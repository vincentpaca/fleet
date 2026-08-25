// Clouds are self-contained units: cloud-specific code lives in its unit
// (src/providers/<name>.ts + infra/<cloud>/), and core never imports it.
// The exceptions are the two composition roots — src/daemon/main.ts maps
// FLEET_PROVIDER to a launch implementation, src/cli/tunnel-openers.ts maps a
// captured deployment's `provider` to a tunnel implementation. Everything else
// depends only on the Provider interface (src/providers/provider.ts). Adding a
// root here is a real widening: keep the list to files whose entire job is the
// map, so a cloud detail can never accumulate beside general code under the
// exemption.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { braceBlock } from './infra-helpers.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const COMPOSITION_ROOTS = [join('daemon', 'main.ts'), join('cli', 'tunnel-openers.ts')];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (p.endsWith('.ts') || p.endsWith('.mjs')) yield p;
  }
}

test('core never imports a concrete cloud provider', () => {
  const offenders: string[] = [];
  for (const file of files(src)) {
    const rel = file.slice(src.length + 1);
    if (rel.startsWith('providers/') || COMPOSITION_ROOTS.includes(rel)) continue;
    const text = readFileSync(file, 'utf8');
    // provider.ts (the interface) is fine; concrete impls are not.
    const match = text.match(/from\s+["'][^"']*providers\/(?!provider\.ts)[^"']+["']/);
    if (match) offenders.push(`${rel}: ${match[0]}`);
  }
  assert.deepStrictEqual(offenders, [], `core imports concrete providers:\n${offenders.join('\n')}`);
});

test('each infra unit is self-contained (module + README + example + plan smoke)', () => {
  const infra = join(src, '..', 'infra');
  for (const unit of readdirSync(infra)) {
    if (statSync(join(infra, unit)).isDirectory()) {
      for (const required of ['README.md', 'main.tf', 'variables.tf', 'outputs.tf', join('examples', 'basic', 'main.tf')]) {
        assert.ok(
          statSync(join(infra, unit, required), { throwIfNoEntry: false }),
          `infra/${unit} is missing ${required} — every cloud unit ships complete`,
        );
      }

      // A unit also ships the check that would have caught #9's three
      // bring-up failures: a `terraform test` plan against mocked providers,
      // which sees the provider-schema rejections validate cannot (#48).
      // `terraform test` on a unit with no test files exits 0 — a deleted
      // smoke reads as a passing run, so require the file here instead.
      const testsDir = join(infra, unit, 'tests');
      const tests = statSync(testsDir, { throwIfNoEntry: false })
        ? readdirSync(testsDir).filter((name) => name.endsWith('.tftest.hcl'))
        : [];
      assert.ok(
        tests.length > 0,
        `infra/${unit}/tests holds no .tftest.hcl — every cloud unit ships a plan-level smoke, or its provider rejects values nothing checked`,
      );
    }
  }
});

test('each infra unit self-describes its shape via fleet_config', () => {
  // fleet_config is the contract between an infra unit and its runtime
  // provider: Fleet predicts the infrastructure it created, never discovers it.
  // Add new required keys here when the EcsConfig (or equivalent) gains a field
  // that the provider cannot derive from any other source — or when operator
  // tooling has to address the unit's own infrastructure: images/build.sh
  // publishes to runner_repository_url and rolls cluster + daemon_service, and
  // `fleet connect` forwards to daemon_container_name on daemon_port (#57).
  //
  // The map must be written EXACTLY ONCE, as a `fleet_config = { ... }` local,
  // and referenced everywhere it is published. A unit publishes it in more than
  // one place — the output operators capture, and (for AWS) the parameter the
  // daemon reads at boot — and Terraform cannot reference an output, so the
  // second copy is always hand-kept. It drifted exactly that way before #57:
  // the SSM parameter never learned daemon_service, and nothing noticed because
  // the copy an operator reads is not the copy the daemon reads.
  const infra = join(src, '..', 'infra');
  for (const unit of readdirSync(infra)) {
    const unitDir = join(infra, unit);
    if (!statSync(unitDir).isDirectory()) continue;
    const outputs = readFileSync(join(unitDir, 'outputs.tf'), 'utf8');
    for (const required of ['output "fleet_config"', 'output "connect_hint"']) {
      assert.ok(outputs.includes(required), `infra/${unit}/outputs.tf missing ${required}`);
    }

    // The example root has to re-export it. Module outputs are not addressable
    // from a root module, so `terraform -chdir=<unit>/examples/basic output
    // -json fleet_config` — the first command of every bring-up, and what the
    // CLI, images/build.sh, and `fleet connect` all read afterwards — fails
    // outright without this passthrough.
    const example = readFileSync(join(unitDir, 'examples', 'basic', 'main.tf'), 'utf8');
    assert.match(
      example,
      /output "fleet_config"/,
      `infra/${unit}/examples/basic/main.tf must re-export fleet_config — the documented capture command reads it from the example root`,
    );

    const blocks: string[] = [];
    let unitText = '';
    for (const name of readdirSync(unitDir)) {
      if (!name.endsWith('.tf')) continue;
      const text = readFileSync(join(unitDir, name), 'utf8');
      unitText += `${text}\n`;
      for (const match of text.matchAll(/^[ \t]*fleet_config\s*=\s*\{/gm)) {
        blocks.push(braceBlock(text, text.indexOf('{', match.index)));
      }
    }
    assert.equal(
      blocks.length,
      1,
      `infra/${unit}: fleet_config must be written once as a local and referenced wherever it is published (found ${blocks.length} definitions)`,
    );
    // Counting definitions only catches a copy that is also *named* fleet_config.
    // A second copy inlined into a jsonencode() would slip past it, so count a
    // key the map alone carries: one assignment across the whole unit, or
    // somebody is writing the description twice again.
    assert.equal(
      [...unitText.matchAll(/^\s*daemon_port\s*=/gm)].length,
      1,
      `infra/${unit}: daemon_port is assigned more than once — reference local.fleet_config where it is published instead of re-listing its keys (a hoisting local counts as an assignment too)`,
    );

    // Keys are required INSIDE that block, as assignments. A whole-file
    // substring scan cannot fail: a prose comment mentioning the key, or a
    // same-named standalone output (daemon_service_name, runner_repository_url
    // both exist), satisfies it while the map itself has been trimmed — and
    // trimming it silently breaks every consumer.
    for (const key of [
      'provider',
      // region (#138): every aws call the CLI and daemon make appends
      // --region from fleet_config; a unit that stops publishing it sends
      // every consumer back to the caller's ambient region.
      'region',
      'cluster',
      'runner_task_definition',
      'runner_container_name',
      'runner_repository_url',
      'daemon_service',
      'daemon_container_name',
      'daemon_port',
    ]) {
      assert.match(
        blocks[0],
        new RegExp(`^\\s*${key}\\s*=`, 'm'),
        `infra/${unit}: fleet_config must set ${key}`,
      );
    }
  }
});

/** Source with comments removed — what the code actually says, not what it explains. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('the setup wizard engine names no cloud — the unit map does', () => {
  // `fleet setup infra` is split for the same reason the providers are: the
  // engine interviews, generates a root module, drives terraform and captures
  // the deployment description, and every cloud-specific word — which questions,
  // which credentials to prove, which terraform arguments — lives in the unit
  // map. Without a gate that split lasts exactly until the first `if (provider
  // === 'aws')`, and the second cloud arrives as a branch instead of an entry.
  const engine = codeOnly(readFileSync(join(src, 'cli', 'setup.ts'), 'utf8'));
  const cloudWords = engine.match(/\b(aws|ecs|ecr|efs|vpc|subnet|azure|gcp|fargate|ssm)\b/gi) ?? [];
  assert.deepStrictEqual(
    [...new Set(cloudWords.map((w) => w.toLowerCase()))],
    [],
    'src/cli/setup.ts must stay cloud-agnostic — put it in src/cli/setup-units.ts',
  );
});
