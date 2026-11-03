import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../src/publication-manifest.mjs', import.meta.url).pathname;

test('generate creates the .readiness directory on the first run and reports the manifest as changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adrm-gen-'));
  const coordinates = join(dir, 'coordinates.json');
  writeFileSync(coordinates, JSON.stringify([{ groupId: 'io.x', artifactId: 'a', version: '1.0.0-4.4.0-0', extension: 'pom' }]));
  const out = join(dir, 'project', '.readiness', 'publication.yaml');
  const r = spawnSync('node', [script, 'generate', '--from-coordinates', coordinates, '--repo', 'example/project', '--out', out, '--exit-code-on-change'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 3, r.stderr);
  assert.ok(existsSync(out));
  assert.match(readFileSync(out, 'utf8'), /io\.x:\n    a: \[\.pom\]/);
  const again = spawnSync('node', [script, 'generate', '--from-coordinates', coordinates, '--repo', 'example/project', '--out', out, '--exit-code-on-change'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(again.status, 0, again.stderr);
});
