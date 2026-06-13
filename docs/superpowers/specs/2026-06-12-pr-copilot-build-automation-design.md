# PR Copilot and Build Automation Design

## Overview

Design a program-driven Codex automation loop that watches open pull requests created by or assigned to the user, then responds to Copilot review feedback and non-e2e build failures with one normal Codex worker at a time.

The automation runtime is a coordinator program, not a skill and not the repair worker itself. On each wake-up the program reconciles GitHub, Buildkite, and local loop state; derives the current worklist; verifies launch requirements; and starts exactly one Codex worker only when no worker is already active. The worker prompt template is a program resource under `scripts/pr-automation-loop/`, not a discoverable skill.

The core model is:

```text
program wake-up -> loop-state facts + current GitHub/Buildkite state -> reconcile -> derived worklist -> one worker
```

## Goals

1. Watch open PRs authored by or assigned to the user.
2. Detect actionable Copilot inline review comments, Copilot PR conversation comments, and build failures.
3. Ignore e2e test failures.
4. Start only one worker globally at any time.
5. Run the worker as a normal Codex session in the PR worktree.
6. Have the worker execute the normal Superpowers skill chain needed to complete the assigned task.
7. Persist facts with the `loop-state` model, not with a persistent task queue.
8. Let later runs resume by reconciling saved facts with the external source of truth.
9. Keep polling, worklist derivation, runtime locking, prompt rendering, and worker launch in a real program.

## Non-Goals

1. Do not build a GitHub webhook listener in the first version.
2. Do not run multiple workers in parallel, even across different PRs.
3. Do not persist a queue in loop state.
4. Do not attempt to fix e2e tests or e2e build jobs.
5. Do not make local state the source of truth for GitHub or Buildkite.
6. Do not rely on Codex Memories as the only state layer.
7. Do not make a skill responsible for runtime coordination.

## Architecture

### Coordinator Program

The coordinator is a scheduled program invoked by Codex Automations, for example:

```bash
node scripts/pr-automation-loop.mjs --project-root "$PROJECT_ROOT" --repo-id mortgage --repo owner/repo
```

For interactive observation, add `--log-stdout` to mirror audit events to stdout while the script runs:

```bash
node scripts/pr-automation-loop.mjs --project-root "$PROJECT_ROOT" --repo-id mortgage --repo owner/repo --json --log-stdout
```

It wakes on a fixed cadence, such as every 10 minutes. The program owns polling, reconciliation, single-worker locking, prompt rendering, and worker launch. Skills guide behavior after they are loaded; they do not provide the automation runtime.

Each wake-up:

1. Reads loop state under `$CODEX_HOME/superpowers/state-index/<repo-id>/`.
2. Checks whether `$CODEX_HOME/superpowers/runtime/<repo-id>/active-worker.json` exists.
3. Fetches current GitHub PR state for PRs authored by or assigned to the user.
4. Fetches PR review comments, PR conversation comments, check runs, and linked Buildkite build/job data.
5. Reconciles current external state against saved entity cursors and loop summaries.
6. Derives an in-memory worklist.
7. Checks worker launch requirements, including the prompt template, target worktree path, and Codex CLI availability.
8. If no worker is active and requirements pass, launches one worker for the highest-priority work item.
9. If a worker is active, records compact observations only when useful and exits without launching another worker.

The coordinator does not directly edit application code. It only starts the worker process for one selected trigger.

The first implementation is zero-dependency and testable with fixture JSON. Live GitHub facts are fetched through the configured GitHub CLI when fixtures are not supplied; Buildkite detail is represented from linked check metadata in this version.

### Worker

The worker is a normal Codex run launched for one item from the derived worklist.

The worker:

1. Uses the PR worktree as its working directory.
2. Receives the PR state handle, relevant loop summaries, the exact trigger, and automation rules in its prompt.
3. Starts with the Superpowers bootstrap and follows the applicable skill chain for the assigned task.
4. Processes exactly one trigger through completion.
5. Makes the smallest code change that resolves the trigger.
6. Runs targeted validation.
7. Pushes to the PR branch when validation passes.
8. Replies to the relevant GitHub comment thread or PR conversation.
9. Uses `loop-state` at the end to write a loop summary and update entity/worktree facts.

Subagents are not part of the first version. The worker may still use normal Superpowers skills and tools available in its Codex session. The automation enforces a single active worker globally; it does not constrain the worker to only the `loop-state` skill.

`loop-state` is not the coordinator or worker execution engine. It is used to resume from durable facts before work begins and to persist durable facts when the worker ends. The worker itself is responsible for completing the assigned repair or escalation task.

## Trigger Sources

### PR Selection

The coordinator watches open PRs that match either condition:

```text
author:@me
assignee:@me
```

It skips closed PRs and PRs where the worker cannot push to the source branch. Draft PRs may be observed, but should not be auto-fixed unless explicitly enabled later.

### Copilot Inline Review Comments

Inline review comments from `github-copilot[bot]` are first priority because they usually include file and line context.

The derived work item includes:

- repository
- PR number
- PR head SHA
- review comment ID
- file path and line, when available
- comment body
- thread URL

### Copilot PR Conversation Comments

Top-level PR comments from `github-copilot[bot]` are second priority.

The coordinator only queues them when they appear actionable. Comments that require product judgment, architectural tradeoffs, or human preference are escalated instead of fixed automatically.

### Build Failures

Build failures are third priority. The coordinator uses GitHub Checks as an entry point and Buildkite as the detailed log source when a check links to a Buildkite build.

The derived work item includes:

- check run ID or status context
- Buildkite org, pipeline, build number, and job ID when available
- job name
- tail log excerpt or failure summary
- PR head SHA

Buildkite job state `broken` is treated as downstream of earlier failure unless the broken job is the only concrete failing signal.

## E2E Skip Rule

Observed Buildkite e2e job name:

```text
:playwright: e2e tests
```

The first version skips any failed check, failure, or Buildkite job whose normalized name contains:

```text
e2e tests
```

Normalization lowercases the name and trims surrounding whitespace. The emoji-style prefix does not matter because the substring `e2e tests` remains present.

If all current failures for a PR are e2e failures, the coordinator does not start a worker.

## Runtime Locking

The coordinator program maintains one global active worker lock at:

```text
$CODEX_HOME/superpowers/runtime/<repo-id>/active-worker.json
```

The program must acquire this lock with create-if-absent semantics before launching a worker. The lock may be updated with worker process identity after spawn because the path has already been acquired and blocks competing coordinators. If spawn fails, the program removes the lock before exiting.

The lock is not durable loop state and is not a queue. If the lock exists and there is no completion evidence, the coordinator must not clear it merely because a trigger appears stale. It can clear the lock only when it can prove the recorded worker is no longer running and external source-of-truth facts prove the trigger has been handled. Otherwise it exits without launching another worker and records/escalates the reconciliation problem.

## State Model

State follows the `loop-state` skill's discipline: state is facts, not plans.

State is not:

- a persistent queue
- chat history
- instructions to a future worker
- a replacement for GitHub or Buildkite

### Storage

State lives under the Codex home directory so automation does not dirty the target repository's git status:

```text
$CODEX_HOME/superpowers/state-index/<repo-id>/
  index.json
  entities/
    github-owner-repo-pr-123.json
  loops/
    2026-06-12-pr-123-copilot-comment-98765.md
  worktrees/
    wt-2026-06-12-pr-123-feature-foo.json
```

The state root is machine-local durable state. For `/Users/bhuang/workspace/mortgage`, use a stable repo id such as `mortgage` and write to `/Users/bhuang/.codex/superpowers/state-index/mortgage/`.

Runtime coordination uses a separate directory:

```text
$CODEX_HOME/superpowers/runtime/<repo-id>/
  active-worker.json
  audit.jsonl
  runs/
    2026-06-12T10-20-00-pr-123-comment-98765/
      worker-prompt.md
      final.md
      stdout.jsonl
      stderr.log
```

Runtime files are operational locks and logs, not durable loop state. `audit.jsonl` is the append-only coordinator audit stream for what woke the script, what it derived, whether it launched a worker, and what result evidence it reconciled later.

### State Handle

The state handle for a PR is the entity ID plus its local entity file:

```text
Entity ID: github:owner/repo:pull/123
State root: /Users/bhuang/.codex/superpowers/state-index/mortgage
Entity file: /Users/bhuang/.codex/superpowers/state-index/mortgage/entities/github-owner-repo-pr-123.json
```

Worker prompts should identify this handle explicitly so the worker can reconcile prior facts before work begins and persist updated facts after the task is complete.

### Entity State

The PR entity stores compact external cursors and worktree links:

```json
{
  "version": 1,
  "entity_id": "github:owner/repo:pull/123",
  "kind": "github_pull_request",
  "repo": "owner/repo",
  "pr_number": 123,
  "pr_url": "https://github.com/owner/repo/pull/123",
  "branch": "feature/foo",
  "base": "main",
  "active_worktree_id": "wt-2026-06-12-pr-123-feature-foo",
  "associated_worktrees": [
    "wt-2026-06-12-pr-123-feature-foo"
  ],
  "associated_loops": [
    "2026-06-12-pr-123-copilot-comment-98765"
  ],
  "last_observed": {
    "observed_at": "2026-06-12T10:20:00-07:00",
    "state": "open",
    "head_sha": "def456",
    "timeline_cursor": "comment-or-event-cursor",
    "check_run_id": "check-run-789"
  }
}
```

The entity state records what was last observed. It does not say what should happen next.

### Loop Summary

Each worker writes one loop summary when it ends.

The summary records:

- trigger type and external ID
- PR head SHA at start
- worktree path and final commit
- work completed
- verification commands and results
- GitHub reply posted
- outcome: `pushed`, `skipped`, `escalated`, or `failed`
- external observations at completion

The purpose is to let the next coordinator run reconcile facts without reading chat history or trusting a stale queue.

## Runtime Lock

The single-worker invariant is enforced by:

```text
$CODEX_HOME/superpowers/runtime/<repo-id>/active-worker.json
```

Example:

```json
{
  "version": 1,
  "started_at": "2026-06-12T10:20:00-07:00",
  "repo": "owner/repo",
  "repo_id": "mortgage",
  "pr_number": 123,
  "trigger_id": "github-review-comment-98765",
  "worktree_path": "/path/to/repo/.worktrees/pr-123",
  "run_dir": "/Users/bhuang/.codex/superpowers/runtime/mortgage/runs/2026-06-12T10-20-00-pr-123-comment-98765"
}
```

If the lock exists, the coordinator does not start another worker. If the lock appears stale, the coordinator checks external state and local process/run evidence before clearing it.

## Audit Log

The coordinator writes append-only JSON Lines to:

```text
$CODEX_HOME/superpowers/runtime/<repo-id>/audit.jsonl
```

Each event includes:

- `timestamp`, `event`, `repo_id`, `project_root`, `state_root`, and `runtime_root`
- selected trigger metadata: trigger ID, PR, repo, URL, check name, and Buildkite details URL when present
- counts for loaded PRs, derived work items, handled triggers, and skipped e2e failures
- requirement failures before discovery or worker launch
- active-worker, lock-race, launch, launch-failure, stale-lock-clear, and completed-worker-clear events

The audit log intentionally records trigger identity and run artifacts, not full Copilot comment bodies or full worker output. Worker stdout, stderr, prompt, and final summary stay in the per-run directory referenced by the audit event. Durable facts still live under `state-index` and are written by `loop-state`.

By default, stdout is reserved for the final script result. With `--log-stdout`, each audit event is also written to stdout as one JSON line; when combined with `--json`, the final result is also a single JSON line after the audit events.

## Derived Worklist

The worklist is built in memory on every wake-up.

Priority order:

1. New actionable Copilot inline review comments.
2. New actionable Copilot PR conversation comments.
3. New non-e2e build failures.
4. Observations that need human escalation.

The coordinator considers an item already handled when one or more of these facts are true:

- a loop summary records the same trigger ID and PR head SHA
- a GitHub reply contains the automation marker for the trigger
- the comment thread has been resolved or the comment no longer applies
- the failing check/job is no longer failing for the current PR head SHA
- the trigger was skipped because it was an e2e test job

Because the queue is derived, stale local work items disappear naturally when GitHub or Buildkite changes.

## Worker Launch

The coordinator starts the worker with `codex exec`.

Representative command:

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

The worker prompt includes:

```text
You are working on PR owner/repo#123.

State handle:
- Repo ID: mortgage
- State root: /Users/bhuang/.codex/superpowers/state-index/mortgage
- Entity ID: github:owner/repo:pull/123
- Entity file: /Users/bhuang/.codex/superpowers/state-index/mortgage/entities/github-owner-repo-pr-123.json

Process exactly one trigger:
- Trigger ID: github-review-comment-98765
- Trigger type: Copilot inline review comment
- PR head SHA: def456

Rules:
- Start with Superpowers skill selection and follow the applicable skill chain for this task.
- Use the current PR worktree.
- Make the smallest change that resolves this trigger.
- Do not fix e2e tests or e2e build failures.
- Run targeted validation.
- Push to the PR branch only after validation passes.
- Reply to the original GitHub thread with summary and validation.
- Use loop-state as the final persistence step: write one loop summary and update entity/worktree facts.
- If blocked, do not guess; mark the loop summary as escalated or failed with a concrete reason.
```

The worker may push only if the PR head SHA still matches the trigger's recorded SHA or after explicitly reconciling a safe fast-forward update.

The worker launch does not use `/goal` in the first version. The prompt's scoped trigger is the worker's immediate objective, Superpowers skill selection drives execution, and `loop-state` records the completed loop.

## GitHub Replies and Markers

Replies should be human-readable and include a hidden marker for deduplication.

Example:

```markdown
Fixed in `<commit>`.

Validation:
- `pytest path/to/test.py` passed

<!-- codex-loop trigger=github-review-comment-98765 sha=def456 outcome=pushed -->
```

Inline review comments should be answered in their review thread. PR conversation comments should receive a direct reply when the GitHub API supports it; otherwise, the worker posts a top-level PR comment that references the original comment.

Build failure replies go to the PR conversation and include the failed check/job link.

## Failure and Escalation

The worker must stop and record an escalated or failed loop summary when:

- the PR head SHA changed during the run and safe reconciliation is unclear
- the trigger needs product, design, or architectural judgment
- the fix requires secrets or unavailable external services
- the build log does not identify a plausible cause
- targeted validation cannot be run meaningfully
- the same trigger has already failed twice
- the trigger is an e2e test failure
- the required change would expand beyond the trigger's scope

Escalation should leave enough facts for a human to decide what to do, without storing a future plan in loop state.

## Validation Strategy

For Copilot comments, the worker chooses the narrowest relevant validation:

- unit test for the changed code
- lint or typecheck for touched files
- focused package test when the comment is structural

For build failures, the worker first uses the failed job name and log tail to identify a local command. If no targeted command is clear, it records an escalation instead of guessing.

The worker never runs e2e validation as part of this loop.

## Security and Permissions

This automation can push code, reply on GitHub, and read Buildkite logs. It should be treated as high trust.

Controls:

- single worker globally
- PR worktree isolation
- targeted prompt with one trigger
- Superpowers skill chain execution inside the worker
- no persistent queue
- hidden markers for deduplication
- loop summaries for auditability
- repeated-failure escalation
- e2e skip rule

If a managed environment disallows unattended full access, the coordinator should run in a more restrictive sandbox and require human approval before launching a push-capable worker.

## Acceptance Criteria

1. A wake-up with no new Copilot comments and no non-e2e build failures starts no worker.
2. A wake-up with multiple actionable comments derives multiple worklist items but starts only one worker.
3. A wake-up while `active-worker.json` exists starts no worker.
4. A Buildkite job named `:playwright: e2e tests` is skipped.
5. A worker processing a Copilot inline comment replies to the review thread and writes a loop summary.
6. A worker processing a non-e2e build failure pushes only after targeted validation.
7. A later wake-up can derive remaining work from GitHub/Buildkite and loop-state facts without reading a persistent queue.
