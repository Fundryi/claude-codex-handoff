# Changelog

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
