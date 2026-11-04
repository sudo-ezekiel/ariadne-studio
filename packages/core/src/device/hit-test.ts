// Pure hit testing over snapshot nodes. This module must stay free of runtime
// imports: the studio UI bundles it for the hover outline, and the server uses
// it to resolve taps, so both sides agree on which node a click means.

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type Viewport = { width: number; height: number };

/**
 * The node fields hit testing and selector choice read. Structurally a subset
 * of agent-device's SnapshotNode, so real snapshot nodes and the studio's
 * lite nodes both satisfy it.
 */
export type HitTestNode = {
  rect?: Rect;
  visibleToUser?: boolean;
  systemBar?: 'status' | 'navigation';
  interactionBlocked?: 'covered';
  hittable?: boolean;
  identifier?: string;
  text?: string;
  label?: string;
  contentDescription?: string;
  depth?: number;
};

export function rectContains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x < rect.x + rect.width &&
    point.y < rect.y + rect.height
  );
}

export function rectCenter(rect: Rect): Point {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

function hasName(node: HitTestNode): boolean {
  return Boolean(
    node.identifier?.trim() || node.text?.trim() || node.label?.trim() || node.contentDescription?.trim(),
  );
}

/** Over this share of the screen, a node with no visible name is the background, not a control. */
const SCREEN_CONTAINER_SHARE = 0.6;

/**
 * True for a node that is really the screen itself: it fills most of it and
 * has at most an id, like the `root` of a WebView. A touch that lands on one
 * fell between controls, and its centre is some other control.
 */
export function isScreenContainer(node: HitTestNode, viewport: Viewport): boolean {
  if (!node.rect || node.text?.trim() || node.label?.trim() || node.contentDescription?.trim()) return false;
  return node.rect.width * node.rect.height >= SCREEN_CONTAINER_SHARE * viewport.width * viewport.height;
}

/** What a tap at `point` presses: the node resolveNodeAt finds, unless that is the screen itself. */
export function resolveTapTarget<T extends HitTestNode>(nodes: readonly T[], point: Point, viewport: Viewport): T | undefined {
  const node = resolveNodeAt(nodes, point);
  return node && isScreenContainer(node, viewport) ? undefined : node;
}

/**
 * Finds the node a tap at `point` (viewport pixels) is aimed at: the smallest
 * visible, unobstructed, app-owned node under the point that is either
 * hittable or carries a name. Ties on area go to the deeper node, then to the
 * later node in document order (a child follows its parent), which keeps the
 * answer stable for lite nodes that carry no depth.
 */
export function resolveNodeAt<T extends HitTestNode>(nodes: readonly T[], point: Point): T | undefined {
  const candidates: Array<{ node: T; order: number }> = [];
  nodes.forEach((node, order) => {
    if (!node.rect || node.rect.width <= 0 || node.rect.height <= 0) return;
    if (node.visibleToUser === false) return;
    if (node.systemBar !== undefined) return;
    if (node.interactionBlocked !== undefined) return;
    if (!rectContains(node.rect, point)) return;
    candidates.push({ node, order });
  });

  const preferred = candidates.filter(({ node }) => node.hittable === true || hasName(node));
  if (preferred.length === 0) return undefined;

  let best = preferred[0]!;
  for (const candidate of preferred.slice(1)) {
    const area = candidate.node.rect!.width * candidate.node.rect!.height;
    const bestArea = best.node.rect!.width * best.node.rect!.height;
    if (area < bestArea) {
      best = candidate;
      continue;
    }
    if (area > bestArea) continue;
    const depth = candidate.node.depth ?? -1;
    const bestDepth = best.node.depth ?? -1;
    if (depth > bestDepth || (depth === bestDepth && candidate.order > best.order)) {
      best = candidate;
    }
  }
  return best.node;
}
