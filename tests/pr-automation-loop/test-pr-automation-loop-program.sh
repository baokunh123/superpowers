#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/pr-automation-loop.mjs"

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

node "$SCRIPT" --project-root "$TMP" --fixture "$FIXTURE" --dry-run --json > "$OUT"

node - "$OUT" "$TMP" <<'NODE'
const fs = require('node:fs');
const [outPath, projectRoot] = process.argv.slice(2);
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
assert(!fs.existsSync(`${projectRoot}/.superpowers/runtime/active-worker.json`), 'dry-run created active-worker.json');
NODE

mkdir -p "$TMP/.superpowers/state/loops"
cat > "$TMP/.superpowers/state/loops/handled-review.md" <<'MARKDOWN'
# Loop Summary

Trigger: github-review-comment-101
Outcome: pushed
State: .superpowers/state/entities/better-mortgage-api-pr-12.json
Reply: https://github.com/better/mortgage-api/pull/12#discussion_r101
MARKDOWN

node "$SCRIPT" --project-root "$TMP" --fixture "$FIXTURE" --dry-run --json > "$OUT"

node - "$OUT" <<'NODE'
const fs = require('node:fs');
const [outPath] = process.argv.slice(2);
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
NODE

mkdir -p "$TMP/.superpowers/runtime"
COMPLETED_RUN="$TMP/.superpowers/runtime/runs/completed"
mkdir -p "$COMPLETED_RUN"
cat > "$COMPLETED_RUN/final.md" <<'MARKDOWN'
Outcome: failed
Trigger: github-review-comment-101
Commit: abcdef0
Validation: unit tests passed
State: .superpowers/state/loops/handled-review.md
Reply: https://github.com/better/mortgage-api/pull/12#discussion_r101
MARKDOWN
cat > "$TMP/.superpowers/runtime/active-worker.json" <<'JSON'
{
  "version": 1,
  "status": "running",
  "repo": "better/mortgage-api",
  "pr_number": 12,
  "trigger_id": "github-review-comment-101",
  "worker_pid": 999999,
  "run_dir": ".superpowers/runtime/runs/completed"
}
JSON

node "$SCRIPT" --project-root "$TMP" --fixture "$FIXTURE" --dry-run --json > "$OUT"

node - "$OUT" "$TMP" <<'NODE'
const fs = require('node:fs');
const [outPath, projectRoot] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
}

assert(data.status === 'dry_run', `expected completed lock to be cleared and dry-run to continue, got ${data.status}`);
assert(data.cleared_completed_worker === true, 'expected completed lock clearance to be reported');
assert(!fs.existsSync(`${projectRoot}/.superpowers/runtime/active-worker.json`), 'completed lock was not cleared');
assert(data.selected?.trigger_id === 'github-pr-comment-202', `expected remaining PR comment after completed lock, got ${data.selected?.trigger_id}`);
NODE

cat > "$TMP/.superpowers/runtime/active-worker.json" <<'JSON'
{
  "version": 1,
  "repo": "better/mortgage-api",
  "pr_number": 12,
  "trigger_id": "github-review-comment-999",
  "worker_pid": 999999,
  "run_dir": ".superpowers/runtime/runs/example"
}
JSON

node "$SCRIPT" --project-root "$TMP" --fixture "$FIXTURE" --dry-run --json > "$OUT"

node - "$OUT" <<'NODE'
const fs = require('node:fs');
const [outPath] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));

if (data.status !== 'worker_active') {
  console.error(`[FAIL] expected worker_active status with existing lock, got ${data.status}`);
  process.exit(1);
}
NODE

rm -f "$TMP/.superpowers/runtime/active-worker.json"
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
State: .superpowers/state/loops/fake.md
Reply: none
MARKDOWN
fi
BASH
chmod +x "$FAKEBIN/codex"

PATH="$FAKEBIN:$PATH" node "$SCRIPT" --project-root "$TMP" --fixture "$FIXTURE" --json > "$OUT"

node - "$OUT" "$TMP" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [outPath, projectRoot] = process.argv.slice(2);
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

const lockPath = path.join(projectRoot, '.superpowers/runtime/active-worker.json');
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
assert(lock.status === 'running', `expected running lock, got ${lock.status}`);
assert(lock.trigger_id === 'github-pr-comment-202', `expected lock trigger github-pr-comment-202, got ${lock.trigger_id}`);
assert(Number.isInteger(lock.worker_pid), 'expected worker_pid in lock');

const prompt = fs.readFileSync(path.join(projectRoot, lock.run_dir, 'worker-prompt.md'), 'utf8');
assert(prompt.includes('Process exactly one trigger'), 'worker prompt was not rendered from template');
assert(prompt.includes('github-pr-comment-202'), 'worker prompt missing selected trigger');
NODE

pass "pr-automation-loop program derives work, reconciles state, and respects active worker lock"
