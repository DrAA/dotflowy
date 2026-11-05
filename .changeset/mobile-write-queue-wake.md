---
"dotflowy": patch
---

**Stuck “changes waiting to sync” on mobile clears after you return to the tab.** The offline write queue now retries on tab wake and on a short backoff — not only on the `online` event, which often never re-fires after a backgrounded phone tab.
