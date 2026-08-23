/// <reference types="@cloudflare/workers-types" />

import type { Plan } from "./plan";

import { getPlan } from "./plan";

/** 8 MiB per file. */
export const MAX_MEDIA_FILE_BYTES = 8 * 1024 * 1024;
/** 100 MiB free-tier account cap. */
export const FREE_MEDIA_QUOTA_BYTES = 100 * 1024 * 1024;
/** 1 GiB paid-tier account cap. */
export const PAID_MEDIA_QUOTA_BYTES = 1024 * 1024 * 1024;

const IMAGE_TYPES = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
} as const;

export type SniffedImageType = (typeof IMAGE_TYPES)[keyof typeof IMAGE_TYPES];

export type MediaRow = {
  id: string;
  nodeId: string;
  contentType: SniffedImageType;
  bytes: number;
  width: number;
  height: number;
  createdAt: number;
};

/** Account media quota for a billing plan. Paid plans share the 1 GiB cap. */
export function mediaQuotaForPlan(plan: Plan): number {
  return plan === "free" ? FREE_MEDIA_QUOTA_BYTES : PAID_MEDIA_QUOTA_BYTES;
}

/** True when adding `incoming` bytes to `used` would pass `cap`. */
export function exceedsMediaQuota(
  used: number,
  incoming: number,
  cap: number,
): boolean {
  return used + incoming > cap;
}

/** R2 object key: `media/<userId>/<attachmentId>`. */
export function mediaR2Key(userId: string, attachmentId: string): string {
  return `media/${userId}/${attachmentId}`;
}

/**
 * Magic-byte sniff. Rejects SVG (and anything else that isn't a raster we
 * allow) even if Content-Type claims otherwise.
 */
export function sniffImage(bytes: Uint8Array): SniffedImageType | null {
  if (bytes.length < 12) return null;
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return IMAGE_TYPES.jpeg;
  }
  // PNG
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return IMAGE_TYPES.png;
  }
  // GIF87a / GIF89a
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return IMAGE_TYPES.gif;
  }
  // WEBP: RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return IMAGE_TYPES.webp;
  }
  // AVIF: ISO-BMFF `ftyp` with brand `avif` or `avis` in the first 32 bytes.
  if (hasFtypBrand(bytes, "avif") || hasFtypBrand(bytes, "avis")) {
    return IMAGE_TYPES.avif;
  }
  return null;
}

function hasFtypBrand(bytes: Uint8Array, brand: string): boolean {
  // Box: size(4) + 'ftyp'(4) + major(4) + minor(4) + compatible brands…
  if (bytes.length < 16) return false;
  if (
    bytes[4] !== 0x66 ||
    bytes[5] !== 0x74 ||
    bytes[6] !== 0x79 ||
    bytes[7] !== 0x70
  ) {
    return false;
  }
  const limit = Math.min(bytes.length, 64);
  for (let i = 8; i + 4 <= limit; i += 4) {
    if (
      bytes[i] === brand.charCodeAt(0) &&
      bytes[i + 1] === brand.charCodeAt(1) &&
      bytes[i + 2] === brand.charCodeAt(2) &&
      bytes[i + 3] === brand.charCodeAt(3)
    ) {
      return true;
    }
  }
  return false;
}

function asMediaRows(raw: unknown[]): MediaRow[] {
  const out: MediaRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.nodeId !== "string") continue;
    if (typeof r.bytes !== "number") continue;
    out.push(r as MediaRow);
  }
  return out;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type MediaEnv = { MEDIA: R2Bucket; DB: D1Database };

type MediaStub = {
  getKv(collection: string): unknown[] | Promise<unknown[]>;
  upsertKv(
    collection: string,
    rows: readonly { key: string; value: unknown }[],
  ): void | Promise<void>;
  deleteKv(collection: string, keys: readonly string[]): void | Promise<void>;
};

/**
 * Session-gated media API: POST raw bytes, GET stream, DELETE kv (R2 stays
 * until account wipe so Cmd+Z can still fetch).
 */
export async function handleMedia(
  request: Request,
  url: URL,
  stub: MediaStub,
  env: MediaEnv,
  userId: string,
): Promise<Response> {
  const idFromPath = mediaIdFromPath(url.pathname);
  if (request.method === "POST" && url.pathname === "/api/media") {
    return postMedia(request, stub, env, userId);
  }
  if (request.method === "GET" && idFromPath) {
    return getMedia(idFromPath, stub, env, userId);
  }
  if (request.method === "DELETE" && idFromPath) {
    return deleteMedia(idFromPath, stub);
  }
  return json({ error: "method not allowed" }, 405);
}

function mediaIdFromPath(pathname: string): string | null {
  const m = /^\/api\/media\/([^/]+)$/.exec(pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}

async function postMedia(
  request: Request,
  stub: MediaStub,
  env: MediaEnv,
  userId: string,
): Promise<Response> {
  const nodeId = new URL(request.url).searchParams.get("nodeId")?.trim();
  if (!nodeId) return json({ error: "missing nodeId" }, 400);

  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.byteLength === 0) return json({ error: "empty body" }, 400);
  if (buf.byteLength > MAX_MEDIA_FILE_BYTES) {
    return json({ error: "file too large" }, 413);
  }

  const contentType = sniffImage(buf);
  if (!contentType) return json({ error: "unsupported type" }, 415);

  const existing = asMediaRows(await stub.getKv("media"));
  const used = existing.reduce((sum, r) => sum + r.bytes, 0);
  const plan = await getPlan(userId, env);
  const cap = mediaQuotaForPlan(plan);
  if (exceedsMediaQuota(used, buf.byteLength, cap)) {
    return json({ error: "quota exceeded" }, 413);
  }

  const width = parseDim(request.headers.get("x-image-width"));
  const height = parseDim(request.headers.get("x-image-height"));
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const row: MediaRow = {
    id,
    nodeId,
    contentType,
    bytes: buf.byteLength,
    width,
    height,
    createdAt,
  };

  await env.MEDIA.put(mediaR2Key(userId, id), buf, {
    httpMetadata: { contentType },
  });
  await stub.upsertKv("media", [{ key: id, value: row }]);
  return json(row, 201);
}

async function getMedia(
  id: string,
  stub: MediaStub,
  env: MediaEnv,
  userId: string,
): Promise<Response> {
  const rows = asMediaRows(await stub.getKv("media"));
  const row = rows.find((r) => r.id === id);
  if (!row) return json({ error: "not found" }, 404);
  const obj = await env.MEDIA.get(mediaR2Key(userId, id));
  if (!obj) return json({ error: "not found" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": row.contentType,
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

async function deleteMedia(id: string, stub: MediaStub): Promise<Response> {
  await stub.deleteKv("media", [id]);
  return json({ ok: true });
}

function parseDim(raw: string | null): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Delete every R2 object under `media/<userId>/` (account wipe). */
export async function deleteMediaPrefix(
  bucket: R2Bucket,
  userId: string,
): Promise<void> {
  const prefix = `media/${userId}/`;
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    if (listed.objects.length) {
      await Promise.all(listed.objects.map((o) => bucket.delete(o.key)));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
