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
