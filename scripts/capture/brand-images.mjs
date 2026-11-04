// Draws the site's share image and raster icons with the Chromium the captures
// use: site/img/og.png, site/favicon-192.png, site/favicon.ico and
// site/apple-touch-icon.png. Also makes the WebP copies the landing page shows
// of its stills. Run it again after a capture or a logo change.
//   node scripts/capture/brand-images.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Page } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '../../site');
const work = mkdtempSync(join(tmpdir(), 'ariadne-brand-'));
const page = await Page.open({ width: 1200, height: 630 });
const PAGE_IMAGES = ['media/record-poster', 'media/run-poster', 'img/run-video-failed', 'img/block-mid-recording', 'img/existing-project'];

async function draw(url, width, height, file, background) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await page.send('Emulation.setDefaultBackgroundColorOverride', { color: background ?? { r: 0, g: 0, b: 0, a: 0 } });
  await page.goto(url, 700);
  await page.shot(file);
}

try {
  await draw(`file://${join(here, 'og.html')}`, 1200, 630, join(site, 'img/og.png'), { r: 28, g: 43, b: 74, a: 1 });
  await draw(`file://${join(site, 'favicon.svg')}`, 192, 192, join(site, 'favicon-192.png'));
  await draw(`file://${join(site, 'favicon.svg')}`, 180, 180, join(site, 'apple-touch-icon.png'), { r: 28, g: 43, b: 74, a: 1 });
  await draw(`file://${join(site, 'favicon.svg')}`, 48, 48, join(work, 'favicon-48.png'));
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', join(work, 'favicon-48.png'), join(work, 'favicon.ico')]);
  copyFileSync(join(work, 'favicon.ico'), join(site, 'favicon.ico'));
  for (const image of PAGE_IMAGES) {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', join(site, `${image}.png`), '-c:v', 'libwebp', '-quality', '82', '-compression_level', '6', join(site, `${image}.webp`)]);
  }
} finally {
  await page.close();
  rmSync(work, { recursive: true, force: true });
}
