/**
 * `fleet upgrade` — converge the deployment to the CLI's own commit (#207).
 *
 * Upgrading a live deployment was a seven-step manual ritual, and every step
 * was botched at least once during the first live week: a stale-ref apply
 * silently rebuilt last week's design, and a runner image predating an
 * already-merged fix cost a job its work (#197). Doctor's skew section names
 * those gaps; this command closes them, re-entering the machinery that
 * created the deployment rather than growing a second convention:
 *
 *   1. the target is the CLI's own git SHA — the same anchor doctor's skew
 *      check compares against (./skew.ts), read the same way;
 *   2. the re-pin is a string edit of the deployment-local main.tf's `?ref=`
 *      — the same one-line edit the operator was doing by hand;
 *   3. init/plan/apply and the capture are `fleet setup infra`'s own steps
 *      (./setup.ts), on the same explicit-yes interview contract, headless
 *      with --yes;
 *   4. the image rebuild is the deployment's in-account build (#189/#204) at
 *      the ref the apply just pinned — the CodeBuild project's source_ref
 *      comes from the applied module args, so "same ref" is structural. A
 *      deployment whose module source is not clonable (a local path or
 *      git::file:// — the dogfood shape) has no such build; the fallback is
 *      named, never silently skipped.
 *
 * A refused plan restores the ref and aborts before any mutation: a main.tf
 * claiming a ref that was never applied is exactly the stale-file lie the
 * skew check exists to catch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gitValue } from '../shared/git.ts';
import { appliedUnitPins, sameCommit, shortSha, type UnitPin } from './skew.ts';
import { unitFor, type SetupUnit } from './setup-units.ts';
import {
  SetupError,
  captureFleetConfig,
  confirm,
  preflight,
  produceImages,
  readCapturedConfig,
  spawnRunner,
  stdinAsker,
  terraformStep,
  type Asker,
  type Runner,
} from './setup.ts';

export type UpgradeOptions = {
  cwd: string;
  env: Record<string, string | undefined>;
  /** Root of this Fleet installation — the checkout whose HEAD is the target. */
  root: string;
  /** --yes: apply the plan without the confirmation (the setup-infra contract). */
  yes: boolean;
  /** True when there is a terminal to confirm the plan on. */
  interactive: boolean;
  log: (line: string) => void;
  run?: Runner;
  openAsker?: () => Promise<Asker>;
};

/**
 * What upgrade would converge: this CLI's commit, and every pin behind it.
 * The three ways the answer cannot exist are refusals with the way out named
 * — an install with no SHA, a directory with no deployment, and a pin with no
 * ref to re-pin.
 */
function upgradeTargets(opts: UpgradeOptions): { cliSha: string; stale: UnitPin[] } {
  const cliSha = gitValue(['rev-parse', 'HEAD'], opts.root);
  if (cliSha === undefined) {
    // The same honest silence doctor's skew section keeps: an npm install
    // carries no git SHA, so there is no commit to converge to (#183).
    throw new SetupError(
      'this CLI is not a git checkout, so it has no commit to converge the deployment to (#183 will version releases)',
    );
  }
  const pins = appliedUnitPins(opts.cwd);
  if (pins.length === 0) {
    throw new SetupError(
      'no deployment to upgrade: no .fleet/infra/<provider>/main.tf here\n' +
        '  fleet setup infra stands one up; upgrade converges what setup created',
    );
  }
  const stale = pins.filter((pin) => !upToDate(pin, cliSha, opts.root));
  const unpinned = stale.find((pin) => pin.ref === undefined);
  if (unpinned !== undefined) {
    throw new SetupError(
      `the ${unpinned.provider} unit is applied from ${unpinned.source}, which pins no ref — there is nothing to re-pin\n` +
        '  re-apply it with fleet setup infra: a pinned module source is what makes a deployment convergeable',
    );
  }
  return { cliSha, stale };
}

/**
 * Converge every deployment root module under cwd to this CLI's commit.
 * Returns 0 on every honest ending (converged, already there, plan refused);
 * refusals that need the operator's attention throw SetupError, the same
 * surface every setup command reports through.
 */
export async function runUpgrade(opts: UpgradeOptions): Promise<number> {
  const run = opts.run ?? spawnRunner;
  const { cliSha, stale } = upgradeTargets(opts);
  if (stale.length === 0) {
    // Before any preflight or terraform: nothing to do needs nothing proven.
    opts.log(`nothing to do: the deployment is already at this CLI's commit (${shortSha(cliSha)})`);
    return 0;
  }

  // One reader for the whole command (see runSetupInfra for why two would
  // break on the second question), opened only when a plan will need a yes.
  const ask = opts.interactive ? await (opts.openAsker ?? stdinAsker)() : undefined;
  try {
    for (const pin of stale) {
      const unit = unitFor(pin.provider);
      if (unit === undefined) {
        throw new SetupError(`no unit for provider "${pin.provider}" — this CLI cannot drive that deployment's terraform`);
      }
      // Before the first edit, exactly as setup infra orders it: a re-pin that
      // then dies on a missing binary leaves a file describing nothing.
      preflight(unit, opts.cwd, run);
      const applied = await upgradeOne(pin, unit, cliSha, opts, run, ask);
      if (!applied) return 0;
    }
  } finally {
    ask?.close();
  }
  return 0;
}

/** Is this pin already at the CLI's commit? Ref-less pins are never "done" — the caller refuses them by name. */
function upToDate(pin: UnitPin, cliSha: string, root: string): boolean {
  if (pin.ref === undefined) return false;
  // A tag ref compares by the commit it names, resolved in the CLI's own
  // checkout — the same resolution doctor's skew section uses.
  const resolved = gitValue(['rev-parse', '--verify', `${pin.ref}^{commit}`], root);
  return sameCommit(resolved ?? pin.ref, cliSha);
}

/** The `source_ref` module argument (#189), hoisted so Lizard's TS-as-C parse
 *  cannot misread an inline regex as a division and swallow the function. */
const SOURCE_REF_RE = /(source_ref\s*=\s*")[^"]*(")/;

/**
 * The re-pinned file text: the module source's `?ref=` swapped for the CLI's
 * sha, and — when the file carries one — the `source_ref` module argument with
 * it, because setup derived that argument from this very pin (#189: images and
 * infra move as one ref or not at all) and a re-pin that missed it would have
 * the in-account build clone the ref the apply just left behind. Nothing else
 * moves: the operator's backend block, comments and hand edits all stay put.
 * split/join rather than replace for the source, so a sha in the replacement
 * can never be read as a replacement pattern.
 */
export function repinnedMainTf(text: string, pin: UnitPin, cliSha: string): string { // contract pin: test-only export, asserted by the suite
  const source = pin.source;
  const repinned = source.replace(/([?&]ref=)[^&"\s]+/, `$1${cliSha}`);
  if (!text.includes(source) || repinned === source) {
    throw new SetupError(
      `cannot re-pin ${pin.provider}: its main.tf no longer contains the module source that was read from it (${source})`,
    );
  }
  return text.split(source).join(repinned).replace(SOURCE_REF_RE, `$1${cliSha}$2`);
}

/**
 * One deployment's converge: re-pin, init -upgrade, plan, apply on an explicit
 * yes, re-capture, rebuild images. Returns false when the plan was not
 * approved — the ref edit is reverted and nothing was mutated.
 */
async function upgradeOne(
  pin: UnitPin,
  unit: SetupUnit,
  cliSha: string,
  opts: UpgradeOptions,
  run: Runner,
  ask: Asker | undefined,
): Promise<boolean> {
  const dir = path.join(opts.cwd, '.fleet', 'infra', pin.provider);
  const mainTf = path.join(dir, 'main.tf');
  const shownTf = path.relative(opts.cwd, mainTf);
  const before = fs.readFileSync(mainTf, 'utf8');
  fs.writeFileSync(mainTf, repinnedMainTf(before, pin, cliSha));
  opts.log(`re-pinned ${shownTf}: ref ${shortSha(pin.ref!)} -> ${shortSha(cliSha)}`);

  const planFile = 'fleet.tfplan';
  // Any ending short of an apply restores the file byte-for-byte and drops the
  // plan: a kept plan for a reverted ref would re-create the upgrade the
  // operator just declined, and a main.tf pinned at a ref that was never
  // applied is a skew report lying in the other direction.
  const revert = (): void => {
    fs.writeFileSync(mainTf, before);
    fs.rmSync(path.join(dir, planFile), { force: true });
  };
  try {
    // -upgrade: the module source just changed, and a plain init keeps serving
    // .terraform's cached copy of the old ref — the stale-ref apply of the
    // 2026-08-26/27 cycle in one flag.
    terraformStep(run, dir, ['init', '-input=false', '-upgrade'], 'init');
    terraformStep(run, dir, ['plan', '-input=false', `-out=${planFile}`], 'plan');
    if (!opts.yes && !(await planApproved(pin, cliSha, opts, ask))) {
      revert();
      opts.log(`nothing applied. ${shownTf} restored to ref ${shortSha(pin.ref!)} — it keeps describing what is deployed.`);
      return false;
    }
  } catch (err) {
    revert();
    throw err;
  }

  terraformStep(run, dir, ['apply', '-input=false', planFile], 'apply');
  const configPath = captureFleetConfig(dir, run);
  opts.log(`applied. Re-captured ${path.relative(opts.cwd, configPath)} — every other fleet command reads it.`);
  await upgradeImages(opts, run, unit, configPath);
  return true;
}

/** The plan gate. Headless without --yes has nobody to consent, so it is a no — and says what would continue. */
async function planApproved(pin: UnitPin, cliSha: string, opts: UpgradeOptions, ask: Asker | undefined): Promise<boolean> {
  if (!ask) {
    opts.log('planned only: no terminal to confirm on. Rerun with --yes to apply.');
    return false;
  }
  return await confirm(`apply this plan, upgrading the ${pin.provider} deployment to ${shortSha(cliSha)}?`, ask);
}

/**
 * The rebuild at the ref the apply just pinned (#189/#204). A deployment whose
 * module source is not clonable by the in-account build (a local path or a
 * git::file:// pin — the dogfood shape) provisions no build project; the
 * unit's own fallback line names images/build.sh --redeploy-daemon rather
 * than skipping silently.
 */
async function upgradeImages(opts: UpgradeOptions, run: Runner, unit: SetupUnit, configPath: string): Promise<void> {
  const config = readCapturedConfig(configPath);
  if (await produceImages({ cwd: opts.cwd, env: opts.env, log: opts.log }, run, unit, config)) {
    // Guidance, not the roll itself: no shipped code path may deploy
    // (docs/decisions.md#d5) — the same boundary --rebuild-images keeps.
    opts.log('the daemon service starts from the new image on its next deployment — roll it now with:');
    opts.log(`  ${unit.images.rollHint(config)}`);
    // #218 sat latent until a real dispatch found it; the proof is one job.
    opts.log('then prove the rolled image on a live job: fleet canary');
    return;
  }
  opts.log(`note: ${unit.images.unavailable}`);
}
