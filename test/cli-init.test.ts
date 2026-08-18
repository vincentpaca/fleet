import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateManifest } from '../src/validate.mjs';
import { runCli, makeTempDir } from './cli-helpers.ts';

test('init scaffolds .fleet/ and the manifest passes lint', async () => {
  const cwd = makeTempDir('fleet-cli-init-');
  const res = await runCli(['init'], { cwd });
  assert.equal(res.code, 0, res.stderr);

  const manifestPath = path.join(cwd, '.fleet', 'manifest.json');
  const setupPath = path.join(cwd, '.fleet', 'setup.sh');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json written');
  assert.ok(fs.existsSync(setupPath), 'setup.sh written');
  assert.ok(fs.existsSync(path.join(cwd, '.fleet', 'out', '.gitkeep')), 'out/.gitkeep written');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const { ok, errors } = validateManifest(manifest);
  assert.equal(ok, true, JSON.stringify(errors));

  const setupMode = fs.statSync(setupPath).mode & 0o111;
  assert.notEqual(setupMode, 0, 'setup.sh is executable');
  assert.ok(fs.readFileSync(setupPath, 'utf8').startsWith('#!'), 'setup.sh has a shebang');

  const lint = await runCli(['lint'], { cwd });
  assert.equal(lint.code, 0, lint.stderr);

  const gitignore = fs.readFileSync(path.join(cwd, '.fleet', '.gitignore'), 'utf8');
  assert.match(gitignore, /^out\/$/m, 'job artifacts (decisions, answers, reports) never enter the repo');
  assert.match(gitignore, /^infra\/$/m, 'generated terraform, local state, per-deployment config stay untracked');
});

test('init refuses to overwrite an existing manifest', async () => {
  const cwd = makeTempDir('fleet-cli-init-');
  assert.equal((await runCli(['init'], { cwd })).code, 0);
  const rerun = await runCli(['init'], { cwd });
  assert.equal(rerun.code, 1);
  assert.match(rerun.stderr, /refusing to overwrite/);
  assert.match(rerun.stderr, /manifest\.json/);
});

test('init refuses to overwrite an existing setup.sh without --existing', async () => {
  const cwd = makeTempDir('fleet-cli-init-');
  fs.mkdirSync(path.join(cwd, '.fleet'));
  fs.writeFileSync(path.join(cwd, '.fleet', 'setup.sh'), '#!/bin/sh\necho mine\n');
  const res = await runCli(['init'], { cwd });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /refusing to overwrite/);
  assert.match(res.stderr, /setup\.sh/);
});

test('init --existing keeps an existing setup.sh and prints brownfield guidance', async () => {
  const cwd = makeTempDir('fleet-cli-init-');
  fs.mkdirSync(path.join(cwd, '.fleet'));
  const original = '#!/bin/sh\necho mine\n';
  fs.writeFileSync(path.join(cwd, '.fleet', 'setup.sh'), original);
  const res = await runCli(['init', '--existing'], { cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(fs.readFileSync(path.join(cwd, '.fleet', 'setup.sh'), 'utf8'), original, 'setup.sh untouched');
  assert.match(res.stdout, /new laptop/, 'brownfield guidance printed');
  assert.ok(fs.existsSync(path.join(cwd, '.fleet', 'manifest.json')), 'manifest still scaffolded');
});

test('init --existing still refuses to overwrite an existing manifest', async () => {
  const cwd = makeTempDir('fleet-cli-init-');
  assert.equal((await runCli(['init'], { cwd })).code, 0);
  const rerun = await runCli(['init', '--existing'], { cwd });
  assert.equal(rerun.code, 1);
  assert.match(rerun.stderr, /refusing to overwrite/);
});

test('init scaffolds .env.example and covers .env in .gitignore', async () => {
  const cwd = makeTempDir('fleet-cli-init-dotenv-');
  const res = await runCli(['init'], { cwd });
  assert.equal(res.code, 0, res.stderr);

  const examplePath = path.join(cwd, '.fleet', '.env.example');
  assert.ok(fs.existsSync(examplePath), '.env.example written');
  const exampleContent = fs.readFileSync(examplePath, 'utf8');
  assert.ok(exampleContent.includes('EXAMPLE_VAR'), '.env.example has placeholder key');

  const gitignore = fs.readFileSync(path.join(cwd, '.fleet', '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.env$/m, '.fleet/.gitignore covers .env');
});

test('init: .env appended to an existing .fleet/.gitignore that lacks it', async () => {
  // Simulate an older init that wrote out/ and infra/ but not .env.
  const cwd = makeTempDir('fleet-cli-init-dotenv3-');
  fs.mkdirSync(path.join(cwd, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.fleet', '.gitignore'), 'out/\ninfra/\n');
  const res = await runCli(['init'], { cwd });
  assert.equal(res.code, 0, res.stderr);
  const gitignore = fs.readFileSync(path.join(cwd, '.fleet', '.gitignore'), 'utf8');
  assert.match(gitignore, /^out\/$/m, 'existing out/ entry preserved');
  assert.match(gitignore, /^infra\/$/m, 'existing infra/ entry preserved');
  assert.match(gitignore, /^\.env$/m, '.env appended without replacing existing content');
  // No double-blank between entries.
  assert.doesNotMatch(gitignore, /\n\n\n/, 'no triple newline (no spurious blank lines)');
});

test('init: .env not appended when /.env already present in .gitignore', async () => {
  const cwd = makeTempDir('fleet-cli-init-dotenv4-');
  fs.mkdirSync(path.join(cwd, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.fleet', '.gitignore'), 'out/\ninfra/\n/.env\n');
  const res = await runCli(['init'], { cwd });
  assert.equal(res.code, 0, res.stderr);
  const gitignore = fs.readFileSync(path.join(cwd, '.fleet', '.gitignore'), 'utf8');
  // The root-anchored form already covers .env — don't add a bare .env too.
  assert.equal(gitignore, 'out/\ninfra/\n/.env\n', 'gitignore unchanged when /.env already present');
});

test('init: .env.example not clobbered on reinit (manifest check fires first)', async () => {
  // fleet init already refuses on an existing manifest.json, so .env.example is safe.
  // But if someone pre-creates .env.example before any init, it must survive.
  const cwd = makeTempDir('fleet-cli-init-dotenv2-');
  fs.mkdirSync(path.join(cwd, '.fleet'), { recursive: true });
  const customExample = '# custom example\nMY_KEY=placeholder\n';
  fs.writeFileSync(path.join(cwd, '.fleet', '.env.example'), customExample);
  const res = await runCli(['init'], { cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(
    fs.readFileSync(path.join(cwd, '.fleet', '.env.example'), 'utf8'),
    customExample,
    'pre-existing .env.example untouched',
  );
});
