/**
 * The cloud units `fleet setup infra` can stand up — one entry per `infra/<cloud>/`.
 *
 * Fleet authors the infra shape (docs/decisions.md#d12), so setup can ask for
 * only what the unit's own defaults cannot assume: a name, where to put it, and
 * whether to reuse a network that already exists. Everything else the contract
 * assumes, and the wizard never mentions.
 *
 * The entire job of this file is that map. It holds no terraform rendering and
 * no process control — ./setup.ts owns both, cloud-agnostically — so a second
 * cloud is a new entry here, not a new branch over there. Nothing in it imports
 * a provider implementation: standing infrastructure up is a terraform
 * conversation, and the runtime provider only exists once the unit is applied.
 */

/** Answers so far, keyed by prompt key. Every value is the operator's raw text. */
export type Answers = Record<string, string>;

/** One question, and the flag that pre-supplies it when there is no terminal. */
export type PromptSpec = {
  /** Answer key, and the long-flag name (`name` → `--name`). */
  key: string;
  /** What the operator is asked, in lower case: "region". */
  question: string;
  /** One line under the question when the answer is not self-evident. */
  hint?: string;
  /** Shown in brackets; Enter accepts it. Absent means there is no assumption to make. */
  fallback?: (env: Record<string, string | undefined>) => string | undefined;
  /** An empty answer is not an answer — headless, its absence is a hard error. */
  required?: boolean;
  /** Rejection message, or undefined when the value is fine. */
  validate?: (value: string) => string | undefined;
  /** Asked only when the answers so far call for it. */
  when?: (answers: Answers) => boolean;
};

/** A `required_providers` entry for the generated root module. */
type RequiredProvider = { name: string; source: string; version: string };

export type SetupUnit = {
  /** Directory name under `infra/` in this repo and under `.fleet/infra/` in the project. */
  provider: string;
  /** How the unit is described to the operator. */
  label: string;
  /**
   * Proves the operator can actually reach the cloud, before a single prompt.
   * Exit 0 is the only pass: a wizard that collects five answers and then dies
   * on `terraform apply` wasted the interview.
   */
  credentials: {
    argv: string[];
    /** The binary is missing entirely. */
    absent: string;
    /** The binary ran and said no. */
    denied: string;
  };
  requiredProviders: RequiredProvider[];
  /** Terraform `provider "<name>"` block arguments, from the answers. */
  providerArgs: (answers: Answers) => Array<[string, string]>;
  /** Module block arguments, as already-rendered HCL values. */
  moduleArgs: (answers: Answers) => Array<[string, string]>;
  prompts: PromptSpec[];
};

// ---------- shared validators ----------

/** Quote a string as an HCL literal. */
function hclString(value: string): string {
  return JSON.stringify(value);
}

/** Render a comma-separated answer as an HCL list of strings. */
function hclStringList(value: string): string {
  return `[${splitList(value).map(hclString).join(', ')}]`;
}

/** Split a comma-separated answer into trimmed, non-empty items. */
export function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * The deployment name is `var.name`: every resource name and the `fleet:module`
 * tag on every taggable resource derive from it, and so does the SSM parameter
 * path the daemon reads at boot. AWS resource names and SSM paths both reject
 * what a loose value would produce, so the wizard rejects it first — at the
 * prompt, where it costs one keystroke instead of a failed apply.
 */
function validateName(value: string): string | undefined {
  if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(value)) {
    return 'a name is 3-32 characters of lower-case letters, digits and dashes, starting with a letter';
  }
  if (value.includes('--')) return 'a name cannot contain a double dash';
  return undefined;
}

function validateRegion(value: string): string | undefined {
  return /^[a-z]{2}(-[a-z]+)+-\d$/.test(value) ? undefined : `not an AWS region: ${value}`;
}

function validateVpcId(value: string): string | undefined {
  return /^vpc-[0-9a-f]+$/.test(value) ? undefined : `not a VPC id: ${value} (expected vpc-…)`;
}

function validateSubnetIds(value: string): string | undefined {
  const ids = splitList(value);
  if (ids.length === 0) return 'reusing a VPC needs at least one subnet';
  const bad = ids.find((id) => !/^subnet-[0-9a-f]+$/.test(id));
  return bad === undefined ? undefined : `not a subnet id: ${bad} (expected subnet-…)`;
}

// ---------- the units ----------

const AWS: SetupUnit = {
  provider: 'aws',
  label: 'AWS — ECS on EC2 that scales to zero, the daemon on Fargate, no public ingress',
  credentials: {
    argv: ['aws', 'sts', 'get-caller-identity'],
    absent: 'the aws CLI is not on PATH — install it and configure credentials, then rerun',
    denied:
      'aws sts get-caller-identity failed — no usable AWS credentials in this shell (set AWS_PROFILE, or run `aws configure`)',
  },
  requiredProviders: [{ name: 'aws', source: 'hashicorp/aws', version: '~> 6.0' }],
  providerArgs: (a) => [['region', hclString(a.region)]],
  moduleArgs: (a) => {
    const args: Array<[string, string]> = [['name', hclString(a.name)]];
    // Left out entirely when absent: the module's own defaults are the contract,
    // and writing them back as literals would freeze today's values into a file
    // the operator keeps.
    if (a.vpc_id) {
      args.push(['vpc_id', hclString(a.vpc_id)]);
      args.push(['subnet_ids', hclStringList(a.subnet_ids)]);
    }
    return args;
  },
  // No budget prompt, deliberately: #13 asked for monthly budget USD + email,
  // but D12's 2026-08-19 amendment took billing products out of the unit, so
  // there is no variable to fill and nothing to ask. Confirmed with a human on
  // the job rather than decided here (decision d1) — a wizard cannot ask for a
  // value the contract has no home for.
  prompts: [
    {
      key: 'name',
      question: 'name',
      hint: 'tags every resource (cost tracking) and names the deployment for teardown',
      required: true,
      validate: validateName,
    },
    {
      key: 'region',
      question: 'region',
      fallback: (env) => env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-1',
      required: true,
      validate: validateRegion,
    },
    {
      key: 'vpc_id',
      question: 'existing VPC to deploy into',
      hint: 'blank creates a dedicated VPC — the default, and what most operators want',
      fallback: () => '',
      validate: (v) => (v === '' ? undefined : validateVpcId(v)),
    },
    {
      key: 'subnet_ids',
      question: 'subnets in that VPC (comma-separated)',
      required: true,
      validate: validateSubnetIds,
      // Truthiness, not `!== ''`: headless with no `--vpc-id` the key can be
      // absent entirely, and an absent answer is not a VPC to reuse.
      when: (a) => Boolean(a.vpc_id),
    },
  ],
};

/** Every unit this CLI can stand up, in the order they are offered. */
export const SETUP_UNITS: SetupUnit[] = [AWS];

export function unitFor(provider: string): SetupUnit | undefined {
  return SETUP_UNITS.find((unit) => unit.provider === provider);
}
