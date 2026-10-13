/// <reference types="@cloudflare/workers-types" />

/**
 * Microsoft 365 Copilot Chat proxy (ADR 0062). Session-gated Worker routes
 * under `/api/copilot/*` hold the delegated Entra token and call Graph beta
 * so the SPA never sees Microsoft credentials. Fail-closed without
 * MICROSOFT_CLIENT_ID + MICROSOFT_CLIENT_SECRET (or COPILOT_MOCK=true for
 * local/e2e). Chat is one-shot: create conversation → synchronous chat →
 * return the assistant text; the client replaces the focused bullet.
 */

import { Schema } from "effect";

import { CopilotChatBody } from "./wire";

export type CopilotEnv = {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  /** Entra tenant. Default `organizations` (work/school). Personal MSA unsupported by Chat API. */
  MICROSOFT_TENANT_ID?: string;
  /** Exact literal `"true"` enables mock chat (no Graph). Fail-closed otherwise. */
  COPILOT_MOCK?: string;
};

const GRAPH = "https://graph.microsoft.com/beta";
const TOKEN_URL = (tenant: string) =>
  `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
const AUTHORIZE_URL = (tenant: string) =>
  `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;

/** All seven delegated scopes the Chat API requires, plus offline_access. */
export const COPILOT_SCOPES = [
  "Sites.Read.All",
  "Mail.Read",
  "People.Read.All",
  "OnlineMeetingTranscript.Read.All",
  "Chat.Read",
  "ChannelMessage.Read.All",
  "ExternalItem.Read.All",
  "offline_access",
  "openid",
  "profile",
].join(" ");

const STATE_TTL_MS = 10 * 60 * 1000;
const PROMPT_MAX = 4000;
const DEFAULT_TZ = "UTC";

type TokenRow = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  scopes: string;
};

function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

export function isCopilotMock(env: CopilotEnv): boolean {
  return env.COPILOT_MOCK === "true";
}

export function isMicrosoftConfigured(env: CopilotEnv): boolean {
  return !!(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET);
}

function tenantId(env: CopilotEnv): string {
  return env.MICROSOFT_TENANT_ID?.trim() || "organizations";
}

function publicOrigin(request: Request, env: CopilotEnv): string {
  if (env.BETTER_AUTH_URL) {
    try {
      return new URL(env.BETTER_AUTH_URL).origin;
    } catch {
      /* fall through */
    }
  }
  return new URL(request.url).origin;
}

function callbackUrl(origin: string): string {
  return `${origin}/api/copilot/callback`;
}

function settingsRedirect(origin: string, query: string): string {
  return `${origin}/settings?${query}`;
}

// --- OAuth state (HMAC over userId + expiry) --------------------------------

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function signOAuthState(
  userId: string,
  secret: string,
  now = Date.now(),
): Promise<string> {
  const exp = String(now + STATE_TTL_MS);
  const payload = `${userId}.${exp}`;
  const sig = await hmacHex(secret, payload);
  return btoa(`${payload}.${sig}`);
}

export async function verifyOAuthState(
  state: string,
  secret: string,
  now = Date.now(),
): Promise<string | null> {
  let decoded: string;
  try {
    decoded = atob(state);
  } catch {
    return null;
  }
  const lastDot = decoded.lastIndexOf(".");
  if (lastDot <= 0) return null;
  const payload = decoded.slice(0, lastDot);
  const sig = decoded.slice(lastDot + 1);
  const expected = await hmacHex(secret, payload);
  if (sig !== expected) return null;
  const sep = payload.indexOf(".");
  if (sep <= 0) return null;
  const userId = payload.slice(0, sep);
  const exp = Number(payload.slice(sep + 1));
  if (!userId || !Number.isFinite(exp) || exp < now) return null;
  return userId;
}

// --- Token store ------------------------------------------------------------

async function getTokenRow(
  db: D1Database,
  userId: string,
): Promise<TokenRow | null> {
  return db
    .prepare(
      `SELECT accessToken, refreshToken, accessTokenExpiresAt, scopes
       FROM microsoft_token WHERE userId = ?`,
    )
    .bind(userId)
    .first<TokenRow>();
}

async function upsertToken(
  db: D1Database,
  userId: string,
  row: TokenRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO microsoft_token
         (userId, accessToken, refreshToken, accessTokenExpiresAt, scopes, updatedAt)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(userId) DO UPDATE SET
         accessToken = excluded.accessToken,
         refreshToken = excluded.refreshToken,
         accessTokenExpiresAt = excluded.accessTokenExpiresAt,
         scopes = excluded.scopes,
         updatedAt = excluded.updatedAt`,
    )
    .bind(
      userId,
      row.accessToken,
      row.refreshToken,
      row.accessTokenExpiresAt,
      row.scopes,
      Date.now(),
    )
    .run();
}

async function deleteToken(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(`DELETE FROM microsoft_token WHERE userId = ?`)
    .bind(userId)
    .run();
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function exchangeToken(
  env: CopilotEnv,
  body: URLSearchParams,
): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL(tenantId(env)), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return (await res.json()) as TokenResponse;
}

async function storeFromTokenResponse(
  db: D1Database,
  userId: string,
  data: TokenResponse,
  priorRefresh?: string,
): Promise<boolean> {
  if (!data.access_token || !data.expires_in) return false;
  const refresh = data.refresh_token || priorRefresh;
  if (!refresh) return false;
  await upsertToken(db, userId, {
    accessToken: data.access_token,
    refreshToken: refresh,
    accessTokenExpiresAt: Date.now() + data.expires_in * 1000 - 60_000,
    scopes: data.scope ?? COPILOT_SCOPES,
  });
  return true;
}

/** Valid access token, refreshing when within 60s of expiry. */
async function resolveAccessToken(
  env: CopilotEnv,
  userId: string,
): Promise<string | null> {
  const row = await getTokenRow(env.DB, userId);
  if (!row) return null;
  if (row.accessTokenExpiresAt > Date.now()) return row.accessToken;
  if (!isMicrosoftConfigured(env)) return null;
  const data = await exchangeToken(
    env,
    new URLSearchParams({
      client_id: env.MICROSOFT_CLIENT_ID!,
      client_secret: env.MICROSOFT_CLIENT_SECRET!,
      grant_type: "refresh_token",
      refresh_token: row.refreshToken,
      scope: COPILOT_SCOPES,
    }),
  );
  if (!(await storeFromTokenResponse(env.DB, userId, data, row.refreshToken))) {
    await deleteToken(env.DB, userId);
    return null;
  }
  return data.access_token ?? null;
}

// --- Graph Chat -------------------------------------------------------------

type GraphMessage = {
  text?: string;
  "@odata.type"?: string;
};

type ConversationBody = {
  id?: string;
  messages?: GraphMessage[];
};

/**
 * Pick the assistant reply: last message whose text differs from the prompt
 * (Graph returns both turns as ResponseMessage). Falls back to the last
 * non-empty text.
 */
export function extractReplyText(
  messages: GraphMessage[] | undefined,
  prompt: string,
): string | null {
  if (!messages?.length) return null;
  const trimmedPrompt = prompt.trim();
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messages[i]?.text?.trim();
    if (text && text !== trimmedPrompt) return text;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messages[i]?.text?.trim();
    if (text) return text;
  }
  return null;
}

async function graphJson<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<
  { ok: true; body: T } | { ok: false; status: number; detail: string }
> {
  const res = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  if (!res.ok) {
    const detail =
      typeof body === "object" &&
      body &&
      "error" in body &&
      typeof (body as { error?: { message?: string } }).error?.message ===
        "string"
        ? (body as { error: { message: string } }).error.message
        : `graph ${res.status}`;
    return { ok: false, status: res.status, detail };
  }
  return { ok: true, body: body as T };
}

export async function chatWithGraph(
  accessToken: string,
  prompt: string,
  timeZone: string,
): Promise<{ text: string } | { error: string; status: number }> {
  const created = await graphJson<ConversationBody>(
    accessToken,
    "/copilot/conversations",
    { method: "POST", body: "{}" },
  );
  if (!created.ok) {
    return { error: created.detail, status: created.status };
  }
  const conversationId = created.body.id;
  if (!conversationId) {
    return { error: "no conversation id", status: 502 };
  }
  const chatted = await graphJson<ConversationBody>(
    accessToken,
    `/copilot/conversations/${encodeURIComponent(conversationId)}/chat`,
    {
      method: "POST",
      body: JSON.stringify({
        message: { text: prompt },
        locationHint: { timeZone },
      }),
    },
  );
  if (!chatted.ok) {
    return { error: chatted.detail, status: chatted.status };
  }
  const text = extractReplyText(chatted.body.messages, prompt);
  if (!text) {
    return { error: "empty copilot reply", status: 502 };
  }
  return { text };
}

/** Deterministic mock reply for COPILOT_MOCK=true (local + e2e). */
export function mockCopilotReply(prompt: string): string {
  return `Copilot (mock): ${prompt.trim()}`;
}

// --- Route handler ----------------------------------------------------------

async function decodeChatBody(
  request: Request,
): Promise<
  | { ok: true; prompt: string; timeZone: string }
  | { ok: false; response: Response }
> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: json({ error: "malformed JSON body" }, 400) };
  }
  let promptRaw: string;
  let timeZoneRaw: string | undefined;
  try {
    const decoded = Schema.decodeUnknownSync(CopilotChatBody)(raw);
    promptRaw = decoded.prompt;
    timeZoneRaw = decoded.timeZone;
  } catch (e) {
    const message = e instanceof Error ? e.message : "invalid body";
    return { ok: false, response: json({ error: message }, 400) };
  }
  const prompt = promptRaw.trim();
  if (!prompt) {
    return { ok: false, response: json({ error: "prompt is required" }, 400) };
  }
  if (prompt.length > PROMPT_MAX) {
    return {
      ok: false,
      response: json({ error: `prompt max ${PROMPT_MAX} characters` }, 400),
    };
  }
  const timeZone =
    timeZoneRaw?.trim() ||
    (typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : DEFAULT_TZ) ||
    DEFAULT_TZ;
  return { ok: true, prompt, timeZone };
}

/**
 * All `/api/copilot/*` routes. `authUserId` is Better Auth `user.id` (not the
 * DO name). Returns a Response; unknown subpaths → 404 JSON.
 */
export async function handleCopilot(
  request: Request,
  url: URL,
  env: CopilotEnv,
  authUserId: string,
): Promise<Response> {
  const path = url.pathname;
  const mock = isCopilotMock(env);
  const configured = isMicrosoftConfigured(env) || mock;

  if (path === "/api/copilot/status" && request.method === "GET") {
    if (mock) {
      return json({ configured: true, connected: true, mock: true });
    }
    if (!isMicrosoftConfigured(env)) {
      return json({ configured: false, connected: false, mock: false });
    }
    const row = await getTokenRow(env.DB, authUserId);
    return json({
      configured: true,
      connected: !!row,
      mock: false,
    });
  }

  if (path === "/api/copilot/connect" && request.method === "GET") {
    if (mock) {
      return redirect(
        settingsRedirect(publicOrigin(request, env), "copilot=connected"),
      );
    }
    if (!isMicrosoftConfigured(env)) {
      return json({ error: "microsoft copilot is not configured" }, 503);
    }
    const secret = env.BETTER_AUTH_SECRET;
    if (!secret) {
      return json({ error: "auth secret missing" }, 503);
    }
    const origin = publicOrigin(request, env);
    const state = await signOAuthState(authUserId, secret);
    const authUrl = new URL(AUTHORIZE_URL(tenantId(env)));
    authUrl.searchParams.set("client_id", env.MICROSOFT_CLIENT_ID!);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", callbackUrl(origin));
    authUrl.searchParams.set("response_mode", "query");
    authUrl.searchParams.set("scope", COPILOT_SCOPES);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("prompt", "select_account");
    return redirect(authUrl.toString());
  }

  if (path === "/api/copilot/callback" && request.method === "GET") {
    const origin = publicOrigin(request, env);
    if (mock) {
      return redirect(settingsRedirect(origin, "copilot=connected"));
    }
    if (!isMicrosoftConfigured(env)) {
      return redirect(settingsRedirect(origin, "copilot=error"));
    }
    const secret = env.BETTER_AUTH_SECRET;
    if (!secret) {
      return redirect(settingsRedirect(origin, "copilot=error"));
    }
    const err = url.searchParams.get("error");
    if (err) {
      return redirect(settingsRedirect(origin, "copilot=error"));
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return redirect(settingsRedirect(origin, "copilot=error"));
    }
    const stateUser = await verifyOAuthState(state, secret);
    if (stateUser !== authUserId) {
      return redirect(settingsRedirect(origin, "copilot=error"));
    }
    const data = await exchangeToken(
      env,
      new URLSearchParams({
        client_id: env.MICROSOFT_CLIENT_ID!,
        client_secret: env.MICROSOFT_CLIENT_SECRET!,
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl(origin),
        scope: COPILOT_SCOPES,
      }),
    );
    if (!(await storeFromTokenResponse(env.DB, authUserId, data))) {
      return redirect(settingsRedirect(origin, "copilot=error"));
    }
    return redirect(settingsRedirect(origin, "copilot=connected"));
  }

  if (path === "/api/copilot/disconnect" && request.method === "POST") {
    if (!mock) await deleteToken(env.DB, authUserId);
    return json({ ok: true });
  }

  if (path === "/api/copilot/chat" && request.method === "POST") {
    if (!configured) {
      return json({ error: "microsoft copilot is not configured" }, 503);
    }
    const body = await decodeChatBody(request);
    if (!body.ok) return body.response;
    if (mock) {
      return json({ text: mockCopilotReply(body.prompt) });
    }
    const accessToken = await resolveAccessToken(env, authUserId);
    if (!accessToken) {
      return json({ error: "not_connected" }, 401);
    }
    const result = await chatWithGraph(accessToken, body.prompt, body.timeZone);
    if ("error" in result) {
      const status =
        result.status >= 400 && result.status < 600 ? result.status : 502;
      // Don't forward Graph 401 as session 401 — map to 502 so the SPA can
      // distinguish "reconnect Microsoft" (not_connected) from Graph failure.
      const out = result.status === 401 || result.status === 403 ? 502 : status;
      return json({ error: result.error }, out);
    }
    return json({ text: result.text });
  }

  return json({ error: "not found" }, 404);
}
