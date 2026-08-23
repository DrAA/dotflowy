/**
 * Toggle browser-only (local-data) mode and reload. Enabling snapshots the
 * in-memory outline (and kv / images) into the browser first so the user keeps
 * what they see. Disabling does not upload; backend data stays on the account,
 * browser-local data stays in this browser.
 */

import { hardReset } from "../lib/auth-client";
import { persistLocalOutline } from "./collection";
import { setLocalDataEnabled } from "./flags";
import { takeKvMemorySnapshot } from "./kv-api";
import { copyRemoteMediaToLocal, writeLocalKvRecord } from "./local-store";
import { mediaCollection } from "./media";

export async function setLocalDataMode(enabled: boolean): Promise<void> {
  if (enabled) {
    persistLocalOutline();
    for (const [collection, record] of takeKvMemorySnapshot()) {
      writeLocalKvRecord(collection, record);
    }
    await copyRemoteMediaToLocal(mediaCollection.toArray);
  }
  setLocalDataEnabled(enabled);
  hardReset(window.location.pathname + window.location.search);
}
