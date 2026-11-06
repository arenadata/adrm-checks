#!/usr/bin/env node
// Lost commits: the commits of older line branches (sources) that the current line branch lacks, classified layer by
// layer; lost-commits.json (ADRM lost-commits v1) for mode=history.
//
//   upstream  upstream.json: the wrapper's upstream_repository, else the root of the fork network (GitHub API
//             `source`), else none.
//   classify  history.json. The candidates of a source are the commits reachable from it, not from the current
//             branch and not from any upstream tag in the clone. Each candidate gets the verdict of the first layer
//             that applies: empty commit, revert on the current branch, branch-local paths, patch-id, cherry-pick
//             trailers, revert pairs, upstream ticket in the upstream base, version bookkeeping, merge-tree, series,
//             hunks. Merges above the upstream base with changes of their own go to review. Needs a full clone and
//             Git 2.40+; writes no refs and no worktree (merge-tree only adds objects).
//   report    lost-commits.json: history.json in the ADRM envelope; inputs from the environment, as for `line`.
//
// Node >= 20, no dependencies. Exit codes: 0 also when the state is error, 2 for errors of the script, 64 for usage.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs, readBranchDispatch, dispatchGate, SHA } from './lib/contract.mjs';

const REPORT_LIMIT = 16 * 1024 * 1024;
const MAX_ERRORS = 100;
const CANDIDATE_LIMIT = 3000;
const SERIES_WINDOW = 10;
const LIST_LIMIT = 20;
const MIN_GIT = [2, 40];
const DEFAULT_BRANCH_LOCAL = ['.github/', '.readiness/'];
const STATES = ['complete', 'partial', 'error'];
const VERDICTS = [
  'lost', 'review:diverged', 'review:diverged-ticket-present', 'review:ticket-present-content-missing', 'review:merge-resolution', 'review:unclassified',
  'expected:reverted-in-current', 'expected:branch-local', 'expected:version-bookkeeping',
  'neutral:empty', 'neutral:revert-pair',
  'present:patch-id', 'present:cherry-pick-trailer', 'present:original-in-current', 'present:upstream-ticket-in-base', 'present:content', 'present:content-as-series', 'present:hunks',
];
// Errors after which the report carries no findings.
const FATAL = new Set(['INPUT_INVALID', 'HEAD_CHANGED', 'CHECKER_CHANGED', 'CHECKER_SETUP_ERROR', 'GIT_TOO_OLD', 'SHALLOW_HISTORY', 'UPSTREAM_UNAVAILABLE', 'CANDIDATE_LIMIT', 'CLASSIFY_ERROR', 'REPORT_TOO_LARGE']);
// Ticket keys (ADH-8490, HADOOP-18867); the number must not continue (CVE-2021-44228), and common non-ticket tokens
// (UTF-8, SHA-256, ISO-8601, TLS-1) never count.
const TICKET = /\b([A-Z][A-Z0-9]{1,15})-([1-9][0-9]{0,6})\b(?![-.]?[0-9])/g;
const NOT_TICKETS = new Set(['AES', 'AGPL', 'ASF', 'BSD', 'CP', 'CVE', 'CWE', 'ECMA', 'ES', 'GHSA', 'GPL', 'HTTP', 'HTTPS', 'IPV', 'ISO', 'JEP', 'JSR', 'LGPL', 'MD', 'MIT', 'PEP', 'RFC', 'RSA', 'SHA', 'SSL', 'TLS', 'UCS', 'UTF', 'WIN', 'X86']);
const BUILD_FILE = /(^|\/)(pom\.xml|version\.txt|gradle\.properties|build\.gradle(\.kts)?|version\.sbt|build\.sbt|package\.json|libs\.versions\.toml)$/;
const VERSION_LINE = /(<version>|version\s*[=:]|\.version>|[-_.]version\s*=)/i;
// The project's own release versions, shaped like the ADRM version template (base-product-fix, optionally with a
// suffix) or snapshots; a dependency version (guava.version) is a real change.
const RELEASE_VALUE = /\d+(\.\d+)+-\d+(\.\d+)+-\d+([-._][A-Za-z0-9]+)*|SNAPSHOT/;
const CHERRY_PICKED = /cherry picked from commit ([0-9a-f]{7,40})/g;
const REVERTS = /This reverts commit ([0-9a-f]{7,40})/g;

// ---------- helpers ----------
const lines = textValue => textValue.split('\n').filter(Boolean);
const text = v => typeof v === 'string' ? v : v == null ? '' : String(v);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const uniqueSorted = items => [...new Set(items)].sort(cmp);
function pushError(errors, code, message, retryable = false) {
  if (errors.length >= MAX_ERRORS || errors.some(e => e.code === code)) return;
  errors.push({ code, message: String(message).slice(0, 4096), retryable });
}
function writeJson(file, value) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); }
function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function emptyCounts() { return { findings: 0, commits: 0, merges: 0, lost: 0, review: 0, expected: 0, neutral: 0, present: 0, byVerdict: {} }; }
function emptyHistory(errors = []) { return { state: 'error', upstream: null, current: null, sources: [], findings: [], counts: emptyCounts(), durationMs: 0, errors }; }
const verdictClass = verdict => verdict === 'lost' ? 'lost' : verdict.split(':')[0];
function countFindings(findings) {
  const counts = emptyCounts();
  for (const f of findings) {
    counts.findings++;
    counts[f.kind === 'merge' ? 'merges' : 'commits']++;
    counts[verdictClass(f.verdict)]++;
    counts.byVerdict[f.verdict] = (counts.byVerdict[f.verdict] ?? 0) + 1;
  }
  counts.byVerdict = Object.fromEntries(Object.entries(counts.byVerdict).sort(([a], [b]) => cmp(a, b)));
  return counts;
}
function tickets(message) {
  const keys = [];
  for (const m of text(message).matchAll(TICKET)) if (!NOT_TICKETS.has(m[1])) keys.push(`${m[1]}-${m[2]}`);
  return keys;
}
const prefixOf = key => key.replace(/-\d+$/, '');
/** `<branch>@<sha>` (sha optional); the branch is a plain branch name as ADRM sends it. */
function parseRefSpec(spec) {
  const value = text(spec).trim();
  const m = /^(.+)@([0-9a-f]{40})$/.exec(value);
  const branch = m ? m[1] : value;
  const valid = branch.length > 0 && branch.length <= 256 && !branch.startsWith('refs/') && !branch.startsWith('-') && !/[\s~^:?*[\\]|\.\.|@\{|\/\/|\/$|\.lock$|^\/|\.$/.test(branch);
  return { branch, sha: m ? m[2] : null, valid };
}
/** Lines of `<branch>@<sha>`; blank lines and `#` comments are skipped. */
function parseRefLines(value) {
  const specs = [], invalid = [];
  for (const raw of text(value).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const spec = parseRefSpec(line);
    if (!spec.valid || !spec.sha) invalid.push(line.slice(0, 300)); else specs.push(spec);
  }
  return { specs, invalid };
}
function branchLocalMatcher(extra) {
  const prefixes = uniqueSorted([...DEFAULT_BRANCH_LOCAL, ...text(extra).split(/[\n,]/).map(p => p.trim().replace(/^\.\//, '')).filter(Boolean)]);
  return { prefixes, test: path => prefixes.some(p => p.endsWith('/') ? path.startsWith(p) : path === p || path.startsWith(`${p}/`)) };
}

// ---------- git ----------
function gitRunner(repo) {
  const base = ['-C', repo, '-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.renames=true', '-c', 'diff.algorithm=default', '-c', 'color.ui=false', '-c', 'log.showSignature=false'];
  const run = (args, { input, allow = [0] } = {}) => {
    const r = spawnSync('git', [...base, ...args], { encoding: 'utf8', input, maxBuffer: 1 << 30, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
    if (r.error) throw r.error;
    if (!allow.includes(r.status)) { const e = new Error(`git ${args[0]} exited with ${r.status}: ${text(r.stderr).trim().slice(0, 500)}`); e.status = r.status; throw e; }
    return r;
  };
  const out = (args, opts) => run(args, opts).stdout;
  const ok = args => run(args, { allow: [0, 1, 128] }).status === 0;
  /** sha -> patch-id from `git log|show ... | git patch-id --stable`, piped through sh to keep large diffs out of memory.
   * `shas` go to stdin (log --stdin); an empty list returns an empty map unless `always` is set. */
  const patchIds = (args, shas, always = false) => {
    const map = new Map();
    if (!shas.length && !always) return map;
    const r = spawnSync('sh', ['-c', 'git "$@" | git patch-id --stable', 'sh', ...base, ...args], { encoding: 'utf8', input: shas.join('\n') + '\n', maxBuffer: 1 << 28, env: { ...process.env, LC_ALL: 'C' } });
    if (r.error || r.status !== 0) throw new Error(`git patch-id failed: ${text(r.stderr).trim().slice(0, 500)}`);
    for (const line of lines(r.stdout)) { const [pid, sha] = line.split(' '); if (pid && sha) map.set(sha, pid); }
    return map;
  };
  return { run, out, ok, patchIds };
}
const LOG_PATCH = ['log', '--no-walk=unsorted', '--stdin', '-p', '--no-color', '--no-ext-diff', '--no-textconv', '--format=commit %H'];

function gitVersion() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text(r.stdout));
  return m ? { text: `${m[1]}.${m[2]}.${m[3] ?? 0}`, major: Number(m[1]), minor: Number(m[2]) } : null;
}

/** Upstream release tags present in the clone: `git ls-remote --tags`, annotated tags peeled to commits. */
function upstreamTags(g, url) {
  const r = spawnSync('git', ['ls-remote', '--tags', url], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 180000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
  if (r.error || r.status !== 0) { const e = new Error(text(r.stderr).trim().slice(0, 300) || (r.error ? r.error.message : `exit ${r.status}`)); e.upstream = true; throw e; }
  const peeled = new Map();
  for (const line of lines(r.stdout)) {
    const [sha, ref] = line.split('\t');
    if (!ref || !ref.startsWith('refs/tags/') || !SHA.test(sha)) continue;
    const name = ref.slice('refs/tags/'.length).replace(/\^\{\}$/, '');
    if (ref.endsWith('^{}') || !peeled.has(name)) peeled.set(name, sha);
  }
  const shas = uniqueSorted([...peeled.values()]);
  const present = new Set(shas.length ? lines(g.out(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: shas.join('\n') + '\n' })).filter(l => l.endsWith(' commit')).map(l => l.split(' ')[0]) : []);
  const names = new Map();
  for (const [name, sha] of peeled) if (present.has(sha)) names.set(sha, [...(names.get(sha) ?? []), name]);
  for (const list of names.values()) list.sort(cmp);
  return { total: peeled.size, shas: [...present].sort(cmp), names };
}

// ---------- classify ----------
function classify(opts) {
  const started = Date.now();
  const outPath = resolve(opts.out || 'history.json');
  const history = emptyHistory();
  const fail = (code, message, retryable = false) => { pushError(history.errors, code, message, retryable); };
  const finish = () => {
    const unknown = history.findings.filter(f => !VERDICTS.includes(f.verdict));
    if (unknown.length) fail('CLASSIFY_ERROR', `The classifier produced unknown verdicts: ${uniqueSorted(unknown.map(f => f.verdict)).join(', ')}.`);
    const fatal = history.errors.some(e => FATAL.has(e.code));
    if (fatal) history.findings = [];
    history.counts = countFindings(history.findings);
    history.state = fatal ? 'error' : history.errors.length ? 'partial' : 'complete';
    history.durationMs = Date.now() - started;
    writeJson(outPath, history);
    console.error(`history written to ${outPath}: ${JSON.stringify({ state: history.state, sources: history.sources.map(s => `${s.ref} ${s.state} ${s.candidates}`), ...history.counts, byVerdict: undefined, errors: history.errors.map(e => e.code), seconds: Math.round(history.durationMs / 1000) })}`);
  };
  try {
    classifyInto(opts, history, fail);
  } catch (error) {
    fail('CLASSIFY_ERROR', `The classifier failed: ${error.message}`, true);
  }
  finish();
}

function classifyInto(opts, history, fail) {
  const repo = resolve(opts.repo || '.');
  const remote = text(opts.remote) || 'origin';
  const g = gitRunner(repo);
  const local = branchLocalMatcher(opts['branch-local']);
  const keyMin = Number(opts['upstream-key-min'] ?? 20);

  // Upstream: the resolved upstream.json of the job, or flags for local use.
  let upstream = { repository: null, source: 'none', url: null, error: null };
  if (opts['upstream-file']) {
    try { const u = readJson(resolve(opts['upstream-file'])); upstream = { repository: u.repository ?? null, source: u.source ?? 'none', url: u.url ?? null, error: u.error ?? null }; }
    catch (error) { upstream = { repository: null, source: 'none', url: null, error: { code: 'UPSTREAM_UNAVAILABLE', message: `upstream.json could not be read: ${error.message}` } }; }
  } else if (opts['upstream-url']) {
    upstream = { repository: text(opts['upstream-repository']) || text(opts['upstream-url']).replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, ''), source: text(opts['upstream-source']) || 'wrapper', url: text(opts['upstream-url']), error: null };
  }
  history.upstream = { repository: upstream.repository, source: upstream.source, releaseTags: 0 };

  const version = gitVersion();
  if (!version || version.major < MIN_GIT[0] || (version.major === MIN_GIT[0] && version.minor < MIN_GIT[1])) { fail('GIT_TOO_OLD', `Git ${MIN_GIT.join('.')} or newer is required (merge-tree --merge-base); the runner has ${version?.text ?? 'an unknown version'}.`); return; }
  if (g.out(['rev-parse', '--is-shallow-repository']).trim() === 'true') { fail('SHALLOW_HISTORY', 'The clone is shallow: lost commits need the whole history (checkout with fetch-depth: 0).'); return; }

  // The current branch: `<branch>@<sha>` from the job, or a branch name for local use.
  const currentSpec = parseRefSpec(opts.current);
  if (!currentSpec.valid) { fail('INPUT_INVALID', `Invalid current branch: ${text(opts.current).slice(0, 300) || '(empty)'}.`); return; }
  const resolveBranch = branch => {
    for (const ref of [`refs/remotes/${remote}/${branch}`, `refs/heads/${branch}`]) {
      const r = g.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allow: [0, 1, 128] });
      if (r.status === 0) return r.stdout.trim();
    }
    return null;
  };
  const hasCommit = sha => g.ok(['cat-file', '-e', `${sha}^{commit}`]);
  const currentSha = currentSpec.sha ?? resolveBranch(currentSpec.branch);
  if (!currentSha || !hasCommit(currentSha)) { fail('INPUT_INVALID', `The commit of the current branch ${currentSpec.branch} is not in the clone.`); return; }
  history.current = { ref: `refs/heads/${currentSpec.branch}`, sha: currentSha, upstreamBaseTags: [] };

  // Sources: a file of `<branch>@<sha>` lines (the compare_refs input) and/or a comma list for local use, where a
  // branch without `@<sha>` is taken at its current head.
  const NONE = '0'.repeat(40);
  const listed = text(opts.sources).split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const spec = parseRefSpec(s);
    return spec.valid && !spec.sha ? `${spec.branch}@${resolveBranch(spec.branch) ?? NONE}` : s;
  });
  const parsed = parseRefLines([opts['sources-file'] ? readFileSync(resolve(opts['sources-file']), 'utf8') : '', ...listed].join('\n'));
  if (parsed.invalid.length) { fail('INPUT_INVALID', `Invalid compare_refs lines: ${parsed.invalid.slice(0, 5).join('; ')}.`); return; }
  const specs = [...new Map(parsed.specs.filter(s => s.branch !== currentSpec.branch).map(s => [s.branch, s])).values()].sort((a, b) => cmp(a.branch, b.branch));
  const sources = specs.map(spec => {
    const head = resolveBranch(spec.branch);
    const present = spec.sha !== NONE && hasCommit(spec.sha);
    const state = head === null ? 'missing' : head === spec.sha ? 'resolved' : 'changed';
    return { ref: `refs/heads/${spec.branch}`, sha: spec.sha, headSha: head, state, evaluated: present, notInCurrent: 0, aboveUpstreamBase: 0, upstreamDrift: 0, candidates: 0, merges: 0, mergesWithChanges: 0, upstreamBaseTags: [] };
  });
  history.sources = sources;
  const moved = sources.filter(s => s.state === 'changed' && s.evaluated), gone = sources.filter(s => !s.evaluated || s.state === 'missing');
  if (gone.length) fail('SOURCE_MISSING', `Predecessor branches not found${gone.some(s => !s.evaluated) ? ', their commits are not in the clone' : ''}: ${gone.map(s => s.ref.slice(11)).join(', ')}.`, true);
  if (moved.length) fail('SOURCE_CHANGED', `Predecessor branches moved after the request; the requested heads were checked: ${moved.map(s => s.ref.slice(11)).join(', ')}.`, true);

  // Upstream release tags present in the clone.
  let tags = { total: 0, shas: [], names: new Map() };
  if (upstream.error) { fail(upstream.error.code === 'INPUT_INVALID' ? 'INPUT_INVALID' : 'UPSTREAM_UNAVAILABLE', upstream.error.message || 'The upstream repository is unavailable.', upstream.error.code !== 'INPUT_INVALID'); return; }
  if (upstream.url) {
    try { tags = upstreamTags(g, upstream.url); }
    catch (error) { fail('UPSTREAM_UNAVAILABLE', `The tags of the upstream repository ${upstream.repository ?? upstream.url} could not be fetched: ${error.message}`, true); return; }
  }
  history.upstream.releaseTags = tags.shas.length;
  const timings = {};
  const timed = (name, fn) => { const t = Date.now(); try { return fn(); } finally { timings[name] = (timings[name] ?? 0) + Date.now() - t; } };
  const ancestors = sha => new Set(lines(g.out(['rev-list', sha])));
  const tagNames = shas => uniqueSorted(shas.flatMap(sha => tags.names.get(sha) ?? []));
  /** Upstream tags that are ancestors of a commit, and the newest of them (independent tips) by name. */
  const baseOf = sha => {
    const reach = timed('ancestors', () => ancestors(sha));
    const base = tags.shas.filter(t => reach.has(t));
    const tips = base.length ? lines(g.out(['merge-base', '--independent', ...base])).sort(cmp) : [];
    return { base, tips, names: tagNames(tips).slice(0, 10) };
  };
  const currentReach = timed('ancestors', () => ancestors(currentSha));
  const currentBase = tags.shas.filter(t => currentReach.has(t));
  const currentTips = currentBase.length ? lines(g.out(['merge-base', '--independent', ...currentBase])).sort(cmp) : [];
  history.current.upstreamBaseTags = tagNames(currentTips).slice(0, 10);
  const revList = (args, revs) => lines(g.out(['rev-list', ...args, '--stdin'], { input: revs.join('\n') + '\n' }));

  // Candidates of every source: reachable from it, not from the current branch, not from any upstream tag.
  const exclusions = [`^${currentSha}`, ...tags.shas.map(s => `^${s}`)];
  const perSource = new Map(), owners = new Map(), mergeOwners = new Map(), sourceBases = [];
  for (const source of sources.filter(s => s.evaluated)) {
    const base = baseOf(source.sha);
    sourceBases.push(...base.tips);
    source.upstreamBaseTags = base.names;
    source.notInCurrent = Number(g.out(['rev-list', '--count', source.sha, `^${currentSha}`]).trim());
    const listing = timed('candidates', () => revList(['--topo-order', '--reverse', '--parents'], [source.sha, ...exclusions]));
    const byAncestorTags = base.base.length < tags.shas.length ? Number(g.out(['rev-list', '--count', '--stdin'], { input: [source.sha, `^${currentSha}`, ...base.tips.map(s => `^${s}`)].join('\n') + '\n' }).trim()) : listing.length;
    source.aboveUpstreamBase = listing.length;
    source.upstreamDrift = Math.max(0, byAncestorTags - listing.length);
    const commits = [], merges = [];
    for (const line of listing) { const [sha, ...parents] = line.split(' '); (parents.length > 1 ? merges : commits).push(sha); }
    source.candidates = commits.length;
    source.merges = merges.length;
    perSource.set(source.ref, { source, commits, merges });
    for (const sha of commits) owners.set(sha, [...(owners.get(sha) ?? []), source.ref]);
    for (const sha of merges) mergeOwners.set(sha, [...(mergeOwners.get(sha) ?? []), source.ref]);
  }
  // Without an upstream base the candidates may include upstream history; a source without candidates is unaffected
  // (its commits are all in the current branch already).
  const unbased = sources.filter(s => s.evaluated && s.aboveUpstreamBase > 0 && !s.upstreamBaseTags.length);
  if (upstream.url && unbased.length) fail('UPSTREAM_BASE_UNTAGGED', tags.shas.length
    ? `No upstream release tag is an ancestor of ${unbased.map(s => s.ref.slice(11)).join(', ')}: the upstream base is unknown, upstream commits may count as candidates.`
    : `No tag of the upstream repository ${upstream.repository ?? upstream.url} is in the history of the clone (${tags.total} upstream tags): the upstream base is unknown, upstream commits may count as candidates.`);
  if (owners.size + mergeOwners.size > CANDIDATE_LIMIT) { fail('CANDIDATE_LIMIT', `${owners.size + mergeOwners.size} candidates, more than ${CANDIDATE_LIMIT}: the upstream base is probably unknown (check upstream_repository) or the branches belong to different lines.`); return; }
  const candidates = [...owners.keys()];

  // Commit data of the candidates, in batches.
  const info = new Map();
  if (candidates.length) {
    const raw = g.out(['log', '--no-walk=unsorted', '--stdin', '--format=%x01%H%x00%P%x00%an%x00%as%x00%s%x00%B'], { input: candidates.join('\n') + '\n' });
    for (const entry of raw.split('\x01').slice(1)) {
      const [sha, parents, author, date, subject, body] = entry.split('\x00');
      info.set(sha, { sha, parents: lines(parents.replace(/ /g, '\n')), author, date, subject, body: text(body).replace(/\n+$/, '') });
    }
    const files = g.out(['log', '--no-walk=unsorted', '--stdin', '--format=%x01%H', '--name-only', '--no-renames'], { input: candidates.join('\n') + '\n' });
    for (const entry of files.split('\x01').slice(1)) { const [sha, ...names] = lines(entry); const item = info.get(sha); if (item) item.files = names; }
  }
  const pids = timed('patch-id', () => g.patchIds(LOG_PATCH, candidates));

  // The current branch side: its commits above its upstream base and above the merge bases with the sources.
  const currentSide = new Set();
  timed('current side', () => {
    for (const { source, commits, merges } of perSource.values()) {
      if (!commits.length && !merges.length) continue;
      const bases = lines(g.run(['merge-base', '--all', currentSha, source.sha], { allow: [0, 1] }).stdout);
      for (const sha of revList(['--no-merges'], [currentSha, ...bases.map(b => `^${b}`), ...currentTips.map(t => `^${t}`)])) currentSide.add(sha);
    }
  });
  const sideList = [...currentSide];
  const sidePids = timed('patch-id', () => g.patchIds(LOG_PATCH, sideList));
  const pidToCurrent = new Map();
  for (const sha of sideList) { const pid = sidePids.get(sha); if (pid && !pidToCurrent.has(pid)) pidToCurrent.set(pid, sha); }
  const picks = new Map(), revertTargets = [];
  if (sideList.length) {
    for (const entry of g.out(['log', '--no-walk=unsorted', '--stdin', '--format=%x01%H%x00%B'], { input: sideList.join('\n') + '\n' }).split('\x01').slice(1)) {
      const [sha, body] = entry.split('\x00');
      for (const m of text(body).matchAll(CHERRY_PICKED)) if (!picks.has(m[1])) picks.set(m[1], sha);
      for (const m of text(body).matchAll(REVERTS)) revertTargets.push(m[1]);
    }
  }
  const resolveCommit = prefix => { const r = g.run(['rev-parse', '--verify', '--quiet', `${prefix}^{commit}`], { allow: [0, 1, 128] }); return r.status === 0 ? r.stdout.trim() : null; };
  const revertedShas = uniqueSorted(revertTargets.map(resolveCommit).filter(Boolean));
  const revertedPids = new Set(g.patchIds(LOG_PATCH, revertedShas).values());
  const pickedInCurrent = sha => picks.get(sha) ?? [...picks.entries()].find(([k]) => k.length < 40 && sha.startsWith(k))?.[1] ?? null;

  // Tickets: everything the current branch mentions, the keys of its upstream base, the upstream prefixes learned from
  // the upstream bases (no configuration).
  const currentTickets = timed('tickets', () => new Set(tickets(g.out(['log', '--format=%s%n%b', currentSha]))));
  const baseTickets = timed('tickets', () => currentTips.length ? new Set(tickets(g.out(['log', '--format=%s%n%b', ...currentTips]))) : new Set());
  const upstreamPrefixes = timed('tickets', () => {
    const tips = uniqueSorted([...currentTips, ...sourceBases]);
    if (!tips.length) return new Set();
    const counts = new Map();
    for (const key of tickets(g.out(['log', '--format=%s', '-n', '3000', ...tips]))) { const p = prefixOf(key); counts.set(p, (counts.get(p) ?? 0) + 1); }
    return new Set([...counts].filter(([, n]) => n >= keyMin).map(([p]) => p));
  });

  const currentTree = g.out(['rev-parse', `${currentSha}^{tree}`]).trim();
  const changedPaths = tree => lines(g.out(['diff-tree', '-r', '--name-only', currentTree, tree])).filter(p => !local.test(p));
  /** In-memory cherry-pick of base..tip onto the current branch: present (tree unchanged outside branch-local paths),
   * applies (the files that would still change are missing) or conflict. */
  const simulate = (mergeBase, tip) => {
    let r;
    try { r = g.run(['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${mergeBase}`, currentSha, tip], { allow: [0, 1] }); }
    catch (error) { return { state: 'error', files: [], message: error.message }; }
    const [tree, ...conflicted] = lines(r.stdout);
    const conflicts = uniqueSorted(conflicted.filter(p => !local.test(p)));
    const changed = changedPaths(tree);
    if (conflicts.length) return { state: 'conflict', files: conflicts };
    if (changed.length) return { state: 'applies', files: changed };
    return { state: 'present', files: [] };
  };
  const contents = new Map();
  const currentFile = path => {
    if (!contents.has(path)) { const r = g.run(['cat-file', 'blob', `${currentSha}:${path}`], { allow: [0, 128] }); contents.set(path, r.status === 0 ? r.stdout : null); }
    return contents.get(path);
  };
  /** Hunk-level presence: every hunk's added lines exist as a whole-line block in the current version of the file
   * (renames followed) and its removed lines no longer do; lines with fewer than 4 significant characters do not count. */
  const hunkPresence = sha => {
    const diff = g.out(['show', '--format=', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', sha]);
    let file = null, cur = null; const hunks = [];
    for (const line of diff.split('\n')) {
      if (line.startsWith('diff --git')) { file = null; cur = null; continue; }
      if (line.startsWith('+++ ')) { file = line === '+++ /dev/null' ? null : line.slice(4).replace(/^b\//, ''); continue; }
      if (line.startsWith('--- ')) continue;
      if (line.startsWith('@@')) { cur = { file, added: [], removed: [] }; hunks.push(cur); continue; }
      if (!cur) continue;
      if (line.startsWith('+')) cur.added.push(line.slice(1)); else if (line.startsWith('-')) cur.removed.push(line.slice(1));
    }
    const relevant = hunks.filter(h => h.file && !local.test(h.file));
    if (!relevant.length) return null;
    // A path the commit itself renames something to is present only under that exact path: following a rename on the
    // current branch would call a rename to another name "present".
    const ownRenames = new Set(lines(g.out(['diff-tree', '-r', '-M', '--root', '--name-status', '--no-commit-id', sha])).map(l => l.split('\t')).filter(p => p[0].startsWith('R') && p.length === 3).map(p => p[2]));
    let renames = null;
    const pathInCurrent = path => {
      if (currentFile(path) !== null) return path;
      if (ownRenames.has(path)) return null;
      renames ??= new Map(lines(g.out(['diff', '--name-status', '-M', '--diff-filter=R', sha, currentSha])).map(l => l.split('\t')).filter(p => p.length === 3).map(p => [p[1], p[2]]));
      return renames.get(path) ?? null;
    };
    const significant = l => l.replace(/\s+/g, '').length >= 4;
    let present = 0;
    for (const h of relevant) {
      const path = pathInCurrent(h.file);
      const content = path ? currentFile(path) : null;
      if (content === null) continue;
      const added = h.added.filter(significant), removed = h.removed.filter(significant);
      const hasAdded = !added.length || `\n${content}\n`.includes(`\n${h.added.join('\n')}\n`);
      const currentLines = new Set(content.split('\n'));
      const removedGone = !removed.length || removed.every(l => !currentLines.has(l));
      if (hasAdded && removedGone && (added.length || removed.length)) present++;
    }
    return { present, total: relevant.length };
  };
  const versionOnly = (sha, files) => {
    if (!files.length || !files.every(f => BUILD_FILE.test(f))) return false;
    const diff = g.out(['show', '--format=', '--unified=0', '--no-color', '--no-ext-diff', sha]).split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
    return diff.length > 0 && diff.every(l => /^[+-]\s*$/.test(l) || (VERSION_LINE.test(l) && (l.startsWith('-') || RELEASE_VALUE.test(l))));
  };

  // Revert pairs among the candidates (any source).
  const candidateSet = new Set(candidates);
  const findCandidate = prefix => candidateSet.has(prefix) ? prefix : candidates.find(s => s.startsWith(prefix)) ?? null;
  const revertPair = new Set();
  for (const item of info.values()) for (const m of item.body.matchAll(REVERTS)) { const target = findCandidate(m[1]); if (target) { revertPair.add(target); revertPair.add(item.sha); } }

  const evidence = extra => ({ match: null, tickets: [], files: 0, missingFiles: [], missingFilesTotal: 0, conflictFiles: [], hunks: null, series: null, resolutionFiles: [], ...extra });
  const findings = [];
  const evaluated = new Set();
  timed('layers', () => {
    for (const { commits } of [...perSource.values()].sort((a, b) => cmp(a.source.ref, b.source.ref))) {
      for (const [index, sha] of commits.entries()) {
        if (evaluated.has(sha)) continue;
        evaluated.add(sha);
        const item = info.get(sha) ?? { sha, parents: [], author: '', date: '', subject: '', body: '', files: [] };
        const files = item.files ?? [];
        const codeFiles = files.filter(f => !local.test(f));
        const pid = pids.get(sha) ?? null;
        const keys = uniqueSorted(tickets(item.body || item.subject));
        const ownPicks = [...item.body.matchAll(CHERRY_PICKED)].map(m => m[1]);
        const origin = ownPicks.length || tickets(item.subject).some(k => upstreamPrefixes.has(prefixOf(k))) ? 'upstream-integrated' : 'ours';
        const inCurrent = keys.filter(k => currentTickets.has(k));
        let verdict, layer, ev = evidence({ files: codeFiles.length });
        const original = () => { for (const x of ownPicks) { const full = x.length === 40 ? x : resolveCommit(x); if (full && currentReach.has(full)) return full; } return null; };
        let pick = null, orig = null;
        if (!files.length) { verdict = 'neutral:empty'; layer = 'empty'; }
        else if ((pid && revertedPids.has(pid)) || revertedShas.includes(sha)) { verdict = 'expected:reverted-in-current'; layer = 'revert'; }
        else if (files.every(f => local.test(f))) { verdict = 'expected:branch-local'; layer = 'branch-local'; }
        else if (pid && pidToCurrent.has(pid)) { verdict = 'present:patch-id'; layer = 'patch-id'; ev.match = pidToCurrent.get(pid); }
        else if ((pick = pickedInCurrent(sha))) { verdict = 'present:cherry-pick-trailer'; layer = 'trailer'; ev.match = pick; }
        else if ((orig = original())) { verdict = 'present:original-in-current'; layer = 'original'; ev.match = orig; }
        else if (revertPair.has(sha)) { verdict = 'neutral:revert-pair'; layer = 'revert-pair'; }
        else if (origin === 'upstream-integrated' && keys.some(k => upstreamPrefixes.has(prefixOf(k)) && baseTickets.has(k))) { verdict = 'present:upstream-ticket-in-base'; layer = 'upstream-ticket'; ev.tickets = keys.filter(k => baseTickets.has(k)); }
        else if (timed('version', () => versionOnly(sha, files))) { verdict = 'expected:version-bookkeeping'; layer = 'version'; }
        else {
          const parent = item.parents[0];
          const sim = parent ? timed('merge-tree', () => simulate(parent, sha)) : { state: 'error', files: [], message: 'a root commit without a parent' };
          let series = null;
          if (sim.state !== 'present' && parent) {
            const mine = new Set(files);
            for (let k = index + 1; k < Math.min(commits.length, index + SERIES_WINDOW); k++) {
              const next = commits[k], nextFiles = info.get(next)?.files ?? [];
              if (!nextFiles.some(f => mine.has(f))) break;
              nextFiles.forEach(f => mine.add(f));
              if (timed('merge-tree', () => simulate(parent, next)).state === 'present') { series = next; break; }
            }
          }
          const hunks = sim.state === 'present' || series ? null : timed('hunks', () => hunkPresence(sha));
          ev.tickets = inCurrent;
          if (sim.state === 'present') { verdict = 'present:content'; layer = 'content'; }
          else if (series) { verdict = 'present:content-as-series'; layer = 'series'; ev.series = series; }
          else if (hunks && hunks.present === hunks.total) { verdict = 'present:hunks'; layer = 'hunks'; ev.hunks = hunks; }
          else {
            layer = 'content';
            ev.hunks = hunks;
            if (sim.state === 'conflict') { verdict = inCurrent.length ? 'review:diverged-ticket-present' : 'review:diverged'; ev.conflictFiles = sim.files.slice(0, LIST_LIMIT); }
            else if (sim.state === 'applies') { verdict = inCurrent.length ? 'review:ticket-present-content-missing' : 'lost'; ev.missingFiles = sim.files.slice(0, LIST_LIMIT); ev.missingFilesTotal = sim.files.length; }
            else { verdict = 'review:unclassified'; ev.conflictFiles = []; }
          }
        }
        findings.push({ sha, patchId: pid, kind: 'commit', sources: uniqueSorted(owners.get(sha) ?? []), subject: item.subject.slice(0, 300), author: item.author.slice(0, 200), authorDate: item.date, tickets: keys.slice(0, LIST_LIMIT), origin, verdict, layer, evidence: ev });
      }
    }
  });

  // Merges above the upstream base: own changes of the resolution (remerge-diff) outside branch-local paths need review;
  // clean merges are skipped, their sides are candidates already.
  timed('merges', () => {
    const order = [...perSource.values()].sort((a, b) => cmp(a.source.ref, b.source.ref)).flatMap(p => p.merges);
    const seen = new Set();
    const mergeInfo = new Map();
    if (order.length) for (const entry of g.out(['log', '--no-walk=unsorted', '--stdin', '--format=%x01%H%x00%P%x00%an%x00%as%x00%s%x00%B'], { input: uniqueSorted(order).join('\n') + '\n' }).split('\x01').slice(1)) {
      const [sha, parents, author, date, subject, body] = entry.split('\x00');
      mergeInfo.set(sha, { parents: lines(parents.replace(/ /g, '\n')), author, date, subject, body: text(body) });
    }
    for (const sha of order) {
      if (seen.has(sha)) continue;
      seen.add(sha);
      const item = mergeInfo.get(sha);
      if (!item || item.parents.length !== 2) continue; // octopus merges never resolve conflicts
      const files = uniqueSorted(lines(g.out(['show', '--remerge-diff', '--format=', '--name-only', sha])).filter(p => !local.test(p)));
      if (!files.length) continue;
      for (const ref of mergeOwners.get(sha) ?? []) { const s = sources.find(x => x.ref === ref); if (s) s.mergesWithChanges++; }
      const pid = g.patchIds(['show', '--remerge-diff', '--no-color', '--no-ext-diff', '--format=commit %H', sha], [], true).get(sha) ?? null;
      const keys = uniqueSorted(tickets(item.body || item.subject));
      findings.push({ sha, patchId: pid, kind: 'merge', sources: uniqueSorted(mergeOwners.get(sha) ?? []), subject: item.subject.slice(0, 300), author: item.author.slice(0, 200), authorDate: item.date, tickets: keys.slice(0, LIST_LIMIT), origin: 'ours', verdict: 'review:merge-resolution', layer: 'remerge-diff', evidence: evidence({ files: files.length, resolutionFiles: files.slice(0, LIST_LIMIT) }) });
    }
  });
  history.findings = findings;
  console.error(`adrm history: timings ms ${JSON.stringify(timings)}`);
}

// ---------- upstream: the static override, else the root of the fork network ----------
async function upstream(opts) {
  const outPath = resolve(opts.out || 'upstream.json');
  const override = text(opts.override).trim();
  const repository = text(opts.repository).trim();
  let result;
  if (override) {
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(override)) result = { repository: override, source: 'wrapper', url: `https://github.com/${override}.git`, error: null };
    else if (/^https:\/\/[^\s@]+$/.test(override)) result = { repository: override.replace(/^https:\/\/[^/]+\//, '').replace(/\.git$/, ''), source: 'wrapper', url: override, error: null };
    else result = { repository: null, source: 'wrapper', url: null, error: { code: 'INPUT_INVALID', message: `upstream_repository must be owner/name or an https URL: ${override.slice(0, 200)}.` } };
  } else if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    result = { repository: null, source: 'fork-network-root', url: null, error: { code: 'INPUT_INVALID', message: 'The project repository is not set (--repository owner/name).' } };
  } else {
    try {
      const res = await fetch(`https://api.github.com/repos/${repository}`, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const meta = await res.json();
      const root = meta && meta.fork && meta.source && typeof meta.source.full_name === 'string' ? meta.source : null;
      result = root ? { repository: root.full_name, source: 'fork-network-root', url: typeof root.clone_url === 'string' ? root.clone_url : `https://github.com/${root.full_name}.git`, error: null } : { repository: null, source: 'none', url: null, error: null };
    } catch (error) {
      result = { repository: null, source: 'fork-network-root', url: null, error: { code: 'UPSTREAM_UNAVAILABLE', message: `The root of the fork network of ${repository} could not be fetched from the GitHub API: ${error.message}.` } };
    }
  }
  writeJson(outPath, result);
  console.error(`upstream written to ${outPath}: ${JSON.stringify(result)}`);
}

// ---------- report: the ADRM envelope (lost-commits.json, lost-commits v1) ----------
// Inputs from the environment, as for `line`, plus COMPARE_REFS: REQUEST_ID, GENERATION, GITHUB_REPOSITORY,
// GITHUB_REPOSITORY_ID, GITHUB_REF_NAME, GITHUB_SHA, EXPECTED_HEAD_SHA, GITHUB_WORKFLOW_REF, GITHUB_WORKFLOW_SHA,
// EXPECTED_CHECKER_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, CHECKER_SETUP_STATUS, COMPARE_REFS, RESULT_PATH.
function report(opts) {
  const env = process.env;
  const historyPath = resolve(opts.history || 'history.json');
  const resultPath = opts.out || env.RESULT_PATH || 'lost-commits.json';
  const executionMode = opts['execution-mode'] || 'live';
  if (!['live', 'fixture'].includes(executionMode)) throw new Error('--execution-mode must be live or fixture');
  const d = readBranchDispatch(env);
  const requested = parseRefLines(env.COMPARE_REFS ?? '');
  const result = {
    schemaVersion: 1, executionMode, requestId: d.inputs.requestId, generation: d.inputs.generation,
    repository: d.repository,
    commit: { ref: `refs/heads/${d.inputs.branch || 'unknown'}`, sha: d.headSha, state: d.branchState },
    checker: d.checker,
    checkedAt: new Date().toISOString(),
    history: emptyHistory(),
  };
  const gate = dispatchGate(d, env, { skipped: 'the branch history was not analysed', setupSkipped: 'the classifier did not run' });
  if (gate) result.history.errors.push(gate);
  else if (requested.invalid.length) pushError(result.history.errors, 'INPUT_INVALID', `Invalid compare_refs lines: ${requested.invalid.slice(0, 5).join('; ')}.`);
  else {
    let history = null;
    try { history = readJson(historyPath); }
    catch (error) { pushError(result.history.errors, 'CHECKER_SETUP_ERROR', `The classifier did not run: ${historyPath} is missing or unreadable (${error.message}).`, true); }
    if (history) {
      const wellFormed = typeof history === 'object' && STATES.includes(history.state) && ['sources', 'findings', 'errors'].every(k => Array.isArray(history[k])) && history.counts && typeof history.counts === 'object';
      const wanted = uniqueSorted([...new Map(requested.specs.filter(s => s.branch !== d.inputs.branch).map(s => [s.branch, `refs/heads/${s.branch}@${s.sha}`])).values()]);
      const got = wellFormed ? uniqueSorted(history.sources.map(s => `${s.ref}@${s.sha}`)) : [];
      const sameCurrent = wellFormed && (history.current === null ? history.state === 'error' : history.current.ref === result.commit.ref && history.current.sha === d.headSha);
      if (!wellFormed) pushError(result.history.errors, 'CHECKER_SETUP_ERROR', `${historyPath} is not a classifier result.`, true);
      else if (!sameCurrent || (history.state !== 'error' && JSON.stringify(got) !== JSON.stringify(wanted))) pushError(result.history.errors, 'CHECKER_SETUP_ERROR', 'The classifier result is for other branches than the ADRM request.', true);
      else result.history = history;
    }
  }
  result.checkedAt = new Date().toISOString();
  let body = JSON.stringify(result);
  if (Buffer.byteLength(body, 'utf8') > REPORT_LIMIT) {
    const counts = result.history.counts;
    result.history = { ...result.history, state: 'error', findings: [], counts: emptyCounts(), errors: [...result.history.errors] };
    pushError(result.history.errors, 'REPORT_TOO_LARGE', `The report exceeds 16 MiB; the findings are left out (${counts.findings} findings, ${counts.lost} lost, ${counts.review} to review).`);
    body = JSON.stringify(result);
  }
  writeFileSync(resultPath, body);
  console.error(`lost-commits.json written to ${resultPath}: ${JSON.stringify({ commit: result.commit.state, state: result.history.state, findings: result.history.counts.findings, lost: result.history.counts.lost, review: result.history.counts.review, errors: result.history.errors.map(e => e.code) })}`);
}

const usage = 'Usage: lost-commits.mjs upstream --repository owner/name [--override owner/name|https-url] [--out upstream.json]   (GITHUB_TOKEN for the API)\n' +
  '       lost-commits.mjs classify [--repo DIR] --current <branch>[@<sha>] [--sources-file FILE] [--sources b1[@sha],b2…] [--upstream-file upstream.json | --upstream-url URL [--upstream-repository owner/name]] [--branch-local p1,p2] [--remote origin] [--out history.json]\n' +
  '       lost-commits.mjs report --history history.json [--out lost-commits.json] [--execution-mode live|fixture]   (ADRM lost-commits.json v1 for mode=history; inputs from env)';
let parsedArgs;
try { parsedArgs = parseArgs(process.argv.slice(2)); } catch (error) { console.error(`${error.message}\n${usage}`); process.exit(64); }
const commands = { upstream, classify, report };
if (!commands[parsedArgs.command]) { console.error(usage); process.exit(64); }
try { await commands[parsedArgs.command](parsedArgs.opts); } catch (error) { console.error(`error: ${error.message}`); process.exit(2); }
