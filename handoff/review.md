# Handoff contract: review / diagnosis

Binding when the handoff prompt names this file. Read-only: no edits, no fixes, no commits, findings only. The prompt may explicitly widen this; then `coding.md` rules apply to the widened part.

## Before reviewing

Same reading order as `coding.md` section 1. If your project keeps a gotcha list, it doubles as the review checklist: each entry is a known failure mode worth actively hunting.

## Finding quality bar

Every finding must have:

- A `file:line` anchor.
- A one-sentence defect statement.
- A concrete failure scenario: specific input or state, then the wrong output or crash. "Could be a problem" without a scenario is not a finding.
- A verdict: **CONFIRMED** (you traced the actual path end to end) or **PLAUSIBLE** (suspected, not fully traced). Never present PLAUSIBLE as fact.

Skip style nits unless they change behavior. Rank most-severe first.

Over-engineering is a valid finding: code that re-implements an existing helper, adds an unrequested abstraction, patches a symptom instead of the shared root cause, or pulls in a dependency for a few-line job gets reported like any other defect, with the simpler alternative named.

ADAPT: add greps for your project's repeat failure modes that tooling cannot catch.

## Return format

1. Ranked findings (format above), or "no findings".
2. Coverage statement: what you checked and found sound, so the orchestrator knows what the review actually covered.
3. For diagnosis tasks: the root cause with its evidence chain, not just the symptom location.
