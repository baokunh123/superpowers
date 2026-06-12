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
