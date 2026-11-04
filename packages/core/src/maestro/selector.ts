import type { HitTestNode, Point, Viewport } from '../device/hit-test.ts';
import { escapeMaestroRegex } from './escape.ts';
import type { MaestroSelector, PercentPoint } from './model.ts';

/*
 * Selector mapping from an agent-device Android snapshot node to a Maestro selector.
 *
 * What the snapshot actually contains on Android (dumped from the Settings app on
 * an Android 16 emulator with agent-device 0.21.35):
 *   - `identifier` is the full Android resource-id, e.g. "android:id/title" or
 *     "com.android.settings:id/search_bar_title". Maestro's `id` matches the full
 *     resource-id, so it is emitted unchanged apart from regex escaping.
 *   - There is no `text` field (SnapshotNode in 0.21.35 does not define one).
 *     The visible text of a TextView arrives in `label`; `label` falls back to
 *     the content description when a view has no text, and `contentDescription`
 *     is only set when it differs from `label`. `text` is still read first so
 *     a future snapshot that adds it, or another platform, is handled.
 *   - `role` is never set; `kind` ("text", "group", ...) and `type` (class name)
 *     carry the role instead. Selector choice does not need either.
 *   - Framework ids are shared across rows: every Settings entry title is
 *     "android:id/title" and every summary "android:id/summary".
 *
 * Maestro semantics this has to respect (Maestro 2.12):
 *   - `id` and `text` are regular expressions matched against the whole value,
 *     case-insensitively. `text` also matches the content description and hint.
 *   - `index` picks among all matches sorted top to bottom, then left to right.
 *   - A node that contains another match is not a match itself: Maestro keeps
 *     the deepest one. A React Native tab is a labelled button holding a text
 *     with the same words, and that counts once.
 *
 * Mapping, in order (first that applies wins):
 *   1. Own `identifier` when no other node on screen matches it  -> { id }
 *   2. Own name (`text`, then `label`, then `contentDescription`; trimmed,
 *      non-empty, under 80 characters) when it is unique on screen -> { text }
 *   3. Otherwise, the first descendant in document order with a unique id or
 *      name, skipping descendants that sit inside another hittable node. This
 *      covers containers: a Settings row is a hittable LinearLayout with no id
 *      or text whose title TextView is unique. Maestro taps the descendant's
 *      centre, which lands inside the same container.            -> { id } or { text }
 *   4. Own `identifier` shared with other nodes                     -> { id, index }
 *   5. Own name shared with other nodes                             -> { text, index }
 *   6. Otherwise the tap point as viewport percentages              -> { point }
 *
 * Steps 1 and 4 are the spec's "identifier first" rule; the change from the
 * spec is that a unique name (2, 3) beats a shared identifier with an index,
 * because shared framework ids such as "android:id/title" turn every list tap
 * into a positional selector that breaks as soon as a row is added.
 *
 * Index values follow Maestro's ordering (top to bottom, then left to right)
 * rather than document order, so the index Maestro computes on replay is the
 * index recorded here.
 */

export const MAX_TEXT_SELECTOR_LENGTH = 80;

export type SelectorNode = HitTestNode & {
  index?: number;
  parentIndex?: number;
  placeholder?: string;
};

type Candidate = { kind: 'id' | 'text'; value: string };

function normalizeText(value: string): string {
  return value.replace(/\n/g, ' ').trim().toLowerCase();
}

function idMatches(node: SelectorNode, id: string): boolean {
  const own = node.identifier?.trim();
  if (!own) return false;
  const want = id.toLowerCase();
  const full = own.toLowerCase();
  // Maestro also accepts the part after the slash, so "title" would match
  // "android:id/title". We always emit the full id, but count those matches too.
  return full === want || full.slice(full.indexOf('/') + 1) === want;
}

function textMatches(node: SelectorNode, text: string): boolean {
  const want = normalizeText(text);
  return [node.text, node.label, node.contentDescription, node.placeholder].some(
    (value) => value !== undefined && normalizeText(value) === want,
  );
}

function matchesCandidate(node: SelectorNode, candidate: Candidate): boolean {
  return candidate.kind === 'id' ? idMatches(node, candidate.value) : textMatches(node, candidate.value);
}

/** The node's own usable name: text, then label, then content description. */
export function nameOf(node: SelectorNode): string | undefined {
  for (const value of [node.text, node.label, node.contentDescription]) {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length < MAX_TEXT_SELECTOR_LENGTH) return trimmed;
  }
  return undefined;
}

function idOf(node: SelectorNode): string | undefined {
  const trimmed = node.identifier?.trim();
  return trimmed ? trimmed : undefined;
}

function nodesByIndex(allNodes: readonly SelectorNode[]): Map<number, SelectorNode> {
  const byIndex = new Map<number, SelectorNode>();
  for (const node of allNodes) {
    if (node.index !== undefined) byIndex.set(node.index, node);
  }
  return byIndex;
}

/** The nodes above `node` in the snapshot tree, nearest first. */
function ancestorsOf(node: SelectorNode, byIndex: ReadonlyMap<number, SelectorNode>): SelectorNode[] {
  const ancestors: SelectorNode[] = [];
  let parent = node.parentIndex === undefined ? undefined : byIndex.get(node.parentIndex);
  while (parent) {
    ancestors.push(parent);
    parent = parent.parentIndex === undefined ? undefined : byIndex.get(parent.parentIndex);
  }
  return ancestors;
}

/** All matches for a candidate, deepest only, in Maestro's index order (y, then x, then document order). */
function orderedMatches(allNodes: readonly SelectorNode[], candidate: Candidate): SelectorNode[] {
  const byIndex = nodesByIndex(allNodes);
  const matches = allNodes.filter((node) => matchesCandidate(node, candidate));
  const containers = new Set(matches.flatMap((node) => ancestorsOf(node, byIndex)));
  return matches
    .map((node, order) => ({ node, order }))
    .filter(({ node }) => !containers.has(node))
    .sort(
      (a, b) =>
        (a.node.rect?.y ?? 0) - (b.node.rect?.y ?? 0) ||
        (a.node.rect?.x ?? 0) - (b.node.rect?.x ?? 0) ||
        a.order - b.order,
    )
    .map(({ node }) => node);
}

function isSameNode(a: SelectorNode, b: SelectorNode): boolean {
  if (a === b) return true;
  return a.index !== undefined && a.index === b.index;
}

function toSelector(candidate: Candidate, index?: number): MaestroSelector {
  const value = escapeMaestroRegex(candidate.value);
  return index === undefined ? { kind: candidate.kind, value } : { kind: candidate.kind, value, index };
}

/** Unique selector for the node itself, or undefined when its id and name are both shared or absent. */
function uniqueOwnSelector(node: SelectorNode, allNodes: readonly SelectorNode[]): MaestroSelector | undefined {
  const id = idOf(node);
  if (id && orderedMatches(allNodes, { kind: 'id', value: id }).length <= 1) {
    return toSelector({ kind: 'id', value: id });
  }
  const name = nameOf(node);
  if (name && orderedMatches(allNodes, { kind: 'text', value: name }).length <= 1) {
    return toSelector({ kind: 'text', value: name });
  }
  return undefined;
}

function indexedSelector(
  node: SelectorNode,
  allNodes: readonly SelectorNode[],
  candidate: Candidate,
): MaestroSelector | undefined {
  const matches = orderedMatches(allNodes, candidate);
  const byIndex = nodesByIndex(allNodes);
  // A container of a match is not a match: its index is the one of the match inside it.
  const position = matches.findIndex((match) => isSameNode(match, node) || ancestorsOf(match, byIndex).some((above) => isSameNode(above, node)));
  if (position < 0) return undefined;
  return toSelector(candidate, matches.length > 1 ? position : undefined);
}

/** Descendants of `node` in document order, skipping anything owned by a nested hittable node. */
function ownedDescendants(node: SelectorNode, allNodes: readonly SelectorNode[]): SelectorNode[] {
  if (node.index === undefined) return [];
  const byIndex = nodesByIndex(allNodes);
  const result: SelectorNode[] = [];
  for (const candidate of allNodes) {
    if (candidate === node || candidate.hittable === true) continue;
    let parentIndex = candidate.parentIndex;
    let owned = false;
    // Walk up until we reach `node` (owned) or a hittable ancestor (a different target).
    while (parentIndex !== undefined) {
      if (parentIndex === node.index) {
        owned = true;
        break;
      }
      const parent = byIndex.get(parentIndex);
      if (!parent || parent.hittable === true) break;
      parentIndex = parent.parentIndex;
    }
    if (owned) result.push(candidate);
  }
  return result;
}

/** A point in viewport pixels as whole percentages of the screen, clamped to 0..100. */
export function percentOfScreen(point: Point, viewport: Viewport): PercentPoint {
  const clamp = (value: number) => Math.min(100, Math.max(0, Math.round(value)));
  return {
    xPercent: clamp((point.x / viewport.width) * 100),
    yPercent: clamp((point.y / viewport.height) * 100),
  };
}

/** The viewport pixel a percentage point stands for, inside the screen. */
export function pointOnScreen(point: PercentPoint, viewport: Viewport): Point {
  return {
    x: Math.min(viewport.width - 1, Math.round((point.xPercent / 100) * viewport.width)),
    y: Math.min(viewport.height - 1, Math.round((point.yPercent / 100) * viewport.height)),
  };
}

function pointSelector(point: Point, viewport: Viewport): MaestroSelector {
  return { kind: 'point', ...percentOfScreen(point, viewport) };
}

/**
 * Chooses the Maestro selector for a tap on `node` (or at `point` when no node
 * was resolved). `allNodes` is the full snapshot the node came from; it is used
 * for uniqueness checks and indexes. `point` and `viewport` are viewport pixels.
 */
export function chooseSelector(
  node: SelectorNode | undefined,
  allNodes: readonly SelectorNode[],
  point: Point,
  viewport: Viewport,
): MaestroSelector {
  if (!node || !node.rect) return pointSelector(point, viewport);

  const own = uniqueOwnSelector(node, allNodes);
  if (own) return own;

  for (const descendant of ownedDescendants(node, allNodes)) {
    if (!descendant.rect) continue;
    const selector = uniqueOwnSelector(descendant, allNodes);
    if (selector) return selector;
  }

  const id = idOf(node);
  if (id) {
    const selector = indexedSelector(node, allNodes, { kind: 'id', value: id });
    if (selector) return selector;
  }
  const name = nameOf(node);
  if (name) {
    const selector = indexedSelector(node, allNodes, { kind: 'text', value: name });
    if (selector) return selector;
  }
  return pointSelector(point, viewport);
}
