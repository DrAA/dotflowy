---
status: accepted
---

# Sealed outline (client passphrase, ciphertext in the per-user DO)

Dotflowy’s live outline is plaintext in a per-user Durable Object (and plaintext in R2 backups). Platform disk encryption does not stop the Worker or an operator with storage access from reading node text. We will **seal** the outline: the DO (and backups/media) hold **ciphertext only**; decryption happens on the client.

Glossary: [CONTEXT.md](../../CONTEXT.md) (**Sealed outline**, **Seal passphrase**).

## Decision

1. **Mandatory sealing** once shipped — no long-term plaintext outline path.
2. **Seal passphrase** unlocks the outline on the client. It is **not** the Better Auth account password and is **never sent to the server**, so password reset does not destroy decryptability and login does not hand the server the seal.
3. **Recovery key** — a one-time user-held secret that can rewrap access if the passphrase is lost. No server-side key escrow.
4. **Storage home stays the per-user DO** as the control plane (keybag, `seal_active`, pointers) with the same routing/`resolveUserId` story as [ADR 0008](./0008-sync-via-a-per-user-durable-object.md) / [ADR 0058](./0058-lunora-replaces-custom-outline-sync.md). **Bulk sealed snapshot and revision envelopes live in R2** (opaque ciphertext) — a single DO `meta` value hits `SQLITE_TOOBIG` for large outlines. Wire payloads stay opaque envelopes; not plaintext node rows.
5. **Media sealed** the same way (ciphertext in object storage).
6. **Migration is client-side one-shot** after the user sets a passphrase: download plaintext → seal → upload envelopes → drop plaintext. The server never performs the seal (preserves “passphrase never on server”). Aligns with the existing “no client-side migration” rule for _account_ data: this is an explicit user-gated transform, not a silent import.
7. **Unlock UX** — DEK in memory until lock/sign-out by default; optional “remember this device.”
8. **MCP** — Worker MCP does not receive plaintext or the DEK. Agents use a **client-side bridge** that decrypts locally.
9. **Backups** — Daily R2 sweeps store sealed envelopes (`kind: "sealed"`) for sealed accounts (not empty plaintext `nodes`); admin restore rewrites the live seal object + DO flags/keybag/kv as opaque ciphertext.

Search/filter stay client-side over the decrypted in-memory outline ([ADR 0047](./0047-query-filter-grammar.md)) — no server FTS required.

## Considered and rejected

| Option                                                                | Why not                                                                          |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Seal with the account password                                        | Couples password reset to data loss; Better Auth sees the password at login.     |
| True hostile-operator E2E via PAKE while still using password-as-seal | Unnecessary once passphrase is separate; PAKE is a later auth upgrade if wanted. |
| Server-held DEK / escrow recovery                                     | Operator can decrypt; undermines the seal.                                       |
| Opt-in sealing only                                                   | Two stores forever; backups and MCP stay ambiguous.                              |
| Blind store outside the DO                                            | Extra product surface; DO already is the per-user shard.                         |
| Server-side seal migration                                            | Requires a server-usable key — contradicts passphrase-never-on-server.           |
| Upload DEK to Worker for MCP                                          | Reopens plaintext on the server for the session.                                 |
| Plaintext R2 backups after seal                                       | Bypass channel for the entire outline.                                           |

## Consequences

- New client crypto: KDF, keybag, envelope codec, unlock/lock UI, recovery-key ceremony, remember-device wrapping.
- Sync adapter speaks sealed snapshot + sealed revisions; DO meta holds keybag + flags; R2 holds bulk sealed envelopes (snapshot + revision log).
- Media upload/download encrypt/decrypt on the client.
- Cutover UX for every existing account; support docs for “lost passphrase + lost recovery key = data gone.”
- Hosted MCP deferred until the client bridge exists; product copy must not promise server-side agents over sealed data.
- Admin tooling can restore envelopes but cannot read content without the user’s secrets.
