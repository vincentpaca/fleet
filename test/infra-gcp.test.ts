// The GCP unit's API-only constraints (#185): what neither `terraform
// validate` nor the mocked plan smoke (infra/gcp/tests/plan.tftest.hcl) can
// reject, because GCP enforces it in the API — or because the value is
// schema-valid either way and only wrong for Fleet. Same split as
// test/infra-aws.test.ts, whose header carries the full rationale (#9 paid
// four applies to learn it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { braceBlock } from './infra-helpers.ts';

const GCP = join(dirname(fileURLToPath(import.meta.url)), '..', 'infra', 'gcp');

/** Every `.tf` file in the unit root, concatenated. */
function unitText(): string {
  let text = '';
  for (const name of readdirSync(GCP)) {
    if (!name.endsWith('.tf')) continue;
    if (!statSync(join(GCP, name)).isFile()) continue;
    text += `${readFileSync(join(GCP, name), 'utf8')}\n`;
  }
  return text;
}

// Google's published source range for IAP TCP forwarding — the only CIDR any
// ingress rule in this unit may admit. Everything else is tag-referenced,
// which is this cloud's spelling of AGENTS.md's "SG-referenced ingress".
const IAP_RANGE = '35.235.240.0/20';

const FIREWALL = /^resource\s+"google_compute_firewall"\s+"[A-Za-z0-9_-]+"[^\n]*\{/gm;

/**
 * Every firewall block in one `.tf` text that admits traffic from anywhere
 * beyond the IAP range or a Fleet tag: a CIDR other than IAP's, or a rule
 * with neither source_ranges nor source_tags (which GCP reads as 0.0.0.0/0 —
 * the worst parse). Pure over its input so the self-test can pin it against
 * planted fixtures.
 */
export function unguardedFirewalls(text: string): string[] {
  const offenders: string[] = [];
  for (const match of text.matchAll(FIREWALL)) {
    const body = braceBlock(text, text.indexOf('{', match.index));
    if (/^\s*direction\s*=\s*"EGRESS"/m.test(body)) continue;
    const ranges = /^\s*source_ranges\s*=\s*\[([^\]]*)\]/m.exec(body);
    const tags = /^\s*source_tags\s*=\s*\[([^\]]*)\]/m.exec(body);
    if (ranges !== null && ranges[1].replace(/["\s]/g, '') === IAP_RANGE.replace(/\s/g, '')) continue;
    // A tag source: a literal name, or a reference to one the unit defines.
    if (ranges === null && tags !== null && /local\.|var\.|\$\{|"[a-z]/.test(tags[1])) continue;
    offenders.push(body.replace(/\s+/g, ' ').trim());
  }
  return offenders;
}

test('every ingress firewall rule admits only the IAP range or a Fleet tag', () => {
  const offenders = unguardedFirewalls(unitText());
  assert.deepStrictEqual(
    offenders,
    [],
    `firewall rules reachable from outside IAP or the runner tag:\n${offenders.join('\n')}`,
  );
  // A scan that matched nothing passes every assertion above.
  assert.ok(
    [...unitText().matchAll(FIREWALL)].length >= 2,
    'fewer than the two shipped firewall rules found — the scan is looking in the wrong place',
  );
});

test('the firewall gate rejects public CIDRs, widened IAP ranges, and source-less rules', () => {
  // Untested, the matcher can be widened to nothing and stay green — exercise
  // it against each shape of violation the invariant bans.
  const rule = (body: string): string =>
    `resource "google_compute_firewall" "x" {\n  network = "default"\n${body}\n  allow {\n    protocol = "tcp"\n    ports    = ["9000"]\n  }\n}`;

  for (const rejected of [
    rule('  source_ranges = ["0.0.0.0/0"]'),
    rule('  source_ranges = ["35.235.240.0/19"]'), // one bit wider than IAP's range
    rule('  source_ranges = ["10.0.0.0/8"]'), // intra-VPC by CIDR is still not tag-referenced
    rule(''), // neither field: GCP defaults the source to 0.0.0.0/0
  ]) {
    assert.equal(unguardedFirewalls(rejected).length, 1, `should be rejected: ${JSON.stringify(rejected)}`);
  }

  for (const accepted of [
    rule(`  source_ranges = ["${IAP_RANGE}"]`),
    rule('  source_tags = ["fleet-runner"]'),
    rule('  source_tags = [local.runner_tag]'),
    rule('  direction = "EGRESS"\n  destination_ranges = ["0.0.0.0/0"]'),
  ]) {
    assert.deepEqual(unguardedFirewalls(accepted), [], `should be accepted: ${JSON.stringify(accepted)}`);
  }
});

test('the daemon VM keeps the cloud-platform access scope', () => {
  // API-only in the worst way: with GCE's legacy default scopes, Secret
  // Manager calls fail regardless of IAM, and the boot-time token publish
  // dies with a permission the operator believes they granted. The scope is
  // schema-valid at any value, so the literal is pinned here.
  // Comments stripped: the unit is allowed to say "no access_config" in prose.
  const text = unitText().replace(/^\s*#.*$/gm, '');
  const start = text.indexOf('resource "google_compute_instance" "daemon"');
  assert.notEqual(start, -1, 'the daemon VM resource must exist');
  const body = braceBlock(text, text.indexOf('{', start));
  assert.match(
    body,
    /scopes\s*=\s*\["https:\/\/www\.googleapis\.com\/auth\/cloud-platform"\]/,
    'the daemon VM must carry exactly the cloud-platform scope — legacy default scopes silently block Secret Manager regardless of IAM',
  );

  // No external IP: an access_config block is a public address, and this
  // unit's entire access story is IAP + the runner tag.
  assert.doesNotMatch(body, /access_config/, 'the daemon VM must not define access_config — no external IP, ever');

  // The reserved internal address is what in-flight jobs' FLEET_DAEMON_URL
  // points at; an instance without it strands them all on fleet upgrade.
  assert.match(
    body,
    /network_ip\s*=\s*google_compute_address\.daemon\.address/,
    'the daemon VM must take the reserved google_compute_address — an ephemeral IP breaks every in-flight job on VM replacement',
  );
});

test('the deprecated container-startup path (konlet) never comes back', () => {
  // gce-container-declaration / create-with-container stopped working July
  // 2026; a daemon shipped on it silently never boots. The unit's design is
  // cloud-init + npm, and this pin is what keeps a helpful refactor from
  // reintroducing the dead path. Comments are stripped first — the unit is
  // allowed to explain WHY the path is banned without tripping the ban.
  const text = unitText().replace(/^\s*#.*$/gm, '');
  for (const banned of ['gce-container-declaration', 'konlet', 'create-with-container']) {
    assert.ok(!text.includes(banned), `infra/gcp must not use the deprecated container-startup path (found "${banned}")`);
  }
});

test('the image build config declares no source of its own', () => {
  // API-only in the CLI: `gcloud builds submit` refuses a build config that
  // carries a `source` unless --no-source is passed, and the refusal arrives
  // after the apply, when the wizard tries to start the build. The git source
  // rides the argv (src/cli/setup-units.ts) precisely because of this; a
  // "tidier" config that inlined the repository would break the whole path.
  const text = unitText().replace(/^\s*#.*$/gm, '');
  const start = text.indexOf('resource "local_file" "cloudbuild"');
  assert.notEqual(start, -1, 'the image build config resource must exist');
  const body = braceBlock(text, text.indexOf('{', start));
  assert.doesNotMatch(
    body,
    /(^|\n)\s*source\s*=/,
    'the build config must not declare a source — gcloud rejects that without --no-source, and the git source is passed on the command line',
  );
  // It must still be the runner image build, or the assertion above passes
  // against an empty file.
  assert.match(body, /images\/runner\/Dockerfile/, 'the scan is looking at the wrong resource');
});

test('the image-build custom role id is spelled the way the IAM API accepts', () => {
  // API-only: a custom role_id may hold letters, digits, underscores and dots —
  // never a dash. var.name is dash-friendly ("fleet-demo"), so the unit
  // translates, and both `terraform validate` and the mocked plan accept the
  // untranslated form happily. The apply is where it would fail.
  const text = unitText();
  const start = text.indexOf('resource "google_project_iam_custom_role" "image_build_submit"');
  assert.notEqual(start, -1, 'the operator StartBuild role must exist');
  const body = braceBlock(text, text.indexOf('{', start));
  // The whole line, not a quote-delimited capture: the value interpolates a
  // function call whose own arguments are quoted.
  const roleId = /^\s*role_id\s*=\s*(.+)$/m.exec(body);
  assert.ok(roleId, 'the custom role must set role_id');
  assert.match(
    roleId[1],
    /replace\(var\.name, "-", "_"\)/,
    "role_id must translate var.name's dashes to underscores — the IAM API rejects a dash in a custom role id",
  );
});

test('the runner service account is granted logging only', () => {
  // The permission split is the sandbox: a job able to execute or cancel
  // executions, or read the operator-token secret, defeats it the same way an
  // agent answering its own question would. The daemon's grants name the
  // daemon SA; the runner SA must appear as a member of exactly one role.
  const text = unitText();
  const grants = [...text.matchAll(/member\s*=\s*"serviceAccount:\$\{google_service_account\.runner\.email\}"/g)];
  assert.equal(grants.length, 1, 'the runner service account must hold exactly one grant (logging.logWriter)');
  const at = text.lastIndexOf('role', grants[0].index);
  assert.match(
    text.slice(at, grants[0].index),
    /roles\/logging\.logWriter/,
    "the runner service account's one grant must be logging.logWriter",
  );
});
