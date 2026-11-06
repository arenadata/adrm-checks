#!/usr/bin/env node
// Dependency inventory: the resolved dependency graph of a checkout, read from the build without compiling, as
// modules, components and edges; dependencies.json (ADRM dependency-inventory v1) for mode=dependencies.
//
//   run        runs the build tool once per line of an args file (Maven: maven-dependency-plugin tree in JSON per
//              module, POMs only; Gradle: the adrmDependencies task of gradle/adrm-dependencies.init.gradle, metadata
//              only), collects the per-module files into <out>/raw after every invocation and writes <out>/inventory.json.
//              Build failures go into inventory.state and inventory.errors.
//              --container IMAGE runs every invocation in its own `docker run --rm` with the checkout, <out>/home, the
//              launcher installation and the adrm files mounted, and with GITHUB_ACTOR, GITHUB_USERNAME and
//              GITHUB_TOKEN as the only job variables. --maven-settings FILE is passed to Maven as --global-settings.
//   normalize  inventory.json from collected raw files (--raw DIR) or from a checkout after a manual run (--from DIR).
//   report     dependencies.json: inventory.json in the ADRM envelope; inputs from the environment, as for `line`.
//
// Node >= 20, no dependencies. Exit codes: 0 also when the inventory state is error, 2 for errors of the script, 64 for
// usage.

import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readBranchDispatch, dispatchGate } from './lib/contract.mjs';

const TOOLS = ['maven', 'gradle', 'sbt'];
const MAVEN_TREE_GOAL = 'org.apache.maven.plugins:maven-dependency-plugin:3.11.0:tree';
const MAVEN_TREE_FILE = 'adrm-dependency-tree.json';
const GRADLE_FILE = 'adrm-dependencies.json';
const GRADLE_TASK = 'adrmDependencies';
const GRADLE_INIT_SCRIPT = fileURLToPath(new URL('../gradle/adrm-dependencies.init.gradle', import.meta.url));
const SKIP_DIRS = new Set(['.git', '.gradle', '.idea', 'node_modules']);
const STATES = ['complete', 'partial', 'error', 'unsupported'];
const SCOPES = new Set(['compile', 'runtime', 'provided', 'test', 'system', 'import']);
const REPORT_LIMIT = 16 * 1024 * 1024;
const MAX_ERRORS = 100;
// Runner file-command and runtime variables, left out of the build environment.
const RUNNER_CONTROL = /^(GITHUB_(ENV|PATH|OUTPUT|STATE|STEP_SUMMARY)|ACTIONS_.+)$/;
// Job variables passed into the build container (by name).
const CONTAINER_ENV = ['GITHUB_ACTOR', 'GITHUB_USERNAME', 'GITHUB_TOKEN'];
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;

// ---------- helpers ----------
function emptyCounts() { return { modules: 0, components: 0, edges: 0, invocations: 0, failedInvocations: 0 }; }
function emptyInventory(tool, state, errors) { return { state, tool, invocations: [], modules: [], components: [], edges: [], counts: emptyCounts(), errors }; }
function pushError(errors, code, message, retryable = false) {
  if (errors.length >= MAX_ERRORS || errors.some(e => e.code === code)) return;
  errors.push({ code, message: String(message).slice(0, 4096), retryable });
}
function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function writeJson(file, value) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); }
function text(v) { return typeof v === 'string' ? v : v == null ? '' : String(v); }
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function listOf(items, limit = 5) { return items.slice(0, limit).join('; ') + (items.length > limit ? ` … (+${items.length - limit})` : ''); }
function summary(path, inventory) {
  console.error(`inventory written to ${path}: ${JSON.stringify({ state: inventory.state, tool: inventory.tool, ...inventory.counts, errors: inventory.errors.map(e => e.code) })}`);
}

// ---------- harvest: the per-module files the build tool left behind ----------
/** Maven: <module>/target/adrm-dependency-tree.json (module = its pom.xml); Gradle: <project>/build/adrm-dependencies.json. */
function harvest(tool, from, { remove }) {
  const root = resolve(from);
  const marker = tool === 'maven' ? { dir: 'target', file: MAVEN_TREE_FILE } : { dir: 'build', file: GRADLE_FILE };
  const files = [], parseErrors = [];
  const visit = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const p = join(dir, entry.name);
      if (entry.name === marker.dir) {
        const file = join(p, marker.file);
        let stat = null;
        try { stat = lstatSync(file); } catch { /* no file in this module */ }
        if (stat) {
          const path = relative(root, file);
          const moduleDir = relative(root, dir) || '.';
          // Symbolic links are not followed.
          if (!stat.isFile()) parseErrors.push({ path, message: 'not a regular file' });
          else {
            try { files.push({ path, module: tool === 'maven' ? join(moduleDir, 'pom.xml') : moduleDir, data: readJson(file) }); }
            catch (error) { parseErrors.push({ path, message: error.message }); }
          }
          if (remove) { try { unlinkSync(file); } catch { /* best effort: the next invocation overwrites it anyway */ } }
        }
        continue; // build output is never descended into
      }
      visit(p);
    }
  };
  visit(root);
  files.sort((a, b) => cmp(a.path, b.path));
  parseErrors.sort((a, b) => cmp(a.path, b.path));
  return { files, parseErrors };
}

// ---------- normalize: raw per-module documents -> modules / components / edges ----------
function normalizeMavenTree(file, { addModule, addComponent, addEdge }) {
  const root = file.data;
  if (!root || typeof root !== 'object' || !text(root.groupId) || !text(root.artifactId) || !text(root.version)) throw new Error('not a dependency tree: the root node has no coordinates');
  const module = addModule({ group: text(root.groupId), name: text(root.artifactId), version: text(root.version), path: file.module, packaging: text(root.type) || null });
  const visit = (node, depth, via) => {
    for (const child of Array.isArray(node.children) ? node.children : []) {
      // `{ }` is how the JSON tree marks a node already visited in this module's tree: no coordinates, no subtree.
      if (!child || typeof child !== 'object' || !text(child.groupId) || !text(child.artifactId) || !text(child.version)) continue;
      const component = addComponent({ group: text(child.groupId), name: text(child.artifactId), version: text(child.version), type: text(child.type) || null, classifier: text(child.classifier) || null });
      const scope = text(child.scope);
      addEdge({ module, component, scope: SCOPES.has(scope) ? scope : null, configuration: null, optional: text(child.optional) === 'true', direct: depth === 1, via });
      visit(child, depth + 1, component);
    }
  };
  visit(root, 1, null);
}

/** Project path -> coordinates: its first Maven publication, else group:name:version. */
function gradleProjectCoordinates(raws) {
  const coordinates = new Map();
  for (const raw of raws) for (const file of raw.files ?? []) {
    const doc = file.data;
    if (!doc || typeof doc !== 'object' || !doc.project || !text(doc.project.path) || coordinates.has(doc.project.path)) continue;
    const publication = (Array.isArray(doc.publications) ? doc.publications : []).find(p => p && text(p.groupId) && text(p.artifactId) && text(p.version));
    coordinates.set(doc.project.path, publication
      ? { group: text(publication.groupId), name: text(publication.artifactId), version: text(publication.version) }
      : { group: text(doc.project.group), name: text(doc.project.name), version: text(doc.project.version) });
  }
  return coordinates;
}

function normalizeGradleDocument(file, coordinates, { addModule, addComponent, addEdge, incomplete }) {
  const doc = file.data;
  if (!doc || typeof doc !== 'object' || !doc.project || !text(doc.project.path) || !Array.isArray(doc.configurations)) throw new Error('not an adrm Gradle dependency document');
  if (doc.configurations.length === 0) return; // a container project without classpath configurations
  const own = coordinates.get(doc.project.path);
  if (!own.group || !own.name || !own.version) throw new Error(`project ${doc.project.path} has no coordinates`);
  const module = addModule({ ...own, path: file.module, packaging: null });
  const componentOf = (entry, key) => {
    const c = entry.components && entry.components[key];
    if (!c) throw new Error(`configuration ${entry.name}: unknown component ${key}`);
    const coords = c.project && coordinates.has(c.project) ? coordinates.get(c.project) : { group: text(c.group), name: text(c.name), version: text(c.version) };
    if (!coords.group || !coords.name || !coords.version) throw new Error(`configuration ${entry.name}: component ${key} without coordinates`);
    return addComponent({ ...coords, type: null, classifier: null });
  };
  for (const entry of doc.configurations) {
    const name = text(entry && entry.name) || '?';
    if (entry && entry.error) incomplete.push(`${doc.project.path}:${name}: ${entry.error}`);
    for (const u of Array.isArray(entry && entry.unresolved) ? entry.unresolved : []) incomplete.push(`${doc.project.path}:${name}: ${text(u.attempted) || '?'} (${text(u.message) || 'unresolved'})`);
    for (const edge of Array.isArray(entry && entry.edges) ? entry.edges : []) {
      const component = componentOf(entry, edge.to);
      const via = edge.from == null ? null : componentOf(entry, edge.from);
      addEdge({ module, component, scope: null, configuration: name, optional: false, direct: via === null, via });
    }
  }
}

/** Normalizes one or more raw harvests; invocations merge by module coordinates and the order is deterministic. */
function normalizeRaw(tool, raws) {
  const modules = new Map(), components = new Map(), edges = new Map();
  const moduleKey = m => `${m.group}:${m.name}:${m.version}`;
  const componentKey = c => `${c.group}:${c.name}:${c.version}:${c.type ?? ''}:${c.classifier ?? ''}`;
  const addModule = m => { const k = moduleKey(m); if (!modules.has(k)) modules.set(k, m); return k; };
  const addComponent = c => { const k = componentKey(c); if (!components.has(k)) components.set(k, c); return k; };
  const addEdge = e => { const k = `${e.module}|${e.component}|${e.configuration ?? ''}|${e.scope ?? ''}|${e.via ?? ''}`; if (!edges.has(k)) edges.set(k, e); };
  const invocations = [], parseErrors = [], incomplete = [], errors = [];
  const coordinates = tool === 'gradle' ? gradleProjectCoordinates(raws) : null;
  for (const raw of raws) {
    if (raw.invocation) invocations.push(raw.invocation);
    for (const p of Array.isArray(raw.parseErrors) ? raw.parseErrors : []) parseErrors.push(p);
    for (const file of Array.isArray(raw.files) ? raw.files : []) {
      try {
        if (tool === 'maven') normalizeMavenTree(file, { addModule, addComponent, addEdge });
        else normalizeGradleDocument(file, coordinates, { addModule, addComponent, addEdge, incomplete });
      } catch (error) { parseErrors.push({ path: file.path, message: error.message }); }
    }
  }
  const moduleList = [...modules.values()].sort((a, b) => cmp(a.group, b.group) || cmp(a.name, b.name) || cmp(a.version, b.version) || cmp(a.path ?? '', b.path ?? ''));
  const componentList = [...components.values()].sort((a, b) => cmp(a.group, b.group) || cmp(a.name, b.name) || cmp(a.version, b.version) || cmp(a.type ?? '', b.type ?? '') || cmp(a.classifier ?? '', b.classifier ?? ''));
  const moduleIds = new Map(moduleList.map((m, i) => [moduleKey(m), i]));
  const componentIds = new Map(componentList.map((c, i) => [componentKey(c), i]));
  const edgeList = [...edges.values()]
    .map(e => ({ module: moduleIds.get(e.module), component: componentIds.get(e.component), scope: e.scope, configuration: e.configuration, optional: e.optional, direct: e.direct, via: e.via === null ? null : componentIds.get(e.via) }))
    .sort((a, b) => a.module - b.module || cmp(a.configuration ?? '', b.configuration ?? '') || a.component - b.component || cmp(a.scope ?? '', b.scope ?? '') || (a.via ?? -1) - (b.via ?? -1));

  const failed = invocations.filter(i => i.exitCode !== 0);
  if (failed.length) pushError(errors, 'INVOCATION_FAILED', `Build tool invocations failed: ${listOf(failed.map(i => `#${i.index + 1} exit ${i.exitCode}: ${i.command}`))}`, true);
  if (parseErrors.length) pushError(errors, 'TREE_PARSE_ERROR', `Dependency files could not be parsed: ${listOf(parseErrors.map(p => `${p.path}: ${p.message}`))}`);
  if (incomplete.length) pushError(errors, 'RESOLUTION_INCOMPLETE', `Configurations are not fully resolved: ${listOf(incomplete)}`, true);
  if (moduleList.length === 0) pushError(errors, 'NO_MODULES', 'No module left a dependency file: the build tool did not run or did not write the graph.', true);
  const state = moduleList.length === 0 ? 'error' : errors.length ? 'partial' : 'complete';
  return {
    state, tool,
    invocations: invocations.map(i => ({ command: i.command, exitCode: i.exitCode, durationMs: i.durationMs })),
    modules: moduleList.map((m, id) => ({ id, ...m })),
    components: componentList.map((c, id) => ({ id, ...c })),
    edges: edgeList,
    counts: { modules: moduleList.length, components: componentList.length, edges: edgeList.length, invocations: invocations.length, failedInvocations: failed.length },
    errors,
  };
}

// ---------- run: the build tool in "only resolve the graph" mode, one invocation per args line ----------
function resolveLauncher(tool, from, command) {
  const chosen = command || (tool === 'maven' ? (existsSync(join(from, 'mvnw')) ? './mvnw' : 'mvn') : (existsSync(join(from, 'gradlew')) ? './gradlew' : 'gradle'));
  if (!chosen.includes('/')) return { display: chosen, executable: chosen };
  const executable = resolve(from, chosen);
  if (!existsSync(executable)) throw new Error(`launcher not found: ${executable}`);
  return { display: chosen, executable };
}

/** A bare launcher (`mvn`, `gradle`) on the host PATH: its real path and its installation directory. */
function hostInstallation(command) {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, command);
    try { accessSync(candidate, constants.X_OK); } catch { continue; }
    const executable = realpathSync(candidate);
    return { executable, root: basename(dirname(executable)) === 'bin' ? dirname(dirname(executable)) : dirname(executable) };
  }
  return null;
}

/** The environment of a build on the host, without the runner variables. */
function hostEnv() { return Object.fromEntries(Object.entries(process.env).filter(([name]) => !RUNNER_CONTROL.test(name))); }

/** `docker run --rm` of one invocation: the checkout and the build's home read-write, the other mounts read-only. */
function containerCommand(image, executable, argv, { from, home, mounts }) {
  for (const path of [from, home, ...mounts]) if (/[\s:,]/.test(path)) throw new Error(`cannot mount a path with whitespace, ':' or ',' into the build container: ${path}`);
  const args = ['run', '--rm', '--init', '--user', `${process.getuid()}:${process.getgid()}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--workdir', from,
    '--env', `HOME=${home}`, '--env', `GRADLE_USER_HOME=${join(home, '.gradle')}`, '--env', `JAVA_TOOL_OPTIONS=-Duser.home=${home}`,
    ...CONTAINER_ENV.filter(name => process.env[name] !== undefined).flatMap(name => ['--env', name]),
    '--volume', `${from}:${from}`, '--volume', `${home}:${home}`, ...[...new Set(mounts)].flatMap(path => ['--volume', `${path}:${path}:ro`]),
    image, executable, ...argv];
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name === 'PATH' || name === 'HOME' || name.startsWith('DOCKER_') || CONTAINER_ENV.includes(name)));
  return { file: 'docker', args, env };
}

function run(opts) {
  const tool = text(opts.tool);
  const from = resolve(opts.from || '.');
  const out = resolve(opts.out || 'adrm-dependencies');
  const inventoryPath = join(out, 'inventory.json');
  const finish = inventory => { writeJson(inventoryPath, inventory); summary(inventoryPath, inventory); };
  if (tool === 'sbt') return finish(emptyInventory('sbt', 'unsupported', [{ code: 'TOOL_UNSUPPORTED', message: 'The dependency inventory does not support sbt.', retryable: false }]));
  if (!['maven', 'gradle'].includes(tool)) return finish(emptyInventory(null, 'error', [{ code: 'INPUT_INVALID', message: `Unknown build tool: ${tool || '(empty)'}; expected maven, gradle or sbt.`, retryable: false }]));
  const image = opts.container ? text(opts.container) : null;
  if (image !== null && !IMAGE.test(image)) throw new Error(`--container must be an image reference: ${image.slice(0, 100)}`);
  const settings = tool === 'maven' && opts['maven-settings'] ? resolve(text(opts['maven-settings'])) : null;
  if (settings && !existsSync(settings)) throw new Error(`Maven settings not found: ${settings}`);
  const launcher = resolveLauncher(tool, from, opts.command);
  // A bare launcher comes from the host installation; the image provides the JDK.
  const installation = image && !launcher.display.includes('/') ? hostInstallation(launcher.display) : null;
  const home = join(out, 'home');
  if (image) { mkdirSync(home, { recursive: true }); console.log(`adrm dependencies: every invocation runs in a throwaway ${image} container`); }
  const mounts = [installation?.root, tool === 'gradle' ? dirname(GRADLE_INIT_SCRIPT) : null, settings].filter(Boolean);
  const lines = opts['args-file'] ? readFileSync(opts['args-file'], 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')) : [];
  const rawDir = join(out, 'raw');
  mkdirSync(rawDir, { recursive: true });
  const raws = (lines.length ? lines : ['']).map((line, index) => {
    const extra = line ? line.split(/\s+/) : [];
    const argv = tool === 'maven'
      ? ['-B', '-ntp', '-fae', '-T', '1C', '-Dscan=false', ...(settings ? ['--global-settings', settings] : []), ...extra, MAVEN_TREE_GOAL, '-DoutputType=json', `-DoutputFile=target/${MAVEN_TREE_FILE}`, '-DoutputEncoding=UTF-8']
      : ['--init-script', GRADLE_INIT_SCRIPT, '--no-daemon', '--no-configuration-cache', '--continue', ...extra, GRADLE_TASK];
    const command = [launcher.display, ...argv].join(' ');
    console.log(`::group::adrm dependencies: invocation ${index + 1}: ${command}`);
    const started = Date.now();
    const spawn = image
      ? containerCommand(image, installation?.executable ?? launcher.executable, argv, { from, home, mounts })
      : { file: launcher.executable, args: argv, env: hostEnv() };
    const result = spawnSync(spawn.file, spawn.args, { cwd: from, stdio: ['ignore', 'inherit', 'inherit'], env: spawn.env });
    const durationMs = Date.now() - started;
    if (result.error) console.error(`adrm dependencies: ${result.error.message}`);
    console.log('::endgroup::');
    const exitCode = result.error ? -1 : (result.status ?? -1);
    const { files, parseErrors } = harvest(tool, from, { remove: true });
    const raw = { schema: 'adrm/dependency-raw/v1', tool, invocation: { index, command, exitCode, durationMs }, files, parseErrors };
    writeJson(join(rawDir, `${index}.json`), raw);
    console.error(`adrm dependencies: invocation ${index + 1} exit ${exitCode} in ${durationMs} ms, ${files.length} module file(s), ${parseErrors.length} parse error(s)`);
    return raw;
  });
  finish(normalizeRaw(tool, raws));
}

function normalize(opts) {
  const tool = text(opts.tool);
  if (!['maven', 'gradle'].includes(tool)) throw new Error('--tool must be maven or gradle');
  const outPath = resolve(opts.out || 'inventory.json');
  let raws;
  if (opts.raw) {
    const dir = resolve(opts.raw);
    raws = readdirSync(dir).filter(f => /^\d+\.json$/.test(f)).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10)).map(f => readJson(join(dir, f)));
  } else {
    const { files, parseErrors } = harvest(tool, resolve(opts.from || '.'), { remove: false });
    raws = [{ schema: 'adrm/dependency-raw/v1', tool, invocation: null, files, parseErrors }];
  }
  const inventory = normalizeRaw(tool, raws);
  writeJson(outPath, inventory);
  summary(outPath, inventory);
}

// ---------- report: the ADRM envelope (dependencies.json, dependency-inventory v1) ----------
// Inputs from the environment, as for `line`, plus BUILD_TOOL: REQUEST_ID, GENERATION, GITHUB_REPOSITORY,
// GITHUB_REPOSITORY_ID, GITHUB_REF_NAME, GITHUB_SHA, EXPECTED_HEAD_SHA, GITHUB_WORKFLOW_REF, GITHUB_WORKFLOW_SHA,
// EXPECTED_CHECKER_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, CHECKER_SETUP_STATUS, BUILD_TOOL, RESULT_PATH.
function report(opts) {
  const env = process.env;
  const inventoryPath = resolve(opts.inventory || 'inventory.json');
  const resultPath = opts.out || env.RESULT_PATH || 'dependencies.json';
  const executionMode = opts['execution-mode'] || 'live';
  if (!['live', 'fixture'].includes(executionMode)) throw new Error('--execution-mode must be live or fixture');
  const tool = TOOLS.includes(env.BUILD_TOOL) ? env.BUILD_TOOL : null;
  const d = readBranchDispatch(env);
  const result = {
    schemaVersion: 1, executionMode, requestId: d.inputs.requestId, generation: d.inputs.generation,
    repository: d.repository,
    commit: { ref: `refs/heads/${d.inputs.branch || 'unknown'}`, sha: d.headSha, state: d.branchState },
    checker: d.checker,
    checkedAt: new Date().toISOString(),
    inventory: emptyInventory(tool, 'error', []),
  };
  const gate = dispatchGate(d, env, { skipped: 'the dependency graph was not built', setupSkipped: 'the build tool did not run' });
  if (gate) result.inventory.errors.push(gate);
  else {
    let inventory = null;
    try { inventory = readJson(inventoryPath); }
    catch (error) { pushError(result.inventory.errors, 'CHECKER_SETUP_ERROR', `The inventory did not run: ${inventoryPath} is missing or unreadable (${error.message}).`, true); }
    if (inventory) {
      const wellFormed = typeof inventory === 'object' && STATES.includes(inventory.state) && ['invocations', 'modules', 'components', 'edges', 'errors'].every(k => Array.isArray(inventory[k])) && inventory.counts && typeof inventory.counts === 'object';
      if (!wellFormed) pushError(result.inventory.errors, 'CHECKER_SETUP_ERROR', `${inventoryPath} is not an inventory.`, true);
      else result.inventory = { ...inventory, tool: inventory.tool ?? tool };
    }
  }
  result.checkedAt = new Date().toISOString();
  let body = JSON.stringify(result);
  if (Buffer.byteLength(body, 'utf8') > REPORT_LIMIT) {
    const counts = result.inventory.counts;
    result.inventory = { ...result.inventory, state: 'error', modules: [], components: [], edges: [], counts: { ...emptyCounts(), invocations: counts.invocations, failedInvocations: counts.failedInvocations }, errors: [...result.inventory.errors] };
    pushError(result.inventory.errors, 'REPORT_TOO_LARGE', `The report exceeds 16 MiB; the dependency graph is left out (${counts.modules} modules, ${counts.components} components, ${counts.edges} edges).`);
    body = JSON.stringify(result);
  }
  writeFileSync(resultPath, body);
  console.error(`dependencies.json written to ${resultPath}: ${JSON.stringify({ commit: result.commit.state, state: result.inventory.state, tool: result.inventory.tool, ...result.inventory.counts, errors: result.inventory.errors.map(e => e.code) })}`);
}

const usage = 'Usage: dependency-inventory.mjs run --tool maven|gradle|sbt [--command mvn|./mvnw|./build/mvn|./gradlew] [--args-file FILE] [--from DIR] [--out DIR] [--container IMAGE] [--maven-settings FILE]\n' +
  '       dependency-inventory.mjs normalize --tool maven|gradle (--raw DIR | --from DIR) [--out inventory.json]\n' +
  '       dependency-inventory.mjs report --inventory inventory.json [--out dependencies.json] [--execution-mode live|fixture]   (ADRM dependencies.json v1 for mode=dependencies; inputs from env)';
let parsed;
try { parsed = parseArgs(process.argv.slice(2)); } catch (error) { console.error(`${error.message}\n${usage}`); process.exit(64); }
const commands = { run, normalize, report };
if (!commands[parsed.command]) { console.error(usage); process.exit(64); }
try { commands[parsed.command](parsed.opts); } catch (error) { console.error(`error: ${error.message}`); process.exit(2); }
