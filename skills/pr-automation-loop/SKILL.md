---
name: pr-automation-loop
description: Use when open GitHub pull requests have Copilot comments or non-e2e check failures needing automated repair
---

# PR Automation Loop

## Overview

Use this skill as the policy reference for the program-driven Codex Automation in `scripts/pr-automation-loop.mjs`.

The automation runtime is the program, not this skill. The program watches open PRs, derives the current worklist, maintains the single active worker lock, renders `worker-prompt-template.md`, and launches one normal Codex worker with `codex exec`. This skill defines the constraints the program and worker must obey.

The worker still uses the normal Superpowers skill chain for the assigned task. `loop-state` records durable facts at resume and completion boundaries; it is not the coordinator or worker execution engine.

## Runtime Boundary

Program responsibilities:

- run from a scheduled Codex Automation
- fetch GitHub and Buildkite facts
- derive the in-memory worklist
- maintain `.superpowers/runtime/active-worker.json`
- render `skills/pr-automation-loop/worker-prompt-template.md`
- launch exactly one worker with `codex exec`

Skill responsibilities:

- define the policy for selecting work
- define what must be skipped or escalated
- define how the worker should use Superpowers and `loop-state`
- prevent queue/planner-state drift

Do not implement polling, locking, or worker launch as manual skill steps. Those are runtime program concerns.

## Scope

The program watches open GitHub PRs matching either query. It must run separate searches, then merge and deduplicate by repository and PR number:

```text
author:@me
assignee:@me
```

Trigger sources:

1. Inline review comments from `github-copilot[bot]`.
2. PR conversation comments from `github-copilot[bot]`.
3. GitHub check failures with Buildkite detail when available.

Do not handle closed PRs. Do not auto-fix draft PRs unless the automation prompt explicitly enables draft PRs.

## State and Runtime Layout

Durable facts live in project-local loop state:

```text
.superpowers/state/
  index.json
  entities/
  loops/
  worktrees/
```

Runtime coordination lives separately:

```text
.superpowers/runtime/
  active-worker.json
  runs/
```

Runtime files are locks and logs. They are not durable loop state and not a persistent queue.

## Worklist Policy

The program builds a derived worklist in memory on every wake-up. The derived worklist is not a persistent queue. Rebuild it from GitHub, Buildkite, and loop-state on the next wake-up.

Process items in this order:

1. New actionable Copilot inline review comments.
2. New actionable Copilot PR conversation comments.
3. New non-e2e build failures.

For worklist derivation, treat a trigger as already handled when a loop summary, GitHub reply marker, resolved thread, passing current check, or stale PR head SHA proves it no longer requires work. This does not prove an active worker has exited.

After considering repair candidates, record escalation observations immediately as factual loop summaries during reconciliation. They are not part of the derived worklist and must not launch workers.

## E2E Skip Rule

Skip any normalized failure, check, or job name containing:

```text
e2e tests
```

The known Buildkite form is:

```text
:playwright: e2e tests
```

If every current failure or check is an e2e failure, do not launch a worker.

## Single Active Worker

Maintain a single active worker globally using:

```text
.superpowers/runtime/active-worker.json
```

The program must acquire that runtime lock with create-if-absent semantics before launching a worker. It may update the acquired lock with the worker process identity after spawn because the lock path already blocks competing coordinators.

If `active-worker.json` exists and completion evidence is absent, do not launch another worker. Do not clear the lock merely because the trigger is stale or no longer needs work. Without completion evidence, clear a stale lock only when the recorded worker liveness identity proves the worker is no longer running and external source-of-truth facts prove the trigger is already handled. If liveness identity is missing or cannot be verified, keep the lock and escalate for human reconciliation.

## Worker Launch Policy

Build `$RUN_DIR/worker-prompt.md` from `skills/pr-automation-loop/worker-prompt-template.md`.

Required worker template inputs:

- repo
- PR number
- entity_id
- entity_file
- worktree_id
- worktree_path
- trigger_json
- pr_state_summary

The worker must:

1. Start with Superpowers skill selection.
2. Follow the applicable Superpowers skill chain.
3. Complete exactly one assigned trigger.
4. Push only after targeted validation passes.
5. Reply to GitHub.
6. Use `loop-state` to write the loop summary and update entity/worktree facts.

Do not use /goal for this first version. The program scopes the worker to one trigger, and loop-state persists durable facts.

## GitHub Reply Marker

Worker replies should include a hidden marker:

```markdown
<!-- codex-loop trigger=github-review-comment-98765 sha=def456 outcome=pushed -->
```

Use the marker only for deduplication. The human-visible reply must still summarize the fix and validation.

## Escalation

Do not launch or continue automatic repair when:

- the trigger requires product, design, or architectural judgment
- the PR head SHA changed and safe reconciliation is unclear
- required secrets or external services are unavailable
- Buildkite logs do not identify a plausible cause
- targeted validation cannot be run
- the same trigger has already failed twice
- the trigger is an e2e test failure
- the required change would expand beyond the trigger's scope

Record escalations as factual loop summaries. Do not include planner-style next-action fields, waiting instructions, or a persistent queue.
