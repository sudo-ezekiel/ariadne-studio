// placeBlock decides where a dragged setup block lands in the stack. `at` is
// the insertion index the drop indicator showed, counted in the list before
// the move, so moving a piece down leaves a gap that placeBlock closes.
import { describe, expect, it } from 'vitest';
import { placeBlock } from '../src/ui/components/block-order.ts';

const A = 'blocks/a.yaml';
const B = 'blocks/b.yaml';
const C = 'blocks/c.yaml';
const NEW = 'blocks/new.yaml';

const lane = (): readonly string[] => Object.freeze([A, B, C]);
const fromPalette = { file: NEW, from: null } as const;
const moving = (from: number) => ({ file: lane()[from]!, from });

describe('placeBlock from the palette', () => {
  it('inserts at the start', () => {
    expect(placeBlock(lane(), fromPalette, 0)).toEqual([NEW, A, B, C]);
  });

  it('inserts in the middle, before the piece at that index', () => {
    expect(placeBlock(lane(), fromPalette, 1)).toEqual([A, NEW, B, C]);
    expect(placeBlock(lane(), fromPalette, 2)).toEqual([A, B, NEW, C]);
  });

  it('inserts at the end', () => {
    expect(placeBlock(lane(), fromPalette, 3)).toEqual([A, B, C, NEW]);
  });

  it('fills an empty stack', () => {
    expect(placeBlock([], fromPalette, 0)).toEqual([NEW]);
  });

  it('appends when the index is past the end', () => {
    expect(placeBlock(lane(), fromPalette, 10)).toEqual([A, B, C, NEW]);
  });

  it('allows the same block twice', () => {
    expect(placeBlock(lane(), { file: B, from: null }, 3)).toEqual([A, B, C, B]);
  });
});

describe('placeBlock moving a piece', () => {
  it('moves the first piece to the very end (from 0, at 3 in a list of 3)', () => {
    expect(placeBlock(lane(), moving(0), 3)).toEqual([B, C, A]);
  });

  it('moves a piece down to the middle', () => {
    expect(placeBlock(lane(), moving(0), 2)).toEqual([B, A, C]);
    expect(placeBlock(lane(), moving(1), 3)).toEqual([A, C, B]);
  });

  it('moves a piece up', () => {
    expect(placeBlock(lane(), moving(2), 0)).toEqual([C, A, B]);
    expect(placeBlock(lane(), moving(2), 1)).toEqual([A, C, B]);
    expect(placeBlock(lane(), moving(1), 0)).toEqual([B, A, C]);
  });

  it('leaves the list as it was when a piece is dropped on its own position', () => {
    for (let from = 0; from < 3; from++) {
      for (const at of [from, from + 1]) {
        const result = placeBlock(lane(), moving(from), at);
        expect(result, `from ${from} at ${at}`).toEqual([A, B, C]);
      }
    }
  });

  it('moves one step with the arrow buttons: up is index - 1, down is index + 2', () => {
    expect(placeBlock(lane(), moving(1), 0)).toEqual([B, A, C]);
    expect(placeBlock(lane(), moving(2), 1)).toEqual([A, C, B]);
    expect(placeBlock(lane(), moving(0), 2)).toEqual([B, A, C]);
    expect(placeBlock(lane(), moving(1), 3)).toEqual([A, C, B]);
  });

  it('keeps duplicates apart by position', () => {
    const doubled = [A, B, A];
    expect(placeBlock(doubled, { file: A, from: 2 }, 0)).toEqual([A, A, B]);
    expect(placeBlock(doubled, { file: A, from: 0 }, 3)).toEqual([B, A, A]);
  });

  it('returns the list unchanged when the piece to move does not exist', () => {
    expect(placeBlock(lane(), { file: A, from: 5 }, 0)).toEqual([A, B, C]);
    expect(placeBlock([], { file: A, from: 0 }, 0)).toEqual([]);
  });

  it('puts the moved piece where the drop indicator was, for every start and drop index', () => {
    const items = ['w', 'x', 'y', 'z'];
    for (let from = 0; from < items.length; from++) {
      for (let at = 0; at <= items.length; at++) {
        const result = placeBlock(items, { file: items[from]!, from }, at);
        const where = `from ${from} at ${at}`;
        // Same pieces, none lost or doubled.
        expect([...result].sort(), where).toEqual([...items].sort());
        // The moved piece sits immediately before the piece that was at `at`,
        // or last when `at` is the end of the list.
        const landed = result.indexOf(items[from]!);
        expect(landed, where).toBe(at > from ? at - 1 : at);
        // Everything else keeps its order.
        expect(result.filter((item) => item !== items[from]), where).toEqual(items.filter((item) => item !== items[from]));
        // Only the two drops that mean "where it already is" change nothing.
        const unchanged = result.join('') === items.join('');
        expect(unchanged, where).toBe(at === from || at === from + 1);
      }
    }
  });
});

describe('placeBlock does not touch its input', () => {
  it('returns a new array and leaves a frozen input as it was, for an insert and for a move', () => {
    const input = lane();
    const inserted = placeBlock(input, fromPalette, 1);
    const moved = placeBlock(input, moving(0), 3);
    const dropped = placeBlock(input, moving(1), 1);
    expect(input).toEqual([A, B, C]);
    expect(inserted).not.toBe(input);
    expect(moved).not.toBe(input);
    expect(dropped).not.toBe(input);
    expect(Object.isFrozen(input)).toBe(true);
  });
});

// The stack keeps each block's values beside its file, so the lane holds
// { file, values? } pieces and a new piece is built from the dragged file.
describe('placeBlock with pieces that are objects', () => {
  type Use = { file: string; values?: Record<string, string> };
  const make = (file: string): Use => ({ file });
  const supervisor = { USERNAME: '${SUPERVISOR_USERNAME}', PASSWORD: '${SUPERVISOR_PASSWORD}' };
  const useA: Use = { file: A, values: supervisor };
  const useB: Use = { file: B };
  const useC: Use = { file: C, values: { COUNTRY: 'GR' } };
  const uses = (): readonly Use[] => Object.freeze([useA, useB, useC]);
  const movingUse = (from: number) => ({ file: uses()[from]!.file, from });

  it('builds the new piece with make, at the start, in the middle and at the end', () => {
    expect(placeBlock(uses(), fromPalette, 0, make)).toEqual([{ file: NEW }, useA, useB, useC]);
    expect(placeBlock(uses(), fromPalette, 1, make)).toEqual([useA, { file: NEW }, useB, useC]);
    expect(placeBlock(uses(), fromPalette, 3, make)).toEqual([useA, useB, useC, { file: NEW }]);
  });

  it('passes make the dragged file, once, and only when a new piece is placed', () => {
    const files: string[] = [];
    const spy = (file: string): Use => {
      files.push(file);
      return { file };
    };
    placeBlock(uses(), fromPalette, 1, spy);
    expect(files).toEqual([NEW]);
    placeBlock(uses(), movingUse(0), 3, spy);
    expect(files).toEqual([NEW]);
  });

  it('places whatever make returns, values included', () => {
    const withDefaults = (file: string): Use => ({ file, values: { USERNAME: '${AGENT_USERNAME}' } });
    expect(placeBlock([], fromPalette, 0, withDefaults)).toEqual([{ file: NEW, values: { USERNAME: '${AGENT_USERNAME}' } }]);
  });

  it('fills an empty stack and appends past the end', () => {
    expect(placeBlock<Use>([], fromPalette, 0, make)).toEqual([{ file: NEW }]);
    expect(placeBlock(uses(), fromPalette, 10, make)).toEqual([useA, useB, useC, { file: NEW }]);
  });

  it('moves a piece with its values, and does not call make', () => {
    expect(placeBlock(uses(), movingUse(0), 3, make)).toEqual([useB, useC, useA]);
    expect(placeBlock(uses(), movingUse(2), 0, make)).toEqual([useC, useA, useB]);
    expect(placeBlock(uses(), movingUse(1), 3, make)).toEqual([useA, useC, useB]);
  });

  it('moves the very pieces, not copies of them', () => {
    const result = placeBlock(uses(), movingUse(0), 3, make);
    expect(result[2]).toBe(useA);
    expect(result[2]!.values).toBe(supervisor);
    expect(result[0]).toBe(useB);
  });

  it('keeps the other pieces by identity when one is inserted', () => {
    const result = placeBlock(uses(), fromPalette, 1, make);
    expect(result[0]).toBe(useA);
    expect(result[2]).toBe(useB);
    expect(result[3]).toBe(useC);
  });

  it('keeps two pieces for the same file apart by position', () => {
    const first: Use = { file: A, values: { USERNAME: '${AGENT_USERNAME}' } };
    const second: Use = { file: A, values: { USERNAME: '${SUPERVISOR_USERNAME}' } };
    const lane = [first, useB, second];
    expect(placeBlock(lane, { file: A, from: 2 }, 0, make)).toEqual([second, first, useB]);
    expect(placeBlock(lane, { file: A, from: 0 }, 3, make)).toEqual([useB, second, first]);
    expect(placeBlock(lane, { file: A, from: null }, 1, make).map((use) => use.values)).toEqual([first.values, undefined, useB.values, second.values]);
  });

  it('leaves the lane unchanged when a piece is dropped on its own position', () => {
    for (let from = 0; from < 3; from++) {
      for (const at of [from, from + 1]) {
        expect(placeBlock(uses(), movingUse(from), at, make), `from ${from} at ${at}`).toEqual([useA, useB, useC]);
      }
    }
  });

  it('returns the lane unchanged when the piece to move does not exist', () => {
    expect(placeBlock(uses(), { file: A, from: 5 }, 0, make)).toEqual([useA, useB, useC]);
    expect(placeBlock<Use>([], { file: A, from: 0 }, 0, make)).toEqual([]);
  });

  it('puts the moved piece where the drop indicator was, for every start and drop index', () => {
    const lane: Use[] = ['w', 'x', 'y', 'z'].map((file) => ({ file, values: { KEY: file } }));
    for (let from = 0; from < lane.length; from++) {
      for (let at = 0; at <= lane.length; at++) {
        const result = placeBlock(lane, { file: lane[from]!.file, from }, at, make);
        const where = `from ${from} at ${at}`;
        expect(result, where).toHaveLength(lane.length);
        expect(result.indexOf(lane[from]!), where).toBe(at > from ? at - 1 : at);
        expect(result.filter((use) => use !== lane[from]), where).toEqual(lane.filter((use) => use !== lane[from]));
      }
    }
  });

  it('does not touch a frozen lane or the pieces in it', () => {
    const input = uses();
    const inserted = placeBlock(input, fromPalette, 1, make);
    const moved = placeBlock(input, movingUse(0), 3, make);
    expect(input).toEqual([useA, useB, useC]);
    expect(inserted).not.toBe(input);
    expect(moved).not.toBe(input);
    expect(useA.values).toEqual(supervisor);
  });

  it('keeps the string default for string lanes when make is left out', () => {
    expect(placeBlock([A, B], fromPalette, 1)).toEqual([A, NEW, B]);
    expect(placeBlock<string>([A, B], fromPalette, 2, (file) => file.toUpperCase())).toEqual([A, B, NEW.toUpperCase()]);
  });
});
