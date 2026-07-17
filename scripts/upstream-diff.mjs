#!/usr/bin/env node
// Compare our plugin/ against the latest openai/codex-plugin-cc default branch.
// Usage: node scripts/upstream-diff.mjs [--full]
// Prints a --stat summary by default; --full prints the whole diff.
// Cherry-pick what you like by hand - upstream updates are opt-in, never automatic.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM = "https://github.com/openai/codex-plugin-cc.git";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(repoRoot, "plugin");
const full = process.argv.includes("--full");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-upstream-"));
try {
  console.log(`[i] Cloning ${UPSTREAM} (depth 1)...`);
  execFileSync("git", ["clone", "--depth", "1", UPSTREAM, tmp], { stdio: ["ignore", "ignore", "inherit"] });
  fs.rmSync(path.join(tmp, ".git"), { recursive: true, force: true });
  for (const dir of [".github", "tests"]) fs.rmSync(path.join(tmp, dir), { recursive: true, force: true });

  const args = ["diff", "--no-index"];
  if (!full) args.push("--stat");
  args.push("--", tmp, pluginDir);
  // git diff --no-index exits 1 when files differ - that is the expected case
  const r = spawnSync("git", args, { stdio: "inherit" });
  if (r.status !== 0 && r.status !== 1) process.exit(r.status ?? 1);
  console.log("\n[i] Left = upstream, right = our plugin/. Rerun with --full for the complete diff.");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
