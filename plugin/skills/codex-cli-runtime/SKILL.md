---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `codex:codex-rescue` subagent.

Primary helper. Flags go on the command line; the handoff text goes through a quoted heredoc, so quotes, backslashes and line breaks reach Codex unchanged:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --write <<'CODEX_HANDOFF'
<handoff text>
CODEX_HANDOFF
```

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged (plus the `result --wait` follow-ups below for a job that is still running).
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, or `cancel`; call `result` only as `result <job-id> --wait` for the job you just started.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- Do not rewrite the handoff. Main Claude wrote it with context you do not have.
- Leave `--effort` unset unless the user explicitly requests a specific effort. The helper then defaults to `xhigh`, never Codex's low built-in default. Use `max` or `ultra` only when the user asks for them.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Model shortcuts: `astra` → `--model gpt-6-astra`, `sol` → `--model gpt-6-sol`, `terra` → `--model gpt-5.6-terra`, `luna` → `--model gpt-6-luna`, `daybreak-blue` → `--model gpt-daybreak-blue-latest`. The GPT-5.6 Sol and Luna models are still reachable by their full names. Daybreak Blue is the security-specialty model: sol-class reasoning with fewer restrictions on defensive security analysis. Use it for security reviews, audits, vulnerability hunting, and reversing work. Daybreak access is verification-gated per account; the helper checks availability before starting the run and fails fast with a clear message if the account has no access, so do not pre-test access yourself. (A Red variant exists but is not available here.)
- Default to a write-capable Codex run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff, followed by `result <job-id> --wait` calls only if the job is still running when `task` returns.
- If the forwarded request includes `--resume-thread <id>`, pass it to `task` as-is and do not add `--resume-last`.
- `--background` is forwarded to `task` as-is. `--wait` is a no-op alias for the default and must be stripped. Neither is ever part of the natural-language task text.
- If the forwarded request includes `--fast` or the user asks for fast mode / priority processing, strip that phrasing from the task text and add `--fast` to the `task` call. Never add `--fast` unless explicitly requested.
- If the forwarded request includes `--model`, normalize the shortcuts above to their full model ids and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. `max` needs a GPT-6, GPT-5.6, or Daybreak model (not `gpt-5.5`); `ultra` needs `gpt-6-astra`, `gpt-6-sol`, `gpt-5.6-sol`, `gpt-5.6-terra`, or `gpt-daybreak-blue-latest`. The Luna models stop at `max`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable Codex work in `codex:codex-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is, or of the last `result --wait` call once the job has ended.
- If the Bash call fails or Codex cannot be invoked, return the error output unchanged.
- If the companion prints a handback (job still running), run `result <job-id> --wait --timeout-ms 540000` in the foreground (Bash timeout 600000) and repeat until the job ends. Never use a background Bash task.
