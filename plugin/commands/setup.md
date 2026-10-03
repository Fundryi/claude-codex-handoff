---
description: Check the local CLI and viewer integrations, and manage setup with user consent
argument-hint: '[--enable-review-gate|--disable-review-gate|--install-opencode-plugin|--remove-opencode-plugin]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If the result says Codex is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not authenticated, preserve the guidance to run `!codex login`.

After the report:

- If `integrations.opencodePlugin.opencodeFound` is true and `installed` is false, use `AskUserQuestion` once with these options:
  - `Install OpenCode viewer plugin (Recommended)`
  - `Skip`
- Ask only when the user has not already chosen install or remove in this request.
- If the user chooses install, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --install-opencode-plugin --json
```

- Present the new report and tell the user to restart OpenCode to load the plugin.
- For an explicit removal request, run `setup --remove-opencode-plugin --json`. Remove only the file with our plugin id marker.
- If `integrations.codexHooks.trusted` is false, show this exact step: `open codex, run /hooks, trust the codex@fundryi hooks`.
- Explain that this optional trust step enables only Codex approval notices. They occur only when the approval policy is not `never`.
- Codex turn toasts come from rollouts and need no setup, plugin or hook trust.
- The PermissionRequest hook ships in the plugin. To enable approval notices, install `codex@fundryi` in Codex first. Setup reports the shipped hook and saved trust.
- Report a legacy `notify.ps1` hook and leave it as it is.

Setup writes or removes only our OpenCode plugin file after consent. It never edits Codex config, Codex hook files or `opencode.json`. The review gate flags change companion state only. OpenCode 2 handoffs still require the user to install OpenCode and run it once.
