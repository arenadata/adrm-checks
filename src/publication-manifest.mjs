#!/usr/bin/env node
// Publication manifest: a version-independent, reviewable list of the files a project publishes.
//
//   generate  builds .readiness/publication.yaml. Primary source (--from-sandbox DIR): the directory into which
//             the project's own publisher wrote when its publish command was run with the destination redirected
//             to a local file repository (Maven: -DaltDeploymentRepository=id::file://DIR via MAVEN_OPTS;
//             Gradle: init script that points PublishToMavenRepository tasks at file://DIR). That is the
//             publication computed from sources + workflow, with nothing read from the registry.
//             Alternative source (--from-coordinates FILE): coordinates produced by an introspection tool.
//   verify    expands the manifest for a given version and checks every file in the registry (HEAD).
//   line      declared project version of a branch checkout -> line.json (ADRM line-state v1) for mode=inspect runs.
//
// Only GET/HEAD requests are made: the standard Maven repository layout for files, the GitHub API for the
// source repository and tag. Env: PACKAGE_TOKEN (registry, read:packages) and GITHUB_TOKEN (API). No dependencies; Node >= 20.
//
// Manifest file entries are literal file-name suffixes after "<artifactId>-<version>":
//   .pom .jar -sources.jar -tests.jar -cyclonedx.json .module -bin.tar.gz .jar.asc
// so the URL of a file is always <registry>/<group path>/<artifactId>/<version>/<artifactId>-<version><suffix>.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs, SHA, UUID, readBranchDispatch, dispatchGate } from './lib/contract.mjs';

const CHECKSUM_SUFFIXES = ['.md5', '.sha1', '.sha256', '.sha512'];
const API = 'https://api.github.com';

function token() {
  const t = process.env.PACKAGE_TOKEN || process.env.GITHUB_TOKEN;
  if (!t) throw new Error('PACKAGE_TOKEN or GITHUB_TOKEN with read:packages is required');
  return t;
}
function apiToken() {
  return process.env.GITHUB_TOKEN || process.env.PACKAGE_TOKEN;
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${apiToken()}`, ...(init.headers || {}) } });
  if (!res.ok) { const e = new Error(`GitHub API ${path}: HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

function classify(fileName, artifactId, version) {
  const prefix = `${artifactId}-${version}`;
  if (!fileName.startsWith(prefix)) return { kind: 'unparsed' };
  const suffix = fileName.slice(prefix.length);
  const checksum = CHECKSUM_SUFFIXES.find(c => suffix.endsWith(c));
  if (checksum) return { kind: 'checksum', of: suffix.slice(0, -checksum.length), algorithm: checksum.slice(1) };
  if (!suffix.startsWith('.') && !suffix.startsWith('-')) return { kind: 'unparsed' };
  return { kind: 'primary', suffix };
}

function suffixToParts(suffix) {
  if (suffix.startsWith('.')) return { classifier: null, extension: suffix.slice(1) };
  const dot = suffix.indexOf('.');
  return { classifier: suffix.slice(1, dot), extension: suffix.slice(dot + 1) };
}

/** Resolve tag -> commit SHA (peeling annotated tags). */
async function resolveTag(repo, tag) {
  let ref;
  try { ref = await api(`/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`); }
  catch (e) { if (e.status === 404) return null; throw e; }
  let object = ref.object;
  for (let depth = 0; depth < 5 && object.type === 'tag'; depth++) object = (await api(`/repos/${repo}/git/tags/${object.sha}`)).object;
  if (object.type !== 'commit') throw new Error(`Tag ${tag} does not resolve to a commit`);
  return object.sha;
}

// ---------- minimal YAML (only the subset this tool writes) ----------
function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  return /^[A-Za-z0-9_./:@+${}-][A-Za-z0-9_./:@+${}\- ]*$/.test(s) && !/^(true|false|null|~)$/i.test(s) && !/^[-?]\s/.test(s) && !/: /.test(s) ? s : JSON.stringify(s);
}
function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) return `[${value.map(yamlScalar).join(', ')}]`;
  const lines = [];
  for (const [k, v] of Object.entries(value)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) lines.push(`${pad}${k}:`, toYaml(v, indent + 2));
    else lines.push(`${pad}${k}: ${Array.isArray(v) ? toYaml(v) : yamlScalar(v)}`);
  }
  return lines.join('\n');
}
function parseScalar(s) {
  s = s.trim();
  if (s.startsWith('"')) return JSON.parse(s);
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}
function fromYaml(text) {
  const lines = text.split(/\r?\n/).map((raw, n) => ({ n: n + 1, raw })).filter(l => l.raw.trim() && !l.raw.trim().startsWith('#'));
  const root = {}; const stack = [{ indent: -1, obj: root }];
  for (const { n, raw } of lines) {
    const indent = raw.length - raw.trimStart().length;
    const m = raw.trim().match(/^([^:#][^:]*?):(?:\s+(.*))?$/);
    if (!m) throw new Error(`Unsupported YAML at line ${n}: ${raw}`);
    while (stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    const key = m[1].trim(); const rest = m[2];
    if (rest === undefined) { const obj = {}; parent[key] = obj; stack.push({ indent, obj }); }
    else if (rest.startsWith('[')) {
      if (!rest.endsWith(']')) throw new Error(`Unsupported flow sequence at line ${n}`);
      parent[key] = rest.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).map(parseScalar);
    } else parent[key] = parseScalar(rest);
  }
  return root;
}

// ---------- generate from a sandbox publish directory (sources + workflow) ----------
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) { const p = join(dir, entry); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); }
  return out;
}

/** Read a Maven-layout file repository written by the redirected publisher. */
function readSandbox(dir, opts) {
  const files = walk(dir).map(p => relative(dir, p).split(sep));
  const groups = {}; const warnings = []; const versions = new Set(); const sidecars = new Set();
  let primaryCount = 0, checksumCount = 0, metadataCount = 0;
  const byVersionDir = new Map();
  for (const parts of files) {
    const fileName = parts[parts.length - 1];
    if (fileName.startsWith('maven-metadata.xml')) { metadataCount++; continue; }
    if (parts.length < 4) { warnings.push(`unexpected path ${parts.join('/')}`); continue; }
    const key = parts.slice(0, -1).join('/');
    (byVersionDir.get(key) ?? byVersionDir.set(key, []).get(key)).push(fileName);
  }
  for (const [key, names] of [...byVersionDir.entries()].sort()) {
    const parts = key.split('/');
    const version = parts[parts.length - 1], artifactId = parts[parts.length - 2], groupId = parts.slice(0, -2).join('.');
    if (!names.some(n => n.startsWith(`${artifactId}-${version}`))) { warnings.push(`${key}: no file starts with ${artifactId}-${version}; skipped`); continue; }
    versions.add(version);
    const suffixes = [];
    for (const n of names) {
      const c = classify(n, artifactId, version);
      if (c.kind === 'primary') { suffixes.push(c.suffix); primaryCount++; }
      else if (c.kind === 'checksum') { checksumCount++; sidecars.add(c.algorithm); }
      else warnings.push(`${key}: unparsed file ${n}`);
    }
    (groups[groupId] ??= {})[artifactId] = suffixes.sort();
  }
  if (versions.size !== 1 && !opts['allow-mixed-versions']) throw new Error(`Sandbox contains ${versions.size} distinct versions (${[...versions].join(', ')}); expected one project version. Pass --allow-mixed-versions to override.`);
  return { groups, warnings, version: [...versions][0] ?? null, primaryCount, checksumCount, metadataCount, sidecars: [...sidecars].sort() };
}

async function generateFromSandbox(opts) {
  const dir = opts['from-sandbox'];
  const repo = opts.repo; if (!repo) throw new Error('--repo owner/name is required');
  const registry = opts.registry || `https://maven.pkg.github.com/${opts['registry-repo'] || repo}`;
  const out = opts.out || '.readiness/publication.yaml';
  const sandbox = readSandbox(dir, opts);
  const modules = Object.values(sandbox.groups).reduce((n, g) => n + Object.keys(g).length, 0);
  if (modules === 0) throw new Error(`No published modules found under ${dir}`);
  const manifest = {
    schema: 'adrm/publication-manifest/v1',
    project: repo,
    registry,
    version: 'from-tag',
    generated: {
      at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      method: 'sandbox-publish',
      fromVersion: sandbox.version,
      sourceRef: opts['source-ref'] || null,
      sourceSha: opts['source-sha'] || null,
      publisherWorkflow: opts['publisher-workflow'] || '.github/workflows/publish.yml',
      publisherInvocations: opts.invocations ? Number(opts.invocations) : null,
      checksumSidecarsWritten: sandbox.sidecars,
      modules,
      primaryFiles: sandbox.primaryCount,
      checksumFiles: sandbox.checksumCount,
      metadataFiles: sandbox.metadataCount,
    },
    groups: sandbox.groups,
  };
  writeManifest(out, manifest, sandbox.warnings, opts);
}

/** Canonical order: groups and modules sorted, suffixes sorted; the digest must not depend on the generation method. */
function canonicalGroups(groups) {
  const out = {};
  for (const g of Object.keys(groups).sort()) { out[g] = {}; for (const m of Object.keys(groups[g]).sort()) out[g][m] = [...new Set(groups[g][m])].sort(); }
  return out;
}

function writeManifest(out, manifest, warnings, opts) {
  manifest.groups = canonicalGroups(manifest.groups);
  const header = [
    '# Publication manifest: every file this project publishes, per module, without versions.',
    '# Entries are file-name suffixes after "<artifactId>-<version>"; the version comes from the tag at check time.',
    '# Generated by adrm-checks publication-manifest.mjs; regenerate and review the diff, do not edit by hand.',
    '',
  ].join('\n');
  const text = header + toYaml(manifest) + '\n';
  const digest = createHash('sha256').update(JSON.stringify(manifest.groups)).digest('hex');
  let changed = true;
  if (existsSync(out)) {
    const previous = fromYaml(readFileSync(out, 'utf8'));
    const diff = diffGroups(previous.groups || {}, manifest.groups);
    changed = diff.length > 0;
    if (changed) console.error(`Manifest changed:\n  ${diff.join('\n  ')}`); else console.error('Manifest unchanged (groups identical; provenance refreshed).');
  }
  mkdirSync(dirname(out), { recursive: true }); // first generation in a project without .readiness yet
  writeFileSync(out, text);
  const g = manifest.generated;
  console.error(`Wrote ${out}: ${g.modules} modules, ${g.primaryFiles} primary files, ${g.checksumFiles ?? 'n/a'} checksum files, method ${g.method}, groups digest ${digest.slice(0, 12)}`);
  for (const w of warnings) console.error(`WARNING: ${w}`);
  process.exitCode = changed && opts['exit-code-on-change'] ? 3 : 0;
}

async function generateFromCoordinates(opts) {
  const file = opts['from-coordinates'];
  const repo = opts.repo; if (!repo) throw new Error('--repo owner/name is required');
  const registry = opts.registry || `https://maven.pkg.github.com/${opts['registry-repo'] || repo}`;
  const out = opts.out || '.readiness/publication.yaml';
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.files;
  const groups = {}; const versions = new Set(); let primaryCount = 0;
  for (const c of list) {
    versions.add(c.version);
    const suffix = (c.classifier ? `-${c.classifier}` : '') + `.${c.extension}`;
    const mod = (groups[c.groupId] ??= {}); (mod[c.artifactId] ??= []).push(suffix); primaryCount++;
  }
  for (const g of Object.values(groups)) for (const k of Object.keys(g)) g[k] = [...new Set(g[k])].sort();
  if (versions.size !== 1 && !opts['allow-mixed-versions']) throw new Error(`Coordinates contain ${versions.size} distinct versions`);
  const modules = Object.values(groups).reduce((n, g) => n + Object.keys(g).length, 0);
  const manifest = { schema: 'adrm/publication-manifest/v1', project: repo, registry, version: 'from-tag',
    generated: { at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), method: opts.method || 'coordinates-file', fromVersion: [...versions][0], sourceRef: opts['source-ref'] || null, sourceSha: opts['source-sha'] || null, coordinatesFile: file, modules, primaryFiles: primaryCount },
    groups };
  writeManifest(out, manifest, [], opts);
}

// ---------- generate ----------
async function generate(opts) {
  if (opts['from-sandbox']) return generateFromSandbox(opts);
  if (opts['from-coordinates']) return generateFromCoordinates(opts);
  throw new Error('generate needs --from-sandbox DIR or --from-coordinates FILE');
}

function diffGroups(a, b) {
  const out = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const g of [...keys].sort()) {
    const ma = a[g] || {}, mb = b[g] || {};
    for (const m of [...new Set([...Object.keys(ma), ...Object.keys(mb)])].sort()) {
      const sa = new Set(ma[m] || []), sb = new Set(mb[m] || []);
      if (!ma[m]) out.push(`+ ${g}:${m} ${JSON.stringify(mb[m])}`);
      else if (!mb[m]) out.push(`- ${g}:${m}`);
      else {
        const added = [...sb].filter(x => !sa.has(x)), removed = [...sa].filter(x => !sb.has(x));
        if (added.length || removed.length) out.push(`~ ${g}:${m} added ${JSON.stringify(added)} removed ${JSON.stringify(removed)}`);
      }
    }
  }
  return out;
}

// ---------- verify ----------
function expand(manifest, version) {
  const files = [];
  for (const [groupId, modules] of Object.entries(manifest.groups)) {
    for (const [artifactId, suffixes] of Object.entries(modules)) {
      for (const suffix of suffixes) {
        const fileName = `${artifactId}-${version}${suffix}`;
        files.push({ groupId, artifactId, suffix, ...suffixToParts(suffix), fileName, url: `${manifest.registry}/${groupId.replace(/\./g, '/')}/${artifactId}/${version}/${fileName}` });
      }
    }
  }
  return files;
}

async function head(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method: 'HEAD', headers: { Authorization: `Bearer ${token()}` }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
      if (res.status >= 500 || res.status === 429) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
      return { http: res.status, state: res.status === 200 ? 'present' : res.status === 404 ? 'missing' : 'error' };
    } catch (e) { if (attempt === 2) return { http: null, state: 'error', error: e.name }; }
  }
  return { http: null, state: 'error' };
}

async function verify(opts) {
  const manifestPath = opts.manifest || '.readiness/publication.yaml';
  const version = opts.version; if (!version) throw new Error('--version is required');
  const manifest = fromYaml(readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 'adrm/publication-manifest/v1') throw new Error(`Unsupported manifest schema: ${manifest.schema}`);
  const expected = expand(manifest, version);
  const concurrency = Number(opts.concurrency || 6);
  const observations = new Array(expected.length);
  let next = 0; const started = Date.now();
  await Promise.all(Array.from({ length: concurrency }, async () => { for (;;) { const i = next++; if (i >= expected.length) return; observations[i] = { ...expected[i], ...(await head(expected[i].url)) }; } }));


  const counts = { expected: expected.length, present: observations.filter(o => o.state === 'present').length, missing: observations.filter(o => o.state === 'missing').length, error: observations.filter(o => o.state === 'error').length };
  const verdict = counts.error > 0 ? 'unknown' : counts.missing > 0 ? 'incomplete' : 'complete';
  const report = { manifest: manifestPath, manifestGroupsDigest: createHash('sha256').update(JSON.stringify(manifest.groups)).digest('hex'), version, checkedAt: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), counts, verdict, missing: observations.filter(o => o.state !== 'present').map(o => ({ file: `${o.groupId}:${o.fileName}`, http: o.http, state: o.state })) };
  if (opts.json) writeFileSync(opts.json, JSON.stringify({ ...report, observations }, null, 1));
  console.log(JSON.stringify(report, null, 1));
  process.exitCode = verdict === 'complete' ? 0 : verdict === 'unknown' ? 2 : 1;
}


// ---------- shared observation of a manifest for one version ----------
async function observeManifest(manifest, version, concurrency, simulate = new Map()) {
  const expected = expand(manifest, version);
  const observations = new Array(expected.length);
  let next = 0;
  const probe = async f => {
    const forced = simulate.get(f.fileName);
    if (forced === 'missing') return { http: 404, state: 'missing' };
    if (forced === 'error') return { http: null, state: 'error', error: 'SIMULATED_ACCESS_DENIED' };
    return head(f.url);
  };
  await Promise.all(Array.from({ length: concurrency }, async () => { for (;;) { const i = next++; if (i >= expected.length) return; observations[i] = { ...expected[i], ...(await probe(expected[i])), observedAt: new Date().toISOString() }; } }));
  return { expected, observations };
}

// ---------- emit: ADRM result.json, contract v1 ----------
// Inputs come from the dispatching workflow (same names as the previous checker): REQUEST_ID, GENERATION,
// GITHUB_REPOSITORY, GITHUB_REPOSITORY_ID, TARGET_TAG, TARGET_SHA, TARGET_VERSION, PRODUCT_VERSION,
// GITHUB_WORKFLOW_REF, GITHUB_WORKFLOW_SHA, EXPECTED_CHECKER_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT,
// CHECKER_SETUP_STATUS, RESULT_PATH; GITHUB_TOKEN for the API, PACKAGE_TOKEN for the registry.
// The report never claims readiness itself: ADRM recomputes it from target state, inventory and observations.
// Tag, project and product versions are shaped by ADRM templates (configurable per repository); only path-safe characters matter here.
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/;

/** Same canonical digest as ADRM src/domain/manifest.ts: sorted requirement tuples, sha256 of their JSON. */
function publicationManifestDigest(artifacts) {
  const records = artifacts.map(a => [a.key, a.required, a.kind, a.repositoryId, a.coordinate ? [a.coordinate.groupId, a.coordinate.artifactId, a.coordinate.version, a.coordinate.extension, a.coordinate.classifier] : null, a.locator.url]);
  records.sort((l, r) => { const a = JSON.stringify(l), b = JSON.stringify(r); return a < b ? -1 : a > b ? 1 : 0; });
  return { artifactCount: records.length, manifestSha256: createHash('sha256').update(JSON.stringify(records), 'utf8').digest('hex') };
}

class CheckError extends Error { constructor(code, message, retryable = false) { super(message); this.code = code; this.retryable = retryable; } }

async function emit(opts) {
  const env = process.env;
  const manifestPath = opts.manifest || '.readiness/publication.yaml';
  const resultPath = opts.out || env.RESULT_PATH || 'result.json';
  const concurrency = Number(opts.concurrency || 6);
  const executionMode = opts['execution-mode'] || 'live';
  if (!['live', 'fixture'].includes(executionMode)) throw new Error('--execution-mode must be live or fixture');
  // --simulate "<fileName>:missing,<fileName>:error" forces observations for local fixtures; never allowed in live mode,
  // so a report with simulated observations can never pass ADRM's live ingestion (executionMode mismatch).
  const simulate = new Map();
  for (const item of String(opts.simulate || '').split(',').map(x => x.trim()).filter(Boolean)) {
    const at = item.lastIndexOf(':'); const file = item.slice(0, at), state = item.slice(at + 1);
    if (!file || !['missing', 'error'].includes(state)) throw new Error(`--simulate entry must be <fileName>:missing|error, got ${item}`);
    simulate.set(file, state);
  }
  if (simulate.size && executionMode !== 'fixture') throw new Error('--simulate requires --execution-mode fixture');
  const inputs = {
    requestId: env.REQUEST_ID ?? '', generation: Number(env.GENERATION), repository: env.GITHUB_REPOSITORY ?? '', repositoryId: Number(env.GITHUB_REPOSITORY_ID),
    target: { tag: env.TARGET_TAG ?? '', commitSha: env.TARGET_SHA ?? '', fullVersion: env.TARGET_VERSION ?? '', productVersion: env.PRODUCT_VERSION ?? '' },
    checker: { workflowRef: env.GITHUB_WORKFLOW_REF ?? '', workflowSha: env.GITHUB_WORKFLOW_SHA ?? '', expectedSha: env.EXPECTED_CHECKER_SHA ?? '', runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT) },
  };
  const invalid = [];
  if (!UUID.test(inputs.requestId)) invalid.push('request_id');
  if (!Number.isSafeInteger(inputs.generation) || inputs.generation < 0) invalid.push('generation');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(inputs.repository) || !Number.isSafeInteger(inputs.repositoryId) || inputs.repositoryId <= 0) invalid.push('repository identity');
  if (!SHA.test(inputs.target.commitSha) || !SAFE_VERSION.test(inputs.target.fullVersion) || !SAFE_VERSION.test(inputs.target.productVersion) || !inputs.target.tag || inputs.target.tag.length > 256) invalid.push('target');
  if (!SHA.test(inputs.checker.workflowSha) || !SHA.test(inputs.checker.expectedSha)) invalid.push('checker sha');
  if (!inputs.checker.workflowRef.startsWith(`${inputs.repository}/.github/workflows/`) || !/@refs\/(heads|tags)\/[^\s]+$/.test(inputs.checker.workflowRef) || inputs.checker.workflowRef.length > 1024) invalid.push('workflow_ref');
  if (!Number.isSafeInteger(inputs.checker.runId) || inputs.checker.runId <= 0 || !Number.isSafeInteger(inputs.checker.runAttempt) || inputs.checker.runAttempt <= 0) invalid.push('run identity');

  const result = {
    schemaVersion: 1, executionMode, requestId: inputs.requestId, generation: inputs.generation,
    repository: { provider: 'github', id: inputs.repositoryId, fullName: inputs.repository },
    requestedTarget: { ...inputs.target }, target: { ...inputs.target, state: 'unknown', commitSha: null },
    checker: { workflowRef: inputs.checker.workflowRef, workflowSha: inputs.checker.workflowSha, ...(SHA.test(env.ADRM_ENGINE_SHA ?? '') ? { engineSha: env.ADRM_ENGINE_SHA } : {}), runId: inputs.checker.runId, runAttempt: inputs.checker.runAttempt, runUrl: `https://github.com/${inputs.repository}/actions/runs/${inputs.checker.runId}` },
    checkedAt: new Date().toISOString(), check: { outcome: 'completed', errors: [] },
    publication: { requirementsComplete: false, inventory: null, artifacts: [] }, publicationReady: null,
    dependencies: { outcome: 'not_supported', observations: [], errors: [] },
  };
  const diagnostic = (code, message, retryable = false) => {
    result.check.outcome = 'error'; result.publicationReady = null;
    if (result.check.errors.length < 100 && !result.check.errors.some(e => e.code === code)) result.check.errors.push({ code, message, retryable });
  };
  const finish = () => {
    result.checkedAt = new Date().toISOString();
    const text = JSON.stringify(result, null, 1);
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) { result.publication.artifacts = []; result.publication.inventory = null; result.publication.requirementsComplete = false; diagnostic('REPORT_TOO_LARGE', 'Отчёт превышает 1 МиБ; список файлов не передан.'); }
    writeFileSync(resultPath, JSON.stringify(result, null, 1));
    const summary = { outcome: result.check.outcome, target: result.target.state, requirementsComplete: result.publication.requirementsComplete, artifacts: result.publication.artifacts.length, present: result.publication.artifacts.filter(a => a.state === 'present').length, missing: result.publication.artifacts.filter(a => a.state === 'missing').length, unknown: result.publication.artifacts.filter(a => a.state === 'unknown').length, errors: result.check.errors.map(e => e.code), publicationReady: result.publicationReady, dependencies: `${result.dependencies.outcome} ${result.dependencies.observations.length} observed, ${result.dependencies.errors.length} errors` };
    console.error(`result.json written to ${resultPath}: ${JSON.stringify(summary)}`);
  };
  if (invalid.length) { diagnostic('INPUT_INVALID', `Некорректные входные данные workflow: ${invalid.join(', ')}.`); finish(); return; }

  try {
    if (inputs.checker.workflowSha !== inputs.checker.expectedSha) throw new CheckError('CHECKER_CHANGED', 'Версия проверяющего workflow отличается от ожидаемой ADRM.');
    if (env.CHECKER_SETUP_STATUS && env.CHECKER_SETUP_STATUS !== 'success') throw new CheckError('CHECKER_SETUP_ERROR', 'Подготовительный шаг workflow завершился с ошибкой; registry не опрашивался.', true);
    // The tag, version and product version come from ADRM, which derives them from its own branch/version/tag
    // templates (configurable per repository); their format is not re-checked here.
    let manifest;
    try { manifest = fromYaml(readFileSync(manifestPath, 'utf8')); } catch { throw new CheckError('CHECK_NOT_CONFIGURED', `Manifest публикации не прочитан: ${manifestPath}.`); }
    if (manifest.schema !== 'adrm/publication-manifest/v1' || !manifest.groups || !manifest.registry) throw new CheckError('CHECK_NOT_CONFIGURED', 'Manifest публикации имеет неподдерживаемую схему.');
    if (String(manifest.project).toLowerCase() !== inputs.repository.toLowerCase()) throw new CheckError('CHECK_NOT_CONFIGURED', 'Manifest публикации относится к другому репозиторию.');
    const registry = new URL(manifest.registry);
    if (registry.protocol !== 'https:' || registry.username || registry.password) throw new CheckError('CHECK_NOT_CONFIGURED', 'Адрес registry в manifest недопустим.');
    const repositoryIdName = manifest.repositoryId || registry.pathname.split('/').filter(Boolean).at(-1) || 'registry';

    const metadata = await api(`/repos/${inputs.repository}`);
    if (metadata?.id !== inputs.repositoryId || String(metadata?.full_name).toLowerCase() !== inputs.repository.toLowerCase()) throw new CheckError('REPOSITORY_IDENTITY_MISMATCH', 'Идентичность репозитория-источника не подтверждена.');
    const actualSha = await resolveTag(inputs.repository, inputs.target.tag);
    result.target.commitSha = actualSha;
    result.target.state = !actualSha ? 'missing' : actualSha === inputs.target.commitSha ? 'resolved' : 'changed';
    if (result.target.state !== 'resolved') { finish(); return; }

    const expected = expand(manifest, inputs.target.fullVersion);
    if (expected.length === 0 || expected.length > 5000) throw new CheckError('CHECK_NOT_CONFIGURED', 'Manifest публикации пуст или слишком велик.');
    const requirements = expected.map(f => ({
      key: `${repositoryIdName}:${f.groupId}:${f.artifactId}:${inputs.target.fullVersion}:${f.extension}:${f.classifier ?? ''}`,
      required: true, kind: 'maven',
      coordinate: { groupId: f.groupId, artifactId: f.artifactId, version: inputs.target.fullVersion, extension: f.extension, classifier: f.classifier ?? null },
      repositoryId: repositoryIdName, locator: { url: f.url },
    }));
    if (new Set(requirements.map(r => r.key)).size !== requirements.length) throw new CheckError('CHECK_NOT_CONFIGURED', 'Manifest публикации содержит повторяющиеся файлы.');
    const groupsDigest = createHash('sha256').update(JSON.stringify(manifest.groups)).digest('hex');
    result.publication.requirementsComplete = true;
    result.publication.inventory = { adapterVersion: `publication-manifest/v1 ${manifest.generated?.method ?? 'unknown'} ${groupsDigest.slice(0, 12)}`, ...publicationManifestDigest(requirements), sourceSha: inputs.checker.workflowSha, reason: null };

    for (const file of simulate.keys()) if (!expected.some(f => f.fileName === file)) throw new CheckError('CHECK_NOT_CONFIGURED', `Файл для симуляции не входит в manifest: ${file}.`);
    const { observations } = await observeManifest(manifest, inputs.target.fullVersion, concurrency, simulate);
    for (const [i, o] of observations.entries()) {
      const conclusive = o.state === 'present' || o.state === 'missing';
      result.publication.artifacts.push({
        ...requirements[i], state: conclusive ? o.state : 'unknown', observedAt: o.observedAt,
        observation: { method: 'HEAD', httpStatus: o.http ?? null, errorCode: conclusive ? null : (o.http ? `HTTP_${o.http}` : (o.error || 'NETWORK_ERROR')), attempts: 1 },
      });
    }
    const unknown = result.publication.artifacts.filter(a => a.state === 'unknown').length;
    if (unknown > 0) diagnostic('PACKAGE_PROBE_ERROR', `Доступность ${unknown} из ${result.publication.artifacts.length} файлов не установлена (ошибки доступа к registry).`, true);

    const finalSha = await resolveTag(inputs.repository, inputs.target.tag);
    result.target.commitSha = finalSha;
    result.target.state = !finalSha ? 'missing' : finalSha === inputs.target.commitSha ? 'resolved' : 'changed';
    if (result.check.outcome === 'completed') result.publicationReady = result.target.state === 'resolved' && result.publication.artifacts.every(a => a.state === 'present');
  } catch (error) {
    if (error instanceof CheckError) diagnostic(error.code, error.message, error.retryable);
    else if (error?.status === 401 || error?.status === 403) diagnostic('SOURCE_ACCESS_DENIED', 'GitHub отклонил доступ к репозиторию-источнику.', true);
    else diagnostic('CHECK_ERROR', 'Проверка не завершена из-за внутренней ошибки; registry мог быть опрошен частично.', true);
  }
  finish();
}

// ---------- line: declared version of a line branch head (line.json, schema adrm/line-state/v1) ----------
// ADRM dispatches the project's wrapper on the line branch with mode=inspect; the wrapper runs this command on
// the branch checkout (--from DIR) and uploads line.json as artifact line-state-<request_id>-<run_attempt>.
// Nothing is built: only the build files a maintainer already keeps are read, and the first file that declares
// a version wins (pom.xml, gradle.properties, version.txt, build.gradle(.kts), version.sbt, build.sbt).
// Inputs: REQUEST_ID, GENERATION, GITHUB_REPOSITORY, GITHUB_REPOSITORY_ID, GITHUB_REF_NAME (the branch),
// GITHUB_SHA (its head), EXPECTED_HEAD_SHA, EXPECTED_CHECKER_SHA, GITHUB_WORKFLOW_REF, GITHUB_WORKFLOW_SHA,
// GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, CHECKER_SETUP_STATUS, RESULT_PATH. ADRM classifies the version itself
// (set / not bumped / invalid), so PRODUCT_VERSION and LINE_VERSION are accepted but not interpreted here.
const cleanVersion = v => { const t = (v ?? '').trim(); return t.length > 0 && t.length <= 256 ? t : null; };

/** `<version>` of the root `<project>` itself; the `<parent>` version only when the project has none. */
function mavenProjectVersion(content) {
  const source = content.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const tags = /<\?[\s\S]*?\?>|<\/?([A-Za-z_][\w.:-]*)(?:\s[^>]*?)?(\/?)>/g;
  const stack = [];
  let own = null, parent = null, open = null, match;
  while ((match = tags.exec(source)) !== null) {
    const [raw, name, selfClosing] = match;
    if (!name) continue;
    if (raw.startsWith('</')) {
      if (open && open.name === 'version' && stack.length === open.depth) {
        const text = cleanVersion(source.slice(open.end, match.index));
        if (stack.length === 2 && stack[0] === 'project' && stack[1] === 'version') own ??= text;
        if (stack.length === 3 && stack[0] === 'project' && stack[1] === 'parent' && stack[2] === 'version') parent ??= text;
      }
      stack.pop();
      open = null;
    } else {
      stack.push(name);
      open = selfClosing ? null : { name, depth: stack.length, end: tags.lastIndex };
      if (selfClosing) stack.pop();
    }
    if (own) break;
  }
  return own ?? parent;
}
function propertyLine(content, key) {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(trimmed);
    if (m && m[1] === key) return cleanVersion(m[2]);
  }
  return null;
}
function versionTxt(content) { return cleanVersion(content.split(/\r?\n/).map(v => v.trim()).find(v => v && !v.startsWith('#'))); }
function gradleScriptVersion(content) {
  for (const line of content.split(/\r?\n/)) {
    const m = /^version\s*(?:=|:)?\s*(['"])([^'"]+)\1\s*(?:\/\/.*)?$/.exec(line);
    if (m) return cleanVersion(m[2]);
  }
  return null;
}
function sbtVersion(content) {
  for (const line of content.split(/\r?\n/)) {
    const m = /^\s*(?:ThisBuild\s*\/\s*)?version\s*:=\s*"([^"]+)"/.exec(line);
    if (m) return cleanVersion(m[1]);
  }
  return null;
}
/** Order matters: a Maven project is never confused with a Gradle one, and a gradle.properties without
 * `version=` (Iceberg) falls through to version.txt. */
const VERSION_READERS = [
  { path: 'pom.xml', tool: 'maven', extract: mavenProjectVersion },
  { path: 'gradle.properties', tool: 'gradle', extract: c => propertyLine(c, 'version') },
  { path: 'version.txt', tool: 'gradle', extract: versionTxt },
  { path: 'build.gradle', tool: 'gradle', extract: gradleScriptVersion },
  { path: 'build.gradle.kts', tool: 'gradle', extract: gradleScriptVersion },
  { path: 'version.sbt', tool: 'sbt', extract: sbtVersion },
  { path: 'build.sbt', tool: 'sbt', extract: sbtVersion },
];
/** The declared version of a checkout: the first build file that yields one, or null. */
function readDeclaredVersion(dir) {
  for (const reader of VERSION_READERS) {
    const file = join(dir, reader.path);
    if (!existsSync(file)) continue;
    const value = reader.extract(readFileSync(file, 'utf8'));
    if (value) return { tool: reader.tool, path: reader.path, value };
  }
  return null;
}

async function line(opts) {
  const env = process.env;
  const dir = opts.from || '.';
  if (opts['version-only']) {
    const declared = readDeclaredVersion(dir);
    if (!declared) { console.error(`no build file in ${dir} declares a version (${VERSION_READERS.map(r => r.path).join(', ')})`); process.exitCode = 1; return; }
    console.log(`${declared.path}: ${declared.value}`);
    return;
  }
  const resultPath = opts.out || env.RESULT_PATH || 'line.json';
  const executionMode = opts['execution-mode'] || 'live';
  if (!['live', 'fixture'].includes(executionMode)) throw new Error('--execution-mode must be live or fixture');
  const d = readBranchDispatch(env);
  const state = {
    schemaVersion: 1, executionMode, requestId: d.inputs.requestId, generation: d.inputs.generation,
    repository: d.repository,
    branch: { name: d.inputs.branch || 'unknown', headSha: d.headSha, state: d.branchState },
    version: { state: 'undeclared', value: null, source: { tool: null, path: null, method: null }, errors: [] },
    checker: d.checker,
    checkedAt: new Date().toISOString(),
  };
  const fail = (code, message, retryable = false) => { state.version = { state: 'error', value: null, source: { tool: null, path: null, method: null }, errors: [{ code, message: message.slice(0, 4096), retryable }] }; };
  const finish = () => {
    state.checkedAt = new Date().toISOString();
    writeFileSync(resultPath, JSON.stringify(state, null, 1));
    console.error(`line.json written to ${resultPath}: ${JSON.stringify({ branch: state.branch.state, version: state.version.state, value: state.version.value, source: state.version.source.path, errors: state.version.errors.map(e => e.code) })}`);
  };
  const gate = dispatchGate(d, env, { skipped: 'версия не читалась', setupSkipped: 'build-файлы не читались' });
  if (gate) { fail(gate.code, gate.message, gate.retryable); finish(); return; }
  try {
    const declared = readDeclaredVersion(dir);
    state.version = declared
      ? { state: 'declared', value: declared.value, source: { tool: declared.tool, path: declared.path, method: 'files' }, errors: [] }
      : { state: 'undeclared', value: null, source: { tool: null, path: null, method: 'files' }, errors: [] };
  } catch (error) {
    fail('VERSION_READ_ERROR', `Build-файлы не прочитаны: ${error.message}`);
  }
  finish();
}

const { command, opts } = parseArgs(process.argv.slice(2));
const commands = { generate, verify, emit, line };
if (!commands[command]) { console.error('Usage: publication-manifest.mjs generate --from-sandbox DIR --repo owner/name [--registry URL] [--source-sha SHA] [--source-ref REF] [--invocations N] [--out file] [--exit-code-on-change]\n       publication-manifest.mjs verify --manifest file --version X [--json out.json] [--concurrency 6]\n       publication-manifest.mjs emit --manifest file [--out result.json] [--execution-mode live|fixture] [--simulate <file>:missing|error,...]   (ADRM result.json v1; inputs from env, see comments)\n       publication-manifest.mjs line [--from DIR] [--out line.json] [--execution-mode live|fixture] | line --from DIR --version-only   (ADRM line.json v1 for mode=inspect; inputs from env)'); process.exit(64); }
commands[command](opts).catch(e => { console.error(`error: ${e.message}`); process.exit(2); });
