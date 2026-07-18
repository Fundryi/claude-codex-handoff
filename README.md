<p align="center">
  <img src="assets/logo.svg" alt="Claude Codex Handoff logo" width="110">
</p>

<h1 align="center">Claude Codex Handoff</h1>

<p align="center">
  Hand coding tasks from <a href="https://claude.com/claude-code">Claude Code</a> to the <a href="https://github.com/openai/codex">OpenAI Codex CLI</a> without losing them.<br>
  A reliability-first fork of the official <code>codex</code> plugin, plus a live dashboard to start, watch, resume, and cancel runs.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/npm_dependencies-0-brightgreen" alt="zero npm dependencies">
  <img src="https://img.shields.io/badge/node-%3E%3D22-blue" alt="node >= 22">
  <img src="https://img.shields.io/badge/platforms-win%20%7C%20linux%20%7C%20mac-8A2BE2" alt="platforms">
</p>

---

> [!WARNING]
> **Codex runs with full access by default.** Runs launched by this plugin use `danger-full-access`: Codex can read and write anywhere and run any command, as your user. This is deliberate. The sandboxed modes are broken on common Windows setups (Store PowerShell stub, error `1312`) and were a constant source of dead handoffs. Sandbox works on your machine? Set `CODEX_PLUGIN_SANDBOX=workspace-write` to get it back. Either way: only use this on machines you trust with the code you run.

## Install

```
/plugin marketplace add Fundryi/claude-codex-handoff
/plugin install codex@fundryi
```

Needs [Node.js](https://nodejs.org) 22+ and the Codex CLI (`npm install -g @openai/codex`, then `codex login`). Had the OpenAI-marketplace `codex` plugin? Uninstall it first; every `/codex:*` command name stays the same.

From your next Claude Code session on:

- the **dashboard starts itself** in the background (open it with `/codex:viewer`)
- the plugin **checks for updates** once a day and prints the update command when there is one

## Why this exists

Handoffs to Codex run headless: no terminal, no window. When one silently died or hung, you found out an hour later, and there was no way to see why or continue it. This project makes the whole thing observable and recoverable.

## Never lose a job again

The dashboard's JOBS tab classifies every job from ground truth (real PID + heartbeat), not from guessing at quiet log files:

| Badge | Means | You do |
|---|---|---|
| `RUNNING` | Heartbeat fresh, or the process is alive on a long command | Nothing. Long tasks are never misflagged. |
| `QUIET` | Process alive but silent for 5+ minutes | Peek at it. Maybe it's thinking, maybe it's wedged. |
| `DEAD` | Process gone before finishing | Click **Resume**, optionally with more effort or another model. |
| `FAILED` | Died with a known cause | Read the reason (broken sandbox, expired `codex login`, rate limit) and its fix hint. |

Recovery is always flag-only: the dashboard marks, you click. It never resumes or kills anything on its own. And because job workers are detached, restarting Claude Code doesn't kill your handoffs.

## What you get

**In Claude Code:**

| Command | Does |
|---|---|
| `/codex:rescue` | Hand a task to Codex as a background job |
| `/codex:review` / `/codex:adversarial-review` | Codex reviews your working tree, or challenges your design |
| `/codex:status` / `/codex:result` / `/codex:cancel` | Track, fetch, or stop jobs |
| `/codex:transfer` | Move the current Claude session into a Codex thread |
| `/codex:viewer` | Open the dashboard |
| `/codex:setup` | Check Codex CLI readiness |

**Effort and fast mode** are set per job (form fields in the dashboard, `--effort`/`--fast` on the CLI, or just say "high effort" / "use fast mode" in a rescue request):

| Effort | Use for |
|---|---|
| `none` / `minimal` | Trivial one-liners, mechanical renames |
| `low` | Small well-specified fixes, boilerplate |
| `medium` | Quick tweaks; simple browser-testing checklists |
| `high` | Browser testing and live verification runs, larger mechanical work |
| `xhigh` | The everyday default: bugfixes, features, reviews, designs, root-cause hunts |

When in doubt, go one tier up. A smarter run costs a little more time and quota; a dumber run costs a redo.

`--fast` is orthogonal: it buys priority processing (faster turnaround, more quota) at whatever effort you chose, and never changes the effort tier. Use it when you are actively waiting on the result; it is always opt-in, never the default.

**In the browser** (`localhost:8377`):

- every Codex session on the machine, streaming live, however it was started
- start new tasks and reviews: project, prompt, effort (`none` to `xhigh`), model, write access, sandbox, fast mode
- one-click resume and cancel, with in-app confirmation
- one job store shared with the CLI, so `/codex:status` and the JOBS tab always agree
- search across all recorded sessions, effort/sandbox/token display, archived sessions, unread markers, saved layout

## Using it well

Patterns from daily use that make handoffs reliable:

1. **Write a contract, not an essay.** Keep short per-task-type instruction files in your repo and open every prompt with `Follow handoff/coding.md (binding). Task: ...`. A ready-to-copy set ships in [`handoff/`](handoff/): copy the folder, fill in the `ADAPT:` markers, done. The plugin spots contract files and names the right one automatically.
2. **Scope limits writes, not reads.** Codex may read anything to trace the real flow; name the files it may change.
3. **Demand a self-check gate.** End your contract with checks Codex runs before returning. Every bug a review catches becomes a permanent check, so quality compounds.
4. **Fix a return format.** Uniform returns (findings, diff, manifest, gate results) are reviewable at a glance.
5. **Match effort to the task, and round up.** `xhigh` for everything that involves judgment; `medium`/`high` fit verification runs like browser testing, where the checklist does the thinking. `--fast` only when you're actively waiting.
6. **Let the dashboard carry the anxiety.** Kick off jobs, keep working, act when a badge asks you to.

<details>
<summary><b>Standalone dashboard</b> (no plugin needed)</summary>

The dashboard runs on its own and only reads `~/.codex/sessions/`:

```sh
node codex-live-viewer.js start    # background + open browser
node codex-live-viewer.js serve    # foreground
node codex-live-viewer.js stop
```

Or grab a tray app from [Releases](../../releases): `Codex-Live-Viewer-Windows-x64.zip` (double-click the exe) or `Codex-Live-Viewer-Linux-x64.zip` (needs GTK 3 + Ayatana AppIndicator). The tray supervises the server and shows completion toasts. No macOS tray; use the Node CLI or the plugin's autostart.

Remote access: `--host 0.0.0.0` for your LAN, `--tunnel` for a free Cloudflare quick tunnel (token-gated, URL printed on start), `--tunnel-token <t>` for a named tunnel on your own domain. Local access never needs a token.

</details>

<details>
<summary><b>Configuration</b> (environment variables)</summary>

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_PLUGIN_SANDBOX` | `danger-full-access` | Sandbox for plugin/dashboard-launched runs (see warning above) |
| `CODEX_PLUGIN_FAST_TIER` | `priority` | Service tier used by `--fast` |
| `CODEX_PLUGIN_UPDATE_CHECK` | `1` | `0` disables the daily update check |
| `CODEX_VIEWER_AUTOSTART` | `1` | `0` disables the session-start dashboard autostart |
| `CODEX_VIEWER_PORT` | `8377` | Dashboard port (also receives job-completion pushes) |
| `CODEX_COMPANION_STATE_ROOT` | `~/.codex-companion/state` | Shared job state (CLI + dashboard) |
| `CODEX_HOME` | `~/.codex` | Where Codex session files are read from |
| `CODEX_VIEWER_TRAY_PORT` | port + 1 | Tray single-instance lock |
| `CODEX_VIEWER_NOTIFICATIONS` | `1` | `0` disables tray toasts |

</details>

<details>
<summary><b>Project layout</b></summary>

- `codex-live-viewer.js`: Node server, CLI, rollout parser, control endpoints (one file, no dependencies)
- `viewer-ui.html`: the whole frontend (one file)
- `plugin/`: the Claude Code plugin, forked from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (keeps its Apache-2.0 `LICENSE` and `NOTICE`)
- `plugin/viewer/`: bundled dashboard copies, refreshed by `npm run sync:viewer`, drift-guarded by tests
- `handoff/`: ready-to-copy handoff contract templates
- `scripts/upstream-diff.mjs`: diff `plugin/` against upstream for selective, manual cherry-picks
- `tests/`: zero-dependency `node:test` suites
- `tray-launcher/`: Rust tray app for Windows and Linux

</details>

## Security notes

- Listens on `127.0.0.1` by default. State-changing endpoints are POST-only, origin-guarded, and confirmed in-app.
- Never edits Codex session files or `~/.codex`. It spawns Codex only through the bundled companion, and only when you act.
- The convenience came from dropping the sandbox. That is a real decision, not a default to forget about.
