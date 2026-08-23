// Gates for two rules that lived only in prose (#136). Both are static and
// always-on: no env flag, no opt-in.
//
// 1. "Secrets NEVER enter this image" was enforced by a docker-history scan
//    behind FLEET_TEST_DOCKER=1, which nothing sets — so CI never ran it.
//    This parses the Dockerfiles directly for secret-shaped ARG/ENV names.
//    The history scan stays as the deeper opt-in layer (it catches what a
//    build actually baked in); this catches the declaration that would bake.
// 2. Helpers under test/ must be export-only. `node --test` collects every
//    file under test/, so a helper that imports node:test or registers tests
//    runs its body during collection of every suite (the bug behind
//    test/translate-helpers.ts). Nothing detected a recurrence — now this does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const IMAGES = join(TEST_DIR, '..', 'images');

// ---------- gate 1: no secret-shaped ARG/ENV in any shipped Dockerfile ----------

/**
 * ARG/ENV declaration names whose identifier looks like it would carry a
 * credential. Matches the same class AGENTS.md's secrets rule names: API keys,
 * tokens, passwords, secrets — case-insensitive, anywhere in the name, so
 * GITHUB_TOKEN and DB_PASSWORD both land. Pure over its input so the
 * self-test can pin it against planted fixtures.
 */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;

export function secretArgEnvNames(dockerfile: string): string[] {
  const names: string[] = [];
  for (const line of dockerfile.matchAll(/^\s*(ARG|ENV)\s+(.+)$/gm)) {
    const rest = line[2];
    // Modern form: space-separated NAME=VALUE pairs (`ENV A=1 B=2`).
    // Legacy form: bare `ARG NAME` / `ENV NAME value` — take the first token.
    if (rest.includes('=')) {
      for (const pair of rest.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
        names.push(pair[1]);
      }
    } else {
      const bare = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
      if (bare) names.push(bare[1]);
    }
  }
  return names.filter((name) => SECRET_NAME.test(name));
}

/** Every Dockerfile shipped under images/, as [relative path, text]. */
function shippedDockerfiles(): Array<{ path: string; text: string }> {
  const files: Array<{ path: string; text: string }> = [];
  for (const entry of readdirSync(IMAGES)) {
    const dir = join(IMAGES, entry);
    if (!statSync(dir).isDirectory()) continue;
    const dockerfile = join(dir, 'Dockerfile');
    try {
      files.push({ path: `images/${entry}/Dockerfile`, text: readFileSync(dockerfile, 'utf8') });
    } catch {
      throw new Error(`images/${entry}/ exists but has no Dockerfile — extend this scan if that is deliberate`);
    }
  }
  return files;
}

test('shipped Dockerfiles declare no secret-shaped ARG or ENV', () => {
  const offenders: string[] = [];
  let checked = 0;

  for (const { path, text } of shippedDockerfiles()) {
    checked += 1;
    for (const name of secretArgEnvNames(text)) {
      offenders.push(`${path}: ${name}`);
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    'secret-shaped ARG/ENV declarations — credentials arrive at container start via -e/task roles only:\n' +
      offenders.join('\n'),
  );
  // A scan that read neither file passes vacuously; both ship benign ARG/ENVs.
  assert.ok(checked >= 2, `only ${checked} Dockerfiles scanned — images/ moved?`);
});

test('the secret-name pin rejects planted violations', () => {
  // The matcher is the whole check; exercise it against each banned shape.
  const dockerfile = (directives: string[]): string => ['FROM node:24-slim', ...directives].join('\n');

  for (const rejected of [
    dockerfile(['ARG API_KEY']), // legacy bare ARG
    dockerfile(['ENV DB_PASSWORD=hunter2']),
    dockerfile(['ENV FLEET_PORT=9000 GITHUB_TOKEN=ghp_x']), // second pair of an ENV line
    dockerfile(['ARG service_secret=abc']), // match anywhere in the name, any case
  ]) {
    assert.deepEqual(secretArgEnvNames(rejected).length >= 1, true, `should be rejected: ${rejected}`);
  }

  for (const accepted of [
    dockerfile(['ARG HARNESS_CLI=claude-code', 'ARG HARNESS_VERSION=latest', 'ENV FLEET_PORT=9000']),
    dockerfile(['# mentions TOKENS in a comment only']),
  ]) {
    assert.deepEqual(secretArgEnvNames(accepted), [], `should be accepted: ${accepted}`);
  }
});

// ---------- gate 2: helpers under test/ are export-only ----------

/**
 * Why one non-.test source violates the export-only rule. An import of
 * node:test means the file participates in test registration; a bare
 * `test(` or `describe(` call means it registers one. Method calls like
 * `t.test(` are left alone — they only exist inside running suites.
 */
export function helperViolations(source: string): string[] {
  const violations: string[] = [];
  if (/from\s+['"]node:test['"]|^import\s+['"]node:test['"]/.test(source)) {
    violations.push("imports 'node:test'");
  }
  if (/(?<![\w$.])(?:test|describe)\s*\(/.test(source)) {
    violations.push('registers tests at import time');
  }
  return violations;
}

/**
 * Findings for every helper file in `dir` — files that are not `*.test.*`.
 * `.test.` files are where node:test registration belongs; everything else
 * must stay inert at import time.
 */
export function exportOnlyHelperGate(dir: string): Array<{ file: string; why: string }> {
  const findings: Array<{ file: string; why: string }> = [];
  for (const entry of readdirSync(dir)) {
    if (!/\.(ts|mjs)$/.test(entry) || /\.test\.(ts|mjs)$/.test(entry)) continue;
    if (!statSync(join(dir, entry)).isFile()) continue;
    for (const why of helperViolations(readFileSync(join(dir, entry), 'utf8'))) {
      findings.push({ file: entry, why });
    }
  }
  return findings;
}

test('every non-test helper under test/ is export-only', () => {
  const findings = exportOnlyHelperGate(TEST_DIR);
  assert.deepStrictEqual(
    findings,
    [],
    `helpers that import node:test or register tests — move them to fixtures/ or make them *.test.*:\n` +
      findings.map((f) => `${f.file}: ${f.why}`).join('\n'),
  );
});

test('the export-only gate rejects a planted registering helper', () => {
  // Prove the gate checks rather than passes: plant a synthetic tree with a
  // violating helper, a clean helper, and a .test.ts that imports node:test
  // (which must be exempt), then run the real directory scan over it.
  const dir = mkdtempSync(join(tmpdir(), 'helper-hygiene-'));
  try {
    writeFileSync(
      join(dir, 'bad-helpers.ts'),
      ["import { test } from 'node:test';", '', "test('runs at collection time', () => {});", ''].join('\n'),
    );
    writeFileSync(join(dir, 'good-helpers.ts'), ['export const answer = 42;', ''].join('\n'));
    writeFileSync(join(dir, 'suite.test.ts'), ["import { test } from 'node:test';", "test('real', () => {});"].join('\n'));

    assert.deepStrictEqual(exportOnlyHelperGate(dir), [
      { file: 'bad-helpers.ts', why: "imports 'node:test'" },
      { file: 'bad-helpers.ts', why: 'registers tests at import time' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
