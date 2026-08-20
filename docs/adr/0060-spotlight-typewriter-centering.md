---
status: accepted
---

# Spotlight typewriter centering

**What.** While spotlight mode is on, focusing a list bullet scrolls that row to the vertical center of the visual viewport. Same toggle as the dim (ADR 0033); default still OFF. The zoomed page title is not a list row and is skipped — centering it would hide its children.

**Why bound to spotlight, not a second setting.** Spotlight already means "focus on this line." A bright line at the top or bottom of a dim field is a weaker version of that; putting it in the middle is the same intent, not a new one. A second toggle would be two controls for one mode.

**Why window scroll from the live rect, not `virtualizer.scrollToIndex`.** The focused row is mounted (it holds the caret), so `getBoundingClientRect()` is the position the user sees. An interruptible ease-out slide (`240ms`, cubic) writes `window.scrollY`; the window virtualizer already observes that. Calling `scrollToIndex` would go through estimated sizes and fight the virtualizer the way ADR 0033 feared; this path does not. A new focus cancels the in-flight rAF and retargets from the current offset, so rapid arrows chase the next line instead of queuing. `prefers-reduced-motion` snaps.

**Why half-viewport `paddingStart`/`paddingEnd` on the virtualizer.** Without it, the first and last rows cannot reach center — `window.scrollY` clamps at 0 and at max. The pad is the virtualizer's own (absolute rows ignore CSS padding-box). A compensating `scrollBy` on toggle keeps the current view from jumping. Mount compensates too: skipping it leaves `paddingStart ≈ ½vh` at `scrollY 0`, so the first row sits in the empty well. `scrollBy(0, +pad)` on mount looks past the well onto the first row.

**Why pointer waits for pointerup.** Centering on `focusin` would yank a click-drag text selection the moment the caret landed. Keyboard (and programmatic focus, e.g. Enter) centers on `focusin`; pointer centers on `pointerup`, and a non-collapsed selection inside the row is skipped.

**Rejected alternatives.**

- **A separate typewriter toggle.** Two settings for one intent; spotlight-off users who want centering can turn spotlight on.
- **`virtualizer.scrollToIndex({ align: "center" })`.** Estimates, not the live rect; the ADR 0033 "fights the virtualizer" case.
- **`Element.scrollIntoView({ block: "center" })`.** Unreliable on the absolutely-positioned windowed rows (ADR 0019).
- **`window.scrollTo({ behavior: "smooth" })`.** Browser-timed, retargets inconsistently when the next arrow fires mid-slide. The rAF ease-out is interruptible and the same duration every time.
- **Center on every `focusin`, including pointer.** Breaks drag-select.
