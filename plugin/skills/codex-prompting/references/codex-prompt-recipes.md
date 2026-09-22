# Codex Prompt Recipes

Use these as starting templates for Codex task prompts or other Codex prompt construction (GPT-5.4 through the GPT-6 family).
Copy the smallest recipe that fits the task, then trim anything you do not need.
Every task handoff uses the four blocks from the skill. The recipes show `<goal>` and `<done_when>`; add `<rules>` and `<files>` for the task at hand.
Do not add an output contract to a task handoff. The companion appends the return format (Summary, Changed files, Checks run, Needs decision), so put what the answer must contain in `<done_when>`.
In `codex:codex-rescue`, run diagnosis and fix-oriented recipes in write mode by default unless the user explicitly asked for read-only behavior.

## Diagnosis

```xml
<goal>
Diagnose why the failing test or command is breaking in this repository.
Use the available repository context and tools to identify the most likely root cause.
</goal>

<done_when>
The answer names the most likely root cause, its evidence, and the smallest safe next step.
</done_when>

<default_follow_through_policy>
Keep going until you have enough evidence to identify the root cause confidently.
Only stop to ask questions when a missing detail changes correctness materially.
</default_follow_through_policy>

<verification_loop>
Before finalizing, verify that the proposed root cause matches the observed evidence.
</verification_loop>

<missing_context_gating>
Do not guess missing repository facts.
If required context is absent, state exactly what remains unknown.
</missing_context_gating>
```

## Narrow Fix

```xml
<goal>
Implement the smallest safe fix for the identified issue in this repository.
Preserve existing behavior outside the failing path.
</goal>

<done_when>
The fix is applied and verified. The answer names residual risks or follow-ups.
</done_when>

<default_follow_through_policy>
Default to the most reasonable low-risk interpretation and keep going.
</default_follow_through_policy>

<completeness_contract>
Resolve the task fully before stopping.
Do not stop after identifying the issue without applying the fix.
</completeness_contract>

<verification_loop>
Before finalizing, verify that the fix matches the task requirements and that the changed code is coherent.
</verification_loop>

<action_safety>
Keep changes tightly scoped to the stated task.
Avoid unrelated refactors or cleanup.
</action_safety>
```

## Root-Cause Review

```xml
<goal>
Analyze this change for the most likely correctness or regression issues.
Focus on the provided repository context only.
</goal>

<done_when>
The answer lists findings ordered by severity, with supporting evidence for each and brief next steps.
</done_when>

<grounding_rules>
Ground every claim in the repository context or tool outputs.
If a point is an inference, label it clearly.
</grounding_rules>

<dig_deeper_nudge>
Check for second-order failures, empty-state handling, retries, stale state, and rollback paths before finalizing.
</dig_deeper_nudge>

<verification_loop>
Before finalizing, verify that each finding is material and actionable.
</verification_loop>
```

## Research Or Recommendation

```xml
<goal>
Research the available options and recommend the best path for this task.
</goal>

<done_when>
The answer gives observed facts, a reasoned recommendation, tradeoffs, and open questions.
</done_when>

<research_mode>
Separate observed facts, reasoned inferences, and open questions.
Prefer breadth first, then go deeper only where the evidence changes the recommendation.
</research_mode>

<citation_rules>
Back important claims with explicit references to the sources you inspected.
Prefer primary sources.
</citation_rules>
```

## Prompt-Patching

```xml
<goal>
Diagnose why this existing prompt is underperforming and propose the smallest high-leverage changes to improve it for Codex (GPT-5.4 through the GPT-6 family).
</goal>

<done_when>
The answer gives the failure modes, their root causes in the current prompt, a revised prompt, and why the revision should work better.
</done_when>

<grounding_rules>
Base your diagnosis on the prompt text and the failure examples provided.
Do not invent failure modes that are not supported by the examples.
</grounding_rules>

<verification_loop>
Before finalizing, make sure the revised prompt resolves the cited failure modes without adding contradictory instructions.
</verification_loop>
```
