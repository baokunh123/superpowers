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
- Before pushing, confirm the PR head SHA still matches the trigger's recorded SHA, or explicitly reconcile a safe fast-forward update.
- Push to the PR branch only after validation passes and the pre-push SHA guard is satisfied.
- Reply to the original GitHub thread or PR conversation with a concise summary, validation evidence, and hidden `<!-- codex-loop trigger=<trigger id> sha=<head sha> outcome=<outcome> -->` marker for deduplication.
- Use loop-state as the final persistence step: write one factual loop summary and update entity/worktree facts.
- Loop summaries must not include `Next Step:`, `Next Trigger:`, waiting instructions, or a persistent queue.
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
