-- Per-user Microsoft delegated tokens for Microsoft 365 Copilot Chat
-- (ADR 0062). Keyed by Better Auth `user.id` (never email / DO name).
-- Access + refresh tokens are plain text like the MCP oauthAccessToken table
-- (migration 0004); wipe on account delete via deleteResidualUserRows.

CREATE TABLE "microsoft_token" (
  "userId"               text NOT NULL PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken"          text NOT NULL,
  "refreshToken"         text NOT NULL,
  "accessTokenExpiresAt" integer NOT NULL,
  "scopes"               text NOT NULL,
  "updatedAt"            integer NOT NULL
);
