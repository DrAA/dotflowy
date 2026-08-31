import { useConnectionStatus } from "@lunora/react";
import { useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

import { isLocalDataEnabled, isLunoraSyncEnabled } from "../data/flags";
import { useSyncReady } from "../data/tree-store";
import {
  getPendingWriteCount,
  subscribePendingWrites,
} from "../data/write-queue";
import { HeaderTooltip } from "./header-tooltip";

function subscribeOnline(onStoreChange: () => void): () => void {
  const notify = () => onStoreChange();
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
}

function getOnlineSnapshot(): boolean {
  return typeof navigator !== "undefined" ? navigator.onLine : true;
}

function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, getOnlineSnapshot, () => true);
}

function usePendingWriteCount(): number {
  return useSyncExternalStore(
    subscribePendingWrites,
    getPendingWriteCount,
    () => 0,
  );
}

function useRuntimeFlag(read: () => boolean): boolean {
  return useSyncExternalStore(
    () => () => {},
    read,
    () => false,
  );
}

function saveStatusLabel(input: {
  ok: boolean;
  pending: number;
  online: boolean;
  syncReady: boolean;
  localData: boolean;
}): string {
  if (input.localData) return "Saved in this browser";
  if (!input.syncReady) return "Connecting…";
  if (!input.online) {
    return input.pending > 0
      ? "Offline — changes waiting to sync"
      : "Offline — not connected";
  }
  if (input.pending > 0) {
    return input.pending === 1
      ? "1 change waiting to sync"
      : `${input.pending} changes waiting to sync`;
  }
  if (input.ok) return "Connected — all changes saved";
  return "Not synced";
}

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <HeaderTooltip label={label}>
      <span
        role="status"
        aria-label={label}
        data-testid="save-status-indicator"
        data-ok={ok ? "true" : "false"}
        className="inline-flex size-7 shrink-0 items-center justify-center"
      >
        <span
          className={cn(
            "size-2.5 rounded-full ring-2 ring-background",
            ok ? "bg-emerald-500" : "bg-red-500",
          )}
        />
      </span>
    </HeaderTooltip>
  );
}

function ClassicSaveStatusIndicator() {
  const online = useOnline();
  const pending = usePendingWriteCount();
  const syncReady = useSyncReady();
  const ok = syncReady && online && pending === 0;
  const label = saveStatusLabel({
    ok,
    pending,
    online,
    syncReady,
    localData: false,
  });
  return <StatusDot ok={ok} label={label} />;
}

function LunoraSaveStatusIndicator() {
  const status = useConnectionStatus();
  const online = useOnline();
  const pending = usePendingWriteCount();
  const syncReady = useSyncReady();
  const connected = status === "connected";
  const ok = syncReady && online && connected && pending === 0;
  const label =
    !connected && syncReady && online
      ? "Sync disconnected"
      : saveStatusLabel({
          ok,
          pending,
          online,
          syncReady,
          localData: false,
        });
  return <StatusDot ok={ok} label={label} />;
}

/**
 * Header dot: green when connected and every change has landed; red when offline,
 * disconnected, or the browser write queue still has pending edits.
 */
export function SaveStatusIndicator() {
  const localData = useRuntimeFlag(isLocalDataEnabled);
  const lunora = useRuntimeFlag(isLunoraSyncEnabled);

  if (localData) {
    return (
      <StatusDot
        ok
        label={saveStatusLabel({
          ok: true,
          pending: 0,
          online: true,
          syncReady: true,
          localData: true,
        })}
      />
    );
  }
  if (lunora) return <LunoraSaveStatusIndicator />;
  return <ClassicSaveStatusIndicator />;
}
