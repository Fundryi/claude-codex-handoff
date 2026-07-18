<p align="center">
  <img src="assets/logo.svg" alt="Claude Codex Handoff logo" width="120">
</p>

# Claude Codex Handoff

Hand coding tasks from [Claude Code](https://claude.com/claude-code) to the [OpenAI Codex CLI](https://github.com/openai/codex) without losing them. This is a fork of the official `codex` Claude Code plugin with reliability built in, plus a live web dashboard to start, watch, resume, and cancel headless Codex runs.

![zero npm dependencies](https://img.shields.io/badge/npm_dependencies-0-brightgreen) ![node >= 22](https://img.shields.io/badge/node-%3E%3D22-blue)

> [!WARNING]
> **Codex runs with full access by default.** Runs launched by this plugin use `danger-full-access`: Codex can read and write anywhere and run any command, as your user. This is deliberate. The sandboxed modes are broken on common Windows setups (the Store PowerShell stub fails with `CreateProcessAsUserW 1312`) and were a constant source of dead handoffs. If sandboxing works on your machine and you want it back, set `CODEX_PLUGIN_SANDBOX=workspace-write`. Use full access only on machines you trust with the code you run.

## Install

In Claude Code:

```
/plugin marketplace add Fundryi/claude-codex-handoff
/plugin install codex@fundryi
```

If you had the OpenAI-marketplace `codex` plugin, uninstall it first. All `/codex:*` command names are identical, so nothing else changes. You need [Node.js](https://nodejs.org) 22 or newer (any current LTS) and the Codex CLI (`npm install -g @openai/codex`, then `codex login`).

That is the whole setup. On your next Claude Code session the dashboard starts itself in the background (the browser stays closed until you run `/codex:viewer`), and the plugin checks once a day whether a newer version exists, printing the update command when one does.

## What you get

In Claude Code, the familiar commands:

| Command | Does |
|---|---|
| `/codex:rescue` | Hand a task to Codex (investigate, fix, implement) as a background job |
| `/codex:review` / `/codex:adversarial-review` | Codex reviews your working tree, or challenges your design |
| `/codex:status` / `/codex:result` / `/codex:cancel` | Track, fetch, or stop background jobs |
| `/codex:transfer` | Move the current Claude session into a Codex thread |
| `/codex:viewer` | Open the live dashboard |
| `/codex:setup` | Check Codex CLI readiness |

Say "use fast mode" in a rescue request (or pass `--fast`) for priority processing. It is faster, costs more quota, and stays opt-in per job.

In the browser (`localhost:8377`), a live dashboard that can also act:

- Every Codex session on the machine streams live, however it was started: prompts, shell commands, output, patches, reasoning summaries.
- The JOBS tab shows ground truth instead of guesses. A job is RUNNING (heartbeat fresh, or the process is alive on a long command), QUIET (alive but silent for over 5 minutes), or DEAD and resumable (process gone). Liveness comes from the real PID, so a long silent command is never mistaken for a stuck job.
- When a job dies you see why: a broken sandbox, an expired `codex login`, a rate limit. Each cause comes with a fix hint.
- Dead jobs get a Resume button, optionally with higher effort or a different model. The dashboard refuses to resume while the process is still alive, and it never resumes or kills anything on its own. It marks, you click.
- You can start tasks and reviews from the browser: project, prompt, effort (`none` to `xhigh`), model, write access, sandbox, fast mode. The CLI and the browser share one job store, so `/codex:status` and the JOBS tab always agree.
- Cancel does a real turn interrupt plus a process-tree kill. Completions push to the UI the moment they happen.
- Also there: search across all recorded sessions, per-session effort/sandbox/token display, archived-session handling, unread markers, sound cues, and layout preferences that survive restarts.

## Using it well

Patterns from daily use that make handoffs reliable:

1. Write a contract, not an essay. Keep short per-task-type instruction files in your repo (say `handoff/coding.md` and `handoff/review.md`) and open every handoff prompt with one line: `Follow handoff/coding.md (binding). Task: ...`. The prompt itself then only carries scope, done-criteria, and task-specific decisions.
2. Scope limits writes, not reads. Let Codex read anything it needs to trace the real flow, but name the files it may change. Allow fixes outside the named files only when the report declares and justifies them.
3. Demand a self-check gate. End your contract with checks Codex must run before returning: linters, validators, greps for your codebase's known failure patterns. Every bug class a review catches becomes a permanent pre-return check, so quality compounds.
4. Fix a return format. Findings verified, fixed/skipped list, diff, per-file manifest, self-check results, out-of-scope observations. Uniform returns are reviewable at a glance.
5. Match effort to the task. `low` or `medium` for mechanical work, `high` or `xhigh` for designs and hard bugs. Add `--fast` only when you are actively waiting on the result.
6. Let the dashboard carry the anxiety. Kick off jobs and keep working; the JOBS tab tells you truthfully when something needs a click. Claude Code restarts do not kill handoffs, because workers are detached and resumable.

## Standalone dashboard (no plugin)

The dashboard also runs on its own. It only reads `~/.codex/sessions/`:

```sh
node codex-live-viewer.js start    # background + open browser
node codex-live-viewer.js serve    # foreground
node codex-live-viewer.js stop
```

Or grab a tray app from [Releases](../../releases): `Codex-Live-Viewer-Windows-x64.zip` (double-click the exe) or `Codex-Live-Viewer-Linux-x64.zip` (needs GTK 3 and Ayatana AppIndicator). The tray supervises the server and shows completion toasts. There is no macOS tray build; use the Node CLI or the plugin's autostart.

Remote access: `--host 0.0.0.0` for your LAN, `--tunnel` for a free Cloudflare quick tunnel (token-gated, URL printed on start), `--tunnel-token <t>` for a named tunnel on your own domain. Local access never needs a token.

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `CODEX_PLUGIN_SANDBOX` | `danger-full-access` | Sandbox for plugin/dashboard-launched runs (see the warning at the top) |
| `CODEX_PLUGIN_FAST_TIER` | `priority` | Service tier used by `--fast` |
| `CODEX_PLUGIN_UPDATE_CHECK` | `1` | `0` disables the daily update check |
| `CODEX_VIEWER_AUTOSTART` | `1` | `0` disables the session-start dashboard autostart |
| `CODEX_VIEWER_PORT` | `8377` | Dashboard port (also receives job-completion pushes) |
| `CODEX_COMPANION_STATE_ROOT` | `~/.codex-companion/state` | Shared job state (CLI + dashboard) |
| `CODEX_HOME` | `~/.codex` | Where Codex session files are read from |
| `CODEX_VIEWER_TRAY_PORT` | port + 1 | Tray single-instance lock |
| `CODEX_VIEWER_NOTIFICATIONS` | `1` | `0` disables tray toasts |

## When something gets stuck

1. Check the JOBS tab. The badge tells you the truth (running, quiet but alive, or dead), with the death reason when one was captured.
2. Dead job: click Resume, optionally with more effort. The dashboard refuses if the process is actually still alive.
3. Truly wedged process: use the stop dialog (on Windows it shows the full command line and warns before touching shared `app-server`/MCP hosts), then Resume.
4. Sessions started outside the plugin get copy-paste `codex exec resume <id> "..."`, `codex resume`, and `codex fork` commands instead.

## Security notes

- Listens on `127.0.0.1` by default. State-changing endpoints are POST-only, origin-guarded, and confirmed in-app.
- Never edits Codex session files or `~/.codex`. It spawns Codex only through the bundled companion, and only when you act.
- Remember the trade-off at the top: the convenience came from dropping the sandbox. That is a real decision, not a default to forget about.

## Project layout

- `codex-live-viewer.js`: Node server, CLI, rollout parser, control endpoints (one file, no dependencies)
- `viewer-ui.html`: the whole frontend (one file)
- `plugin/`: the Claude Code plugin, forked from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (keeps its Apache-2.0 `LICENSE` and `NOTICE`)
- `plugin/viewer/`: bundled dashboard copies, refreshed by `npm run sync:viewer` and drift-guarded by tests
- `scripts/upstream-diff.mjs`: diff `plugin/` against upstream for selective, manual cherry-picks
- `tests/`: zero-dependency `node:test` suites
- `tray-launcher/`: Rust tray app for Windows and Linux
