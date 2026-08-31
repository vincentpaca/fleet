// The baked paper airplane (#225): its shape, its escape hygiene, and whether
// it still matches the source it was generated from.
//
// The art in src/cli/banner-art.ts is chafa's output, committed. That buys a
// plane the hand-rolled rasteriser could never draw and costs the usual price
// of generated code: it can drift from its source and nothing notices. So this
// re-runs the generator and compares — and skips, loudly, when chafa is absent,
// the way test/complexity.test.ts skips without lizard. Same caveat as that
// gate: it is a check you can accidentally not have, which is why AGENTS.md
// names the install alongside the other pre-push tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DART_COMPACT, DART_HERO, type BannerArt } from '../src/cli/banner-art.ts';
import { visualLength } from '../src/cli/ansi.ts';
import { ART_MODULE, SIZES, bakeArtModule, chafaAvailable } from '../fixtures/bake-banner-art.ts';

/** Half blocks, the full block and the blank — and nothing else. */
const HALF_BLOCKS = /^[ ▀▄█▌▐]+$/;

/** Every size the CLI has, by the name its generated constant carries. */
const BAKED: Array<[string, BannerArt]> = [
  ['DART_COMPACT', DART_COMPACT],
  // The hero size has no runtime consumer yet — onboarding (#217) is what
  // consumes it. Asserted here so it cannot rot in the meantime.
  ['DART_HERO', DART_HERO],
];

const FORM_KEYS: Array<keyof Pick<BannerArt, 'truecolor' | 'c256'>> = ['truecolor', 'c256'];

test('every baked size is one grid in all three colour forms', () => {
  for (const [name, art] of BAKED) {
    assert.ok(art.rows >= 4 && art.cols >= 12, `${name} is too small to read as a plane`);
    for (const form of FORM_KEYS) {
      const rows = art[form];
      assert.equal(rows.length, art.rows, `${name}.${form} has ${rows.length} rows, declared ${art.rows}`);
      for (const row of rows) {
        // A form of a different width would move the wordmark with it; the
        // banner composes by appending to a row, so the grid is the contract.
        assert.equal(visualLength(row), art.cols, `${name}.${form} row is not ${art.cols} wide: ${JSON.stringify(row)}`);
      }
    }
  }
});

test('the baked art carries no sequence that outlives the frame', () => {
  // chafa's defaults hide the cursor and position relative to it. Baked
  // verbatim into strings a CLI prints, that leaves the operator with no
  // cursor — and the width helpers in src/cli/ansi.ts only understand
  // SGR (`ESC [ ... m`), so anything else also breaks every clip and pad
  // that draws the banner into a pane.
  for (const [name, art] of BAKED) {
    for (const form of FORM_KEYS) {
      const text = art[form].join('\n');
      assert.doesNotMatch(text, /\x1b\[\?25[lh]/, `${name}.${form} hides or shows the cursor`);
      assert.doesNotMatch(text, /\x1b\[\?1049[hl]/, `${name}.${form} switches the screen buffer`);
      assert.doesNotMatch(text, /\x1b\[[0-9;]*[A-DGHJKfsu]/, `${name}.${form} moves the cursor`);
      for (const esc of text.matchAll(/\x1b(.)([^\x1b]*)/g)) {
        assert.equal(esc[1], '[', `${name}.${form} carries a non-CSI escape`);
        assert.match(esc[2], /^[0-9;]*m/, `${name}.${form} carries a non-SGR sequence: ${JSON.stringify(esc[0])}`);
      }
    }
  }
});

test('the baked art still matches fixtures/dart.png', () => {
  if (!chafaAvailable()) {
    // Absent chafa is a skip, not a failure: a fresh checkout still runs the
    // suite. It does mean this is a check you can accidentally not have — the
    // same bargain the complexity gate strikes with lizard.
    console.error('banner-art regeneration skipped: chafa not installed (brew install chafa)');
    return;
  }
  const committed = readFileSync(ART_MODULE, 'utf8');
  const rebaked = bakeArtModule();
  assert.equal(
    rebaked,
    committed,
    'src/cli/banner-art.ts drifted from its source. Regenerate it: node fixtures/bake-banner-art.ts',
  );
  // A comparison of two empty strings passes; prove the generator produced art.
  for (const size of SIZES) {
    assert.ok(rebaked.includes(`export const ${size.constant}: BannerArt`), `${size.constant} missing from the bake`);
  }
  // The coloured forms are half blocks paired against a background, so the
  // proof of art is a block glyph plus a colour — not the solid █ the deleted
  // plain form used (#225).
  assert.match(rebaked, /[▀▄█▌▐]/, 'the bake carries no half-block art');
  assert.match(rebaked, /38;2;|38;5;/, 'the bake carries no colour');
});
