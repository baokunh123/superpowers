# Skill Chain Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a formal skill-chain JSON contract to all Superpowers skills while preserving the existing Superpowers scheduling model.

**Architecture:** Create one canonical model document at `docs/superpowers/skill-chain-model.md` containing the JSON Schema, state map, artifact kinds, gate names, and examples. Add a short `Chain Contract` section to every `skills/*/SKILL.md` that points to the canonical model and declares the skill's artifact and gate. Add a static shell test that fails before the model/contracts exist and passes after all contracts are present.

**Tech Stack:** Markdown skill documentation, JSON Schema embedded in Markdown, Bash static tests, Ruby JSON parsing for local validation.

---

## File Structure

- Create `docs/superpowers/skill-chain-model.md` — canonical source of truth for `SkillResult`, `GateDecision`, artifact kinds, evidence, states, gates, routing semantics, and examples.
- Create `tests/skill-chain/test-skill-chain-contracts.sh` — static contract test for the canonical model and all skill files.
- Modify all 14 `skills/*/SKILL.md` files — add a concise `## Chain Contract` section near the top after the overview or initial mandatory-use section.

The contract remains centralized. Individual skills only declare their local contract and link to the model doc.

## Contract Mapping

| Skill | State | Artifact Kind | Gate |
|---|---|---|---|
| `using-superpowers` | `NeedsSkillSelection` | `SkillSelectionResult` | `SkillSelectionGate` |
| `brainstorming` | `NeedsDesign` | `DesignSpec` | `SpecReadinessGate` |
| `writing-plans` | `NeedsPlan` | `ImplementationPlan` | `PlanReadinessGate` |
| `using-git-worktrees` | `NeedsWorkspace` | `WorkspaceReadiness` | `WorkspaceReadinessGate` |
| `subagent-driven-development` | `NeedsImplementation` | `ImplementationResult` | `ImplementationQualityGate` |
| `executing-plans` | `NeedsImplementation` | `ImplementationResult` | `ImplementationQualityGate` |
| `test-driven-development` | `NeedsTDDCycle` | `TDDCycleResult` | `TDDCompletionGate` |
| `systematic-debugging` | `NeedsDebugging` | `RootCauseAnalysis` | `RootCauseGate` |
| `verification-before-completion` | `NeedsVerification` | `VerificationResult` | `VerificationGate` |
| `requesting-code-review` | `NeedsCodeReview` | `CodeReviewResult` | `CodeReviewGate` |
| `receiving-code-review` | `NeedsReviewResponse` | `ReviewResponseResult` | `ReviewResponseGate` |
| `dispatching-parallel-agents` | `NeedsParallelInvestigation` | `ParallelDispatchResult` | `ParallelIntegrationGate` |
| `finishing-a-development-branch` | `NeedsFinishing` | `CompletionResult` | `CompletionGate` |
| `writing-skills` | `NeedsSkillAuthoring` | `SkillAuthoringResult` | `SkillDeploymentGate` |

### Task 1: Add Failing Static Contract Test

**Files:**
- Create: `tests/skill-chain/test-skill-chain-contracts.sh`

- [ ] **Step 1: Write the failing test**

Create `tests/skill-chain/test-skill-chain-contracts.sh` with this content:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODEL="$ROOT/docs/superpowers/skill-chain-model.md"

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

skills=(
  "using-superpowers:NeedsSkillSelection:SkillSelectionResult:SkillSelectionGate"
  "brainstorming:NeedsDesign:DesignSpec:SpecReadinessGate"
  "writing-plans:NeedsPlan:ImplementationPlan:PlanReadinessGate"
  "using-git-worktrees:NeedsWorkspace:WorkspaceReadiness:WorkspaceReadinessGate"
  "subagent-driven-development:NeedsImplementation:ImplementationResult:ImplementationQualityGate"
  "executing-plans:NeedsImplementation:ImplementationResult:ImplementationQualityGate"
  "test-driven-development:NeedsTDDCycle:TDDCycleResult:TDDCompletionGate"
  "systematic-debugging:NeedsDebugging:RootCauseAnalysis:RootCauseGate"
  "verification-before-completion:NeedsVerification:VerificationResult:VerificationGate"
  "requesting-code-review:NeedsCodeReview:CodeReviewResult:CodeReviewGate"
  "receiving-code-review:NeedsReviewResponse:ReviewResponseResult:ReviewResponseGate"
  "dispatching-parallel-agents:NeedsParallelInvestigation:ParallelDispatchResult:ParallelIntegrationGate"
  "finishing-a-development-branch:NeedsFinishing:CompletionResult:CompletionGate"
  "writing-skills:NeedsSkillAuthoring:SkillAuthoringResult:SkillDeploymentGate"
)

[[ -f "$MODEL" ]] || fail "Missing model document: $MODEL"

contains "$MODEL" '"$schema": "https://json-schema.org/draft/2020-12/schema"' "JSON Schema"
contains "$MODEL" '"SkillResult"' "SkillResult schema"
contains "$MODEL" '"GateDecision"' "GateDecision schema"
contains "$MODEL" '"advance"' "Gate decision enum"
contains "$MODEL" '"retry"' "Gate decision enum"
contains "$MODEL" '"branch"' "Gate decision enum"
contains "$MODEL" '"ask_user"' "Gate decision enum"
contains "$MODEL" '"escalate"' "Gate decision enum"
contains "$MODEL" "Gate does not generate content" "Gate boundary"
contains "$MODEL" "Tool output is evidence" "Tool boundary"
contains "$MODEL" "Existing Superpowers scheduling remains the execution mechanism" "Scheduling boundary"

for entry in "${skills[@]}"; do
  IFS=: read -r skill state artifact gate <<< "$entry"
  skill_file="$ROOT/skills/$skill/SKILL.md"

  [[ -f "$skill_file" ]] || fail "Missing skill file: $skill_file"

  contains "$MODEL" "\"$skill\"" "Model skill enum"
  contains "$MODEL" "\"$state\"" "Model state enum"
  contains "$MODEL" "\"$artifact\"" "Model artifact enum"
  contains "$MODEL" "\"$gate\"" "Model gate enum"

  contains "$skill_file" "## Chain Contract" "$skill Chain Contract"
  contains "$skill_file" "docs/superpowers/skill-chain-model.md" "$skill model reference"
  contains "$skill_file" 'SkillResult' "$skill SkillResult"
  contains "$skill_file" "\`skill\`: \`$skill\`" "$skill skill field"
  contains "$skill_file" "\`state\`: \`$state\`" "$skill state field"
  contains "$skill_file" "\`artifact.kind\`: \`$artifact\`" "$skill artifact kind"
  contains "$skill_file" "\`gate\`: \`$gate\`" "$skill gate"
  contains "$skill_file" "GateDecision" "$skill GateDecision"
done

ruby - "$MODEL" <<'RUBY'
require "json"
path = ARGV.fetch(0)
content = File.read(path)
blocks = content.scan(/```json\n(.*?)\n```/m).flatten
abort "[FAIL] No JSON blocks found in #{path}" if blocks.empty?

blocks.each_with_index do |block, index|
  JSON.parse(block)
rescue JSON::ParserError => e
  abort "[FAIL] JSON block #{index + 1} is invalid: #{e.message}"
end

puts "[PASS] JSON examples parse"
RUBY

pass "Skill chain contracts are present"
```

- [ ] **Step 2: Make the test executable**

Run:

```bash
chmod +x tests/skill-chain/test-skill-chain-contracts.sh
```

Expected: no output.

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
tests/skill-chain/test-skill-chain-contracts.sh
```

Expected: FAIL with:

```text
[FAIL] Missing model document:
```

Do not commit yet. The test should remain failing until the model document and skill contracts are implemented.

### Task 2: Add Canonical Skill Chain Model

**Files:**
- Create: `docs/superpowers/skill-chain-model.md`
- Test: `tests/skill-chain/test-skill-chain-contracts.sh`

- [ ] **Step 1: Create the model document**

Create `docs/superpowers/skill-chain-model.md` with these sections and schema. Keep the exact headings because the static test depends on them:

````markdown
# Skill Chain Model

This document is the canonical source of truth for Superpowers skill-chain outputs.

Existing Superpowers scheduling remains the execution mechanism. The chain model does not trigger skills and does not introduce a runtime engine. It makes each skill handoff explicit, structured, and auditable.

## Model

```text
input -> current state -> skill -> artifact -> gate -> next state / retry / branch / ask user / escalate
```

Every skill invocation MUST end with a complete `SkillResult` JSON object. Every transition between states MUST be represented by a complete `GateDecision` JSON object.

## Boundaries

- Skill creates content. A skill transforms current state into a structured artifact.
- Gate does not generate content. A gate judges whether the artifact is sufficient to move forward.
- Tool output is evidence. Tools, shell commands, test runs, and subagents do not directly decide flow.
- `GateDecision.next_state` records the next state. It does not automatically trigger a skill without a runtime engine.

## Routing

| State | Skill |
|---|---|
| `NeedsSkillSelection` | `using-superpowers` |
| `NeedsDesign` | `brainstorming` |
| `NeedsPlan` | `writing-plans` |
| `NeedsWorkspace` | `using-git-worktrees` |
| `NeedsImplementation` | `subagent-driven-development` or `executing-plans` |
| `NeedsTDDCycle` | `test-driven-development` |
| `NeedsDebugging` | `systematic-debugging` |
| `NeedsVerification` | `verification-before-completion` |
| `NeedsCodeReview` | `requesting-code-review` |
| `NeedsReviewResponse` | `receiving-code-review` |
| `NeedsParallelInvestigation` | `dispatching-parallel-agents` |
| `NeedsFinishing` | `finishing-a-development-branch` |
| `NeedsSkillAuthoring` | `writing-skills` |
| `AwaitingUser` | user input |
| `Blocked` | escalation |
| `Complete` | stop |

## Contract Mapping

| Skill | State | Artifact Kind | Gate |
|---|---|---|---|
| `using-superpowers` | `NeedsSkillSelection` | `SkillSelectionResult` | `SkillSelectionGate` |
| `brainstorming` | `NeedsDesign` | `DesignSpec` | `SpecReadinessGate` |
| `writing-plans` | `NeedsPlan` | `ImplementationPlan` | `PlanReadinessGate` |
| `using-git-worktrees` | `NeedsWorkspace` | `WorkspaceReadiness` | `WorkspaceReadinessGate` |
| `subagent-driven-development` | `NeedsImplementation` | `ImplementationResult` | `ImplementationQualityGate` |
| `executing-plans` | `NeedsImplementation` | `ImplementationResult` | `ImplementationQualityGate` |
| `test-driven-development` | `NeedsTDDCycle` | `TDDCycleResult` | `TDDCompletionGate` |
| `systematic-debugging` | `NeedsDebugging` | `RootCauseAnalysis` | `RootCauseGate` |
| `verification-before-completion` | `NeedsVerification` | `VerificationResult` | `VerificationGate` |
| `requesting-code-review` | `NeedsCodeReview` | `CodeReviewResult` | `CodeReviewGate` |
| `receiving-code-review` | `NeedsReviewResponse` | `ReviewResponseResult` | `ReviewResponseGate` |
| `dispatching-parallel-agents` | `NeedsParallelInvestigation` | `ParallelDispatchResult` | `ParallelIntegrationGate` |
| `finishing-a-development-branch` | `NeedsFinishing` | `CompletionResult` | `CompletionGate` |
| `writing-skills` | `NeedsSkillAuthoring` | `SkillAuthoringResult` | `SkillDeploymentGate` |

## JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://superpowers.local/schemas/skill-chain-result.schema.json",
  "title": "Superpowers Skill Chain Result",
  "type": "object",
  "oneOf": [
    { "$ref": "#/$defs/SkillResult" },
    { "$ref": "#/$defs/GateDecision" }
  ],
  "$defs": {
    "SkillName": {
      "type": "string",
      "enum": [
        "using-superpowers",
        "brainstorming",
        "writing-plans",
        "using-git-worktrees",
        "subagent-driven-development",
        "executing-plans",
        "test-driven-development",
        "systematic-debugging",
        "verification-before-completion",
        "requesting-code-review",
        "receiving-code-review",
        "dispatching-parallel-agents",
        "finishing-a-development-branch",
        "writing-skills"
      ]
    },
    "ChainState": {
      "type": "string",
      "enum": [
        "NeedsSkillSelection",
        "NeedsDesign",
        "NeedsPlan",
        "NeedsWorkspace",
        "NeedsImplementation",
        "NeedsTDDCycle",
        "NeedsDebugging",
        "NeedsVerification",
        "NeedsCodeReview",
        "NeedsReviewResponse",
        "NeedsParallelInvestigation",
        "NeedsFinishing",
        "NeedsSkillAuthoring",
        "AwaitingUser",
        "Blocked",
        "Complete"
      ]
    },
    "ArtifactKind": {
      "type": "string",
      "enum": [
        "SkillSelectionResult",
        "DesignSpec",
        "ImplementationPlan",
        "WorkspaceReadiness",
        "ImplementationResult",
        "TDDCycleResult",
        "RootCauseAnalysis",
        "VerificationResult",
        "CodeReviewResult",
        "ReviewResponseResult",
        "ParallelDispatchResult",
        "CompletionResult",
        "SkillAuthoringResult"
      ]
    },
    "GateName": {
      "type": "string",
      "enum": [
        "SkillSelectionGate",
        "SpecReadinessGate",
        "PlanReadinessGate",
        "WorkspaceReadinessGate",
        "ImplementationQualityGate",
        "TDDCompletionGate",
        "RootCauseGate",
        "VerificationGate",
        "CodeReviewGate",
        "ReviewResponseGate",
        "ParallelIntegrationGate",
        "CompletionGate",
        "SkillDeploymentGate"
      ]
    },
    "Status": {
      "type": "string",
      "enum": ["completed", "completed_with_concerns", "blocked", "needs_context"]
    },
    "GateDecisionType": {
      "type": "string",
      "enum": ["advance", "retry", "branch", "ask_user", "escalate"]
    },
    "Evidence": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "source", "summary"],
      "properties": {
        "kind": {
          "type": "string",
          "enum": ["CommandEvidence", "FileEvidence", "UserInputEvidence", "SubagentEvidence", "TestEvidence", "ManualEvidence"]
        },
        "source": { "type": "string", "minLength": 1 },
        "summary": { "type": "string", "minLength": 1 },
        "exit_code": { "type": "integer" },
        "status": { "type": "string" },
        "path": { "type": "string" }
      }
    },
    "Artifact": {
      "type": "object",
      "additionalProperties": true,
      "required": ["kind", "summary"],
      "properties": {
        "kind": { "$ref": "#/$defs/ArtifactKind" },
        "summary": { "type": "string", "minLength": 1 },
        "path": { "type": "string" },
        "status": { "type": "string" },
        "items": { "type": "array", "items": { "type": "object" } }
      }
    },
    "SkillResult": {
      "type": "object",
      "additionalProperties": false,
      "required": ["schema_version", "kind", "state", "skill", "status", "artifact", "evidence", "open_questions", "concerns"],
      "properties": {
        "schema_version": { "const": "1.0.0" },
        "kind": { "const": "SkillResult" },
        "state": { "$ref": "#/$defs/ChainState" },
        "skill": { "$ref": "#/$defs/SkillName" },
        "status": { "$ref": "#/$defs/Status" },
        "artifact": { "$ref": "#/$defs/Artifact" },
        "evidence": { "type": "array", "items": { "$ref": "#/$defs/Evidence" } },
        "open_questions": { "type": "array", "items": { "type": "string" } },
        "concerns": { "type": "array", "items": { "type": "string" } }
      }
    },
    "GateDecision": {
      "type": "object",
      "additionalProperties": false,
      "required": ["schema_version", "kind", "gate", "current_state", "input_artifact_kind", "decision", "next_state", "reasons", "required_actions"],
      "properties": {
        "schema_version": { "const": "1.0.0" },
        "kind": { "const": "GateDecision" },
        "gate": { "$ref": "#/$defs/GateName" },
        "current_state": { "$ref": "#/$defs/ChainState" },
        "input_artifact_kind": { "$ref": "#/$defs/ArtifactKind" },
        "decision": { "$ref": "#/$defs/GateDecisionType" },
        "next_state": { "$ref": "#/$defs/ChainState" },
        "reasons": { "type": "array", "items": { "type": "string" } },
        "required_actions": { "type": "array", "items": { "type": "string" } }
      }
    }
  }
}
```

## SkillResult Example

```json
{
  "schema_version": "1.0.0",
  "kind": "SkillResult",
  "state": "NeedsDesign",
  "skill": "brainstorming",
  "status": "completed",
  "artifact": {
    "kind": "DesignSpec",
    "summary": "Design spec written and committed",
    "path": "docs/superpowers/specs/2026-06-11-skill-chain-model-design.md"
  },
  "evidence": [
    {
      "kind": "UserInputEvidence",
      "source": "conversation",
      "summary": "User approved full 14-skill chain contract scope."
    }
  ],
  "open_questions": [],
  "concerns": []
}
```

## GateDecision Example

```json
{
  "schema_version": "1.0.0",
  "kind": "GateDecision",
  "gate": "SpecReadinessGate",
  "current_state": "NeedsDesign",
  "input_artifact_kind": "DesignSpec",
  "decision": "advance",
  "next_state": "NeedsPlan",
  "reasons": [
    "The design spec defines scope, schema requirements, skill coverage, and validation strategy."
  ],
  "required_actions": []
}
```

## Required Skill Footer Behavior

At completion, every skill must emit:

1. A complete `SkillResult` JSON object.
2. A complete `GateDecision` JSON object for the gate named by that skill's `Chain Contract`.

If the skill cannot produce a complete artifact, `SkillResult.status` must be `blocked` or `needs_context`, and the gate should use `ask_user` or `escalate`.
````

- [ ] **Step 2: Run the static test and verify it still fails on missing skill contracts**

Run:

```bash
tests/skill-chain/test-skill-chain-contracts.sh
```

Expected: FAIL with a message like:

```text
[FAIL] using-superpowers Chain Contract missing '## Chain Contract'
```

Do not commit yet. The model document is present, but the skills still need contracts.

### Task 3: Add Chain Contracts To All Skills

**Files:**
- Modify: `skills/using-superpowers/SKILL.md`
- Modify: `skills/brainstorming/SKILL.md`
- Modify: `skills/writing-plans/SKILL.md`
- Modify: `skills/using-git-worktrees/SKILL.md`
- Modify: `skills/subagent-driven-development/SKILL.md`
- Modify: `skills/executing-plans/SKILL.md`
- Modify: `skills/test-driven-development/SKILL.md`
- Modify: `skills/systematic-debugging/SKILL.md`
- Modify: `skills/verification-before-completion/SKILL.md`
- Modify: `skills/requesting-code-review/SKILL.md`
- Modify: `skills/receiving-code-review/SKILL.md`
- Modify: `skills/dispatching-parallel-agents/SKILL.md`
- Modify: `skills/finishing-a-development-branch/SKILL.md`
- Modify: `skills/writing-skills/SKILL.md`
- Test: `tests/skill-chain/test-skill-chain-contracts.sh`

- [ ] **Step 1: Add this contract block to `skills/using-superpowers/SKILL.md`**

Insert after the `<SUBAGENT-STOP>` block:

```markdown
## Chain Contract

At completion, this skill MUST output a complete `SkillResult` JSON object following `docs/superpowers/skill-chain-model.md`.

- `skill`: `using-superpowers`
- `state`: `NeedsSkillSelection`
- `artifact.kind`: `SkillSelectionResult`
- `gate`: `SkillSelectionGate`
- `allowed_decisions`: [`advance`, `retry`, `branch`, `ask_user`, `escalate`]

The gate MUST output a complete `GateDecision` JSON object. Gate decisions record the next state for the existing Superpowers scheduling flow; they do not automatically trigger skills.
```

- [ ] **Step 2: Add this contract block to `skills/brainstorming/SKILL.md`**

Insert after the hard gate section:

```markdown
## Chain Contract

At completion, this skill MUST output a complete `SkillResult` JSON object following `docs/superpowers/skill-chain-model.md`.

- `skill`: `brainstorming`
- `state`: `NeedsDesign`
- `artifact.kind`: `DesignSpec`
- `gate`: `SpecReadinessGate`
- `allowed_decisions`: [`advance`, `retry`, `branch`, `ask_user`, `escalate`]

The gate MUST output a complete `GateDecision` JSON object. Gate decisions record the next state for the existing Superpowers scheduling flow; they do not automatically trigger skills.
```

- [ ] **Step 3: Add this contract block to `skills/writing-plans/SKILL.md`**

Insert after the overview:

```markdown
## Chain Contract

At completion, this skill MUST output a complete `SkillResult` JSON object following `docs/superpowers/skill-chain-model.md`.

- `skill`: `writing-plans`
- `state`: `NeedsPlan`
- `artifact.kind`: `ImplementationPlan`
- `gate`: `PlanReadinessGate`
- `allowed_decisions`: [`advance`, `retry`, `branch`, `ask_user`, `escalate`]

The gate MUST output a complete `GateDecision` JSON object. Gate decisions record the next state for the existing Superpowers scheduling flow; they do not automatically trigger skills.
```

- [ ] **Step 4: Add this contract block to `skills/using-git-worktrees/SKILL.md`**

Insert after the overview:

```markdown
## Chain Contract

At completion, this skill MUST output a complete `SkillResult` JSON object following `docs/superpowers/skill-chain-model.md`.

- `skill`: `using-git-worktrees`
- `state`: `NeedsWorkspace`
- `artifact.kind`: `WorkspaceReadiness`
- `gate`: `WorkspaceReadinessGate`
- `allowed_decisions`: [`advance`, `retry`, `branch`, `ask_user`, `escalate`]

The gate MUST output a complete `GateDecision` JSON object. Gate decisions record the next state for the existing Superpowers scheduling flow; they do not automatically trigger skills.
```

- [ ] **Step 5: Add this contract block to `skills/subagent-driven-development/SKILL.md`**

Insert after the overview paragraph:

```markdown
## Chain Contract

At completion, this skill MUST output a complete `SkillResult` JSON object following `docs/superpowers/skill-chain-model.md`.

- `skill`: `subagent-driven-development`
- `state`: `NeedsImplementation`
- `artifact.kind`: `ImplementationResult`
- `gate`: `ImplementationQualityGate`
- `allowed_decisions`: [`advance`, `retry`, `branch`, `ask_user`, `escalate`]

The gate MUST output a complete `GateDecision` JSON object. Gate decisions record the next state for the existing Superpowers scheduling flow; they do not automatically trigger skills. Subagent outputs are evidence or nested task results; they do not directly decide `next_state`.
```

- [ ] **Step 6: Add this contract block to `skills/executing-plans/SKILL.md`**

Insert after the overview:

```markdown
## Chain Contract

At completion, this skill MUST output a complete `SkillResult` JSON object following `docs/superpowers/skill-chain-model.md`.

- `skill`: `executing-plans`
- `state`: `NeedsImplementation`
- `artifact.kind`: `ImplementationResult`
- `gate`: `ImplementationQualityGate`
- `allowed_decisions`: [`advance`, `retry`, `branch`, `ask_user`, `escalate`]

The gate MUST output a complete `GateDecision` JSON object. Gate decisions record the next state for the existing Superpowers scheduling flow; they do not automatically trigger skills.
```

- [ ] **Step 7: Add this contract block to `skills/test-driven-development/SKILL.md`**

Insert after the overview:

```markdown
## Chain Contract

At completion, this skill MUST output a complete `SkillResult` JSON object following `docs/superpowers/skill-chain-model.md`.

- `skill`: `test-driven-development`
- `state`: `NeedsTDDCycle`
- `artifact.kind`: `TDDCycleResult`
- `gate`: `TDDCompletionGate`
- `allowed_decisions`: [`advance`, `retry`, `branch`, `ask_user`, `escalate`]

The gate MUST output a complete `GateDecision` JSON object. Gate decisions record the next state for the existing Superpowers scheduling flow; they do not automatically trigger skills.
```

- [ ] **Step 8: Add this contract block to `skills/systematic-debugging/SKILL.md`**

Insert after the overview:

```markdown
## Chain Contract

At completion, this skill MUST output a complete `SkillResult` JSON object following `docs/superpowers/skill-chain-model.md`.

- `skill`: `systematic-debugging`
- `state`: `NeedsDebugging`
- `artifact.kind`: `RootCauseAnalysis`
- `gate`: `RootCauseGate`
- `allowed_decisions`: [`advance`, `retry`, `branch`, `ask_user`, `escalate`]

The gate MUST output a complete `GateDecision` JSON object. Gate decisions record the next state for the existing Superpowers scheduling flow; they do not automatically trigger skills.
```

- [ ] **Step 9: Add this contract block to `skills/verification-before-completion/SKILL.md`**

Insert after the overview:

```markdown
## Chain Contract

At completion, this skill MUST output a complete `SkillResult` JSON object following `docs/superpowers/skill-chain-model.md`.

- `skill`: `verification-before-completion`
- `state`: `NeedsVerification`
- `artifact.kind`: `VerificationResult`
- `gate`: `VerificationGate`
- `allowed_decisions`: [`advance`, `retry`, `branch`, `ask_user`, `escalate`]

The gate MUST output a complete `GateDecision` JSON object. Gate decisions record the next state for the existing Superpowers scheduling flow; they do not automatically trigger skills.
```

- [ ] **Step 10: Add this contract block to `skills/requesting-code-review/SKILL.md`**

Insert after the opening paragraph:

```markdown
## Chain Contract

At completion, this skill MUST output a complete `SkillResult` JSON object following `docs/superpowers/skill-chain-model.md`.

- `skill`: `requesting-code-review`
- `state`: `NeedsCodeReview`
- `artifact.kind`: `CodeReviewResult`
- `gate`: `CodeReviewGate`
- `allowed_decisions`: [`advance`, `retry`, `branch`, `ask_user`, `escalate`]

The gate MUST output a complete `GateDecision` JSON object. Gate decisions record the next state for the existing Superpowers scheduling flow; they do not automatically trigger skills.
```

- [ ] **Step 11: Add this contract block to `skills/receiving-code-review/SKILL.md`**

Insert after the overview:

```markdown
## Chain Contract

At completion, this skill MUST output a complete `SkillResult` JSON object following `docs/superpowers/skill-chain-model.md`.

- `skill`: `receiving-code-review`
- `state`: `NeedsReviewResponse`
- `artifact.kind`: `ReviewResponseResult`
- `gate`: `ReviewResponseGate`
- `allowed_decisions`: [`advance`, `retry`, `branch`, `ask_user`, `escalate`]

The gate MUST output a complete `GateDecision` JSON object. Gate decisions record the next state for the existing Superpowers scheduling flow; they do not automatically trigger skills.
```

- [ ] **Step 12: Add this contract block to `skills/dispatching-parallel-agents/SKILL.md`**

Insert after the overview:

```markdown
## Chain Contract

At completion, this skill MUST output a complete `SkillResult` JSON object following `docs/superpowers/skill-chain-model.md`.

- `skill`: `dispatching-parallel-agents`
- `state`: `NeedsParallelInvestigation`
- `artifact.kind`: `ParallelDispatchResult`
- `gate`: `ParallelIntegrationGate`
- `allowed_decisions`: [`advance`, `retry`, `branch`, `ask_user`, `escalate`]

The gate MUST output a complete `GateDecision` JSON object. Gate decisions record the next state for the existing Superpowers scheduling flow; they do not automatically trigger skills. Subagent outputs are evidence or nested investigation results; they do not directly decide `next_state`.
```

- [ ] **Step 13: Add this contract block to `skills/finishing-a-development-branch/SKILL.md`**

Insert after the overview:

```markdown
## Chain Contract

At completion, this skill MUST output a complete `SkillResult` JSON object following `docs/superpowers/skill-chain-model.md`.

- `skill`: `finishing-a-development-branch`
- `state`: `NeedsFinishing`
- `artifact.kind`: `CompletionResult`
- `gate`: `CompletionGate`
- `allowed_decisions`: [`advance`, `retry`, `branch`, `ask_user`, `escalate`]

The gate MUST output a complete `GateDecision` JSON object. Gate decisions record the next state for the existing Superpowers scheduling flow; they do not automatically trigger skills.
```

- [ ] **Step 14: Add this contract block to `skills/writing-skills/SKILL.md`**

Insert after the overview:

```markdown
## Chain Contract

At completion, this skill MUST output a complete `SkillResult` JSON object following `docs/superpowers/skill-chain-model.md`.

- `skill`: `writing-skills`
- `state`: `NeedsSkillAuthoring`
- `artifact.kind`: `SkillAuthoringResult`
- `gate`: `SkillDeploymentGate`
- `allowed_decisions`: [`advance`, `retry`, `branch`, `ask_user`, `escalate`]

The gate MUST output a complete `GateDecision` JSON object. Gate decisions record the next state for the existing Superpowers scheduling flow; they do not automatically trigger skills.
```

- [ ] **Step 15: Run the static contract test and verify it passes**

Run:

```bash
tests/skill-chain/test-skill-chain-contracts.sh
```

Expected output includes:

```text
[PASS] JSON examples parse
[PASS] Skill chain contracts are present
```

- [ ] **Step 16: Commit the passing implementation**

Run:

```bash
git add docs/superpowers/skill-chain-model.md tests/skill-chain/test-skill-chain-contracts.sh skills/*/SKILL.md
git commit -m "feat: add skill chain contracts"
```

Expected: commit succeeds with the model doc, static test, and 14 skill contract edits.

### Task 4: Final Verification

**Files:**
- Verify: `docs/superpowers/skill-chain-model.md`
- Verify: `tests/skill-chain/test-skill-chain-contracts.sh`
- Verify: `skills/*/SKILL.md`

- [ ] **Step 1: Re-run the targeted static test**

Run:

```bash
tests/skill-chain/test-skill-chain-contracts.sh
```

Expected output includes:

```text
[PASS] JSON examples parse
[PASS] Skill chain contracts are present
```

- [ ] **Step 2: Verify no placeholders were introduced**

Run:

```bash
rg -n "TODO|TBD|FIXME|implement later|fill in details" \
  docs/superpowers/skill-chain-model.md \
  tests/skill-chain \
  $(find skills -maxdepth 2 -name SKILL.md -print)
```

Expected: no output and exit code `1`.

- [ ] **Step 3: Verify git status is clean after commit**

Run:

```bash
git status --short
```

Expected: no output.
