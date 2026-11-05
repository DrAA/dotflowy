---
"dotflowy": patch
---

**`bun run deploy` can skip Cloudflare cloud upload.** `deploy.config.json` gates `wrangler deploy`; when `cloudflareDeploy` is false it only runs the build so a self-hosted Worker can be restarted instead.
