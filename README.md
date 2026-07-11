# Codex Live Viewer

A read-only live dashboard for **all** [OpenAI Codex CLI](https://github.com/openai/codex) sessions on your machine — including headless handoffs spawned by other tools (e.g. the Claude Code codex plugin), which normally run invisibly with no window at all.

**The problem:** harness tools (T3 Code, CliDeck, Warp, …) only show sessions they launch themselves. There is no global Codex session registry (see openai/codex #30713, #22321), so background jobs started through the Codex app server are completely invisible.

**The trick:** Codex writes every event of every session — regardless of who launched it — live to `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. This viewer tails that folder and streams updates to your browser. A session appears within ~1 second of starting, no matter what spawned it.

![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen) ![node >= 18](https://img.shields.io/badge/node-%3E%3D18-blue)

## Features

- **Near-instant updates** — filesystem watch pushes events to the browser via SSE within ~50 ms of Codex writing them (1 s poll as fallback)
- **Live session list** with task titles (first user prompt) and status tabs: LIVE (pulsing, actively writing) / IDLE / STALE / DONE / ALL
- **Sectioned feed** — events grouped under USER / AGENT / WORKING / STATUS captions so you can scan what the AI is doing at a glance
- **Unread markers** — a dot appears when a session you're not watching changes status or gets new events; click the session to mark it read
- **Live event feed** — user prompts, shell commands, command output, file patches (expandable), reasoning summaries, agent messages, task completion
- **Auto-follow** — newest LIVE session is selected automatically until you click one yourself
- **Resume hint** — header shows the thread id and a ready-made `codex resume <id>` command
- **Stop stuck tasks** (Windows) — lists codex processes sorted by closeness to the session start time, and lets you kill one (with its child tree) after confirmation
- **Zero npm dependencies** — one file, plain Node

## Quick start

Requires [Node.js 18+](https://nodejs.org).

**Windows:** double-click `codex-viewer.bat` — it opens your browser and runs the server in that window. Close the window (or Ctrl+C) to stop. Prefer no window at all?

```bat
codex-viewer.bat tray
```

runs the server hidden with a system-tray icon (double-click = open viewer, right-click = Open / Exit).

**Any platform:**

```sh
node codex-live-viewer.js serve    # foreground (what npm start does)
node codex-live-viewer.js start    # detached background + open browser
node codex-live-viewer.js stop     # stop the background server
node codex-live-viewer.js status
```

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `CODEX_VIEWER_PORT` | `8377` | HTTP port |
| `CODEX_HOME` | `~/.codex` | Codex home (sessions are read from `$CODEX_HOME/sessions`) |

## Optional: completion toasts (Windows)

`install-codex-notify-hook.bat` installs a Codex `notify` hook that shows a Windows toast (via [BurntToast](https://github.com/Windos/BurntToast)) and appends a log line to `~/.codex/hooks/notify-log.jsonl` whenever any Codex turn completes. It:

- chains to whatever notifier was previously configured (e.g. Codex Desktop's Computer Use plumbing), so nothing breaks
- edits `config.toml` surgically: backup first, single-line change, verify, restore on failure
- is idempotent — re-run it any time, e.g. after a Codex Desktop update rewrites the notify line

The viewer does not depend on the hook; they are independent. The hook is the completion ping, the viewer is the live view.

## Security notes

- The server binds to `127.0.0.1` only — nothing is exposed to the network.
- The viewer itself is read-only; it never writes to session files or steers sessions.
- The kill feature runs `taskkill` on a PID you explicitly pick and confirm, and re-verifies the PID belongs to a codex-related process right before killing. Session-to-process matching is a start-time heuristic (rollout files contain no PID) — read the shown command line before killing, especially `codex app-server`, which hosts *all* plugin handoffs.

## Limitations

- The kill feature is Windows-only for now (returns 501 elsewhere). Everything else is cross-platform.
- Sessions are detected by file growth. A session whose file stops growing for 20 s shows as IDLE even if the process is still alive (e.g. long-running silent tool call).
- The rollout schema is not a public API. The parser is schema-tolerant and skips unknown shapes silently; if an event type renders as a gap, extend `simplify()` in `codex-live-viewer.js`.

## License

MIT
