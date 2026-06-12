---
name: pr-automation-loop
description: Use when open GitHub pull requests have Copilot comments or non-e2e check failures needing automated repair
---

# PR Automation Loop

## Overview

Use this skill inside a Codex Automation that coordinates PR feedback repair. The automation watches open PRs created by or assigned to the user, reconciles GitHub and Buildkite facts with local loop state, derives an in-memory worklist, and launches at most one normal Codex worker.

This skill is a coordinator workflow. It does not replace the Superpowers skill chain used by the worker. It also does not replace `loop-state`. The coordinator reads and reconciles durable state at wake-up and completion boundaries; the worker writes durable completion facts for its assigned trigger.

## Required Supporting Skill

Use `loop-state` when resuming or ending a PR loop. If `loop-state` is unavailable in the active Codex environment, stop and report that the automation cannot safely persist state.

## Scope

Watch open GitHub PRs matching either query. Run separate searches, then merge and deduplicate by repository and PR number:

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

## Coordinator Workflow

On every Codex Automation wake-up:

1. Identify the target project root and ensure `.superpowers/state/` and `.superpowers/runtime/` exist.
2. Use `loop-state` to read relevant entity state and loop summaries.
3. Check `.superpowers/runtime/active-worker.json`; if it exists, inspect the prior run before deciding whether a worker is still active.
4. Fetch current GitHub PR facts with separate `author:@me` and `assignee:@me` searches, then merge and deduplicate PRs.
5. Fetch current PR review comments, PR conversation comments, checks, and linked Buildkite failures.
6. Compare current external facts against loop-state cursors and loop summaries.
7. Build a derived worklist in memory.
8. If `active-worker.json` exists and the prior run is not complete, do not launch another worker.
9. If no worker is active and the derived worklist is non-empty, launch one worker for the highest-priority item.
10. Exit after launching one worker or after recording that no work was available.

The derived worklist is not a persistent queue. Rebuild it from GitHub, Buildkite, and loop-state on the next wake-up.

## Worklist Priority

Process items in this order:

1. New actionable Copilot inline review comments.
2. New actionable Copilot PR conversation comments.
3. New non-e2e build failures.

Treat a trigger as already handled when a loop summary, GitHub reply marker, resolved thread, passing current check, or stale PR head SHA proves it no longer requires work.

After considering repair candidates, record escalation observations immediately as factual loop summaries during reconciliation. They are not part of the derived worker worklist and must not launch workers.

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

Before launching a worker, acquire the lock atomically using exclusive file creation, a `mkdir` lock directory, or temp file plus hard-link/create-if-absent semantics. Do not use plain rename as the acquisition primitive because it can replace an existing lock. If acquisition fails, treat another worker as active and exit without launching.

Create the lock with:

```json
{
  "version": 1,
  "started_at": "2026-06-12T10:20:00-07:00",
  "repo": "owner/repo",
  "pr_number": 123,
  "trigger_id": "github-review-comment-98765",
  "worktree_path": "/path/to/repo/.worktrees/pr-123",
  "run_dir": ".superpowers/runtime/runs/2026-06-12T10-20-00-pr-123-comment-98765"
}
```

On wake-up, if the lock exists, inspect the prior run. Completion evidence is final output plus either a loop-state summary or GitHub reply marker. After reconciling completion through `loop-state`, remove `active-worker.json`. If the run is not complete, do not launch another worker.

The lock schema does not record worker liveness identity. Clear stale locks without completion evidence only when external source-of-truth facts prove the trigger is already handled. Never clear based on age alone or on generic process checks.

## Worker Launch

Launch the worker with `codex exec` from the PR worktree:

```bash
codex exec \
  -C "$PR_WORKTREE" \
  -a never \
  -s danger-full-access \
  --json \
  --output-last-message "$RUN_DIR/final.md" \
  - < "$RUN_DIR/worker-prompt.md" \
  > "$RUN_DIR/stdout.jsonl"
```

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

Do not use /goal for this first version. The coordinator scopes the worker to one trigger, and loop-state persists durable facts.

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
