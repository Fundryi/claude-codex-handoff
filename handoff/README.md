# Handoff contracts (copy this folder into your repo)

Per-task-type contracts for Codex handoffs. When a handoff prompt names one of these files, that file is binding for the run. The prompt then only needs to carry the task itself: scope, done-criteria, and any task-specific decisions.

## Why

Rules you improvise per prompt get forgotten, and quality varies with your mood. A contract file is written once, referenced with one line, and improves every time a review catches a new failure mode.

## Usage

1. Copy this folder into your repo (keep the name `handoff/` or adjust the references).
2. Fill in the `ADAPT:` markers in each file with your stack's commands and rules.
3. Open every handoff prompt with one line:

```
Follow handoff/coding.md (binding). Task: <what to do, which files may change, when it's done>
```

If you use the claude-codex-handoff plugin, Claude picks these files up automatically when composing `/codex:rescue` prompts for a repo that has them.

## Files

| File | Use for |
|---|---|
| `coding.md` | Implementation, bugfix, refactor handoffs |
| `review.md` | Code review, diagnosis, root-cause investigation (read-only) |
| `browser-testing.md` | Browser or live verification runs |

## Maintenance

Contracts hold boundaries, gates, and return formats. Project rules live in their canonical homes (CLAUDE.md, your coding guidelines, docs); contracts point at them instead of copying them. When a review catches a new failure mode: add the rule to its canonical home, add one self-check line to the matching contract, done. The self-check gate is the part that compounds.
