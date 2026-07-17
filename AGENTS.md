# Codex Control Panel — Agent Guide

Browser dashboard + control panel for local OpenAI Codex CLI sessions (including headless handoffs), bundled with our own fork of the `codex` Claude Code plugin. Follows `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, streams activity to the browser over SSE, and can start/review/resume/cancel Codex jobs through the bundled plugin's companion script.

## Layout

- `codex-live-viewer.js` — the entire Node server + CLI. Single file, on purpose.
- `viewer-ui.html` — the entire frontend (HTML/CSS/JS in one file). Theme rules: `docs/UI-THEME.md`.
- `plugin/` — our fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc): the `codex` Claude Code plugin (commands, hooks, `scripts/codex-companion.mjs`). Multi-file ESM layout is upstream's, keep it. Upstream updates are pulled selectively via `scripts/upstream-diff.mjs`.
- `plugin/viewer/` — bundled copies of the server and UI. Refresh with `npm run sync:viewer`; `tests/plugin-viewer-bundle.test.js` guards against drift.
- `.claude-plugin/marketplace.json` — makes this repo an installable Claude Code marketplace (`fundryi`), serving the `codex` plugin from `./plugin`.
- `scripts/upstream-diff.mjs` — clones upstream and diffs it against `plugin/` for manual cherry-picking.
- `tests/` — `node:test` suites. Server/UI functions are extracted via regex + `vm.runInNewContext`, so keep function declarations self-contained (`function name(...) { ... }` at top level, no closures over outer state) or the extraction breaks. Plugin `.mjs` modules are imported directly with dynamic `import()`.
- `tray-launcher/` — Rust tray app that runs the Node server in the background (Windows/Linux).
- `docs/superpowers/` — design specs (`specs/`), implementation plans (`plans/`), finished ones in `archive/`. Whole dir is gitignored: plans/specs stay local, never committed.

## Hard rules

- **Zero npm dependencies.** Node stdlib only (`node >= 18`). Never add a package.
- Server stays one file, UI stays one file. No build step for the Node side.
- The viewer never *edits* Codex session files or anything under `~/.codex`. It DOES spawn codex via `plugin/scripts/codex-companion.mjs` (task/review/resume/cancel) and shares plugin job state at `~/.codex-companion/state`. All state-changing endpoints are POST, origin-guarded (`trustedControlOrigin`), and confirmed in-app — never `window.confirm`/`alert`.
- Recovery is flag-only: the classifier marks jobs working / possibly-stuck / dead; the user clicks Resume. No auto-resume, no auto-kill.

## Env vars

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_PLUGIN_SANDBOX` | `danger-full-access` | Sandbox for all companion runs (full access by default: Store-pwsh breaks sandboxed spawns on this machine with error 1312) |
| `CODEX_COMPANION_STATE_ROOT` | `~/.codex-companion/state` | Shared job state root (plugin CLI + viewer) |
| `CODEX_VIEWER_PORT` | `8377` | Viewer HTTP port; also where the companion POSTs job completions (`/notify`) |
| `CODEX_VIEWER_AUTOSTART` | `1` | Set to `0` to disable SessionStart viewer autostart |

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
- Windows dev machine; paths in tests use `\\`. Shell scripts must work in both PowerShell and Git Bash contexts.
