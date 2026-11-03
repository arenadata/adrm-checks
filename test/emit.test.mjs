import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../src/publication-manifest.mjs', import.meta.url).pathname;
const manifest = `schema: adrm/publication-manifest/v1\nproject: example/project\nregistry: https://maven.pkg.github.com/example/project\nversion: from-tag\ngroups:\n  org.x:\n    a: [.jar, .pom]\n`;
function run(args, env) { return spawnSync('node', [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }); }

test('emit without workflow inputs writes a diagnostic report instead of touching the network', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adrm-emit-'));
  writeFileSync(join(dir, 'm.yaml'), manifest);
  const r = run(['emit', '--manifest', join(dir, 'm.yaml'), '--out', join(dir, 'r.json')], {});
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'));
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.executionMode, 'live');
  assert.equal(result.check.outcome, 'error');
  assert.equal(result.check.errors[0].code, 'INPUT_INVALID');
  assert.equal(result.publication.requirementsComplete, false);
  assert.equal(result.publicationReady, null);
});

test('emit refuses simulated observations outside fixture mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adrm-emit-'));
  writeFileSync(join(dir, 'm.yaml'), manifest);
  const r = run(['emit', '--manifest', join(dir, 'm.yaml'), '--out', join(dir, 'r.json'), '--simulate', 'a-1.0.0.jar:missing'], {});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--simulate requires --execution-mode fixture/);
});

test('emit in fixture mode marks the report so that ADRM cannot accept it as live', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adrm-emit-'));
  writeFileSync(join(dir, 'm.yaml'), manifest);
  const r = run(['emit', '--manifest', join(dir, 'm.yaml'), '--out', join(dir, 'r.json'), '--execution-mode', 'fixture'], {});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')).executionMode, 'fixture');
});

test('emit rejects a checker SHA that differs from the expected one before any network access', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adrm-emit-'));
  writeFileSync(join(dir, 'm.yaml'), manifest);
  const env = { REQUEST_ID: '12345678-1234-1234-1234-123456789abc', GENERATION: '1', GITHUB_REPOSITORY: 'example/project', GITHUB_REPOSITORY_ID: '1',
    TARGET_TAG: 'v1.0.0-4.3.0-0', TARGET_SHA: 'a'.repeat(40), TARGET_VERSION: '1.0.0-4.3.0-0', PRODUCT_VERSION: '4.3.0',
    GITHUB_WORKFLOW_REF: 'example/project/.github/workflows/release-readiness.yml@refs/heads/main', GITHUB_WORKFLOW_SHA: 'b'.repeat(40), EXPECTED_CHECKER_SHA: 'c'.repeat(40),
    GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' };
  const r = run(['emit', '--manifest', join(dir, 'm.yaml'), '--out', join(dir, 'r.json')], env);
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'));
  assert.equal(result.check.errors[0].code, 'CHECKER_CHANGED');
  assert.equal(result.target.state, 'unknown');
  assert.equal(result.publication.artifacts.length, 0);
});
