// Clouds are self-contained units: cloud-specific code lives in its unit
// (src/providers/<name>.ts + infra/<cloud>/), and core never imports it.
// The one exception is the composition root, src/daemon/main.ts, which maps
// FLEET_PROVIDER to an implementation. Everything else depends only on the
// Provider interface (src/providers/provider.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const COMPOSITION_ROOT = join('daemon', 'main.ts');

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
    if (rel.startsWith('providers/') || rel === COMPOSITION_ROOT) continue;
    const text = readFileSync(file, 'utf8');
    // provider.ts (the interface) is fine; concrete impls are not.
    const match = text.match(/from\s+["'][^"']*providers\/(?!provider\.ts)[^"']+["']/);
    if (match) offenders.push(`${rel}: ${match[0]}`);
  }
  assert.deepStrictEqual(offenders, [], `core imports concrete providers:\n${offenders.join('\n')}`);
});

test('each infra unit is self-contained (module + README + example)', () => {
  const infra = join(src, '..', 'infra');
  for (const unit of readdirSync(infra)) {
    if (statSync(join(infra, unit)).isDirectory()) {
      for (const required of ['README.md', 'main.tf', 'variables.tf', 'outputs.tf', join('examples', 'basic', 'main.tf')]) {
        assert.ok(
          statSync(join(infra, unit, required), { throwIfNoEntry: false }),
          `infra/${unit} is missing ${required} — every cloud unit ships complete`,
        );
      }
    }
  }
});

test('each infra unit self-describes its shape via fleet_config', () => {
  // The output is the contract between an infra unit and its runtime
  // provider: Fleet predicts the infrastructure it created, never discovers it.
  // Add new required keys here when the EcsConfig (or equivalent) gains a field
  // that the provider cannot derive from any other source — or when operator
  // tooling has to address the unit's own infrastructure: images/build.sh
  // publishes to runner_repository_url and rolls cluster + daemon_service.
  // Trailing space on daemon_service: the separate daemon_service_name output
  // must not satisfy the fleet_config requirement.
  const infra = join(src, '..', 'infra');
  for (const unit of readdirSync(infra)) {
    if (!statSync(join(infra, unit)).isDirectory()) continue;
    const outputs = readFileSync(join(infra, unit, 'outputs.tf'), 'utf8');
    for (const required of [
      'output "fleet_config"',
      'output "connect_hint"',
      'provider ',
      'runner_task_definition',
      'runner_repository_url',
      'daemon_service ',
    ]) {
      assert.ok(outputs.includes(required), `infra/${unit}/outputs.tf missing ${required}`);
    }
  }
});
