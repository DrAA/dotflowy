/**
 * Live image frames on the outline socket (ADR 0061).
 *
 * `collection.ts` must apply them without importing `media.ts` (that path
 * pulls tree-store → collection and wedges load). The media module binds the
 * implementation once it loads. Direct synced writes, not collection.insert:
 * an insert would PUT the row back to the server.
 */

export type RemoteMediaRow = {
  id: string;
  nodeId: string;
  contentType: string;
  bytes: number;
  width: number;
  height: number;
  createdAt: number;
};

type Handlers = {
  upsert: (rows: readonly RemoteMediaRow[]) => void;
  remove: (ids: readonly string[]) => void;
};

let handlers: Handlers = {
  upsert: () => {},
  remove: () => {},
};

/** Wire the media collection once the outline UI loads. */
export function bindMediaLive(next: Handlers): void {
  handlers = next;
}

/** Apply one `media` sync frame. No-op until the media module has bound. */
export function applyRemoteMedia(msg: {
  upserts: readonly RemoteMediaRow[];
  deletes: readonly string[];
}): void {
  if (msg.deletes.length) handlers.remove(msg.deletes);
  if (msg.upserts.length) handlers.upsert(msg.upserts);
}
