// The text box drawn over the field that has focus on the device, so a tester
// types straight into the screen. Pure, so which field counts and where the box
// goes are tested without a browser.
import type { Rect } from '@ariadne/core/hit-test';
import type { SnapshotNodeLite } from '../../shared/api-types.ts';

/** The box never gets shorter than this (CSS pixels), however small the field is drawn. */
export const INLINE_MIN_HEIGHT = 28;

/** Nor narrower than this, so a placeholder still fits. */
export const INLINE_MIN_WIDTH = 96;

type Size = { width: number; height: number };

/** The field that has focus and takes text, if the screen reports one with a place on it. */
export function focusedField(nodes: readonly SnapshotNodeLite[]): (SnapshotNodeLite & { rect: Rect }) | undefined {
  return nodes.find(
    (node): node is SnapshotNodeLite & { rect: Rect } =>
      node.focused === true && takesText(node) && node.rect !== undefined && node.rect.width > 0 && node.rect.height > 0,
  );
}

function takesText(node: SnapshotNodeLite): boolean {
  return node.editable === true || node.password === true;
}

/**
 * Which field of `nodes` the text in the box was typed for. When the focus moves to another field
 * the text is dropped, so it is never typed into that field, and a password never shows in a plain
 * box. Neither the place nor the label counts: a field moves when the keyboard opens, and on Android
 * a field's label is the text in it. Fields alike in all else are told apart by their order.
 */
export function fieldKey(nodes: readonly SnapshotNodeLite[], field: SnapshotNodeLite): string {
  const traits = (node: SnapshotNodeLite) => JSON.stringify([node.identifier ?? '', node.password === true, node.contentDescription ?? '', node.role ?? '']);
  const own = traits(field);
  const order = nodes.filter((node) => takesText(node) && traits(node) === own).indexOf(field);
  return JSON.stringify([own, order]);
}

/**
 * Where the box goes on the mirror, in CSS pixels from its top left corner.
 * `screen` is the device's size (the space node rects use), `mirror` the size the
 * screen is drawn at. A field drawn too small grows around its centre, and the box
 * stays inside the mirror.
 */
export function inlineBox(screen: Size, mirror: Size, rect: Rect): { left: number; top: number; width: number; height: number } {
  const scaleX = mirror.width / screen.width;
  const scaleY = mirror.height / screen.height;
  const width = Math.min(mirror.width, Math.max(INLINE_MIN_WIDTH, rect.width * scaleX));
  const height = Math.min(mirror.height, Math.max(INLINE_MIN_HEIGHT, rect.height * scaleY));
  const centerX = (rect.x + rect.width / 2) * scaleX;
  const centerY = (rect.y + rect.height / 2) * scaleY;
  return {
    left: clamp(centerX - width / 2, 0, mirror.width - width),
    top: clamp(centerY - height / 2, 0, mirror.height - height),
    width,
    height,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
