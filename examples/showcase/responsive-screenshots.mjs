// Screenshot one page at phone, tablet and desktop sizes, one browser per
// size (the phone at 2x pixel density), then put the three side by side in
// one image.
//
//   node examples/showcase/responsive-screenshots.mjs [url]
//
// Writes examples/showcase/out/responsive-<size>.png and
// docs/media/showcase/responsive-screenshots.png. Needs ffmpeg on PATH.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, mediaDir, sleep } from './lib/showcase.mjs';

const URL = process.argv[2] ?? 'https://books.toscrape.com/';
const SIZES = [
  { name: 'phone', width: 390, height: 844, deviceScaleFactor: 2 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'desktop', width: 1440, height: 900 },
];
const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(outDir, { recursive: true });

async function shoot(size) {
  const { name, ...viewport } = size;
  const b = await launch({ viewport });
  try {
    await b.navigate(URL);
    await b.waitFor('body');
    const measured = await b.evaluate(() => `${innerWidth}x${innerHeight} @${devicePixelRatio}x`);
    await sleep(800); // let images finish painting
    const shot = await b.screenshot({ format: 'png' });
    const file = join(outDir, `responsive-${name}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return { ...size, file, measured };
  } finally {
    await b.release();
  }
}

const started = Date.now();
const shots = [];
for (const size of SIZES) shots.push(await shoot(size));

// Side by side on a dark background, all scaled to one height, with a
// label under each.
const H = 560;
const font = process.platform === 'win32' ? 'C\\:/Windows/Fonts/segoeui.ttf' : 'DejaVuSans';
const parts = shots.map(
  (s, i) =>
    `[${i}:v]scale=-2:${H},pad=iw+48:${H + 92}:24:24:0x0d1117,` +
    `drawtext=fontfile='${font}':text='${s.name} ${s.width}x${s.height}${s.deviceScaleFactor ? ` at ${s.deviceScaleFactor}x` : ''}':fontcolor=0xe6edf3:fontsize=24:x=(w-tw)/2:y=${H + 44}[p${i}]`,
);
const filter = `${parts.join(';')};${shots.map((_, i) => `[p${i}]`).join('')}hstack=inputs=${shots.length},pad=iw+48:ih:24:0:0x0d1117`;
mkdirSync(mediaDir, { recursive: true });
const composite = join(mediaDir, 'responsive-screenshots.png');
execFileSync('ffmpeg', [
  '-y',
  '-loglevel',
  'error',
  ...shots.flatMap((s) => ['-i', s.file]),
  '-filter_complex',
  filter,
  composite,
]);

console.log(`${URL} at ${shots.length} sizes in ${Math.round((Date.now() - started) / 1000)}s`);
for (const s of shots) {
  console.log(`  ${s.name.padEnd(8)} asked ${s.width}x${s.height}, page measured ${s.measured}`);
}
console.log('  composite: docs/media/showcase/responsive-screenshots.png');
