/**
 * Bake the paper-airplane art the CLI draws (#225).
 *
 * One airplane, one generator. `fixtures/dart.png` is the vendored source — a
 * trimmed, downscaled copy of the site's own dart, produced once by hand with
 * ImageMagick:
 *
 *   magick <site>/public/img/dart.png -trim +repage -resize 360x -strip PNG8:fixtures/dart.png
 *
 * chafa reduces it to half blocks and this writes the result into
 * `src/cli/banner-art.ts`, which is the only art the CLI ships. Committing the
 * generator alongside its output is the point: art whose generator is lost can
 * never be regenerated, and `test/cli-banner-art.test.ts` re-runs chafa on
 * every suite to prove the two still agree.
 *
 * Regenerate by hand:  node fixtures/bake-banner-art.ts
 *
 * BUILD side: chafa is a dev-time tool like lizard and terraform, never invoked
 * at runtime and never shipped (`test/packaging.test.ts` owns that boundary).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { visualLength } from '../src/cli/ansi.ts';

/** The vendored source and the module the art is baked into. */
export const SOURCE_PNG = fileURLToPath(new URL('./dart.png', import.meta.url));
export const ART_MODULE = fileURLToPath(new URL('../src/cli/banner-art.ts', import.meta.url));

/**
 * One baked size: the chafa bounding box, the constant it becomes, and why that
 * size. chafa fits the image inside the box at its own aspect ratio, so the box
 * is a ceiling and the emitted `cols`/`rows` are what actually came out.
 */
export type ArtSize = { constant: string; box: string; doc: string[] };

export const SIZES: ArtSize[] = [
  {
    constant: 'DART_COMPACT',
    box: '36x10',
    doc: [
      'The dart, banner size: the cockpit header and `fleet --help`. 30x6 was tried',
      'first, to keep the banner close to the hand-drawn plane\'s four rows, and it',
      'is not a paper airplane at that scale — the fold and the wing edge both go.',
      'The plane decides the size; the cockpit suppresses the whole banner on short',
      'windows instead (BANNER_MIN_ROWS).',
    ],
  },
  {
    constant: 'DART_HERO',
    box: '44x12',
    doc: [
      'The dart, hero-sized: onboarding\'s centred first contact (#217). The tail',
      'fold survives at this size, which is why a second size exists at all.',
    ],
  },
];

/**
 * The three colour forms `renderBanner(width, noColor, level)` already asks for.
 *
 * Half blocks only — sextants, octants and braille render as tofu in macOS
 * terminal fonts, which was measured rather than assumed. There is no plain
 * form: the dart is half blocks paired against a background colour, so with
 * the colour stripped it reads as a blob, and board.ts shows the wordmark
 * alone instead (#225).
 *
 * `--polite=on --relative=off` on every form: chafa's default output hides the
 * cursor and positions relative to it. Baked verbatim into a string the CLI
 * prints, that would leave the operator with no cursor.
 */
export type ArtForm = { key: 'truecolor' | 'c256'; args: string[] };

export const FORMS: ArtForm[] = [
  { key: 'truecolor', args: ['--symbols=half', '-c', 'full'] },
  { key: 'c256', args: ['--symbols=half', '-c', '256'] },
];

const COMMON = ['-f', 'symbols', '--polite=on', '--relative=off'];

/** Is chafa on PATH? Callers skip rather than fail when it is not. */
export function chafaAvailable(): boolean {
  const probe = spawnSync('chafa', ['--version'], { encoding: 'utf8' });
  return probe.status === 0 && (probe.stdout ?? '').includes('Chafa version');
}

/**
 * Render one size in one form: chafa's own bytes, split into rows and padded to
 * a common width so a caller can append a wordmark to any row and have it line
 * up. Throws rather than returning a half-baked plane — a generator that
 * silently emits nothing is how empty art gets committed.
 */
export function renderForm(size: ArtSize, form: ArtForm): string[] {
  const run = spawnSync('chafa', [...COMMON, ...form.args, `--size=${size.box}`, SOURCE_PNG], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (run.status !== 0) {
    throw new Error(`chafa failed for ${size.constant}/${form.key}: ${run.stderr || run.status}`);
  }
  const rows = run.stdout.replace(/\n$/, '').split('\n');
  const cols = Math.max(...rows.map(visualLength));
  if (rows.length === 0 || cols === 0) {
    throw new Error(`chafa produced no art for ${size.constant}/${form.key}`);
  }
  return rows.map((row) => row + ' '.repeat(cols - visualLength(row)));
}

/** One size, all three forms, with the dimensions they agree on. */
export function renderSize(size: ArtSize): { cols: number; rows: number; forms: Map<string, string[]> } {
  const forms = new Map<string, string[]>();
  for (const form of FORMS) forms.set(form.key, renderForm(size, form));
  const first = forms.get(FORMS[0].key)!;
  const cols = visualLength(first[0]);
  for (const [key, rows] of forms) {
    // Every form must be the same grid: the CLI swaps one for another by colour
    // level, and a form of a different size would move the wordmark with it.
    if (rows.length !== first.length || rows.some((row) => visualLength(row) !== cols)) {
      throw new Error(`${size.constant}/${key} is not ${cols}x${first.length}`);
    }
  }
  return { cols, rows: first.length, forms };
}

const HEADER = `// The paper airplane, baked. GENERATED — do not edit by hand.
//
// Source: fixtures/dart.png (a trimmed, downscaled copy of the site's own dart).
// Generator: fixtures/bake-banner-art.ts — \`node fixtures/bake-banner-art.ts\`.
// test/cli-banner-art.test.ts re-runs chafa and fails if these strings drift
// from the source, so the art cannot quietly stop being the airplane.
//
// Half blocks only, and no cursor-hiding or relative-positioning sequences:
// these strings are printed verbatim by a CLI that must leave the terminal as
// it found it. There is no plain form — colour here adds
// depth to a shape that already reads without it.

/** One size of the art, in the three forms \`renderBanner\` selects between. */
export type BannerArt = {
  cols: number;
  rows: number;
  truecolor: string[];
  c256: string[];
};
`;

/** The generated module's text, for writing or for comparing against what is committed. */
export function bakeArtModule(): string {
  const blocks = SIZES.map((size) => {
    const { cols, rows, forms } = renderSize(size);
    const body = FORMS.map((form) => {
      const lines = forms.get(form.key)!.map((row) => `    ${JSON.stringify(row)},`).join('\n');
      return `  ${form.key}: [\n${lines}\n  ],`;
    }).join('\n');
    const marker = size.constant === 'DART_HERO'
      ? ' // contract pin: the hero size is #217\'s to consume; asserted by the suite'
      : '';
    const doc = ['/**', ...size.doc.map((line) => ` * ${line}`), ` * chafa --size=${size.box} → ${cols}x${rows}.`, ' */'];
    return `${doc.join('\n')}\n`
      + `export const ${size.constant}: BannerArt = {${marker}\n`
      + `  cols: ${cols},\n  rows: ${rows},\n${body}\n};\n`;
  });
  return [HEADER, ...blocks].join('\n');
}

function main(): void {
  if (!chafaAvailable()) {
    console.error('chafa is not installed — `brew install chafa` (or your package manager).');
    process.exitCode = 1;
    return;
  }
  writeFileSync(ART_MODULE, bakeArtModule());
  console.log(`baked ${SIZES.map((s) => s.constant).join(', ')} → src/cli/banner-art.ts`);
}

// Executable fixture: importers get the functions, `node fixtures/bake-banner-art.ts` bakes.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
