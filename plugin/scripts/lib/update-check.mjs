import fs from "node:fs";
import https from "node:https";
import path from "node:path";

const MANIFEST_URL = "https://raw.githubusercontent.com/Fundryi/claude-codex-handoff/main/plugin/.claude-plugin/plugin.json";
const CHECK_INTERVAL_MS = 24 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 800;

export function compareVersions(a, b) {
  const pa = String(a ?? "").split(".").map(Number);
  const pb = String(b ?? "").split(".").map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN) || pa.length !== 3 || pb.length !== 3) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function buildUpdateNotice(current, latest) {
  if (!latest || compareVersions(current, latest) >= 0) return null;
  return `[codex plugin] Update available: ${current} -> ${latest}. Update with: /plugin marketplace update fundryi  (then restart the Claude Code session)`;
}

export function cacheIsFresh(cache, now) {
  return Boolean(cache && typeof cache.checkedAt === "number" && now - cache.checkedAt < CHECK_INTERVAL_MS);
}

export function fetchLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get(MANIFEST_URL, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      let body = "";
      res.on("data", (c) => { if (body.length < 10000) body += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(body).version ?? null); } catch { resolve(null); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

export async function checkForUpdate({ currentVersion, cacheFile, env = process.env, fetcher = fetchLatestVersion, now = Date.now() } = {}) {
  try {
    if (env.CODEX_PLUGIN_UPDATE_CHECK === "0") return null;
    if (!currentVersion || !cacheFile) return null;
    let cache = null;
    try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch {}
    if (!cacheIsFresh(cache, now)) {
      const latestVersion = await fetcher();
      cache = { checkedAt: now, latestVersion: latestVersion ?? cache?.latestVersion ?? null };
      try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(cache));
      } catch {}
    }
    return buildUpdateNotice(currentVersion, cache?.latestVersion ?? null);
  } catch {
    return null;
  }
}
