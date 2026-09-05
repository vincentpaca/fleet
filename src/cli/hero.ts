/**
 * First contact, full screen (#217): `fleet setup repo` on a fresh repo takes
 * the whole terminal — the paper dart bobbing softly in the centre, the
 * wordmark under it, what setup detected under that, and the one question at
 * the bottom. The alternate screen buffer, entered and restored the way the
 * cockpit does it, so the operator's scrollback is exactly as they left it.
 *
 * The bob is the site's own motion (fleet-web tether.ts: one sine, "gently"),
 * translated to terminal resolution: rows are the only vertical unit, so the
 * dart moves between three positions — up one, centre, down one — sampling the
 * same 6.2s sine. The sine's flat peaks make it dwell at the extremes and pass
 * quickly through the middle, which is what reads as hovering rather than
 * blinking.
 *
 * Everything here writes to the stream directly, never through the setup log:
 * the screen is presentation, the log is the transcript, and the transcript is
 * written after the screen is gone so it survives in real scrollback.
 */
import { DART_HERO } from './banner-art.ts';
import { ENTER_ALT, RESTORE_SEQ, TAGLINE_STYLED, WORDMARK_STYLED, detectColorLevel } from './board.ts';
import { visualLength } from './ansi.ts';

/** One full rise and fall, in ms — fleet-web's own period. */
const BOB_PERIOD_MS = 6200;
/** How often the sine is sampled. Redraws happen only when the row changes. */
const BOB_TICK_MS = 100;
/** Blank rows above and below the dart that the bob moves through. */
const WINDOW_PAD = 1;
/** What `confirm()` appends to a defaultYes question — reserved for width. */
const CONFIRM_SUFFIX = ' [Y/n]: ';

/** The dart's row at time t: -1 (up), 0 (centre) or 1 (down). */
export function bobRow(tMs: number): number { // contract pin: test-only export, asserted by the suite
  return Math.round(Math.sin((tMs / BOB_PERIOD_MS) * 2 * Math.PI));
}

type BodyLine = { text: string; centered?: boolean };

export type HeroLayout = { // contract pin: test-only export, asserted by the suite
  /** 1-based terminal row of the bob window's first row. */
  windowTop: number;
  /** 1-based column the art rows start at. */
  dartLeft: number;
  /** Everything below the dart, placed. */
  body: Array<{ row: number; col: number; text: string }>;
  promptRow: number;
  promptCol: number;
};

/**
 * Centre the whole composition, or say it does not fit.
 *
 * One block: the dart's bob window, the body lines, the prompt row. The block
 * is centred as a unit — the summary keeps its own left edge so its columns
 * stay aligned, and only the wordmark lines centre individually under the
 * dart. Undefined on a terminal too small for it; the caller falls back to the
 * static banner, which fits anywhere.
 */
export function heroLayout(opts: { // contract pin: test-only export, asserted by the suite
  cols: number;
  rows: number;
  artCols: number;
  artRows: number;
  bodyLines: BodyLine[];
  promptText: string;
}): HeroLayout | undefined {
  const promptWidth = visualLength(opts.promptText) + CONFIRM_SUFFIX.length;
  const blockW = Math.max(opts.artCols, promptWidth, ...opts.bodyLines.map((line) => visualLength(line.text)));
  const windowRows = opts.artRows + 2 * WINDOW_PAD;
  const total = windowRows + opts.bodyLines.length + 1;
  if (opts.cols < blockW + 2 || opts.rows < total + 2) return undefined;
  const left = Math.floor((opts.cols - blockW) / 2) + 1;
  const windowTop = Math.floor((opts.rows - total) / 2) + 1;
  const body = opts.bodyLines.map((line, i) => ({
    row: windowTop + windowRows + i,
    col: line.centered ? left + Math.floor((blockW - visualLength(line.text)) / 2) : left,
    text: line.text,
  }));
  return {
    windowTop,
    dartLeft: left + Math.floor((blockW - opts.artCols) / 2),
    body,
    promptRow: windowTop + windowRows + opts.bodyLines.length,
    promptCol: left,
  };
}

/** Redraw the bob window with the dart at `offset` rows from centre. */
function drawWindow(out: NodeJS.WriteStream, layout: HeroLayout, art: string[], offset: number): void {
  let buf = '\x1b7'; // save cursor: this may fire while the operator is typing
  for (let i = 0; i < art.length + 2 * WINDOW_PAD; i++) {
    const row = layout.windowTop + i;
    const line = art[i - WINDOW_PAD - offset];
    buf += `\x1b[${row};1H\x1b[2K`;
    if (line !== undefined) buf += `\x1b[${row};${layout.dartLeft}H${line}`;
  }
  out.write(buf + '\x1b8');
}

/** Paint the whole screen once: dart at centre, body, cursor parked at the prompt. */
function drawScreen(out: NodeJS.WriteStream, layout: HeroLayout, art: string[]): void {
  out.write(ENTER_ALT + '\x1b[2J\x1b[H');
  drawWindow(out, layout, art, 0);
  let buf = '';
  for (const line of layout.body) buf += `\x1b[${line.row};${line.col}H${line.text}`;
  buf += `\x1b[${layout.promptRow};${layout.promptCol}H\x1b[?25h`;
  out.write(buf);
}

/**
 * Offer the detected plan on the hero screen, and return the operator's answer.
 *
 * Undefined means the screen never ran — not a terminal a human is watching
 * (a pipe, NO_COLOR, CI: the same gate the static banner honours, pinned by
 * `the banner animation never reaches anything but a terminal`), or a terminal
 * too small for the composition. The caller falls back to the plain flow.
 *
 * The dart keeps bobbing while the operator reads and answers: the redraw
 * saves and restores the cursor around itself, so typing at the prompt is
 * undisturbed. Ctrl-C restores the terminal before exiting — a stuck alternate
 * screen is the one way this could leave a mark.
 */
export async function offerOnHeroScreen(opts: {
  out: NodeJS.WriteStream;
  env: Record<string, string | undefined>;
  /** Where setup is running, already shortened for humans. */
  place: string;
  /** `planSummary` rows, indentation included. */
  summary: string[];
  question: string;
  confirm: (question: string) => Promise<boolean>;
}): Promise<boolean | undefined> {
  const { out, env } = opts;
  if (out.isTTY !== true || 'NO_COLOR' in env || env.CI !== undefined) return undefined;
  const art = detectColorLevel(env) === '24bit' ? DART_HERO.truecolor : DART_HERO.c256;
  const bodyLines: BodyLine[] = [
    { text: '' },
    { text: WORDMARK_STYLED, centered: true },
    { text: TAGLINE_STYLED, centered: true },
    { text: '' },
    { text: `Setting up ${opts.place}` },
    { text: 'Here is what this repo says about itself:' },
    { text: '' },
    ...opts.summary.map((text) => ({ text })),
    { text: '' },
  ];
  const layout = heroLayout({
    cols: out.columns,
    rows: out.rows,
    artCols: DART_HERO.cols,
    artRows: DART_HERO.rows,
    bodyLines,
    promptText: opts.question,
  });
  if (!layout) return undefined;

  const restore = (): void => out.write(RESTORE_SEQ) as unknown as void;
  const onSigint = (): void => {
    restore();
    process.exit(130);
  };
  process.once('SIGINT', onSigint);
  let shown = 0;
  const start = Date.now();
  const bob = setInterval(() => {
    const offset = bobRow(Date.now() - start);
    if (offset === shown) return;
    shown = offset;
    drawWindow(out, layout, art, offset);
  }, BOB_TICK_MS);
  try {
    drawScreen(out, layout, art);
    return await opts.confirm(opts.question);
  } finally {
    clearInterval(bob);
    process.off('SIGINT', onSigint);
    restore();
  }
}
