---
status: accepted
---

# Sealed live revisions (multi-device pull)

Sealed mode ([ADR 0063](./0063-sealed-outline.md)) stores the live outline as one R2 snapshot. Without a pull path, two unlocked browsers last-writer-win on that object and silently drop each other’s edits. Snapshot OCC (Phase A in 0063) stops the silent clobber; this ADR adds **live multi-writer convergence** via the existing sealed revision log.

## Decision

1. **Append-only sealed revisions remain the wire unit** — opaque envelopes in R2 (`seal/{userId}/rev/{seq}`), allocated by DO `seal_rev_seq`. No plaintext ops on the server.
2. **`GET /api/seal/revisions?after=N`** returns envelopes with seq `> N` (plus current `revSeq`). Clients decrypt locally with the DEK.
3. **On unlock**: hydrate snapshot, then apply revisions with seq `>` DO `seal_snapshot_at_rev` (stamped on every OCC snapshot commit). Do not start at tip — that skips catch-up.
4. **While unlocked**: `/api/sync` stays open for opaque `seal_rev` pokes (revSeq only — no ciphertext). On poke, clients `GET /api/seal/revisions?after=N` and apply with **node-level last-write-wins on `updatedAt`** (tie → prefer remote). Deletes always apply. Sibling-chain heal stays the existing tree invariant. A slow poll is fallback only. Persist pulls once more immediately before snapshot compact so a writer cannot omit nodes another device already appended. When `seal_active`, the classic hello snapshot is empty so plaintext never fans out.
5. **Local edits** append a sealed revision first (so peers poke+pull immediately), then best-effort OCC-compact the live snapshot. Snapshot is compaction, not the multi-writer wire.
6. **OCC snapshot conflict** adopts the server seq, pulls missing revisions, and retries compact once — **no page reload**. Concurrent tabs converge via revisions; a lost snapshot race must not discard local ciphertext that already landed as a revision.

## Considered and rejected

| Option                                   | Why not                                                |
| ---------------------------------------- | ------------------------------------------------------ |
| CRDT / character-level concurrent typing | Out of scope; outliner atomic unit is the node.        |
| Server-side merge of plaintext           | Breaks passphrase-never-on-server.                     |
| Drop snapshot; revisions only            | Cold start and backup still need a compacted snapshot. |

## Consequences

- Clients must track `localRevSeq` / `localSnapshotSeq` across the session.
- Collection applies remote deltas under `withPersistSuppressed` so they do not echo as local seal writes.
- If `revSeq` advances past the pruned revision window with no envelopes returned, fall back to snapshot rehydrate (future hardening) or accept temporary lag until next unlock.
- Structural same-node conflicts (both sides reparent) resolve by LWW on the node row + chain heal; document residual oddities in support notes, not special-case every tree shape.
