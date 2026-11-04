import { describe, expect, it } from 'vitest';
import { classifyPointer, distance, DRAG_PX, HOLD_MS } from '../src/ui/components/gestures.ts';

describe('classifyPointer', () => {
  it('is a tap when short and still', () => {
    expect(classifyPointer({ durationMs: 80, maxDistancePx: 0 })).toBe('tap');
    expect(classifyPointer({ durationMs: HOLD_MS - 1, maxDistancePx: DRAG_PX - 0.5 })).toBe('tap');
  });

  it('is a long press when held 600 ms or more without moving 8 px', () => {
    expect(classifyPointer({ durationMs: HOLD_MS, maxDistancePx: 0 })).toBe('hold');
    expect(classifyPointer({ durationMs: 3000, maxDistancePx: 7.9 })).toBe('hold');
  });

  it('is a drag as soon as the pointer got 8 px away, however long it took', () => {
    expect(classifyPointer({ durationMs: 50, maxDistancePx: DRAG_PX })).toBe('drag');
    expect(classifyPointer({ durationMs: 5000, maxDistancePx: 200 })).toBe('drag');
  });

  it('measures straight-line distance', () => {
    expect(distance({ x: 0, y: 0 }, { x: 6, y: 8 })).toBe(10);
  });
});
