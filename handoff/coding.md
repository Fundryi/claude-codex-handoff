# Handoff contract: coding

Binding when the handoff prompt names this file. The prompt supplies the task, scope, and done-criteria; this file supplies everything else.

## 1. Before writing any code (in order)

1. Read the repo's `AGENTS.md` / `CLAUDE.md` and anything they tell you to read. Not optional.
2. ADAPT: list your canonical rule docs here (coding guidelines, gotcha list, architecture doc) and when each applies.
3. If the prompt names an issue or ticket, read it first. A closed issue means STOP and report. Verify every claimed finding against current source; findings that are already fixed or not real get SKIPPED with reasoning, never "fixed" blind.

## 2. Hard boundaries

- The prompt's scope limits WRITES only. Read anything in the repo you need to trace the real flow.
- The named files are the expected footprint, not a cage: if root-cause tracing proves the fix belongs in a file the prompt did not name, fix it at the root, and declare the expansion in your manifest (which file, why the root cause lives there, the evidence chain). Never expand into unrelated components or shared/global config.
- Unrelated improvements and refactors stay report-only, even inside the named files.
- NEVER commit, NEVER push, NEVER bump versions. The orchestrator owns review and release.
- No new dependencies unless the prompt allows them.
- ADAPT: add absolute don'ts for your project (generated files never edited by hand, commands never run, compatibility baselines to respect).
- If your sandbox blocks runtime testing, do static verification and say exactly what you could not run, instead of skipping the mention.

## 3. Self-check gate (run ALL before returning)

| Check | Command / rule |
|---|---|
| Syntax / compile | ADAPT: your linter or compiler over every touched file |
| Tests | ADAPT: your test command; state which tests cover the change |
| Config validity | Parse every touched config file (JSON/YAML/TOML) |
| Known failure modes | ADAPT: greps for your project's repeat bugs. Every bug class a review has caught belongs here as a permanent check |
| Minimalism | Re-read the diff: nothing re-implements an existing helper, no unrequested abstraction, the fix sits at the shared root cause rather than one caller |
| Diff hygiene | `git diff --check` clean; every file outside the named scope is a declared EXPANDED root-cause fix, nothing else |

## 4. Return format (all six, every time)

1. Step-0 verification result (issue state, per-finding validity).
2. Per-finding FIXED / SKIPPED-with-reason list.
3. Unified diff.
4. Per-file manifest: one line per file, what changed and why. Files outside the named scope are marked EXPANDED with the root-cause justification.
5. Self-check gate results, including how each hit was resolved.
6. Out-of-scope observations (report-only), or "none".
