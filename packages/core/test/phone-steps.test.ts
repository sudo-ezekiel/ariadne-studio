import { describe, expect, it } from 'vitest';
import { isScreenContainer, resolveTapTarget, type Point, type Rect } from '../src/device/hit-test.ts';
import type { TouchGesture } from '../src/device/touch.ts';
import {
  focusedField,
  foregroundApp,
  readGesture,
  typedChange,
  type GestureScreens,
  type PhoneNode,
  type PhoneScreen,
  type TouchSettings,
} from '../src/recorder/phone-steps.ts';

const viewport = { width: 1080, height: 2400 };
const KEYBOARD: Rect = { x: 0, y: 1500, width: 1080, height: 800 };
const SETTINGS: TouchSettings = { longPressMs: 400, touchSlopPx: 20, gestureNavigation: false };
const GESTURE_NAV: TouchSettings = { ...SETTINGS, gestureNavigation: true };

function screen(nodes: PhoneNode[], extra: Partial<PhoneScreen> = {}): PhoneScreen {
  return { nodes, viewport, startedAt: 1000, endedAt: 1100, ...extra };
}

function gesture(x: number, y: number, extra: Partial<TouchGesture> = {}): TouchGesture {
  const point = { x, y };
  return { downAt: 2000, upAt: 2080, durationMs: 80, start: point, end: point, travelPx: 0, fingers: 1, ...extra };
}

const button = (label: string, rect: Rect, extra: Partial<PhoneNode> = {}): PhoneNode => ({ label, rect, hittable: true, ...extra });
const WIFI = button('Wi-Fi', { x: 0, y: 400, width: 1080, height: 150 }, { identifier: 'android:id/title' });
const BACKGROUND_ROOT: PhoneNode = { identifier: 'root', rect: { x: 0, y: 0, width: 1080, height: 2400 } };

describe('isScreenContainer and resolveTapTarget', () => {
  it('calls a big node with only an id the screen itself', () => {
    expect(isScreenContainer(BACKGROUND_ROOT, viewport)).toBe(true);
  });

  it('does not call a big node the screen when it has text, a label or a description', () => {
    const rect = BACKGROUND_ROOT.rect!;
    expect(isScreenContainer({ rect, text: 'Hello' }, viewport)).toBe(false);
    expect(isScreenContainer({ rect, label: 'Hello' }, viewport)).toBe(false);
    expect(isScreenContainer({ rect, contentDescription: 'Hello' }, viewport)).toBe(false);
  });

  it('does not call a small node the screen, and a node with no rect is not one', () => {
    expect(isScreenContainer({ identifier: 'ok', rect: { x: 0, y: 0, width: 200, height: 100 } }, viewport)).toBe(false);
    expect(isScreenContainer({ identifier: 'ok' }, viewport)).toBe(false);
  });

  it('puts the threshold at 60 percent of the screen area', () => {
    const just = { identifier: 'a', rect: { x: 0, y: 0, width: 1080, height: 1440 } };
    const less = { identifier: 'a', rect: { x: 0, y: 0, width: 1080, height: 1439 } };
    expect(isScreenContainer(just, viewport)).toBe(true);
    expect(isScreenContainer(less, viewport)).toBe(false);
  });

  it('resolves a tap to the control under it', () => {
    expect(resolveTapTarget([BACKGROUND_ROOT, WIFI], { x: 500, y: 450 }, viewport)).toBe(WIFI);
  });

  it('resolves a tap on the background to nothing, not to the root', () => {
    expect(resolveTapTarget([BACKGROUND_ROOT], { x: 500, y: 1000 }, viewport)).toBeUndefined();
  });
});

describe('readGesture: taps and long presses', () => {
  const before = screen([WIFI]);

  it('reads a short touch on a control as a tap on that control', () => {
    expect(readGesture(gesture(500, 450), { before }, SETTINGS)).toEqual({ kind: 'tap', node: WIFI, point: { x: 500, y: 450 } });
  });

  it('uses the phone\'s own long press time as the boundary', () => {
    expect(readGesture(gesture(500, 450, { durationMs: 399 }), { before }, SETTINGS).kind).toBe('tap');
    expect(readGesture(gesture(500, 450, { durationMs: 400 }), { before }, SETTINGS).kind).toBe('longPress');
    expect(readGesture(gesture(500, 450, { durationMs: 399 }), { before }, { ...SETTINGS, longPressMs: 300 }).kind).toBe('longPress');
  });

  it('reads a background touch on a node with only an id as no element', () => {
    const action = readGesture(gesture(500, 1000), { before: screen([BACKGROUND_ROOT]) }, SETTINGS);
    expect(action).toEqual({ kind: 'tap', point: { x: 500, y: 1000 }, review: 'no-element' });
  });

  it('reads a touch with nothing under it as no element', () => {
    const action = readGesture(gesture(500, 1000), { before: screen([WIFI]) }, SETTINGS);
    expect(action).toMatchObject({ kind: 'tap', review: 'no-element' });
    expect(action).not.toHaveProperty('node');
  });
});

describe('readGesture: swipes', () => {
  const before = screen([WIFI]);

  it('reads travel at or past the touch slop as a swipe', () => {
    const swipe = gesture(500, 1800, { end: { x: 500, y: 900 }, travelPx: 900, durationMs: 250 });
    expect(readGesture(swipe, { before }, SETTINGS)).toEqual({ kind: 'swipe', from: { x: 500, y: 1800 }, to: { x: 500, y: 900 }, durationMs: 250 });
    expect(readGesture(gesture(500, 450, { end: { x: 520, y: 450 }, travelPx: 20 }), { before }, SETTINGS).kind).toBe('swipe');
  });

  it('reads travel under the touch slop as a tap', () => {
    expect(readGesture(gesture(500, 450, { end: { x: 519, y: 450 }, travelPx: 19 }), { before }, SETTINGS).kind).toBe('tap');
  });
});

describe('readGesture: the keyboard', () => {
  const key = (label: string, x: number, extra: Partial<PhoneNode> = {}): PhoneNode => ({
    label,
    rect: { x, y: 1600, width: 100, height: 120 },
    hittable: true,
    ...extra,
  });
  const keys = [key('q', 0), key('w', 100), key('Enter', 200), key('Go', 300), key('Search', 400), key('x', 500, { identifier: 'com.google.android.inputmethod.latin:id/key_pos_ime_action' }), key('y', 600, { identifier: 'key_enter' })];
  const before = screen([WIFI, ...keys], { keyboard: KEYBOARD });

  it('drops a key press, and carries no position at all', () => {
    const action = readGesture(gesture(50, 1650), { before }, SETTINGS);
    expect(action).toStrictEqual({ kind: 'keyboard', submits: false });
  });

  it('carries no position even for a submit key', () => {
    const action = readGesture(gesture(250, 1650), { before }, SETTINGS);
    expect(action).toStrictEqual({ kind: 'keyboard', submits: true });
  });

  it('knows an Enter-like key by its label', () => {
    for (const x of [250, 350, 450]) expect(readGesture(gesture(x, 1650), { before }, SETTINGS)).toMatchObject({ kind: 'keyboard', submits: true });
  });

  it('knows an Enter-like key by its identifier', () => {
    expect(readGesture(gesture(550, 1650), { before }, SETTINGS)).toMatchObject({ submits: true });
    expect(readGesture(gesture(650, 1650), { before }, SETTINGS)).toMatchObject({ submits: true });
  });

  it('does not take a letter for a submit key', () => {
    expect(readGesture(gesture(150, 1650), { before }, SETTINGS)).toMatchObject({ submits: false });
  });

  it('treats a swipe across the keyboard as a keyboard touch that submits nothing', () => {
    const action = readGesture(gesture(250, 1650, { end: { x: 700, y: 1650 }, travelPx: 450 }), { before }, SETTINGS);
    expect(action).toStrictEqual({ kind: 'keyboard', submits: false });
  });

  it('treats two fingers on the keyboard as the keyboard, not as a recorded gesture', () => {
    const action = readGesture(gesture(250, 1650, { fingers: 2 }), { before }, SETTINGS);
    expect(action).toStrictEqual({ kind: 'keyboard', submits: false });
  });

  it('does not treat a touch just above the keyboard as a key', () => {
    expect(readGesture(gesture(250, 1499), { before }, SETTINGS).kind).toBe('tap');
  });
});

describe('readGesture: a keyboard the snapshots have not shown yet', () => {
  // Real numbers from the phone: focus showed in snapshots at about 160 ms, the band only at 600 to 860 ms.
  const tall = { width: 1440, height: 3200 };
  const BAND: Rect = { x: 0, y: 2027, width: 1440, height: 1008 };
  const DELETE: Point = { x: 1282, y: 2720 };
  const field: PhoneNode = { identifier: 'f', editable: true, focused: true, type: 'android.widget.EditText', rect: { x: 0, y: 400, width: 1440, height: 150 } };
  const submit: PhoneNode = { label: 'Submit', hittable: true, rect: { x: 1000, y: 2600, width: 400, height: 240 } };
  const seen = (nodes: PhoneNode[], extra: Partial<PhoneScreen> = {}): PhoneScreen => ({ nodes, viewport: tall, startedAt: 1000, endedAt: 1100, ...extra });
  const swipeFrom = (start: Point) => gesture(start.x, start.y, { end: { x: start.x - 300, y: start.y - 40 }, travelPx: 303 });

  it('reads a touch in the band as a key when only the later snapshot shows the band', () => {
    const action = readGesture(gesture(DELETE.x, DELETE.y), { before: seen([field]), atTouch: seen([field], { keyboard: BAND }) }, SETTINGS);
    expect(action).toStrictEqual({ kind: 'keyboard', submits: false });
  });

  it('finds an Enter key in the later snapshot\'s nodes', () => {
    const enter: PhoneNode = { label: 'Enter', hittable: true, rect: { x: 1200, y: 2650, width: 200, height: 140 } };
    const action = readGesture(gesture(1300, 2720), { before: seen([field]), atTouch: seen([field, enter], { keyboard: BAND }) }, SETTINGS);
    expect(action).toStrictEqual({ kind: 'keyboard', submits: true });
  });

  it('still reads a touch above that band as an ordinary tap', () => {
    const action = readGesture(gesture(500, 1000), { before: seen([field]), atTouch: seen([field], { keyboard: BAND }) }, SETTINGS);
    expect(action.kind).toBe('tap');
  });

  it('reads a tap low on the screen as a key while the keyboard is opening and nothing shows it yet', () => {
    const action = readGesture(gesture(DELETE.x, DELETE.y), { before: seen([field]), keyboardOpening: true }, SETTINGS);
    expect(action).toStrictEqual({ kind: 'keyboard', submits: false });
  });

  it('reads glide typing low on the screen as a key too', () => {
    const action = readGesture(swipeFrom(DELETE), { before: seen([field]), keyboardOpening: true }, SETTINGS);
    expect(action).toStrictEqual({ kind: 'keyboard', submits: false });
  });

  it('reads it as a key even when an app node sits under that spot', () => {
    const under = { before: seen([field, submit]), keyboardOpening: true };
    expect(readGesture(gesture(1100, 2700), under, SETTINGS)).toStrictEqual({ kind: 'keyboard', submits: false });
    expect(readGesture(swipeFrom({ x: 1100, y: 2700 }), under, SETTINGS)).toStrictEqual({ kind: 'keyboard', submits: false });
  });

  it('reads a touch high on the screen as an ordinary tap while the keyboard is opening', () => {
    const action = readGesture(gesture(500, 1000), { before: seen([field]), keyboardOpening: true }, SETTINGS);
    expect(action).toMatchObject({ kind: 'tap', review: 'no-element' });
  });

  it('puts the keyboard zone at the lower half of the screen', () => {
    expect(readGesture(gesture(500, 1600), { before: seen([field]), keyboardOpening: true }, SETTINGS).kind).toBe('tap');
    expect(readGesture(gesture(500, 1601), { before: seen([field]), keyboardOpening: true }, SETTINGS).kind).toBe('keyboard');
  });

  it('reads a tap on a button low on the screen as a tap when the keyboard is not opening, though a field is focused', () => {
    // Back hid the keyboard; the field kept focus; Submit is down here. Dropping this tap would lose a step.
    const action = readGesture(gesture(1100, 2700), { before: seen([field, submit]) }, SETTINGS);
    expect(action).toMatchObject({ kind: 'tap', node: submit, point: { x: 1100, y: 2700 } });
    expect(readGesture(gesture(1100, 2700), { before: seen([field, submit]), keyboardOpening: false }, SETTINGS)).toMatchObject({ kind: 'tap', node: submit });
  });
});

describe('readGesture: the navigation bar', () => {
  const NAV = { y: 2300, height: 100 };
  const navNodes: PhoneNode[] = [
    { identifier: 'com.android.systemui:id/navigation_bar_frame', systemBar: 'navigation', rect: { x: 0, y: NAV.y, width: 1080, height: NAV.height } },
    { identifier: 'com.android.systemui:id/back', systemBar: 'navigation', rect: { x: 100, y: NAV.y, width: 200, height: NAV.height } },
    { identifier: 'com.android.systemui:id/home', systemBar: 'navigation', rect: { x: 440, y: NAV.y, width: 200, height: NAV.height } },
    { identifier: 'com.android.systemui:id/recent_apps', systemBar: 'navigation', rect: { x: 780, y: NAV.y, width: 200, height: NAV.height } },
  ];
  const before = screen([WIFI, ...navNodes]);

  it('reads the three buttons by identifier', () => {
    expect(readGesture(gesture(200, 2350), { before }, SETTINGS)).toEqual({ kind: 'back' });
    expect(readGesture(gesture(540, 2350), { before }, SETTINGS)).toEqual({ kind: 'home' });
    expect(readGesture(gesture(880, 2350), { before }, SETTINGS)).toEqual({ kind: 'recents' });
  });

  it('ignores a touch in a gap of the navigation bar', () => {
    expect(readGesture(gesture(350, 2350), { before }, SETTINGS)).toEqual({ kind: 'ignored' });
  });

  it('ignores a swipe that starts on a navigation button', () => {
    const swipe = gesture(200, 2350, { end: { x: 700, y: 2350 }, travelPx: 500 });
    expect(readGesture(swipe, { before }, SETTINGS)).toEqual({ kind: 'ignored' });
  });

  it('does not read buttons by identifier when navigation is by gestures', () => {
    expect(readGesture(gesture(200, 2350), { before }, GESTURE_NAV).kind).not.toBe('back');
    expect(readGesture(gesture(540, 2350), { before }, GESTURE_NAV).kind).not.toBe('home');
  });
});

describe('readGesture: gesture navigation edges', () => {
  const before = screen([WIFI]);

  it('reads a sideways swipe from the left edge as back', () => {
    expect(readGesture(gesture(5, 1000, { end: { x: 400, y: 1010 }, travelPx: 400 }), { before }, GESTURE_NAV)).toEqual({ kind: 'back' });
  });

  it('reads a sideways swipe from the right edge as back', () => {
    expect(readGesture(gesture(1075, 1000, { end: { x: 600, y: 1000 }, travelPx: 475 }), { before }, GESTURE_NAV)).toEqual({ kind: 'back' });
  });

  it('reads an upward swipe from the bottom edge as home', () => {
    expect(readGesture(gesture(540, 2390, { end: { x: 540, y: 1800 }, travelPx: 590 }), { before }, GESTURE_NAV)).toEqual({ kind: 'home' });
  });

  it('reads the same edge swipes as plain swipes when navigation is by buttons', () => {
    expect(readGesture(gesture(5, 1000, { end: { x: 400, y: 1010 }, travelPx: 400 }), { before }, SETTINGS).kind).toBe('swipe');
    expect(readGesture(gesture(540, 2390, { end: { x: 540, y: 1800 }, travelPx: 590 }), { before }, SETTINGS).kind).toBe('swipe');
  });

  it('does not take a tap on the edge for back', () => {
    expect(readGesture(gesture(5, 1000), { before }, GESTURE_NAV).kind).toBe('tap');
  });

  it('does not take a swipe away from the edges for back or home', () => {
    expect(readGesture(gesture(500, 1000, { end: { x: 900, y: 1000 }, travelPx: 400 }), { before }, GESTURE_NAV).kind).toBe('swipe');
  });
});

describe('readGesture: status bar and several fingers', () => {
  const statusBar: PhoneNode = { identifier: 'com.android.systemui:id/status_bar', systemBar: 'status', rect: { x: 0, y: 0, width: 1080, height: 100 } };
  const before = screen([WIFI, statusBar]);

  it('ignores a tap on the status bar', () => {
    expect(readGesture(gesture(500, 50), { before }, SETTINGS)).toEqual({ kind: 'ignored' });
  });

  it('ignores a pull down from the status bar', () => {
    expect(readGesture(gesture(500, 50, { end: { x: 500, y: 900 }, travelPx: 850 }), { before }, SETTINGS)).toEqual({ kind: 'ignored' });
  });

  it('reads two fingers as a multi-touch gesture', () => {
    expect(readGesture(gesture(500, 450, { fingers: 2 }), { before }, SETTINGS)).toEqual({ kind: 'multiTouch' });
  });
});

describe('readGesture: a screen that was still moving', () => {
  const at = (name: string, startedAt: number): PhoneScreen => screen([button(name, WIFI.rect!)], { startedAt, endedAt: startedAt + 100 });
  const tapAt = (screens: GestureScreens) => readGesture(gesture(500, 450, { upAt: 2080 }), screens, SETTINGS);

  it('does not flag a tap on Wi-Fi when the later snapshot began after the lift plus the grace', () => {
    // Three quick taps on Wi-Fi: the later snapshot named a different screen, but too late to matter.
    const action = tapAt({ before: at('Wi-Fi', 1900), atTouch: at('Network', 2080 + 61) });
    expect(action).toEqual({ kind: 'tap', node: expect.objectContaining({ label: 'Wi-Fi' }), point: { x: 500, y: 450 } });
  });

  it('does not flag a tap when the later snapshot names nothing', () => {
    const empty = screen([], { startedAt: 2030, endedAt: 2100 });
    expect(tapAt({ before: at('Wi-Fi', 1900), atTouch: empty })).not.toHaveProperty('review');
  });

  it('does not flag a tap when the later snapshot names the same element', () => {
    expect(tapAt({ before: at('Wi-Fi', 1900), atTouch: at('Wi-Fi', 2030) })).not.toHaveProperty('review');
  });

  it('flags a tap when a snapshot begun within the grace of the lift names another element', () => {
    // "6666'" was on screen before; right after the lift the same spot said "0".
    const action = tapAt({ before: at("6666'", 1900), atTouch: at('0', 2030) });
    expect(action).toMatchObject({ kind: 'tap', review: 'screen-moving' });
  });

  it('puts the end of the grace at 60 ms after the lift', () => {
    expect(tapAt({ before: at("6666'", 1900), atTouch: at('0', 2080 + 60) })).toMatchObject({ review: 'screen-moving' });
    expect(tapAt({ before: at("6666'", 1900), atTouch: at('0', 2080 + 61) })).not.toHaveProperty('review');
  });

  it('flags a tap when the element\'s rect differs between the prior and the before snapshot', () => {
    const moved = screen([button('Wi-Fi', { x: 0, y: 380, width: 1080, height: 150 }, { identifier: 'android:id/title' })], { startedAt: 1700, endedAt: 1800 });
    const settled = screen([WIFI], { startedAt: 1900, endedAt: 2000 });
    expect(tapAt({ before: settled, prior: moved })).toMatchObject({ kind: 'tap', review: 'screen-moving' });
  });

  it('does not flag a tap when the element is where it was in the prior snapshot', () => {
    const prior = screen([WIFI], { startedAt: 1700, endedAt: 1800 });
    const before = screen([WIFI], { startedAt: 1900, endedAt: 2000 });
    expect(tapAt({ before, prior })).not.toHaveProperty('review');
  });

  it('does not flag a tap when the prior snapshot had no element there', () => {
    const prior = screen([], { startedAt: 1700, endedAt: 1800 });
    expect(tapAt({ before: screen([WIFI]), prior })).not.toHaveProperty('review');
  });

  it('keeps no-element ahead of screen-moving for a background tap', () => {
    const action = readGesture(gesture(500, 1000), { before: screen([BACKGROUND_ROOT]), atTouch: at('Other', 2030) }, SETTINGS);
    expect(action).toMatchObject({ kind: 'tap', review: 'no-element' });
  });
});

describe('foregroundApp', () => {
  it('names the package owning most of the screen', () => {
    const nodes: PhoneNode[] = [
      { bundleId: 'com.example', rect: { x: 0, y: 0, width: 1, height: 1 } },
      { bundleId: 'com.example', rect: { x: 0, y: 0, width: 1, height: 1 } },
      { bundleId: 'com.other', rect: { x: 0, y: 0, width: 1, height: 1 } },
    ];
    expect(foregroundApp(screen(nodes))).toBe('com.example');
  });

  it('does not count system bar nodes', () => {
    const nodes: PhoneNode[] = [
      { bundleId: 'com.example', rect: { x: 0, y: 0, width: 1, height: 1 } },
      { bundleId: 'com.android.systemui', systemBar: 'status' },
      { bundleId: 'com.android.systemui', systemBar: 'navigation' },
      { bundleId: 'com.android.systemui', systemBar: 'navigation' },
    ];
    expect(foregroundApp(screen(nodes))).toBe('com.example');
  });

  it('does not count the keyboard\'s own nodes', () => {
    const nodes: PhoneNode[] = [
      { bundleId: 'com.example', rect: { x: 0, y: 100, width: 10, height: 10 } },
      { bundleId: 'com.google.android.inputmethod.latin', rect: { x: 10, y: 1600, width: 10, height: 10 } },
      { bundleId: 'com.google.android.inputmethod.latin', rect: { x: 50, y: 1600, width: 10, height: 10 } },
    ];
    expect(foregroundApp(screen(nodes, { keyboard: KEYBOARD }))).toBe('com.example');
  });

  it('gives undefined for a screen with no package', () => {
    expect(foregroundApp(screen([]))).toBeUndefined();
    expect(foregroundApp(screen([{ label: 'x' }]))).toBeUndefined();
  });
});

describe('focusedField', () => {
  it('never returns a password field\'s value, whichever property carries it', () => {
    const secret = 'hunter2-s3cret';
    const field = focusedField([
      { focused: true, editable: true, password: true, identifier: 'login:id/password', value: secret, text: secret, label: secret },
    ]);
    expect(field).toEqual({ key: 'login:id/password', password: true, value: '' });
    expect(JSON.stringify(field)).not.toContain(secret);
  });

  it('reads an ordinary field\'s value, then its text, then its label', () => {
    expect(focusedField([{ focused: true, editable: true, identifier: 'a', value: 'v', text: 't', label: 'l' }])?.value).toBe('v');
    expect(focusedField([{ focused: true, editable: true, identifier: 'a', text: 't', label: 'l' }])?.value).toBe('t');
    expect(focusedField([{ focused: true, editable: true, identifier: 'a', label: 'l' }])?.value).toBe('l');
  });

  it('reads the placeholder hint as no text', () => {
    expect(focusedField([{ focused: true, editable: true, identifier: 'a', hintShowing: true, text: 'Search here' }])?.value).toBe('');
  });

  it('finds an EditText that is not marked editable', () => {
    expect(focusedField([{ focused: true, type: 'android.widget.EditText', text: 'x' }])).toEqual({ key: 'android.widget.EditText', password: false, value: 'x' });
  });

  it('names the field by identifier, else type, else "field"', () => {
    expect(focusedField([{ focused: true, editable: true, identifier: 'id1' }])?.key).toBe('id1');
    expect(focusedField([{ focused: true, editable: true, type: 'Custom' }])?.key).toBe('Custom');
    expect(focusedField([{ focused: true, editable: true }])?.key).toBe('field');
  });

  it('gives undefined when nothing editable has focus', () => {
    expect(focusedField([])).toBeUndefined();
    expect(focusedField([{ editable: true, text: 'x' }])).toBeUndefined();
    expect(focusedField([{ focused: true, label: 'A button' }])).toBeUndefined();
  });

  it('skips a focused node that is not a field in favour of the field', () => {
    expect(focusedField([{ focused: true, label: 'Row' }, { focused: true, editable: true, identifier: 'f', text: 'z' }])?.key).toBe('f');
  });
});

describe('typedChange', () => {
  it('types everything from an empty field', () => {
    expect(typedChange('', 'abc')).toEqual({ erase: 0, text: 'abc' });
  });

  it('types only what was added', () => {
    expect(typedChange('ab', 'abcd')).toEqual({ erase: 0, text: 'cd' });
  });

  it('erases from the end when text was removed', () => {
    expect(typedChange('abc', 'ab')).toEqual({ erase: 1, text: '' });
    expect(typedChange('abc', '')).toEqual({ erase: 3, text: '' });
  });

  it('erases back to the common start, then types the rest', () => {
    expect(typedChange('2', '4')).toEqual({ erase: 1, text: '4' });
    expect(typedChange('hello', 'help')).toEqual({ erase: 2, text: 'p' });
  });

  it('does nothing when the text is unchanged', () => {
    expect(typedChange('same', 'same')).toEqual({ erase: 0, text: '' });
  });
});
