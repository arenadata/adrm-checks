import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../src/publication-manifest.mjs', import.meta.url).pathname;
function run(args, env = {}) { return spawnSync('node', [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }); }
function checkout(files) {
  const dir = mkdtempSync(join(tmpdir(), 'adrm-line-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
function declared(files) {
  const r = run(['line', '--from', checkout(files), '--version-only']);
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const pomWithParent = `<?xml version="1.0"?>\n<!-- <version>0.0.0-comment</version> -->\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n  <modelVersion>4.0.0</modelVersion>\n  <parent>\n    <groupId>org.apache</groupId>\n    <artifactId>apache</artifactId>\n    <version>35</version>\n  </parent>\n  <groupId>org.apache.hive</groupId>\n  <artifactId>hive</artifactId>\n  <version>4.3.0.2-4.4.0-2</version>\n  <packaging>pom</packaging>\n  <properties><hadoop.version>3.4.3.2-4.4.0-1</hadoop.version></properties>\n  <dependencies><dependency><groupId>x</groupId><artifactId>y</artifactId><version>9.9.9</version></dependency></dependencies>\n</project>\n`;

test('version-only: Maven project version wins over the parent version, comments and dependencies', () => {
  assert.deepEqual(declared({ 'pom.xml': pomWithParent }), { status: 0, out: 'pom.xml: 4.3.0.2-4.4.0-2', err: '' });
});

test('version-only: a Maven project without its own version inherits the parent version', () => {
  const pom = `<project><parent><groupId>g</groupId><artifactId>p</artifactId><version>1.2.3-4.4.0-0</version></parent><artifactId>child</artifactId></project>`;
  assert.equal(declared({ 'pom.xml': pom }).out, 'pom.xml: 1.2.3-4.4.0-0');
});

test('version-only: Iceberg layout (gradle.properties without version) falls through to version.txt', () => {
  const r = declared({ 'gradle.properties': 'org.gradle.jvmargs=-Xmx2g\nsystemProp.x=1\n', 'version.txt': '# release\n\n1.10.1.3-4.5.0-0\n' });
  assert.equal(r.out, 'version.txt: 1.10.1.3-4.5.0-0');
});

test('version-only: gradle.properties version, build.gradle.kts assignment and sbt ThisBuild version', () => {
  assert.equal(declared({ 'gradle.properties': '# comment\nversion = 2.0.0-4.4.0-1\n' }).out, 'gradle.properties: 2.0.0-4.4.0-1');
  assert.equal(declared({ 'build.gradle.kts': 'plugins { java }\nversion = "3.0.0-4.4.0-1" // release\n' }).out, 'build.gradle.kts: 3.0.0-4.4.0-1');
  assert.equal(declared({ 'version.sbt': 'ThisBuild / version := "0.9.0-4.4.0-3"\n' }).out, 'version.sbt: 0.9.0-4.4.0-3');
  assert.equal(declared({ 'build.sbt': 'name := "x"\nversion := "0.1.0-4.4.0-0"\n' }).out, 'build.sbt: 0.1.0-4.4.0-0');
});

test('version-only: pom.xml takes precedence and an empty checkout exits 1', () => {
  assert.equal(declared({ 'pom.xml': pomWithParent, 'version.txt': '9.9.9-4.4.0-0\n' }).out, 'pom.xml: 4.3.0.2-4.4.0-2');
  const empty = declared({});
  assert.equal(empty.status, 1);
  assert.match(empty.err, /no build file/);
});

const head = 'a'.repeat(40);
const env = {
  REQUEST_ID: '12345678-1234-1234-1234-123456789abc', GENERATION: '3', GITHUB_REPOSITORY: 'example/project', GITHUB_REPOSITORY_ID: '42',
  GITHUB_REF_NAME: 'develop/4.4.0/4.3.0', GITHUB_SHA: head, EXPECTED_HEAD_SHA: head, EXPECTED_CHECKER_SHA: head,
  GITHUB_WORKFLOW_REF: 'example/project/.github/workflows/release-readiness.yml@refs/heads/develop/4.4.0/4.3.0', GITHUB_WORKFLOW_SHA: head,
  GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '2', PRODUCT_VERSION: '4.4.0', LINE_VERSION: '4.3.0',
};
function lineState(files, overrides = {}) {
  const dir = checkout(files);
  const r = run(['line', '--from', dir, '--out', join(dir, 'line.json')], { ...env, ...overrides });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(readFileSync(join(dir, 'line.json'), 'utf8'));
}

test('line: declared version of a resolved branch head with the checker identity ADRM correlates on', () => {
  const s = lineState({ 'pom.xml': pomWithParent });
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.executionMode, 'live');
  assert.equal(s.requestId, env.REQUEST_ID);
  assert.equal(s.generation, 3);
  assert.deepEqual(s.repository, { provider: 'github', id: 42, fullName: 'example/project' });
  assert.deepEqual(s.branch, { name: 'develop/4.4.0/4.3.0', headSha: head, state: 'resolved' });
  assert.deepEqual(s.version, { state: 'declared', value: '4.3.0.2-4.4.0-2', source: { tool: 'maven', path: 'pom.xml', method: 'files' }, errors: [] });
  assert.deepEqual(s.checker, { workflowRef: env.GITHUB_WORKFLOW_REF, workflowSha: head, runId: 7, runAttempt: 2, runUrl: 'https://github.com/example/project/actions/runs/7' });
  assert.ok(!Number.isNaN(Date.parse(s.checkedAt)));
  assert.deepEqual(Object.keys(s).sort(), ['branch', 'checkedAt', 'checker', 'executionMode', 'generation', 'repository', 'requestId', 'schemaVersion', 'version']);
});

test('line: a checkout without build files is undeclared, not an error', () => {
  const s = lineState({});
  assert.deepEqual(s.version, { state: 'undeclared', value: null, source: { tool: null, path: null, method: 'files' }, errors: [] });
  assert.equal(s.branch.state, 'resolved');
});

test('line: a moved branch head is reported as changed with the actual SHA and no version is read', () => {
  const s = lineState({ 'pom.xml': pomWithParent }, { GITHUB_SHA: 'b'.repeat(40), GITHUB_WORKFLOW_SHA: 'b'.repeat(40) });
  assert.deepEqual(s.branch, { name: 'develop/4.4.0/4.3.0', headSha: 'b'.repeat(40), state: 'changed' });
  assert.equal(s.version.state, 'error');
  assert.equal(s.version.value, null);
  assert.equal(s.version.errors[0].code, 'HEAD_CHANGED');
  assert.equal(s.version.errors[0].retryable, true);
});

test('line: a different checker workflow SHA on the same head is an error, not a moved branch', () => {
  const s = lineState({ 'pom.xml': pomWithParent }, { GITHUB_WORKFLOW_SHA: 'c'.repeat(40) });
  assert.equal(s.branch.state, 'resolved');
  assert.equal(s.version.errors[0].code, 'CHECKER_CHANGED');
});

test('line: setup failure and invalid inputs become diagnostics in the report', () => {
  assert.equal(lineState({ 'pom.xml': pomWithParent }, { CHECKER_SETUP_STATUS: 'failure' }).version.errors[0].code, 'CHECKER_SETUP_ERROR');
  const s = lineState({ 'pom.xml': pomWithParent }, { REQUEST_ID: 'nope', GITHUB_RUN_ID: '0' });
  assert.equal(s.version.errors[0].code, 'INPUT_INVALID');
  assert.match(s.version.errors[0].message, /request_id, run identity/);
});

test('line: fixture mode marks the report so that ADRM cannot accept it as live', () => {
  const dir = checkout({ 'version.txt': '1.0.0-4.4.0-0\n' });
  const r = run(['line', '--from', dir, '--out', join(dir, 'line.json'), '--execution-mode', 'fixture'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, 'line.json'), 'utf8')).executionMode, 'fixture');
  assert.equal(run(['line', '--from', dir, '--execution-mode', 'demo'], env).status, 2);
});
