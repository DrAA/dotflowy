# Hosted images under bullets

Status: accepted

Paste or drop a screenshot onto a bullet; it renders as a capped-height block
**under** the text. Bytes live in R2. The outline row only stores a pointer in a
plugin side-collection.

## Decision

- **Hosted files, not hotlinks.** Screenshot paste works. External
  `![alt](https://…)` is a later extra.
- **Block under the bullet, not inline.** Photos do not enter contentEditable
  (that fights caret math, [ADR 0005](./0005-rich-links-source-offset-caret.md),
  and the token decorator).
- **No `Node` field.** Attachments are plugin data
  ([ADR 0001](./0001-plugin-architecture.md)): kv collection `media`, keyed by
  attachment id, with `nodeId` = the **content** id (`mirrorOf ?? id`) so mirrors
  show the source's images.
- **Do not store `![alt](media:…)` in `node.text`.** History snapshots nodes
  only. A hidden suffix stripped from the contentEditable recreates the
  source/display split ADR 0005 exists to avoid. Undo snapshots the `media`
  collection on attach/detach via a history extra hook.
- **Bytes never enter SQLite.** Changelog rows already sit near the 2 MB cap.
  R2 object key: `media/<userId>/<attachmentId>`. JSON outline backups do not
  contain bytes; restore of nodes still points at live R2 objects. A snapshot
  restore after a media GC shows a broken placeholder.

## Seams

- New slot positions `row:below` and `title:below` (full-width under the text
  flex row, inside the measured `<li>` — not in `NodeDecorations`, which is the
  CSS chip budget, ADR 0031).
- `input.onPasteFiles` claims a paste that carries image files before the
  string paste chain runs.
- File drop on a row is HTML5 DnD; bullet reorder is pointer-driven, so they
  do not share a gesture. Drop `preventDefault`s when `types` includes `Files`.

## Caps

- Types: jpeg, png, gif, webp, avif. **Reject SVG** (stored XSS). Sniff magic
  bytes; do not trust `Content-Type`.
- Per file: 8 MB. Per account: 100 MB free / 1 GB paid. Over-cap = 413; the
  outline stays editable.

## Orphan grace

Detaching an image deletes the kv row immediately so quota frees. R2 objects
stay until account wipe so Cmd+Z can restore the kv row and GET still works.
Node delete GCs kv rows for those `nodeId`s (client + DO); R2 remains until
wipe.

## Export / MCP

Markdown and OPML append a counted `[image]` placeholder — never a private
`/api/media/:id` URL. MCP flatten mentions `[image]` and does not send bytes.
