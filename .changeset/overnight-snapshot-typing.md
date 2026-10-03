---
"dotflowy": patch
---

**Typing no longer vanishes a few seconds after overnight reconnect / This week.** Mid-session sync snapshots re-apply focused contentEditable text and in-flight coalesced field edits after truncate, so a remount cannot paint stale server text over keystrokes that only lived in the DOM.
