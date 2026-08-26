/**
 * Lossless converter between the Operating Plane demo's run-history records
 * (harness-x-operating-plane/data/history.json) and the Fleet event stream.
 *
 * Exit check for that claim: if every demo run round-trips through the
 * event schema with nothing lost, the demo's registry can consume the real
 * stream with no translation layer beyond deserialisation.
 */

/** history record -> ordered event list */
export function historyToEvents(run) {
  let seq = 0;
  const ev = (type, payload) => ({ job: run.id, seq: seq++, type, ...payload });
  return [
    ev('state', {
      state: 'queued',
      at: run.at,
      meta: {
        kind: run.kind,
        label: run.label,
        target: run.target,
        where: run.where,
        fleet: run.fleet,
      },
    }),
    ev('state', { state: 'running' }),
    ev('settle', { minutes: run.minutes, outcome: run.outcome }),
    ev('state', { state: run.state }),
  ];
}

/** ordered event list -> history record (inverse of historyToEvents) */
export function eventsToHistory(events) {
  const queued = events.find((e) => e.type === 'state' && e.state === 'queued');
  const settle = events.find((e) => e.type === 'settle');
  const terminal = events.findLast((e) => e.type === 'state' && ['done', 'cancelled'].includes(e.state));
  if (!queued?.meta) throw new Error('missing queued state event with job meta');
  if (!settle) throw new Error('missing settle event');
  if (!terminal) throw new Error('missing terminal state event');
  return {
    id: queued.job,
    kind: queued.meta.kind,
    label: queued.meta.label,
    target: queued.meta.target,
    where: queued.meta.where,
    state: terminal.state,
    at: queued.at,
    minutes: settle.minutes,
    fleet: queued.meta.fleet,
    outcome: settle.outcome,
  };
}
