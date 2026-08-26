// Per-repo job images: hash-gated build at delegate time.
//
// Two-layer model:
//   Layer 1 (runner base): fleet-runner:<cli>-<cli_version>
//     Built from images/runner/Dockerfile; published by Fleet; contains node,
//     git, gh, the pinned harness CLI, and the runner source. Selection is
//     manifest harness.cli + harness.cli_version — operators never author a
//     Dockerfile for this layer.
//   Layer 2 (per-repo job image): fleet-job:<hash>
//     Built by the CLI at delegate time FROM the runner base, applying
//     manifest setup (script). Tagged by sha256(baseTag + resolved base image
//     id + setupInputs) — rebuilt when any of those change (including the
//     base tag moving to a new image, #138); otherwise the existing tag is
//     reused and cold start benefits from base-layer caching.
//
// Secrets: API keys never bake into either layer. They enter at task start
// via -e flags injected by the daemon (manifest env.vars, operator-supplied).
// Delegated jobs bill via API key; interactive OAuth/subscription login does
// not transfer to headless containers.
//
// ECR push: images/build.sh covers the runner base and daemon layers — it
// builds for the deployment's architecture, tags them :runner / :daemon, pushes
// to the repository its fleet_config names, and rolls the daemon service.
// Per-repo images are pushed here when --registry is configured.
// Region precedence differs from that script and predates it: pushToEcr below
// composes the ECR host from a flag/AWS_REGION region, while build.sh reads the
// region out of the repository URL (a login token is region-scoped, so the URL
// is the authority). Reconciling them belongs with the layer-2 ECR push work,
// not here — until then AWS_REGION must match the registry for this path.

import { createHash } from "node:crypto";
import { SETUP_BAKED_BASENAME } from "../shared/setup-marker.ts";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------- manifest shape (subset we care about) ----------

export type ImageManifest = {
  harness?: {
    cli?: string;
    cli_version?: string;
  };
  setup?: {
    image?: string;
    script?: string;
    devcontainer?: string;
    dockerfile?: string;
  };
};

// ---------- hash ----------

/**
 * Stable serialisation of setup inputs for hashing.
 * `readFile` is injectable so tests can verify hash behaviour without touching
 * the filesystem.
 */
function setupHashInputs(
  manifest: ImageManifest,
  readFile: (path: string) => string = defaultReadFile,
): string {
  const setup = manifest.setup ?? {};
  return JSON.stringify({
    script: setup.script != null ? tryRead(readFile, setup.script) : null,
    devcontainer: setup.devcontainer != null ? tryRead(readFile, setup.devcontainer) : null,
    dockerfile: setup.dockerfile != null ? tryRead(readFile, setup.dockerfile) : null,
    // setup.image is intentionally excluded: when cli_version is set, the
    // runner base IS the image; setup.image is not the job-image base.
  });
}

function defaultReadFile(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function tryRead(readFile: (p: string) => string, path: string): string {
  try {
    return readFile(path);
  } catch {
    return "";
  }
}

/** Derive the Fleet runner base tag from the manifest. */
export function runnerBaseTag(manifest: ImageManifest): string {
  const cli = manifest.harness?.cli ?? "claude-code";
  const version = manifest.harness?.cli_version ?? "latest";
  return `fleet-runner:${cli}-${version}`;
}

/**
 * Content hash for the per-repo job image.
 * sha256(baseTag + NUL + baseImageId + NUL + setupInputs) — first 16 hex chars.
 *
 * The base tag TEXT alone is not an identity (#138): "fleet-runner:
 * claude-code-latest" reads the same before and after the tag moves to a
 * rebuilt base, so hashing only the text reuses every stale job image under
 * an unchanged hash. Folding in the tag's resolved docker image id makes a
 * moved base a new hash — and a rebuild. When docker cannot resolve the tag
 * (base not pulled yet, no docker in a unit test) the id contributes nothing
 * and the hash degrades to the old text-only behavior; the build that follows
 * fails loudly on the missing base anyway.
 */
export function computeImageHash(
  manifest: ImageManifest,
  readFile?: (path: string) => string,
  resolveImageId: (tag: string) => string | undefined = localImageId,
): string {
  const base = runnerBaseTag(manifest);
  const inputs = setupHashInputs(manifest, readFile);
  return createHash("sha256")
    .update(base)
    .update("\0")
    .update(resolveImageId(base) ?? "")
    .update("\0")
    .update(inputs)
    .digest("hex")
    .slice(0, 16);
}

/** Per-repo job image tag derived from the content hash. */
export function jobImageTag(hash: string): string {
  return `fleet-job:${hash}`;
}

/**
 * True when cli_version is set — signals that the two-layer image model
 * applies and delegate should compute/build the job image.
 */
export function twoLayerEnabled(manifest: ImageManifest): boolean {
  return typeof manifest.harness?.cli_version === "string" && manifest.harness.cli_version !== "";
}

// ---------- local image check ----------

/**
 * Resolve a local image tag to its content-addressed docker image id
 * (sha256:…), or undefined when the local daemon has no such tag (or there is
 * no docker at all — a spawn failure is indistinguishable and treated the
 * same). The id is what a tag's text hides: it changes when the tag moves.
 */
function localImageId(tag: string): string | undefined {
  const result = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", tag], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  const id = result.stdout?.toString().trim();
  return id ? id : undefined;
}

const execFileAsync = promisify(execFile);

/**
 * `localImageId` without blocking the event loop. The delegate path runs on the
 * cockpit's live loop (#121): a spawnSync against a wedged docker daemon would
 * freeze every keypress including ^C. The sync form above stays for the plain
 * `fleet image build` command and as `computeImageHash`'s injectable default.
 */
export async function localImageIdAsync(tag: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const result = await execFileAsync("docker", ["image", "inspect", "--format", "{{.Id}}", tag], {
      encoding: "utf8",
      signal,
    });
    const id = result.stdout.trim();
    return id ? id : undefined;
  } catch {
    // Nonzero exit (no such tag), no docker at all, or an abort: all read as
    // "no local image", same as the sync form.
    return undefined;
  }
}

/** True when the image tag exists in the local Docker daemon. */
export function imageExistsLocally(tag: string): boolean {
  return localImageId(tag) !== undefined;
}

// ---------- build ----------

type BuildJobImageOptions = {
  /** Local tag to assign (e.g. "fleet-job:abc123"). */
  tag: string;
  /** Fleet runner base tag (e.g. "fleet-runner:claude-code-1.2.3"). */
  baseTag: string;
  manifest: ImageManifest;
  /** Build context directory (the repo root). */
  contextDir?: string;
  /**
   * Receives docker's combined stdout+stderr as it streams. The caller owns
   * presentation: the plain CLI writes it through, the cockpit passes nothing —
   * it owns the alternate screen, and raw build bytes splatted over it were the
   * original #121 symptom. Output is always captured either way, so a failure
   * carries its tail in the error.
   */
  onOutput?: (chunk: string) => void;
  /** Aborting kills the docker build — ^C mid-build must actually stop it. */
  signal?: AbortSignal;
};

/** How much of the build's tail a failure carries in its error message. */
const BUILD_ERROR_TAIL = 4_096;

/** Spawn `docker <args>` with captured output; resolve on exit 0, reject with the output tail otherwise. */
function runDockerBuild(
  args: string[],
  onOutput: ((chunk: string) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], signal });
    let tail = "";
    const consume = (chunk: Buffer): void => {
      const text = chunk.toString();
      onOutput?.(text);
      tail = (tail + text).slice(-BUILD_ERROR_TAIL);
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    let settled = false;
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    // With a `signal`, an abort surfaces here as an AbortError after the child
    // is killed; say what actually happened instead.
    child.on("error", (err) => done(signal?.aborted ? new Error("docker build aborted") : err));
    child.on("close", (code, killSignal) => {
      if (code === 0) done();
      else if (signal?.aborted) done(new Error("docker build aborted"));
      else done(new Error(`docker build exited ${code ?? `on ${killSignal}`}${tail ? `:\n${tail.trimEnd()}` : ""}`));
    });
  });
}

/**
 * The generated Dockerfile for a job image built without `setup.dockerfile`.
 * Pure and exported: the baked-marker contract below is what keeps setup from
 * running twice (or never), and it has to be testable without a docker daemon.
 *
 *   - `setup.script` set →
 *       FROM <runnerBase>
 *       COPY <setup.script> /tmp/fleet-setup.sh
 *       RUN sh /tmp/fleet-setup.sh && touch "$HOME/<marker>"
 *     The marker rides the same layer as the script run (#49): the runner
 *     executes setup.script itself before the pickup gate unless this file
 *     exists (src/runner/setup.ts). `$HOME`, never /etc — the runner checks
 *     the marker before the privilege drop (#196), so bake-time and
 *     check-time $HOME agree on every substrate, including the process
 *     provider where /etc was never writable. Baked setup runs as root, the
 *     same trust the runtime pass gets.
 *   - `setup.devcontainer` set → comment only; builds as a plain runner-base alias.
 */
export function jobImageDockerfile(baseTag: string, manifest: ImageManifest): string { // contract pin: test-only export, asserted by the suite
  const setup = manifest.setup ?? {};
  const lines: string[] = [`FROM ${baseTag}`];

  if (setup.script) {
    // Copy the script into the build so it runs during image creation, not at
    // runtime — this is the per-repo dependency install layer.
    lines.push(`COPY ${setup.script} /tmp/fleet-setup.sh`);
    lines.push(`RUN sh /tmp/fleet-setup.sh && touch "$HOME/${SETUP_BAKED_BASENAME}"`);
  } else if (setup.devcontainer) {
    // No devcontainer build yet: emit a marker so the image still builds
    // (a plain runner-base alias). A real build layers @devcontainers/cli output.
    lines.push(`# devcontainer: ${setup.devcontainer} (not built; base alias only)`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Build the per-repo job image.
 *
 * Two paths: `setup.dockerfile` set → use it directly (`-f setup.dockerfile`;
 * the Dockerfile is expected to start FROM the runner base, and owns the baked
 * marker if it runs the repo's setup itself). Otherwise → build from the
 * generated Dockerfile above.
 *
 * Async, with output captured rather than inherited (#121): a build takes
 * minutes, and both callers run on an event loop that must stay live — the
 * cockpit's for the keys it has to keep reading, the plain CLI's so the same
 * one path serves both. Progress reaches the caller through `onOutput`.
 */
export async function buildJobImage(opts: BuildJobImageOptions): Promise<void> {
  const { tag, baseTag, manifest, contextDir = process.cwd(), onOutput, signal } = opts;
  const setup = manifest.setup ?? {};

  if (setup.dockerfile) {
    // Use the repo's own Dockerfile; it controls the full build.
    await runDockerBuild(["build", "-t", tag, "-f", setup.dockerfile, contextDir], onOutput, signal);
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "fleet-image-build-"));
  try {
    const dockerfilePath = join(tmpDir, "Dockerfile.fleet-job");
    writeFileSync(dockerfilePath, jobImageDockerfile(baseTag, manifest));
    await runDockerBuild(["build", "-t", tag, "-f", dockerfilePath, contextDir], onOutput, signal);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------- ECR push ----------

type PushToEcrOptions = {
  /** Local image tag to push. */
  localTag: string;
  /** ECR registry URI, e.g. "123456789012.dkr.ecr.us-east-1.amazonaws.com". */
  registryUri: string;
  /** AWS region. Defaults to AWS_REGION env, then "us-east-1". */
  region?: string;
};

/**
 * Authenticate to ECR and push the image.
 *
 * AWS credentials must be in the environment (AWS_ACCESS_KEY_ID +
 * AWS_SECRET_ACCESS_KEY, or an IAM role attached to the running instance).
 * A live exercise against real ECR belongs to issue #9.
 */
export function pushToEcr(opts: PushToEcrOptions): string {
  const region = opts.region ?? process.env.AWS_REGION ?? "us-east-1";
  const accountId = opts.registryUri.split(".")[0];
  const ecrHost = `${accountId}.dkr.ecr.${region}.amazonaws.com`;

  const loginResult = spawnSync("aws", ["ecr", "get-login-password", "--region", region], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (loginResult.status !== 0) {
    throw new Error(`ECR get-login-password failed: ${loginResult.stderr ?? loginResult.error}`);
  }

  execFileSync("docker", ["login", "--username", "AWS", "--password-stdin", ecrHost], {
    input: loginResult.stdout,
    stdio: ["pipe", "inherit", "inherit"],
  });

  const remoteTag = `${opts.registryUri}/${opts.localTag}`;
  execFileSync("docker", ["tag", opts.localTag, remoteTag], { stdio: "inherit" });
  execFileSync("docker", ["push", remoteTag], { stdio: "inherit" });
  return remoteTag;
}
