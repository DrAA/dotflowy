# Dotflowy

Dotflowy is an outliner: nested bullets, per-user sync, and a plugin-extended editor. It is a React SPA with no SSR, on Cloudflare Workers. Each user's outline lives in its own Durable Object.

Keep this file brief. Put task-specific guidance behind a pointer.

## Gotchas

- **Structural vs field writes.** Tree-shape changes go through `runStructural` at the call site, not inside `mutations.ts`. Field edits stay a direct PATCH.
- **A new `Node` field touches seven places:** `src/data/wire-schema.ts`, `src/data/schema.ts`, `makeNode()`, `withNodeDefaults` in `collection.ts`, a DO `ADD COLUMN` migration, `e2e/fixtures.ts`, and the R2 snapshot boundary in `worker/backup.ts`. Miss the fixtures and inbound-frame decode rejects every snapshot. Build nodes with `makeNode()`.
- **Add a new side-collection to `KV_COLLECTIONS` in `worker/index.ts`.**
- **Read side-collections with `subscribeChanges` and `useSyncExternalStore`.** `useLiveQuery` hard-fails the `/` prerender. Readiness rides `toArrayWhenReady()`.
- **The tree index mutates in place and notifies synchronously.** Read sibling state before you mutate.
- **Read event-time values through the getters** (`getTreeIndex()`, `getViewRootId()`, `getViewIsHidden()`, `getViewFilter()`). Write view state in effects.
- **Entitlement reads never call Stripe.** `getPlan(userId, env)` is one D1 query. Keep the founding seat cap in `getCheckoutSessionParams`.
- **A node renders in three places**, with three keymaps: `OutlineRow`, `ZoomedTitle`, `MiniNodeEditor`. Keymaps and slots do not share. The `refs` registry maps a node id to its contentEditable span; the zoomed title registers under `rootId`.
- **`el.textContent` is not the source.** Read with `readSource(el)`. Caret offsets are SOURCE offsets. Stored text writes to the DOM only when it differs.
- **`OutlineEditor` and `SwitcherDialog` carry `"use no memo"`.**
- **The visible-neighbor walk must mirror render visibility.** Assert nesting through `data-parent-id` and `data-depth`.
- **`rootId` is route-owned.** `routes/index.tsx` gives `null`; `routes/$nodeId.tsx` gives `nodeId`. The editor remounts per zoom via `key={nodeId}`.
- **The typed-error channel in Effect is the error model.** Read Effect v4 from `bunx opensrc path Effect-TS/effect-smol`, never `node_modules/effect/`. App code imports `effect` from npm. **`kv-api.ts` must keep throwing.**
- **e2e runs on its own Vite server on port 3210.** Kill a zombie or set `E2E_PORT`. For a caret, set the Selection range directly. `toHaveText` normalizes whitespace.
- **A perf guard asserts a countable invariant**, never a wall clock.
- **When you add an MCP tool, update the ordered tool-name list in `worker/mcp.test.ts`.**
- **After `bun add` of a React-importing package, clear `node_modules/.vite`** if the hook call dies.
- **The Codex app rewrites `.codex/environments/environment.toml`** and drops comments.
- **Session handoffs.** `HANDOFF.md` is branch-local. Commit it on the branch; delete it in the shipping PR. It must never reach `main`.
- **Local dev is `bun run cf:dev` on port 8787.** `bun run dev` on :3000 has a broken database on Cam's machine.
- **Lunora mutator patch, delete, and get must pass `expectedTable`.** Write through the per-table facade. `ctx.db.asId(...)` is compile-time branding only.
- **Vite proxies for `/api` and `/_lunora` need `ws: true`.**
- **Capture a repeated incantation** in a `package.json` script or a config file.

## Guardrails

- **Grill first.** New plugin, route, seam, `Node` field, side-collection, or ADR-worthy behavior: read the matching ADRs, then ask the user to run `/grill-with-docs` (user-invoked only). If they waive it, hold the design against those ADRs by hand. An agent can invoke `/domain-modeling`, `/code-review`, `/security-review`, and `/ft-create-concise-pr`.
- **There is no client-side data migration.**
- **Key the DO through `resolveUserId`**, never the email. The one exception is the owner-continuity bridge to `'default'`.
- **The `/api` session check trusts the server session**, never a client-supplied id.
- **The SSRF guard in `worker/unfurl.ts` revalidates every redirect hop.**
- **Google is `disableSignUp: true`**, never `disableImplicitSignUp`. Signup gates fail closed: `SIGNUP_OPEN` must be the exact literal `"true"`. Admin routes return 404.
- **Send all transactional email through `worker/email.ts`.** Park sends on `ctx.waitUntil`.
- **Decode request bodies against Effect Schema.**
- **The app is a pure static SPA.** Code that touches `nodesCollection` stays off the server and render pass.
- **Lunora sync stays opt-in.** User-facing copy must not name Lunora. Turning it off returns the last classic snapshot. Live-read and `isPersisted` landmines: [ADR 0058](./docs/adr/0058-lunora-replaces-custom-outline-sync.md).
- **Documentation Freshness.** If `AGENTS.md` or `README.md` becomes false about a path, command, or tool, correct it in the same change. Ask first before changing policy, philosophy, or positioning.
- **Run the app before calling an observable change done.** Drive it in `bun run cf:dev` or an e2e spec.

## Design

New feature or design: `ls docs/adr/` and read the ADRs that match the surface. Filenames name their surface except:

| Surface                                                | ADR                                                    |
| ------------------------------------------------------ | ------------------------------------------------------ |
| Plugin seams, adding a plugin                          | 0001, 0031, and [`docs/plugins.md`](./docs/plugins.md) |
| Structural write atomicity, and why field edits differ | 0009, 0010                                             |
| Auth gate, Google sign-in, email verification          | 0011                                                   |
| Effect: errore removal, sync socket, schemas, fiber    | 0012, 0013, 0021, 0053                                 |
| Touch targets, reading size, and the bullet dot        | 0029                                                   |
| Spotlight dim + typewriter centering                   | 0033, 0060                                             |
| Lunora sync (experimental, flag-gated)                 | 0058                                                   |

## Architecture

Structure, data model, backend-swap: [`docs/architecture.md`](./docs/architecture.md). Setup and local dev: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Plugins

Plugin, seam, token, or kit UI: read [`docs/plugins.md`](./docs/plugins.md).

## Testing

Testing or coverage: read [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Review

PR description: `/ft-create-concise-pr`. Review: `/code-review`. Auth, SSRF, Worker-to-DO trust, or signup gate: `/security-review`.

## Release

Version bump or changelog: [ADR 0046](./docs/adr/0046-changelog-and-release-versioning.md) and [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Landing

Landing site (`landing/`, dotflowy.com): Geist only, no mono. Accents match the app palette. Feature bullets stay vertical on desktop. Keep "Workflowy alternative" out of the H1 and the footer brand row.

## Preferences

- Once the approach is agreed, pick the best reasonable option and proceed. If the target worktree is unclear, ask.
- Icons: free MIT Hugeicons (`@hugeicons/react`, `@hugeicons/core-free-icons`) at default stroke.

## Tooling

The three blocks below are written by their own tools. The `:start` and `:end`
markers are how each tool finds its block to replace. Never hand-edit inside
them, and never drop the markers: without them the next run appends a duplicate.
Neither fff nor codegraph reaches `~/.opensrc/`.

<!-- intent-skills:start -->

## Skill Loading

Before substantial work:

- Skill check: run `bunx @tanstack/intent@latest list`, or use skills already listed in context.
- Skill guidance: if one local skill clearly matches the task, run `bunx @tanstack/intent@latest load <package>#<skill>` and follow the returned `SKILL.md`.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.

<!-- intent-skills:end -->

<!-- codegraph:start -->

## CodeGraph

This project has a CodeGraph MCP server (`codegraph_*` tools) configured. CodeGraph is a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Reads are sub-millisecond and return structural information grep cannot.

### When to prefer codegraph over native search

Use codegraph for **structural** questions — what calls what, what would break, where is X defined, what is X's signature. Use native grep/read only for **literal text** queries (string contents, comments, log messages) or after you already have a specific file open.

| Question                                      | Tool                |
| --------------------------------------------- | ------------------- |
| "Where is X defined?" / "Find symbol named X" | `codegraph_search`  |
| "What calls function Y?"                      | `codegraph_callers` |
| "What does Y call?"                           | `codegraph_callees` |
| "What would break if I changed Z?"            | `codegraph_impact`  |
| "Show me Y's signature / source / docstring"  | `codegraph_node`    |
| "Give me focused context for a task/area"     | `codegraph_context` |
| "Survey an unfamiliar module/topic"           | `codegraph_explore` |
| "What files exist under path/"                | `codegraph_files`   |
| "Is the index healthy?"                       | `codegraph_status`  |

### Rules of thumb

- **Trust codegraph results.** They come from a full AST parse. Do NOT re-verify them with grep — that's slower, less accurate, and wastes context.
- **Don't grep first** when looking up a symbol by name. `codegraph_search` is faster and returns kind + location + signature in one call.
- **Don't chain `codegraph_search` + `codegraph_node`** when you just want context — `codegraph_context` is one call.
- **`codegraph_explore` is the heavy hitter** for unfamiliar areas — it returns full source from all relevant files in one call, but is token-heavy. If your harness supports parallel subagents (e.g., Claude Code's Task tool), spawn one for explore-class questions to keep main session context clean.
- **Index lag**: the file watcher debounces ~500ms behind writes; don't re-query immediately after editing a file in the same turn.

### If `.codegraph/` doesn't exist

The MCP server returns "not initialized." Ask the user: _"I notice this project doesn't have CodeGraph initialized. Want me to run `codegraph init -i` to build the index?"_
<!-- codegraph:end -->

<!-- fff:start -->

For any file search or grep in the current git-indexed directory, use fff tools.
<!-- fff:end -->
