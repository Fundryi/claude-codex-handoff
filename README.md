<p align="center">
  <img src="assets/logo.svg" alt="Claude Codex Handoff logo" width="110">
</p>

<h1 align="center">Claude Codex Handoff</h1>

<p align="center">
  Delegate coding tasks from <a href="https://claude.com/claude-code">Claude Code</a> to the <a href="https://github.com/openai/codex">OpenAI Codex CLI</a> and get the results back.<br>
  Claude plans, Codex does the work. A fork of the official <code>codex</code> plugin where jobs survive restarts, plus a live dashboard to watch, resume, and cancel Codex runs.<br>
  Works in the terminal and in VS Code.
</p>

<p align="center">
  <a href="../../releases/latest"><img src="https://img.shields.io/github/v/release/Fundryi/claude-codex-handoff" alt="latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0_%2B_Commons_Clause-blue" alt="license: Apache 2.0 + Commons Clause"></a>
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

## Who this is for

- You work in Claude Code most of the time, in the terminal or the VS Code extension, and want Claude to delegate the heavy coding to Codex. Claude stays the orchestrator: it plans the work, writes the handoff, and checks what comes back.
- You want a second opinion. Codex reviews Claude's changes (`/codex:review`) or argues against a design (`/codex:adversarial-review`).
- You run long Codex jobs in the background and want to know when one is stuck, has failed, or waits for an answer.

## Why this exists

Handoffs to Codex run headless: no terminal, no window. When one silently died or hung, you found out an hour later, and there was no way to see why or continue it. This project makes the whole thing observable and recoverable.

## Compared with the official plugin

This is a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc). The command names are the same, so you type the same commands after you switch. What is different:

- **Jobs survive restarts.** Every Codex run is detached from Claude. Restarting Claude Code or closing the chat does not end it.
- **Results come back by themselves.** Your next message to Claude brings back the result of each finished job, from any session in the same folder.
- **A live dashboard** shows every Codex session on the machine, marks jobs that are stuck or dead, and lets you resume or cancel them.
- **Better defaults.** Effort defaults to `xhigh`, you can set effort and fast mode per job, and short model names such as `sol` and `astra` work.
- **Full access by default,** because the sandbox breaks on many Windows setups. See the warning above.

## Never lose a job again

The dashboard classifies every job from ground truth (real PID + heartbeat), not from guessing at quiet log files:

| Status | Means | You do |
|---|---|---|
| Running | Heartbeat fresh, or the process is alive on a long command | Nothing. Long tasks are never misflagged. |
| Needs attention | Process gone before finishing, its heartbeat stopped, or it failed with a known cause | Click **Resume**, optionally with more effort or another model, or read the fix hint (broken sandbox, expired `codex login`, rate limit). |
| Needs answer | The finished job asked a question | Answer it in the result card; "Answer and resume" continues the same thread after a confirm. |
| Stopped | Cancelled job or aborted turn | Nothing. Not an alarm. |
| Finished | Completion event received | Read the result card: Summary, Changed files, Checks run. |

Recovery is always flag-only: the dashboard marks, you click. It never resumes or kills anything on its own. Job workers are detached and nothing ends them when a session ends, so restarting Claude Code, or sending a new message under a host like CloudCLI that ends the session per turn, doesn't kill your handoffs. The next prompt brings back a short result for each finished job: its Summary, any question Codex asks, and the job id for the full text.

On CloudCLI, where Claude always runs in one folder, `/codex:handoff --cwd <folder>` targets another project and its result still comes back to Claude's folder. Two limits: a resume started from the viewer is not reported through Claude's prompt hook (only a session in the job's own folder sees it), and `/codex:status` with no job id shows only the current folder's jobs (pass the id to see a `--cwd` job).

## What you get

**In Claude Code:**

| Command | Does |
|---|---|
| `/codex:handoff` | Hand a task to Codex as a background job (`/codex:rescue` is the same command under its original name) |
| `/codex:review` / `/codex:adversarial-review` | Codex reviews your working tree, or challenges your design |
| `/codex:status` / `/codex:result` / `/codex:cancel` | Track, fetch, or stop jobs |
| `/codex:transfer` | Move the current Claude session into a Codex thread |
| `/codex:viewer [restart\|stop\|kill\|status]` | Open the dashboard (starts it, and replaces one left running by an older version); `restart`, `stop`, force-quit (`kill`) or `status` it |
| `/codex:setup` | Check Codex CLI readiness |

**Effort and fast mode** are set per job (the Resume form in the dashboard, `--effort`/`--fast` on the CLI, or just say "high effort" / "use fast mode" in a handoff request):

| Effort | Use for |
|---|---|
| `low` | Trivial one-liners, mechanical renames, boilerplate |
| `medium` | Quick tweaks; simple browser-testing checklists |
| `high` | Browser testing and live verification runs, larger mechanical work |
| `xhigh` | The everyday default: bugfixes, features, reviews, designs, root-cause hunts |
| `max` | The hardest problems (GPT-6.1, GPT-6, GPT-5.6, and Daybreak models) |
| `ultra` | Max reasoning plus automatic task delegation (`gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-daybreak-blue-latest`; the Luna models stop at `max`) |

When in doubt, go one tier up. A smarter run costs a little more time and quota; a dumber run costs a redo. If you set no effort, the plugin applies `xhigh` instead of Codex's own low default. `/codex:review` is the exception: it takes no `--effort` (Codex's review request has no effort field) and runs at the effort in your Codex config; `/codex:adversarial-review` takes `--effort`. `max` and `ultra` are never applied on their own; ask for them.

**Model shortcuts:** `--model astra`, `sol`, `terra`, `luna`, and `daybreak-blue` expand to `gpt-6-astra`, `gpt-6.1-sol`, `gpt-5.6-terra`, `gpt-6-luna`, and `gpt-daybreak-blue-latest`. There is no GPT-6 Terra, so `terra` stays on GPT-5.6. Pass a full name such as `gpt-6-sol` or `gpt-5.6-sol` to pick an older model. Leave the model unset to get the default from your Codex config; without a model in the config, Codex uses its catalog default, `gpt-6.1-sol` (since Codex 0.159.1). `astra` is GPT-6 Astra, the most capable model. A `--model` that Codex has scheduled for retirement still runs. Handoffs and `/codex:adversarial-review` then put a warning with the retirement date and the model Codex suggests on the first line of the result and in the job log. `/codex:review` gives no warning. The effort table above says which models take `max` and `ultra`.

`daybreak-blue` is Daybreak Blue, the security-specialty model: sol-class reasoning with fewer restrictions on defensive security analysis. Use it for security reviews, audits, vulnerability hunting, and reversing work. Daybreak access is verification-gated per account, so the plugin checks availability before starting a Daybreak run; without access the run fails immediately with a clear message instead of an opaque API error.

`--fast` is orthogonal: it buys the `priority` service tier (faster turnaround, more quota; the Codex catalog lists about 2x speed on `gpt-6.1-sol` and `gpt-6-astra`, 1.5x on most other models) at whatever effort you chose, and never changes the effort tier. Use it when you are actively waiting on the result; it is always opt-in, never the default.

**In the browser** (`localhost:8377`):

- every Codex session on the machine, streaming live, however it was started, in one list with tabs (Now, Handoffs, History) and filter chips instead of separate session/job views
- a feed that shows who says what: your messages, Claude's handoff prompts and automatic answers, the plugin's return format, Codex's replies and questions, and Codex's work (thinking, commands, patches) in its own collapsed log, each actor in one color with a legend
- a result card on every finished handoff (Summary, Changed files, Checks run, Needs decision) with an answer box that resumes the thread when Codex asked a question; "Show full result" opens the full result dialog and lists every run on the thread, newest first
- a Claude tab for Claude Code workflows (runs of the Workflow tool): each run with its phases and agents, live, and the transcript of each agent. Claude work has its own label, icon and color, so it never looks like a Codex handoff. A "Claude: N running" counter in the header shows on every tab. The tab only reads the run files under `~/.claude/projects` and has no stop or resume buttons
- one-click resume and cancel, with in-app confirmation
- one job store shared with the CLI, so `/codex:status` and the dashboard always agree
- search across all recorded sessions, effort/sandbox/token display, archived sessions, unread markers, saved layout

## Using it well

Patterns from daily use that make handoffs reliable:

1. **Write a contract, not an essay.** Keep short per-task-type instruction files in your repo and open every prompt with the line `Follow handoff/coding.md (binding).` on its own, then the task as `<goal>`, `<rules>`, `<done_when>` and `<files>`. A ready-to-copy set ships in [`handoff/`](handoff/): copy the folder, fill in the `ADAPT:` markers, done. The plugin spots contract files and names the right one automatically.
2. **Scope limits writes, not reads.** Codex may read anything to trace the real flow; name the files it may change.
3. **Demand a self-check gate.** End your contract with checks Codex runs before returning. Every bug a review catches becomes a permanent check, so quality compounds.
4. **Fix a return format.** Uniform returns (findings, diff, manifest, gate results) are reviewable at a glance. The plugin ends every task with Summary, Changed files, Checks run and Needs decision; your contract's sections come before those.
5. **Match effort to the task, and round up.** `xhigh` for everything that involves judgment; `medium`/`high` fit verification runs like browser testing, where the checklist does the thinking. `--fast` only when you're actively waiting.
6. **Let the dashboard carry the anxiety.** Kick off jobs, keep working, act when a badge asks you to.

<details>
<summary><b>Standalone dashboard</b> (no plugin needed)</summary>

The dashboard runs on its own and only reads `~/.codex/sessions/`:

```sh
node codex-live-viewer.js start    # background + open browser (add --no-open to skip the tab)
node codex-live-viewer.js serve    # foreground
node codex-live-viewer.js stop
node codex-live-viewer.js restart  # stop whatever viewer runs, start this one
node codex-live-viewer.js status   # running or not, and its version
node codex-live-viewer.js kill     # force-quit, also a hung viewer
```

`start` replaces a viewer left running by an older version, so after an update it brings up the new one.

**Port and address.** The viewer listens on `127.0.0.1:8377`. The port is fixed on purpose: the plugin finds the viewer by it to report finished jobs. If another program already uses 8377, the viewer does not start and says so; set `CODEX_VIEWER_PORT` to a free port where Claude and Codex run. Under WSL, `localhost:8377` on Windows reaches a viewer running inside WSL, and it shows the Codex runs from the WSL side. In a Docker container, set `CODEX_VIEWER_HOST=0.0.0.0` and publish the port to the host only, for example `-p 127.0.0.1:8377:8377`.

Or grab a tray app from [Releases](../../releases): `Codex-Live-Viewer-Windows-x64.zip` (double-click the exe) or `Codex-Live-Viewer-Linux-x64.zip` (needs GTK 3 + Ayatana AppIndicator). The tray supervises the server and shows completion toasts. No macOS tray; use the Node CLI or the plugin's autostart.

Remote access: `--host 0.0.0.0` (or `CODEX_VIEWER_HOST=0.0.0.0`, which the plugin's autostart also uses) for your LAN, with no token, so anyone on that network can use it; `--tunnel` for a free Cloudflare quick tunnel (token-gated, URL printed on start), `--tunnel-token <t>` for a named tunnel on your own domain. Local access never needs a token.

Behind a reverse proxy (Nginx Proxy Manager, Caddy, Traefik): set `CODEX_VIEWER_ALLOWED_HOSTS` to the name you open in the browser, for example `viewer.example.com`. Put it in the `env` block of `~/.claude/settings.json` on the machine that runs the viewer, so the autostart uses it too. That one setting also makes the viewer listen on all addresses, because the proxy usually runs on another machine. If the proxy runs on the same machine, also set `CODEX_VIEWER_HOST=127.0.0.1`. Without the name, the page loads but every control is refused, and the header says "Controls blocked at this address". The proxy needs no special settings: the viewer sends a keep-alive line every 25 seconds, so live updates do not time out. Like LAN access, there is no token, so protect the proxy name if others can reach it.

Claude workflow transcripts can hold text from every project on the machine. The viewer sends them only to a browser on the same machine that uses the `localhost` or `127.0.0.1` link, or to the tunnel link. The LAN link refuses them, also when you open it on the same machine. When `CODEX_VIEWER_ALLOWED_HOSTS` is set, only the tunnel link shows them, because the viewer cannot tell a browser behind the proxy from a local one. The run list, with phases and agent states, shows on every link. Limit: a proxy on the same machine that you did not put in `CODEX_VIEWER_ALLOWED_HOSTS`, with default settings (for example nginx `proxy_pass` without forwarding headers), still looks local. Always declare your proxy.

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
| `CODEX_VIEWER_HOST` | `127.0.0.1` | Bind address; `0.0.0.0` opens it to your LAN |
| `CODEX_VIEWER_ALLOWED_HOSTS` | (none) | Comma list of names a reverse proxy serves the dashboard under; when set, the default bind becomes `0.0.0.0` |
| `CODEX_COMPANION_STATE_ROOT` | `~/.codex-companion/state` | Shared job state (CLI + dashboard) |
| `CODEX_HOME` | `~/.codex` | Where Codex session files are read from |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude workflow runs are read from (its `projects` folder) |
| `CODEX_VIEWER_TRAY_PORT` | port + 1 | Tray single-instance lock |
| `CODEX_VIEWER_NOTIFICATIONS` | `1` | `0` disables tray toasts |

</details>

<details>
<summary><b>Project layout</b></summary>

- `codex-live-viewer.js`: Node server, CLI, rollout parser, control endpoints (one file, no dependencies)
- `viewer-ui.html`: the whole frontend (one file)
- `plugin/`: the Claude Code plugin, forked from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (keeps OpenAI's Apache-2.0 `LICENSE` and `NOTICE`; the changes fall under the root [LICENSE](LICENSE))
- `plugin/.codex-plugin/plugin.json`: the manifest Codex reads when the plugin is installed there. Its empty `hooks` object keeps the Claude hooks out of Codex sessions; Codex loads only the skills. Keep its version equal to `plugin/.claude-plugin/plugin.json`
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

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. For questions, use [Discussions](../../discussions).

## License

[Apache 2.0 with the Commons Clause](LICENSE). You may use, change, fork and share this project, also at work, and publish your own better version. You may not sell it, or sell a service that is built mainly on it.

The plugin started as [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc). Code that comes unchanged from there stays under OpenAI's plain Apache 2.0 license. The plugin in releases up to v2.17.0 was published under plain Apache 2.0, and those copies keep that license.
