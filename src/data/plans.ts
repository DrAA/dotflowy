/**
 * Client-side plan display facts for the pricing surface (#171). The ENTITLEMENT
 * source of truth is server-side (`worker/plan.ts` + the D1 subscription table);
 * these constants only drive the Settings UI, so a drift here can never grant or
 * deny access — it can only mislabel a card, which the gates behind it correct.
 *
 * The plan NAMES ("unlimited" / "founding") are the Better Auth plugin's plan
 * ids (worker/auth.ts `subscription.plans`) and MUST match, since
 * `subscription.upgrade({ plan })` sends them verbatim.
 */

/** A resolved plan for display. Mirrors `worker/plan.ts` `Plan`. */
export type PlanName = "free" | "unlimited" | "founding";

export const PLAN_LABELS: Record<PlanName, string> = {
  free: "Free",
  unlimited: "Unlimited",
  founding: "Founding",
};
