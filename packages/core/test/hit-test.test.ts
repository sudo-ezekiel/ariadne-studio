import { describe, expect, it } from 'vitest';
import { resolveNodeAt, type HitTestNode } from '../src/device/hit-test.ts';

type Node = HitTestNode & { name: string };

const screen: Node = { name: 'root', rect: { x: 0, y: 0, width: 1080, height: 2400 }, depth: 0 };

describe('resolveNodeAt', () => {
  it('picks the smallest named node inside nested containers', () => {
    const nodes: Node[] = [
      screen,
      { name: 'list', rect: { x: 0, y: 300, width: 1080, height: 1800 }, depth: 1, hittable: true },
      { name: 'row', rect: { x: 0, y: 600, width: 1080, height: 200 }, depth: 2, hittable: true },
      { name: 'title', rect: { x: 200, y: 640, width: 400, height: 70 }, depth: 3, label: 'Network & internet' },
    ];
    expect(resolveNodeAt(nodes, { x: 300, y: 660 })?.name).toBe('title');
    // Outside the title but inside the row, the row wins over the list.
    expect(resolveNodeAt(nodes, { x: 900, y: 700 })?.name).toBe('row');
  });

  it('ignores containers that are neither hittable nor named', () => {
    const nodes: Node[] = [screen, { name: 'plain', rect: { x: 0, y: 0, width: 100, height: 100 }, depth: 1 }];
    expect(resolveNodeAt(nodes, { x: 50, y: 50 })).toBeUndefined();
  });

  it('chooses the smaller of two overlapping siblings', () => {
    const nodes: Node[] = [
      screen,
      { name: 'big', rect: { x: 0, y: 0, width: 500, height: 500 }, depth: 1, label: 'Big' },
      { name: 'small', rect: { x: 100, y: 100, width: 100, height: 100 }, depth: 1, label: 'Small' },
    ];
    expect(resolveNodeAt(nodes, { x: 150, y: 150 })?.name).toBe('small');
    expect(resolveNodeAt(nodes, { x: 400, y: 400 })?.name).toBe('big');
  });

  it('breaks area ties by depth, then by document order', () => {
    const rect = { x: 0, y: 0, width: 200, height: 200 };
    const byDepth: Node[] = [
      { name: 'deep', rect, depth: 5, label: 'A' },
      { name: 'shallow', rect, depth: 2, label: 'B' },
    ];
    expect(resolveNodeAt(byDepth, { x: 10, y: 10 })?.name).toBe('deep');
    const noDepth: Node[] = [
      { name: 'parent', rect, hittable: true },
      { name: 'child', rect, label: 'Child' },
    ];
    expect(resolveNodeAt(noDepth, { x: 10, y: 10 })?.name).toBe('child');
  });

  it('skips system bars, hidden nodes and covered nodes', () => {
    const nodes: Node[] = [
      { name: 'content', rect: { x: 0, y: 0, width: 1080, height: 2400 }, depth: 0, hittable: true },
      { name: 'navbar', rect: { x: 0, y: 2300, width: 1080, height: 100 }, depth: 1, systemBar: 'navigation', label: 'Home' },
      { name: 'hidden', rect: { x: 0, y: 0, width: 50, height: 50 }, depth: 1, visibleToUser: false, label: 'Ghost' },
      { name: 'covered', rect: { x: 500, y: 500, width: 50, height: 50 }, depth: 1, interactionBlocked: 'covered', label: 'Under' },
    ];
    expect(resolveNodeAt(nodes, { x: 540, y: 2350 })?.name).toBe('content');
    expect(resolveNodeAt(nodes, { x: 10, y: 10 })?.name).toBe('content');
    expect(resolveNodeAt(nodes, { x: 510, y: 510 })?.name).toBe('content');
  });

  it('returns undefined when nothing is under the point', () => {
    const nodes: Node[] = [{ name: 'a', rect: { x: 0, y: 0, width: 10, height: 10 }, label: 'A' }];
    expect(resolveNodeAt(nodes, { x: 50, y: 50 })).toBeUndefined();
    expect(resolveNodeAt([], { x: 0, y: 0 })).toBeUndefined();
  });
});
