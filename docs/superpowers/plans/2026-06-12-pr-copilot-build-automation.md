# PR Copilot and Build Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a program-driven PR automation loop that coordinates one Codex worker at a time for Copilot PR feedback and non-e2e build failures.

**Architecture:** The automation runtime is a zero-dependency Node program. It derives work from GitHub/Buildkite facts, owns the single-worker runtime lock, checks worker launch requirements before starting Codex, renders a prompt template from `scripts/pr-automation-loop/`, and launches one normal `codex exec` worker. It is not exposed as a Superpowers skill.

**Tech Stack:** Node.js ESM, GitHub CLI for live PR facts, shell fixture tests.

---

## File Structure

- `scripts/pr-automation-loop.mjs` - coordinator runtime invoked by Codex Automations.
- `scripts/pr-automation-loop/worker-prompt-template.md` - prompt template for exactly one selected trigger.
- `tests/pr-automation-loop/test-pr-automation-loop-program.sh` - fixture-driven program behavior tests.
- `tests/pr-automation-loop/test-pr-automation-loop-boundary.sh` - static boundary test proving this is not a discoverable skill.
- `docs/superpowers/specs/2026-06-12-pr-copilot-build-automation-design.md` - design record for the automation workflow.

## Tasks

### Task 1: Program Boundary

- [x] Create `scripts/pr-automation-loop.mjs` as the automation entrypoint.
- [x] Keep orchestration in the program: PR discovery, worklist derivation, active-worker locking, prompt rendering, and worker launch.
- [x] Do not create `skills/pr-automation-loop/SKILL.md`.
- [x] Keep the worker prompt template under `scripts/pr-automation-loop/`.
- [x] Remove `pr-automation-loop` from README skill lists.

### Task 2: Trigger Derivation

- [x] Watch open PRs authored by or assigned to the user.
- [x] Derive work items from unresolved Copilot review comments, Copilot PR comments, and failed non-e2e checks.
- [x] Ignore failures whose normalized name contains `e2e tests`.
- [x] Sort work by review comments, then PR comments, then build failures.

### Task 3: State Reconciliation

- [x] Read handled trigger markers from `$CODEX_HOME/superpowers/state-index/<repo-id>/loops/*.md`.
- [x] Read handled GitHub reply markers from PR/comment bodies.
- [x] Treat `pushed`, `skipped`, and `escalated` as handled outcomes.
- [x] Treat `failed` as a completed worker outcome for lock cleanup, but not as a handled trigger.
- [x] Keep the queue derived in memory instead of persisting it.

### Task 4: Single Worker Runtime

- [x] Use `$CODEX_HOME/superpowers/runtime/<repo-id>/active-worker.json` as the single-worker lock.
- [x] Preserve an active lock while the recorded worker PID is still alive.
- [x] Clear completed locks when the run directory has completion evidence.
- [x] Handle lock creation races as `worker_active`.

### Task 5: Requirements Preflight

- [x] Before discovery, check that `--project-root` exists and either fixture facts are present or `gh` is available.
- [x] Before launching a worker, check that the prompt template exists, the target worktree exists, and `codex` is available.
- [x] If requirements are missing, return `requirements_failed` with `missing_requirements`.
- [x] Do not write `active-worker.json` when requirements fail.

### Task 6: Auditability

- [x] Write append-only coordinator events to `$CODEX_HOME/superpowers/runtime/<repo-id>/audit.jsonl`.
- [x] Record wake, facts-loaded, worklist-derived, no-work, dry-run, active-worker, requirement-failure, launch, launch-failure, stale-lock-clear, and completed-worker-clear events.
- [x] Include trigger identity, PR/check metadata, counts, run artifact paths, and worker completion evidence.
- [x] Do not write full Copilot comment bodies into the audit log.
- [x] Support `--log-stdout` for mirroring audit events to stdout during interactive runs.

### Task 7: Verification

- [x] `node --check scripts/pr-automation-loop.mjs`
- [x] `tests/pr-automation-loop/test-pr-automation-loop-program.sh`
- [x] `tests/pr-automation-loop/test-pr-automation-loop-boundary.sh`
- [x] `git diff --check`
