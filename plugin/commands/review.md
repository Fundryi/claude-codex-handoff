---
description: Run a Codex code review against local git state
argument-hint: '[--background] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

Run a Codex review through the shared built-in reviewer.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.

Execution:
- Codex always runs detached, so no timeout can end a review. Do not estimate the review size, and do not ask the user how to run it.
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.
- If the output says the review is still running and gives a job id, relay that verbatim too. The review is detached and still going; it is not an error.

Argument handling:
- Preserve the user's arguments exactly.
- Do not add extra review instructions or rewrite the user's intent.
- `--background` returns a job id immediately instead of waiting for the review text.
- `--wait` is accepted for compatibility and does nothing.
- `/codex:review` is native-review only. It does not support staged-only review, unstaged-only review, or extra focus text.
- If the user needs custom review instructions or more adversarial framing, they should use `/codex:adversarial-review`.
