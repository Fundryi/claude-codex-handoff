---
description: Open the Codex Live Viewer dashboard (starts it if needed)
allowed-tools: Bash(node:*)
---

The viewer was already started when this command was invoked. Its output:

!`node "${CLAUDE_PLUGIN_ROOT}/viewer/codex-live-viewer.js" start`

If the output above contains a dashboard URL, reply with just that URL — do not run any tools. Only if it shows an error: diagnose it (check that Node 22+ is on PATH, check the port from CODEX_VIEWER_PORT, default 8377) and tell the user what's wrong.
