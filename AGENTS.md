# AI Live Viewer - Agent Guide

Browser dashboard + control panel for local OpenAI Codex CLI sessions (including headless handoffs), bundled with our own fork of the `codex` Claude Code plugin. Follows `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, streams activity to the browser over SSE, and can resume or cancel Codex and OpenCode jobs (and answer a question by resuming) through the bundled plugin's companion script. It does not start new runs; those come from Claude, a Codex CLI or OpenCode.

The same tree shows Claude chats and OpenCode TUI, CLI and child sessions. Claude and OpenCode transcripts are read only and use the shared feed renderer.

## Layout

- `codex-live-viewer.js` — the entire Node server + CLI. Single file, on purpose.
- `viewer-ui.html` — the entire frontend (HTML/CSS/JS in one file). Theme rules: `docs/UI-THEME.md`.
- `plugin/` — our fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc): the `codex` Claude Code plugin (commands, hooks, `scripts/codex-companion.mjs`). Multi-file ESM layout is upstream's, keep it. Upstream updates are pulled selectively via `scripts/upstream-diff.mjs`. OpenCode handoffs (`task --engine opencode`) run through our own `plugin/scripts/lib/opencode.mjs`, which upstream does not have.
- `plugin/viewer/` — bundled copies of the server and UI. Refresh with `npm run sync:viewer`; `tests/plugin-viewer-bundle.test.js` guards against drift.
- `.claude-plugin/marketplace.json` — makes this repo an installable Claude Code marketplace (`fundryi`), serving the `codex` plugin from `./plugin`.
- `scripts/upstream-diff.mjs` — clones upstream and diffs it against `plugin/` for manual cherry-picking.
- `tests/` — `node:test` suites. Server/UI functions are extracted via regex + `vm.runInNewContext`, so keep function declarations self-contained (`function name(...) { ... }` at top level, no closures over outer state) or the extraction breaks. Plugin `.mjs` modules are imported directly with dynamic `import()`.
- `tray-launcher/` — Rust tray app that runs the Node server in the background (Windows/Linux).
- `docs/superpowers/` — design specs (`specs/`), implementation plans (`plans/`), finished ones in `archive/`. Whole dir is gitignored: plans/specs stay local, never committed.

## Hard rules

- **Zero npm dependencies.** Node stdlib only (`node >= 22.13`; requirements always track a current LTS, never an EOL line). Never add a package.
- Server stays one file, UI stays one file. No build step for the Node side.
- The viewer's OpenCode source is read only. Use a lazy, guarded `node:sqlite` load and `DatabaseSync` with `readOnly: true`. Query only `session_v2` and `session_message`, with explicit columns. The same DB holds OAuth tokens and credentials in other tables. Do not query those tables or send their data to a browser or log. Reuse the handle until the file identity changes or a query fails. Poll on the Claude cadence, including its no-browser slow mode. Pull bounded transcript pages by `seq` behind `trustedControlOrigin`. Do not write, checkpoint, or run write PRAGMAs. A read-only WAL connection can touch the `-shm` file; this is accepted.
- The viewer never *edits* Codex session files or anything under `~/.codex`. `~/.claude` is read-only the same way: the viewer polls the chat, subagent and workflow run files under `~/.claude/projects` (no `fs.watch`, never runs a workflow script, never reads a whole chat file on a timer) and serves their transcripts only behind `trustedControlOrigin`, the gate of `/jobs`. From Claude Code's state file (`~/.claude.json`, or `.claude.json` in `CLAUDE_CONFIG_DIR`) it reads only `cachedUsageUtilization`; the file also holds OAuth and MCP settings, so nothing else from it ever reaches the browser or a log. The newer source for the 5-hour and 7-day windows is `~/.codex-companion/claude-limits.json`, written by the plugin's status line script (`plugin/scripts/claude-statusline.mjs`, only the two documented `rate_limits` windows); the session hook keeps a copy of that script at `~/.codex-companion/claude-statusline.mjs`, and the user's own `statusLine` setting points there (a plugin cannot set it). It DOES spawn codex via `plugin/scripts/codex-companion.mjs` (resume/cancel, and the read-only `limits` read: every 5 min only while a browser is connected, and when a job ends) and shares plugin job state at `~/.codex-companion/state`. All state-changing endpoints are POST, origin-guarded (`trustedControlOrigin`), and confirmed in-app — never `window.confirm`/`alert`.
- Recovery is flag-only: the classifier marks jobs working / possibly-stuck / dead; the user clicks Resume. No auto-resume, no auto-kill. The one permitted automatic state write is liveness bookkeeping — a `queued`/`running` record whose pid is gone is reconciled to `failed` on read (`reconcileDeadJobs`), because nothing else will ever correct it and a frozen record permanently jams `/codex:result`.
  This covers dead or stuck jobs. When Claude answers a Codex "Needs decision" question and resumes that thread (`codex-result-handling` skill), that is a new handoff Claude chooses, not recovery.
- Nothing depends on the Claude process staying alive. Hosts like CloudCLI end it on every new message. The session id stays the same for a normal message (CloudCLI resumes the same chat file), but changes on a fork or `/clear`. Every result must reach Claude through the prompt hook on the next message, so the hook's scope is the whole workspace, never one session.
- Every companion run is detached. Codex is never a child of the calling process, so no harness timeout can end a run. `--background` returns a job id; the default follows the detached job and hands back a job id if it outlives the follow budget.
- Every Codex companion connection spawns its own `codex app-server`. Every OpenCode task uses `opencode run --standalone`. There is no shared broker. Never reintroduce one: a SessionEnd in any Claude session of the workspace used to shut it down and abort every turn on it.
- License: Apache 2.0 + Commons Clause (root `LICENSE`: use, change, fork and share, never sell). `plugin/` came from openai/codex-plugin-cc under Apache 2.0, so `plugin/LICENSE` stays byte-identical to upstream and `plugin/NOTICE` keeps OpenAI's notice, with our addendum and the Commons Clause text at its end (the installed plugin holds only `plugin/`, so the clause travels in NOTICE). Release zips carry the root `LICENSE` beside `plugin/LICENSE` and `plugin/NOTICE`.

## Env vars

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_PLUGIN_SANDBOX` | `danger-full-access` | Sandbox for all companion runs (full access by default: Store-pwsh breaks sandboxed spawns on this machine with error 1312) |
| `CODEX_PLUGIN_FAST_TIER` | `priority` | Service tier used by `--fast` runs |
| `CODEX_PLUGIN_UPDATE_CHECK` | `1` | Set `0` to disable the daily session-start update check. |
| `CODEX_COMPANION_STATE_ROOT` | `~/.codex-companion/state` | Shared job state root (plugin CLI + viewer) |
| `CODEX_VIEWER_PORT` | `8377` | Viewer HTTP port; also where the companion POSTs job completions (`/notify`) |
| `CODEX_VIEWER_HOST` | `127.0.0.1` | Viewer bind address (`--host` overrides; `0.0.0.0` = LAN, no token) |
| `CODEX_VIEWER_ALLOWED_HOSTS` | (none) | Comma list of reverse-proxy names trusted by `controlHosts`; when set, the default bind becomes `0.0.0.0` |
| `CODEX_VIEWER_AUTOSTART` | `1` | Set to `0` to disable SessionStart viewer autostart |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where the viewer reads Claude chats, subagents and workflow runs (`projects/`), live processes (`sessions/`) and, when set, `.claude.json` for plan usage |
| `OPENCODE_DB` | `$XDG_DATA_HOME/opencode/opencode.db` or `~/.local/share/opencode/opencode.db` | OpenCode sessions and messages, read only; same default on Windows |

## Commands

```sh
npm test          # node --test tests/*.test.js
npm start         # node codex-live-viewer.js serve
npm run stop      # node codex-live-viewer.js stop
npm run tray      # cargo run (tray-launcher)
npm run build:tray
node scripts/upstream-diff.mjs   # diff plugin/ against upstream (--full for whole diff)
```

## Workflow

- Feature work follows spec → plan → TDD implementation; plans live in `docs/superpowers/plans/` with checkbox steps.
- Commit style: conventional commits (`feat(server):`, `feat(ui):`, `feat(plugin):`, `docs:`, `chore(release):`).
- Every release gets a hand-written `plugin/CHANGELOG.md` entry; nothing generates it. The GitHub release notes are that entry, cut from the file. Style: plain ASD-STE100 English, a bold lead sentence per bullet, and every removed test named with its reason.
- Every plugin release: sweep for stale facts before the version bump. Facts: model aliases and defaults, effort lists (`max`/`ultra`), the checked Codex CLI version, command options, file paths, versions. Places: `README.md`, `plugin/skills/`, `plugin/commands/`, `plugin/agents/`, `plugin/CHANGELOG.md` (new entry only), the viewer, `docs/superpowers/STATUS.md`, the KB pages in `../knowledge-base/wiki/projects/claude-handoff-improvment/`, auto-memory, and routing tables in other projects that quote the plugin. One owner per fact (the code for aliases and efforts, the README effort table for users, the runtime skill for Claude); other places link to it. A model whose Codex retirement date (`upgrade.retirement_at` in `codex debug models`) is less than 3 months away is removed from the docs, aliases and skills; no shortcut ever points at it.
- Windows dev machine; paths in tests use `\\`. Shell scripts must work in both PowerShell and Git Bash contexts.

## Shared knowledge base

If the shared KB is configured and `../knowledge-base/AGENTS.md` exists, search it before domain answers or code changes and follow its operating rules.

- Project knowledge: `../knowledge-base/wiki/projects/claude-handoff-improvment/`
- Freshness: when a registered source path changes, follow `../knowledge-base/wiki/meta/knowledge-freshness.md`.

If the shared KB is unavailable, state that access is unavailable and do not invent its contents.
