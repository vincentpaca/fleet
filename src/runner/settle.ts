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
import { toMinutes } from '../shared/time.ts';
import type { EventBody } from './events.ts';

type SettleComposition = {
  body: EventBody;
  /**
   * Human-readable problems encountered (e.g. invalid report.json, a workspace
   * retained after a failed push). The caller emits each as a log event.
   */
  notes: string[];
};

type SettleOpts = {
  jobId: string;
  startedAt: number;
  decisions: number;
  workspace: string;
  rung?: string;
  report?: EventBody;
  /** PR URL from authority.publish — merged into report.pr (issue #3). */
  prUrl?: string;
  /**
   * True when work commits landed on the job branch (pushed or delivered by
   * the agent itself). Feeds the empty-handed check (issue #81): a settle with
   * no pushed work, no PR and no artifacts delivered nothing retrievable.
   */
  workPushed?: boolean;
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
  /**
   * Cumulative count of events dropped by the runner's delivery sink
   * (issue #109): exhausted retries or buffer shedding. Any nonzero count
   * becomes a settle note so transcript gaps are visible to the operator.
   */
  droppedEvents?: number;
};

/** Emit notes for retained workspace and dropped events. */
function addPushNotes(opts: SettleOpts, notes: string[]): void {
  if (opts.retainedWorkspace !== undefined) {
    notes.push(
      'workspace retained at ' + opts.retainedWorkspace + ' (work push failed) — ' +
      'retry the push with: fleet resume-push ' + opts.jobId,
    );
  }
  if ((opts.droppedEvents ?? 0) > 0) {
    notes.push(
      opts.droppedEvents + ' event(s) dropped during the run: event delivery ' +
      'failed or the event buffer overflowed — the transcript has gaps',
    );
  }
}

/** Build the initial settle body (without report). */
function buildBaseBody(opts: SettleOpts): EventBody {
  const minutes = toMinutes(Date.now() - opts.startedAt);
  const body: EventBody = {
    type: 'settle',
    minutes,
    outcome: { produced: opts.produced ?? [], findings: 0, decisions: opts.decisions },
  };
  if (opts.rung !== undefined) body.rung = opts.rung;
  return body;
}

/**
 * Read/receive the report, then merge the PR URL when present (issue #3).
 * The runner-derived URL is authoritative over anything the harness wrote.
 */
function resolveReport(opts: SettleOpts, notes: string[]): EventBody | null | undefined {
  const report = opts.report ?? readReportFile(opts.workspace, notes);
  if (!opts.prUrl) return report;
  if (report) return { ...report as Record<string, unknown>, pr: opts.prUrl } as EventBody;
  // No harness report but we have a PR URL — create a minimal report so the
  // URL is preserved in the event log.
  return { status: 'READY', next_action: 'review the draft PR', pr: opts.prUrl } as unknown as EventBody;
}

/**
 * Validate the report block in situ against the events schema.
 * Invalid → omit the report, keep the minimal settle.
 */
function attachReport(body: EventBody, jobId: string, report: EventBody | null | undefined, notes: string[]): void {
  if (!report) return;
  const candidate = { job: jobId, seq: 0, ...body, report };
  const { ok, errors } = validateEvent(candidate);
  if (ok) {
    body.report = report;
    return;
  }
  const first = Array.isArray(errors) && errors[0]
    ? ((errors[0].instancePath ?? '') + ' ' + (errors[0].message ?? '')).trim()
    : 'schema validation failed';
  notes.push('report omitted from settle (invalid): ' + first);
}

/**
 * Empty-handed settle (issue #81): nothing pushed, no PR, zero artifacts.
 * Appending a string to not_done cannot invalidate an already-valid report.
 */
function addEmptyHandedNote(opts: SettleOpts, body: EventBody, notes: string[]): void {
  if (opts.workPushed === true || opts.prUrl || (opts.produced ?? []).length > 0) return;
  const note =
    'no deliverable landed: no pushed commits, no PR, no artifacts — ' +
    'the answer exists only in the transcript (fleet logs ' + opts.jobId + ')';
  notes.push(note);
  if (body.report !== undefined) {
    const rep = body.report as Record<string, unknown>;
    const notDone = Array.isArray(rep.not_done) ? rep.not_done as unknown[] : [];
    body.report = { ...rep, not_done: [...notDone, note] } as EventBody;
  }
}

export function composeSettle(opts: SettleOpts): SettleComposition {
  const notes: string[] = [];
  addPushNotes(opts, notes);
  const body = buildBaseBody(opts);
  const report = resolveReport(opts, notes);
  attachReport(body, opts.jobId, report, notes);
  addEmptyHandedNote(opts, body, notes);
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
