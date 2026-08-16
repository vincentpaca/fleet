import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli-helpers.ts';

const PKG_PATH = fileURLToPath(new URL('../package.json', import.meta.url));
const EXPECTED_VERSION = (JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')) as { version: string }).version;

test('fleet --version prints the package version and exits 0', async () => {
  const res = await runCli(['--version']);
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\n${res.stderr}`);
  assert.equal(res.stdout.trim(), EXPECTED_VERSION, 'stdout must be exactly the package.json version');
});

test('fleet version prints the package version and exits 0', async () => {
  const res = await runCli(['version']);
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\n${res.stderr}`);
  assert.equal(res.stdout.trim(), EXPECTED_VERSION, 'stdout must be exactly the package.json version');
});

test('fleet --version and fleet version print identical output', async () => {
  const flag = await runCli(['--version']);
  const cmd = await runCli(['version']);
  assert.equal(flag.stdout, cmd.stdout, '--version and version must produce identical output');
});

test('fleet help mentions --version flag and version command', async () => {
  const res = await runCli(['help']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /--version/, 'help text must mention --version flag');
  assert.match(res.stdout, /^\s+version\b/m, 'help text must list version as a command');
});
