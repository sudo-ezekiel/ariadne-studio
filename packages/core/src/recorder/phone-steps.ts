// What a touch on the phone meant, given the screens around it. The mirror
// knows the element before it presses; a finger has already pressed by the
// time the studio hears of it, so these rules work from snapshots of the
// screen just before the touch. Pure: the snapshot loop and adb are elsewhere.
import { rectContains, resolveTapTarget, type Point, type Rect, type Viewport } from '../device/hit-test.ts';
import type { TouchGesture } from '../device/touch.ts';
import type { SelectorNode } from '../maestro/selector.ts';
import type { StepReview } from './case-types.ts';

export type PhoneNode = SelectorNode & {
  focused?: boolean;
  editable?: boolean;
  password?: boolean;
  hintShowing?: boolean;
  value?: string;
  bundleId?: string;
  type?: string;
};

export type PhoneScreen = {
  nodes: readonly PhoneNode[];
  viewport: Viewport;
  keyboard?: Rect;
  startedAt: number;
  endedAt: number;
};

/** The screens a gesture is read against. */
export type GestureScreens = {
  /** The last screen finished before the finger came down. */
  before: PhoneScreen;
  /** The one before that, to see whether the screen was still moving. */
  prior?: PhoneScreen;
  /** The first one started after the finger came down, which may show the same screen or the result. */
  atTouch?: PhoneScreen;
  /**
   * A field took focus just before this touch, so its keyboard may be on
   * screen before any snapshot reports it: on the test phone focus showed at
   * 160 ms and the keyboard not until 860 ms.
   */
  keyboardOpening?: boolean;
};

export type TouchSettings = { longPressMs: number; touchSlopPx: number; gestureNavigation: boolean };

export type PhoneAction =
  | { kind: 'tap' | 'longPress'; node?: PhoneNode; point: Point; review?: StepReview }
  | { kind: 'swipe'; from: Point; to: Point; durationMs: number }
  | { kind: 'back' | 'home' | 'recents' }
  /** A key on the on-screen keyboard; `submits` when it is the Enter, Go or Search key. */
  | { kind: 'keyboard'; submits: boolean }
  /** Two fingers or more: Maestro has no command for it. */
  | { kind: 'multiTouch' }
  /** Nothing to record: the status bar, a gap in the navigation bar. */
  | { kind: 'ignored' };

/** A snapshot started this soon after the finger lifted still shows the screen as it was. */
const AT_TOUCH_GRACE_MS = 60;
/** Where gesture navigation's edge swipes start, as shares of the screen. */
const BACK_EDGE_SHARE = 0.04;
const HOME_EDGE_SHARE = 0.97;
/** Below this share of the screen a keyboard may be opening. */
const KEYBOARD_ZONE_SHARE = 0.5;

const NAV_BUTTON = /\/(back|home|recent_apps)$/;
const SUBMIT_KEY_ID = /ime_action|key_enter/i;
const SUBMIT_KEY_LABEL = /^(enter|return|search|go|done|next|send)$/i;

function nodesAt(screen: PhoneScreen, point: Point): PhoneNode[] {
  return screen.nodes.filter((node) => node.rect && rectContains(node.rect, point));
}

function smallest(nodes: readonly PhoneNode[]): PhoneNode | undefined {
  const area = (node: PhoneNode) => (node.rect?.width ?? 0) * (node.rect?.height ?? 0);
  return [...nodes].sort((a, b) => area(a) - area(b))[0];
}

function navButtonAt(screen: PhoneScreen, point: Point): 'back' | 'home' | 'recents' | 'gap' | undefined {
  const hits = nodesAt(screen, point).filter((node) => node.systemBar === 'navigation');
  if (hits.length === 0) return undefined;
  const button = hits.map((node) => NAV_BUTTON.exec(node.identifier ?? '')?.[1]).find(Boolean);
  if (button === 'recent_apps') return 'recents';
  return button === 'back' || button === 'home' ? button : 'gap';
}

/** What identifies an element between two snapshots: if this differs, the tap may have meant something else. */
function targetKey(screen: PhoneScreen, point: Point, withPlace: boolean): string | undefined {
  const node = resolveTapTarget(screen.nodes, point, screen.viewport);
  if (!node) return undefined;
  const name = `${node.identifier ?? ''}|${node.text ?? node.label ?? ''}`;
  return withPlace ? `${name}|${node.rect?.x},${node.rect?.y},${node.rect?.width},${node.rect?.height}` : name;
}

/**
 * True when the element under the finger was not settled. A later snapshot
 * only counts when it names a real element and began before the app could
 * have reacted: right after a tap the tree is often empty, which says nothing.
 */
function screenWasMoving({ before, prior, atTouch }: GestureScreens, point: Point, upAt: number): boolean {
  const key = targetKey(before, point, false);
  if (atTouch && atTouch.startedAt <= upAt + AT_TOUCH_GRACE_MS) {
    const later = targetKey(atTouch, point, false);
    if (later !== undefined && later !== key) return true;
  }
  if (!prior) return false;
  const earlier = targetKey(prior, point, true);
  return earlier !== undefined && earlier !== targetKey(before, point, true);
}

function edgeGesture(gesture: TouchGesture, viewport: Viewport): 'back' | 'home' | undefined {
  const { start, end } = gesture;
  const sideways = Math.abs(end.x - start.x) > Math.abs(end.y - start.y);
  const fromSide = start.x < viewport.width * BACK_EDGE_SHARE || start.x > viewport.width * (1 - BACK_EDGE_SHARE);
  if (fromSide && sideways) return 'back';
  return start.y > viewport.height * HOME_EDGE_SHARE && end.y < start.y ? 'home' : undefined;
}

/** Decides what one finished gesture was. */
export function readGesture(gesture: TouchGesture, screens: GestureScreens, settings: TouchSettings): PhoneAction {
  const { before, atTouch } = screens;
  const point = gesture.start;
  const moved = gesture.travelPx >= settings.touchSlopPx;

  const band = before.keyboard ?? atTouch?.keyboard;
  if (band && rectContains(band, point)) {
    if (moved || gesture.fingers > 1) return { kind: 'keyboard', submits: false };
    const key = smallest(nodesAt(before.keyboard ? before : atTouch!, point));
    const submits = SUBMIT_KEY_ID.test(key?.identifier ?? '') || SUBMIT_KEY_LABEL.test((key?.label ?? '').trim());
    return { kind: 'keyboard', submits };
  }
  // May be a key on a keyboard nothing has reported yet, and a key press must never become a step.
  // Only just after focus: a field stays focused once Back hides the keyboard, with buttons down here.
  if (!band && screens.keyboardOpening && point.y > before.viewport.height * KEYBOARD_ZONE_SHARE) return { kind: 'keyboard', submits: false };
  if (gesture.fingers > 1) return { kind: 'multiTouch' };

  if (settings.gestureNavigation && moved) {
    const edge = edgeGesture(gesture, before.viewport);
    if (edge) return { kind: edge };
  }
  if (!settings.gestureNavigation) {
    const button = navButtonAt(before, point);
    if (button) return moved || button === 'gap' ? { kind: 'ignored' } : { kind: button };
  }
  if (nodesAt(before, point).some((node) => node.systemBar === 'status')) return { kind: 'ignored' };

  if (moved) return { kind: 'swipe', from: gesture.start, to: gesture.end, durationMs: gesture.durationMs };

  const kind = gesture.durationMs >= settings.longPressMs ? 'longPress' : 'tap';
  const node = resolveTapTarget(before.nodes, point, before.viewport);
  const review: StepReview | undefined = !node ? 'no-element' : screenWasMoving(screens, point, gesture.upAt) ? 'screen-moving' : undefined;
  return { kind, point, ...(node ? { node } : {}), ...(review ? { review } : {}) };
}

/** The app showing, by which package owns most of the screen's nodes; the keyboard's own nodes do not count. */
export function foregroundApp(screen: Pick<PhoneScreen, 'nodes' | 'keyboard'>): string | undefined {
  const counts = new Map<string, number>();
  for (const node of screen.nodes) {
    if (node.systemBar || !node.bundleId) continue;
    if (screen.keyboard && node.rect && rectContains(screen.keyboard, { x: node.rect.x, y: node.rect.y })) continue;
    counts.set(node.bundleId, (counts.get(node.bundleId) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export type FocusedField = { key: string; password: boolean; value: string };

/**
 * The text field with focus. A password field's value is never read: only
 * that it is one, so nothing downstream can hold the password.
 */
export function focusedField(nodes: readonly PhoneNode[]): FocusedField | undefined {
  const field = nodes.find((node) => node.focused === true && (node.editable === true || /EditText/.test(node.type ?? '')));
  if (!field) return undefined;
  const key = field.identifier ?? field.type ?? 'field';
  if (field.password === true) return { key, password: true, value: '' };
  const value = field.hintShowing ? '' : (field.value ?? field.text ?? field.label ?? '');
  return { key, password: false, value };
}

/** How to get from `before` to `after` by erasing from the end and typing: what Maestro can replay. */
export function typedChange(before: string, after: string): { erase: number; text: string } {
  let same = 0;
  while (same < before.length && same < after.length && before[same] === after[same]) same += 1;
  return { erase: before.length - same, text: after.slice(same) };
}
