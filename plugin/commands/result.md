---
description: Show the stored final output for a finished Codex job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/codex:status <id>` and `/codex:review`

If the job is still running, do not poll or re-arm foreground waits. This
slash command itself runs `result` in the foreground at prompt-expansion time,
so `--wait` is not for it. Instead, invoke the Bash tool directly with:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result <job-id> --wait

and `run_in_background: true`, then continue with other work. The process
exits the moment the job finishes — fast or slow — and the harness delivers
the full report automatically. `--timeout-ms <ms>` adds an optional ceiling;
without it the wait has no deadline (a dead worker is reconciled to `failed`,
which also ends the wait).
