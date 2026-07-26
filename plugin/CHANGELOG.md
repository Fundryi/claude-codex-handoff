# Changelog

## 2.7.0

Long Codex handoffs stop dying at the ten-minute mark.

- **Codex runs never die when Claude stops watching.** Every `task`, `review`, and `adversarial-review` now runs in the detached worker that previously only backed `--background` — spawned through a trampoline so not even a Windows tree kill (`taskkill /T`, the harness timeout mechanism) can walk the process chain to reach it. Previously a long rescue or review was killed at the harness's wall clock, losing every token spent and leaving the job unusable.
- **The CLI follows the detached run instead of hosting it.** Output is unchanged for jobs that finish quickly. A job that outlives the follow budget prints its job id and keeps running — pick it up with `/codex:result <job-id>`, or let the new re-attach hook surface it on your next message.
- **Jobs whose worker vanished no longer jam `/codex:result` forever.** A `running` record with a dead process is reconciled to `failed` with `diedReason: process-vanished` the next time jobs are read, so the partial output is retrievable and `/codex:cancel` stops seeing a phantom active job. Previously that record stayed `running` permanently and every result fetch refused with "still running".
- **`/codex:review` and `/codex:adversarial-review` no longer ask how to run.** The foreground/background question and the diff-size estimate behind it are gone; there is nothing left to choose. `--background` still returns a job id immediately, and `--wait` is accepted but does nothing.
- Errors that used to print inline now surface as failed jobs. Because every run is detached, a review that fails preflight (for example, outside a git repository) records a failed job with the real error instead of erroring inline — `/codex:result` returns it, and the viewer shows it.
- Removed the guidance that had Claude guess whether a task "looks complicated" to decide execution mode — a prediction that was guarding a hard cliff that no longer exists.

## 2.6.2

- **`/codex:viewer` starts the viewer instantly, without spending tokens.** The command now launches the viewer via slash-command bash preprocessing (`` !`...` `` in the command file), so the dashboard is already up before the model responds. The AI only relays the URL — and only investigates if the start output shows an error.

## 2.6.1

- **Viewer: Resume from the job result modal.** Opening a dead/failed job used to show only the result (often "No rendered result is available.") with a lone Close button; resuming required going back to the card. The modal now offers a Resume button that opens the usual resume dialog with thread and workspace prefilled.

## 2.6.0

Smarter status: the viewer now tells "thinking hard" apart from actually stuck.

- **Viewer: sessions with a live companion job stay "Running" while quiet.** Session status used to track only rollout file growth, so long thinking stretches (which write nothing to the rollout) flipped to "Waiting" after 20 seconds. Now the thread's job liveness — process alive plus a fresh companion heartbeat — keeps the session shown as Running.
- **Viewer: dead jobs surface immediately.** A session whose job process died without completing shows "Possibly stuck" right away instead of waiting out the 10-minute quiet window, so Resume is offered sooner.
- Status help text updated to match. Interactive sessions without a companion job behave exactly as before.

## 2.5.0

Reliable stop: cancelling a Codex job now works, stops exactly one job, and shows up correctly everywhere.

- **Graceful cancel (safe stop → verify → force).** `/codex:cancel` and the viewer's CANCEL button now flag the job; the job's own worker interrupts its Codex turn natively (`turn/interrupt`), so the rollout records `turn_aborted` and the thread resumes cleanly later. Only if the worker doesn't stop within a 5s grace period does cancel force-kill the process tree. Cancel output reports which mode landed (`stopMode: safe | forced`).
- **Fix: cancel never killed anything when run from Git Bash.** `taskkill /PID` was routed through `$SHELL`, and MSYS rewrote `/PID` into a path (`C:/Program Files/Git/PID`). taskkill now runs without a shell.
- **Fix: stale `broker.json` broke turn interrupts** (`connect ENOENT` on a dead broker pipe). The broker endpoint is probed before being reused and fails over instead of erroring.
- **Cancelled jobs are `cancelled`, not `failed`.** A worker that stops due to a cancel request records status `cancelled` with "Cancelled by user."
- **Viewer: new STOPPED status.** Sessions whose job was cancelled show a red "Stopped" badge instead of hanging on "Waiting"; cancelled job cards are red instead of green; the stop button hides on stopped tasks.
- Dead-pid fast path: cancelling a job whose worker already died skips the grace wait.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
