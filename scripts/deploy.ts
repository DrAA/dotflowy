/**
 * Ship the built SPA + Worker.
 *
 * Cloudflare cloud upload is gated by `deploy.config.json` → `cloudflareDeploy`.
 * This host runs the Worker locally (systemd + nginx on flowy.aaintelligence.se);
 * leave that flag false so `bun run deploy` never calls `wrangler deploy`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CONFIG_PATH = resolve(ROOT, "deploy.config.json");

type DeployConfig = { cloudflareDeploy?: boolean };

function loadConfig(): DeployConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as DeployConfig;
  } catch {
    // Missing/unreadable config → upstream default (Cloudflare cloud deploy).
    return { cloudflareDeploy: true };
  }
}

function run(cmd: string[], label: string): void {
  const proc = Bun.spawnSync(cmd, {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    console.error(`[deploy] ${label} failed (exit ${proc.exitCode ?? "?"})`);
    process.exit(proc.exitCode ?? 1);
  }
}

const config = loadConfig();

run(["bun", "run", "build:cf"], "build:cf");

if (config.cloudflareDeploy !== true) {
  console.log(
    `[deploy] cloudflareDeploy is off (${CONFIG_PATH}). Built dist/client; skipped wrangler deploy.`,
  );
  console.log(
    "[deploy] Restart the host Worker to serve the new build (e.g. make -C .. deploy).",
  );
  process.exit(0);
}

run(["bunx", "wrangler", "deploy"], "wrangler deploy");
