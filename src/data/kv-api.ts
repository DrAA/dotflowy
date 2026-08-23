/**
 * Throw-based client for the generic /api/kv side-collection store (ADR 0008).
 * Each plugin side-collection (tag colors, the daily index) is one `collection`
 * namespace; `value` is the full item object, `key` is the collection's getKey.
 *
 * These are thin SHELLS over the Effect transport core in kv-client-effect.ts:
 * each runs the matching Effect program through `runPromise`, so every kv write
 * inherits the core's retry (exponential backoff), 8s timeout, typed errors, and
 * response-shape validation — instead of the bespoke bare-fetch they used to be.
 *
 * They keep THROWING on failure on purpose: TanStack DB mutation handlers signal
 * failure by throwing (a throw triggers optimistic rollback), so the consumers
 * (tag-colors.ts, daily-index.ts onInsert/onUpdate/onDelete) need a rejecting
 * promise, not an Effect value. The throw is now Effect-backed, not hand-rolled.
 *
 * Same-origin, so the Better Auth session cookie rides along automatically. See
 * CONTRIBUTING.md "typed-error channel in Effect" and ADR 0012.
 */

import { isLocalDataEnabled } from "./flags";
import { kvDeleteE, kvFetchE, kvPutE, runPromise } from "./kv-client-effect";
import {
  inferKvKey,
  readLocalKvRecord,
  writeLocalKvRecord,
} from "./local-store";

const kvMemory = new Map<string, Record<string, unknown>>();

function rememberKv(collection: string, record: Record<string, unknown>): void {
  kvMemory.set(collection, record);
}

/** Last-seen kv rows, for snapshotting into localStorage when switching mode. */
export function takeKvMemorySnapshot(): ReadonlyMap<
  string,
  Record<string, unknown>
> {
  return kvMemory;
}

function recordFromRows(
  rows: readonly { key: string; value: unknown }[],
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...existing };
  for (const row of rows) next[row.key] = row.value;
  return next;
}

function valuesOf<T>(record: Record<string, unknown>): T[] {
  return Object.values(record) as T[];
}

/** Complete state for one collection (the query collection treats it as
 *  authoritative, so the Worker returns every owned row). */
export const kvFetch = <T>(collection: string): Promise<T[]> => {
  if (isLocalDataEnabled()) {
    const record = readLocalKvRecord(collection);
    rememberKv(collection, record);
    return Promise.resolve(valuesOf<T>(record));
  }
  return runPromise(kvFetchE<T>(collection)).then((rows) => {
    const record: Record<string, unknown> = {};
    for (const row of rows) {
      record[inferKvKey(row, "")] = row as unknown;
    }
    rememberKv(collection, record);
    return rows;
  });
};

/** Upsert rows (insert + update both map here — the items are tiny). */
export const kvPut = (
  collection: string,
  rows: { key: string; value: unknown }[],
): Promise<void> => {
  if (isLocalDataEnabled()) {
    const next = recordFromRows(rows, readLocalKvRecord(collection));
    writeLocalKvRecord(collection, next);
    rememberKv(collection, next);
    return Promise.resolve();
  }
  return runPromise(kvPutE(collection, rows)).then(() => {
    const next = recordFromRows(rows, kvMemory.get(collection) ?? {});
    rememberKv(collection, next);
  });
};

export const kvDelete = (collection: string, keys: string[]): Promise<void> => {
  if (isLocalDataEnabled()) {
    const next = { ...readLocalKvRecord(collection) };
    for (const key of keys) delete next[key];
    writeLocalKvRecord(collection, next);
    rememberKv(collection, next);
    return Promise.resolve();
  }
  return runPromise(kvDeleteE(collection, keys)).then(() => {
    const next = { ...kvMemory.get(collection) };
    for (const key of keys) delete next[key];
    rememberKv(collection, next);
  });
};

// --- Mutation-transaction shaping --------------------------------------------
// A side-collection's onInsert/onUpdate both upsert the WHOLE value (the items
// are tiny key->value rows), and onDelete sends the keys. These map a query
// collection's mutation transaction to those payloads. The param is structural
// (just the fields read), so the concrete transaction type satisfies it without
// importing TanStack's mutation generics. Used by tag-colors.ts / daily-index.ts.

type KvMutations = {
  mutations: readonly { key: unknown; modified?: unknown }[];
};

/** Upsert rows from a transaction: `{ key, value }` per mutation. */
export const toKvRows = (t: KvMutations): { key: string; value: unknown }[] =>
  t.mutations.map((m) => ({ key: String(m.key), value: m.modified }));

/** The keys to delete from a transaction. */
export const toKvKeys = (t: KvMutations): string[] =>
  t.mutations.map((m) => String(m.key));
