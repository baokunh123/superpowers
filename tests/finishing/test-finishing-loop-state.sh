#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILL="$ROOT/skills/finishing-a-development-branch/SKILL.md"

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
    fail "$label missing '$pattern'"
  fi
}

[[ -f "$SKILL" ]] || fail "Missing skill: $SKILL"

contains "$SKILL" "### Step 7: Persist Finish State" "finish-state step"
contains "$SKILL" "**REQUIRED SUB-SKILL:** Use superpowers:loop-state" "loop-state handoff"
contains "$SKILL" "Do not write state files directly." "direct state write prohibition"
contains "$SKILL" "Capture these facts before cleanup" "pre-cleanup capture"
contains "$SKILL" "repo_root" "repo root fact"
contains "$SKILL" "worktree_path" "worktree path fact"
contains "$SKILL" "branch" "branch fact"
contains "$SKILL" "head_sha" "head sha fact"
contains "$SKILL" "validation commands/results" "validation fact"
contains "$SKILL" "worktree_status" "worktree status fact"
contains "$SKILL" "state_root" "state root fact"
contains "$SKILL" "~/.codex/superpowers/state-index/<repo-id>/" "global state root"
contains "$SKILL" "Persist finish state with loop-state" "quick reference"

pass "finishing-a-development-branch triggers loop-state at terminal outcomes"
