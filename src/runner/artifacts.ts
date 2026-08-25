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
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
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
 * Measure and read one artifact file via a single open fd, checking per-file
 * and total caps before pulling the bytes into memory. Returns the Buffer, or
 * null after pushing a note (file is skipped but the job continues).
 *
 * Sizing by statSync(path) and then reading by readFileSync(path) asks the
 * filesystem to resolve the name twice, and what answers the second time need
 * not be what answered the first — the daemon would record a byte count that
 * does not describe the bytes stored beside it.
 */
function readArtifactFile(
  fullPath: string,
  relPath: string,
  totalBytes: number,
  notes: string[],
): Buffer | null {
  const fd = openSync(fullPath, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size > ARTIFACT_PER_FILE_CAP) {
      notes.push('artifact skipped (exceeds ' + ARTIFACT_PER_FILE_CAP / 1024 / 1024 + ' MB per-file cap): ' + relPath);
      return null;
    }
    if (totalBytes + size > ARTIFACT_TOTAL_CAP) {
      notes.push('artifact skipped (total cap of ' + ARTIFACT_TOTAL_CAP / 1024 / 1024 + ' MB reached): ' + relPath);
      return null;
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Upload one artifact payload to the daemon, retrying once on transient
 * failure. Returns null on success, or the last error message on failure.
 * sha256 is pre-computed by the caller so it is not hashed twice.
 */
async function uploadArtifact(url: string, token: string, relPath: string, content: Buffer, sha256: string): Promise<string | null> {
  // Build the payload once; sha256 and bytes come from the buffer so they
  // describe these exact bytes (not what fstat reported before reading).
  const body = JSON.stringify({
    path: relPath,
    content: content.toString('base64'),
    sha256,
    bytes: content.length,
  });
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fleet-runner-token': token },
        body,
      });
      if (response.ok) return null;
      const detail = await response.text().catch(() => '');
      lastError = 'HTTP ' + response.status + ': ' + detail.slice(0, 200);
    } catch (err) {
      lastError = String(err instanceof Error ? err.message : err);
    }
  }
  return lastError;
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
  const url = opts.daemonUrl.replace(/\/$/, '') + '/internal/jobs/' + encodeURIComponent(opts.jobId) + '/artifacts';

  for (const fullPath of allFiles) {
    const relPath = relative(artifactsDir, fullPath).replace(/\\/g, '/');
    const content = readArtifactFile(fullPath, relPath, totalBytes, notes);
    if (!content) continue;
    // Compute sha256 once; passed to uploadArtifact (for the payload) and
    // stored in the produced entry — same hash describes the same bytes.
    // Use content.length, not fstat's size: a file appended to while we read
    // it hands back more bytes than fstat measured.
    const sha256 = createHash('sha256').update(content).digest('hex');
    const bytes = content.length;
    const errorMsg = await uploadArtifact(url, opts.token, relPath, content, sha256);
    if (errorMsg) {
      notes.push('artifact upload failed (' + relPath + '): ' + errorMsg);
      continue;
    }
    totalBytes += bytes;
    produced.push({ id: relPath, type: 'file', title: relPath, path: relPath, sha256, bytes });
  }
  return { produced, notes };
}
