---
description: Hand a task to Codex or OpenCode (investigation, a fix, or follow-up on the same thread); it runs in the background and the result comes back by itself
argument-hint: "[--engine codex|opencode] [--background] [--cwd <folder>] [--resume|--fresh] [--resume-thread <id>] [--model <model|astra|sol|terra|luna|daybreak-blue>] [--effort <low|medium|high|xhigh|max|ultra>] [--fast] [what the engine should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `codex:codex-rescue` subagent via the `Agent` tool (`subagent_type: "codex:codex-rescue"`, `run_in_background: true`). It waits for Codex by itself and sends you one message with the final result; keep working meanwhile. With `--background` that message carries only the job id, and the result comes later through the prompt hook.
`codex:codex-rescue` is a subagent, not a skill. Do not call `Skill(codex:codex-rescue)` (no such skill), `Skill(codex:handoff)` or `Skill(codex:rescue)` (those re-enter this command and hang the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.

Raw user request:
$ARGUMENTS

Before you call the subagent:

- Write the handoff as the `codex-prompting` skill describes (goal, rules, done_when, files). You can see this conversation and the subagent cannot, so the handoff must carry what Codex needs to know.
- Choose the engine. Codex is the default. Use `--engine opencode` only when the user asks for OpenCode or names an OpenCode model (`provider/model`).
- Put the routing flags from the raw request (`--engine`, `--background`, `--cwd <folder>`, `--resume`, `--fresh`, `--resume-thread <id>`, `--model`, `--effort`, `--fast`) on the first line, before the handoff. Drop `--wait`; it is a no-op.
- `--cwd <folder>` runs Codex in another folder. Use it on hosts where Claude cannot change folder, such as CloudCLI, which runs every session in one fixed folder. The result still arrives here through the prompt hook, and `/codex:status <id>` and `/codex:result <id>` find the job from this folder, as does `/codex:cancel <id>`. Bare `/codex:status` and `/codex:result` (no id) show only this folder's own jobs.
- If the request is already a complete instruction, forward it unchanged.
- If the request has `--resume`, `--fresh`, or `--resume-thread`, the user already chose. Do not ask about continuing.
- Otherwise check for a resumable rescue thread from this Claude session. Add `--cwd "<folder>"` when supplied, and `--engine opencode` for an OpenCode request:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
```

- If it reports `available: true`, use `AskUserQuestion` once: continue the current thread or start a new thread of the selected engine. Put `(Recommended)` on continue when the user is clearly following up ("continue", "keep going", "apply the top fix", "dig deeper"), otherwise on the new thread. Add `--resume` or `--fresh` to match.
- If it reports `available: false`, do not ask.

After the subagent returns:

- Without `--background`, the subagent returns only when the Codex job has ended. With `--background`, it returns the job id at once, and the result arrives through the prompt hook on the next message or through `/codex:result <id>`. If this process ends first, as it does under hosts like CloudCLI, the prompt hook delivers the result on the next message. Do not start your own waiter.
- Show Codex's output to the user verbatim, with no paraphrase or commentary around it. Then follow the `codex-result-handling` skill, which covers a "Needs decision" question.
- If Codex is missing or unauthenticated, tell the user to run `/codex:setup`. If OpenCode is missing, show its install and first-run error.
- If the user did not supply a request, ask what Codex should investigate or fix.

Flag rules (model shortcuts, effort, resume, write) live in the `codex-cli-runtime` skill. Do not restate them here.
