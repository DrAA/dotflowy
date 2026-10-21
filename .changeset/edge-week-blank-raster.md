---
"dotflowy": patch
---

**Text and images no longer stay blank in Edge after This week.** The week view remounts the windowed list; rows now wait for the measured scroll offset so `translateY` is not rewritten in the same frame their text and images first paint, and in-view images are not lazy-loaded (that heuristic treats translated rows as off-screen).
