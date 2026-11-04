import { describe, expect, it } from 'vitest';
import { chooseSelector, type SelectorNode } from '../src/maestro/selector.ts';
import { byLabel, settingsHome, viewport } from './fixtures.ts';

const somewhere = { x: 540, y: 1200 };

describe('chooseSelector', () => {
  it('uses a unique resource-id as is', () => {
    const nodes = settingsHome();
    const searchBar = nodes.find((node) => node.identifier === 'com.android.settings:id/search_action_bar')!;
    expect(chooseSelector(searchBar, nodes, somewhere, viewport)).toEqual({
      kind: 'id',
      value: 'com\\.android\\.settings:id/search_action_bar',
    });
  });

  it('prefers a unique text over a resource-id shared by every row', () => {
    const nodes = settingsHome();
    expect(chooseSelector(byLabel(nodes, 'Connected devices'), nodes, somewhere, viewport)).toEqual({
      kind: 'text',
      value: 'Connected devices',
    });
  });

  it('escapes regex metacharacters in text and id', () => {
    const nodes = settingsHome();
    expect(chooseSelector(byLabel(nodes, 'Storage (64 GB)'), nodes, somewhere, viewport)).toEqual({
      kind: 'text',
      value: 'Storage \\(64 GB\\)',
    });
  });

  it('resolves a nameless row container to its first uniquely named child', () => {
    const nodes = settingsHome();
    const row = nodes.find((node) => node.hittable && node.rect?.y === 827)!;
    expect(chooseSelector(row, nodes, { x: 900, y: 900 }, viewport)).toEqual({ kind: 'text', value: 'Connected devices' });
  });

  it('does not borrow a name from a child that is its own tap target', () => {
    const nodes: SelectorNode[] = [
      { index: 0, rect: { x: 0, y: 0, width: 1000, height: 300 }, hittable: true },
      { index: 1, parentIndex: 0, rect: { x: 800, y: 100, width: 150, height: 100 }, hittable: true },
      { index: 2, parentIndex: 1, rect: { x: 820, y: 120, width: 100, height: 50 }, label: 'Delete' },
    ];
    expect(chooseSelector(nodes[0], nodes, { x: 100, y: 100 }, viewport)).toEqual({
      kind: 'point',
      xPercent: 9,
      yPercent: 4,
    });
  });

  it('adds an index for duplicates, ordered top to bottom then left to right', () => {
    const nodes: SelectorNode[] = [
      // Document order deliberately differs from screen order.
      { index: 0, rect: { x: 0, y: 900, width: 100, height: 50 }, label: 'Edit' },
      { index: 1, rect: { x: 500, y: 100, width: 100, height: 50 }, label: 'edit' },
      { index: 2, rect: { x: 0, y: 100, width: 100, height: 50 }, label: 'Edit' },
    ];
    expect(chooseSelector(nodes[0], nodes, somewhere, viewport)).toEqual({ kind: 'text', value: 'Edit', index: 2 });
    expect(chooseSelector(nodes[1], nodes, somewhere, viewport)).toEqual({ kind: 'text', value: 'edit', index: 1 });
    expect(chooseSelector(nodes[2], nodes, somewhere, viewport)).toEqual({ kind: 'text', value: 'Edit', index: 0 });
  });

  it('uses a shared id with an index when the text is shared too', () => {
    const nodes: SelectorNode[] = [
      { index: 0, rect: { x: 0, y: 100, width: 100, height: 50 }, label: 'Remove', identifier: 'com.app:id/remove' },
      { index: 1, rect: { x: 0, y: 300, width: 100, height: 50 }, label: 'Remove', identifier: 'com.app:id/remove' },
    ];
    expect(chooseSelector(nodes[1], nodes, somewhere, viewport)).toEqual({
      kind: 'id',
      value: 'com\\.app:id/remove',
      index: 1,
    });
  });

  describe('nested matches (Maestro keeps only the deepest)', () => {
    const tabBar = { x: 0, y: 2000, width: 270, height: 100 };

    it.each([
      ['the parent button', 0],
      ['the child text', 1],
    ])('counts a labelled parent and child once, targeting %s', (_name, target) => {
      const nodes: SelectorNode[] = [
        { index: 0, rect: tabBar, label: 'Forms', hittable: true },
        { index: 1, parentIndex: 0, rect: { x: 80, y: 2030, width: 100, height: 40 }, label: 'Forms' },
      ];
      expect(chooseSelector(nodes[target], nodes, somewhere, viewport)).toEqual({ kind: 'text', value: 'Forms' });
    });

    it.each([
      ['the grandparent', 0],
      ['the unlabelled node between', 1],
      ['the grandchild', 2],
    ])('counts a match once through an unlabelled middle node, targeting %s', (_name, target) => {
      const nodes: SelectorNode[] = [
        { index: 0, rect: tabBar, label: 'Forms', hittable: true },
        { index: 1, parentIndex: 0, rect: { x: 40, y: 2020, width: 200, height: 60 } },
        { index: 2, parentIndex: 1, rect: { x: 80, y: 2030, width: 100, height: 40 }, label: 'Forms' },
      ];
      expect(chooseSelector(nodes[target], nodes, somewhere, viewport)).toEqual({ kind: 'text', value: 'Forms' });
    });

    // Two tabs, each a hittable button holding a text with the same label.
    const twoTabs = (): SelectorNode[] => [
      { index: 0, rect: { x: 0, y: 2000, width: 270, height: 100 }, label: 'Forms', hittable: true },
      { index: 1, parentIndex: 0, rect: { x: 80, y: 2030, width: 100, height: 40 }, label: 'Forms' },
      { index: 2, rect: { x: 270, y: 2000, width: 270, height: 100 }, label: 'Forms', hittable: true },
      { index: 3, parentIndex: 2, rect: { x: 350, y: 2030, width: 100, height: 40 }, label: 'Forms' },
    ];

    it.each([
      ['the second tab text', 3, 1],
      ['the second tab button', 2, 1],
      ['the first tab text', 1, 0],
      ['the first tab button', 0, 0],
    ])('indexes two tabs among real matches only, targeting %s', (_name, target, index) => {
      const nodes = twoTabs();
      expect(chooseSelector(nodes[target], nodes, somewhere, viewport)).toEqual({ kind: 'text', value: 'Forms', index });
    });

    it('never produces an index for a match that Maestro would not see', () => {
      const nodes = twoTabs();
      for (const node of nodes) {
        const selector = chooseSelector(node, nodes, somewhere, viewport);
        expect(selector.kind === 'text' && selector.index !== undefined && selector.index > 1).toBe(false);
      }
    });

    it('follows the same rule for an id shared by a parent and its child', () => {
      const nodes: SelectorNode[] = [
        { index: 0, rect: { x: 0, y: 100, width: 270, height: 100 }, identifier: 'com.app:id/tab', hittable: true },
        { index: 1, parentIndex: 0, rect: { x: 80, y: 130, width: 100, height: 40 }, identifier: 'com.app:id/tab' },
      ];
      const expected = { kind: 'id', value: 'com\\.app:id/tab' };
      expect(chooseSelector(nodes[0], nodes, somewhere, viewport)).toEqual(expected);
      expect(chooseSelector(nodes[1], nodes, somewhere, viewport)).toEqual(expected);
    });

    it('indexes nested shared ids among the deepest nodes only', () => {
      const nodes: SelectorNode[] = [
        { index: 0, rect: { x: 0, y: 100, width: 270, height: 100 }, identifier: 'com.app:id/tab', hittable: true },
        { index: 1, parentIndex: 0, rect: { x: 80, y: 130, width: 100, height: 40 }, identifier: 'com.app:id/tab' },
        { index: 2, rect: { x: 270, y: 100, width: 270, height: 100 }, identifier: 'com.app:id/tab', hittable: true },
        { index: 3, parentIndex: 2, rect: { x: 350, y: 130, width: 100, height: 40 }, identifier: 'com.app:id/tab' },
      ];
      const second = { kind: 'id', value: 'com\\.app:id/tab', index: 1 };
      expect(chooseSelector(nodes[2], nodes, somewhere, viewport)).toEqual(second);
      expect(chooseSelector(nodes[3], nodes, somewhere, viewport)).toEqual(second);
      expect(chooseSelector(nodes[0], nodes, somewhere, viewport)).toEqual({ ...second, index: 0 });
    });

    it('still indexes flat duplicates that have no index or parentIndex links', () => {
      const nodes: SelectorNode[] = [
        { rect: { x: 0, y: 100, width: 100, height: 50 }, label: 'Edit' },
        { rect: { x: 0, y: 300, width: 100, height: 50 }, label: 'Edit' },
      ];
      expect(chooseSelector(nodes[1], nodes, somewhere, viewport)).toEqual({ kind: 'text', value: 'Edit', index: 1 });
      expect(chooseSelector(nodes[0], nodes, somewhere, viewport)).toEqual({ kind: 'text', value: 'Edit', index: 0 });
    });

    it('counts same-label siblings separately when neither contains the other', () => {
      const nodes: SelectorNode[] = [
        { index: 0, rect: { x: 0, y: 0, width: 1000, height: 600 } },
        { index: 1, parentIndex: 0, rect: { x: 0, y: 100, width: 100, height: 50 }, label: 'Edit' },
        { index: 2, parentIndex: 0, rect: { x: 0, y: 300, width: 100, height: 50 }, label: 'Edit' },
      ];
      expect(chooseSelector(nodes[1], nodes, somewhere, viewport)).toEqual({ kind: 'text', value: 'Edit', index: 0 });
      expect(chooseSelector(nodes[2], nodes, somewhere, viewport)).toEqual({ kind: 'text', value: 'Edit', index: 1 });
    });

    it('orders by the position of the deepest match, not of the dropped container', () => {
      const nodes: SelectorNode[] = [
        // The container starts above the standalone match, but its text sits below it.
        { index: 0, rect: { x: 0, y: 100, width: 1000, height: 700 }, label: 'Save', hittable: true },
        { index: 1, parentIndex: 0, rect: { x: 400, y: 700, width: 100, height: 50 }, label: 'Save' },
        { index: 2, rect: { x: 400, y: 400, width: 100, height: 50 }, label: 'Save' },
      ];
      expect(chooseSelector(nodes[2], nodes, somewhere, viewport)).toEqual({ kind: 'text', value: 'Save', index: 0 });
      expect(chooseSelector(nodes[1], nodes, somewhere, viewport)).toEqual({ kind: 'text', value: 'Save', index: 1 });
      expect(chooseSelector(nodes[0], nodes, somewhere, viewport)).toEqual({ kind: 'text', value: 'Save', index: 1 });
    });

    it('breaks a same-row tie left to right after containers are dropped', () => {
      const nodes: SelectorNode[] = [
        // Document order puts the right-hand tab first.
        { index: 0, rect: { x: 540, y: 2000, width: 270, height: 100 }, label: 'Forms', hittable: true },
        { index: 1, parentIndex: 0, rect: { x: 600, y: 2030, width: 100, height: 40 }, label: 'Forms' },
        { index: 2, rect: { x: 0, y: 2000, width: 270, height: 100 }, label: 'Forms', hittable: true },
        { index: 3, parentIndex: 2, rect: { x: 60, y: 2030, width: 100, height: 40 }, label: 'Forms' },
      ];
      expect(chooseSelector(nodes[0], nodes, somewhere, viewport)).toEqual({ kind: 'text', value: 'Forms', index: 1 });
      expect(chooseSelector(nodes[3], nodes, somewhere, viewport)).toEqual({ kind: 'text', value: 'Forms', index: 0 });
    });
  });

  it('counts content descriptions as text matches, as Maestro does', () => {
    const nodes: SelectorNode[] = [
      { index: 0, rect: { x: 0, y: 100, width: 100, height: 50 }, label: 'Back' },
      { index: 1, rect: { x: 0, y: 300, width: 100, height: 50 }, label: 'Go', contentDescription: 'Back' },
    ];
    expect(chooseSelector(nodes[0], nodes, somewhere, viewport)).toEqual({ kind: 'text', value: 'Back', index: 0 });
  });

  it('falls back to contentDescription when there is no label', () => {
    const nodes: SelectorNode[] = [{ index: 0, rect: { x: 0, y: 0, width: 10, height: 10 }, contentDescription: 'Close' }];
    expect(chooseSelector(nodes[0], nodes, somewhere, viewport)).toEqual({ kind: 'text', value: 'Close' });
  });

  it('falls back to a point for texts of 80 characters or more', () => {
    const long = 'x'.repeat(80);
    const nodes: SelectorNode[] = [{ index: 0, rect: { x: 0, y: 0, width: 10, height: 10 }, label: long }];
    expect(chooseSelector(nodes[0], nodes, { x: 108, y: 600 }, viewport)).toEqual({
      kind: 'point',
      xPercent: 10,
      yPercent: 25,
    });
    const shorter = 'y'.repeat(79);
    expect(chooseSelector({ ...nodes[0], label: shorter }, [{ ...nodes[0], label: shorter }], somewhere, viewport)).toEqual({
      kind: 'text',
      value: shorter,
    });
  });

  it('falls back to a point when the node has no rect or there is no node', () => {
    const nodes: SelectorNode[] = [{ index: 0, label: 'Floating' }];
    expect(chooseSelector(nodes[0], nodes, { x: 540, y: 1200 }, viewport)).toEqual({
      kind: 'point',
      xPercent: 50,
      yPercent: 50,
    });
    expect(chooseSelector(undefined, nodes, { x: 1079, y: 1 }, viewport)).toEqual({
      kind: 'point',
      xPercent: 100,
      yPercent: 0,
    });
  });
});
