# AI Live Viewer - Agent Guide

Browser dashboard + control panel for local OpenAI Codex CLI sessions (including headless handoffs), bundled with our own fork of the `codex` Claude Code plugin. Follows `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, streams activity to the browser over SSE, and can resume or cancel Codex and OpenCode jobs (and answer a question by resuming) through the bundled plugin's companion script. It does not start new runs; those come from Claude, a Codex CLI or OpenCode.

The same tree shows Claude chats and OpenCode TUI, CLI and child sessions. Claude and OpenCode transcripts are read only and use the shared feed renderer.

## Layout

- `ai-live-viewer.js`: CLI and server startup.
- `server/`: CommonJS server modules. See the server file map below.
- `ui/`: `index.html` markup, six CSS files and 19 classic scripts in `ui/js/`, loaded in a fixed order. Theme rules: `docs/UI-THEME.md`.
- `plugin/` — our fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc): the `codex` Claude Code plugin (commands, hooks, `scripts/codex-companion.mjs`). Multi-file ESM layout is upstream's, keep it. Upstream updates are pulled selectively via `scripts/upstream-diff.mjs`. OpenCode handoffs (`task --engine opencode`) run through our own `plugin/scripts/lib/opencode.mjs`, which upstream does not have.
- `plugin/viewer/`: bundled copies of `ai-live-viewer.js`, the complete `server/` and `ui/` trees, and `assets/logo.svg`. Refresh with `npm run sync:viewer`; `tests/plugin-viewer-bundle.test.js` guards against drift.
- `.claude-plugin/marketplace.json` — makes this repo an installable Claude Code marketplace (`fundryi`), serving the `codex` plugin from `./plugin`.
- `scripts/upstream-diff.mjs` — clones upstream and diffs it against `plugin/` for manual cherry-picking.
- `tests/` — `node:test` suites. Server/UI functions are extracted via regex + `vm.runInNewContext`, so keep function declarations self-contained (`function name(...) { ... }` at top level, no closures over outer state) or the extraction breaks. Plugin `.mjs` modules are imported directly with dynamic `import()`.
- `docs/superpowers/` — design specs (`specs/`), implementation plans (`plans/`), finished ones in `archive/`. Whole dir is gitignored: plans/specs stay local, never committed.

## Server file map

- `server/runtime.js`: startup config, paths and shared state; `parseFlags`.
- `server/access.js`: tunnel, process inspection and origin guards; `startTunnel`, `codexProcs`, `trustedControlOrigin`.
- `server/events.js`: SSE delivery; `broadcast`.
- `server/sessions.js`: Codex rollouts, search and polling; `ingest`, `sessionSummary`, `buildSearchIndex`, `tick`.
- `server/jobs.js`: companion jobs and liveness; `listCompanionJobs`, `classifyJobLiveness`, `buildCompanionTaskArgs`, `runCompanion`.
- `server/readers.js`: bounded file readers; `readAppended`, `claudeCursor`, `claudeReadHead`, `claudeReadTail`.
- `server/claude-workflows.js`: workflow runs and agents; `claudeTick`, `claudeAgentState`, `claudeTranscriptPage`.
- `server/discovery.js`: Claude file discovery; `claudeDiscover`.
- `server/claude-chats.js`: Claude chats and live state; `claudeChatsTick`, `claudeChatsScan`, `claudeChatView`, `claudeAgentLiveState`.
- `server/opencode.js`: read-only SQLite sessions and transcripts; `opencodeConnection`, `opencodeChatsTick`, `opencodeTranscriptPage`.
- `server/usage.js`: Claude usage and Codex limits; `claudeUsageCheck`, `refreshCodexLimits`.
- `server/http.js`: assets, routes and server creation; `handleRequest`, `handleLaunch`, `createViewerServer`.

`runtime.js` owns stable shared maps and sets, including `claudeWfReaders`. Never reassign these containers. Read and write replaceable frames, arrays and flags through the `shared` object; do not destructure its properties. Keep private state in its owning module. Startup stays in `ai-live-viewer.js`; requiring a module must not bind a port or start a timer.

## UI file map

`ui/index.html` holds markup. It is served at `/`. CSS URLs are `/ui/<name>.css`; script URLs are `/ui/js/<name>.js`. The logo stays at `/logo.svg`. Lists below are in load order.

CSS:

- `ui/theme.css`: tokens, `:root` and the 2200px token override.
- `ui/layout.css`: reset, sidebar, tabs, chips, tree rows, rails and folds.
- `ui/marks.css`: kind marks, working halos, animations and kind words.
- `ui/surfaces.css`: overview, activity, plans, workflows, panels, headers, menus, controls, result card and feed frame.
- `ui/feed.css`: feed grammar, messages, thinking/work rows, Markdown and pagination.
- `ui/responsive.css`: mobile token/layout overrides, container query and reduced motion. Keep last.

JavaScript:

- `ui/js/state.js`: preferences, shared state and DOM handles; `loadPrefs`, `firstLine`.
- `ui/js/markdown.js`: Markdown parsing and DOM output; `parseInline`, `parseMarkdown`, `renderMarkdown`.
- `ui/js/feed-model.js`: result sections, event grouping, actors and internal context; `startedBy`, `workingLine`, `workSummary`.
- `ui/js/rows.js`: row models, metadata, menus and result targets; `buildRows`, `menuItems`, `resultCardModel`, `rowTooltip`.
- `ui/js/workflow-model.js`: workflow filters, phases and selection predicates; `claudeStatusView`, `isEditableElement`.
- `ui/js/tree-model.js`: unified nodes, roots, filters and counts; `buildNodes`, `nodeIdFor`.
- `ui/js/navigation.js`: connection, preferences, views and auto-open; `setConnection`, `chooseView`, `followRunningSession`.
- `ui/js/tree.js`: sidebar badges, rails and row rendering; `nodeBadge`, `renderList`.
- `ui/js/header.js`: selected-row header and actions; `statusChip`, `selectedRow`, `renderHeader`.
- `ui/js/marks.js`: shared avatars, SVG glyphs and kind marks; `GL`, `glyph`, `markElement`, `kindChipsElement`.
- `ui/js/plans.js`: usage windows, reset times and plan rows; `planRow`, `renderPlans`.
- `ui/js/node-header.js`: task facts, breadcrumbs, usage and chat menus; `renderNodeHeader`, `fillChatMenu`, `nodeContextMenu`.
- `ui/js/feed.js`: feed DOM: messages, command/work rows, thinking groups, markers and render batching; `createEvent`, `createWorkBlock`, `createThinkGroupEvent`, `renderFeed`, `renderGhostPage`, `requestFeedRender`.
- `ui/js/overview.js`: Live groups and Activity rail; `overviewRowElement`, `renderHome`, `renderActivity`.
- `ui/js/pages.js`: selection, transcript polling, shared transcript drawing (Codex, Claude, OpenCode and panel feeds) and side panels; `drawTranscript`, `newClaudeFeed`, `snapScrollToGrid`, `renderPanel`.
- `ui/js/workflows.js`: workflow headers, agents, topics and menus; `claudeRunById`, `openClaudeAgent`, `runClaudeMenuAction`.
- `ui/js/jobs.js`: handoff/history loading, run picker and result cards; `refreshJobs`, `openJob`.
- `ui/js/controls.js`: resume/stop dialogs, copy actions and processes; `openStopModal`, `rovingKeydown`, `COPY_COMMANDS`, `showProcesses`.
- `ui/js/boot.js`: panel setup, event bindings, observers, SSE, preference migration, initial renders and polling.

## Hard rules

- **Zero npm dependencies.** Node stdlib only (`node >= 22.13`; requirements always track a current LTS, never an EOL line). Never add a package.
- The server uses CommonJS modules in `server/`, with `ai-live-viewer.js` as the entry. Keep server functions as top-level named function declarations. There is no build step. Add each new server file to the `serverSource` list in `tests/helpers/source.js` and ensure `scripts/sync-viewer.js` copies it.
- The UI lives in `ui/` as ordered classic `<script src>` files and CSS files: no ES modules, no bundler, no build step. The scripts share globals, as one page script did before. Only `ui/js/boot.js` runs code at load (bindings, SSE, timers, first render); every other script only declares functions, constants and state. Keep regex-extracted functions as top-level named declarations. A new UI file goes into `ui/index.html`, `UI_ASSET_FILES` in `server/http.js`, `tests/helpers/source.js` and `scripts/sync-viewer.js`.
- A complete viewer install needs the entry, `server/`, `ui/` and `assets/logo.svg`. Required UI assets load before the server listens. A missing asset fails startup; there is no embedded fallback page.
- Setup changes user config only with consent, by writing or removing our one OpenCode viewer plugin file. It never edits Codex config or hook files, or `opencode.json`. Codex viewer hooks ship in `plugin/codex-hooks/hooks.json`; Claude hooks in `plugin/hooks/hooks.json` must never run inside Codex.
- The viewer shows no desktop pop-ups. The optional Codex PermissionRequest hook and OpenCode viewer plugin only request earlier refreshes. The Codex hook runs only when approval policy is not `never` and the user trusts it. Keep `/notify` and its guards, the job broadcasts to `/notifications`, and both integrations' refresh effects.
- The viewer's OpenCode source is read only. Use a lazy, guarded `node:sqlite` load and `DatabaseSync` with `readOnly: true`. Query only `session_v2` and `session_message`, with explicit columns. The same DB holds OAuth tokens and credentials in other tables. Do not query those tables or send their data to a browser or log. Reuse the handle until the file identity changes or a query fails. Poll on the Claude cadence, including its no-browser slow mode. Pull bounded transcript pages by `seq` behind `trustedControlOrigin`. Do not write, checkpoint, or run write PRAGMAs. A read-only WAL connection can touch the `-shm` file; this is accepted.
- The viewer never *edits* Codex session files or anything under `~/.codex`. `~/.claude` is read-only the same way: the viewer polls the chat, subagent and workflow run files under `~/.claude/projects` (no `fs.watch`, never runs a workflow script, never reads a whole chat file on a timer) and serves their transcripts only behind `trustedControlOrigin`, the gate of `/jobs`. From Claude Code's state file (`~/.claude.json`, or `.claude.json` in `CLAUDE_CONFIG_DIR`) it reads only `cachedUsageUtilization`; the file also holds OAuth and MCP settings, so nothing else from it ever reaches the browser or a log. The newer source for the 5-hour and 7-day windows is `~/.codex-companion/claude-limits.json`, written by the plugin's status line script (`plugin/scripts/claude-statusline.mjs`, only the two documented `rate_limits` windows); the session hook keeps a copy of that script at `~/.codex-companion/claude-statusline.mjs`, and the user's own `statusLine` setting points there (a plugin cannot set it). It DOES spawn codex via `plugin/scripts/codex-companion.mjs` (resume/cancel, and the read-only `limits` read: every 5 min only while a browser is connected, and when a job ends) and shares plugin job state at `~/.codex-companion/state`. All state-changing endpoints are POST, origin-guarded (`trustedControlOrigin`), and confirmed in-app — never `window.confirm`/`alert`.
- Recovery is flag-only: the classifier marks jobs working / possibly-stuck / dead; the user clicks Resume. No auto-resume, no auto-kill. The one permitted automatic state write is liveness bookkeeping — a `queued`/`running` record whose pid is gone is reconciled to `failed` on read (`reconcileDeadJobs`), because nothing else will ever correct it and a frozen record permanently jams `/codex:result`.
  This covers dead or stuck jobs. When Claude answers a Codex "Needs decision" question and resumes that thread (`codex-result-handling` skill), that is a new handoff Claude chooses, not recovery.
- Nothing depends on the Claude process staying alive. Hosts like CloudCLI end it on every new message. The session id stays the same for a normal message (CloudCLI resumes the same chat file), but changes on a fork or `/clear`. Every result must reach Claude through the prompt hook on the next message, so the hook's scope is the whole workspace, never one session.
- Every companion run is detached. Codex is never a child of the calling process, so no harness timeout can end a run. `--background` returns a job id; the default follows the detached job and hands back a job id if it outlives the follow budget.
- Every Codex companion connection spawns its own `codex app-server`. Every OpenCode task uses `opencode run --standalone`. There is no shared broker. Never reintroduce one: a SessionEnd in any Claude session of the workspace used to shut it down and abort every turn on it.
- License: Apache 2.0 + Commons Clause (root `LICENSE`: use, change, fork and share, never sell). `plugin/` came from openai/codex-plugin-cc under Apache 2.0, so `plugin/LICENSE` stays byte-identical to upstream and `plugin/NOTICE` keeps OpenAI's notice, with our addendum and the Commons Clause text at its end (the installed plugin holds only `plugin/`, so the clause travels in NOTICE).

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
npm start         # node ai-live-viewer.js serve
npm run stop      # node ai-live-viewer.js stop
node scripts/upstream-diff.mjs   # diff plugin/ against upstream (--full for whole diff)
```

## Workflow

- Feature work follows spec → plan → TDD implementation; plans live in `docs/superpowers/plans/` with checkbox steps.
- Create releases by hand with `gh`. Releases have no zip assets. The plugin installs from the marketplace.
- Commit style: conventional commits (`feat(server):`, `feat(ui):`, `feat(plugin):`, `docs:`, `chore(release):`).
- Every release gets a hand-written `plugin/CHANGELOG.md` entry; nothing generates it. The GitHub release notes are that entry, cut from the file. Style: plain ASD-STE100 English, a bold lead sentence per bullet, and every removed test named with its reason.
- Every plugin release: sweep for stale facts before the version bump. Facts: model aliases and defaults, effort lists (`max`/`ultra`), the checked Codex CLI version, command options, file paths, versions. Places: `README.md`, `plugin/skills/`, `plugin/commands/`, `plugin/agents/`, `plugin/CHANGELOG.md` (new entry only), the viewer, `docs/superpowers/STATUS.md`, the KB pages in `../knowledge-base/wiki/projects/claude-handoff-improvment/`, auto-memory, and routing tables in other projects that quote the plugin. One owner per fact (the code for aliases and efforts, the README effort table for users, the runtime skill for Claude); other places link to it. A model whose Codex retirement date (`upgrade.retirement_at` in `codex debug models`) is less than 3 months away is removed from the docs, aliases and skills; no shortcut ever points at it.
- Windows dev machine; paths in tests use `\\`. Shell scripts must work in both PowerShell and Git Bash contexts.

## Shared knowledge base

If the shared KB is configured and `../knowledge-base/AGENTS.md` exists, search it before domain answers or code changes and follow its operating rules.

- Project knowledge: `../knowledge-base/wiki/projects/claude-handoff-improvment/`
- Freshness: when a registered source path changes, follow `../knowledge-base/wiki/meta/knowledge-freshness.md`.

If the shared KB is unavailable, state that access is unavailable and do not invent its contents.
