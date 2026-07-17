---
description: Open the Codex Live Viewer dashboard (starts it if needed)
---

Run this exact command with the Bash tool, then tell the user the dashboard URL it prints:

    node "${CLAUDE_PLUGIN_ROOT}/viewer/codex-live-viewer.js" start

`start` is idempotent: it reuses a running viewer or starts one in the background, then opens the browser. If the command fails, show the user the error and suggest checking that Node 18+ is on PATH.
