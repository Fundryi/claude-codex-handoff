<p align="center">
  <img src="assets/logo.svg" alt="Codex Live Viewer logo" width="120">
</p>

# Codex Live Viewer

A read-only dashboard for every [OpenAI Codex CLI](https://github.com/openai/codex) session running on your machine, including headless tasks started by an orchestrator.

## Why this exists

We use Fable to plan and coordinate work. Its plugin/skill hands implementation tasks to Codex, and Codex does the coding in a headless app-server session.

Those handoffs do not open a terminal or window. We built this viewer because we wanted to know whether Codex was still working, had finished, or had become stuck.

Codex already writes its session events to `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. The viewer follows those files and sends new activity to the browser. A new task usually appears within a second, however it was started.

![zero npm dependencies](https://img.shields.io/badge/npm_dependencies-0-brightgreen) ![node >= 18](https://img.shields.io/badge/node-%3E%3D18-blue)

## Features

- Filesystem watching sends new events to the browser through SSE. A one-second poll is there as a fallback.
- The session list shows the first user prompt as its title and sorts sessions into LIVE, IDLE, STALE, DONE, and ALL.
- The feed separates user messages, agent messages, working output, and status changes.
- Sessions you are not watching get an unread dot when something changes.
- The feed includes prompts, shell commands, command output, patches, reasoning summaries, agent messages, and completion events.
- The newest live session opens automatically until you choose a session yourself.
- The task menu copies ready-to-paste `codex resume`, `codex exec resume` (headless continue), and `codex fork` commands for the selected session.
- Sessions archived with `codex archive` appear under an Archived filter with a copy-paste `codex unarchive <id>` command to restore them.
- Waiting and possibly-stuck sessions explain what they were last doing (running a command, thinking, waiting for a reply) and for how long.
- The responsive dashboard includes search, human-readable status filters, Activity and Raw log views, a collapsible and resizable session list, and a safer task-actions menu.
- Search covers ALL recorded sessions, not just the visible list: a metadata index (title, project, thread id) of every rollout file powers a History section, and clicking a result loads that session on demand.
- Layout and display preferences are saved in the browser, including sidebar width, selected filter, feed view, auto-follow, and auto-scroll.
- On Windows, you can inspect matching Codex processes and stop a stuck task through a detail dialog that shows the full command line and warns before touching shared `app-server`/MCP processes.
- A small Rust tray app starts the Node viewer in the background on Windows and Linux.
- The tray shows a native notification when a Codex task finishes.
- The Node viewer itself has no npm dependencies.

## Quick start

Requires [Node.js 18+](https://nodejs.org).

### Windows

Download and extract `Codex-Live-Viewer-Windows-x64.zip`, then double-click `Codex Live Viewer.exe`. The app starts in the system tray without opening a terminal. Double-click the tray icon to open the viewer, or right-click it for status, `Open viewer`, `Restart viewer`, and `Exit`.

The tray checks its Node child once per second. If the background server exits, the icon turns red, the menu shows `Status: Stopped`, and a native notification points to `Restart viewer`. A successful restart restores the blue icon and dashboard without restarting the tray app.

### Linux desktop

Download and extract `Codex-Live-Viewer-Linux-x64.zip`, then run:

```sh
./codex-live-viewer-tray
```

The Linux tray requires GTK 3 and Ayatana AppIndicator (for example `libgtk-3-0` and `libayatana-appindicator3-1` on Ubuntu/Debian).

### Node CLI

```sh
node codex-live-viewer.js serve    # foreground (what npm start does)
node codex-live-viewer.js start    # detached background + open browser
node codex-live-viewer.js stop     # stop the background server
node codex-live-viewer.js status
```

## Remote access

By default the viewer only listens on `127.0.0.1`. Three ways to open it up:

### Home LAN

    node codex-live-viewer.js serve --host 0.0.0.0

Open `http://<server-ip>:8377` from any machine on your network. No auth — your LAN is trusted.

### Internet, zero setup (Cloudflare quick tunnel)

Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then:

    node codex-live-viewer.js serve --tunnel

The viewer prints a ready-to-click `https://<random>.trycloudflare.com/?token=...` URL. Free, no Cloudflare account, new URL each start. Tunnel visitors need the token (auto-generated once, stored in `~/.codex/live-viewer-token`); local/LAN access stays tokenless.

### Internet, custom domain (named tunnel)

Create a named tunnel in the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/) pointing at `http://localhost:8377`, copy its token, then:

    node codex-live-viewer.js serve --tunnel-token <TUNNEL_TOKEN>

Stable URL on your own domain. Access token works the same as above.

Pin a fixed access token with `--token <secret>` or `CODEX_VIEWER_TOKEN` instead of the auto-generated one.

### Build from source

Requires stable Rust and Node.js 18+:

```sh
npm run tray          # development build
npm run build:tray    # optimized launcher
```

The tray launcher must remain beside `codex-live-viewer.js` in a release folder. The Node CLI can also run independently without Rust.

## Releases

Pushing a version tag such as `v1.0.0` builds the Windows and Linux launchers and creates a GitHub Release with ready-to-use ZIP files.

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `CODEX_VIEWER_PORT` | `8377` | HTTP port |
| `CODEX_HOME` | `~/.codex` | Codex home (sessions are read from `$CODEX_HOME/sessions`) |
| `CODEX_VIEWER_TRAY_PORT` | viewer port + 1 | Tray single-instance lock port |
| `CODEX_VIEWER_NOTIFICATIONS` | `1` | Set to `0` to disable tray notifications |

## Optional: completion toasts (Windows)

The tray already shows completion notifications while it is running. The viewer and tray work without changing your Codex configuration.

Run `install-codex-notify-hook.bat` if you also want notifications when the viewer is closed. The hook uses [BurntToast](https://github.com/Windos/BurntToast) when it is available and writes each completion to `~/.codex/hooks/notify-log.jsonl`.

The installer keeps the notifier that was already configured and calls it after writing its own notification. It backs up `config.toml`, changes only the `notify` line, verifies the result, and restores the backup if verification fails. You can run it again after a Codex Desktop update changes the notifier path.

When the tray is connected, the hook keeps logging and calling the original notifier but suppresses its own toast. This prevents duplicate notifications. The viewer does not need the hook for normal operation.

## Recovering a stuck session

1. Check the status: a **Waiting** or **Possibly stuck** task shows what it was last doing (for example `running command "npm test"`) and for how long.
2. If the process is truly stuck, open the task menu, choose `Stop task process…`, pick the matching PID, and review the confirmation dialog. It warns you when the process is a shared `app-server`/MCP host, because stopping one of those stops every task it hosts.
3. Continue the work: `Copy continue command` gives you `codex exec resume <id> "…"`, which resumes the same thread headlessly and finishes the task. `Copy resume command` opens the thread interactively instead, and `Copy fork command` experiments on a copy while leaving the original session untouched. (Verified against codex-cli 0.144.1.)
4. Don't want to continue it at all? `Dismiss task` hides the dead session from every filter except All (viewer-only, stored in your browser, undoable via `Restore task`). For permanent cleanup, `Copy archive command` gives you `codex archive <id>` — Codex moves the session file out of the sessions folder and the viewer drops it automatically. Archived sessions stay visible under the **Archived** filter, where `Copy unarchive command` gives you `codex unarchive <id>` to restore one.

The viewer itself stays read-only: it never launches Codex or writes to session files. You paste the commands into your own terminal.

## Security notes

- The server listens on `127.0.0.1`, so it is not exposed to the network.
- The viewer never writes to Codex session files or sends instructions back to a session.
- Control requests reject untrusted browser origins.
- The Windows stop feature runs `taskkill` only after you choose a PID and confirm it in a dialog that shows the full command line and start-time match. It checks the process again immediately before killing it. Rollout files do not contain a PID, so the suggested match is based on start time, and the dialog warns explicitly before stopping `codex app-server`/MCP processes that may host several handoffs.

## Limitations

- The tray launcher supports Windows and Linux. The Node server and CLI also run on macOS, but there is no macOS tray build yet.
- `Exit` stops Node only when that tray instance started it. If Node was already running, the tray leaves it alone.
- Sessions are detected by file growth. A session whose file stops growing for 20 s shows as IDLE even if the process is still alive (e.g. long-running silent tool call).
- Search matches session metadata (title, project, thread id) — not the full conversation text.
- The rollout schema is not a public API. The parser is schema-tolerant and skips unknown shapes silently; if an event type renders as a gap, extend `simplify()` in `codex-live-viewer.js`.

## Project layout

- `codex-live-viewer.js`: Node server, CLI, rollout parser, and embedded fallback UI
- `viewer-ui.html`: zero-dependency responsive browser interface
- `docs/UI-THEME.md`: visual system and interaction rules
- `tests/`: Node regression tests for browser navigation state
- `tray-launcher/`: Windows and Linux tray app
- `install-codex-notify-hook.bat`: optional Windows completion notifications
- `.github/workflows/release.yml`: builds release ZIPs when a `v*` tag is pushed

## License

MIT
