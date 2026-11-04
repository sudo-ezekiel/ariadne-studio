// Expectation picker: which on-screen texts are worth asserting at the end of
// a case. Pure (no Node imports), so it can be shared with the browser later.
import { rectCenter, type Viewport } from '../device/hit-test.ts';
import { escapeMaestroRegex } from '../maestro/escape.ts';
import type { MaestroSelector } from '../maestro/model.ts';
import { chooseSelector, nameOf, type SelectorNode } from '../maestro/selector.ts';
import type { RecordedNode } from './case-types.ts';
import { recordedNode } from './recorded-node.ts';

export type ExpectationNode = SelectorNode & {
  editable?: boolean;
  password?: boolean;
  keyboardOwned?: boolean;
};

export type ExpectationCandidate = {
  /** Position in the returned list; stable for the same snapshot. */
  id: number;
  selector: MaestroSelector;
  node: RecordedNode;
  /** The visible name, for the picker. */
  label: string;
};

export const MAX_EXPECTATION_CANDIDATES = 12;

const PUNCTUATION_OR_NUMBER = /^[\d\s.,:/+-]+$/;
const TIME = /\b\d{1,2}:\d{2}\b/;
const DATE = /\b\d{1,4}[./-]\d{1,2}([./-]\d{1,4})?\b/;
const CURRENCY = /[€$£]\s?\d|\d\s?(€|\$|£|EUR|USD)/;
const PERCENTAGE = /\d\s?%/;

/**
 * True for names that are likely to differ on the next run: very short
 * strings, numbers, times, dates, amounts, percentages, and anything that is
 * more than a third digits (counters, ids, phone numbers).
 */
export function isVolatileName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 3) return true;
  if (PUNCTUATION_OR_NUMBER.test(trimmed)) return true;
  if (TIME.test(trimmed) || DATE.test(trimmed) || CURRENCY.test(trimmed) || PERCENTAGE.test(trimmed)) return true;
  const digits = trimmed.replace(/\D/g, '').length;
  return digits > trimmed.length / 3;
}

function fullyInside(node: ExpectationNode, viewport: Viewport): boolean {
  const rect = node.rect;
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height;
}

/**
 * chooseSelector may borrow a descendant's id or name for a container. The
 * picker shows the node's own name, so only a selector for the node itself
 * says what the BA ticked.
 */
function ownSelector(node: ExpectationNode, label: string, selector: MaestroSelector): boolean {
  if (selector.kind === 'id') return selector.value === escapeMaestroRegex(node.identifier?.trim() ?? '');
  if (selector.kind === 'text') return selector.value === escapeMaestroRegex(label);
  return false;
}

/**
 * Named, stable, fully visible elements a BA can assert at the end of a case,
 * top of the screen first. Only `id` and `text` selectors that are unique on
 * screen (no `index`) are offered: an indexed or positional assertion breaks
 * as soon as the list changes.
 */
export function expectationCandidates(nodes: readonly ExpectationNode[], viewport: Viewport): ExpectationCandidate[] {
  const kept: Array<{ node: ExpectationNode; selector: MaestroSelector; label: string; order: number }> = [];
  nodes.forEach((node, order) => {
    if (node.systemBar !== undefined || node.visibleToUser === false || node.interactionBlocked !== undefined) return;
    if (node.editable === true || node.password === true || node.keyboardOwned === true) return;
    if (!fullyInside(node, viewport)) return;
    const label = nameOf(node);
    if (!label || isVolatileName(label)) return;
    const selector = chooseSelector(node, nodes, rectCenter(node.rect!), viewport);
    if (selector.kind === 'point' || selector.index !== undefined || !ownSelector(node, label, selector)) return;
    kept.push({ node, selector, label, order });
  });
  kept.sort((a, b) => a.node.rect!.y - b.node.rect!.y || b.node.rect!.height - a.node.rect!.height || a.order - b.order);
  const seen = new Set<string>();
  const candidates: ExpectationCandidate[] = [];
  for (const { node, selector, label } of kept) {
    if (selector.kind === 'point') continue;
    const key = `${selector.kind}:${selector.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ id: candidates.length, selector, node: recordedNode(node), label });
    if (candidates.length === MAX_EXPECTATION_CANDIDATES) break;
  }
  return candidates;
}
