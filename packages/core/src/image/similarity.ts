// "Looks different" check between a recorded and a replayed screenshot of the
// same step. Coarse on purpose: it should ignore anti-aliasing, a blinking
// cursor and the clock, and notice a different screen, a dialog, or a list
// scrolled to somewhere else. It is reported beside the run, never used to
// pass or fail it.
import type { RawImage } from './png.ts';

export type SimilarityOptions = {
  /** Grid size; each cell is the mean luminance of its pixels. */
  columns?: number;
  rows?: number;
  /** Fractions of the height ignored at the top (status bar) and bottom (navigation bar). */
  cropTop?: number;
  cropBottom?: number;
  /** Largest luminance difference (0-255) at which two cells still match. */
  tolerance?: number;
  /**
   * Largest vertical shift, in grid rows, tried when lining the two up. Two
   * devices (or one after a system update) can draw the same screen a few
   * pixels higher or lower, and a fixed grid would call that a different screen.
   */
  maxShiftRows?: number;
};

const DEFAULTS: Required<SimilarityOptions> = {
  columns: 27,
  rows: 120,
  cropTop: 0.06,
  cropBottom: 0.05,
  tolerance: 14,
  maxShiftRows: 8,
};

/** Below this, the studio flags a step as "looks different". */
export const LOOKS_DIFFERENT_BELOW = 85;

function luminanceAt(image: RawImage, index: number): number {
  const { channels, data } = image;
  const at = index * channels;
  if (channels <= 2) return data[at]!;
  return 0.299 * data[at]! + 0.587 * data[at + 1]! + 0.114 * data[at + 2]!;
}

/** Mean luminance per grid cell over the cropped image. */
export function luminanceGrid(image: RawImage, options: SimilarityOptions = {}): Float64Array {
  const { columns, rows, cropTop, cropBottom } = { ...DEFAULTS, ...options };
  const top = Math.floor(image.height * cropTop);
  const bottom = Math.max(top + rows, Math.ceil(image.height * (1 - cropBottom)));
  const usable = Math.min(image.height, bottom) - top;
  const sums = new Float64Array(columns * rows);
  const counts = new Float64Array(columns * rows);
  // Sample every other pixel each way; the grid is far coarser than that.
  for (let y = top; y < top + usable; y += 2) {
    const row = Math.min(rows - 1, Math.floor(((y - top) * rows) / usable));
    for (let x = 0; x < image.width; x += 2) {
      const column = Math.min(columns - 1, Math.floor((x * columns) / image.width));
      const cell = row * columns + column;
      sums[cell]! += luminanceAt(image, y * image.width + x);
      counts[cell]! += 1;
    }
  }
  for (let i = 0; i < sums.length; i++) sums[i] = counts[i]! > 0 ? sums[i]! / counts[i]! : 0;
  return sums;
}

/** The most common cell value of both grids, in buckets of 8: the shared background. */
function background(a: Float64Array, b: Float64Array): number {
  const buckets = new Map<number, number>();
  for (const grid of [a, b]) {
    for (const value of grid) {
      const bucket = Math.round(value / 8);
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
  }
  let best = 0;
  let bestCount = -1;
  for (const [bucket, count] of buckets) {
    if (count > bestCount) {
      best = bucket;
      bestCount = count;
    }
  }
  return best * 8;
}

function scoreAt(gridA: Float64Array, gridB: Float64Array, columns: number, rows: number, shift: number, bg: number, tolerance: number): number {
  let content = 0;
  let matched = 0;
  let cells = 0;
  let allMatched = 0;
  for (let row = Math.max(0, -shift); row < Math.min(rows, rows - shift); row++) {
    for (let column = 0; column < columns; column++) {
      const va = gridA[row * columns + column]!;
      const at = (row + shift) * columns + column;
      const vb = gridB[at]!;
      // A shift that is not a whole number of rows puts text edges part way
      // into the next cell, so a cell also matches anything between its
      // vertical neighbours in the other image.
      const up = row + shift > 0 ? gridB[at - columns]! : vb;
      const down = row + shift < rows - 1 ? gridB[at + columns]! : vb;
      const low = Math.min(up, vb, down) - tolerance;
      const high = Math.max(up, vb, down) + tolerance;
      const same = va >= low && va <= high;
      cells++;
      if (same) allMatched++;
      if (Math.abs(va - bg) > 10 || Math.abs(vb - bg) > 10) {
        content++;
        if (same) matched++;
      }
    }
  }
  // A nearly blank pair of screens has no content to compare; use every cell.
  if (content < cells * 0.02) return cells === 0 ? 0 : allMatched / cells;
  return matched / content;
}

/**
 * Percentage (0-100) of content cells that match, at the best vertical shift
 * within maxShiftRows. Content cells are those where either screenshot differs
 * from the shared background, so two mostly white screens with different text
 * do not look alike just because they are both white. Callers pass
 * screenshots of the same screen size; the grid makes the resolution irrelevant.
 */
export function screenSimilarity(a: RawImage, b: RawImage, options: SimilarityOptions = {}): number {
  const { tolerance, columns, rows, maxShiftRows } = { ...DEFAULTS, ...options };
  const gridA = luminanceGrid(a, options);
  const gridB = luminanceGrid(b, options);
  const bg = background(gridA, gridB);
  let best = 0;
  for (let shift = -maxShiftRows; shift <= maxShiftRows; shift++) {
    best = Math.max(best, scoreAt(gridA, gridB, columns, rows, shift, bg, tolerance));
  }
  return Math.round(best * 1000) / 10;
}
