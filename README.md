<p align="center">
  <img src="assets/logo.svg" alt="Claude Codex Handoff logo" width="120">
</p>

# Claude Codex Handoff

Hand coding tasks from [Claude Code](https://claude.com/claude-code) to [OpenAI Codex CLI](https://github.com/openai/codex) — and never lose one again. A fork of the official `codex` Claude Code plugin with reliability built in, bundled with a live web dashboard to start, watch, resume, and cancel headless Codex runs.

![zero npm dependencies](https://img.shields.io/badge/npm_dependencies-0-brightgreen) ![node >= 18](https://img.shields.io/badge/node-%3E%3D18-blue)

> ⚠️ **Sandbox: full access by default.** Codex runs launched by this plugin use `danger-full-access` — Codex can read/write anywhere and run any command, as your user. This is deliberate: the sandboxed modes are broken on common Windows setups (Store PowerShell stub → `CreateProcessAsUserW failed: 1312`) and were a constant source of dead handoffs. If your machine's sandbox works and you want it back: `CODEX_PLUGIN_SANDBOX=workspace-write`. Use full access only on machines you trust with the code you run.

## Install

In Claude Code:

```
/plugin marketplace add Fundryi/claude-codex-handoff
/plugin install codex@fundryi
```

If you had the OpenAI-marketplace `codex` plugin, uninstall it first — all `/codex:*` command names are identical, so nothing else changes. Requires [Node.js 18+](https://nodejs.org) and the Codex CLI (`npm install -g @openai/codex`, then `codex login`).

That's the whole setup. On your next Claude Code session:

- the **dashboard auto-starts** in the background (browser stays closed; open it anytime with `/codex:viewer`),
- the plugin **checks for updates once a day** and prints the update command when there's a new version.

## What you get

**In Claude Code** — the familiar commands, made reliable:

| Command | Does |
|---|---|
| `/codex:rescue` | Hand a task to Codex (investigate, fix, implement) as a background job |
| `/codex:review` / `/codex:adversarial-review` | Codex reviews your working tree / challenges your design |
| `/codex:status` / `/codex:result` / `/codex:cancel` | Track, fetch, or stop background jobs |
| `/codex:transfer` | Move the current Claude session into a Codex thread |
| `/codex:viewer` | Open the live dashboard |
| `/codex:setup` | Check Codex CLI readiness |

Say **"use fast mode"** in a rescue request (or pass `--fast`) for priority processing — faster, uses more quota, opt-in per job, never the default.

**In the browser** (`localhost:8377`) — a live dashboard *and* control panel:

- Every Codex session on the machine streams live: prompts, commands, output, patches, reasoning — however it was started.
- **JOBS tab** with ground truth, not guesses: jobs are **RUNNING** (heartbeat fresh / process alive on a long task), **QUIET — process alive** (silent 5+ min), or **DEAD — resumable** (process gone). Long-running commands are never misflagged.
- When a job dies you see **why** — sandbox failures, expired `codex login`, rate limits — with a fix hint.
- **One-click resume** for dead jobs, optionally with higher effort or a different model. Refuses while the process still lives. Recovery is always flag-only: it marks, you click — no auto-resume, no auto-kill.
- **Start new tasks and reviews from the browser**: project, prompt, effort (`none`→`xhigh`), model, write access, sandbox, fast mode. Same job store as the CLI — `/codex:status` and the JOBS tab always agree.
- Cancel with a real turn-interrupt + process-tree kill; completions push to the UI instantly.
- Search across all recorded sessions, effort/sandbox/token display per session, archived-session handling, unread markers, sound cues, saved layout prefs.

## Using it well

Patterns that make handoffs reliable (distilled from daily use):

1. **Write a contract, not an essay.** Keep short per-task-type instruction files in your repo (e.g. `handoff/coding.md`, `handoff/review.md`) and open every handoff prompt with one line: `Follow handoff/coding.md (binding). Task: …`. The prompt then only carries scope, done-criteria, and task-specific decisions.
2. **Scope limits writes, not reads.** Let Codex read anything to trace the real flow, but name the files it may change. Allow root-cause fixes outside the named files only when declared and justified in the report.
3. **Demand a self-check gate.** End your contract with checks Codex must run before returning — linters, validators, greps for your codebase's known failure patterns. Every bug class a review catches becomes a permanent pre-return check: quality compounds.
4. **Fix a return format.** Findings verified → fixed/skipped list → diff → per-file manifest → self-check results → out-of-scope observations. Uniform returns are reviewable at a glance.
5. **Match effort to the task.** `low`/`medium` for mechanical work, `high`/`xhigh` for designs and gnarly bugs; add `--fast` only when you're actively waiting on the result.
6. **Let the dashboard carry the anxiety.** Kick off jobs, keep working; the JOBS tab tells you truthfully if something needs a click. Claude Code restarts don't kill handoffs — workers are detached and resumable.

## Standalone viewer (no plugin)

The dashboard also runs on its own — it only reads `~/.codex/sessions/`:

```sh
node codex-live-viewer.js start    # background + open browser
node codex-live-viewer.js serve    # foreground
node codex-live-viewer.js stop
```

Or grab a tray app from [Releases](../../releases): `Codex-Live-Viewer-Windows-x64.zip` (double-click the exe) or `Codex-Live-Viewer-Linux-x64.zip` (needs GTK 3 + Ayatana AppIndicator). The tray supervises the server and shows completion toasts. macOS: no tray build — use the Node CLI or the plugin's autostart.

**Remote access:** `--host 0.0.0.0` for your LAN; `--tunnel` for a free Cloudflare quick tunnel (token-gated, printed on start); `--tunnel-token <t>` for a named tunnel on your own domain. Local access never needs a token.

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `CODEX_PLUGIN_SANDBOX` | `danger-full-access` | Sandbox for plugin/dashboard-launched runs (see warning at top) |
| `CODEX_PLUGIN_FAST_TIER` | `priority` | Service tier used by `--fast` |
| `CODEX_PLUGIN_UPDATE_CHECK` | `1` | `0` disables the daily update check |
| `CODEX_VIEWER_AUTOSTART` | `1` | `0` disables the session-start dashboard autostart |
| `CODEX_VIEWER_PORT` | `8377` | Dashboard port (also receives job-completion pushes) |
| `CODEX_COMPANION_STATE_ROOT` | `~/.codex-companion/state` | Shared job state (CLI + dashboard) |
| `CODEX_HOME` | `~/.codex` | Where Codex session files are read from |
| `CODEX_VIEWER_TRAY_PORT` | port + 1 | Tray single-instance lock |
| `CODEX_VIEWER_NOTIFICATIONS` | `1` | `0` disables tray toasts |

## When something gets stuck

1. Check the JOBS tab — the badge tells you the truth (running / quiet-but-alive / dead), with the death reason if there is one.
2. Dead job → **Resume** (optionally bump effort). The dashboard refuses if the process is actually still alive.
3. Truly wedged process → stop dialog (Windows shows the full command line and warns before touching shared `app-server`/MCP hosts), then Resume.
4. Sessions started outside the plugin get copy-paste `codex exec resume <id> "…"` / `codex resume` / `codex fork` commands instead.

## Security notes

- Listens on `127.0.0.1` by default; state-changing endpoints are POST-only, origin-guarded, and confirmed in-app.
- Never edits Codex session files or `~/.codex` — it spawns Codex only through the bundled companion, only when you act.
- Remember the trade-off at the top: convenience came from dropping the sandbox. That's a real decision, not a default to forget about.

## Project layout

- `codex-live-viewer.js` — Node server, CLI, rollout parser, control endpoints (one file, no deps)
- `viewer-ui.html` — the whole frontend (one file)
- `plugin/` — the Claude Code plugin (fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc); keeps its Apache-2.0 `LICENSE`/`NOTICE`)
- `plugin/viewer/` — bundled dashboard copies (refreshed by `npm run sync:viewer`, drift-guarded by tests)
- `scripts/upstream-diff.mjs` — diff `plugin/` against upstream for selective, manual cherry-picks
- `tests/` — zero-dep `node:test` suites
- `tray-launcher/` — Rust tray app (Windows/Linux)
