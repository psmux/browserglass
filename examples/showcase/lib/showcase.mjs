// Shared helper for the showcase runs: start a browser, show a caption bar
// on the page while the run is recorded, then turn the recording into a GIF
// and a poster frame.
//
// Needs a running gateway started with --recordings-dir, and three env vars:
//   BGLS_ADMIN_TOKEN     from `pnpm bgls token --ttl 900`
//   BGLS_RECORDINGS_DIR  the same folder passed to `bgls serve --recordings-dir`
//   BGLS_URL             optional, default http://127.0.0.1:7799/browserglass
// ffmpeg must be on PATH for the GIF step.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AutomationClient } from '../../../packages/automation/dist/index.mjs';

export { AutomationClient };
export { BrowserSwarm } from '../../../packages/automation/dist/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
export const mediaDir = join(repo, 'docs', 'media', 'showcase');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts one headless browser at a fixed size, holding control. */
export function launch(opts = {}) {
  return AutomationClient.launch({ viewport: { width: 1280, height: 800 }, ...opts });
}

/**
 * Shows (or updates) a caption bar along the bottom of the page. It is
 * drawn into the page itself, so it is part of the recording. Call it again
 * after every navigation, since a new page starts without it.
 */
export async function caption(browser, step, text) {
  await browser.evaluate(
    (s, t) => {
      let bar = document.getElementById('__bg_caption');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = '__bg_caption';
        bar.style.cssText = [
          'position:fixed',
          'left:16px',
          'bottom:16px',
          'z-index:2147483647',
          'display:flex',
          'align-items:center',
          'gap:10px',
          'padding:12px 18px',
          'border-radius:10px',
          'background:rgba(13,17,23,0.92)',
          'color:#f0f6fc',
          'font:500 19px/1.3 system-ui,-apple-system,Segoe UI,sans-serif',
          'box-shadow:0 6px 24px rgba(0,0,0,0.35)',
          'pointer-events:none',
          'max-width:80vw',
        ].join(';');
        document.documentElement.appendChild(bar);
      }
      bar.innerHTML = '';
      if (s) {
        const badge = document.createElement('span');
        badge.textContent = s;
        badge.style.cssText =
          'background:#7c3aed;color:#fff;border-radius:6px;padding:2px 9px;font-size:15px;font-weight:700;letter-spacing:.02em';
        bar.appendChild(badge);
      }
      const label = document.createElement('span');
      label.textContent = t;
      bar.appendChild(label);
    },
    step,
    text,
  );
}

/**
 * Outlines one element so the viewer can see what is about to be used. The
 * outline goes away on its own shortly after `ms`; clickShown() removes it
 * as soon as the click lands.
 */
export async function highlight(browser, selector, ms = 700) {
  const res = await browser.resolve(selector).catch(() => null);
  const r = res?.matches?.[0]?.rect ?? res?.rect;
  if (!r) return;
  await browser.evaluate(
    (x, y, w, h, life) => {
      const box = document.createElement('div');
      box.className = '__bg_hl';
      box.style.cssText = `position:fixed;left:${x - 4}px;top:${y - 4}px;width:${w + 8}px;height:${h + 8}px;border:3px solid #7c3aed;border-radius:8px;z-index:2147483646;pointer-events:none;box-shadow:0 0 0 4px rgba(124,58,237,.25)`;
      document.documentElement.appendChild(box);
      setTimeout(() => box.remove(), life);
    },
    r.x,
    r.y,
    r.width ?? r.w,
    r.height ?? r.h,
    ms + 400,
  );
  await sleep(ms);
}

/** Removes every outline highlight() drew. */
export async function clearHighlights(browser) {
  await browser
    .evaluate(() => {
      for (const b of document.querySelectorAll('.__bg_hl')) b.remove();
    })
    .catch(() => {});
}

/** Outlines an element, clicks it, then drops the outline. */
export async function clickShown(browser, selector, ms = 500) {
  await highlight(browser, selector, ms);
  const res = await browser.click(selector);
  await clearHighlights(browser);
  return res;
}

// Chrome's new tab page is not something a clip should open on. When the
// tab is still there (or on any chrome:// page), move to about:blank.
async function leaveNewTabPage(browser) {
  const href = await browser.evaluate(() => location.href).catch(() => '');
  if (!href || href.startsWith('chrome') || href.startsWith('edge')) {
    await browser.navigate('about:blank');
  }
  for (let k = 0; k < 40; k++) {
    const state = await browser.evaluate(() => document.readyState).catch(() => 'loading');
    if (state === 'complete') return;
    await sleep(250);
  }
}

/**
 * Records `body` and writes docs/media/showcase/<name>.gif and <name>.png.
 * Returns the run duration in seconds, for the caption under the GIF.
 *
 * Pass `url` (and optionally `ready`, a selector) to load the first page
 * before the recording starts, so the clip opens on it. Without `url` the
 * recording starts on whatever page is open, or on about:blank if that is
 * still Chrome's new tab page.
 */
export async function recordRun(
  browser,
  name,
  body,
  { width = 720, fps = 10, url, ready = 'body' } = {},
) {
  const recordingsDir = process.env.BGLS_RECORDINGS_DIR;
  if (!recordingsDir)
    throw new Error('set BGLS_RECORDINGS_DIR to the folder given to bgls serve --recordings-dir');
  if (url) {
    await browser.navigate(url);
    await browser.waitFor(ready, { timeoutMs: 30000 });
  }
  await leaveNewTabPage(browser);
  await sleep(500); // let web fonts and images settle
  const started = Date.now();
  const handle = await browser.startRecording();
  let stopped;
  try {
    await body();
    await sleep(1200); // hold the last frame for a moment
  } finally {
    stopped = await browser.stopRecording(handle.recordingId);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const out = join(recordingsDir, '..', `export-${name}`);
  rmSync(out, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [
      join(repo, 'packages', 'cli', 'dist', 'bin.mjs'),
      'record',
      'export',
      handle.recordingId,
      '--dir',
      recordingsDir,
      '--out',
      out,
    ],
    { stdio: 'ignore' },
  );
  checkCoverage(name, out, stopped);
  mkdirSync(mediaDir, { recursive: true });
  framesToGif(out, join(mediaDir, `${name}.gif`), join(mediaDir, `${name}.png`), { width, fps });
  return seconds;
}

// Warns when the recording lost frames or has a long stretch with none, so
// the clip can be recorded again. Frame times count from when the stream
// started, not from startRecording(), so only the gaps between frames are
// compared. A page that does not change sends no frames either, so a gap
// during a still hold is harmless.
function checkCoverage(name, dir, stopped) {
  const { frames } = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  let gap = 0;
  let at = 0;
  for (let i = 1; i < frames.length; i++) {
    const d = frames[i].tsDeltaMs - frames[i - 1].tsDeltaMs;
    if (d > gap) {
      gap = d;
      at = frames[i - 1].tsDeltaMs - frames[0].tsDeltaMs;
    }
  }
  const dropped = stopped.framesDropped ?? 0;
  if (dropped > 0 || gap > 2000 || stopped.failed) {
    console.warn(
      `warning: ${name} recording has ${frames.length} frames, ${dropped} dropped, longest gap ${(gap / 1000).toFixed(1)}s at ${(at / 1000).toFixed(1)}s${stopped.failed ? ', recorder failed' : ''}. Consider recording it again.`,
    );
  }
}

function jpegSize(file) {
  const b = readFileSync(file);
  for (let i = 2; i < b.length - 9; i++) {
    if (b[i] === 0xff && (b[i + 1] === 0xc0 || b[i + 1] === 0xc2)) {
      return `${b.readUInt16BE(i + 7)}x${b.readUInt16BE(i + 5)}`;
    }
  }
  return '?';
}

/** Exported frames plus their timing manifest, to a GIF that keeps real time. */
export function framesToGif(dir, gifPath, posterPath, { width = 720, fps = 10 } = {}) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const all = manifest.frames;
  // Chrome can emit a few frames at a different size while the window
  // settles; a size change mid sequence breaks the concat demuxer.
  const size = jpegSize(join(dir, all[all.length - 1].file));
  const sized = all.filter((f) => jpegSize(join(dir, f.file)) === size);
  // A busy page sends a frame every 16 ms or so. Group frames into slots of
  // one GIF frame each, show the newest picture of every slot, and give it
  // the real time until the next slot, so the GIF plays at the speed the
  // run happened.
  const frames = [];
  for (const f of sized) {
    const last = frames[frames.length - 1];
    if (!last || f.tsDeltaMs - last.tsDeltaMs >= 1000 / fps) frames.push(f);
    else frames[frames.length - 1] = { ...f, tsDeltaMs: last.tsDeltaMs };
  }
  let list = '';
  for (let k = 0; k < frames.length; k++) {
    const next = k + 1 < frames.length ? frames[k + 1].tsDeltaMs : frames[k].tsDeltaMs + 1500;
    const dur = (next - frames[k].tsDeltaMs) / 1000;
    list += `file '${join(dir, frames[k].file).replaceAll('\\', '/')}'\nduration ${dur.toFixed(3)}\n`;
  }
  list += `file '${join(dir, frames[frames.length - 1].file).replaceAll('\\', '/')}'\n`;
  const listPath = join(dir, 'list.txt');
  writeFileSync(listPath, list);
  const palette = join(dir, 'palette.png');
  const vf = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
  ff([
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-vf',
    `${vf},palettegen=stats_mode=diff`,
    palette,
  ]);
  ff([
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-i',
    palette,
    '-lavfi',
    `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`,
    gifPath,
  ]);
  // Poster: the last frame, full width, for docs/showcase.md.
  ff(['-i', join(dir, frames[frames.length - 1].file), '-vf', 'scale=1280:-1', posterPath]);
}
