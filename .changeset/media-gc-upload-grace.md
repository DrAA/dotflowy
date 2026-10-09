---
"dotflowy": patch
---

**Just-pasted images are no longer wiped by orphan GC.** Tree-driven media cleanup skips attachments younger than two minutes, so Enter / sync turbulence right after upload cannot persist-delete the new kv row (R2 was already fine; the pointer is what vanished).
