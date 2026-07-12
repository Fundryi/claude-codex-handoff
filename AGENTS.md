# Codex Live Viewer — Agent Guide

Read-only browser dashboard for local OpenAI Codex CLI sessions (including headless handoffs). Follows `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and streams activity to the browser over SSE.

## Layout

- `codex-live-viewer.js` — the entire Node server + CLI. Single file, on purpose.
- `viewer-ui.html` — the entire frontend (HTML/CSS/JS in one file). Theme rules: `docs/UI-THEME.md`.
- `tests/` — `node:test` suites. They extract functions from `codex-live-viewer.js` via regex + `vm.runInNewContext`, so keep function declarations self-contained (`function name(...) { ... }` at top level, no closures over outer state) or the extraction breaks.
- `tray-launcher/` — Rust tray app that runs the Node server in the background (Windows/Linux).
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — active design specs and implementation plans. Finished ones move to `docs/superpowers/archive/` (gitignored, local only).

## Hard rules

- **Zero npm dependencies.** Node stdlib only (`node >= 18`). Never add a package.
- Server stays one file, UI stays one file. No build step for the Node side.
- The viewer is read-only toward Codex sessions — it never writes to `~/.codex`. The only process-touching feature is the explicit Windows stop-task dialog.

## Commands

```sh
npm test          # node --test tests/*.test.js
npm start         # node codex-live-viewer.js serve
npm run stop      # node codex-live-viewer.js stop
npm run tray      # cargo run (tray-launcher)
npm run build:tray
```

## Workflow

- Feature work follows spec → plan → TDD implementation; plans live in `docs/superpowers/plans/` with checkbox steps.
- Commit style: conventional commits (`feat(server):`, `fix(ui):`, `docs:`, `chore(release):`).
- Windows dev machine; paths in tests use `\\`. Shell scripts must work in both PowerShell and Git Bash contexts.
