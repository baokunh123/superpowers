# Skill Chain Model Design

## Overview

Add a structured skill-chain contract to Superpowers without replacing the existing Superpowers scheduling model.

The model is:

```text
input -> current state -> skill -> artifact -> gate -> next state / retry / branch / ask user / escalate
```

Every skill invocation ends with a complete, parseable `SkillResult` JSON object. Every state transition is justified by a complete, parseable `GateDecision` JSON object. Tools and subagents may provide evidence, but they do not decide flow.

## Problem

Superpowers already has a workflow, but handoffs are expressed in prose and flowcharts. Skills say things like "invoke writing-plans", "request code review", or "use finishing-a-development-branch", while gates are embedded as instructions such as "tests must pass" or "reviewer approves".

That works for human-readable guidance, but it leaves three gaps:

1. Skill outputs are not uniformly structured.
2. Gates are not consistently separated from content generation.
3. Flow decisions are hard to audit because the reason for advancing, retrying, branching, asking the user, or escalating is not captured in one consistent object.

## Goals

1. Define a canonical skill-chain model in `docs/superpowers/skill-chain-model.md`.
2. Define formal JSON Schema for `SkillResult`, `GateDecision`, evidence, artifacts, and shared enums.
3. Require every skill to end by outputting a complete `SkillResult` JSON object.
4. Require every transition between states to be represented by a complete `GateDecision` JSON object.
5. Add a short `Chain Contract` section to all 14 skills.
6. Keep the existing Superpowers scheduling behavior; artifact and gate contracts strengthen handoffs but do not introduce a runtime engine.
7. Add static tests that verify the chain model document, schema coverage, and skill contract coverage.

## Non-Goals

1. Do not build a runtime state-machine engine.
2. Do not replace `using-superpowers` skill discovery.
3. Do not remove subagent workflows.
4. Do not allow subagents, tools, or shell commands to directly route the chain.
5. Do not rewrite skill bodies beyond the minimum needed to add the chain contract.
6. Do not make gates generate missing content. Gates judge artifacts; skills create or revise artifacts.

## Core Semantics

### State

A state describes where the workflow currently is. State names are stable strings used by `SkillResult.state`, `GateDecision.current_state`, and `GateDecision.next_state`.

The first implementation includes the main states below:

| State | Meaning |
|---|---|
| `NeedsSkillSelection` | The agent must select the applicable skill under `using-superpowers`. |
| `NeedsDesign` | The agent must produce or revise a design spec. |
| `NeedsPlan` | The agent must produce or revise an implementation plan. |
| `NeedsWorkspace` | The agent must verify or prepare an isolated workspace. |
| `NeedsImplementation` | The agent must execute a plan or task. |
| `NeedsTDDCycle` | The agent must complete a red-green-refactor cycle. |
| `NeedsDebugging` | The agent must investigate a bug or unexpected behavior. |
| `NeedsVerification` | The agent must verify a completion or correctness claim. |
| `NeedsCodeReview` | The agent must request or produce a code review result. |
| `NeedsReviewResponse` | The agent must evaluate and respond to review feedback. |
| `NeedsParallelInvestigation` | The agent must coordinate independent parallel investigations. |
| `NeedsFinishing` | The agent must complete branch/PR/merge/discard workflow. |
| `NeedsSkillAuthoring` | The agent must create or update a skill under the writing-skills process. |
| `AwaitingUser` | The gate requires user input before proceeding. |
| `Blocked` | The gate cannot make safe progress and must escalate. |
| `Complete` | The chain is complete. |

### Skill

A skill transforms the current state into an artifact. A skill may use tools and subagents, but their results are captured as evidence. The skill does not decide the next state directly.

At the end of every skill invocation, the agent must output one complete JSON object:

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
  "evidence": [],
  "open_questions": [],
  "concerns": []
}
```

### Artifact

An artifact is the structured product of a skill. The artifact must be complete enough for the gate to evaluate. It may reference files, commits, test output, or subagent reports, but it cannot be replaced by a prose statement such as "see above".

Artifact kinds for the first implementation:

| Skill | Artifact Kind |
|---|---|
| `using-superpowers` | `SkillSelectionResult` |
| `brainstorming` | `DesignSpec` |
| `writing-plans` | `ImplementationPlan` |
| `using-git-worktrees` | `WorkspaceReadiness` |
| `subagent-driven-development` | `ImplementationResult` |
| `executing-plans` | `ImplementationResult` |
| `test-driven-development` | `TDDCycleResult` |
| `systematic-debugging` | `RootCauseAnalysis` |
| `verification-before-completion` | `VerificationResult` |
| `requesting-code-review` | `CodeReviewResult` |
| `receiving-code-review` | `ReviewResponseResult` |
| `dispatching-parallel-agents` | `ParallelDispatchResult` |
| `finishing-a-development-branch` | `CompletionResult` |
| `writing-skills` | `SkillAuthoringResult` |

### Evidence

Evidence records observations that influenced a skill result or gate decision. Tools and subagents only produce evidence; they never decide flow directly.

Evidence examples:

```json
{
  "kind": "CommandEvidence",
  "source": "git status --short",
  "summary": "Working tree clean",
  "exit_code": 0
}
```

```json
{
  "kind": "SubagentEvidence",
  "source": "spec compliance reviewer",
  "summary": "Reviewer found no missing requirements",
  "status": "approved"
}
```

### Gate

A gate judges whether an artifact is good enough to move forward. Gates may use evidence, but they do not generate missing content. A gate outputs one complete `GateDecision` JSON object.

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
    "The design spec has a concrete scope, artifact contract, gate semantics, and validation strategy."
  ],
  "required_actions": []
}
```

Allowed gate decisions:

| Decision | Meaning |
|---|---|
| `advance` | Artifact satisfies the gate and can move to the next state. |
| `retry` | Same skill or state must revise the artifact. |
| `branch` | Work should branch to a supporting state such as debugging, TDD, review, or workspace setup. |
| `ask_user` | User input is required before the gate can decide safely. |
| `escalate` | The workflow is blocked or unsafe to continue without external intervention. |

## Existing Scheduling Remains

The chain model does not replace how Superpowers currently selects and sequences skills.

Examples:

1. `brainstorming` still hands off to `writing-plans` after the spec is approved.
2. `writing-plans` still hands off to the existing implementation execution path.
3. `subagent-driven-development` may still dispatch implementer and reviewer subagents.
4. `finishing-a-development-branch` still presents merge, PR, keep, or discard options.

The change is that each handoff becomes auditable:

1. The skill produces a structured artifact in `SkillResult`.
2. The gate produces a structured `GateDecision`.
3. The next skill follows existing Superpowers scheduling using that decision as the explicit transition record.

## Subagent Semantics

Subagents are allowed. They may produce implementation work, review findings, or investigative results. Their outputs must be captured as evidence or nested task results in the controller's artifact.

Subagents do not directly decide `next_state`. If a subagent reviewer says "approved", that approval is evidence for the controller gate. The controller gate still emits the final `GateDecision`.

## Chain Contracts Per Skill

Each `skills/*/SKILL.md` receives a short `Chain Contract` section with these fields:

```markdown
## Chain Contract

At completion, this skill MUST output a complete `SkillResult` JSON object following `docs/superpowers/skill-chain-model.md`.

- `skill`: `<skill-name>`
- `artifact.kind`: `<ArtifactKind>`
- `gate`: `<GateName>`
- `allowed_decisions`: [`advance`, `retry`, `branch`, `ask_user`, `escalate`]
```

Gate mapping:

| Skill | Artifact Kind | Gate |
|---|---|---|
| `using-superpowers` | `SkillSelectionResult` | `SkillSelectionGate` |
| `brainstorming` | `DesignSpec` | `SpecReadinessGate` |
| `writing-plans` | `ImplementationPlan` | `PlanReadinessGate` |
| `using-git-worktrees` | `WorkspaceReadiness` | `WorkspaceReadinessGate` |
| `subagent-driven-development` | `ImplementationResult` | `ImplementationQualityGate` |
| `executing-plans` | `ImplementationResult` | `ImplementationQualityGate` |
| `test-driven-development` | `TDDCycleResult` | `TDDCompletionGate` |
| `systematic-debugging` | `RootCauseAnalysis` | `RootCauseGate` |
| `verification-before-completion` | `VerificationResult` | `VerificationGate` |
| `requesting-code-review` | `CodeReviewResult` | `CodeReviewGate` |
| `receiving-code-review` | `ReviewResponseResult` | `ReviewResponseGate` |
| `dispatching-parallel-agents` | `ParallelDispatchResult` | `ParallelIntegrationGate` |
| `finishing-a-development-branch` | `CompletionResult` | `CompletionGate` |
| `writing-skills` | `SkillAuthoringResult` | `SkillDeploymentGate` |

## JSON Schema Requirements

`docs/superpowers/skill-chain-model.md` contains the canonical schema. The schema should define:

1. `SkillResult`
2. `GateDecision`
3. `Artifact`
4. concrete artifact definitions for all 14 artifact kinds
5. `Evidence`
6. `ChainState`
7. `SkillName`
8. `GateName`
9. `GateDecisionType`
10. shared `Status` values

The schema must be strict enough that:

1. `SkillResult.kind` must equal `SkillResult`.
2. `GateDecision.kind` must equal `GateDecision`.
3. `skill` must be one of the 14 known skill names.
4. `artifact.kind` must match the artifact kinds in the table above.
5. `decision` must be one of the five allowed gate decisions.
6. `next_state` must be one of the declared chain states.
7. `evidence` must be an array.
8. `open_questions`, `concerns`, `reasons`, and `required_actions` must be arrays.

## File Changes

Create:

- `docs/superpowers/skill-chain-model.md`
- `tests/skill-chain/test-skill-chain-contracts.sh`

Modify:

- `skills/using-superpowers/SKILL.md`
- `skills/brainstorming/SKILL.md`
- `skills/writing-plans/SKILL.md`
- `skills/using-git-worktrees/SKILL.md`
- `skills/subagent-driven-development/SKILL.md`
- `skills/executing-plans/SKILL.md`
- `skills/test-driven-development/SKILL.md`
- `skills/systematic-debugging/SKILL.md`
- `skills/verification-before-completion/SKILL.md`
- `skills/requesting-code-review/SKILL.md`
- `skills/receiving-code-review/SKILL.md`
- `skills/dispatching-parallel-agents/SKILL.md`
- `skills/finishing-a-development-branch/SKILL.md`
- `skills/writing-skills/SKILL.md`

## Testing Strategy

Add static tests under `tests/skill-chain/`:

1. Verify `docs/superpowers/skill-chain-model.md` exists.
2. Verify the model document includes `SkillResult`, `GateDecision`, all 14 skill names, all 14 artifact kinds, and all 14 gate names.
3. Verify each `skills/*/SKILL.md` contains a `## Chain Contract` section.
4. Verify each skill contract mentions `SkillResult`.
5. Verify each skill contract declares its expected `artifact.kind`.
6. Verify each skill contract declares its expected gate.
7. Extract schema examples from the model document and validate they are parseable JSON using a local JSON parser available in the environment.

Do not require Claude harness tests for the first implementation. Agent behavior tests can be added after the contract is stable.

## Risks

### Risk: Too Much JSON Makes Skills Hard To Use

Mitigation: Keep the per-skill `Chain Contract` short. The full schema lives in the centralized model document.

### Risk: Gates Start Generating Content

Mitigation: The model document and every gate description explicitly state that gates can only judge artifacts and require actions. They cannot fill missing artifact content.

### Risk: Existing Scheduling Gets Confused With A New Engine

Mitigation: The model document explicitly says there is no runtime engine in this implementation. The chain model strengthens existing Superpowers scheduling.

### Risk: Subagent Approval Becomes A Flow Decision

Mitigation: Subagent outputs are evidence. The controller gate always emits the final `GateDecision`.

## Success Criteria

1. The skill-chain model document defines the complete contract and schema.
2. All 14 skills declare a chain contract.
3. Static tests pass locally.
4. Existing skill scheduling remains intact.
5. A reader can identify, for every skill, the produced artifact kind and the gate that decides the next transition.
