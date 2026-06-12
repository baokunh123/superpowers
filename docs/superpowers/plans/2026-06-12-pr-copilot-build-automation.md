# PR Copilot and Build Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `pr-automation-loop` workflow skill that lets a Codex Automation coordinate one Superpowers worker at a time for Copilot PR feedback and non-e2e build failures.

**Architecture:** The first implementation is documentation-driven, matching the rest of Superpowers: one skill defines the coordinator workflow and one prompt template defines worker launch instructions. A static shell test verifies the single-worker rule, derived worklist rule, e2e skip rule, no `/goal` rule, Superpowers skill-chain execution, and `loop-state` persistence boundary.

**Tech Stack:** Markdown skills, Bash static tests, Codex CLI `codex exec`, GitHub and Buildkite accessed through the active Codex session tools or configured CLIs.

---

## File Structure

- Create `tests/pr-automation-loop/test-pr-automation-loop-skill.sh` - static validation for the new skill and worker prompt template.
- Create `skills/pr-automation-loop/worker-prompt-template.md` - reusable worker prompt template for exactly one PR trigger.
- Create `skills/pr-automation-loop/SKILL.md` - coordinator skill used by Codex Automations.
- Modify `README.md` - list the new skill in the collaboration section.

This plan does not add a runtime daemon, webhook listener, GitHub API client, Buildkite API client, or persistent queue. The Codex Automation run is the coordinator runtime. The worker is a normal `codex exec` session. `loop-state` remains a required supporting skill for durable facts, not the execution engine.

## Task 1: Add Failing Static Test

**Files:**
- Create: `tests/pr-automation-loop/test-pr-automation-loop-skill.sh`
- Test: `tests/pr-automation-loop/test-pr-automation-loop-skill.sh`

- [ ] **Step 1: Write the failing test**

Create `tests/pr-automation-loop/test-pr-automation-loop-skill.sh` with this exact content:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILL="$ROOT/skills/pr-automation-loop/SKILL.md"
WORKER_TEMPLATE="$ROOT/skills/pr-automation-loop/worker-prompt-template.md"
README="$ROOT/README.md"

fail() {
  echo "[FAIL] $1" >&2
  exit 1
}

pass() {
  echo "[PASS] $1"
}

contains() {
  local file="$1"
  local pattern="$2"
  local label="$3"

  if ! grep -Fq "$pattern" "$file"; then
    fail "$label missing '$pattern' in $file"
  fi
}

not_contains() {
  local file="$1"
  local pattern="$2"
  local label="$3"

  if grep -Fq "$pattern" "$file"; then
    fail "$label must not contain '$pattern' in $file"
  fi
}

[[ -f "$SKILL" ]] || fail "Missing skill: $SKILL"
[[ -f "$WORKER_TEMPLATE" ]] || fail "Missing worker prompt template: $WORKER_TEMPLATE"

contains "$SKILL" "name: pr-automation-loop" "frontmatter name"
contains "$SKILL" "description: Use when" "frontmatter description"
contains "$SKILL" "Codex Automation" "automation scope"
contains "$SKILL" "author:@me" "PR selection"
contains "$SKILL" "assignee:@me" "PR selection"
contains "$SKILL" "github-copilot[bot]" "Copilot trigger"
contains "$SKILL" "Buildkite" "build trigger"
contains "$SKILL" "e2e tests" "e2e skip rule"
contains "$SKILL" "single active worker" "single worker rule"
contains "$SKILL" "derived worklist" "derived worklist rule"
contains "$SKILL" "not a persistent queue" "queue boundary"
contains "$SKILL" ".superpowers/state/" "state storage"
contains "$SKILL" ".superpowers/runtime/active-worker.json" "runtime lock"
contains "$SKILL" "Superpowers skill chain" "worker execution model"
contains "$SKILL" "loop-state" "loop-state boundary"
contains "$SKILL" "codex exec" "worker launch"
contains "$SKILL" "worker-prompt-template.md" "template reference"
contains "$SKILL" "Do not use /goal" "goal boundary"

contains "$WORKER_TEMPLATE" "Process exactly one trigger" "worker scope"
contains "$WORKER_TEMPLATE" "State handle" "state handle"
contains "$WORKER_TEMPLATE" "Start with Superpowers skill selection" "skill-chain startup"
contains "$WORKER_TEMPLATE" "Do not fix e2e tests" "worker e2e skip"
contains "$WORKER_TEMPLATE" "Use loop-state as the final persistence step" "worker persistence"
contains "$WORKER_TEMPLATE" "Do not use /goal" "worker goal boundary"
contains "$WORKER_TEMPLATE" "<PR_STATE>" "state block"
contains "$WORKER_TEMPLATE" "<TRIGGER>" "trigger block"

contains "$README" "pr-automation-loop" "README skill list"

not_contains "$SKILL" "Next Step:" "planner field"
not_contains "$SKILL" "Next Trigger:" "planner field"
not_contains "$SKILL" "create a persistent queue" "persistent queue claim"
not_contains "$SKILL" "store a persistent queue" "persistent queue claim"
not_contains "$SKILL" "write a persistent queue" "persistent queue claim"
not_contains "$WORKER_TEMPLATE" "Next Step:" "worker planner field"
not_contains "$WORKER_TEMPLATE" "Next Trigger:" "worker planner field"

pass "pr-automation-loop skill structure is present"
```

- [ ] **Step 2: Make the test executable**

Run:

```bash
chmod +x tests/pr-automation-loop/test-pr-automation-loop-skill.sh
```

Expected: no output.

- [ ] **Step 3: Run the test to verify it fails**

Run:

```bash
tests/pr-automation-loop/test-pr-automation-loop-skill.sh
```

Expected: failure with:

```text
[FAIL] Missing skill:
```

Do not commit yet. The test should fail until the skill and worker prompt template exist.

## Task 2: Add Worker Prompt Template

**Files:**
- Create: `skills/pr-automation-loop/worker-prompt-template.md`
- Test: `tests/pr-automation-loop/test-pr-automation-loop-skill.sh`

- [ ] **Step 1: Create the skill directory**

Run:

```bash
mkdir -p skills/pr-automation-loop
```

Expected: no output.

- [ ] **Step 2: Write the worker prompt template**

Create `skills/pr-automation-loop/worker-prompt-template.md` with this exact content:

````markdown
# PR Automation Worker Prompt Template

You are working on PR {{repo}}#{{pr_number}}.

Process exactly one trigger and then stop.

Do not use /goal. The coordinator has already scoped this run to one trigger. Your immediate objective is the trigger below, and durable progress is recorded through loop-state at the end.

## State handle

- Entity ID: {{entity_id}}
- Entity file: {{entity_file}}
- Worktree ID: {{worktree_id}}
- Worktree path: {{worktree_path}}

Before changing code:

1. Read the entity state file.
2. Read the relevant loop summaries listed in `<PR_STATE>`.
3. Reconcile those facts with the current PR head SHA and trigger details.
4. If the trigger is already handled or stale, write an escalated or skipped loop summary and stop.

## Trigger

<TRIGGER>
{{trigger_json}}
</TRIGGER>

## PR State

<PR_STATE>
{{pr_state_summary}}
</PR_STATE>

## Rules

- Start with Superpowers skill selection and follow the applicable Superpowers skill chain for this task.
- Use the current PR worktree.
- Make the smallest change that resolves this trigger.
- Process exactly one trigger.
- Do not fix e2e tests or e2e build failures.
- Run the most targeted useful validation.
- Push to the PR branch only after validation passes.
- Reply to the original GitHub thread or PR conversation with a concise summary and validation evidence.
- Use loop-state as the final persistence step: write one loop summary and update entity/worktree facts.
- If blocked, do not guess. Mark the loop summary as `escalated` or `failed` with a concrete reason.

## Expected completion

When the task is complete, your final response must include:

```text
Outcome: pushed | skipped | escalated | failed
Trigger: <trigger id>
Commit: <commit sha or none>
Validation: <commands run and result>
State: <loop summary path and entity file path>
Reply: <GitHub reply URL or none>
```
````

- [ ] **Step 3: Run the test to verify the remaining failure**

Run:

```bash
tests/pr-automation-loop/test-pr-automation-loop-skill.sh
```

Expected: failure with:

```text
[FAIL] Missing skill:
```

The worker prompt exists now, but the skill and README entry do not.

## Task 3: Add Coordinator Skill

**Files:**
- Create: `skills/pr-automation-loop/SKILL.md`
- Test: `tests/pr-automation-loop/test-pr-automation-loop-skill.sh`

- [ ] **Step 1: Write the coordinator skill**

Create `skills/pr-automation-loop/SKILL.md` with this exact content:

````markdown
---
name: pr-automation-loop
description: Use when a Codex Automation should watch the user's open GitHub pull requests, derive work from Copilot comments and non-e2e build failures, and launch one Superpowers worker at a time
---

# PR Automation Loop

## Overview

Use this skill inside a Codex Automation that coordinates PR feedback repair. The automation watches open PRs created by or assigned to the user, reconciles GitHub and Buildkite facts with local loop state, derives an in-memory worklist, and launches at most one normal Codex worker.

This skill is a coordinator workflow. It does not replace the Superpowers skill chain used by the worker. It also does not replace `loop-state`; `loop-state` records durable facts at resume and completion boundaries.

## Required Supporting Skill

Use `loop-state` when resuming or ending a PR loop. If `loop-state` is unavailable in the active Codex environment, stop and report that the automation cannot safely persist state.

## Scope

Watch open GitHub PRs matching:

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
3. Check `.superpowers/runtime/active-worker.json`.
4. Fetch current GitHub PR facts for `author:@me` and `assignee:@me`.
5. Fetch current PR review comments, PR conversation comments, checks, and linked Buildkite failures.
6. Compare current external facts against loop-state cursors and loop summaries.
7. Build a derived worklist in memory.
8. If `active-worker.json` exists, do not launch another worker.
9. If no worker is active and the derived worklist is non-empty, launch one worker for the highest-priority item.
10. Exit after launching one worker or after recording that no work was available.

The derived worklist is not a persistent queue. Rebuild it from GitHub, Buildkite, and loop-state on the next wake-up.

## Worklist Priority

Process items in this order:

1. New actionable Copilot inline review comments.
2. New actionable Copilot PR conversation comments.
3. New non-e2e build failures.
4. Observations that require human escalation.

Treat a trigger as already handled when a loop summary, GitHub reply marker, resolved thread, passing current check, or stale PR head SHA proves it no longer requires work.

## E2E Skip Rule

Skip any Buildkite job whose normalized name contains:

```text
e2e tests
```

The known Buildkite form is:

```text
:playwright: e2e tests
```

If every current failure is an e2e failure, do not launch a worker.

## Single Active Worker

Maintain a single active worker globally using:

```text
.superpowers/runtime/active-worker.json
```

Before launching a worker, create the lock with:

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

If the lock exists, do not launch another worker. If the lock appears stale, reconcile with the source of truth before clearing it.

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

Record escalations as factual loop summaries. Do not write `Next Step:`, `Next Trigger:`, waiting instructions, or a persistent queue.
````

- [ ] **Step 2: Run the test to verify the README failure**

Run:

```bash
tests/pr-automation-loop/test-pr-automation-loop-skill.sh
```

Expected: failure with:

```text
[FAIL] README skill list missing 'pr-automation-loop'
```

## Task 4: Document the Skill in README

**Files:**
- Modify: `README.md`
- Test: `tests/pr-automation-loop/test-pr-automation-loop-skill.sh`

- [ ] **Step 1: Add the README bullet**

In `README.md`, in the `**Collaboration**` skill list, insert this bullet after `receiving-code-review`:

```markdown
- **pr-automation-loop** - Coordinate one worker at a time for Copilot PR comments and non-e2e build failures
```

The resulting `**Collaboration**` section should contain this exact sequence:

```markdown
**Collaboration**
- **brainstorming** - Socratic design refinement
- **writing-plans** - Detailed implementation plans
- **executing-plans** - Batch execution with checkpoints
- **dispatching-parallel-agents** - Concurrent subagent workflows
- **requesting-code-review** - Pre-review checklist
- **receiving-code-review** - Responding to feedback
- **pr-automation-loop** - Coordinate one worker at a time for Copilot PR comments and non-e2e build failures
- **using-git-worktrees** - Parallel development branches
- **finishing-a-development-branch** - Merge/PR decision workflow
- **subagent-driven-development** - Fast iteration with two-stage review (spec compliance, then code quality)
```

- [ ] **Step 2: Run the static test**

Run:

```bash
tests/pr-automation-loop/test-pr-automation-loop-skill.sh
```

Expected:

```text
[PASS] pr-automation-loop skill structure is present
```

- [ ] **Step 3: Run whitespace validation**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 4: Commit the implementation**

Run:

```bash
git add tests/pr-automation-loop/test-pr-automation-loop-skill.sh skills/pr-automation-loop/worker-prompt-template.md skills/pr-automation-loop/SKILL.md README.md
git commit -m "feat: add PR automation loop skill"
```

Expected: commit succeeds.

## Task 5: Validate Plugin Packaging Surface

**Files:**
- Read: `.codex-plugin/plugin.json`
- Read: `.claude-plugin/plugin.json`
- Read: `.cursor-plugin/plugin.json`
- Test: `tests/pr-automation-loop/test-pr-automation-loop-skill.sh`

- [ ] **Step 1: Confirm skill directory discovery**

Run:

```bash
sed -n '1,80p' .codex-plugin/plugin.json
sed -n '1,80p' .claude-plugin/plugin.json
sed -n '1,80p' .cursor-plugin/plugin.json
```

Expected: each plugin manifest points at `./skills/` or otherwise includes skills from the repository's `skills` directory.

- [ ] **Step 2: Run targeted test again**

Run:

```bash
tests/pr-automation-loop/test-pr-automation-loop-skill.sh
```

Expected:

```text
[PASS] pr-automation-loop skill structure is present
```

- [ ] **Step 3: Commit only if packaging metadata changed**

If Step 1 shows all manifests already discover `./skills/`, run:

```bash
git status --short
```

Expected: no files changed from this task.

If a manifest needs an explicit skill path update, edit the manifest to include `./skills/`, then run:

```bash
git add .codex-plugin/plugin.json .claude-plugin/plugin.json .cursor-plugin/plugin.json
git commit -m "chore: expose PR automation skill in plugin manifests"
```

Expected: commit succeeds only when a manifest changed.

## Task 6: Final Verification

**Files:**
- Test: `tests/pr-automation-loop/test-pr-automation-loop-skill.sh`
- Test: `README.md`
- Test: `skills/pr-automation-loop/SKILL.md`
- Test: `skills/pr-automation-loop/worker-prompt-template.md`

- [ ] **Step 1: Run the targeted test**

Run:

```bash
tests/pr-automation-loop/test-pr-automation-loop-skill.sh
```

Expected:

```text
[PASS] pr-automation-loop skill structure is present
```

- [ ] **Step 2: Confirm no forbidden planner fields were introduced**

Run:

```bash
rg -n "Next Step:|Next Trigger:" skills/pr-automation-loop README.md
```

Expected: no output.

- [ ] **Step 3: Confirm persistent queue language is only a negative boundary**

Run:

```bash
rg -n "create a persistent queue|store a persistent queue|write a persistent queue" skills/pr-automation-loop README.md
```

Expected: no output.

- [ ] **Step 4: Confirm the negative persistent queue boundary is present**

Run:

```bash
rg -n "not a persistent queue" skills/pr-automation-loop/SKILL.md
```

Expected output includes:

```text
skills/pr-automation-loop/SKILL.md
```

- [ ] **Step 5: Confirm worker is not scoped to loop-state only**

Run:

```bash
rg -n "Superpowers skill chain|Start with Superpowers skill selection|Use loop-state as the final persistence step" skills/pr-automation-loop
```

Expected output includes:

```text
skills/pr-automation-loop/SKILL.md
skills/pr-automation-loop/worker-prompt-template.md
```

- [ ] **Step 6: Run whitespace validation**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 7: Inspect final diff**

Run:

```bash
git status --short
git log --oneline -5
```

Expected: working tree is clean, and the recent commits include:

```text
feat: add PR automation loop skill
```

If packaging metadata changed in Task 5, the recent commits also include:

```text
chore: expose PR automation skill in plugin manifests
```
