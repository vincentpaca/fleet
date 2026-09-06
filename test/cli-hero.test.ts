/**
 * The full-screen hero (#247): geometry and gating. The bob and the layout are
 * pure functions, so what is pinned here is the math the screen keeps — the
 * escape-code side is pinned from the outside by cli-setup's "the banner
 * animation never reaches anything but a terminal".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bobRow, heroLayout, offerOnHeroScreen } from '../src/cli/hero.ts';

test('the bob is the website sine at terminal resolution: three rows, dwell at the extremes', () => {
  assert.equal(bobRow(0), 0, 'starts at centre');
  assert.equal(bobRow(1550), 1, 'quarter period is the far edge');
  assert.equal(bobRow(3100), 0, 'half period is back through centre');
  assert.equal(bobRow(4650), -1, 'three quarters is the other edge');
  assert.ok(bobRow(6200) === 0, 'one full period returns home'); // === so the sine's -0 counts as home
  // The sine's flat peak is the dwell: a third of each half-period sits at the
  // extreme, which is what reads as hovering rather than blinking.
  assert.equal(bobRow(1100), 1);
  assert.equal(bobRow(2000), 1);
  for (let t = 0; t <= 12400; t += 50) {
    assert.ok(Math.abs(bobRow(t)) <= 1, `the dart left its window at t=${t}`);
  }
});

test('the hero layout centres the block and says when it cannot', () => {
  const opts = {
    cols: 80,
    rows: 30,
    artCols: 30,
    artRows: 10,
    bodyLines: [{ text: 'x'.repeat(40) }, { text: 'mark', centered: true }],
    promptText: 'use this?',
  };
  const layout = heroLayout(opts);
  assert.ok(layout, 'an 80x30 terminal fits this composition');
  // Block width is the widest member (the 40-char body line), centred on 80 cols.
  assert.equal(layout.windowTop, 8, 'bob window + body + prompt centre vertically');
  assert.equal(layout.dartLeft, 26, 'the art centres inside the block');
  assert.deepEqual(layout.body[0], { row: 20, col: 21, text: 'x'.repeat(40) }, 'plain lines keep the block left edge');
  assert.deepEqual(layout.body[1], { row: 21, col: 39, text: 'mark' }, 'centered lines centre inside the block');
  assert.equal(layout.promptRow, 22, 'the prompt is the last row of the block');
  assert.equal(layout.promptCol, 21);

  assert.equal(heroLayout({ ...opts, rows: 16 }), undefined, 'too short is a no, not a squeeze');
  assert.equal(heroLayout({ ...opts, cols: 41 }), undefined, 'too narrow is a no, not a wrap');

  // Styled text must count visually or every centred line drifts left. With
  // the wide line gone the block is the art's 30 columns: left lands on 26,
  // and "mark" centres 13 columns further in.
  const styled = heroLayout({ ...opts, bodyLines: [{ text: '\x1b[1mmark\x1b[0m', centered: true }] });
  assert.ok(styled);
  assert.equal(styled.body[0].col, 26 + 13, 'ANSI codes take no columns');
});

test('the follow-up runs on the screen: its two rows are real, and restore waits for it', async () => {
  let buf = '';
  const tty = {
    isTTY: true,
    columns: 120,
    rows: 40,
    write: (s: string) => ((buf += s), true),
  } as unknown as NodeJS.WriteStream;
  const order: string[] = [];
  const took = await offerOnHeroScreen({
    out: tty,
    env: {},
    place: '~/repo',
    summary: ['  jobs run in   node:24'],
    question: '  use this?',
    confirm: async () => (order.push('confirm'), false),
    followUp: async (stage, accepted) => {
      order.push(`followUp accepted=${accepted}`);
      stage.note('  one of: a, b');
      stage.note('  a hint that\n  spans two lines');
      stage.clearPrompt();
    },
  });
  assert.equal(took, false, 'the answer is still what confirm said');
  assert.deepEqual(order, ['confirm', 'followUp accepted=false'], 'the follow-up runs after the answer');

  // The stage's rows are anchored to the layout: the note sits one row above
  // the prompt at the prompt's column, and clearPrompt parks the cursor back
  // on the prompt row. Drift here scatters the interview across the art.
  const park = buf.match(/\x1b\[(\d+);(\d+)H\x1b\[\?25h/);
  assert.ok(park, 'drawScreen parked the cursor at the prompt');
  const promptRow = Number(park[1]);
  const note = buf.match(/\x1b\[(\d+);1H\x1b\[2K\x1b\[(\d+);(\d+)Hone of: a, b/);
  assert.ok(note, 'the note landed, indent trimmed');
  assert.equal(Number(note[1]), promptRow - 1, 'the note row is just above the prompt');
  assert.equal(note[3], park[2], 'the note keeps the prompt column');
  assert.ok(buf.includes(`\x1b[${promptRow};1H\x1b[2K\x1b[${promptRow};${park[2]}H`), 'clearPrompt re-parks at the prompt');
  // A multi-line hint stays inside its one row: a raw newline written on the
  // note row would walk the cursor onto the prompt row.
  assert.ok(buf.includes('a hint that spans two lines'), 'the note flattened the newline');
  assert.ok(!buf.includes('a hint that\n'), 'no raw newline reached the screen');
  const restore = buf.lastIndexOf('\x1b[?1049l');
  assert.ok(restore > buf.indexOf('one of: a, b'), 'the screen outlives the interview');
});

test('the hero screen refuses everything that is not a human terminal', async () => {
  // A stream that throws on write: the gate must answer before any escape code
  // moves, or a pipe (or a CI log) gets the alternate screen.
  const untouchable = {
    isTTY: false,
    columns: 120,
    rows: 40,
    write: () => {
      throw new Error('wrote to a non-terminal');
    },
  } as unknown as NodeJS.WriteStream;
  const base = { out: untouchable, env: {}, place: 'here', summary: [], question: 'use this?', confirm: async () => true };

  assert.equal(await offerOnHeroScreen(base), undefined, 'a pipe never sees the screen');

  const tty = { ...untouchable, isTTY: true } as unknown as NodeJS.WriteStream;
  assert.equal(await offerOnHeroScreen({ ...base, out: tty, env: { CI: 'true' } }), undefined, 'CI never sees the screen');
  assert.equal(await offerOnHeroScreen({ ...base, out: tty, env: { NO_COLOR: '1' } }), undefined, 'NO_COLOR opted out');

  const tiny = { ...untouchable, isTTY: true, columns: 20, rows: 6 } as unknown as NodeJS.WriteStream;
  assert.equal(await offerOnHeroScreen({ ...base, out: tiny }), undefined, 'a terminal too small falls back whole');
});
