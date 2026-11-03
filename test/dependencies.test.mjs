import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const script = new URL('../src/dependency-inventory.mjs', import.meta.url).pathname;
function run(args, env = {}) { return spawnSync('node', [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }); }
function temp(prefix) { return mkdtempSync(join(tmpdir(), `adrm-${prefix}-`)); }
function write(file, content) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); }
function json(file) { return JSON.parse(readFileSync(file, 'utf8')); }

// ---------- fixtures ----------
const node = (groupId, artifactId, version, extra = {}) => ({ groupId, artifactId, version, type: 'jar', scope: 'compile', classifier: '', optional: 'false', ...extra });
const guava = node('com.google.guava', 'guava', '32.1.3-jre', { children: [node('com.google.guava', 'failureaccess', '1.0.1')] });
const mavenTrees = {
  'target/adrm-dependency-tree.json': node('org.example', 'parent', '1.0.0-4.5.0-0', { type: 'pom', scope: '' }),
  'a/target/adrm-dependency-tree.json': node('org.example', 'a', '1.0.0-4.5.0-0', { scope: '', children: [
    guava,
    node('org.apache.hadoop', 'hadoop-common', '3.4.3.2-4.4.0-1', { scope: 'provided', children: [{}] }),
    node('org.slf4j', 'slf4j-api', '2.0.9', { optional: 'true' }),
  ] }),
  'b/target/adrm-dependency-tree.json': node('org.example', 'b', '1.0.0-4.5.0-0', { scope: '', children: [
    node('org.example', 'a', '1.0.0-4.5.0-0', { children: [guava] }),
    node('org.example', 'a', '1.0.0-4.5.0-0', { type: 'test-jar', scope: 'test', classifier: 'tests' }),
    node('junit', 'junit', '4.13.2', { scope: 'test' }),
  ] }),
};
function mavenCheckout(trees = mavenTrees) {
  const dir = temp('maven');
  for (const [path, tree] of Object.entries(trees)) write(join(dir, path), tree);
  return dir;
}
function normalizeFrom(tool, dir) {
  const out = join(dir, 'inventory.json');
  const r = run(['normalize', '--tool', tool, '--from', dir, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  return json(out);
}
const byName = (inventory, name) => inventory.components.find(c => c.name === name && !c.classifier);
const edge = (inventory, moduleName, component, filter = {}) => inventory.edges.find(e => inventory.modules[e.module].name === moduleName && e.component === component.id && Object.entries(filter).every(([k, v]) => e[k] === v));

// ---------- normalize: Maven ----------
test('normalize maven: modules, components and edges with scope, optional, direct and via; the { } marker is skipped', () => {
  const inv = normalizeFrom('maven', mavenCheckout());
  assert.equal(inv.state, 'complete');
  assert.equal(inv.tool, 'maven');
  assert.deepEqual(inv.errors, []);
  assert.deepEqual(inv.invocations, []);
  assert.deepEqual(inv.modules, [
    { id: 0, group: 'org.example', name: 'a', version: '1.0.0-4.5.0-0', path: 'a/pom.xml', packaging: 'jar' },
    { id: 1, group: 'org.example', name: 'b', version: '1.0.0-4.5.0-0', path: 'b/pom.xml', packaging: 'jar' },
    { id: 2, group: 'org.example', name: 'parent', version: '1.0.0-4.5.0-0', path: 'pom.xml', packaging: 'pom' },
  ]);
  assert.deepEqual(inv.components.map(c => `${c.group}:${c.name}:${c.version}:${c.type}:${c.classifier}`), [
    'com.google.guava:failureaccess:1.0.1:jar:null', 'com.google.guava:guava:32.1.3-jre:jar:null', 'junit:junit:4.13.2:jar:null',
    'org.apache.hadoop:hadoop-common:3.4.3.2-4.4.0-1:jar:null', 'org.example:a:1.0.0-4.5.0-0:jar:null', 'org.example:a:1.0.0-4.5.0-0:test-jar:tests', 'org.slf4j:slf4j-api:2.0.9:jar:null',
  ]);
  assert.equal(inv.components.every((c, i) => c.id === i), true);
  assert.deepEqual(inv.counts, { modules: 3, components: 7, edges: 9, invocations: 0, failedInvocations: 0 });
  const g = byName(inv, 'guava'), fa = byName(inv, 'failureaccess'), hc = byName(inv, 'hadoop-common'), sl = byName(inv, 'slf4j-api'), a = byName(inv, 'a'), ju = byName(inv, 'junit');
  const aTests = inv.components.find(c => c.name === 'a' && c.classifier === 'tests');
  assert.deepEqual(edge(inv, 'a', g), { module: 0, component: g.id, scope: 'compile', configuration: null, optional: false, direct: true, via: null });
  assert.deepEqual(edge(inv, 'a', fa), { module: 0, component: fa.id, scope: 'compile', configuration: null, optional: false, direct: false, via: g.id });
  assert.equal(edge(inv, 'a', hc).scope, 'provided');
  assert.equal(edge(inv, 'a', sl).optional, true);
  assert.deepEqual(edge(inv, 'b', a), { module: 1, component: a.id, scope: 'compile', configuration: null, optional: false, direct: true, via: null });
  assert.equal(edge(inv, 'b', g).via, a.id);
  assert.equal(edge(inv, 'b', fa).via, g.id);
  assert.deepEqual(edge(inv, 'b', aTests), { module: 1, component: aTests.id, scope: 'test', configuration: null, optional: false, direct: true, via: null });
  assert.equal(edge(inv, 'b', ju).scope, 'test');
  assert.equal(inv.edges.every(e => e.direct === (e.via === null)), true);
  assert.equal(inv.edges.filter(e => e.module === 2).length, 0);
});

// ---------- normalize: Gradle ----------
const gradleDocs = {
  'build/adrm-dependencies.json': { schema: 'adrm/gradle-dependencies/v1', project: { path: ':', group: 'org.example', name: 'root', version: '1.0.0-4.5.0-0', dir: '.' }, publications: [], configurations: [] },
  'clients/build/adrm-dependencies.json': {
    schema: 'adrm/gradle-dependencies/v1', project: { path: ':clients', group: 'org.example', name: 'clients', version: '1.0.0-4.5.0-0', dir: 'clients' },
    publications: [{ name: 'maven', groupId: 'org.example', artifactId: 'example-clients', version: '1.0.0-4.5.0-0' }],
    configurations: [
      { name: 'compileClasspath', root: 'org.example:clients:1.0.0-4.5.0-0', components: { 'com.google.guava:guava:32.1.3-jre': { group: 'com.google.guava', name: 'guava', version: '32.1.3-jre', project: null } }, edges: [{ from: null, to: 'com.google.guava:guava:32.1.3-jre' }], unresolved: [], error: null },
      { name: 'runtimeClasspath', root: 'org.example:clients:1.0.0-4.5.0-0', components: { 'com.google.guava:guava:32.1.3-jre': { group: 'com.google.guava', name: 'guava', version: '32.1.3-jre', project: null } }, edges: [{ from: null, to: 'com.google.guava:guava:32.1.3-jre' }], unresolved: [{ from: null, attempted: 'org.example:missing:1.0', message: 'Could not find org.example:missing:1.0.' }], error: null },
    ],
  },
  'core/build/adrm-dependencies.json': {
    schema: 'adrm/gradle-dependencies/v1', project: { path: ':core', group: 'org.example', name: 'core', version: '1.0.0-4.5.0-0', dir: 'core' }, publications: [],
    configurations: [
      { name: 'compileClasspath', root: 'org.example:core:1.0.0-4.5.0-0', components: {
        'org.example:clients:1.0.0-4.5.0-0': { group: 'org.example', name: 'clients', version: '1.0.0-4.5.0-0', project: ':clients' },
        'com.google.guava:guava:32.1.3-jre': { group: 'com.google.guava', name: 'guava', version: '32.1.3-jre', project: null },
      }, edges: [{ from: null, to: 'org.example:clients:1.0.0-4.5.0-0' }, { from: 'org.example:clients:1.0.0-4.5.0-0', to: 'com.google.guava:guava:32.1.3-jre' }], unresolved: [], error: null },
    ],
  },
};
test('normalize gradle: project coordinates come from publications, container projects are skipped, unresolved entries make the inventory partial', () => {
  const dir = temp('gradle');
  for (const [path, doc] of Object.entries(gradleDocs)) write(join(dir, path), doc);
  const inv = normalizeFrom('gradle', dir);
  assert.equal(inv.state, 'partial');
  assert.deepEqual(inv.errors.map(e => [e.code, e.retryable]), [['RESOLUTION_INCOMPLETE', true]]);
  assert.match(inv.errors[0].message, /:clients:runtimeClasspath: org\.example:missing:1\.0/);
  assert.deepEqual(inv.modules, [
    { id: 0, group: 'org.example', name: 'core', version: '1.0.0-4.5.0-0', path: 'core', packaging: null },
    { id: 1, group: 'org.example', name: 'example-clients', version: '1.0.0-4.5.0-0', path: 'clients', packaging: null },
  ]);
  assert.deepEqual(inv.components.map(c => `${c.group}:${c.name}:${c.version}`), ['com.google.guava:guava:32.1.3-jre', 'org.example:example-clients:1.0.0-4.5.0-0']);
  assert.equal(inv.components.every(c => c.type === null && c.classifier === null), true);
  const g = byName(inv, 'guava'), clients = byName(inv, 'example-clients');
  assert.deepEqual(edge(inv, 'core', clients), { module: 0, component: clients.id, scope: null, configuration: 'compileClasspath', optional: false, direct: true, via: null });
  assert.deepEqual(edge(inv, 'core', g), { module: 0, component: g.id, scope: null, configuration: 'compileClasspath', optional: false, direct: false, via: clients.id });
  assert.ok(edge(inv, 'example-clients', g, { configuration: 'compileClasspath', direct: true }));
  assert.ok(edge(inv, 'example-clients', g, { configuration: 'runtimeClasspath', direct: true }));
  assert.equal(inv.counts.edges, 4);
});

// ---------- normalize: merge, determinism, parse errors ----------
function rawFile(tool, invocation, files, parseErrors = []) { return { schema: 'adrm/dependency-raw/v1', tool, invocation, files, parseErrors }; }
test('normalize --raw merges invocations by module coordinates and reports a failed invocation as partial', () => {
  const dir = temp('raw');
  const a1 = node('org.example', 'a', '1.0.0-4.5.0-0', { scope: '', children: [node('x', 'one', '1')] });
  const a2 = node('org.example', 'a', '1.0.0-4.5.0-0', { scope: '', children: [node('x', 'one', '1'), node('x', 'two', '2')] });
  write(join(dir, 'raw/0.json'), rawFile('maven', { index: 0, command: 'mvn tree -Pone', exitCode: 0, durationMs: 10 }, [{ path: 'a/target/adrm-dependency-tree.json', module: 'a/pom.xml', data: a1 }]));
  write(join(dir, 'raw/1.json'), rawFile('maven', { index: 1, command: 'mvn tree -Ptwo', exitCode: 1, durationMs: 20 }, [{ path: 'a/target/adrm-dependency-tree.json', module: 'a/pom.xml', data: a2 }]));
  const out = join(dir, 'inventory.json');
  assert.equal(run(['normalize', '--tool', 'maven', '--raw', join(dir, 'raw'), '--out', out]).status, 0);
  const inv = json(out);
  assert.equal(inv.state, 'partial');
  assert.deepEqual(inv.invocations, [{ command: 'mvn tree -Pone', exitCode: 0, durationMs: 10 }, { command: 'mvn tree -Ptwo', exitCode: 1, durationMs: 20 }]);
  assert.deepEqual(inv.counts, { modules: 1, components: 2, edges: 2, invocations: 2, failedInvocations: 1 });
  assert.deepEqual(inv.errors.map(e => [e.code, e.retryable]), [['INVOCATION_FAILED', true]]);
  assert.match(inv.errors[0].message, /#2 код 1: mvn tree -Ptwo/);
});

test('normalize is deterministic: the order of the raw files does not change the result', () => {
  const trees = Object.entries(mavenTrees).map(([path, data]) => ({ path, module: path.replace('target/adrm-dependency-tree.json', 'pom.xml'), data }));
  const forward = temp('det-a'), backward = temp('det-b');
  write(join(forward, 'raw/0.json'), rawFile('maven', null, trees));
  write(join(backward, 'raw/0.json'), rawFile('maven', null, [...trees].reverse()));
  for (const dir of [forward, backward]) assert.equal(run(['normalize', '--tool', 'maven', '--raw', join(dir, 'raw'), '--out', join(dir, 'inventory.json')]).status, 0);
  assert.equal(readFileSync(join(forward, 'inventory.json'), 'utf8'), readFileSync(join(backward, 'inventory.json'), 'utf8'));
});

test('normalize: a file that is not a tree makes the inventory partial next to good modules and an error alone', () => {
  const dir = mavenCheckout({ ...mavenTrees, 'c/target/adrm-dependency-tree.json': '{ not json' });
  const partial = normalizeFrom('maven', dir);
  assert.equal(partial.state, 'partial');
  assert.deepEqual(partial.errors.map(e => e.code), ['TREE_PARSE_ERROR']);
  assert.match(partial.errors[0].message, /c\/target\/adrm-dependency-tree\.json/);
  assert.equal(partial.counts.modules, 3);
  const alone = normalizeFrom('maven', mavenCheckout({ 'target/adrm-dependency-tree.json': { children: [] } }));
  assert.equal(alone.state, 'error');
  assert.deepEqual(alone.errors.map(e => e.code).sort(), ['NO_MODULES', 'TREE_PARSE_ERROR']);
  assert.deepEqual([alone.modules, alone.components, alone.edges], [[], [], []]);
});

// ---------- run ----------
test('run: sbt is unsupported and an unknown tool is an input error, both with exit code 0', () => {
  const dir = temp('run-tool');
  assert.equal(run(['run', '--tool', 'sbt', '--from', dir, '--out', join(dir, 'out')]).status, 0);
  const sbt = json(join(dir, 'out/inventory.json'));
  assert.equal(sbt.state, 'unsupported');
  assert.equal(sbt.tool, 'sbt');
  assert.deepEqual(sbt.errors.map(e => [e.code, e.retryable]), [['TOOL_UNSUPPORTED', false]]);
  assert.deepEqual(sbt.counts, { modules: 0, components: 0, edges: 0, invocations: 0, failedInvocations: 0 });
  assert.equal(run(['run', '--tool', 'ant', '--from', dir, '--out', join(dir, 'out2')]).status, 0);
  const unknown = json(join(dir, 'out2/inventory.json'));
  assert.equal(unknown.state, 'error');
  assert.equal(unknown.tool, null);
  assert.deepEqual(unknown.errors.map(e => e.code), ['INPUT_INVALID']);
});

function fakeLauncher(dir) {
  // Writes the trees a Maven run would leave in target/ and records its arguments; exit code from FAKE_EXIT.
  const launcher = join(dir, 'fake-mvn');
  writeFileSync(launcher, `#!/bin/sh
printf '%s\\n' "$@" >> "$(dirname "$0")/launcher-args.txt"
mkdir -p target a/target
cp "$(dirname "$0")/fixtures/root.json" target/adrm-dependency-tree.json
cp "$(dirname "$0")/fixtures/a.json" a/target/adrm-dependency-tree.json
exit "\${FAKE_EXIT:-0}"
`);
  chmodSync(launcher, 0o755);
  write(join(dir, 'fixtures/root.json'), mavenTrees['target/adrm-dependency-tree.json']);
  write(join(dir, 'fixtures/a.json'), mavenTrees['a/target/adrm-dependency-tree.json']);
  return launcher;
}

test('run: one invocation per args line with the publisher flags before the tree goal; harvested files are removed', () => {
  const dir = temp('run');
  fakeLauncher(dir);
  write(join(dir, 'args.txt'), '# profiles of the publisher\n\n-DskipTests -Pdist\n-Pextra\n');
  const r = run(['run', '--tool', 'maven', '--command', './fake-mvn', '--args-file', join(dir, 'args.txt'), '--from', dir, '--out', join(dir, 'out')]);
  assert.equal(r.status, 0, r.stderr);
  const inv = json(join(dir, 'out/inventory.json'));
  assert.equal(inv.state, 'complete', JSON.stringify(inv.errors));
  assert.equal(inv.invocations.length, 2);
  assert.equal(inv.invocations[0].command, './fake-mvn -B -ntp -fae -T 1C -Dscan=false -DskipTests -Pdist org.apache.maven.plugins:maven-dependency-plugin:3.11.0:tree -DoutputType=json -DoutputFile=target/adrm-dependency-tree.json -DoutputEncoding=UTF-8');
  assert.equal(inv.invocations[1].command.includes(' -Pextra org.apache.maven.plugins:'), true);
  assert.equal(inv.invocations.every(i => i.exitCode === 0 && Number.isInteger(i.durationMs) && i.durationMs >= 0), true);
  assert.deepEqual(inv.counts, { modules: 2, components: 4, edges: 4, invocations: 2, failedInvocations: 0 });
  const argLines = readFileSync(join(dir, 'launcher-args.txt'), 'utf8').trim().split('\n');
  assert.equal(argLines.filter(l => l === '-Pextra').length, 1);
  assert.equal(argLines[0], '-B');
  assert.equal(existsSync(join(dir, 'a/target/adrm-dependency-tree.json')), false);
  assert.equal(existsSync(join(dir, 'out/raw/1.json')), true);
  assert.match(r.stdout, /::group::adrm dependencies: invocation 1: \.\/fake-mvn /);
});

test('run: a launcher exit code other than 0 makes the inventory partial with a retryable INVOCATION_FAILED', () => {
  const dir = temp('run-fail');
  fakeLauncher(dir);
  const r = run(['run', '--tool', 'maven', '--command', './fake-mvn', '--from', dir, '--out', join(dir, 'out')], { FAKE_EXIT: '3' });
  assert.equal(r.status, 0, r.stderr);
  const inv = json(join(dir, 'out/inventory.json'));
  assert.equal(inv.state, 'partial');
  assert.deepEqual(inv.invocations.map(i => i.exitCode), [3]);
  assert.deepEqual(inv.errors.map(e => [e.code, e.retryable]), [['INVOCATION_FAILED', true]]);
  assert.equal(inv.counts.failedInvocations, 1);
  assert.equal(run(['run', '--tool', 'maven', '--command', './missing-launcher', '--from', dir, '--out', join(dir, 'out2')]).status, 2);
});

// ---------- report ----------
const head = 'a'.repeat(40);
const env = {
  REQUEST_ID: '12345678-1234-1234-1234-123456789abc', GENERATION: '3', GITHUB_REPOSITORY: 'example/project', GITHUB_REPOSITORY_ID: '42',
  GITHUB_REF_NAME: 'develop/4.4.0/4.3.0', GITHUB_SHA: head, EXPECTED_HEAD_SHA: head, EXPECTED_CHECKER_SHA: head,
  GITHUB_WORKFLOW_REF: 'example/project/.github/workflows/release-readiness.yml@refs/heads/develop/4.4.0/4.3.0', GITHUB_WORKFLOW_SHA: head,
  GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '2', PRODUCT_VERSION: '4.4.0', LINE_VERSION: '4.3.0', BUILD_TOOL: 'maven',
};
function reportOf(inventoryFile, overrides = {}, extraArgs = []) {
  const out = join(dirname(inventoryFile), 'dependencies.json');
  const r = run(['report', '--inventory', inventoryFile, '--out', out, ...extraArgs], { ...env, ...overrides });
  assert.equal(r.status, 0, r.stderr);
  return json(out);
}
const emptyCounts = { modules: 0, components: 0, edges: 0, invocations: 0, failedInvocations: 0 };

test('report: the envelope ADRM correlates on, with the inventory embedded verbatim', () => {
  const dir = mavenCheckout();
  const inventory = normalizeFrom('maven', dir);
  const d = reportOf(join(dir, 'inventory.json'));
  assert.deepEqual(Object.keys(d).sort(), ['checkedAt', 'checker', 'commit', 'executionMode', 'generation', 'inventory', 'repository', 'requestId', 'schemaVersion']);
  assert.equal(d.schemaVersion, 1);
  assert.equal(d.executionMode, 'live');
  assert.equal(d.requestId, env.REQUEST_ID);
  assert.equal(d.generation, 3);
  assert.deepEqual(d.repository, { provider: 'github', id: 42, fullName: 'example/project' });
  assert.deepEqual(d.commit, { ref: 'refs/heads/develop/4.4.0/4.3.0', sha: head, state: 'resolved' });
  assert.deepEqual(d.checker, { workflowRef: env.GITHUB_WORKFLOW_REF, workflowSha: head, runId: 7, runAttempt: 2, runUrl: 'https://github.com/example/project/actions/runs/7' });
  assert.ok(!Number.isNaN(Date.parse(d.checkedAt)));
  assert.deepEqual(d.inventory, inventory);
  assert.deepEqual(Object.keys(d.inventory).sort(), ['components', 'counts', 'edges', 'errors', 'invocations', 'modules', 'state', 'tool']);
});

test('report: a moved head, another wrapper revision, invalid inputs and a failed setup are diagnostics with an empty inventory', () => {
  const dir = mavenCheckout();
  normalizeFrom('maven', dir);
  const file = join(dir, 'inventory.json');
  const moved = reportOf(file, { GITHUB_SHA: 'b'.repeat(40), GITHUB_WORKFLOW_SHA: 'b'.repeat(40) });
  assert.deepEqual(moved.commit, { ref: 'refs/heads/develop/4.4.0/4.3.0', sha: 'b'.repeat(40), state: 'changed' });
  assert.equal(moved.inventory.state, 'error');
  assert.equal(moved.inventory.tool, 'maven');
  assert.deepEqual([moved.inventory.modules, moved.inventory.components, moved.inventory.edges, moved.inventory.invocations], [[], [], [], []]);
  assert.deepEqual(moved.inventory.counts, emptyCounts);
  assert.deepEqual(moved.inventory.errors.map(e => [e.code, e.retryable]), [['HEAD_CHANGED', true]]);
  assert.match(moved.inventory.errors[0].message, /граф зависимостей не строился/);
  const checker = reportOf(file, { GITHUB_WORKFLOW_SHA: 'c'.repeat(40) });
  assert.equal(checker.commit.state, 'resolved');
  assert.deepEqual(checker.inventory.errors.map(e => e.code), ['CHECKER_CHANGED']);
  const invalid = reportOf(file, { REQUEST_ID: 'nope', GITHUB_RUN_ID: '0' });
  assert.equal(invalid.inventory.errors[0].code, 'INPUT_INVALID');
  assert.match(invalid.inventory.errors[0].message, /request_id, run identity/);
  const setup = reportOf(file, { CHECKER_SETUP_STATUS: 'failure' });
  assert.deepEqual(setup.inventory.errors.map(e => [e.code, e.retryable]), [['CHECKER_SETUP_ERROR', true]]);
  const missing = reportOf(join(dir, 'absent.json'));
  assert.equal(missing.inventory.state, 'error');
  assert.deepEqual(missing.inventory.errors.map(e => [e.code, e.retryable]), [['CHECKER_SETUP_ERROR', true]]);
  assert.match(missing.inventory.errors[0].message, /absent\.json/);
});

test('report: fixture mode marks the report so that ADRM cannot accept it as live; other modes are refused', () => {
  const dir = mavenCheckout();
  normalizeFrom('maven', dir);
  assert.equal(reportOf(join(dir, 'inventory.json'), {}, ['--execution-mode', 'fixture']).executionMode, 'fixture');
  assert.equal(run(['report', '--inventory', join(dir, 'inventory.json'), '--execution-mode', 'demo'], env).status, 2);
});

test('report: a report over 16 MiB keeps the envelope and the counts in the message, not the graph', () => {
  const dir = temp('big');
  const edges = Array.from({ length: 320000 }, (_, i) => ({ module: 0, component: i % 1000, scope: 'compile', configuration: null, optional: false, direct: i < 1000, via: i < 1000 ? null : (i % 1000) }));
  const inventory = { state: 'complete', tool: 'maven', invocations: [{ command: 'mvn', exitCode: 0, durationMs: 1 }], modules: [{ id: 0, group: 'g', name: 'm', version: '1', path: 'pom.xml', packaging: 'jar' }],
    components: Array.from({ length: 1000 }, (_, id) => ({ id, group: 'org.example.group', name: `artifact-${id}`, version: '1.0.0', type: 'jar', classifier: null })), edges,
    counts: { modules: 1, components: 1000, edges: edges.length, invocations: 1, failedInvocations: 0 }, errors: [] };
  const file = join(dir, 'inventory.json');
  write(file, inventory);
  assert.ok(readFileSync(file).length > 16 * 1024 * 1024);
  const d = reportOf(file);
  assert.equal(d.inventory.state, 'error');
  assert.deepEqual([d.inventory.modules, d.inventory.components, d.inventory.edges], [[], [], []]);
  assert.deepEqual(d.inventory.counts, { ...emptyCounts, invocations: 1 });
  assert.equal(d.inventory.invocations.length, 1);
  assert.deepEqual(d.inventory.errors.map(e => e.code), ['REPORT_TOO_LARGE']);
  assert.match(d.inventory.errors[0].message, /рёбер 320000/);
  assert.ok(readFileSync(join(dir, 'dependencies.json')).length < 1024 * 1024);
});
