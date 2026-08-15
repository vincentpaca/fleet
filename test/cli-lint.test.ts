import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, makeTempDir } from './cli-helpers.ts';

const VALID_MANIFEST = {
  version: 1,
  setup: { image: 'node:22', script: '.fleet/setup.sh' },
  workspace: { repo: 'git@github.com:acme/example-app.git', strategy: 'branch-per-job' },
  harness: { cli: 'claude-code', commands: [{ path: '.claude/commands/dev-sprint.md', critic: 'code-reviewer' }] },
  gates: { pickup: 'node .fleet/check-ready.js' },
};

function writeManifest(cwd: string, manifest: unknown): void {
  fs.mkdirSync(path.join(cwd, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.fleet', 'manifest.json'), JSON.stringify(manifest, null, 2));
}

test('lint fails a broken manifest with one readable finding per line', async () => {
  const cwd = makeTempDir('fleet-cli-lint-');
  writeManifest(cwd, {
    version: 2, // must be const 1
    setup: { image: 'node:22', dockerfile: 'Dockerfile' }, // violates oneOf
    workspace: { repo: 'git@github.com:acme/example-app.git', strategy: 'branch-per-job' },
    harness: { cli: 'claude-code', commands: [{ path: 'x.md', critic: 'code-reviewer' }] },
    // gates missing entirely
  });
  const res = await runCli(['lint'], { cwd });
  assert.equal(res.code, 1);
  const lines = res.stderr.trim().split('\n');
  assert.ok(lines.length >= 2, `expected multiple findings, got: ${res.stderr}`);
  for (const line of lines) {
    assert.match(line, /^.+: \S+ .+$/, `finding line has file, pointer, message: ${line}`);
  }
  assert.match(res.stderr, /\/version/, 'names the /version pointer');
  assert.match(res.stderr, /gates/, 'mentions the missing gates property');
});

test('lint passes a valid manifest and reports the file count', async () => {
  const cwd = makeTempDir('fleet-cli-lint-');
  writeManifest(cwd, VALID_MANIFEST);
  const res = await runCli(['lint'], { cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /lint ok: 1 file/);
});

test('lint validates .fleet/orders/*.json as work orders', async () => {
  const cwd = makeTempDir('fleet-cli-lint-');
  writeManifest(cwd, VALID_MANIFEST);
  const ordersDir = path.join(cwd, '.fleet', 'orders');
  fs.mkdirSync(ordersDir);
  fs.writeFileSync(
    path.join(ordersDir, 'good.json'),
    JSON.stringify({ mode: 'implement', target: 'APP-123', finish: 'merge-ready' }),
  );
  fs.writeFileSync(
    path.join(ordersDir, 'bad.json'),
    JSON.stringify({ mode: 'conquer', target: '', finish: 'merged' }),
  );
  const res = await runCli(['lint'], { cwd });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /bad\.json/, 'names the offending order file');
  assert.match(res.stderr, /\/mode/, 'points at the bad mode');
  assert.doesNotMatch(res.stderr, /good\.json/, 'valid order produces no finding');
});

test('lint accepts an explicit manifest path', async () => {
  const cwd = makeTempDir('fleet-cli-lint-');
  fs.writeFileSync(path.join(cwd, 'other-manifest.json'), JSON.stringify(VALID_MANIFEST));
  const res = await runCli(['lint', 'other-manifest.json'], { cwd });
  assert.equal(res.code, 0, res.stderr);
});

test('lint fails readably on a missing or unparsable manifest', async () => {
  const cwd = makeTempDir('fleet-cli-lint-');
  const missing = await runCli(['lint'], { cwd });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /manifest not found/);

  fs.mkdirSync(path.join(cwd, '.fleet'));
  fs.writeFileSync(path.join(cwd, '.fleet', 'manifest.json'), '{not json');
  const unparsable = await runCli(['lint'], { cwd });
  assert.equal(unparsable.code, 1);
  assert.match(unparsable.stderr, /not valid JSON/);
});
