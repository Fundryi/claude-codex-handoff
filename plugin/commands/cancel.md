---
description: Cancel a running Codex job in this folder, or one started from here with --cwd
argument-hint: '[job-id] [--cwd <folder>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" cancel "$ARGUMENTS"`
