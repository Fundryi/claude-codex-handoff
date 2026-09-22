---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
argument-hint: "[--background] [--resume|--fresh] [--resume-thread <id>] [--model <model|astra|sol|terra|luna|daybreak-blue>] [--effort <low|medium|high|xhigh|max|ultra>] [what Codex should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `codex:codex-rescue` subagent via the `Agent` tool (`subagent_type: "codex:codex-rescue"`, `run_in_background: true`). It waits for Codex by itself and sends you one message with the final result; keep working meanwhile.
`codex:codex-rescue` is a subagent, not a skill. Do not call `Skill(codex:codex-rescue)` (no such skill) or `Skill(codex:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.

Raw user request:
$ARGUMENTS

Before you call the subagent:

- Write the handoff as the `codex-prompting` skill describes (goal, rules, done_when, files). You can see this conversation and the subagent cannot, so the handoff must carry what Codex needs to know.
- Put the routing flags from the raw request (`--background`, `--resume`, `--fresh`, `--resume-thread <id>`, `--model`, `--effort`, `--fast`) on the first line, before the handoff. Drop `--wait`; it is a no-op.
- If the request is already a complete instruction, forward it unchanged.
- If the request has `--resume`, `--fresh`, or `--resume-thread`, the user already chose. Do not ask about continuing.
- Otherwise check for a resumable rescue thread from this Claude session:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
```

- If it reports `available: true`, use `AskUserQuestion` once: `Continue current Codex thread` or `Start a new Codex thread`. Put `(Recommended)` on continue when the user is clearly following up ("continue", "keep going", "apply the top fix", "dig deeper"), otherwise on the new thread. Add `--resume` or `--fresh` to match.
- If it reports `available: false`, do not ask.

After the subagent returns:

- Without `--background`, the subagent returns only when the Codex job has ended. With `--background`, it returns the job id at once, and the result arrives through the prompt hook on the next message or through `/codex:result <id>`. If this process ends first, as it does under hosts like CloudCLI, the prompt hook delivers the result on the next message. Do not start your own waiter.
- Show Codex's output to the user verbatim, with no paraphrase or commentary around it. Then follow the `codex-result-handling` skill, which covers a "Needs decision" question.
- If the output says Codex is missing or unauthenticated, tell the user to run `/codex:setup`.
- If the user did not supply a request, ask what Codex should investigate or fix.

Flag rules (model shortcuts, effort, resume, write) live in the `codex-cli-runtime` skill. Do not restate them here.
