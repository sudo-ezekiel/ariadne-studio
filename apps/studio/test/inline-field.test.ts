// Typing straight into the screen: which field gets the text box, where the box
// goes on the mirror, and the flags the server passes on for it.
import type { DeviceSnapshot } from '@ariadne/core';
import { describe, expect, it } from 'vitest';
import { toLiteNode } from '../src/server/state.ts';
import type { SnapshotNodeLite } from '../src/shared/api-types.ts';
import { fieldKey, focusedField, INLINE_MIN_HEIGHT, INLINE_MIN_WIDTH, inlineBox } from '../src/ui/components/inline-field.ts';

type SnapshotNode = DeviceSnapshot['nodes'][number];

const rect = { x: 100, y: 400, width: 880, height: 140 };

describe('focusedField', () => {
  it('is the focused node that takes text', () => {
    const nodes: SnapshotNodeLite[] = [
      { label: 'Title', rect: { x: 0, y: 0, width: 100, height: 50 } },
      { label: 'Email', focused: true, editable: true, rect },
    ];
    expect(focusedField(nodes)?.label).toBe('Email');
  });

  it('counts a focused password field even when it is not marked editable', () => {
    const nodes: SnapshotNodeLite[] = [{ label: 'Password', focused: true, password: true, rect }];
    expect(focusedField(nodes)?.label).toBe('Password');
  });

  it('skips a focused node that takes no text, and a field without focus', () => {
    const nodes: SnapshotNodeLite[] = [
      { label: 'Save', focused: true, rect },
      { label: 'Email', editable: true, rect },
      { label: 'Password', password: true, rect },
    ];
    expect(focusedField(nodes)).toBeUndefined();
  });

  it('skips a focused field with no place on the screen', () => {
    expect(focusedField([{ focused: true, editable: true }])).toBeUndefined();
    expect(focusedField([{ focused: true, editable: true, rect: { x: 10, y: 10, width: 0, height: 40 } }])).toBeUndefined();
  });
});

describe('fieldKey', () => {
  const email: SnapshotNodeLite = { identifier: 'input', label: 'Email', focused: true, editable: true, rect };

  it('differs between a password field and a plain field that share an identifier', () => {
    expect(fieldKey({ ...email, password: true })).not.toBe(fieldKey(email));
  });

  it('keeps the key of the same field at another place, since a field moves when the keyboard opens', () => {
    expect(fieldKey({ ...email, rect: { ...rect, y: 100 } })).toBe(fieldKey(email));
  });

  it('keeps the key when only the focus changes', () => {
    expect(fieldKey({ ...email, focused: false })).toBe(fieldKey(email));
  });

  it('changes with the label', () => {
    expect(fieldKey({ ...email, label: 'Username' })).not.toBe(fieldKey(email));
  });

  it('changes with the content description', () => {
    expect(fieldKey({ ...email, contentDescription: 'Work email' })).not.toBe(fieldKey(email));
  });

  it('changes with the identifier and the role', () => {
    expect(fieldKey({ ...email, identifier: 'other' })).not.toBe(fieldKey(email));
    expect(fieldKey({ ...email, role: 'search' })).not.toBe(fieldKey(email));
  });

  it('does not run two different fields together when one value is empty', () => {
    expect(fieldKey({ label: 'ab' })).not.toBe(fieldKey({ identifier: 'a', label: 'b' }));
  });
});

describe('inlineBox', () => {
  const screen = { width: 1080, height: 2400 };

  it('scales the field into the mirror like the hover outline', () => {
    const mirror = { width: 540, height: 1200 };
    expect(inlineBox(screen, mirror, rect)).toEqual({ left: 50, top: 200, width: 440, height: 70 });
  });

  it('grows a field drawn too small around its centre', () => {
    const mirror = { width: 270, height: 600 };
    const small = { x: 500, y: 1000, width: 80, height: 40 };
    const box = inlineBox(screen, mirror, small);
    expect(box.height).toBe(INLINE_MIN_HEIGHT);
    expect(box.width).toBe(INLINE_MIN_WIDTH);
    // The field's centre is at (135, 255) on this mirror.
    expect(box.left + box.width / 2).toBeCloseTo(135);
    expect(box.top + box.height / 2).toBeCloseTo(255);
  });

  it('keeps a grown box inside the mirror at the edges', () => {
    const mirror = { width: 270, height: 600 };
    const corner = inlineBox(screen, mirror, { x: 0, y: 0, width: 40, height: 20 });
    expect(corner.left).toBe(0);
    expect(corner.top).toBe(0);
    const bottomRight = inlineBox(screen, mirror, { x: 1040, y: 2380, width: 40, height: 20 });
    expect(bottomRight.left + bottomRight.width).toBe(270);
    expect(bottomRight.top + bottomRight.height).toBe(600);
  });

  it('never grows past the mirror itself', () => {
    const box = inlineBox(screen, { width: 60, height: 20 }, rect);
    expect(box.width).toBe(60);
    expect(box.height).toBe(20);
    expect(box.left).toBe(0);
    expect(box.top).toBe(0);
  });
});

describe('toLiteNode', () => {
  const base = { index: 0, depth: 1, rect, label: 'Email' } as SnapshotNode;

  it('passes focused, editable and password on when they are true', () => {
    const lite = toLiteNode({ ...base, focused: true, editable: true, password: true });
    expect(lite).toMatchObject({ focused: true, editable: true, password: true });
  });

  it('leaves them out when they are false or missing', () => {
    const lite = toLiteNode({ ...base, focused: false, editable: false, password: false });
    expect(lite).not.toHaveProperty('focused');
    expect(lite).not.toHaveProperty('editable');
    expect(lite).not.toHaveProperty('password');
    expect(toLiteNode(base)).toEqual({ label: 'Email', rect });
  });
});
