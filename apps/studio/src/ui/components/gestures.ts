// What a press on the mirrored screen means, from how long it lasted and how
// far the pointer went. Pure, so the thresholds are tested without a browser.

/** Held at least this long without moving, a press is a long press. */
export const HOLD_MS = 600;

/** Moved at least this far (CSS pixels on the mirror), a press is a drag, whatever its length. */
export const DRAG_PX = 8;

export type PointerGesture = 'tap' | 'hold' | 'drag';

/**
 * `maxDistancePx` is the farthest the pointer got from where it went down,
 * so a drag that comes back to its start is still a drag and never a tap.
 */
export function classifyPointer(press: { durationMs: number; maxDistancePx: number }): PointerGesture {
  if (press.maxDistancePx >= DRAG_PX) return 'drag';
  return press.durationMs >= HOLD_MS ? 'hold' : 'tap';
}

/** Straight-line distance between two points, for tracking `maxDistancePx`. */
export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
