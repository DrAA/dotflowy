# Microsoft 365 Copilot slash command

## Status

Accepted (grill waived for the initial build; hold against 0001 / 0011 / 0014 / 0031).

## Context

Users want to ask Microsoft 365 Copilot from a bullet (`/copilot`) and drop the
reply into the outline. Seam C closes the slash menu on whitespace, so the
prompt cannot ride `/copilot <args>`. Microsoft exposes Copilot Chat only via
Graph beta with **delegated** Entra tokens (no app-only), and the seven listed
Graph scopes are all required. Licensing: Microsoft 365 Copilot add-on.

## Decision

1. **Lane-A plugin** (`src/plugins/copilot`) contributes Seam C `/copilot` only —
   no `Node` field, no side-collection (ADR 0001 / 0031).
2. **Prompt dialog** (root-mounted opener, same pattern as `/move`) collects the
   prompt; on success the plugin's `onTextChange` replaces the bullet text.
3. **Worker proxy** under `/api/copilot/*` (session-gated like `/api/unfurl`):
   - `GET /status` — configured / connected / mock
   - `GET /connect` + `GET /callback` — Entra OAuth (HMAC `state`)
   - `POST /chat` — `{ prompt, timeZone? }` → create conversation → synchronous
     `chat` → `{ text }` (Effect Schema body, ADR 0014)
   - `POST /disconnect` — drop D1 tokens
4. **Tokens in D1** (`microsoft_token`, keyed by Better Auth `user.id`, never
   email / DO name). Wiped in `deleteResidualUserRows`.
5. **Fail-closed** without `MICROSOFT_CLIENT_ID` + `MICROSOFT_CLIENT_SECRET`.
   Exact `COPILOT_MOCK=true` enables a deterministic mock for local/e2e.
6. **Settings** shows Connect / Disconnect only when configured.

## Consequences

- Org must register an Entra app, grant admin consent for the seven scopes, and
  set Worker secrets. Users need a Copilot license.
- Graph beta may change; chat is one-shot (no multi-turn persistence in v1).
- Mock mode must never be set in production.
