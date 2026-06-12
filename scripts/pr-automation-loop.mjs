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
  --include-drafts        Allow draft PRs to produce work items.
  --dry-run               Derive work without creating a lock or launching Codex.
  --json                  Emit JSON output.
  --help                  Show this help.
`;
}

function parseArgs(argv) {
  const options = {
    projectRoot: process.cwd(),
    fixture: null,
    repo: null,
    includeDrafts: false,
    dryRun: false,
    json: false,
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
      case '--include-drafts':
        options.includeDrafts = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--json':
        options.json = true;
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

async function collectLoopStateHandledTriggers(projectRoot) {
  const handled = new Set();
  const loopsDir = path.join(projectRoot, '.superpowers', 'state', 'loops');
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

async function collectHandledTriggers(projectRoot, facts) {
  return new Set([
    ...(await collectLoopStateHandledTriggers(projectRoot)),
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

function runtimePaths(projectRoot) {
  const runtimeDir = path.join(projectRoot, '.superpowers', 'runtime');
  const lockPath = path.join(runtimeDir, 'active-worker.json');
  const runsDir = path.join(runtimeDir, 'runs');
  return { runtimeDir, lockPath, runsDir };
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

function resolveRunDir(projectRoot, activeWorker) {
  if (!activeWorker?.run_dir) return null;
  if (path.isAbsolute(activeWorker.run_dir)) return activeWorker.run_dir;
  return path.join(projectRoot, activeWorker.run_dir);
}

async function hasCompletionEvidence(projectRoot, activeWorker) {
  const runDir = resolveRunDir(projectRoot, activeWorker);
  if (!runDir) return false;

  const finalText = await readTextIfExists(path.join(runDir, 'final.md'));
  if (!finalText) return false;

  const outcome = finalText.match(/^Outcome:\s*(\S+)/im)?.[1];
  if (!outcome || !completedOutcome(outcome)) return false;

  const state = finalText.match(/^State:\s*(.+)$/im)?.[1]?.trim();
  const reply = finalText.match(/^Reply:\s*(.+)$/im)?.[1]?.trim();
  const hasState = state && normalizeName(state) !== 'none';
  const hasReply = reply && normalizeName(reply) !== 'none';

  return Boolean(hasState || hasReply || parseMarkerTriggers(finalText).size > 0);
}

async function reconcileActiveWorker(projectRoot, lockPath) {
  const activeWorker = await readActiveWorker(lockPath);
  if (!activeWorker) {
    return { activeWorker: null, clearedCompletedWorker: false };
  }

  if (await hasCompletionEvidence(projectRoot, activeWorker)) {
    await rm(lockPath, { force: true });
    return { activeWorker: null, clearedCompletedWorker: true };
  }

  return { activeWorker, clearedCompletedWorker: false };
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
    return { activeWorker: null, clearedStaleWorker: true };
  }

  return { activeWorker, clearedStaleWorker: false };
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

async function writeWorkerPrompt(projectRoot, runDir, selected) {
  const template = await readFile(WORKER_TEMPLATE_PATH, 'utf8');
  const promptPath = path.join(runDir, 'worker-prompt.md');
  const entityId = `github:${selected.repo}:pull/${selected.pr_number}`;
  const entityFile = `.superpowers/state/entities/${selected.repo.replaceAll(/[/:]/g, '-')}-pr-${selected.pr_number}.json`;
  const worktreeId = `wt-pr-${selected.pr_number}`;
  const worktreePath = selected.worktree_path || projectRoot;

  const prompt = renderTemplate(template, {
    repo: selected.repo,
    pr_number: selected.pr_number,
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
  const { runtimeDir, lockPath, runsDir } = runtimePaths(projectRoot);
  await mkdir(runsDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });

  const runDirRel = path.join('.superpowers', 'runtime', 'runs', `${timestampForPath()}-${selected.pr_number}-${selected.trigger_id}`);
  const runDir = path.join(projectRoot, runDirRel);
  await mkdir(runDir, { recursive: true });

  const lock = {
    version: 1,
    status: 'starting',
    started_at: new Date().toISOString(),
    repo: selected.repo,
    pr_number: selected.pr_number,
    trigger_id: selected.trigger_id,
    worktree_path: selected.worktree_path || projectRoot,
    run_dir: runDirRel,
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
    const { promptPath, worktreePath } = await writeWorkerPrompt(projectRoot, runDir, selected);
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
      run_dir: runDirRel,
      worker_pid: child.pid,
    };
  } catch (error) {
    await rm(lockPath, { force: true });
    throw error;
  }
}

function output(result, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
  const missingDiscoveryRequirements = await checkDiscoveryRequirements(options);
  if (missingDiscoveryRequirements.length > 0) {
    output({
      status: 'requirements_failed',
      missing_requirements: missingDiscoveryRequirements,
    }, options);
    return;
  }

  const { lockPath } = runtimePaths(options.projectRoot);
  const { activeWorker, clearedCompletedWorker } = await reconcileActiveWorker(options.projectRoot, lockPath);
  const facts = await loadFacts(options);
  const handledTriggers = await collectHandledTriggers(options.projectRoot, facts);
  let clearedStaleWorker = false;

  if (activeWorker) {
    const staleResult = await maybeClearStaleHandledLock(options.projectRoot, lockPath, activeWorker, handledTriggers);
    clearedStaleWorker = staleResult.clearedStaleWorker;

    if (staleResult.activeWorker) {
      output({
        status: 'worker_active',
        active_worker: staleResult.activeWorker,
        lock_path: lockPath,
      }, options);
      return;
    }
  }

  const { worklist, skipped } = deriveWorklist(facts, { ...options, handledTriggers });
  const selected = worklist[0] || null;

  if (!selected) {
    output({
      status: 'no_work',
      worklist_count: 0,
      skipped_e2e_count: skipped.length,
      cleared_completed_worker: clearedCompletedWorker,
      cleared_stale_worker: clearedStaleWorker,
    }, options);
    return;
  }

  if (options.dryRun) {
    output({
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
    output({
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
    output(await launchWorker(options, selected), options);
  } catch (error) {
    if (error instanceof ActiveWorkerLockExists) {
      output({
        status: 'worker_active',
        active_worker: await readActiveWorker(lockPath),
        lock_path: lockPath,
      }, options);
      return;
    }
    throw error;
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
