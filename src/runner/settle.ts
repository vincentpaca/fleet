/**
 * Settle composition: minutes from wall time, minimal outcome
 * {produced: [], findings: 0, decisions: <count>}, plus the harness's
 * .fleet/out/report.json when present AND valid against the events schema's
 * report definition. An invalid or unreadable report is omitted, never
 * coerced; the caller emits the returned notes as log events.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-ignore -- plain-JS module, no type declarations
import { validateEvent } from '../validate.mjs';
import type { EventBody } from './events.ts';

export type SettleComposition = {
  body: EventBody;
  /** Human-readable problems encountered (e.g. invalid report.json). */
  notes: string[];
};

export function composeSettle(opts: {
  jobId: string;
  startedAt: number;
  decisions: number;
  workspace: string;
  rung?: string;
  report?: EventBody;
  /** PR URL from authority.publish — merged into report.pr (issue #3). */
  prUrl?: string;
}): SettleComposition {
  const notes: string[] = [];
  const minutes = Math.max(
    0,
    Math.round(((Date.now() - opts.startedAt) / 60000) * 100) / 100,
  );
  const body: EventBody = {
    type: 'settle',
    minutes,
    outcome: { produced: [], findings: 0, decisions: opts.decisions },
  };
  if (opts.rung !== undefined) body.rung = opts.rung;

  let report = opts.report ?? readReportFile(opts.workspace, notes);
  // Merge the PR URL into the report when the runner opened a PR (issue #3).
  // The runner-derived URL is authoritative over anything the harness wrote.
  if (opts.prUrl && report !== null && report !== undefined) {
    report = { ...report as Record<string, unknown>, pr: opts.prUrl } as EventBody;
  } else if (opts.prUrl) {
    // No harness report but we have a PR URL — create a minimal report so the
    // URL is preserved in the event log.
    report = { status: 'READY', next_action: 'review the draft PR', pr: opts.prUrl } as unknown as EventBody;
  }
  if (report !== null && report !== undefined) {
    // Validate the report block in situ: build the candidate settle event and
    // run it through the events schema. Invalid → omit the report, keep the
    // minimal settle.
    const candidate = { job: opts.jobId, seq: 0, ...body, report };
    const { ok, errors } = validateEvent(candidate);
    if (ok) {
      body.report = report;
    } else {
      const first = Array.isArray(errors) && errors[0]
        ? `${errors[0].instancePath ?? ''} ${errors[0].message ?? ''}`.trim()
        : 'schema validation failed';
      notes.push(`report omitted from settle (invalid): ${first}`);
    }
  }
  return { body, notes };
}

function readReportFile(workspace: string, notes: string[]): EventBody | null {
  const path = join(workspace, '.fleet', 'out', 'report.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as EventBody;
    }
    notes.push('report omitted from settle (invalid): report.json is not an object');
  } catch {
    notes.push('report omitted from settle (invalid): report.json is not valid JSON');
  }
  return null;
}
