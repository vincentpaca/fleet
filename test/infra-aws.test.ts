// The AWS unit's API-only constraints: what neither `terraform validate` nor
// `terraform plan` can reject, because AWS enforces it in the API rather than
// in the provider schema.
//
// #9's bring-up burned an apply on a security-group rule whose description
// contained a unicode arrow. Nothing local objected — fmt was clean, validate
// was happy, the plan was fine — and AuthorizeSecurityGroupIngress rejected it
// against a character class the provider does not model. A rule like that has
// exactly one place left to live: a pin on the literal Fleet ships.
//
// The other half of the pair is infra/aws/tests/plan.tftest.hcl, the plan-level
// smoke that catches provider-schema mismatches (a string where a bool is
// wanted) without an apply. Constraints go in whichever half can see them:
// schema-shaped in the plan smoke, API-shaped here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { braceBlock } from './infra-helpers.ts';

const INFRA = join(dirname(fileURLToPath(import.meta.url)), '..', 'infra');

/**
 * AWS's allowed characters for a security-group description — the group's own
 * and each rule's alike: letters, digits, spaces, and `._-:/()#,@[]+=&;{}!$*`,
 * up to 255 of them (EC2 API reference, CreateSecurityGroup GroupDescription
 * and IpRange Description; both document the same class). Anything else — a
 * unicode arrow, an angle bracket, an em dash — is rejected at the API, after
 * terraform has already started creating resources.
 */
const AWS_SG_DESCRIPTION = /^[a-zA-Z0-9 ._\-:/()#,@[\]+=&;{}!$*]{0,255}$/;

/**
 * Resource types whose `description` reaches that API field. The standalone
 * rule resources are in here because the AWS provider documents them as the
 * preferred way to express a rule: a description added through one of those
 * must be pinned by the same class as an inline `ingress` block's.
 */
const SG_RESOURCE = /^resource\s+"(aws_security_group|aws_security_group_rule|aws_vpc_security_group_(in|e)gress_rule)"[^\n]*\{/gm;

/** Bodies of the security-group resources declared in one `.tf` file. */
function securityGroupBlocks(text: string): Array<{ type: string; body: string }> {
  return [...text.matchAll(SG_RESOURCE)].map((match) => ({
    type: match[1],
    body: braceBlock(text, text.indexOf('{', match.index)),
  }));
}

/** Every `description = "…"` literal in a block, interpolations stood down. */
function descriptions(body: string): string[] {
  return [...body.matchAll(/^\s*description\s*=\s*"([^"]*)"/gm)].map((m) =>
    // `${var.name}` and friends resolve to values Fleet already constrains —
    // the deployment name is validated to lower-case letters, digits and dashes
    // at the prompt (src/cli/setup-units.ts) — so the interpolation itself is
    // not what this pin is about. Stand it down and check the literal text
    // around it, which is where a typed-in arrow lands.
    m[1].replace(/\$\{[^}]*\}/g, 'INTERPOLATED'),
  );
}

/**
 * Every `ingress {` block in one `.tf` text whose rule admits traffic without
 * naming a Fleet-created security group as its source. The enforced invariant
 * (AGENTS.md) is not "no ingress" — it is "no inbound from outside the VPC":
 * an intra-VPC rule lists `security_groups = [aws_security_group.<name>.id]`,
 * while a `cidr_blocks` rule is reachable from anywhere its route table says,
 * and a rule with neither field parses as worse. Pure over its input so the
 * self-test can pin it against planted fixtures.
 */
const INGRESS_BLOCK = /^\s*ingress\s*\{/gm;
const SG_REF = /aws_security_group\.[A-Za-z0-9_]+\.id/;

export function unguardedIngresses(text: string): string[] {
  const offenders: string[] = [];
  for (const match of text.matchAll(INGRESS_BLOCK)) {
    const body = braceBlock(text, text.indexOf('{', match.index));
    const sources = /^\s*security_groups\s*=\s*\[([^\]]*)\]/m.exec(body);
    if (!sources || !SG_REF.test(sources[1])) {
      offenders.push(body.replace(/\s+/g, ' ').trim());
    }
  }
  return offenders;
}

/**
 * IMDS pin (#157). A worker instance's IMDS hands out *instance-role*
 * credentials, which are broader than any job's task role — and a job is
 * untrusted code. `http_tokens = "required"` shuts off IMDSv1, and a PUT
 * response hop limit of 1 keeps the v2 token from crossing the bridge into a
 * job's container. Neither validate nor the plan smoke can hold this line:
 * 2 is a perfectly schema-valid hop limit, it just re-opens the escalation
 * Fleet's permission split exists to prevent. Nothing job-side reads IMDS
 * (task credentials come from the ECS credential endpoint at 169.254.170.2),
 * so any launch template loosening either field is a bug, not a need.
 */
const LAUNCH_TEMPLATE = /^resource\s+"aws_launch_template"\s+"[A-Za-z0-9_-]+"[^\n]*\{/gm;

export function imdsOffenders(text: string): string[] {
  const offenders: string[] = [];
  for (const match of text.matchAll(LAUNCH_TEMPLATE)) {
    const body = braceBlock(text, text.indexOf('{', match.index));
    const options = /^\s*metadata_options\s*\{/m.exec(body);
    if (!options) {
      offenders.push('launch template with no metadata_options block (IMDSv1 stays enabled by default)');
      continue;
    }
    const optionsBody = braceBlock(body, body.indexOf('{', options.index));
    if (!/^\s*http_tokens\s*=\s*"required"\s*(#.*)?$/m.test(optionsBody)) {
      offenders.push('metadata_options without http_tokens = "required" (IMDSv1 answers without a token)');
    }
    if (!/^\s*http_put_response_hop_limit\s*=\s*1\s*(#.*)?$/m.test(optionsBody)) {
      offenders.push('metadata_options without http_put_response_hop_limit = 1 (a container can reach IMDS and assume the instance role)');
    }
  }
  return offenders;
}

test('every launch template requires IMDSv2 and keeps the hop limit at 1', () => {
  const offenders: string[] = [];
  let checked = 0;

  for (const unit of readdirSync(INFRA)) {
    const unitDir = join(INFRA, unit);
    if (!statSync(unitDir).isDirectory()) continue;

    for (const name of readdirSync(unitDir)) {
      if (!name.endsWith('.tf')) continue;
      const text = readFileSync(join(unitDir, name), 'utf8');
      checked += [...text.matchAll(LAUNCH_TEMPLATE)].length;
      for (const offence of imdsOffenders(text)) {
        offenders.push(`infra/${unit}/${name}: ${offence}`);
      }
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    `launch templates that leave IMDS reachable from a job's container:\n${offenders.join('\n')}`,
  );
  // The unit ships one launch template; a scan that saw none saw nothing.
  assert.ok(checked >= 1, 'no launch templates found at all — the scan is looking in the wrong place');
});

test('the IMDS pin rejects a raised hop limit, optional tokens, and a missing block', () => {
  // Same discipline as the other gates: untested, the matcher can be widened
  // to nothing and stay green. Exercise it against each way the escalation
  // comes back.
  const template = (body: string): string =>
    `resource "aws_launch_template" "workers" {\n${body}\n}`;
  const options = (lines: string): string =>
    template(`  metadata_options {\n${lines}\n  }`);

  for (const rejected of [
    options('    http_tokens                 = "required"\n    http_put_response_hop_limit = 2'), // what shipped before #157
    options('    http_tokens                 = "required"\n    http_put_response_hop_limit = 16'),
    options('    http_tokens                 = "optional"\n    http_put_response_hop_limit = 1'),
    options('    http_put_response_hop_limit = 1'), // tokens unset: IMDSv1 default
    template('  instance_type = "t3.medium"'), // no metadata_options at all
  ]) {
    assert.equal(imdsOffenders(rejected).length >= 1, true, `should be rejected: ${JSON.stringify(rejected)}`);
  }

  for (const accepted of [
    options('    http_tokens                 = "required"\n    http_put_response_hop_limit = 1'),
    options('    http_put_response_hop_limit = 1 # one hop: the instance, never a container\n    http_tokens                 = "required"'),
  ]) {
    assert.deepEqual(imdsOffenders(accepted), [], `should be accepted: ${JSON.stringify(accepted)}`);
  }
});

test('every security-group description is a string the AWS API accepts', () => {
  const offenders: string[] = [];
  let checked = 0;

  for (const unit of readdirSync(INFRA)) {
    const unitDir = join(INFRA, unit);
    if (!statSync(unitDir).isDirectory()) continue;

    for (const name of readdirSync(unitDir)) {
      if (!name.endsWith('.tf')) continue;
      const text = readFileSync(join(unitDir, name), 'utf8');

      for (const { type, body } of securityGroupBlocks(text)) {
        const found = descriptions(body);
        // A security group's own description is required by the API, so a
        // block with none means the scan read the wrong bytes rather than that
        // the unit omitted one. Rule resources may legitimately carry none.
        if (type === 'aws_security_group') {
          assert.ok(found.length > 0, `infra/${unit}/${name}: an aws_security_group block with no description parsed`);
        }
        for (const description of found) {
          checked += 1;
          if (!AWS_SG_DESCRIPTION.test(description)) {
            offenders.push(`infra/${unit}/${name}: ${JSON.stringify(description)}`);
          }
        }
      }
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    `security-group descriptions AWS will reject (allowed: letters, digits, spaces, ._-:/()#,@[]+=&;{}!$*):\n${offenders.join('\n')}`,
  );
  // A scan that matched nothing passes every assertion above.
  assert.ok(checked > 0, 'no security-group descriptions found at all — the scan is looking in the wrong place');
});

test('the description pin rejects what AWS rejected', () => {
  // The regex is the whole check. Untested, it can be loosened to nothing —
  // drop the anchors, widen the class — and stay green forever, so exercise it
  // against the strings that actually failed a bring-up (#9) and the limit the
  // API documents.
  for (const rejected of [
    'Runner tasks → daemon HTTP (private VPC only)', // the unicode arrow that died at apply
    'Runner tasks to daemon HTTP <private VPC only>', // angle brackets, banned by the same class
    'NFS from instances — and the daemon task', // em dash: the arrow's quieter cousin
    'x'.repeat(256), // one over the documented 255
    'tab\tseparated', // a space is allowed; other whitespace is not
  ]) {
    assert.equal(AWS_SG_DESCRIPTION.test(rejected), false, `should be rejected: ${JSON.stringify(rejected)}`);
  }

  for (const accepted of [
    'Runner tasks to daemon HTTP (private VPC only)',
    'All outbound (ECR, CloudWatch, SSM, EFS, daemon)',
    'NFS from Fleet container instances and daemon task',
    'punctuation the API allows: ._-:/()#,@[]+=&;{}!$*',
  ]) {
    assert.equal(AWS_SG_DESCRIPTION.test(accepted), true, `should be accepted: ${JSON.stringify(accepted)}`);
  }
});

test('every ingress block sources its traffic from a Fleet security group', () => {
  // The enforced form of AGENTS.md's VPC invariant: the unit ships two
  // intra-VPC ingress blocks (instances SG → daemon SG, instances + daemon
  // SGs → EFS SG), both documented inline in infra/aws/main.tf. A third —
  // or a loosening of these two to cidr_blocks — fails here.
  const offenders: string[] = [];
  let checked = 0;

  for (const unit of readdirSync(INFRA)) {
    const unitDir = join(INFRA, unit);
    if (!statSync(unitDir).isDirectory()) continue;

    for (const name of readdirSync(unitDir)) {
      if (!name.endsWith('.tf')) continue;
      const text = readFileSync(join(unitDir, name), 'utf8');
      checked += [...text.matchAll(INGRESS_BLOCK)].length;
      for (const body of unguardedIngresses(text)) {
        offenders.push(`infra/${unit}/${name}: ${body.slice(0, 120)}`);
      }
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    `ingress rules with no aws_security_group.<name>.id source (CIDR-based or source-less):\n${offenders.join('\n')}`,
  );
  // The unit's two shipped blocks must have been scanned, not zero.
  assert.ok(checked >= 2, `only ${checked} ingress blocks found — the scan is looking in the wrong place`);
});

test('the ingress gate rejects CIDR-based, variable-sourced, and source-less rules', () => {
  // Same discipline as the description pin: untested, the matcher can be
  // widened to nothing and stay green. Exercise it against each shape of
  // violation the invariant bans.
  const block = (source: string): string =>
    `resource "aws_security_group" "acme" {\n  ingress {\n${source}  }\n}`;
  const sg = (source: string): string => block(`    ${source}\n`);

  for (const rejected of [
    sg('description = "http"\n    from_port   = 80\n    protocol    = "tcp"\n    cidr_blocks = ["0.0.0.0/0"]'),
    sg('from_port = 2049\n    to_port   = 2049\n    protocol  = "tcp"'),
    sg('security_groups = [var.external_sg_id]'), // referenced, but not a Fleet-created SG
  ]) {
    assert.deepEqual(unguardedIngresses(rejected).length, 1, `should be rejected: ${JSON.stringify(rejected)}`);
  }

  for (const accepted of [
    sg('security_groups = [aws_security_group.instances.id]'),
    sg('security_groups = [aws_security_group.instances.id, aws_security_group.daemon.id]'),
  ]) {
    assert.deepEqual(unguardedIngresses(accepted), [], `should be accepted: ${JSON.stringify(accepted)}`);
  }
});

// #187: the reconcile sweep (#147/#171) shipped without its IAM grants — the
// daemon's dispatch policy allowed RunTask/StopTask/PassRole but not the two
// read actions the sweep's first AWS call needs, so POST /reconcile answered
// 500 on a live deployment. No mocked test or plan can see a live IAM denial
// (the policy JSON embeds computed ARNs, unknown at plan), so the grant is
// pinned at the source level like the other API-only constraints here.
test('the daemon dispatch policy grants the reconcile sweep its two read actions', () => {
  const text = readFileSync(join(INFRA, 'aws', 'main.tf'), 'utf8');
  const start = text.indexOf('resource "aws_iam_role_policy" "daemon_dispatch"');
  assert.notEqual(start, -1, 'daemon_dispatch policy resource must exist');
  const body = text.slice(start, text.indexOf('\nresource ', start + 1));
  for (const action of ['ecs:ListTasks', 'ecs:DescribeTasks']) {
    assert.match(
      body,
      new RegExp(`"${action}"`),
      `daemon_dispatch must grant ${action} or the reconcile sweep 500s live (#187)`,
    );
  }
  // Cluster-scoped, matching the RunTask statement's shape: a read grant that
  // widens past the cluster is a diff a reviewer must see. Each action's
  // statement is small; the condition must appear before the next statement's
  // Effect line.
  for (const action of ['ecs:ListTasks', 'ecs:DescribeTasks']) {
    const at = body.indexOf(`"${action}"`);
    const next = body.indexOf('Effect', at);
    const statement = body.slice(at, next === -1 ? at + 400 : next);
    assert.match(statement, /ecs:cluster/, `the ${action} grant must stay cluster-scoped (#187)`);
  }
});

// #188: the daemon publishes its operator token at boot as an SSM parameter,
// so the CLI can fetch it instead of the operator running ecs execute-command
// by hand. The grant's resource ARN embeds computed region/account values no
// plan resolves, so — like the #187 grants above — it is pinned at the source
// level: present, write-only, and scoped to exactly the operator-token path.
test('the daemon SSM policy grants the boot-time token publish, scoped to one path', () => {
  const text = readFileSync(join(INFRA, 'aws', 'main.tf'), 'utf8');
  const start = text.indexOf('resource "aws_iam_role_policy" "daemon_ssm_config"');
  assert.notEqual(start, -1, 'daemon_ssm_config policy resource must exist');
  const body = text.slice(start, text.indexOf('\nresource ', start + 1));
  const at = body.indexOf('"ssm:PutParameter"');
  assert.notEqual(
    at,
    -1,
    'daemon_ssm_config must grant ssm:PutParameter or the boot-time token publish is denied live (#188)',
  );
  // Scoped to the one operator-token path — a PutParameter that widens past it
  // lets the daemon overwrite fleet-config, which it must never write.
  const next = body.indexOf('Effect', at);
  const statement = body.slice(at, next === -1 ? body.length : next);
  assert.match(
    statement,
    /operator_token_ssm_path/,
    'the ssm:PutParameter grant must stay scoped to the operator-token parameter (#188)',
  );
  assert.match(
    text,
    /operator_token_ssm_path\s*=\s*"\/\$\{var\.name\}\/operator-token"/,
    'the operator-token path must be the sibling of fleet-config under the same prefix (#188)',
  );
});
