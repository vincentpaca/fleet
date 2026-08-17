/**
 * Artifact delivery (issue #18): collect files from .fleet/out/artifacts/,
 * upload each to the daemon's artifact endpoint, and return produced[] entries
 * for the settle event.
 *
 * Size caps:
 *   PER_FILE_CAP: 10 MB per artifact file
 *   TOTAL_CAP:   100 MB total across all artifacts in one job
 *
 * Over-cap files produce a loud note; the settle still completes and other
 * artifacts are delivered. The job never fails solely due to an over-cap file.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ARTIFACT_PER_FILE_CAP, ARTIFACT_TOTAL_CAP } from '../shared/home.ts';

export { ARTIFACT_PER_FILE_CAP, ARTIFACT_TOTAL_CAP };

export type ProducedEntry = {
  id: string;
  type: 'file';
  title: string;
  path: string;
  sha256: string;
  bytes: number;
};

export type ArtifactResult = {
  produced: ProducedEntry[];
  notes: string[];
};

/** Recursive directory walk; yields absolute file paths. */
function* walkDir(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkDir(full);
    else if (entry.isFile()) yield full;
  }
}

/**
 * Walk .fleet/out/artifacts/, upload each file to the daemon, and return
 * produced[] entries for the settle event. Files that exceed a cap are skipped
 * with a loud note; files that fail to upload are also noted and skipped.
 */
export async function collectArtifacts(opts: {
  workspace: string;
  jobId: string;
  daemonUrl: string;
  token: string;
}): Promise<ArtifactResult> {
  const artifactsDir = join(opts.workspace, '.fleet', 'out', 'artifacts');
  if (!existsSync(artifactsDir)) return { produced: [], notes: [] };

  const allFiles = [...walkDir(artifactsDir)];
  if (allFiles.length === 0) return { produced: [], notes: [] };

  const notes: string[] = [];
  const produced: ProducedEntry[] = [];
  let totalBytes = 0;

  const baseUrl = opts.daemonUrl.replace(/\/$/, '');
  const url = `${baseUrl}/internal/jobs/${encodeURIComponent(opts.jobId)}/artifacts`;

  for (const fullPath of allFiles) {
    const relPath = relative(artifactsDir, fullPath).replace(/\\/g, '/');
    const bytes = statSync(fullPath).size;

    if (bytes > ARTIFACT_PER_FILE_CAP) {
      notes.push(
        `artifact skipped (exceeds ${ARTIFACT_PER_FILE_CAP / 1024 / 1024} MB per-file cap): ${relPath}`,
      );
      continue;
    }
    if (totalBytes + bytes > ARTIFACT_TOTAL_CAP) {
      notes.push(
        `artifact skipped (total cap of ${ARTIFACT_TOTAL_CAP / 1024 / 1024} MB reached): ${relPath}`,
      );
      continue;
    }

    const content = readFileSync(fullPath);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const body = JSON.stringify({
      path: relPath,
      content: content.toString('base64'),
      sha256,
      bytes,
    });

    let ok = false;
    let errorMsg = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-fleet-runner-token': opts.token,
          },
          body,
        });
        if (response.ok) { ok = true; break; }
        const detail = await response.text().catch(() => '');
        errorMsg = `HTTP ${response.status}: ${detail.slice(0, 200)}`;
      } catch (err) {
        errorMsg = String(err instanceof Error ? err.message : err);
      }
    }

    if (!ok) {
      notes.push(`artifact upload failed (${relPath}): ${errorMsg}`);
      continue;
    }

    totalBytes += bytes;
    produced.push({
      id: relPath,
      type: 'file',
      title: relPath,
      path: relPath,
      sha256,
      bytes,
    });
  }

  return { produced, notes };
}
