#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const COPILOT_LOGIN = 'github-copilot[bot]';
const E2E_NAME = 'e2e tests';
const SUPERPOWERS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_TEMPLATE_PATH = path.join(SUPERPOWERS_ROOT, 'scripts', 'pr-automation-loop', 'worker-prompt-template.md');

function usage() {
  return `Usage: node scripts/pr-automation-loop.mjs [options]

Options:
  --project-root <path>   Target project root. Defaults to cwd.
  --fixture <path>        Read PR facts from JSON fixture instead of gh.
  --repo <owner/repo>     Limit live gh discovery to a repository.
  --repo-id <id>          Stable local state id. Defaults to project root name.
  --state-root <path>     Override durable loop-state root.
  --runtime-root <path>   Override automation runtime root.
  --include-drafts        Allow draft PRs to produce work items.
  --dry-run               Derive work without creating a lock or launching Codex.
  --json                  Emit JSON output.
  --log-stdout            Mirror audit events to stdout as JSONL.
  --help                  Show this help.
`;
}

function parseArgs(argv) {
  const options = {
    projectRoot: process.cwd(),
    fixture: null,
    repo: null,
    repoId: null,
    stateRoot: null,
    runtimeRoot: null,
    includeDrafts: false,
    dryRun: false,
    json: false,
    logStdout: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--project-root':
        options.projectRoot = argv[++index];
        break;
      case '--fixture':
        options.fixture = argv[++index];
        break;
      case '--repo':
        options.repo = argv[++index];
        break;
      case '--repo-id':
        options.repoId = argv[++index];
        break;
      case '--state-root':
        options.stateRoot = argv[++index];
        break;
      case '--runtime-root':
        options.runtimeRoot = argv[++index];
        break;
      case '--include-drafts':
        options.includeDrafts = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--log-stdout':
        options.logStdout = true;
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeId(value) {
  return normalizeName(value)
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '') || 'default';
}

function codexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(homedir(), '.codex');
}

function resolveStateRoots(options) {
  const repoId = normalizeId(options.repoId || path.basename(options.projectRoot));
  const superpowersRoot = path.join(codexHome(), 'superpowers');
  return {
    repoId,
    stateRoot: options.stateRoot
      ? path.resolve(options.stateRoot)
      : path.join(superpowersRoot, 'state-index', repoId),
    runtimeRoot: options.runtimeRoot
      ? path.resolve(options.runtimeRoot)
      : path.join(superpowersRoot, 'runtime', repoId),
  };
}

function isE2EName(value) {
  return normalizeName(value).includes(E2E_NAME);
}

function userLogin(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.login || value.name || '';
}

function isCopilot(value) {
  return userLogin(value) === COPILOT_LOGIN;
}

function repoName(pr) {
  if (pr.repo) return pr.repo;
  if (typeof pr.repository === 'string') return pr.repository;
  return pr.repository?.nameWithOwner || pr.repository?.fullName || pr.repository?.full_name || '';
}

function isFailedCheck(check) {
  const conclusion = normalizeName(check.conclusion || check.state);
  const status = normalizeName(check.status);
  return ['failure', 'failed', 'timed_out', 'action_required'].includes(conclusion)
    || (status === 'failure' || status === 'failed');
}

function handledOutcome(value) {
  return ['pushed', 'skipped', 'escalated'].includes(normalizeName(value));
}

function completedOutcome(value) {
  return ['pushed', 'skipped', 'escalated', 'failed'].includes(normalizeName(value));
}

function parseMarkerTriggers(text) {
  const handled = new Set();
  const markerPattern = /codex-loop\s+[^>\n]*trigger=([^\s>]+)(?:[^>\n]*outcome=([^\s>]+))?/g;
  for (const match of text.matchAll(markerPattern)) {
    if (!match[2] || handledOutcome(match[2])) {
      handled.add(match[1]);
    }
  }
  return handled;
}

function parseLoopSummaryTrigger(text) {
  const trigger = text.match(/^Trigger:\s*(\S+)/im)?.[1];
  const outcome = text.match(/^Outcome:\s*(\S+)/im)?.[1];
  if (trigger && outcome && handledOutcome(outcome)) {
    return trigger;
  }
  return null;
}

function baseWorkItem(pr, type, priority, triggerId) {
  return {
    type,
    priority,
    trigger_id: triggerId,
    repo: repoName(pr),
    pr_number: pr.number,
    pr_url: pr.url,
    head_sha: pr.head_sha || pr.headSha || pr.head?.sha || null,
    branch: pr.branch || pr.head?.ref || null,
    base: pr.base || pr.baseRefName || pr.base?.ref || null,
    worktree_path: pr.worktree_path || pr.worktreePath || null,
  };
}

function pushIfUnhandled(worklist, handledTriggers, item) {
  if (!handledTriggers.has(item.trigger_id)) {
    worklist.push(item);
  }
}

function deriveWorklist(facts, options = {}) {
  const worklist = [];
  const skipped = [];
  const prs = facts.pull_requests || facts.prs || [];
  const handledTriggers = options.handledTriggers || new Set();

  for (const pr of prs) {
    if (normalizeName(pr.state) === 'closed') continue;
    if ((pr.is_draft || pr.isDraft || pr.draft) && !options.includeDrafts) continue;

    for (const comment of pr.review_comments || pr.reviewComments || []) {
      if (!isCopilot(comment.user || comment.author)) continue;
      if (comment.resolved === true || comment.isResolved === true) continue;
      const id = comment.id || comment.databaseId;
      pushIfUnhandled(worklist, handledTriggers, {
        ...baseWorkItem(pr, 'copilot_review_comment', 1, `github-review-comment-${id}`),
        external_id: id,
        body: comment.body || '',
        path: comment.path || null,
        line: comment.line || comment.originalLine || null,
        url: comment.url || comment.html_url || null,
      });
    }

    for (const comment of pr.comments || pr.conversation_comments || pr.issueComments || []) {
      if (!isCopilot(comment.user || comment.author)) continue;
      const id = comment.id || comment.databaseId;
      pushIfUnhandled(worklist, handledTriggers, {
        ...baseWorkItem(pr, 'copilot_pr_comment', 2, `github-pr-comment-${id}`),
        external_id: id,
        body: comment.body || '',
        url: comment.url || comment.html_url || null,
      });
    }

    for (const check of pr.checks || pr.check_runs || pr.checkRuns || []) {
      if (!isFailedCheck(check)) continue;
      if (isE2EName(check.name || check.title)) {
        skipped.push({
          repo: repoName(pr),
          pr_number: pr.number,
          reason: 'e2e_tests',
          name: check.name || check.title || '',
        });
        continue;
      }

      const id = check.id || check.databaseId || normalizeName(check.name || check.title).replaceAll(/\s+/g, '-');
      pushIfUnhandled(worklist, handledTriggers, {
        ...baseWorkItem(pr, 'build_failure', 3, `github-check-${id}`),
        external_id: id,
        name: check.name || check.title || '',
        conclusion: check.conclusion || check.state || check.status || null,
        details_url: check.details_url || check.detailsUrl || check.url || null,
        buildkite: check.buildkite || null,
      });
    }
  }

  worklist.sort((a, b) => a.priority - b.priority || String(a.trigger_id).localeCompare(String(b.trigger_id)));

  return { worklist, skipped };
}

async function collectLoopStateHandledTriggers(stateRoot) {
  const handled = new Set();
  const loopsDir = path.join(stateRoot, 'loops');
  let entries;

  try {
    entries = await readdir(loopsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return handled;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const text = await readFile(path.join(loopsDir, entry.name), 'utf8');
    const trigger = parseLoopSummaryTrigger(text);
    if (trigger) handled.add(trigger);
    for (const markerTrigger of parseMarkerTriggers(text)) {
      handled.add(markerTrigger);
    }
  }

  return handled;
}

function collectGitHubMarkerHandledTriggers(facts) {
  const handled = new Set();
  const prs = facts.pull_requests || facts.prs || [];

  for (const pr of prs) {
    const comments = [
      ...(pr.review_comments || pr.reviewComments || []),
      ...(pr.comments || pr.conversation_comments || pr.issueComments || []),
    ];
    for (const comment of comments) {
      for (const trigger of parseMarkerTriggers(comment.body || '')) {
        handled.add(trigger);
      }
    }
  }

  return handled;
}

async function collectHandledTriggers(stateRoot, facts) {
  return new Set([
    ...(await collectLoopStateHandledTriggers(stateRoot)),
    ...collectGitHubMarkerHandledTriggers(facts),
  ]);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed with ${code}: ${stderr.trim()}`));
      }
    });
  });
}

async function pathExists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function commandSucceeds(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'ignore',
    });

    child.once('error', () => {
      resolve(false);
    });
    child.once('close', code => {
      resolve(code === 0);
    });
  });
}

async function checkDiscoveryRequirements(options) {
  const missing = [];

  if (!(await pathExists(options.projectRoot))) {
    missing.push({
      id: 'project_root',
      message: `Project root does not exist: ${options.projectRoot}`,
    });
  }

  if (options.fixture) {
    const fixturePath = path.resolve(options.fixture);
    if (!(await pathExists(fixturePath))) {
      missing.push({
        id: 'fixture',
        message: `Fixture file does not exist: ${fixturePath}`,
      });
    }
  } else if (!(await commandSucceeds('gh', ['--version'], { cwd: options.projectRoot }))) {
    missing.push({
      id: 'gh',
      message: 'GitHub CLI is required when --fixture is not provided.',
    });
  }

  return missing;
}

async function checkWorkerRequirements(options, selected) {
  const missing = [];
  const worktreePath = selected.worktree_path || options.projectRoot;

  if (!(await pathExists(WORKER_TEMPLATE_PATH))) {
    missing.push({
      id: 'worker_prompt_template',
      message: `Worker prompt template does not exist: ${WORKER_TEMPLATE_PATH}`,
    });
  }

  if (!(await pathExists(worktreePath))) {
    missing.push({
      id: 'worktree_path',
      message: `Worker worktree path does not exist: ${worktreePath}`,
    });
  }

  if (!(await commandSucceeds('codex', ['--version'], { cwd: options.projectRoot }))) {
    missing.push({
      id: 'codex',
      message: 'Codex CLI is required before launching a worker.',
    });
  }

  return missing;
}

async function ghJson(args, options) {
  const stdout = await runCommand('gh', args, { cwd: options.projectRoot });
  return JSON.parse(stdout || 'null');
}

async function ghPaginated(args, options) {
  const pages = await ghJson([...args, '--paginate', '--slurp'], options);
  if (!Array.isArray(pages)) return [];
  return pages;
}

function flattenArrayPages(pages) {
  return pages.flatMap(page => Array.isArray(page) ? page : []);
}

function flattenCheckRunPages(pages) {
  return pages.flatMap(page => page?.check_runs || []);
}

function ghPrToKey(pr) {
  return `${repoName(pr)}#${pr.number}`;
}

async function searchPrs(options, flag) {
  const args = [
    'search',
    'prs',
    flag,
    '@me',
    '--state',
    'open',
    '--json',
    'number,url,repository,isDraft,state',
    '--limit',
    '100',
  ];
  if (options.repo) {
    args.push('--repo', options.repo);
  }
  return ghJson(args, options);
}

async function loadLiveFacts(options) {
  const byKey = new Map();
  for (const pr of [
    ...(await searchPrs(options, '--author')),
    ...(await searchPrs(options, '--assignee')),
  ]) {
    byKey.set(ghPrToKey(pr), pr);
  }

  const pullRequests = [];
  for (const pr of byKey.values()) {
    const repo = repoName(pr);
    const number = pr.number;
    const pull = await ghJson(['api', `repos/${repo}/pulls/${number}`], options);
    const reviewComments = flattenArrayPages(await ghPaginated(['api', `repos/${repo}/pulls/${number}/comments`], options));
    const comments = flattenArrayPages(await ghPaginated(['api', `repos/${repo}/issues/${number}/comments`], options));
    const checkRuns = flattenCheckRunPages(await ghPaginated(['api', `repos/${repo}/commits/${pull.head.sha}/check-runs`], options));

    pullRequests.push({
      repo,
      number,
      url: pull.html_url || pr.url,
      state: pull.state,
      is_draft: pull.draft || pr.isDraft,
      head_sha: pull.head.sha,
      branch: pull.head.ref,
      base: pull.base.ref,
      review_comments: reviewComments.map(comment => ({
        id: comment.id,
        user: comment.user,
        body: comment.body,
        path: comment.path,
        line: comment.line,
        url: comment.html_url,
      })),
      comments: comments.map(comment => ({
        id: comment.id,
        user: comment.user,
        body: comment.body,
        url: comment.html_url,
      })),
      checks: checkRuns.map(check => ({
        id: check.id,
        name: check.name,
        conclusion: check.conclusion,
        status: check.status,
        details_url: check.details_url,
      })),
    });
  }

  return { pull_requests: pullRequests };
}

async function loadFacts(options) {
  if (options.fixture) {
    return readJson(path.resolve(options.fixture));
  }
  return loadLiveFacts(options);
}

function runtimePaths(options) {
  const runtimeDir = options.runtimeRoot;
  const lockPath = path.join(runtimeDir, 'active-worker.json');
  const runsDir = path.join(runtimeDir, 'runs');
  const auditPath = path.join(runtimeDir, 'audit.jsonl');
  return { runtimeDir, lockPath, runsDir, auditPath };
}

function resultBase(options) {
  const { auditPath } = runtimePaths(options);
  return {
    state_root: options.stateRoot,
    runtime_root: options.runtimeRoot,
    audit_log: auditPath,
  };
}

function summarizeWorkItem(item) {
  if (!item) return null;
  return {
    type: item.type,
    priority: item.priority,
    trigger_id: item.trigger_id,
    repo: item.repo,
    pr_number: item.pr_number,
    pr_url: item.pr_url,
    head_sha: item.head_sha,
    branch: item.branch,
    base: item.base,
    worktree_path: item.worktree_path,
    external_id: item.external_id,
    path: item.path,
    line: item.line,
    url: item.url,
    name: item.name,
    conclusion: item.conclusion,
    details_url: item.details_url,
  };
}

function summarizeSkippedItem(item) {
  return {
    repo: item.repo,
    pr_number: item.pr_number,
    reason: item.reason,
    name: item.name,
  };
}

function summarizeActiveWorker(activeWorker) {
  if (!activeWorker) return null;
  return {
    version: activeWorker.version,
    status: activeWorker.status,
    started_at: activeWorker.started_at,
    worker_started_at: activeWorker.worker_started_at,
    repo: activeWorker.repo,
    pr_number: activeWorker.pr_number,
    trigger_id: activeWorker.trigger_id,
    worker_pid: activeWorker.worker_pid,
    worktree_path: activeWorker.worktree_path,
    run_dir: activeWorker.run_dir,
  };
}

function errorSummary(error) {
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
  };
}

async function appendAudit(options, event, fields = {}) {
  const { runtimeDir, auditPath } = runtimePaths(options);
  await mkdir(runtimeDir, { recursive: true });
  const entry = {
    version: 1,
    timestamp: new Date().toISOString(),
    event,
    repo_id: options.repoId,
    project_root: options.projectRoot,
    state_root: options.stateRoot,
    runtime_root: options.runtimeRoot,
    ...fields,
  };
  await writeFile(auditPath, `${JSON.stringify(entry)}\n`, { flag: 'a' });
  if (options.logStdout) {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
}

async function readActiveWorker(lockPath) {
  try {
    return await readJson(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readTextIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function resolveRunDir(options, activeWorker) {
  if (!activeWorker?.run_dir) return null;
  if (path.isAbsolute(activeWorker.run_dir)) return activeWorker.run_dir;
  return path.join(options.runtimeRoot, activeWorker.run_dir);
}

function matchSummaryLine(text, label) {
  return text.match(new RegExp(`^${label}:\\s*(.+)$`, 'im'))?.[1]?.trim() || null;
}

function parseCompletionEvidence(finalText) {
  const outcome = matchSummaryLine(finalText, 'Outcome');
  if (!outcome || !completedOutcome(outcome)) return null;

  const state = matchSummaryLine(finalText, 'State');
  const reply = matchSummaryLine(finalText, 'Reply');
  const markerTriggers = [...parseMarkerTriggers(finalText)];
  const hasState = state && normalizeName(state) !== 'none';
  const hasReply = reply && normalizeName(reply) !== 'none';

  if (!hasState && !hasReply && markerTriggers.length === 0) return null;

  return {
    outcome,
    trigger: matchSummaryLine(finalText, 'Trigger'),
    commit: matchSummaryLine(finalText, 'Commit'),
    validation: matchSummaryLine(finalText, 'Validation'),
    state: hasState ? state : null,
    reply: hasReply ? reply : null,
    marker_triggers: markerTriggers,
  };
}

async function readCompletionEvidence(options, activeWorker) {
  const runDir = resolveRunDir(options, activeWorker);
  if (!runDir) return null;

  const finalText = await readTextIfExists(path.join(runDir, 'final.md'));
  if (!finalText) return null;

  return parseCompletionEvidence(finalText);
}

async function reconcileActiveWorker(options, lockPath) {
  const activeWorker = await readActiveWorker(lockPath);
  if (!activeWorker) {
    return { activeWorker: null, clearedCompletedWorker: false, clearedCompletedWorkerRecord: null, completion: null };
  }

  const completion = await readCompletionEvidence(options, activeWorker);
  if (completion) {
    await rm(lockPath, { force: true });
    return {
      activeWorker: null,
      clearedCompletedWorker: true,
      clearedCompletedWorkerRecord: activeWorker,
      completion,
    };
  }

  return { activeWorker, clearedCompletedWorker: false, clearedCompletedWorkerRecord: null, completion: null };
}

function isRecordedWorkerRunning(activeWorker) {
  if (!Number.isInteger(activeWorker?.worker_pid)) {
    return null;
  }

  try {
    process.kill(activeWorker.worker_pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    return null;
  }
}

async function maybeClearStaleHandledLock(projectRoot, lockPath, activeWorker, handledTriggers) {
  const running = isRecordedWorkerRunning(activeWorker);

  if (running === false && handledTriggers.has(activeWorker.trigger_id)) {
    await rm(lockPath, { force: true });
    return { activeWorker: null, clearedStaleWorker: true, clearedStaleWorkerRecord: activeWorker };
  }

  return { activeWorker, clearedStaleWorker: false, clearedStaleWorkerRecord: null };
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function renderTemplate(template, values) {
  return template.replaceAll(/{{([a-zA-Z0-9_]+)}}/g, (_match, key) => {
    if (!(key in values)) return '';
    return String(values[key]);
  });
}

async function writeWorkerPrompt(options, runDir, selected) {
  const template = await readFile(WORKER_TEMPLATE_PATH, 'utf8');
  const promptPath = path.join(runDir, 'worker-prompt.md');
  const entityId = `github:${selected.repo}:pull/${selected.pr_number}`;
  const entityFile = path.join(options.stateRoot, 'entities', `${selected.repo.replaceAll(/[/:]/g, '-')}-pr-${selected.pr_number}.json`);
  const worktreeId = `wt-pr-${selected.pr_number}`;
  const worktreePath = selected.worktree_path || options.projectRoot;

  const prompt = renderTemplate(template, {
    repo: selected.repo,
    pr_number: selected.pr_number,
    repo_id: options.repoId,
    state_root: options.stateRoot,
    runtime_root: options.runtimeRoot,
    entity_id: entityId,
    entity_file: entityFile,
    worktree_id: worktreeId,
    worktree_path: worktreePath,
    trigger_json: JSON.stringify(selected, null, 2),
    pr_state_summary: JSON.stringify({
      entity_id: entityId,
      head_sha: selected.head_sha,
      pr_url: selected.pr_url,
    }, null, 2),
  });

  await writeFile(promptPath, prompt);
  return { promptPath, worktreePath, entityId, entityFile, worktreeId };
}

async function acquireLock(lockPath, lock) {
  const handle = await open(lockPath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`);
  } finally {
    await handle.close();
  }
}

class ActiveWorkerLockExists extends Error {
  constructor(message) {
    super(message);
    this.name = 'ActiveWorkerLockExists';
  }
}

async function updateLock(lockPath, lock) {
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

async function launchWorker(options, selected) {
  const projectRoot = options.projectRoot;
  const { runtimeDir, lockPath, runsDir, auditPath } = runtimePaths(options);
  await mkdir(runsDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });

  const runDir = path.join(runsDir, `${timestampForPath()}-${selected.pr_number}-${selected.trigger_id}`);
  await mkdir(runDir, { recursive: true });

  const lock = {
    version: 1,
    status: 'starting',
    started_at: new Date().toISOString(),
    repo: selected.repo,
    pr_number: selected.pr_number,
    trigger_id: selected.trigger_id,
    worktree_path: selected.worktree_path || projectRoot,
    run_dir: runDir,
  };

  try {
    await acquireLock(lockPath, lock);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new ActiveWorkerLockExists('active worker lock already exists');
    }
    throw error;
  }

  try {
    const { promptPath, worktreePath } = await writeWorkerPrompt(options, runDir, selected);
    const finalPath = path.join(runDir, 'final.md');
    const stdoutPath = path.join(runDir, 'stdout.jsonl');
    const stderrPath = path.join(runDir, 'stderr.log');
    const stdoutHandle = await open(stdoutPath, 'a');
    const stderrHandle = await open(stderrPath, 'a');

    const child = spawn('codex', [
      'exec',
      '-C',
      worktreePath,
      '-a',
      'never',
      '-s',
      'danger-full-access',
      '--json',
      '--output-last-message',
      finalPath,
      '-',
    ], {
      cwd: projectRoot,
      detached: true,
      stdio: ['pipe', stdoutHandle.fd, stderrHandle.fd],
    });

    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    createReadStream(promptPath).pipe(child.stdin);
    child.unref();

    await updateLock(lockPath, {
      ...lock,
      status: 'running',
      worker_pid: child.pid,
      worker_started_at: new Date().toISOString(),
    });

    await stdoutHandle.close();
    await stderrHandle.close();

    return {
      status: 'launched',
      selected,
      lock_path: lockPath,
      state_root: options.stateRoot,
      runtime_root: options.runtimeRoot,
      audit_log: auditPath,
      run_dir: runDir,
      final_path: finalPath,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      worker_pid: child.pid,
    };
  } catch (error) {
    await rm(lockPath, { force: true });
    throw error;
  }
}

function output(result, options) {
  if (options.json) {
    const json = options.logStdout
      ? JSON.stringify(result)
      : JSON.stringify(result, null, 2);
    process.stdout.write(`${json}\n`);
  } else {
    process.stdout.write(`${result.status}\n`);
    if (result.selected) {
      process.stdout.write(`${result.selected.trigger_id}\n`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  options.projectRoot = path.resolve(options.projectRoot);
  const roots = resolveStateRoots(options);
  options.repoId = roots.repoId;
  options.stateRoot = roots.stateRoot;
  options.runtimeRoot = roots.runtimeRoot;

  await appendAudit(options, 'wake_started', {
    dry_run: options.dryRun,
    include_drafts: options.includeDrafts,
    discovery: options.fixture
      ? { mode: 'fixture', fixture: path.resolve(options.fixture) }
      : { mode: 'github', repo: options.repo || null },
  });

  const missingDiscoveryRequirements = await checkDiscoveryRequirements(options);
  if (missingDiscoveryRequirements.length > 0) {
    await appendAudit(options, 'requirements_failed', {
      phase: 'discovery',
      missing_requirements: missingDiscoveryRequirements,
    });
    output({
      ...resultBase(options),
      status: 'requirements_failed',
      missing_requirements: missingDiscoveryRequirements,
    }, options);
    return;
  }

  const { lockPath } = runtimePaths(options);
  const {
    activeWorker,
    clearedCompletedWorker,
    clearedCompletedWorkerRecord,
    completion,
  } = await reconcileActiveWorker(options, lockPath);
  if (clearedCompletedWorker) {
    await appendAudit(options, 'completed_worker_cleared', {
      active_worker: summarizeActiveWorker(clearedCompletedWorkerRecord),
      completion,
    });
  }

  const facts = await loadFacts(options);
  await appendAudit(options, 'facts_loaded', {
    pull_request_count: (facts.pull_requests || facts.prs || []).length,
  });

  const handledTriggers = await collectHandledTriggers(options.stateRoot, facts);
  let clearedStaleWorker = false;
  let clearedStaleWorkerRecord = null;

  if (activeWorker) {
    const staleResult = await maybeClearStaleHandledLock(options.projectRoot, lockPath, activeWorker, handledTriggers);
    clearedStaleWorker = staleResult.clearedStaleWorker;
    clearedStaleWorkerRecord = staleResult.clearedStaleWorkerRecord;
    if (clearedStaleWorker) {
      await appendAudit(options, 'stale_worker_cleared', {
        active_worker: summarizeActiveWorker(clearedStaleWorkerRecord),
        handled_trigger_count: handledTriggers.size,
      });
    }

    if (staleResult.activeWorker) {
      await appendAudit(options, 'worker_active', {
        reason: 'active_lock',
        active_worker: summarizeActiveWorker(staleResult.activeWorker),
      });
      output({
        ...resultBase(options),
        status: 'worker_active',
        active_worker: staleResult.activeWorker,
        lock_path: lockPath,
      }, options);
      return;
    }
  }

  const { worklist, skipped } = deriveWorklist(facts, { ...options, handledTriggers });
  const selected = worklist[0] || null;
  await appendAudit(options, 'worklist_derived', {
    handled_trigger_count: handledTriggers.size,
    worklist_count: worklist.length,
    skipped_e2e_count: skipped.length,
    selected: summarizeWorkItem(selected),
    worklist: worklist.map(summarizeWorkItem),
    skipped: skipped.map(summarizeSkippedItem),
  });

  if (!selected) {
    await appendAudit(options, 'no_work', {
      worklist_count: 0,
      skipped_e2e_count: skipped.length,
      cleared_completed_worker: clearedCompletedWorker,
      cleared_stale_worker: clearedStaleWorker,
    });
    output({
      ...resultBase(options),
      status: 'no_work',
      worklist_count: 0,
      skipped_e2e_count: skipped.length,
      cleared_completed_worker: clearedCompletedWorker,
      cleared_stale_worker: clearedStaleWorker,
    }, options);
    return;
  }

  if (options.dryRun) {
    await appendAudit(options, 'dry_run', {
      worklist_count: worklist.length,
      skipped_e2e_count: skipped.length,
      selected: summarizeWorkItem(selected),
      cleared_completed_worker: clearedCompletedWorker,
      cleared_stale_worker: clearedStaleWorker,
    });
    output({
      ...resultBase(options),
      status: 'dry_run',
      worklist_count: worklist.length,
      skipped_e2e_count: skipped.length,
      cleared_completed_worker: clearedCompletedWorker,
      cleared_stale_worker: clearedStaleWorker,
      selected,
      worklist,
      skipped,
    }, options);
    return;
  }

  const missingWorkerRequirements = await checkWorkerRequirements(options, selected);
  if (missingWorkerRequirements.length > 0) {
    await appendAudit(options, 'requirements_failed', {
      phase: 'worker',
      worklist_count: worklist.length,
      skipped_e2e_count: skipped.length,
      selected: summarizeWorkItem(selected),
      missing_requirements: missingWorkerRequirements,
      cleared_completed_worker: clearedCompletedWorker,
      cleared_stale_worker: clearedStaleWorker,
    });
    output({
      ...resultBase(options),
      status: 'requirements_failed',
      worklist_count: worklist.length,
      skipped_e2e_count: skipped.length,
      cleared_completed_worker: clearedCompletedWorker,
      cleared_stale_worker: clearedStaleWorker,
      selected,
      missing_requirements: missingWorkerRequirements,
    }, options);
    return;
  }

  try {
    await appendAudit(options, 'worker_launching', {
      worklist_count: worklist.length,
      skipped_e2e_count: skipped.length,
      selected: summarizeWorkItem(selected),
    });
    const launchResult = await launchWorker(options, selected);
    await appendAudit(options, 'worker_launched', {
      selected: summarizeWorkItem(selected),
      lock_path: launchResult.lock_path,
      run_dir: launchResult.run_dir,
      final_path: launchResult.final_path,
      stdout_path: launchResult.stdout_path,
      stderr_path: launchResult.stderr_path,
      worker_pid: launchResult.worker_pid,
    });
    output(launchResult, options);
  } catch (error) {
    if (error instanceof ActiveWorkerLockExists) {
      const activeWorkerAfterRace = await readActiveWorker(lockPath);
      await appendAudit(options, 'worker_active', {
        reason: 'lock_race',
        active_worker: summarizeActiveWorker(activeWorkerAfterRace),
      });
      output({
        ...resultBase(options),
        status: 'worker_active',
        active_worker: activeWorkerAfterRace,
        lock_path: lockPath,
      }, options);
      return;
    }
    await appendAudit(options, 'worker_launch_failed', {
      selected: summarizeWorkItem(selected),
      error: errorSummary(error),
    });
    throw error;
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
