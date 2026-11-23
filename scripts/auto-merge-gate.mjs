#!/usr/bin/env node
/**
 * Deterministic auto-merge gate.
 *
 * No model is consulted: every rule is computed from `git diff` and file names.
 * Exit code is ALWAYS 0 for analysis, so the workflow can read the verdict and
 * branch on it; `--merge` exits non-zero only when a merge was attempted and failed.
 *
 * Kill switch: merging requires `.ai/cezar/auto-merge.enabled`. Without that file
 * the gate still reports, it just never merges (shadow mode).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const PROTECTED = [
  '.github/**',
  '.ai/cezar/**',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'scripts/auto-merge-gate.mjs',
  'skills/**/scripts/**',
  'skills/**/SKILL.md',
  'evidence/**',
  'docs/**',
  'README.md',
  '.env*',
];

const TEST_PATH = /(^|\/)(test|tests|__tests__)\//;
const DOC_PATH = /(^|\/)(docs\/|README\.md$)/;
/** Generated build output is never code under review: if it shows up in a diff
 *  that is a release-flow problem, not something this gate should measure. */
const GENERATED_PATH = /(^|\/)(dist|release)\/|\.generated\.js$/;

const MAX_PROD_LINES = 200;
const MAX_PROD_FILES = 6;

/**
 * Cezar runs check nodes through `bash -lc`, which on this host is WSL's bash.
 * A worktree created by Windows git records `gitdir: S:/...` in its `.git` file,
 * and WSL's git cannot resolve that drive letter. Detect the situation and point
 * GIT_DIR/GIT_WORK_TREE at the real paths so git works from either side.
 */
function gitEnv(cwd) {
  const env = { ...process.env };
  if (process.platform !== 'win32' && /^\/mnt\/[a-z]\//i.test(cwd)) {
    const wt = cwd.replace(/\/+$/, '');
    const m = wt.match(/^(.*)[\\/]\.ai[\\/]cezar[\\/]worktrees[\\/]([^\\/]+)$/);
    if (m) {
      const repoRootPosix = m[1].replace(/\\/g, '/');
      const runId = m[2];
      const gitDir = `${repoRootPosix}/.git/worktrees/${runId}`;
      if (existsSync(gitDir)) {
        env.GIT_DIR = gitDir;
        env.GIT_WORK_TREE = wt;
      }
    }
  }
  return env;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(cwd) });
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

const PROTECTED_RES = PROTECTED.map((g) => ({ glob: g, re: globToRegExp(g) }));

function parseArgs(argv) {
  const opts = { base: 'main', merge: false, cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--merge') opts.merge = true;
    else if (a === '--base') opts.base = argv[++i];
    else if (a === '--cwd') opts.cwd = resolve(argv[++i]);
  }
  return opts;
}

function collectDiff(cwd, base) {
  const range = `${base}...HEAD`;
  const numstat = git(['diff', '--numstat', range], cwd).trim();
  const nameStatus = git(['diff', '--name-status', range], cwd).trim();

  const statusByPath = new Map();
  if (nameStatus) {
    for (const line of nameStatus.split('\n')) {
      const [status, ...rest] = line.split('\t');
      const path = rest[rest.length - 1];
      statusByPath.set(path, status[0]);
    }
  }

  const files = [];
  if (numstat) {
    for (const line of numstat.split('\n')) {
      const [adds, dels, path] = line.split('\t');
      if (path === undefined) continue;
      const status = statusByPath.get(path) ?? 'M';
      files.push({
        path,
        status,
        added: adds === '-' ? 0 : Number(adds),
        removed: dels === '-' ? 0 : Number(dels),
      });
    }
  }
  return files;
}

function evaluate(files) {
  const reasons = [];
  const notes = [];

  const deleted = files.filter((f) => f.status === 'D');
  for (const f of deleted) reasons.push(`Deletes a file: ${f.path}`);

  const touchedProtected = files.filter((f) =>
    PROTECTED_RES.some(({ re }) => re.test(f.path)),
  );
  for (const f of touchedProtected) {
    // A brand-new document is the one exception: it only adds prose.
    const isNewDoc = f.status === 'A' && DOC_PATH.test(f.path) && f.removed === 0;
    if (!isNewDoc) {
      const hit = PROTECTED_RES.find(({ re }) => re.test(f.path)).glob;
      reasons.push(`Protected path: ${f.path} (matched ${hit})`);
    }
  }

  // Editing a line is removing a line: a gate that refuses removals refuses all
  // real work. The size and file limits below are what bound the change.
  const prod = files.filter(
    (f) => !TEST_PATH.test(f.path) && !DOC_PATH.test(f.path) && !GENERATED_PATH.test(f.path),
  );
  const prodLines = prod.reduce((n, f) => n + f.added + f.removed, 0);
  if (prodLines > MAX_PROD_LINES) {
    reasons.push(`Production change ${prodLines} lines exceeds the ${MAX_PROD_LINES}-line limit`);
  }
  if (prod.length > MAX_PROD_FILES) {
    reasons.push(`Touches ${prod.length} production files, over the ${MAX_PROD_FILES}-file limit`);
  }

  // A brand-new production file is allowed only when the same task adds a test
  // file too — a new module with no new coverage is exactly the case that needs a
  // human. The size limits above still apply.
  const newProd = prod.filter((f) => f.status === 'A');
  // Extending an existing test file counts as long as nothing was removed —
  // an append-only test change cannot weaken an assertion that was already there.
  const newTests = files.filter(
    (f) => TEST_PATH.test(f.path) && (f.status === 'A' || (f.status === 'M' && f.removed === 0)),
  );
  if (newProd.length > 0 && newTests.length === 0) {
    for (const f of newProd) reasons.push(`New production file with no new test in the same task: ${f.path}`);
  }
  if (newProd.length > 0 && newTests.length > 0) {
    notes.push(`New production file(s): ${newProd.length}, accompanied by ${newTests.length} test change(s)`);
  }

  const onlyTestsOrDocs = files.length > 0 && files.every((f) => TEST_PATH.test(f.path) || DOC_PATH.test(f.path));
  if (onlyTestsOrDocs) notes.push('Change touches tests and/or docs only');

  let verdict;
  if (files.length === 0) verdict = 'ineligible:empty';
  else if (reasons.length > 0) verdict = 'ineligible';
  else if (onlyTestsOrDocs) verdict = 'eligible:test-docs';
  else verdict = 'eligible:small-src';

  return { verdict, reasons, notes, prodLines, prodFiles: prod.length };
}

function findRepoRoot(cwd) {
  return git(['rev-parse', '--show-toplevel'], cwd).trim();
}

function killSwitchOn(repoRoot) {
  return existsSync(join(repoRoot, '.ai', 'cezar', 'auto-merge.enabled'));
}

function headSha(cwd) {
  return git(['rev-parse', 'HEAD'], cwd).trim();
}

function prInfo(cwd) {
  try {
    const raw = execFileSync(
      'gh',
      ['pr', 'view', '--json', 'number,headRefOid,isDraft,state', '--jq', '.'],
      { cwd, encoding: 'utf8', env: gitEnv(cwd) },
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mergePr(cwd, number, sha) {
  try {
    // The workflow opens a DRAFT pull request on purpose, and GitHub refuses to
    // merge a draft. Marking it ready is the gate's own decision (every rule
    // already passed), not a step that needs a human.
    execFileSync('gh', ['pr', 'ready', String(number)], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env: gitEnv(cwd),
    });
    execFileSync(
      'gh',
      ['pr', 'merge', String(number), '--squash', '--match-head-commit', sha],
      { cwd, encoding: 'utf8', stdio: 'pipe', env: gitEnv(cwd) },
    );
    return { ok: true };
  } catch (err) {
    const msg = `${err.stderr ?? ''}${err.stdout ?? ''}`.trim() || err.message;
    return { ok: false, error: msg.split('\n')[0] };
  }
}

function render({ verdict, reasons, notes, prodLines, prodFiles }, { mergeEnabled, merged }) {
  const lines = [];
  const ok = verdict.startsWith('eligible');
  lines.push(`## Auto-merge gate: ${ok ? 'PASS (eligible)' : 'BLOCKED (not eligible)'}`);
  lines.push('');
  lines.push(`Verdict: \`${verdict}\``);
  lines.push('');
  lines.push(`- Production change: ${prodLines} lines / ${prodFiles} files (limits: ${MAX_PROD_LINES} / ${MAX_PROD_FILES})`);
  for (const n of notes) lines.push(`- ${n}`);
  if (reasons.length) {
    lines.push('');
    lines.push('Blocking reasons:');
    for (const r of reasons) lines.push(`- ${r}`);
  }
  lines.push('');
  lines.push(
    mergeEnabled
      ? merged === undefined
        ? 'Merge switch: **ON**'
        : merged.ok
          ? 'Merge switch: ON -> **merged**'
          : `Merge switch: ON -> merge failed: ${merged.error}`
      : 'Merge switch: **OFF (shadow mode — verdict only, never merges)**',
  );
  lines.push('');
  lines.push('> No model self-assessment is involved: every rule is computed from `git diff` and file paths.');
  return lines.join('\n');
}

function run() {
  const opts = parseArgs(process.argv.slice(2));
  const cwd = opts.cwd;
  const repoRoot = findRepoRoot(cwd);
  const files = collectDiff(cwd, opts.base);
  const result = evaluate(files);
  const enabled = killSwitchOn(repoRoot);

  let merged;
  if (opts.merge) {
    const pr = prInfo(cwd);
    if (!enabled) {
      merged = { ok: false, error: 'kill switch off' };
    } else if (!result.verdict.startsWith('eligible')) {
      merged = { ok: false, error: `ineligible (${result.verdict})` };
    } else if (!pr) {
      merged = { ok: false, error: 'no PR found for this branch' };
    } else {
      const sha = headSha(cwd);
      if (pr.headRefOid && pr.headRefOid !== sha) {
        merged = { ok: false, error: `head moved: remote ${pr.headRefOid.slice(0, 8)} vs local ${sha.slice(0, 8)}` };
      } else {
        merged = mergePr(cwd, pr.number, sha);
      }
    }
  }

  const report = render(result, { mergeEnabled: enabled, merged });
  emit(report);
  emit('');
  emit(`CEZ_GATE=${result.verdict}`);
  if (enabled && result.verdict.startsWith('eligible')) emit('CEZ_AUTOMERGE=on');
  if (merged?.ok) emit('CEZ_MERGED=1');

  // The verdict is also written where an agent step can read it verbatim: the
  // check node's stdout carries WSL's UTF-16 banner on this host, so it cannot be
  // forwarded through the run's event stream.
  try {
    // Written into this run's own worktree, so parallel runs never collide. Cezar
    // treats check-generated paths as verification residue and keeps them out of
    // later autosaves.
    const outDir = join(cwd, '.ai', 'cezar');
    writeFileSync(join(outDir, 'auto-merge-verdict.md'), `${report}\n`, 'utf8');
    writeFileSync(join(outDir, 'auto-merge-verdict.json'), `${JSON.stringify({ ...result, mergeEnabled: enabled }, null, 2)}\n`, 'utf8');
  } catch {
    // Reporting is best-effort; the exit code still decides the branch.
  }

  if (opts.merge && merged && !merged.ok) process.exit(1);
}

/**
 * Cezar pipes this stdout straight into its event stream. WSL's bash prepends a
 * UTF-16 proxy warning whose NUL bytes crash that stream ("must be a string
 * without null bytes"), so drop any control character before printing.
 */
function emit(text) {
  process.stdout.write(`${String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')}\n`);
}

try {
  run();
} catch (err) {
  // Never let an internal error look like a pass: print a readable report and
  // exit non-zero so the workflow routes to the human gate.
  emit('## Auto-merge gate: COULD NOT EVALUATE');
  emit('');
  emit('The gate itself failed; treated as "do not merge".');
  emit('');
  emit('```');
  emit(String(err.message).replace(/[\u0000-\u001f]/g, ''));
  emit('```');
  emit('');
  emit('CEZ_GATE=error');
  process.exit(1);
}
