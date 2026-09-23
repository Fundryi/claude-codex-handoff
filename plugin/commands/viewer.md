---
description: Open the Codex Live Viewer dashboard (starts it if needed; restart, stop, kill or status)
argument-hint: "[restart|stop|kill|status]"
allowed-tools: Bash(node:*)
---

The viewer command already ran when this command was invoked. Its output:

!`node "${CLAUDE_PLUGIN_ROOT}/viewer/codex-live-viewer.js" start "$ARGUMENTS"`

With no argument, the viewer starts if needed and replaces a running viewer from an older plugin version. `restart` replaces any running viewer, `stop` stops it, `kill` force-quits it (also when it hangs and does not answer), and `status` shows whether it runs and its version.

If the output above contains a dashboard URL, reply with just that URL. If it says the viewer stopped or was killed, or shows the status, reply with that one line. Do not run any tools. Only if it shows an error: diagnose it (check that Node 22+ is on PATH, check the port from CODEX_VIEWER_PORT, default 8377) and tell the user what's wrong.
