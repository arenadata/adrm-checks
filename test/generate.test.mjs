import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../src/publication-manifest.mjs', import.meta.url).pathname;
function layout(root, files) { for (const f of files) { mkdirSync(join(root, ...f.split('/').slice(0, -1)), { recursive: true }); writeFileSync(join(root, f), ''); } }
function run(args) { return spawnSync('node', [script, ...args], { encoding: 'utf8' }); }

test('generate --from-sandbox classifies primary, checksum and metadata files and writes version-free suffixes', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'adrm-sandbox-'));
  layout(sandbox, [
    'org/example/a/lib/1.0.0/lib-1.0.0.pom', 'org/example/a/lib/1.0.0/lib-1.0.0.pom.sha1', 'org/example/a/lib/1.0.0/lib-1.0.0.pom.md5',
    'org/example/a/lib/1.0.0/lib-1.0.0.jar', 'org/example/a/lib/1.0.0/lib-1.0.0-sources.jar', 'org/example/a/lib/1.0.0/lib-1.0.0-bin.tar.gz',
    'org/example/a/lib/1.0.0/lib-1.0.0.jar.asc', 'org/example/a/lib/maven-metadata.xml', 'org/example/a/lib/maven-metadata.xml.sha1',
    'org/example/b/parent/1.0.0/parent-1.0.0.pom',
  ]);
  const out = join(sandbox, 'publication.yaml');
  const r = run(['generate', '--from-sandbox', sandbox, '--repo', 'example/project', '--source-sha', 'a'.repeat(40), '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const yaml = readFileSync(out, 'utf8');
  assert.match(yaml, /^schema: adrm\/publication-manifest\/v1$/m);
  assert.match(yaml, /^  method: sandbox-publish$/m);
  assert.match(yaml, /^    lib: \[-bin\.tar\.gz, -sources\.jar, \.jar, \.jar\.asc, \.pom\]$/m);
  assert.match(yaml, /^    parent: \[\.pom\]$/m);
  assert.match(yaml, /^  primaryFiles: 6$/m);
  assert.match(yaml, /^  checksumFiles: 2$/m);
  assert.match(yaml, /^  metadataFiles: 2$/m);
  assert.doesNotMatch(yaml, /1\.0\.0\.(pom|jar)/, 'file names must not carry the version');
  // regenerating the same tree reports no change; a new file reports a diff and exit code 3
  const again = run(['generate', '--from-sandbox', sandbox, '--repo', 'example/project', '--out', out, '--exit-code-on-change']);
  assert.equal(again.status, 0); assert.match(again.stderr, /Manifest unchanged/);
  layout(sandbox, ['org/example/a/lib/1.0.0/lib-1.0.0-tests.jar']);
  const changed = run(['generate', '--from-sandbox', sandbox, '--repo', 'example/project', '--out', out, '--exit-code-on-change']);
  assert.equal(changed.status, 3); assert.match(changed.stderr, /~ org\.example\.a:lib added \["-tests\.jar"\]/);
});

test('generate refuses a sandbox with several versions unless explicitly allowed', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'adrm-sandbox-'));
  layout(sandbox, ['org/x/a/1.0.0/a-1.0.0.pom', 'org/x/b/2.0.0/b-2.0.0.pom']);
  const r = run(['generate', '--from-sandbox', sandbox, '--repo', 'example/project', '--out', join(sandbox, 'm.yaml')]);
  assert.equal(r.status, 2); assert.match(r.stderr, /distinct versions/);
  const ok = run(['generate', '--from-sandbox', sandbox, '--repo', 'example/project', '--out', join(sandbox, 'm.yaml'), '--allow-mixed-versions']);
  assert.equal(ok.status, 0, ok.stderr);
});

test('the groups digest does not depend on the order files were found in', () => {
  const a = mkdtempSync(join(tmpdir(), 'adrm-a-')), b = mkdtempSync(join(tmpdir(), 'adrm-b-'));
  layout(a, ['org/x/z/1.0.0/z-1.0.0.pom', 'org/x/a/1.0.0/a-1.0.0.jar', 'org/x/a/1.0.0/a-1.0.0.pom']);
  layout(b, ['org/x/a/1.0.0/a-1.0.0.pom', 'org/x/a/1.0.0/a-1.0.0.jar', 'org/x/z/1.0.0/z-1.0.0.pom']);
  const da = run(['generate', '--from-sandbox', a, '--repo', 'e/p', '--out', join(a, 'm.yaml')]).stderr.match(/groups digest (\w+)/)[1];
  const db = run(['generate', '--from-sandbox', b, '--repo', 'e/p', '--out', join(b, 'm.yaml')]).stderr.match(/groups digest (\w+)/)[1];
  assert.equal(da, db);
  assert.equal(readFileSync(join(a, 'm.yaml'), 'utf8').split('groups:')[1], readFileSync(join(b, 'm.yaml'), 'utf8').split('groups:')[1]);
});

test('generate --from-coordinates accepts a coordinate list and yields the same shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adrm-coords-'));
  writeFileSync(join(dir, 'c.json'), JSON.stringify([
    { groupId: 'org.x', artifactId: 'a', version: '1.0.0', extension: 'jar', classifier: null },
    { groupId: 'org.x', artifactId: 'a', version: '1.0.0', extension: 'jar', classifier: 'sources' },
    { groupId: 'org.x', artifactId: 'a', version: '1.0.0', extension: 'pom', classifier: null },
  ]));
  const r = run(['generate', '--from-coordinates', join(dir, 'c.json'), '--repo', 'e/p', '--method', 'test', '--out', join(dir, 'm.yaml')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(dir, 'm.yaml'), 'utf8'), /^    a: \[-sources\.jar, \.jar, \.pom\]$/m);
});
