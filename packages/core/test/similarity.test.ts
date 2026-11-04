import { describe, expect, it } from 'vitest';
import type { RawImage } from '../src/image/png.ts';
import { LOOKS_DIFFERENT_BELOW, luminanceGrid, screenSimilarity } from '../src/image/similarity.ts';

/** A filled rectangle; position and size are fractions of the screen so one layout draws at any resolution. */
type Box = { x: number; y: number; w: number; h: number; lum: number };

const BACKGROUND = 242;

function screen(width: number, height: number, channels: 1 | 3 | 4, boxes: readonly Box[], shiftPx = 0): RawImage {
  const data = new Uint8Array(width * height * channels);
  const put = (pixel: number, lum: number) => {
    const at = pixel * channels;
    for (let c = 0; c < Math.min(channels, 3); c++) data[at + c] = lum;
    if (channels === 4) data[at + 3] = 255;
  };
  for (let i = 0; i < width * height; i++) put(i, BACKGROUND);
  for (const box of boxes) {
    const y0 = Math.round(box.y * height) + shiftPx;
    const y1 = Math.round((box.y + box.h) * height) + shiftPx;
    const x0 = Math.round(box.x * width);
    const x1 = Math.round((box.x + box.w) * width);
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
      for (let x = x0; x < x1; x++) put(y * width + x, box.lum);
    }
  }
  return { width, height, channels, data };
}

/** Something like the Settings home screen: a search bar, then rows of icon, dark title and grey summary. */
function settingsList(): Box[] {
  const boxes: Box[] = [{ x: 0.05, y: 0.08, w: 0.9, h: 0.05, lum: 225 }];
  [0.35, 0.5, 0.28, 0.42, 0.31, 0.55, 0.24, 0.38, 0.47].forEach((w, i) => {
    const y = 0.17 + i * 0.085;
    boxes.push({ x: 0.08, y: y + 0.005, w: 0.06, h: 0.03, lum: 90 });
    boxes.push({ x: 0.2, y, w, h: 0.02, lum: 30 });
    boxes.push({ x: 0.2, y: y + 0.028, w: w * 0.8, h: 0.014, lum: 120 });
  });
  return boxes;
}

/** A different screen: a banner image and two big buttons. */
function landingPage(): Box[] {
  return [
    { x: 0, y: 0.1, w: 1, h: 0.25, lum: 70 },
    { x: 0.1, y: 0.42, w: 0.8, h: 0.06, lum: 40 },
    { x: 0.1, y: 0.55, w: 0.8, h: 0.06, lum: 40 },
    { x: 0.3, y: 0.75, w: 0.4, h: 0.04, lum: 30 },
  ];
}

const list = screen(1080, 2400, 3, settingsList());

describe('screenSimilarity', () => {
  it('scores an identical screen 100', () => {
    expect(screenSimilarity(list, list)).toBe(100);
    expect(screenSimilarity(list, screen(1080, 2400, 3, settingsList()))).toBe(100);
  });

  it('stays high when the same screen is drawn a few pixels lower', () => {
    for (const shift of [3, 6, 10, 40]) {
      const score = screenSimilarity(list, screen(1080, 2400, 3, settingsList(), shift));
      expect(score, `shifted ${shift}px`).toBeGreaterThan(90);
      expect(score).toBeGreaterThanOrEqual(LOOKS_DIFFERENT_BELOW);
    }
  });

  it('needs the shift search to forgive a larger offset', () => {
    const lower = screen(1080, 2400, 3, settingsList(), 80);
    expect(screenSimilarity(list, lower)).toBeGreaterThanOrEqual(LOOKS_DIFFERENT_BELOW);
    expect(screenSimilarity(list, lower, { maxShiftRows: 0 })).toBeLessThan(LOOKS_DIFFERENT_BELOW);
  });

  it('scores a clearly different layout low', () => {
    expect(screenSimilarity(list, screen(1080, 2400, 3, landingPage()))).toBeLessThan(40);
  });

  it('flags a dialog over a dimmed screen', () => {
    const dimmed = settingsList().map((box) => ({ ...box, lum: Math.round(box.lum * 0.4) }));
    const dialog = screen(1080, 2400, 3, [
      { x: 0, y: 0, w: 1, h: 1, lum: 97 },
      ...dimmed,
      { x: 0.08, y: 0.32, w: 0.84, h: 0.3, lum: 250 },
      { x: 0.14, y: 0.36, w: 0.5, h: 0.025, lum: 20 },
    ]);
    expect(screenSimilarity(list, dialog)).toBeLessThan(LOOKS_DIFFERENT_BELOW);
  });

  it('gives the same verdict whichever screenshot comes first', () => {
    const other = screen(1080, 2400, 3, landingPage());
    expect(screenSimilarity(other, list)).toBeLessThan(LOOKS_DIFFERENT_BELOW);
    expect(screenSimilarity(screen(1080, 2400, 3, settingsList(), 6), list)).toBeGreaterThanOrEqual(LOOKS_DIFFERENT_BELOW);
  });

  it('compares every cell when both screens are blank', () => {
    const blank = screen(1080, 2400, 3, []);
    // No content cells at all: without the fallback this would be 0 / 0.
    expect(screenSimilarity(blank, screen(1080, 2400, 3, []))).toBe(100);
    // A blinking cursor is a handful of content cells that do not match; over every cell it barely counts.
    const cursor = screen(1080, 2400, 3, [{ x: 0.5, y: 0.5, w: 0.006, h: 0.03, lum: 20 }]);
    const score = screenSimilarity(blank, cursor);
    expect(score).toBeGreaterThan(99);
    expect(score).toBeLessThan(100);
    // A real block of content is not covered by the fallback.
    expect(screenSimilarity(blank, screen(1080, 2400, 3, [{ x: 0.1, y: 0.3, w: 0.8, h: 0.3, lum: 20 }]))).toBeLessThan(10);
  });

  it('ignores the status bar and the navigation bar', () => {
    const withBars = screen(1080, 2400, 3, [
      ...settingsList(),
      { x: 0.02, y: 0.01, w: 0.15, h: 0.03, lum: 0 },
      { x: 0.3, y: 0.96, w: 0.4, h: 0.02, lum: 0 },
    ]);
    expect(screenSimilarity(list, withBars)).toBe(100);
  });

  it('compares across resolutions and channel layouts', () => {
    const small = screen(540, 1200, 4, settingsList());
    expect(screenSimilarity(small, list)).toBeGreaterThan(95);
    expect(screenSimilarity(small, screen(1080, 2400, 3, settingsList(), 8))).toBeGreaterThanOrEqual(LOOKS_DIFFERENT_BELOW);
    expect(screenSimilarity(screen(540, 1200, 1, settingsList()), small)).toBe(100);
    expect(screenSimilarity(small, screen(1080, 2400, 3, landingPage()))).toBeLessThan(LOOKS_DIFFERENT_BELOW);
  });

  it('weights RGB channels by luminance', () => {
    const fill = (width: number, height: number, channels: 1 | 3, pixel: number[]): RawImage => {
      const data = new Uint8Array(width * height * channels);
      for (let i = 0; i < width * height; i++) data.set(pixel, i * channels);
      return { width, height, channels, data };
    };
    // Pure red has luminance 0.299 * 255 = 76.2.
    const red = fill(200, 400, 3, [255, 0, 0]);
    expect(screenSimilarity(red, fill(200, 400, 1, [76]))).toBe(100);
    expect(screenSimilarity(red, fill(200, 400, 1, [200]))).toBe(0);
  });
});

describe('luminanceGrid', () => {
  it('has one value per cell, each the mean luminance of the cropped image', () => {
    const grid = luminanceGrid(list);
    expect(grid.length).toBe(27 * 120);
    const custom = luminanceGrid(screen(100, 200, 3, []), { columns: 4, rows: 10 });
    expect(custom.length).toBe(40);
    expect([...custom].every((value) => value === BACKGROUND)).toBe(true);
  });

  it('leaves the cropped top and bottom out of every cell', () => {
    const bars = screen(100, 200, 1, [
      { x: 0, y: 0, w: 1, h: 0.05, lum: 0 },
      { x: 0, y: 0.96, w: 1, h: 0.04, lum: 0 },
    ]);
    expect([...luminanceGrid(bars, { columns: 2, rows: 4 })].every((value) => value === BACKGROUND)).toBe(true);
    expect([...luminanceGrid(bars, { columns: 2, rows: 4, cropTop: 0, cropBottom: 0 })].some((value) => value < BACKGROUND)).toBe(true);
  });
});
