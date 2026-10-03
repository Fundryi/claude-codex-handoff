# Changelog

## 2.22.0

- **The viewer shows OpenCode sessions.** OpenCode TUI chats, `opencode run` jobs and their child sessions now appear in the tree, next to Claude and Codex. A new OpenCode chip filters the tree. Click a session to read its messages, reasoning, tool output, model, tokens and cost in the same feed as Claude chats. A child session sits under its parent. The status comes from OpenCode's own idle record, so a finished session shows as finished, and a failed one as failed.
- **Claude can hand a task to OpenCode.** Add `--engine opencode` to `/codex:handoff`, for example `/codex:handoff --engine opencode --model provider/model#variant Fix the retry logic`. The model goes to OpenCode as you type it. With no model, OpenCode uses the default from your own OpenCode config. The job uses the same records as a Codex job, so status, result, cancel and the result on your next message all work the same way. Resume with `--resume` or `--resume-thread <ses_id>`. A Codex thread never goes to OpenCode, and an OpenCode session never goes to Codex.
- **OpenCode runs with full permission, like Codex.** Every run uses OpenCode's `build` agent with `--auto`, so no approval prompt can stop a headless run. `--write` is only a label, as it is for Codex. If a task must not edit files, write that in the handoff.
- **Each OpenCode run has its own private server.** The companion starts `opencode run --standalone`. It never uses OpenCode's shared background service, so the end of one Claude session cannot stop a run that another session started. The prompt goes in through stdin, so a long prompt does not hit the Windows command line limit.
- **An OpenCode handoff sits under the chat that started it.** The viewer shows it under the Claude chat or agent that sent it, with the result card, a Resume button and the context size. `/codex:status` names it "OpenCode task", and gives `opencode -s <ses_id>` to open the session in OpenCode.
- **The viewer never reads your OpenCode login data.** OpenCode keeps sessions and login tokens in one database file, `~/.local/share/opencode/opencode.db`. The viewer opens it read only and reads only the two session tables. It never writes to the file. Set `OPENCODE_DB` if your database is in a different place.
- **The dashboard is now called AI Live Viewer.** Only the shown name changed. File names, the `CODEX_VIEWER_*` settings and the `/codex:*` commands stay the same, so your setup keeps working.
- **Node 22.13 or newer is now necessary.** The viewer reads OpenCode with the SQLite module that is built into Node from 22.13. On an older Node, the OpenCode part stays off and the rest of the viewer works as before.
- **New tests:** OpenCode session rows become feed events, and unknown data is skipped (`tests/server-metadata.test.js`). The companion reads OpenCode's JSON output: the final answer, the session id, error lines and broken lines (`tests/plugin-task-result.test.js`). No test was removed.

## 2.21.0

- **The viewer uses much less CPU.** Before, each write to a Codex session started a full check, often several times per second, and each check sent the full task list to every open tab. Now the time between checks grows with the number of tasks that run: about 0.3 s with one task, 2 s with 20 or more. The viewer does not send a task list again when nothing in it changed. It reads a job state file again only when the file changed. Measured at the same time with the same load (19 live Codex sessions and running Claude agents): 21.4 % of one CPU core before, 4.7 % after. Task list updates went from 4 per second to 0.5.
- **With no browser open, the viewer does very little work.** It checks for changes every 5 s and looks for new Claude chats every 25 s. When you open the page, it catches up first, so the first view is current. Measured: 14.9 % of one core before, 2.8 % after.
- **New sessions still show quickly.** A new Codex session shows in about 0.1 s when few tasks run, and within 2 s when many run.
- **A resumed old Codex session shows again.** The viewer follows the 40 newest Codex sessions. On Windows, Codex keeps the creation time on a session file, so an old session that you resumed did not sort up and never showed. Now the full scan every 30 s sees that the file grew. The viewer then follows that session next to the 40 until it has read the new lines. It does not push another session out of the list.
- **An open question stays until you answer or dismiss it.** The viewer reads the 100 newest Codex jobs. On a busy day, a job with an open question fell past 100, and its "Needs answer" row left the list with no notice. Now the viewer also keeps older jobs that wait or run, and the newest job of each thread that has an open question.
- **A click on an old handoff opens its page.** A handoff that waits for your answer stays in Live, but its Codex session can be older than the 40 newest. A click on its row showed only the result popup. Now the click loads the session and opens the full page with the transcript and the answer box. If the session file is gone, the popup opens as before.
- **The "Waiting" time moves in 5 s steps.** This keeps a quiet task list the same from one check to the next, so the viewer does not send it again.
- **Tests:** no test was added or removed. Real checks on a test copy with a fake sessions folder: a new session shows in 0.1 s; a resumed old session shows after about 27 s; while it is read, all 40 other sessions stay in the list and no old event is sent again.

## 2.20.0

- **Claude limits stay current without /usage.** The plugin ships a status line script. Claude Code hands every status line your 5-hour and weekly limits after each reply. The script prints them at the bottom of the chat (for example "Opus 5.5 · 5h 2% · week 44%") and saves them to `~/.codex-companion/claude-limits.json`. The dashboard shows the newer of this file and the `/usage` snapshot. Numbers from the status line do not hide after one hour: they only grow while you use Claude, and a window whose reset passed shows "unknown". The per-model weekly limit (for example Fable) still comes only from `/usage`.
- **You turn it on with one setting.** A plugin cannot set a status line, so add `"statusLine": { "type": "command", "command": "node \"<home>/.codex-companion/claude-statusline.mjs\"" }` to `~/.claude/settings.json`. The session hook copies the script to that path at each session start, so the path stays the same after plugin updates. The README section "Claude limits that stay current" has the steps. If you already have a status line, keep it: the dashboard then uses the `/usage` snapshot, as before.
- **It is light.** One run takes about 50 ms, after a reply and never during one. It makes no network call and costs no tokens. The file is replaced on each run and stays about 150 bytes. A failed write leaves no temporary file.
- **Where it works.** Confirmed in the terminal CLI. Not yet confirmed in the VS Code extension: it did not run in a VS Code chat that was open before the setting was added. Limits appear only for claude.ai Pro and Max plans.
- **New tests:** the status line script keeps only the two documented windows and copies itself to a stable path (`tests/plugin-autostart.test.js`); the newer source wins and the per-model week keeps its own age (`tests/server-metadata.test.js`).

## 2.19.0

- **One tree shows all work that a Claude chat starts.** The sidebar is now a tree, grouped by project. Each Claude chat is a root. Under it are its subagents, its workflow runs and its Codex handoffs. Each handoff sits under the exact agent that started it, also when a subagent or a workflow agent started it. Codex agents nest under their handoff at every level. Your own Codex CLI runs are roots of their own, with a "you" tag. A handoff whose chat is not on this PC sits under "Not on this PC". Finished children fold behind one "+ N finished" row.
- **Two tabs replace four.** Live shows everything from the last 24 hours, and older work that still needs you. History keeps the finished and older Codex sessions. Status chips count a root when any node in its tree has that state. Two kind chips, Claude and Codex, filter the tree. Saved tabs from 2.18.0 map to the new ones (Handoffs becomes Live with the Codex chip; the Claude tab becomes Live with the Claude chip).
- **The viewer opens on what runs now.** Live starts on the Running chip, so the tree shows only the work that runs, and work that waits for your answer. A view saved by an older version moves from All to Running once. If nothing runs, the list says so and has a button that shows everything from today. The overview shows Running first, then Needs you and Needs attention. Finished work is behind one "Show finished" button. Under a chat, active work is always on top, the newest started first, so a row does not move while it writes. Finished children come after it, the newest first, folded behind "+ N finished". An overview card lists only the children at work, and counts the finished ones on one line. When a task you have open finishes, the chip you picked stays: a bar at the top of the list leads back to it.
- **The look follows a calm, dark reference design.** The sidebar, the main page and the side panel are rounded cards with gaps between them. Every surface has rounded corners. One violet color marks the tree lines and the selection. Status colors are few and small. A finished child is one quiet line. No card or message has a colored edge stripe: each has one even, quiet border.
- **A Claude chat opens with its own transcript.** Click a chat to read it live: your prompts, Claude's replies and Claude's work. A Claude subagent or a workflow agent opens in a side panel next to its chat or run. The header shows a breadcrumb back to the parent, the model, the effort and where the chat runs (VS Code, Terminal, Desktop, SDK).
- **Token usage is always on screen.** Every row shows its tokens. A root shows the total of its whole tree, split into Claude and Codex. The header shows the context, the total and the tree. Over a 64 MB chat file the viewer reads only the newest 64 MB, and the total shows "≥" as a lower bound. Until the first read reaches a file, its total shows "counting…".
- **The sidebar shows your plan limits.** A block at the bottom shows how much of each limit you used, with the word "used" on every number and the reset time next to it.
  - Codex: the viewer asks Codex for its limits every 5 minutes while a browser has the viewer open, and when a job ends. Each read starts one short `codex app-server` through the companion command `limits` and takes about 1 second. Each Codex window has its own row ("5 h", "week"). A small pill shows how many free limit resets you have, for example "3 resets". Its tooltip gives the date when the next one expires.
  - Claude: the numbers come from the snapshot that Claude Code saves when you open `/usage` or the VS Code usage panel. Nothing else updates it. When the snapshot is older than one hour, the block hides the numbers and says "open /usage", because old numbers can be wrong. A per-model weekly limit (for example Fable) shows only when it is the limit that applies now. The viewer reads only that one key from `~/.claude.json`, which also holds your login data.
  - A window whose reset time has passed shows "unknown", not the old number.
- **One counter covers every kind.** The header counter shows how many trees run, need you, or need attention. Click it to filter the tree.
- **Wide screens use the extra width.** From 2200 px, the side panel shows the Live overview next to the open page. Add `?wide=0` to the address to turn this off.
- **Claude transcripts use the same gate as Codex jobs.** Every link that can use the controls can read them: the localhost link, the tunnel link and a declared proxy name. A page from another site cannot. If you start the viewer with `--host 0.0.0.0`, every device on your network can read your Claude chats, the same as your Codex jobs. The new endpoint `/claude/transcript` serves chats, subagents and workflow agents. `/claude/agent` stays for one release.
- **The live stream and search check the address too.** `/events` and `/search` now refuse a request with an unknown Host, the same as `/jobs`. A web page that changes its DNS record to point at your PC (DNS rebinding) can no longer read your task titles, prompts and paths. If you open the viewer through a proxy name, add that name to `CODEX_VIEWER_ALLOWED_HOSTS`.
- **History lists every Codex session.** This includes handoffs under a chat, and handoffs past the 20 children that Live shows per chat. Search filters History too. A dismissed or archived handoff leaves Live also when it sits under a chat.
- **A chat that only ran a slash command is named after it.** For example, a chat where you only opened `/workflows` shows as "Ran /workflows", not as its id.
- **Every Codex result names its job and its thread.** The companion now ends a foreground result with the line `Codex job: <id> · thread: <id>`. The viewer uses it to find the agent that started the job.
- **Codex sessions report their context.** The viewer now reads the context size and the context window from each Codex session. It does not take the plan limits from a session file: one event there holds one limit bucket, and after a Spark run the block showed the Spark limit (0 %) in place of your real one.
- **Removed test:** "claudeTranscriptAllowed: this PC's browser or the tunnel link only" in `tests/remote-access.test.js`. The function is gone, because transcripts now use `trustedControlOrigin`, which has its own tests. The serve test checks that the transcript routes refuse a foreign origin.
- **Removed tests:** "Follow newest keeps a thread resumed after its handoff finished in the running view" and "Follow newest deliberately returns to the running view" in `tests/viewer-ui-state.test.js`. Auto-open no longer switches the tab or chip, so there is no view to return to. The new test "Auto-open follows a running Codex task, never away from an open Claude page or panel" covers what is left, and adds the case that auto-open never leaves an open chat or side panel.
- **Removed test:** "child sessions render nested with a nickname chip" in `tests/ui-agents.test.js`. It only checked that two CSS rules exist, and both rules are gone with the old list rows. The buildNodes test checks that Codex agents nest at every level, and `tests/stopped-status.test.js` keeps the "Needs attention" label check.
- **Removed tests:** "the chip widens only when the open node's status change takes its root out of the view", "Everything stays Everything when the open node changes" and "an open Codex child agent follows the view of its root" in `tests/viewer-ui-state.test.js`. The chip no longer widens on its own (with Running as the default, each finished task would have reset the list to All), so the function they tested is gone. The saved-view test in `tests/ui-rows.test.js` now checks the Running default and the one-time switch.
- **Changed tests:** four navigation tests in `tests/viewer-ui-state.test.js` now check the Live and History tabs instead of Now, Handoffs and Claude. The parts about the Handoffs tab are gone with that tab.

## 2.18.0

- **The viewer shows Claude Code workflows live.** A new Claude tab lists each run of the Workflow tool with its phases and agents. It shows which agent runs, its current tool and its context size, with a progress bar per phase. Click an agent to follow its transcript live in a side panel next to the run. On a narrow screen the panel covers the run and has a back button. Finished runs show their totals.
- **Claude work never looks like Codex work.** Everything from Claude uses the Claude orange, as handoffs already did. A Claude workflow has its own label ("Claude workflow") and its own icon, so it is not mistaken for a handoff (✳ "Handoff"). Codex stays teal. Claude runs never appear in the Now, Handoffs or History lists, and Codex jobs never appear in the Claude tab. The feed names the actors "Workflow script", "Claude agent" and "Agent work".
- **The project, the model and the effort stand out.** The top of every task, Claude or Codex, shows them as chips under the title: the project in bold with a folder icon, then the model (for example "Opus 5.5" or "gpt-6.1-sol") and the effort. List rows show the project in bold. In a Claude run, an agent shows its own model or effort only when it differs from the rest of the run.
- **A header counter shows running Claude workflows on every tab.** It reads "Claude: N running", plus a count of runs that need attention. Click it to open the Claude tab.
- **The Claude tab only reads.** It reads the run files under `~/.claude/projects` every few seconds and never writes there. It never runs a workflow script. Its menu only copies the run ID, the journal path, a resume hint and the agent ID. There is no stop, pause or resume.
- **Transcripts stay on your machine.** Agent transcripts can hold text from every project, so the viewer sends them only to a browser on the same machine that uses the `localhost` link, or to the tunnel link. When `CODEX_VIEWER_ALLOWED_HOSTS` is set, only the tunnel link shows them.
- **Job reports to the viewer must come from this machine.** The viewer accepts a finished-job report only from a direct local connection without a browser origin. The plugin's own reports still arrive.
- **The tab row fits narrow screens.** The tabs now take the width of their names. In a sidebar under 300 px the counts hide, so all four tab names stay readable. On phones the header title wraps under the badges instead of shrinking to nothing.
- **The old broker cleanup is gone.** 2.17.0 removed the shared broker. Its session-end cleanup, the SessionEnd hook and two broker files are now deleted as well. If you update from a version older than 2.17.0 straight to 2.18.0, an idle old broker process can stay until you restart the computer. It does nothing.
- **New license: Apache 2.0 with the Commons Clause.** You may use, change, fork and share the project, but not sell it. Code that comes unchanged from openai/codex-plugin-cc stays plain Apache 2.0. Releases up to 2.17.0 keep plain Apache 2.0.
- **Removed test:** `tests/plugin-session-end.test.js`. It checked that the SessionEnd hook left running jobs alone. That hook no longer exists, so nothing runs at session end.

## 2.17.0

A cleanup release from a full review of the plugin by six Codex agents. Every change was checked twice for side effects before it was made.

- **The shared broker is gone.** Every command now starts its own short Codex process, as handoffs and reviews already did. `/codex:setup` and `/codex:status` show "private per job". A broker left running by an older version is asked to stop when a session ends. That step waits at most 1 second and never ends a process by its id.
- **Windows paths keep their backslashes.** Commands such as `/codex:result`, `/codex:status` and `/codex:cancel` removed every backslash from a path. Now a backslash only escapes a quote character.
- **An option value keeps everything after the first `=`.** `--base=feature/auth=v2` was cut to `feature/auth`.
- **A background job never starts before its record is saved.** Two jobs launched at the same moment could start a worker that found no record.
- **No result is lost when several jobs finish at once.** The prompt hook shows at most three results in full. It marked the others as delivered too, so they never came back. Now only the results it showed are marked.
- **A cancel never overwrites a finished job.** Job files now use the same lock as the state file.
- **Finished work is never marked cancelled.** A run that ended successfully stays completed, even when a stop was sent at the same moment.
- **Reviews can be cancelled cleanly.** `/codex:cancel` now stops `/codex:review` and `/codex:adversarial-review` the same safe way as a handoff.
- **A failed `/codex:review` says why.** It used to report "Review completed" with no reason.
- **A question that starts with "None" is still a question.** "None of these fit. Should I keep the API?" was taken as "no question". A "Needs decision" heading inside a code block is no longer taken as a question. The plugin and the viewer read results the same way.
- **`CODEX_PLUGIN_FAST_TIER` accepts only letters, digits, `-` and `_`.** Any other value falls back to `priority` with a warning, so nothing unexpected reaches a Windows shell.
- **The viewer survives bad input.** A malformed search or open request, an odd record in a session file, or a file that disappears while it is read no longer stops the viewer. Text with accents or emoji that was split between two reads is no longer garbled.
- **The viewer's status is more exact.** A session shows DONE only when its latest turn has finished. Agents started by a child agent get their own row. The open feed updates when its job fails. A reconnect keeps your place in the feed. Search no longer lists a child session twice.
- **The Resume dialog has no "Allow writes" box.** It never changed what Codex may do; the Sandbox setting does that. `--write` stays as a label for edit tasks.
- **The standalone tray downloads include the companion script,** so Resume and Cancel work in them.
- **Less code.** Unused functions, styles and duplicate code were removed: about 550 lines fewer.

## 2.16.1

- **Two jobs at the same time no longer lose a result.** Jobs in one project share one state file, and each job rewrote it with no lock. When two jobs ran at once, one write could replace the other. A finished job then stayed `running`, and the dead-job check marked it failed with "Worker process exited without recording a result". Every change to the state file now waits for a lock. The file is written to a temporary file first and then renamed, so a process that stops mid-write leaves the old file intact.
- **A finished job is never marked dead.** If the job's own file already records the end of the run, the dead-job check copies that result and does not mark the job failed.
- **`--resume-last` finds the thread again when no Claude session id is known.** The fallback asked Codex for threads from the wrong source and found none.
- **The retirement warning shows everywhere.** It is now also on the first line of `/codex:result`, `result --wait` and the prompt hook, not only in the first output.
- **The job log shows model reroutes and Codex notices.** When Codex moves a run to another model, the log says from which model to which, and why. Deprecation notices and general warnings from Codex are logged too.

## 2.16.0

Checked against Codex CLI 0.159.2.

- **`sol` now runs GPT-6.1 Sol.** `--model sol` expands to `gpt-6.1-sol`, the new Codex default model. GPT-6 Sol is still available by its full name, `--model gpt-6-sol`. `max` and `ultra` work on `gpt-6.1-sol`.
- **The reviews expand model shortcuts.** `/codex:review --model sol` and `/codex:adversarial-review --model sol` now send `gpt-6.1-sol`. Before, they sent the word `sol` as the model name.
- **`/codex:adversarial-review` takes `--effort`.** Without it, the review runs at `xhigh`, the same default as a handoff. Before, it used the effort from your Codex config or the model default. `/codex:review` takes no `--effort`: Codex's review request has no effort field, so it runs at the effort in your Codex config. If you pass `--effort`, it is refused and you are pointed to `/codex:adversarial-review --effort`.
- **A wrong model or effort fails before the run starts.** For handoffs and `/codex:adversarial-review`, when you pass `--model`, the plugin checks it against the models of your Codex account. An unknown model stops with a clear message. An effort that the model does not take stops and names the efforts it does take. If Codex cannot list its models, the run starts as before.
- **A model that Codex plans to retire gets a warning.** For handoffs and `/codex:adversarial-review`, when `--model` names a model that Codex plans to replace, the run still starts. The first line of the result names the retirement date and the model Codex suggests, and the job log has the same line. `/codex:review` gives no warning.
- **A retry is not a failure.** When Codex says it will retry, the job shows "Codex retrying" and keeps running. Before, the job could show as failed while Codex was still working.
- **Terminal control text no longer breaks the connection to Codex.** Some shells put escape codes or plain text in front of the Codex output. The plugin now skips them. Before, this stopped the run with a protocol error.
- **Every failure reason reaches the result.** When Codex reports the error only at the end of the turn, the result now shows it.
- **Codex does not wait for an answer during a run.** The return format tells Codex that no one can answer during the run. Codex must not use a tool that asks the user. It puts each question under "Needs decision" instead.
- **The adversarial review thread is saved.** Its name is "Codex Companion Review: <target>". `--resume-last` never picks it up.
- **Task threads get a short name.** A new task thread is named after the task title, not after the start of the full prompt.
- **No Node warning about shell arguments.** Newer Node versions printed a DEP0190 warning when the plugin started Codex through a shell. The warning is gone. The command that runs is the same.
- **The tunnel token moved out of `~/.codex`.** It is stored in `~/.codex-companion/state/live-viewer-token`, so the viewer no longer writes under `~/.codex`. An existing `~/.codex/live-viewer-token` is copied over on first start, so old tunnel links keep working. To rotate the token, edit or delete the new file.
- **The viewer shows LIVE on Windows again.** The last-activity time now comes from the newest record in the session file. Before, it came from the file's change time, which on Windows can stay at the time the file was made, so a running session did not show as LIVE.
- **Commands and file changes are back in the feed.** Codex 0.159 writes them in a new record format that the viewer did not read. The feed now shows each command with its exit code and output, each changed file with its diff, MCP tool calls and web searches. A command that some older Codex versions wrote twice shows once.
- **Sub-agent sessions have their own title.** A session that a Codex agent started is named "Agent <name> · <path>". Before, it showed the parent's prompt as its title.
- **History and search show titles for almost all sessions.** The viewer reads further into each session file to find the title. Before, most new sessions had no title. The session list also builds about three times faster.
- **Session sources have clear names.** A session shows "Codex CLI", "Codex SDK" or "Codex Desktop". The text that Codex adds before an approval check shows as internal text, not as a user message.
- **Installed in Codex, the plugin loads only its skills.** A new `.codex-plugin/plugin.json` manifest stops Codex from running the Claude hooks. The old leftover `plugin.json` (version 1.0.6) is removed.

## 2.15.7

- **The viewer works behind a reverse proxy.** Set `CODEX_VIEWER_ALLOWED_HOSTS` to the name the proxy serves it under, for example in the `env` block of `~/.claude/settings.json`. Before, every control request through a proxy was refused as "untrusted origin", so jobs never showed. The name can be bare, carry a port, or be the full URL. Setting it also makes the viewer listen on all addresses, unless `CODEX_VIEWER_HOST` says otherwise.
- **Live updates stay open behind a proxy.** The viewer sends a keep-alive line on both event streams every 25 seconds. Before, nginx closed a quiet stream after 60 seconds.
- **A refused control says why.** The header shows "Controls blocked at this address". Hover over it to see the name to add. The refusal text names it too.

## 2.15.6

- **`/codex:handoff` is the main command.** It hands a task to Codex. `/codex:rescue` keeps working as the same command under its original name, and a test keeps the two identical.
- **A port used by another program is named plainly.** `/codex:viewer` used to say only "Failed to start within 5s". It now says that another program uses the port and names the fix: set `CODEX_VIEWER_PORT` to a free port. Session start says the same, once per port and day, because CloudCLI runs it on every message. The viewer never touches the other program.
- **Command hints match the options.** `/codex:review` and `/codex:adversarial-review` list `--model`, `--fast` and `--cwd`. `/codex:status`, `/codex:result` and `/codex:cancel` list `--cwd` and say they also find a job started from here with `--cwd`. `/codex:handoff` lists `--fast`. A test checks that every flag a hint offers exists.
- **The README explains the port and address**, including WSL and Docker.

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
