# Changelog

## 2.10.0

- **GPT-6 Astra is supported.** `--model astra` expands to `gpt-6-astra`, the top model in the Codex catalog. Verified against the installed Codex CLI (0.153.0) through its own model catalog: Astra accepts `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`, supports `--fast`, and ships with a `medium` built-in default. The plugin keeps `xhigh` as its default on Astra too. The skills, the rescue command, the rescue agent, and the README now name Astra next to the GPT-5.6 models.
- **The effort table names Astra.** `max` works on Astra and every GPT-5.6 model; `ultra` needs `astra`, `sol`, or `terra`.

## 2.9.4

- **The `SessionEnd` hook asks for a 3 second timeout.** Codex caps `SessionEnd` at 3 seconds, so it clamped the old value of 5 and printed a compatibility warning at every session start. The hook already ran under a 3 second limit there; the manifest now says so and the warning is gone. Claude Code accepts either value, so the only change for Claude Code is two fewer seconds of shutdown headroom.

## 2.9.3

- **The Daybreak shortcut is `daybreak-blue` now.** It expands to `gpt-daybreak-blue-latest`. The name is exact on purpose: a Red variant exists, so a bare `daybreak` alias would turn ambiguous the day an account gains Red access.
- **Daybreak runs preflight account access.** Daybreak models are verification-gated per account. Before starting a Daybreak turn, the worker asks the app-server's `model/list`; without access the run fails immediately with a clear message instead of an opaque API error mid-run.
- **The default effort is `xhigh` everywhere, Daybreak included.** The `max` default for Daybreak from 2.9.0 is gone; `max` and `ultra` are only ever used when asked for.

## 2.9.2

- **`daybreak` model shortcut.** `--model daybreak` expands to `gpt-daybreak-blue-latest` (Daybreak Blue), the security-specialty model: sol-class reasoning with fewer restrictions on defensive security analysis, for security reviews, audits, vulnerability hunting, and reversing. It already got the `max` default effort; now it has the shortcut, and the skill and README explain what it is for.

## 2.9.1

- **The prompting skill is now `codex-prompting`.** The old folder and skill name `gpt-5-4-prompting` claimed one model version; the guidance covers Codex across GPT-5.4 through the GPT-5.6 family, so the name now says what it is. All internal references moved with it. If you invoked it by its old internal name anywhere, use `codex:codex-prompting`.

## 2.9.0

Model and effort handling now matches what Codex actually ships, and healthy jobs stop looking stuck.

- **Model shortcuts for the GPT-5.6 family.** `--model sol`, `terra`, and `luna` map to `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`; `spark` still maps to `gpt-5.3-codex-spark`. The mapping lives in the companion CLI, so it works from `/codex:rescue`, the rescue agent, and the dashboard alike.
- **The effort list is real now.** `none` and `minimal` were never valid Codex efforts and are gone. `max` and `ultra` are in: every current model accepts `max` except the pre-5.6 line, and `ultra` needs `gpt-5.6-sol` or `gpt-5.6-terra`. The list was verified against the installed Codex CLI (0.147.0) through its own app-server `model/list`.
- **Unset effort no longer means low effort.** When a run has no `--effort`, the companion applies `xhigh` (`max` for daybreak models) instead of falling through to Codex's built-in default, which is `low` on the default model `gpt-5.6-sol`. A handoff you did not tune now runs smart, not cheap; `max` and `ultra` stay opt-in.
- **Healthy jobs stop reading as possibly-stuck.** The heartbeat used to advance only on progress events, and a long quiet thinking phase emits none, so a live run drifted into "possibly-stuck" after five minutes. The worker now also beats on a 30-second timer for the whole run. A stale heartbeat with a live process finally means what it says: the worker itself is wedged.
- **Home gets a "Needs attention" section.** Possibly-stuck jobs, dead-but-resumable jobs, and stale sessions now sit in their own amber-bordered section at the top of Home instead of blending into the active grid. Home cards also gained the same right-click menu as the session and job rows, so you can resume, cancel, or copy commands straight from the overview.

## 2.8.0

Waiting on a long handoff costs nothing now, and the viewer got a Home page.

- **`/codex:result` gains a deadline-free wait: `result <job-id> --wait`.** It blocks until the job is terminal — however long that takes — then prints the full report. Run it as a background Bash task (`run_in_background: true`) and the harness delivers the report the moment the job finishes: no more re-arming foreground waits every nine minutes, no lost track of a running job. A job whose worker died ends the wait too (the liveness reconciler flips it to `failed`), and `--timeout-ms` adds an optional ceiling. The follow handback and command docs now teach exactly this pattern.
- **Home view in the viewer.** A `Home` button next to Follow newest shows live cards for everything currently running, quiet, or stuck — sessions and companion jobs across all projects, deduped per thread — plus the last five finished items. Follow newest never yanks you away while Home is open; clicking a card jumps to that task.
- **Fast-tier runs are visible.** A `FAST` chip appears in the task header, session rows, the Jobs list, and the job result modal whenever the run used priority processing.
- **One feed instead of Activity/Raw tabs.** The two views differed only in showing internal events and auto-expanding patches, so they are now a single feed with an `Internals` toggle.
- **Right-click menu on the session list.** Every session and job row gets the full 3-dot action set (copy resume/continue/fork/archive, dismiss, stop, resume/cancel) at the cursor, acting on the row you clicked — no need to select it first.

## 2.7.1

- **Multi-agent handoffs no longer end with a spurious "turn aborted".** In collab-mode runs, the worker inferred turn completion just 250ms after the root agent's final answer — usually beating the real `turn/completed` event — then closed the app-server, which aborted the still-finishing turn. The rollout got stamped `turn_aborted`, the viewer showed "err: turn aborted", and resuming that thread fed Codex an "interrupted on purpose" marker, even though the job itself completed with the full result. The inferred-completion grace window is now 10 seconds, so it only fires for genuinely hung turns; normal runs complete on the real event with no added latency.

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
