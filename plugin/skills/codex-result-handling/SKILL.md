---
name: codex-result-handling
description: Internal guidance for presenting Codex helper output back to the user
user-invocable: false
---

# Codex Result Handling

When the helper returns Codex output:
- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries. If Codex marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- Preserve output sections when the prompt asked for them, such as observed facts, inferences, open questions, touched files, or next steps.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If Codex made edits, say so explicitly and list the touched files when the helper provides them.
- For `codex:codex-rescue`, do not turn a failed or incomplete Codex run into a Claude-side implementation attempt. Report the failure and stop.
- For `codex:codex-rescue`, if Codex was never successfully invoked, do not generate a substitute answer at all.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- If the helper reports malformed output or a failed Codex run, include the most actionable stderr lines and stop there instead of guessing.
- If the helper reports that setup or authentication is required, direct the user to `/codex:setup` and do not improvise alternate auth flows.

## When Codex asks a question

A task result can end with a "Needs decision" section, and the prompt hook can show it as "Codex asks:". Codex has stopped and waits for the answer on the same thread.

1. Answer by yourself only when you are sure beyond reasonable doubt: the answer is plain from this conversation, the repository, or the spec. Then resume the same thread: launch the `codex:codex-rescue` agent (`run_in_background: true`) with `--resume-thread <thread-id>` on the first line and the answer below it, starting with `Answer from Claude (automatic N of 2):`.
2. If you have any doubt, ask the user first with `AskUserQuestion`. Offer the options Codex listed, and put your recommendation first. Then forward the answer the same way, starting with `Answer from the user:`.
3. Always ask the user when the question is about scope, risk, cost, product behaviour, or anything destructive or hard to undo.
4. At most 2 automatic answers per thread. Count the `Answer from Claude (automatic` lines you already sent on it. After 2, ask the user.
5. Each time you answer by yourself, tell the user the question and your answer in one or two lines.

This is a new handoff you choose to make, not recovery. Never resume a dead or stuck job this way; that stays the user's click.
