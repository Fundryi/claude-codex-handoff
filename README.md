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
- Each session shows its thread ID and the matching `codex resume <id>` command.
- On Windows, you can inspect matching Codex processes and stop a stuck task after confirming the PID.
- A small Rust tray app starts the Node viewer in the background on Windows and Linux.
- The Node viewer itself has no npm dependencies.

## Quick start

Requires [Node.js 18+](https://nodejs.org).

### Windows

Download and extract `Codex-Live-Viewer-Windows-x64.zip`, then double-click `Codex Live Viewer.exe`. The app starts in the system tray without opening a terminal. Double-click the tray icon to open the viewer, or right-click it for `Open viewer` and `Exit`.

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

## Optional: completion toasts (Windows)

Run `install-codex-notify-hook.bat` if you also want a Windows toast when a Codex turn finishes. The hook uses [BurntToast](https://github.com/Windos/BurntToast) when it is available and writes each notification to `~/.codex/hooks/notify-log.jsonl`.

The installer keeps the notifier that was already configured and calls it after writing its own notification. It backs up `config.toml`, changes only the `notify` line, verifies the result, and restores the backup if verification fails. You can run it again after a Codex Desktop update changes the notifier path.

The viewer does not need this hook. It only adds completion notifications.

## Security notes

- The server listens on `127.0.0.1`, so it is not exposed to the network.
- The viewer never writes to Codex session files or sends instructions back to a session.
- Control requests reject untrusted browser origins.
- The Windows stop feature runs `taskkill` only after you choose and confirm a PID. It checks the process again immediately before killing it. Rollout files do not contain a PID, so the suggested match is based on start time. Check the command line before stopping `codex app-server`, since that process may host several handoffs.

## Limitations

- The tray launcher supports Windows and Linux. The Node server and CLI also run on macOS, but there is no macOS tray build yet.
- `Exit` stops Node only when that tray instance started it. If Node was already running, the tray leaves it alone.
- Sessions are detected by file growth. A session whose file stops growing for 20 s shows as IDLE even if the process is still alive (e.g. long-running silent tool call).
- The rollout schema is not a public API. The parser is schema-tolerant and skips unknown shapes silently; if an event type renders as a gap, extend `simplify()` in `codex-live-viewer.js`.

## Project layout

- `codex-live-viewer.js`: Node server, CLI, rollout parser, and browser UI
- `tray-launcher/`: Windows and Linux tray app
- `install-codex-notify-hook.bat`: optional Windows completion notifications
- `.github/workflows/release.yml`: builds release ZIPs when a `v*` tag is pushed

## License

MIT
