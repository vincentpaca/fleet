// Function size and complexity, at the thresholds Codacy actually enforces.
//
// Codacy's gate is `issueThreshold: 0` on NEW issues, and every issue it has
// ever raised against this repo's code has come from Lizard: nloc over 50 or
// cyclomatic complexity over 10. That gate lives on a pull request, which means
// the only way to find out was to push and wait — four findings across three
// PRs were each discovered that way, and each cost a push, a wait, and a fix.
// The check belongs where `agents/dev.md` already sends every job: `npm test`.
//
// A pinned baseline rather than a flat limit, because 27 functions are over the
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

/** Codacy's Lizard patterns: `Lizard_nloc-medium` and `Lizard_ccn-minor`. */
const NLOC_LIMIT = 50;
const CCN_LIMIT = 10;

/**
 * Functions already over a limit, as `<file>::<name>`. Every entry is debt, not
 * an exemption — and three of them are Lizard misreading TypeScript rather than
 * real complexity, which is worth knowing before anyone "fixes" them:
 * `generatedName` (nloc 675, ccn 1) is one big template literal, and Lizard
 * parses TS as C, so a function whose body ends in nested arrows, template
 * literals, or an inline object return-type annotation absorbs its neighbours.
 * When a number here looks absurd, measure the function by hand before
 * rewriting it.
 */
const BASELINE = [
  'src/cli/board.ts::(anonymous)',
  'src/cli/board.ts::buildBanner',
  'src/cli/board.ts::renderContextStrip',
  'src/cli/board.ts::renderEventLines',
  'src/cli/client.ts::daemonTarget',
  'src/cli/cockpit.ts::checkTunnel',
  'src/cli/cockpit.ts::cockpitKeyAction',
  'src/cli/cockpit.ts::parseCockpitInput',
  'src/cli/cockpit.ts::renderCockpit',
  'src/cli/connect.ts::superviseTunnel',
  'src/cli/format.ts::formatLogText',
  'src/cli/main.ts::cmdLint',
  'src/cli/main.ts::daemonFailureMessage',
  'src/cli/main.ts::dispatchDelegate',
  'src/cli/setup.ts::generatedName',
  'src/daemon/server.ts::#answer',
  'src/daemon/server.ts::#createJob',
  'src/daemon/server.ts::#receiveArtifact',
  'src/daemon/server.ts::#route',
  'src/daemon/verify.ts::verifyWithGh',
  'src/runner/artifacts.ts::collectArtifacts',
  'src/runner/git.ts::setupWorkspace',
  'src/runner/harness.ts::buildHarnessCommand',
  'src/runner/harness.ts::versionSatisfies',
  'src/runner/settle.ts::composeSettle',
  'src/runner/translate.ts::translateLine',
  'src/shared/http.ts::request',
];

type Offender = { key: string; nloc: number; ccn: number; why: string };

/** `lizard --csv` columns: nloc, ccn, token, param, length, location, file, name, … */
function measure(): Offender[] | null {
  const run = spawnSync('python3', ['-m', 'lizard', '--csv', '-l', 'typescript', 'src'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (run.status !== 0) return null;
  const offenders: Offender[] = [];
  for (const line of run.stdout.split('\n')) {
    if (line.trim() === '') continue;
    // Fields 6+ are quoted and may contain commas; the five leading numbers are not.
    const lead = /^(\d+),(\d+),\d+,\d+,\d+,/.exec(line);
    if (!lead) continue;
    const nloc = Number(lead[1]);
    const ccn = Number(lead[2]);
    if (nloc <= NLOC_LIMIT && ccn <= CCN_LIMIT) continue;
    const quoted = line.match(/"([^"]*)"/g);
    if (quoted === null || quoted.length < 3) continue;
    const file = quoted[1]!.slice(1, -1);
    const name = quoted[2]!.slice(1, -1);
    const why = [
      nloc > NLOC_LIMIT ? `${nloc} lines of code (limit ${NLOC_LIMIT})` : '',
      ccn > CCN_LIMIT ? `complexity ${ccn} (limit ${CCN_LIMIT})` : '',
    ].filter(Boolean).join(', ');
    offenders.push({ key: `${file}::${name}`, nloc, ccn, why });
  }
  return offenders;
}

const offenders = measure();

test(
  'no function is over Codacy\'s size or complexity limits beyond the pinned baseline',
  { skip: offenders === null ? 'lizard not installed: pip install lizard' : false },
  () => {
    assert.ok(offenders !== null);
    assert.ok(offenders.length > 0, 'lizard measured nothing — the invocation is wrong, not the code');

    const allowed = new Set(BASELINE);
    const added = offenders.filter((o) => !allowed.has(o.key));
    assert.deepEqual(
      added.map((o) => `${o.key} — ${o.why}`),
      [],
      'new function(s) over Codacy\'s Lizard limits. Split them, or — if the number is ' +
      'absurd — check whether Lizard mis-parsed the file before touching anything.',
    );

    const seen = new Set(offenders.map((o) => o.key));
    const paidOff = BASELINE.filter((key) => !seen.has(key));
    assert.deepEqual(
      paidOff,
      [],
      'these are no longer over the limits — delete them from BASELINE so the list ' +
      'stays an honest account of the debt',
    );
  },
);
