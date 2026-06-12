#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILL_DIR="$ROOT/skills/pr-automation-loop"
WORKER_TEMPLATE="$ROOT/scripts/pr-automation-loop/worker-prompt-template.md"
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

[[ ! -e "$SKILL_DIR" ]] || fail "Program-driven automation must not install a discoverable skill at $SKILL_DIR"
[[ -f "$WORKER_TEMPLATE" ]] || fail "Missing worker prompt template: $WORKER_TEMPLATE"

contains "$WORKER_TEMPLATE" "Process exactly one trigger" "worker scope"
contains "$WORKER_TEMPLATE" "State handle" "state handle"
contains "$WORKER_TEMPLATE" "Start with Superpowers skill selection" "skill-chain startup"
contains "$WORKER_TEMPLATE" "Do not fix e2e tests" "worker e2e skip"
contains "$WORKER_TEMPLATE" "Use loop-state as the final persistence step" "worker persistence"
contains "$WORKER_TEMPLATE" "Do not use /goal" "worker goal boundary"
contains "$WORKER_TEMPLATE" "<PR_STATE>" "state block"
contains "$WORKER_TEMPLATE" "<TRIGGER>" "trigger block"

not_contains "$README" "pr-automation-loop" "README skill list"
not_contains "$WORKER_TEMPLATE" "Next Step:" "worker planner field"
not_contains "$WORKER_TEMPLATE" "Next Trigger:" "worker planner field"

pass "pr-automation-loop is program-driven and not exposed as a skill"
