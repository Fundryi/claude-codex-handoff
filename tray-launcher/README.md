# Native tray launcher

Small Rust shell for the Windows and Linux system tray. The Node application
continues to own rollout parsing, session state, HTTP/SSE, and the browser UI.

Run from the repository root:

```sh
npm run tray
```

Build a release binary with `npm run build:tray`. Release archives place the
renamed binary beside `codex-live-viewer.js`; Node must be available on `PATH`.

The launcher:

- keeps the existing Node viewer unchanged;
- starts `node codex-live-viewer.js serve` only when port 8377 is down;
- opens the dashboard from the tray menu;
- kills only the Node child it started when **Exit** is selected;
- verifies the viewer through `/health` before trusting port 8377;
- uses port 8378 as a lightweight single-instance lock;
- shows native notifications for fresh task completions;
- opens the browser on startup unless `CODEX_TRAY_NO_OPEN=1` is set.

Useful environment variables:

| Variable | Default | Purpose |
|---|---:|---|
| `CODEX_VIEWER_PORT` | `8377` | Existing viewer HTTP port |
| `CODEX_VIEWER_TRAY_PORT` | viewer port + 1 | Single-instance lock |
| `CODEX_VIEWER_JS` | auto-detected | Explicit path to `codex-live-viewer.js` |
| `CODEX_TRAY_NO_OPEN` | unset | Set to `1` to suppress opening the browser |
| `CODEX_VIEWER_NOTIFICATIONS` | `1` | Set to `0` to disable native notifications |

Linux development packages required by `tray-icon` on Debian/Ubuntu:

```sh
sudo apt install libgtk-3-dev libayatana-appindicator3-dev
```
