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
  /**
   * Human-readable problems encountered (e.g. invalid report.json, a workspace
   * retained after a failed push). The caller emits each as a log event.
   */
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
  /**
   * Pre-collected artifact produced[] entries (issue #18). Populated by
   * collectArtifacts() in main.ts before composeSettle is called; the
   * daemon has already received the artifact files by this point.
   */
  produced?: Array<Record<string, unknown>>;
  /**
   * Workspace kept because the work push failed (issue #38). Its path is the
   * only address the work has until the late push succeeds, so it rides out as
   * a settle note — and therefore into the event log.
   */
  retainedWorkspace?: string;
}): SettleComposition {
  const notes: string[] = [];
  if (opts.retainedWorkspace !== undefined) {
    notes.push(
      `workspace retained at ${opts.retainedWorkspace} (work push failed) — ` +
      `retry the push with: fleet resume-push ${opts.jobId}`,
    );
  }
  const minutes = Math.max(
    0,
    Math.round(((Date.now() - opts.startedAt) / 60000) * 100) / 100,
  );
  const body: EventBody = {
    type: 'settle',
    minutes,
    outcome: { produced: opts.produced ?? [], findings: 0, decisions: opts.decisions },
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
