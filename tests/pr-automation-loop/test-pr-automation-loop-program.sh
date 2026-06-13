#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/pr-automation-loop.mjs"
NODE_BIN="$(command -v node)"

fail() {
  echo "[FAIL] $1" >&2
  exit 1
}

pass() {
  echo "[PASS] $1"
}

[[ -f "$SCRIPT" ]] || fail "Missing program: $SCRIPT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FIXTURE="$TMP/facts.json"
OUT="$TMP/out.json"
LOG_STDOUT_OUT="$TMP/log-stdout.jsonl"
CODEX_HOME_DIR="$TMP/codex-home"
STATE_ROOT="$CODEX_HOME_DIR/superpowers/state-index/mortgage"
RUNTIME_ROOT="$CODEX_HOME_DIR/superpowers/runtime/mortgage"
AUDIT_LOG="$RUNTIME_ROOT/audit.jsonl"
COMMON_ARGS=(--project-root "$TMP" --repo-id mortgage --fixture "$FIXTURE")

cat > "$FIXTURE" <<'JSON'
{
  "pull_requests": [
    {
      "repo": "better/mortgage-api",
      "number": 12,
      "url": "https://github.com/better/mortgage-api/pull/12",
      "head_sha": "abc123",
      "branch": "feature/pr-loop",
      "base": "main",
      "is_draft": false,
      "review_comments": [
        {
          "id": 101,
          "user": "github-copilot[bot]",
          "body": "Add a guard for the missing state.",
          "path": "app/models/state.ts",
          "line": 42,
          "url": "https://github.com/better/mortgage-api/pull/12#discussion_r101"
        }
      ],
      "comments": [
        {
          "id": 202,
          "user": "github-copilot[bot]",
          "body": "The helper should cover the empty array case.",
          "url": "https://github.com/better/mortgage-api/pull/12#issuecomment-202"
        }
      ],
      "checks": [
        {
          "id": 303,
          "name": "unit tests",
          "conclusion": "failure",
          "details_url": "https://buildkite.com/better/mortgage-api/builds/154655#job-303"
        },
        {
          "id": 304,
          "name": ":playwright: e2e tests",
          "conclusion": "failure",
          "details_url": "https://buildkite.com/better/mortgage-api/builds/154655#job-304"
        },
        {
          "id": 305,
          "name": "lint",
          "conclusion": "success",
          "details_url": "https://buildkite.com/better/mortgage-api/builds/154655#job-305"
        }
      ]
    }
  ]
}
JSON

CODEX_HOME="$CODEX_HOME_DIR" node "$SCRIPT" "${COMMON_ARGS[@]}" --dry-run --json > "$OUT"

node - "$OUT" "$TMP" "$STATE_ROOT" "$RUNTIME_ROOT" "$AUDIT_LOG" <<'NODE'
const fs = require('node:fs');
const [outPath, projectRoot, stateRoot, runtimeRoot, auditLog] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
}

assert(data.status === 'dry_run', `expected dry_run status, got ${data.status}`);
assert(data.worklist_count === 3, `expected 3 non-e2e work items, got ${data.worklist_count}`);
assert(data.skipped_e2e_count === 1, `expected 1 skipped e2e item, got ${data.skipped_e2e_count}`);
assert(data.selected?.type === 'copilot_review_comment', `expected review comment first, got ${data.selected?.type}`);
assert(data.selected?.trigger_id === 'github-review-comment-101', `unexpected trigger ${data.selected?.trigger_id}`);
assert(data.state_root === stateRoot, `expected state_root ${stateRoot}, got ${data.state_root}`);
assert(data.runtime_root === runtimeRoot, `expected runtime_root ${runtimeRoot}, got ${data.runtime_root}`);
assert(!fs.existsSync(`${projectRoot}/.superpowers/runtime/active-worker.json`), 'dry-run created active-worker.json');
assert(!fs.existsSync(`${runtimeRoot}/active-worker.json`), 'dry-run created global active-worker.json');
assert(data.audit_log === auditLog, `expected audit_log ${auditLog}, got ${data.audit_log}`);

assert(fs.existsSync(auditLog), 'audit log was not written');
const auditEvents = fs.readFileSync(auditLog, 'utf8').trim().split(/\n+/).map(line => JSON.parse(line));
const eventNames = auditEvents.map(event => event.event);
for (const eventName of ['wake_started', 'facts_loaded', 'worklist_derived', 'dry_run']) {
  assert(eventNames.includes(eventName), `expected audit event ${eventName}`);
}
const worklistEvent = auditEvents.find(event => event.event === 'worklist_derived');
assert(worklistEvent.worklist_count === 3, `expected audit worklist count 3, got ${worklistEvent.worklist_count}`);
assert(worklistEvent.skipped_e2e_count === 1, `expected audit skipped e2e count 1, got ${worklistEvent.skipped_e2e_count}`);
assert(worklistEvent.selected?.trigger_id === 'github-review-comment-101', `expected audit selected review comment, got ${worklistEvent.selected?.trigger_id}`);
assert(worklistEvent.repo_id === 'mortgage', `expected audit repo_id mortgage, got ${worklistEvent.repo_id}`);
assert(!JSON.stringify(worklistEvent).includes('Add a guard for the missing state.'), 'audit log leaked full comment body');
NODE

rm -f "$AUDIT_LOG"
CODEX_HOME="$CODEX_HOME_DIR" node "$SCRIPT" "${COMMON_ARGS[@]}" --dry-run --json --log-stdout > "$LOG_STDOUT_OUT"

node - "$LOG_STDOUT_OUT" "$AUDIT_LOG" <<'NODE'
const fs = require('node:fs');
const [stdoutPath, auditLog] = process.argv.slice(2);

function assert(condition, message) {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
}

const stdoutLines = fs.readFileSync(stdoutPath, 'utf8').trim().split(/\n+/).map(line => JSON.parse(line));
const auditLines = fs.readFileSync(auditLog, 'utf8').trim().split(/\n+/).map(line => JSON.parse(line));
const stdoutEvents = stdoutLines.filter(line => line.event);
const finalResult = stdoutLines[stdoutLines.length - 1];

assert(stdoutEvents.length === auditLines.length, `expected ${auditLines.length} stdout audit events, got ${stdoutEvents.length}`);
assert(stdoutEvents.some(event => event.event === 'wake_started'), 'expected wake_started on stdout');
assert(stdoutEvents.some(event => event.event === 'worklist_derived'), 'expected worklist_derived on stdout');
assert(stdoutEvents.some(event => event.event === 'dry_run'), 'expected dry_run audit event on stdout');
assert(finalResult.status === 'dry_run', `expected final stdout result dry_run, got ${finalResult.status}`);
assert(finalResult.selected?.trigger_id === 'github-review-comment-101', `expected final stdout selected trigger, got ${finalResult.selected?.trigger_id}`);
NODE

mkdir -p "$STATE_ROOT/loops"
cat > "$STATE_ROOT/loops/handled-review.md" <<'MARKDOWN'
# Loop Summary

Trigger: github-review-comment-101
Outcome: pushed
State: /Users/bhuang/.codex/superpowers/state-index/mortgage/entities/better-mortgage-api-pr-12.json
Reply: https://github.com/better/mortgage-api/pull/12#discussion_r101
MARKDOWN

CODEX_HOME="$CODEX_HOME_DIR" node "$SCRIPT" "${COMMON_ARGS[@]}" --dry-run --json > "$OUT"

node - "$OUT" "$AUDIT_LOG" <<'NODE'
const fs = require('node:fs');
const [outPath, auditLog] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
}

assert(data.status === 'dry_run', `expected dry_run status after handled summary, got ${data.status}`);
assert(data.worklist_count === 2, `expected handled review comment to be filtered, got ${data.worklist_count}`);
assert(data.selected?.trigger_id === 'github-pr-comment-202', `expected PR comment after handled review, got ${data.selected?.trigger_id}`);

const auditEvents = fs.readFileSync(auditLog, 'utf8').trim().split(/\n+/).map(line => JSON.parse(line));
const worklistEvents = auditEvents.filter(event => event.event === 'worklist_derived');
const latestWorklist = worklistEvents[worklistEvents.length - 1];
assert(latestWorklist.worklist_count === 2, `expected latest audit worklist count 2, got ${latestWorklist.worklist_count}`);
assert(latestWorklist.selected?.trigger_id === 'github-pr-comment-202', `expected latest audit selected PR comment, got ${latestWorklist.selected?.trigger_id}`);
NODE

mkdir -p "$RUNTIME_ROOT"
COMPLETED_RUN="$RUNTIME_ROOT/runs/completed"
mkdir -p "$COMPLETED_RUN"
cat > "$COMPLETED_RUN/final.md" <<'MARKDOWN'
Outcome: failed
Trigger: github-review-comment-101
Commit: abcdef0
Validation: unit tests passed
State: /Users/bhuang/.codex/superpowers/state-index/mortgage/loops/handled-review.md
Reply: https://github.com/better/mortgage-api/pull/12#discussion_r101
MARKDOWN
cat > "$RUNTIME_ROOT/active-worker.json" <<JSON
{
  "version": 1,
  "status": "running",
  "repo": "better/mortgage-api",
  "pr_number": 12,
  "trigger_id": "github-review-comment-101",
  "worker_pid": 999999,
  "run_dir": "$COMPLETED_RUN"
}
JSON

CODEX_HOME="$CODEX_HOME_DIR" node "$SCRIPT" "${COMMON_ARGS[@]}" --dry-run --json > "$OUT"

node - "$OUT" "$TMP" "$RUNTIME_ROOT" "$AUDIT_LOG" <<'NODE'
const fs = require('node:fs');
const [outPath, projectRoot, runtimeRoot, auditLog] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
}

assert(data.status === 'dry_run', `expected completed lock to be cleared and dry-run to continue, got ${data.status}`);
assert(data.cleared_completed_worker === true, 'expected completed lock clearance to be reported');
assert(!fs.existsSync(`${runtimeRoot}/active-worker.json`), 'completed global lock was not cleared');
assert(!fs.existsSync(`${projectRoot}/.superpowers/runtime/active-worker.json`), 'project-local runtime lock was created');
assert(data.selected?.trigger_id === 'github-pr-comment-202', `expected remaining PR comment after completed lock, got ${data.selected?.trigger_id}`);

const auditEvents = fs.readFileSync(auditLog, 'utf8').trim().split(/\n+/).map(line => JSON.parse(line));
assert(auditEvents.some(event => event.event === 'completed_worker_cleared' && event.active_worker?.trigger_id === 'github-review-comment-101'), 'expected completed_worker_cleared audit event');
NODE

cat > "$RUNTIME_ROOT/active-worker.json" <<'JSON'
{
  "version": 1,
  "repo": "better/mortgage-api",
  "pr_number": 12,
  "trigger_id": "github-review-comment-999",
  "worker_pid": 999999,
  "run_dir": ".superpowers/runtime/runs/example"
}
JSON

CODEX_HOME="$CODEX_HOME_DIR" node "$SCRIPT" "${COMMON_ARGS[@]}" --dry-run --json > "$OUT"

node - "$OUT" "$AUDIT_LOG" <<'NODE'
const fs = require('node:fs');
const [outPath, auditLog] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));

if (data.status !== 'worker_active') {
  console.error(`[FAIL] expected worker_active status with existing lock, got ${data.status}`);
  process.exit(1);
}

const auditEvents = fs.readFileSync(auditLog, 'utf8').trim().split(/\n+/).map(line => JSON.parse(line));
if (!auditEvents.some(event => event.event === 'worker_active' && event.active_worker?.trigger_id === 'github-review-comment-999')) {
  console.error('[FAIL] expected worker_active audit event');
  process.exit(1);
}
NODE

rm -f "$RUNTIME_ROOT/active-worker.json"
EMPTYBIN="$TMP/emptybin"
mkdir -p "$EMPTYBIN"

CODEX_HOME="$CODEX_HOME_DIR" PATH="$EMPTYBIN" "$NODE_BIN" "$SCRIPT" "${COMMON_ARGS[@]}" --json > "$OUT"

node - "$OUT" "$TMP" "$RUNTIME_ROOT" "$AUDIT_LOG" <<'NODE'
const fs = require('node:fs');
const [outPath, projectRoot, runtimeRoot, auditLog] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
}

assert(data.status === 'requirements_failed', `expected requirements_failed without codex, got ${data.status}`);
assert(data.selected?.trigger_id === 'github-pr-comment-202', `expected selected trigger to be reported, got ${data.selected?.trigger_id}`);
assert(Array.isArray(data.missing_requirements), 'expected missing_requirements array');
assert(data.missing_requirements.some(requirement => requirement.id === 'codex'), 'expected missing codex requirement');
assert(!fs.existsSync(`${projectRoot}/.superpowers/runtime/active-worker.json`), 'requirements failure created active-worker.json');
assert(!fs.existsSync(`${runtimeRoot}/active-worker.json`), 'requirements failure created global active-worker.json');

const auditEvents = fs.readFileSync(auditLog, 'utf8').trim().split(/\n+/).map(line => JSON.parse(line));
const requirementEvents = auditEvents.filter(event => event.event === 'requirements_failed');
const latestRequirementEvent = requirementEvents[requirementEvents.length - 1];
assert(latestRequirementEvent.selected?.trigger_id === 'github-pr-comment-202', `expected audit selected trigger for failed requirements, got ${latestRequirementEvent.selected?.trigger_id}`);
assert(latestRequirementEvent.missing_requirements.some(requirement => requirement.id === 'codex'), 'expected audit missing codex requirement');
NODE

FAKEBIN="$TMP/fakebin"
mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/codex" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-last-message)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

cat >/dev/null
if [[ -n "$out" ]]; then
  cat > "$out" <<'MARKDOWN'
Outcome: skipped
Trigger: fake
Commit: none
Validation: not run
State: /tmp/codex/superpowers/state-index/mortgage/loops/fake.md
Reply: none
MARKDOWN
fi
BASH
chmod +x "$FAKEBIN/codex"

CODEX_HOME="$CODEX_HOME_DIR" PATH="$FAKEBIN:$PATH" node "$SCRIPT" "${COMMON_ARGS[@]}" --json > "$OUT"

node - "$OUT" "$TMP" "$RUNTIME_ROOT" "$STATE_ROOT" "$AUDIT_LOG" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [outPath, projectRoot, runtimeRoot, stateRoot, auditLog] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
}

assert(data.status === 'launched', `expected launched status, got ${data.status}`);
assert(data.selected?.trigger_id === 'github-pr-comment-202', `expected launch to use first unhandled item, got ${data.selected?.trigger_id}`);
assert(Number.isInteger(data.worker_pid), 'expected worker_pid in launch output');
assert(data.state_root === stateRoot, `expected state_root ${stateRoot}, got ${data.state_root}`);
assert(data.runtime_root === runtimeRoot, `expected runtime_root ${runtimeRoot}, got ${data.runtime_root}`);

const lockPath = path.join(runtimeRoot, 'active-worker.json');
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
assert(lock.status === 'running', `expected running lock, got ${lock.status}`);
assert(lock.trigger_id === 'github-pr-comment-202', `expected lock trigger github-pr-comment-202, got ${lock.trigger_id}`);
assert(Number.isInteger(lock.worker_pid), 'expected worker_pid in lock');
assert(!fs.existsSync(path.join(projectRoot, '.superpowers/runtime/active-worker.json')), 'launch created project-local runtime lock');

const prompt = fs.readFileSync(path.join(lock.run_dir, 'worker-prompt.md'), 'utf8');
assert(prompt.includes('Process exactly one trigger'), 'worker prompt was not rendered from template');
assert(prompt.includes('github-pr-comment-202'), 'worker prompt missing selected trigger');
assert(prompt.includes(stateRoot), 'worker prompt missing global state root');

const auditEvents = fs.readFileSync(auditLog, 'utf8').trim().split(/\n+/).map(line => JSON.parse(line));
assert(auditEvents.some(event => event.event === 'worker_launching' && event.selected?.trigger_id === 'github-pr-comment-202'), 'expected worker_launching audit event');
const launchedEvents = auditEvents.filter(event => event.event === 'worker_launched');
const latestLaunchedEvent = launchedEvents[launchedEvents.length - 1];
assert(latestLaunchedEvent.selected?.trigger_id === 'github-pr-comment-202', `expected worker_launched trigger github-pr-comment-202, got ${latestLaunchedEvent.selected?.trigger_id}`);
assert(Number.isInteger(latestLaunchedEvent.worker_pid), 'expected worker_pid in worker_launched audit event');
assert(latestLaunchedEvent.run_dir === lock.run_dir, `expected audit run_dir ${lock.run_dir}, got ${latestLaunchedEvent.run_dir}`);
NODE

pass "pr-automation-loop program derives work, reconciles state, and respects active worker lock"
