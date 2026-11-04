import { describe, expect, it } from 'vitest';
import { expectationCandidates, isVolatileName, MAX_EXPECTATION_CANDIDATES, type ExpectationNode } from '../src/recorder/expectations.ts';
import { settingsHome, viewport } from './fixtures.ts';

function text(index: number, label: string, y: number, extra: Partial<ExpectationNode> = {}): ExpectationNode {
  return { index, rect: { x: 100, y, width: 400, height: 60 }, label, ...extra };
}

describe('isVolatileName', () => {
  it.each([
    ['OK', true],
    ['Wi', true],
    ['  12  ', true],
    ['1,234.50', true],
    ['+30 210 1234567', true],
    ['Updated 10:42', true],
    ['Due 31/10/2026', true],
    ['Born 2026-10-31', true],
    ['Total €12', true],
    ['12 EUR', true],
    ['$ 9.99', true],
    ['Battery 85 %', true],
    ['Ref 4417 2093', true],
    ['ID A1B2C3D4', true],
    ['Order A1B2', false],
    ['Network & internet', false],
    ['Storage (64 GB)', false],
    ['Android 16', false],
    ['Sign in', false],
  ])('%s -> %s', (name, volatile) => {
    expect(isVolatileName(name)).toBe(volatile);
  });
});

describe('expectationCandidates', () => {
  it('offers the named, stable, fully visible elements of a real-shaped screen', () => {
    const candidates = expectationCandidates(settingsHome(), viewport);
    expect(candidates.map(({ id, label, selector }) => ({ id, label, selector }))).toEqual([
      { id: 0, label: 'Search Settings', selector: { kind: 'id', value: 'com\\.android\\.settings:id/search_bar_title' } },
      { id: 1, label: 'Network & internet', selector: { kind: 'text', value: 'Network & internet' } },
      { id: 2, label: 'Mobile, Wi‑Fi, hotspot', selector: { kind: 'text', value: 'Mobile, Wi‑Fi, hotspot' } },
      { id: 3, label: 'Connected devices', selector: { kind: 'text', value: 'Connected devices' } },
      { id: 4, label: 'Bluetooth, pairing', selector: { kind: 'text', value: 'Bluetooth, pairing' } },
      { id: 5, label: 'Storage (64 GB)', selector: { kind: 'text', value: 'Storage \\(64 GB\\)' } },
      { id: 6, label: 'Used 12 GB', selector: { kind: 'text', value: 'Used 12 GB' } },
    ]);
    // The status bar clock is left out (system bar), and so are the nameless row containers.
    expect(candidates[1]!.node).toEqual({ label: 'Network & internet', identifier: 'android:id/title', rect: { x: 210, y: 663, width: 436, height: 71 } });
  });

  it('skips hidden, covered, editable, password, keyboard and off-screen nodes', () => {
    const nodes: ExpectationNode[] = [
      text(0, 'Visible title', 100),
      text(1, 'Hidden title', 200, { visibleToUser: false }),
      text(2, 'Covered title', 300, { interactionBlocked: 'covered' }),
      text(3, 'Email address', 400, { editable: true }),
      text(4, 'Secret field', 500, { password: true }),
      text(5, 'Keyboard key', 600, { keyboardOwned: true }),
      text(6, 'Half off screen', 2380),
      text(7, 'Zero height', 700, { rect: { x: 0, y: 700, width: 100, height: 0 } }),
      text(8, 'Navigation bar', 2300, { systemBar: 'navigation' }),
      text(9, 'x'.repeat(80), 800),
    ];
    expect(expectationCandidates(nodes, viewport).map((candidate) => candidate.label)).toEqual(['Visible title']);
  });

  it('only offers unique id or text selectors that belong to the node itself', () => {
    const nodes: ExpectationNode[] = [
      // Shared name and shared id: only reachable with an index, so not offered.
      text(0, 'Remove', 100, { identifier: 'com.app:id/remove' }),
      text(1, 'Remove', 300, { identifier: 'com.app:id/remove' }),
      // Shared name, unique id: offered by id.
      text(2, 'Details', 500, { identifier: 'com.app:id/details_a' }),
      text(3, 'Details', 700),
      // Text matching is case-insensitive, as in Maestro, so these are not unique.
      text(4, 'Summary', 900),
      text(5, 'summary', 1000),
      // Two cards with the same name: chooseSelector would borrow the child's
      // unique text for the card, which is not what the card says.
      { index: 6, rect: { x: 0, y: 1200, width: 1080, height: 200 }, label: 'Card' },
      { index: 7, parentIndex: 6, rect: { x: 40, y: 1220, width: 600, height: 60 }, label: 'Jane Doe' },
      { index: 8, rect: { x: 0, y: 1500, width: 1080, height: 200 }, label: 'Card' },
    ];
    expect(expectationCandidates(nodes, viewport).map(({ id, label, selector }) => ({ id, label, selector }))).toEqual([
      { id: 0, label: 'Details', selector: { kind: 'id', value: 'com\\.app:id/details_a' } },
      { id: 1, label: 'Jane Doe', selector: { kind: 'text', value: 'Jane Doe' } },
    ]);
  });

  it('offers a label held by both a parent and its child once, without an index', () => {
    const nodes: ExpectationNode[] = [
      { index: 0, rect: { x: 0, y: 2000, width: 270, height: 100 }, label: 'Forms', hittable: true },
      { index: 1, parentIndex: 0, rect: { x: 80, y: 2030, width: 100, height: 40 }, label: 'Forms' },
    ];
    expect(expectationCandidates(nodes, viewport).map(({ label, selector }) => ({ label, selector }))).toEqual([
      { label: 'Forms', selector: { kind: 'text', value: 'Forms' } },
    ]);
  });

  it('ranks top to bottom, taller first on the same row, and caps the list', () => {
    const nodes: ExpectationNode[] = [
      text(0, 'Lower', 500),
      { index: 1, rect: { x: 600, y: 100, width: 300, height: 40 }, label: 'Small label' },
      { index: 2, rect: { x: 0, y: 100, width: 500, height: 120 }, label: 'Big heading' },
    ];
    for (let n = 0; n < 20; n++) nodes.push(text(10 + n, `Row number ${'abcdefghijklmnopqrst'[n]}`, 600 + n * 80));
    const candidates = expectationCandidates(nodes, viewport);
    expect(candidates).toHaveLength(MAX_EXPECTATION_CANDIDATES);
    expect(candidates.slice(0, 4).map((candidate) => candidate.label)).toEqual(['Big heading', 'Small label', 'Lower', 'Row number a']);
    expect(candidates.map((candidate) => candidate.id)).toEqual([...Array(MAX_EXPECTATION_CANDIDATES).keys()]);
  });

  it('gives the same ids for the same snapshot', () => {
    expect(expectationCandidates(settingsHome(), viewport)).toEqual(expectationCandidates(settingsHome(), viewport));
  });
});
