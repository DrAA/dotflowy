import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { whenNodesSyncReady } from "../data/collection";
import { dayKeyToWeekKey } from "../data/date-links";
import { subscribeTree } from "../data/tree-store";
import { getOrCreateDay, getOrCreateScaffold } from "../plugins/daily";
import { getMappedId, localDateKey } from "../plugins/daily/daily-index";
import { refreshLocalDateKey } from "../plugins/daily/local-date-key";

export const Route = createFileRoute("/this-week")({
  component: ThisWeekRedirect,
});

/**
 * Same path as the header "This week" button: ensure today's day shell exists
 * (seed-free — not a write-intent surface, ADR 0041), then zoom the week node.
 */
function ThisWeekRedirect() {
  const navigate = useNavigate();
  const redirectStarted = useRef(false);

  useEffect(() => {
    if (redirectStarted.current) return;
    redirectStarted.current = true;

    // Subscribe so classic sync starts (see /today). Lunora: no-op; the host
    // above AuthGate owns that path.
    const unsub = subscribeTree(() => {});

    void (async () => {
      try {
        await whenNodesSyncReady();
        refreshLocalDateKey();
        const today = localDateKey();
        const weekKey = dayKeyToWeekKey(today);
        if (!weekKey) {
          toast.error("Couldn't open this week's note");
          navigate({ to: "/", replace: true });
          return;
        }
        const dayId = await getOrCreateDay(today, {
          failureToast: "Couldn't open this week's note",
        });
        if (!dayId) {
          navigate({ to: "/", replace: true });
          return;
        }
        const weekId =
          getMappedId(weekKey) ??
          (await getOrCreateScaffold(weekKey, {
            failureToast: "Couldn't open this week's note",
          }));
        if (!weekId) {
          navigate({ to: "/", replace: true });
          return;
        }
        // SPA navigate + replace: same rationale as /today (keep the in-flight
        // structural write alive; don't leave /this-week in history).
        navigate({
          to: "/$nodeId",
          params: { nodeId: weekId },
          replace: true,
        });
      } catch {
        navigate({ to: "/", replace: true });
      } finally {
        unsub();
      }
    })();
  }, [navigate]);

  return null;
}
