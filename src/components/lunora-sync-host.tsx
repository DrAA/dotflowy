/**
 * Starts Lunora outline sync when `dotflowy:flag:lunora-sync` is ON (ADR 0058).
 * Mounted inside AuthGate so a session userId is available. Flag OFF = pass-
 * through (custom `/api/sync` path unchanged).
 *
 * Flag is read in an effect (not during SSR/prerender) so the SPA shell and
 * client hydration agree on the first paint.
 */

import { LunoraProvider, useConnectionStatus } from "@lunora/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { isLunoraSyncEnabled } from "../data/flags";
import { getLunoraClient } from "../data/lunora-client";
import {
  startLunoraOutlineSync,
  stopLunoraOutlineSync,
} from "../data/lunora-sync";
import { useSession } from "../lib/auth-client";

function LunoraConnectionFeedback() {
  const status = useConnectionStatus();
  const wasOffline = useRef(false);

  useEffect(() => {
    if (status === "offline") {
      wasOffline.current = true;
      toast.warning("Sync paused — changes will send when reconnected", {
        id: "lunora-connection",
      });
    } else if (status === "connected" && wasOffline.current) {
      wasOffline.current = false;
      toast.success("Sync reconnected", { id: "lunora-connection" });
    }
  }, [status]);

  return null;
}

function LunoraOutlineBootstrap({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const userId = session?.user?.id;

  useEffect(() => {
    if (!userId) return;
    startLunoraOutlineSync(userId);
    return () => {
      stopLunoraOutlineSync();
    };
  }, [userId]);

  return (
    <>
      <LunoraConnectionFeedback />
      {children}
    </>
  );
}

/**
 * When the Lunora sync flag is ON, wrap children in LunoraProvider and start
 * the outline store. When OFF, pass children through unchanged (no Lunora
 * client constructed — keeps prerender / default path clean).
 */
export function LunoraSyncHost({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(isLunoraSyncEnabled());
  }, []);

  if (!enabled) return <>{children}</>;

  return (
    <LunoraProvider client={getLunoraClient()}>
      <LunoraOutlineBootstrap>{children}</LunoraOutlineBootstrap>
    </LunoraProvider>
  );
}
