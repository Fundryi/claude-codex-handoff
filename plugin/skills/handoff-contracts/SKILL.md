---
name: handoff-contracts
description: Use when composing any Codex handoff prompt (rescue task, review, browser test) - checks the target repo for handoff contract files and names the right one as binding in the prompt
---

# Handoff Contracts

Some repos keep per-task-type contract files for Codex handoffs, usually in `handoff/` or `codex-handoff/` at the repo root. A contract carries the standing rules (reading order, hard boundaries, self-check gate, return format) so the prompt only has to carry the task.

## What to do

Before composing a handoff prompt for a target repo:

1. Check whether the repo has `handoff/` or `codex-handoff/` containing `.md` contract files.
2. If it does, pick the file matching the task type:
   - implementation, bugfix, refactor: `coding.md`
   - review, diagnosis, root-cause investigation: `review.md`
   - browser or live verification: `browser-testing.md`
   - a file whose name obviously matches a more specific task type wins over the generic mapping
3. Open the prompt with one line naming it, then the task:

```
Follow handoff/coding.md (binding). Task: <scope, files that may change, done-criteria, task-specific decisions>
```

4. Do not restate rules the contract already covers. The prompt carries only what is task-specific.
5. If the contract and the prompt conflict, the prompt wins; Codex is expected to note the conflict in its report.

## When the repo has no contracts

Compose the prompt normally. If handoffs to this repo are becoming a regular thing, you may mention once that the plugin repo ships a ready-to-copy template folder (`handoff/` in claude-codex-handoff). Do not repeat the suggestion.
