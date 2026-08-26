// Function size, complexity, parameter count and file size — at the thresholds
// Codacy actually enforces.
//
// Codacy's gate is `issueThreshold: 0` on NEW issues, and every issue it has
// ever raised against this repo's code has come from Lizard. That gate lives on
// a pull request, which means the only way to find out was to push and wait —
// four findings across three PRs were each discovered that way, and each cost a
// push, a wait and a fix. The check belongs where `agents/dev.md` already sends
// every job: `npm test`.
//
// All four of Lizard's patterns, because the first version of this file checked
// two and I reported it as covering Lizard: `Lizard_ccn-minor` and
// `Lizard_nloc-medium` are per function, `Lizard_parameter-count-medium` and
// `Lizard_file-nloc-medium` are not, and the two it missed accounted for 8 of
// the 45 findings.
//
// Scope follows `.codacy.yaml`, not convenience: `src/**` and `.fleet/`'s own
// scripts, both of which are in Codacy's scope, and both TypeScript and the
// `.mjs` files. No `-l` flag: `-l typescript` measures no `.mjs` at all, which
// made `src/validate.mjs` and `.fleet/gate.mjs` invisible to the first version
// of this gate, and lizard's own extension detection covers both in one pass.
//
// A pinned baseline rather than a flat limit, because 36 entries are over the
// line today and rewriting them is not a prerequisite for touching this repo.
// The list is the debt, written down. Adding to it fails; paying one off fails
// too, and the fix is deleting the line — the same bargain
// `test/analyzer-scope.test.ts` strikes, for the same reason: a number that
// drifts silently is not a checkpoint.
//
// Lizard is a dev-time Python tool, not a package dependency — nothing here
// ships (`test/packaging.test.ts` owns that boundary). It is skipped when
// absent, so a fresh checkout still runs the suite. That makes this a local
// gate only until it is wired into `.github/workflows/`, which a job token
// cannot push (#48) — the same caveat AGENTS.md records for the terraform smoke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Codacy's four Lizard patterns, and the limit each one carries. */
const CCN_LIMIT = 10;          // Lizard_ccn-minor
const FUNC_NLOC_LIMIT = 50;    // Lizard_nloc-medium
const PARAM_LIMIT = 8;         // Lizard_parameter-count-medium
const FILE_NLOC_LIMIT = 500;   // Lizard_file-nloc-medium

/**
 * Paths Codacy analyses and this gate therefore has to. `.fleet/` is in scope
 * deliberately (`.codacy.yaml`: "Config gets excluded here; code does not") and
 * `gate.mjs` is 200-odd lines of Node that shells out to `gh`.
 */
const TARGETS = ['src', '.fleet'];

/**
 * Functions already over a per-function limit, as `<file>::<name>`. Every entry
 * is debt, not an exemption — and some are Lizard misreading TypeScript rather
 * than real complexity, which is worth knowing before anyone "fixes" them:
 * Lizard parses TS as C, so `generatedName` (nloc 675, ccn 1) is one big
 * template literal, and a function whose body ends in nested arrows, template
 * literals, or an inline object return-type annotation absorbs its neighbours.
 * When a number here looks absurd, measure the function by hand first.
 */
const FUNCTION_BASELINE = [
  // cmdDoctor: checks ~10 env/tool prerequisites = CCN 39, NLOC 83; genuine.
  'src/cli/main.ts::cmdDoctor',
  // cmdLint: two try/catch loops + git check = CCN 15; genuine.
  'src/cli/main.ts::cmdLint',
  // dispatchDelegate: full dispatch state machine. CCN 51, NLOC 108 as measured
  // before #36 added the shape/authority resolution, which grew both; genuine,
  // and the numbers are a floor rather than the current reading.
  'src/cli/main.ts::dispatchDelegate',
  // main: top-level argument dispatch over all subcommands = CCN 23; genuine.
  'src/cli/main.ts::main',
  // run (the cockpit's command switch): one case per verb plus their guards =
  // CCN 18; genuine, and pre-existing — invisible until #121 flattened the
  // delegate case, whose old inline try/catch made Lizard's TS-as-C parse
  // absorb the whole switch into a neighbouring segment.
  'src/cli/cockpit.ts::run',
  // runCockpit: Lizard misparse (see the note above). It reports 53 NLOC over a
  // 285-line span; the function's real direct body is several times that and
  // was never measured before #121, for the same segmentation reason as `run`.
  'src/cli/cockpit.ts::runCockpit',
];

/** Files already over FILE_NLOC_LIMIT. Same bargain as FUNCTION_BASELINE. */
const FILE_BASELINE = [
  'src/cli/cockpit.ts',
  'src/cli/main.ts',
  'src/cli/setup.ts',
  'src/daemon/registry.ts',
  'src/daemon/server.ts',
  'src/runner/main.ts',
];

type Measured = { functions: { key: string; why: string }[]; files: { key: string; why: string }[] };

/**
 * One lizard pass over both languages. Deliberately one, and deliberately not
 * at module scope: `node --test` runs test files concurrently, so a couple of
 * seconds of CPU spent while this file is being imported competes with the
 * timing-sensitive end-to-end tests that spawn real runners — two invocations
 * at import time were enough to start tipping them over.
 */
function measure(): Measured | null {
  const functions: { key: string; why: string }[] = [];
  const files: { key: string; why: string }[] = [];

  const run = spawnSync(
    'python3',
    [
      '-m', 'lizard',
      // Lizard's own warning thresholds, pushed out of reach. It exits 1
      // whenever its defaults (-C 15 -L 1000) fire, so a plain `status !== 0`
      // check cannot tell "lizard is not installed" from "lizard found
      // something" — and reading it that way made this gate skip silently on a
      // tree it should have failed. The limits that matter are Codacy's,
      // applied below to the numbers it reports.
      '-C', '9999', '-L', '999999', '-a', '9999',
      ...TARGETS,
    ],
    { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 },
  );
  // Now that its own thresholds cannot fire, a non-zero exit is a real failure —
  // and the footer proves it produced a report rather than a usage error.
  if (run.status !== 0 || !run.stdout.includes('Total nloc')) return null;
  collect(run.stdout, functions, files);
  return { functions, files };
}

/**
 * Lizard's default report, in two parts: per-function rows (`nloc ccn token
 * param length location`) and a per-file summary table (`NLOC Avg.NLOC AvgCCN
 * Avg.token function_cnt file`). The `--csv` form carries only the first, which
 * is why this parses the human report instead.
 */
function collect(
  stdout: string,
  functions: { key: string; why: string }[],
  files: { key: string; why: string }[],
): void {
  for (const line of stdout.split('\n')) {
    const fn = /^\s+(\d+)\s+(\d+)\s+\d+\s+(\d+)\s+\d+\s+(\S+)@\d+-\d+@(\S+)\s*$/.exec(line);
    if (fn !== null) {
      const [nloc, ccn, params, name, file] = [
        Number(fn[1]), Number(fn[2]), Number(fn[3]), fn[4]!, fn[5]!,
      ];
      const why = [
        nloc > FUNC_NLOC_LIMIT ? `${nloc} lines of code (limit ${FUNC_NLOC_LIMIT})` : '',
        ccn > CCN_LIMIT ? `complexity ${ccn} (limit ${CCN_LIMIT})` : '',
        params > PARAM_LIMIT ? `${params} parameters (limit ${PARAM_LIMIT})` : '',
      ].filter(Boolean).join(', ');
      if (why !== '') functions.push({ key: `${file}::${name}`, why });
      continue;
    }
    // Per-file summary row: six columns, the last a path, and no `@` locator.
    const fileRow = /^\s+(\d+)\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+\d+\s+(\S+)\s*$/.exec(line);
    if (fileRow !== null && !fileRow[2]!.includes('@')) {
      const nloc = Number(fileRow[1]);
      if (nloc > FILE_NLOC_LIMIT) {
        files.push({ key: fileRow[2]!, why: `${nloc} non-comment lines (limit ${FILE_NLOC_LIMIT})` });
      }
    }
  }
}

test(
  'nothing is over Codacy\'s Lizard limits beyond the pinned baseline',
  () => {
    const measured = measure();
    if (measured === null) {
      // Absent lizard is a skip, not a failure: a fresh checkout still runs the
      // suite. It does mean this is a check you can accidentally not have — see
      // AGENTS.md, which names the install alongside the other pre-push steps.
      console.error('complexity gate skipped: lizard not installed (pip install lizard)');
      return;
    }
    // A broken invocation reports no offenders, which reads exactly like a clean
    // tree. That mistake is why this exists in this shape: an earlier read of
    // Lizard's output through `sed -n '/Warnings/,/^====/p'` terminated on the
    // table's own header rule, printed zero rows, and was reported as "clean"
    // while two functions were over the limit.
    assert.ok(measured.functions.length > 0, 'measured no offending function — the invocation is wrong, not the code');
    assert.ok(measured.files.length > 0, 'measured no offending file — the invocation is wrong, not the code');

    const check = (
      what: string,
      found: { key: string; why: string }[],
      baseline: string[],
      hint: string,
    ): void => {
      const allowed = new Set(baseline);
      assert.deepEqual(
        found.filter((o) => !allowed.has(o.key)).map((o) => `${o.key} — ${o.why}`),
        [],
        `new ${what} over Codacy's Lizard limits. ${hint}`,
      );
      const seen = new Set(found.map((o) => o.key));
      assert.deepEqual(
        baseline.filter((key) => !seen.has(key)),
        [],
        `${what}(s) no longer over the limits — delete them from the baseline so the ` +
        'list stays an honest account of the debt',
      );
    };

    check(
      'function',
      measured.functions,
      FUNCTION_BASELINE,
      'Split them — or, if the number looks absurd, check whether Lizard mis-parsed the file first.',
    );
    check(
      'file',
      measured.files,
      FILE_BASELINE,
      'Move something out of the file rather than growing it further.',
    );
  },
);
