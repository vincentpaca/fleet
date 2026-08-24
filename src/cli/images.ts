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
//     manifest setup (script). Tagged by sha256(baseTag + setupInputs) —
//     rebuilt only when that hash changes; otherwise the existing tag is
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
// Per-repo images are pushed here when --registry is configured (Phase 1: doc +
// path; live exercise against real ECR belongs to #9 once the ECS substrate is up).
// Region precedence differs from that script and predates it: pushToEcr below
// composes the ECR host from a flag/AWS_REGION region, while build.sh reads the
// region out of the repository URL (a login token is region-scoped, so the URL
// is the authority). Reconciling them belongs with the layer-2 ECR push work,
// not here — until then AWS_REGION must match the registry for this path.

import { createHash } from "node:crypto";
import { SETUP_BAKED_BASENAME } from "../shared/setup-marker.ts";
import { execFileSync, spawnSync } from "node:child_process";
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
export function setupHashInputs(
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
 * sha256(baseTag + NUL + setupInputs) — first 16 hex chars (64-bit prefix).
 */
export function computeImageHash(
  manifest: ImageManifest,
  readFile?: (path: string) => string,
): string {
  const base = runnerBaseTag(manifest);
  const inputs = setupHashInputs(manifest, readFile);
  return createHash("sha256")
    .update(base)
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

/** True when the image tag exists in the local Docker daemon. */
export function imageExistsLocally(tag: string): boolean {
  const result = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", tag], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && (result.stdout?.toString().trim().length ?? 0) > 0;
}

// ---------- build ----------

export type BuildJobImageOptions = {
  /** Local tag to assign (e.g. "fleet-job:abc123"). */
  tag: string;
  /** Fleet runner base tag (e.g. "fleet-runner:claude-code-1.2.3"). */
  baseTag: string;
  manifest: ImageManifest;
  /** Build context directory (the repo root). */
  contextDir?: string;
};

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
 *     exists (src/runner/setup.ts). `$HOME`, never /etc — the runner base
 *     drops to USER node before any job-image layer runs.
 *   - `setup.devcontainer` set → comment only (Phase 2); builds as a base alias.
 *   - neither → plain `FROM <runnerBase>` alias (base caching, no extra layers).
 */
export function jobImageDockerfile(baseTag: string, manifest: ImageManifest): string {
  const setup = manifest.setup ?? {};
  const lines: string[] = [`FROM ${baseTag}`];

  if (setup.script) {
    // Copy the script into the build so it runs during image creation, not at
    // runtime — this is the per-repo dependency install layer.
    lines.push(`COPY ${setup.script} /tmp/fleet-setup.sh`);
    lines.push(`RUN sh /tmp/fleet-setup.sh && touch "$HOME/${SETUP_BAKED_BASENAME}"`);
  } else if (setup.devcontainer) {
    // Phase 2: @devcontainers/cli integration. For now, emit a comment so the
    // image still builds successfully (as a plain runner base alias).
    lines.push(`# devcontainer: ${setup.devcontainer} — Phase 2 support`);
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
 */
export function buildJobImage(opts: BuildJobImageOptions): void {
  const { tag, baseTag, manifest, contextDir = process.cwd() } = opts;
  const setup = manifest.setup ?? {};

  if (setup.dockerfile) {
    // Use the repo's own Dockerfile; it controls the full build.
    execFileSync("docker", ["build", "-t", tag, "-f", setup.dockerfile, contextDir], {
      stdio: "inherit",
    });
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "fleet-image-build-"));
  try {
    const dockerfilePath = join(tmpDir, "Dockerfile.fleet-job");
    writeFileSync(dockerfilePath, jobImageDockerfile(baseTag, manifest));
    execFileSync("docker", ["build", "-t", tag, "-f", dockerfilePath, contextDir], {
      stdio: "inherit",
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------- ECR push ----------

export type PushToEcrOptions = {
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
