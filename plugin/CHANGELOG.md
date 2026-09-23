# Changelog

## 2.15.5

- **`/codex:viewer kill` force-quits the viewer.** It works when the viewer hangs and no longer answers, which `stop` cannot handle. The viewer now records its process id when it starts. `kill` checks that this process is still a viewer before it ends it, so a stale record never kills another program. On Windows it also ends a tunnel the viewer started. `stop` and `status` now point to `kill` when the viewer does not answer.

## 2.15.4

- **A slow viewer is not taken for a stopped one.** The viewer commands wait 1 second for an answer. A viewer still loading its history can take longer, and was then reported as "not running". A replace could also start the new viewer while the old one still held the port. Now a slow answer is reported as "not answering, try again", and nothing is started or stopped.
- **The start message prints once.** Overlapping checks could print "Codex Live Viewer running" up to four times.

## 2.15.3

- **`/codex:viewer` can restart, stop and check the viewer.** `/codex:viewer restart` replaces whatever viewer runs, `/codex:viewer stop` stops it and checks that the port is free, and `/codex:viewer status` shows whether it runs and its version.
- **Starting the viewer replaces an older one.** `/codex:viewer` and `codex-live-viewer.js start` now read the running viewer's version. If it is older, they stop it and start the new one, so a plugin update takes effect without a new session. A newer or equal viewer, or one with no version, is left alone.
- **`CODEX_VIEWER_HOST` is documented.** It sets the bind address, and the plugin's autostart uses it too. `0.0.0.0` opens the viewer to your LAN without a token.

## 2.15.2

- **Failed checks are reported as failed.** The return format now tells Codex to mark each failed command under "Checks run". If a command in a chain fails, the commands after it did not run, and Codex must not state a result from them. Before, a chained check that stopped early could come back as a finding.
- **Fresh jobs show "<1m".** The prompt hook rounds ages to whole minutes. A job younger than 30 seconds showed "0m", which read as if it had not started.

## 2.15.1

- **Jobs started with `--cwd` reach you.** On hosts where Claude cannot change folder, such as CloudCLI, a job started with `task --cwd <folder>` was stored under the other folder and never reported. The companion now leaves a pointer in the folder Claude runs in. The prompt hook delivers the result there once. `/codex:status <id>`, `/codex:result <id>` and `/codex:cancel <id>` find the job without `--cwd`. Bare `/codex:status` still lists only the current folder. Pointers to jobs that no longer exist are removed, and the hook does the same work however many pointers point into one folder. A `--cwd` on the first line of a handoff now counts too, Windows paths included, and a folder that does not exist gets a clear error.
- **The viewer resumes and cancels from the job's folder.** Runs it starts no longer show up in the prompt hook of whatever folder the viewer was started from.
- **`--background` returns at once.** The rescue agent returns the job id and no longer waits for the result. It passes `--cwd` on to `task` and `result --wait`. The rescue command and the runtime skill document `--cwd`.
- **An old viewer is replaced after an update.** At session start the hook reads the running viewer's version. If an older plugin started it, the hook stops it and starts the bundled one. An equal or newer viewer, one with no version, and another app on the port are left alone. The wait for the port is capped at 1.5 seconds. If the old viewer does not stop, the hook says so once and does not try again for that plugin version.
- **Codex's opening lines are kept.** When Codex answers above the Summary heading, the prompt hook report and the viewer's result card now show those lines first. Before, a stub Summary such as "Completed." hid the answer.
- **The job log shows full commands.** Commands were cut at 96 characters, which hid the second half of a chained command. They are now logged whole, up to 4000 characters, with "(truncated)" past that.

## 2.15.0

- **The feed shows who sent each message.** Every message has a sender and a receiver, such as "Claude -> Codex" or "Codex -> You", in one color per actor: You, Claude, Plugin, Codex, Codex work and System. A small legend above the feed explains the colors.
- **Claude and you are told apart.** The server now passes on each session's originator. In a session Claude started, a prompt is Claude's handoff; anywhere else it is yours. An answer that starts with "Answer from the user:" shows as your words, relayed. One that starts with "Answer from Claude (automatic" shows as Claude's own answer. In a child agent's session, prompts show as coming from the lead agent. The text a Resume sends by default is tagged "resume", not "handoff".
- **The task header says who started it.** "Started by: Claude (handoff)", "Started by: you (Codex CLI)" or "Started by: Codex (lead agent)" for a child agent. Sessions with no originator show no line. On a phone the header shows the project name instead of the full path.
- **The plugin's return format is split off.** The footer the plugin adds to every handoff prompt now sits in its own collapsed Plugin part, so the prompt reads as what Claude asked.
- **Codex questions stand out.** A reply with a question under Needs decision gets an "asks you" tag and a "Question for you" callout that holds the whole question, however long, with its options. In a handoff both say "via Claude".
- **Codex work is one collapsed log per turn.** Thinking, commands, output, patches and tools fold into one "Codex work" row under their turn. While a task runs, the feed ends with "Codex is working" and the latest step.
- **Injected context is always there, and always collapsed.** The Show internals switch is gone. Permissions, AGENTS.md, environment and hook text fold into one quiet System row. Only the tags Codex itself injects count as context, so a prompt that opens with a tag such as `<goal>`, `<task>` or `<role>` shows as a message and keeps its title.
- **The Start button is gone**, with its dialog and the `/task` and `/review` endpoints. Runs start from Claude or a Codex CLI. Resume, answer and cancel work as before.

## 2.14.0

- **One list instead of two.** Sessions and handoff jobs used to live in separate views with 8 overlapping filters. They are now one list with three tabs: Now, Handoffs, History. Each tab has small filter chips with counts, and every old filter still has a home there.
- **One word per status.** Running, Waiting, Needs attention, Needs answer, Stopped, Finished, Archived. The same word and color show in list rows, tabs, the task header and dialogs, so a run never looks alive in one place and dead in another.
- **A session that ends in an error now shows as Stopped, not Waiting forever.** A quiet session whose last event is an error, such as an aborted turn, used to sit in Waiting with no way to tell it apart from a session that is simply idle.
- **The Now tab replaces Home.** It shows Needs answer, Needs attention, Running and Recently finished, and opens whenever no task is selected or you click Now again.
- **One Start dialog.** New task, Review and Adversarial review used to be three separate buttons and forms. Start now opens one dialog with a Kind switch, and the model field is a dropdown of the current shortcuts plus a custom option.
- **A result card with an answer box.** A finished handoff now shows Summary, Changed files, Checks run and Needs decision right in the feed. If Codex asked a question, an answer box resumes the same thread after the normal in-app confirm.
- **Feed output renders as Markdown.** Codex and user messages, and the result card, show headings, bold, italic, code, and lists instead of raw text. Links show as plain text plus the URL; nothing untrusted is ever inserted as HTML.
- **Consecutive thinking steps collapse into one row.** "Thinking - N steps - <first summary>" expands to show each step.
- **The feed follows the bottom and pauses when you scroll up**, showing Jump to latest. The separate Auto-scroll toggle is gone since this is now the only behavior.
- **The sidebar drawer gets a backdrop on mobile**, chips scroll sideways instead of wrapping off screen, and Escape now also closes the row menu. `/` focuses search when no field is focused.
- **The right-click row menu and the ... menu are now one shared builder**, grouped into Job, Session, Terminal commands and Diagnostics, so both stay in step.

## 2.13.0

- **Results come back on their own.** The prompt hook used to print a pointer to `/codex:result`. It now prints a short result for up to 3 finished jobs: the Summary, any question Codex asks, and the job id for the full text. This works under hosts like CloudCLI too, where the Claude process ends on every message.
- **Codex can ask, Claude can answer.** Every task ends with the headings Summary, Changed files, Checks run and Needs decision. A question under Needs decision flags the job. Claude answers only when it is sure, and asks you otherwise, then resumes the same thread with `--resume-thread`. It gives at most 2 automatic answers per thread.
- **One handoff form.** Main Claude writes goal, rules, done_when and files, because it can see the conversation. The rescue agent forwards the text unchanged through a heredoc and no longer rewrites it.
- **The rescue agent runs in the background and waits by itself.** `/codex:rescue` starts it as a background subagent, so Claude keeps working. On a long job the agent waits in 9-minute steps and sends one message with the final result, instead of an early "Waiting..." reply.
- **Less noise.** The follower no longer copies the whole Codex log into Claude's context, so the answer appears once. The companion adds its own list of recorded file edits.
- **Fixes.** A task passed as one string keeps its line breaks, quotes and backslashes. `/codex:result` marks the job delivered, so the hook stops reporting it again. The stop review gate now waits the full 15 minutes instead of blocking after 100 seconds.

## 2.12.0

- **`sol` and `luna` now run GPT-6.** `--model sol` expands to `gpt-6-sol` and `--model luna` to `gpt-6-luna`. Both are new in the Codex catalog and both answered a live run. `terra` stays on `gpt-5.6-terra` because there is no GPT-6 Terra. For the older models, pass the full name, such as `--model gpt-5.6-sol`.
- **The `spark` shortcut is gone.** `gpt-5.3-codex-spark` is no longer in the Codex catalog, and the API now rejects it for ChatGPT accounts.
- **The effort rules match the catalog again.** `max` works on every GPT-6, GPT-5.6, and Daybreak model, but not on `gpt-5.5`. `ultra` works on `gpt-6-astra`, `gpt-6-sol`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-daybreak-blue-latest`. The Luna models stop at `max`. Checked against Codex CLI 0.155.1 with `codex debug models`.

## 2.11.6

- **SessionEnd no longer kills your jobs.** The SessionEnd hook used to terminate every queued or running job the ending session had started and delete its record and log. Hosts like CloudCLI end the Claude process on every new message, so a long rescue died the moment you typed anything and `/codex:status` said "No jobs recorded yet". Workers are detached and own their app-server, so the hook now leaves them alone. The next prompt re-announces the job and `/codex:result <id>` still works from the new session.

## 2.11.5

- **Detached jobs no longer die when another session ends.** Rescue and review workers used to share the per-workspace Codex broker. When any Claude session in that repo ended, its SessionEnd hook shut the broker down, Codex aborted the turn, and the worker exited without writing a result. The job then showed `process-vanished` with no reason. Workers now spawn their own `codex app-server`, and a connection that closes mid-turn is recorded as a failure with its reason.

## 2.11.4

- **Flags pasted into the prompt now count.** A rescue prompt that opens with a line like `--model astra --effort high` used to run on the wrong model with the default effort, and the job was titled after that line. The companion lifts leading flag lines out of the prompt and applies them. Flags given on the command line still win.

## 2.11.3

- **The rescue command hint names `astra`.** The argument hint for `/codex:rescue` listed every model shortcut except the new one. Docs only.

## 2.11.2

- **`start --no-open` skips the browser tab.** Every restart of the dashboard used to open a fresh tab. The flag keeps a detached start silent. The plugin autostart never opened tabs and is unchanged.

## 2.11.1

- **Agent teams read as one unit.** A parent session and its child agents sit inside one purple bracket with an "Agent team" caption and a tree line to each child. The parent carries a `lead` badge, each child its nickname. Sessions without agents stay plain, so you see at a glance what belongs together and what runs alone.

## 2.11.0

Every run has a readable name, only real handoffs can be stuck, hook noise stays out of the feed, and Codex child agents show under their parent.

- **Child agents show under their parent.** When Codex spawns agents, each one writes its own rollout with a parent thread id and a nickname. The dashboard now nests those sessions under the parent card with the nickname as a chip, counts them on the parent ("2 agents"), and folds them into the parent's Home card. A finished job records the agents it used, and the job line in the dashboard lists them.
- **Jobs get a real title.** Every job used to be called "Codex Task". The title now comes from the first meaningful line of the prompt: XML tags and the "Dispatch flags" and "Binding contract" lines are skipped, and text after "Task:" wins. The dashboard borrows that title for the session on the same thread.
- **Prompts are back in the feed.** Codex 0.153 records the user's prompt only as a user-role response item, which the viewer dropped. It now shows as USER, and the session title comes from it again.
- **Hook output stops posing as Codex.** Codex hooks and system blocks arrive as developer-role items. They rendered as CODEX speech; they are internal now and hidden until you toggle Internals. Injected `<tag>` blocks in user items are hidden the same way.
- **"Possibly stuck" needs job evidence.** A quiet session with no companion job is an interactive window you left open, not a stuck handoff. It stays Waiting however long it sits. Only a job whose process died or whose heartbeat stopped is marked stuck, so the "Needs attention" box stops crying wolf.
- **A child agent keeps its own thread id.** A child's rollout repeats the parent's session_meta after its own. The viewer used to take the last one, so the child carried the parent's id and looked like its own parent. The list now draws each session once and nests one level only, so bad data can never grow the page without end.
- **The dashboard reports its real version.** The `/health` version string was stuck at 2.5.0. A test now keeps it equal to package.json.

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
