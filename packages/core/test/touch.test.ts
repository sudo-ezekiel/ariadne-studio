import { describe, expect, it } from 'vitest';
import {
  TouchReader,
  findTouchScreen,
  parseDensity,
  parseHomeApp,
  parseRotation,
  touchToViewport,
  type TouchGesture,
  type TouchScreen,
} from '../src/device/touch.ts';

// `getevent -pl` as the phone prints it: one block per input device.
const PHONE_TOUCH = `add device 1: /dev/input/event7
  name:     "fts_ts"
  events:
    KEY (0001): BTN_TOUCH
    ABS (0003): ABS_MT_SLOT           : value 0, min 0, max 9, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_X     : value 0, min 0, max 14399, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 31999, fuzz 0, flat 0, resolution 0
                ABS_MT_TRACKING_ID    : value 0, min 0, max 65535, fuzz 0, flat 0, resolution 0
  input props:
    INPUT_PROP_DIRECT
`;
const POWER_BUTTON = `add device 2: /dev/input/event0
  name:     "gpio-keys"
  events:
    KEY (0001): KEY_VOLUMEDOWN KEY_VOLUMEUP KEY_POWER
  input props:
    <none>
`;
const KEYBOARD = `add device 3: /dev/input/event3
  name:     "Virtual keyboard"
  events:
    KEY (0001): KEY_ESC KEY_1 KEY_2 KEY_ENTER
  input props:
    <none>
`;
function emulatorTouch(path: string, max: number): string {
  return `add device 4: ${path}
  name:     "virtio_input_multi_touch_${path.at(-1)}"
  events:
    KEY (0001): BTN_TOUCH
    ABS (0003): ABS_MT_SLOT           : value 0, min 0, max 9, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_X     : value 0, min 0, max ${max}, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max ${max}, fuzz 0, flat 0, resolution 0
  input props:
    <none>
`;
}

describe('findTouchScreen', () => {
  it('picks the real screen on a Galaxy, past a touchpad and a marked device with no positions', () => {
    // From a Galaxy A16: both of the first two look like the touchscreen in one way.
    const galaxy = [
      'add device 1: /dev/input/event7',
      '  name:     "sec_touchproximity"',
      '  input props:',
      '    INPUT_PROP_DIRECT',
      'add device 2: /dev/input/event6',
      '  name:     "sec_touchpad"',
      '  events:',
      '    ABS (0003): ABS_MT_POSITION_X     : value 0, min 0, max 1079, fuzz 0, flat 0, resolution 0',
      '                ABS_MT_POSITION_Y     : value 0, min 0, max 2339, fuzz 0, flat 0, resolution 0',
      'add device 3: /dev/input/event5',
      '  name:     "sec_touchscreen"',
      '  events:',
      '    ABS (0003): ABS_MT_POSITION_X     : value 0, min 0, max 1079, fuzz 0, flat 0, resolution 0',
      '                ABS_MT_POSITION_Y     : value 0, min 0, max 2339, fuzz 0, flat 0, resolution 0',
      '  input props:',
      '    INPUT_PROP_DIRECT',
    ].join('\n');
    expect(findTouchScreen(galaxy)).toEqual({ path: '/dev/input/event5', maxX: 1079, maxY: 2339 });
  });

  it('finds the touchscreen of a phone by INPUT_PROP_DIRECT and reads its raw range', () => {
    expect(findTouchScreen(POWER_BUTTON + PHONE_TOUCH)).toEqual({ path: '/dev/input/event7', maxX: 14399, maxY: 31999 });
  });

  it('takes the first of an emulator\'s several unmarked multi-touch devices', () => {
    const output = KEYBOARD + emulatorTouch('/dev/input/event1', 32767) + emulatorTouch('/dev/input/event2', 32767);
    expect(findTouchScreen(output)).toEqual({ path: '/dev/input/event1', maxX: 32767, maxY: 32767 });
  });

  it('prefers a device marked INPUT_PROP_DIRECT over an earlier unmarked one', () => {
    const output = emulatorTouch('/dev/input/event1', 32767) + PHONE_TOUCH;
    expect(findTouchScreen(output)?.path).toBe('/dev/input/event7');
  });

  it('skips a keyboard and a power button, which have no touch position', () => {
    expect(findTouchScreen(POWER_BUTTON + KEYBOARD + PHONE_TOUCH)?.path).toBe('/dev/input/event7');
  });

  it('gives undefined when no device reports touch positions', () => {
    expect(findTouchScreen(POWER_BUTTON + KEYBOARD)).toBeUndefined();
    expect(findTouchScreen('')).toBeUndefined();
  });

  it('ignores a device that reports only one of the two axes', () => {
    const xOnly = `add device 5: /dev/input/event5
  events:
    ABS (0003): ABS_MT_POSITION_X     : value 0, min 0, max 1079, fuzz 0, flat 0, resolution 0
  input props:
    INPUT_PROP_DIRECT
`;
    expect(findTouchScreen(xOnly)).toBeUndefined();
  });
});

describe('phone settings parsers', () => {
  it('reads the override density when wm density prints two lines', () => {
    expect(parseDensity('Physical density: 480\nOverride density: 420\n')).toBe(420);
  });

  it('reads the physical density when there is no override', () => {
    expect(parseDensity('Physical density: 420\n')).toBe(420);
  });

  it('gives undefined density for output without one', () => {
    expect(parseDensity('')).toBeUndefined();
    expect(parseDensity('error: closed')).toBeUndefined();
  });

  it('takes the package from the last line of resolve-activity output', () => {
    expect(parseHomeApp('priority=0 preferredOrder=0\ncom.miui.home/.launcher.Launcher\n')).toBe('com.miui.home');
    expect(parseHomeApp('com.google.android.apps.nexuslauncher/.NexusLauncherActivity\r\n')).toBe('com.google.android.apps.nexuslauncher');
  });

  it('gives undefined home app when the last line is not an activity', () => {
    expect(parseHomeApp('')).toBeUndefined();
    expect(parseHomeApp('No activity found')).toBeUndefined();
  });

  it('reads the rotation from the internal viewport in dumpsys input', () => {
    expect(parseRotation('  Viewport INTERNAL: displayId=0, orientation=1, logicalFrame=[0, 0, 2400, 1080]')).toBe(1);
    expect(parseRotation('  Viewport INTERNAL: displayId=0, orientation=3, logicalFrame=[0, 0, 2400, 1080]')).toBe(3);
  });

  it('falls back to SurfaceOrientation, and to 0 when nothing says', () => {
    expect(parseRotation('SurfaceOrientation: 2')).toBe(2);
    expect(parseRotation('')).toBe(0);
    expect(parseRotation('Viewport INTERNAL: orientation=7')).toBe(0);
  });
});

describe('touchToViewport', () => {
  // A panel of 1000 x 2000 raw units, so shares are easy to read.
  const panel: TouchScreen = { path: '/dev/input/event7', maxX: 999, maxY: 1999 };
  const portrait = { width: 1000, height: 2000 };
  const landscape = { width: 2000, height: 1000 };

  it('maps straight through when the display is upright', () => {
    expect(touchToViewport({ x: 250, y: 500 }, panel, portrait, 0)).toEqual({ x: 250, y: 500 });
  });

  it('maps a point for a display turned a quarter (rotation 1)', () => {
    expect(touchToViewport({ x: 250, y: 500 }, panel, landscape, 1)).toEqual({ x: 500, y: 750 });
    // The panel's top-left corner shows at the bottom-left of the turned display.
    expect(touchToViewport({ x: 0, y: 0 }, panel, landscape, 1)).toEqual({ x: 0, y: 999 });
  });

  it('maps a point for an upside-down display (rotation 2)', () => {
    expect(touchToViewport({ x: 250, y: 500 }, panel, portrait, 2)).toEqual({ x: 750, y: 1500 });
    expect(touchToViewport({ x: 0, y: 0 }, panel, portrait, 2)).toEqual({ x: 999, y: 1999 });
  });

  it('maps a point for a display turned three quarters (rotation 3)', () => {
    expect(touchToViewport({ x: 250, y: 500 }, panel, landscape, 3)).toEqual({ x: 1500, y: 250 });
    // The panel's top-left corner shows at the top-right of the turned display.
    expect(touchToViewport({ x: 0, y: 0 }, panel, landscape, 3)).toEqual({ x: 1999, y: 0 });
  });

  it('scales a raw range that is ten times the screen, as on the real phone', () => {
    const real: TouchScreen = { path: '/dev/input/event7', maxX: 14399, maxY: 31999 };
    const viewport = { width: 1440, height: 3200 };
    expect(touchToViewport({ x: 7200, y: 16000 }, real, viewport, 0)).toEqual({ x: 720, y: 1600 });
    expect(touchToViewport({ x: 1440, y: 3200 }, real, viewport, 0)).toEqual({ x: 144, y: 320 });
  });

  it('scales the emulator\'s 32767 range onto a 1080 x 2400 screen', () => {
    const emulator: TouchScreen = { path: '/dev/input/event1', maxX: 32767, maxY: 32767 };
    const viewport = { width: 1080, height: 2400 };
    expect(touchToViewport({ x: 16384, y: 16384 }, emulator, viewport, 0)).toEqual({ x: 540, y: 1200 });
    expect(touchToViewport({ x: 0, y: 0 }, emulator, viewport, 0)).toEqual({ x: 0, y: 0 });
  });

  it('keeps the last raw column and row on the last pixel of the screen', () => {
    // Raw max is a real touch position, so it must land on a pixel that exists:
    // x 1439 of 1440 is the last one. Rounding sends it to 1440, one past.
    const real: TouchScreen = { path: '/dev/input/event7', maxX: 14399, maxY: 31999 };
    const viewport = { width: 1440, height: 3200 };
    const corner = touchToViewport({ x: 14399, y: 31999 }, real, viewport, 0);
    expect(corner.x).toBeLessThanOrEqual(1439);
    expect(corner.y).toBeLessThanOrEqual(3199);
  });
});

// getevent -lt prints `[ seconds.micro] TYPE CODE VALUE`; a report ends each batch.
function event(at: number, type: string, code: string, value: string): string {
  return `[ ${at.toFixed(6).padStart(12)}] ${type.padEnd(12)} ${code.padEnd(20)} ${value}`;
}
const hex = (n: number) => n.toString(16).padStart(8, '0');

type Report = { at: number; slot?: number; id?: number | 'lift'; x?: number; y?: number };

/** One SYN_REPORT batch. `id: 'lift'` is a tracking id of ffffffff. */
function report({ at, slot, id, x, y }: Report): string[] {
  const out: string[] = [];
  if (slot !== undefined) out.push(event(at, 'EV_ABS', 'ABS_MT_SLOT', hex(slot)));
  if (id !== undefined) out.push(event(at, 'EV_ABS', 'ABS_MT_TRACKING_ID', id === 'lift' ? 'ffffffff' : hex(id)));
  if (x !== undefined) out.push(event(at, 'EV_ABS', 'ABS_MT_POSITION_X', hex(x)));
  if (y !== undefined) out.push(event(at, 'EV_ABS', 'ABS_MT_POSITION_Y', hex(y)));
  out.push(event(at, 'EV_SYN', 'SYN_REPORT', '00000000'));
  return out;
}

/** Feeds lines as they would arrive, `delay` ms after the kernel stamped them. */
function feed(reader: TouchReader, lines: string[], delay = 5000): TouchGesture[] {
  const found: TouchGesture[] = [];
  for (const line of lines) {
    const stamp = Number(/\[\s*([\d.]+)\]/.exec(line)?.[1] ?? 0) * 1000;
    const gesture = reader.read(line, stamp + delay);
    if (gesture) found.push(gesture);
  }
  return found;
}

const identity = (raw: { x: number; y: number }) => raw;

describe('TouchReader', () => {
  it('turns a tap into one gesture at the touched position with a kernel duration', () => {
    const reader = new TouchReader(identity);
    const lines = [...report({ at: 100, slot: 0, id: 1, x: 300, y: 700 }), ...report({ at: 100.08, id: 'lift' })];
    const [gesture, ...more] = feed(reader, lines);
    expect(more).toEqual([]);
    expect(gesture).toMatchObject({ start: { x: 300, y: 700 }, end: { x: 300, y: 700 }, travelPx: 0, fingers: 1, durationMs: 80 });
  });

  it('reports a long hold by its duration', () => {
    const reader = new TouchReader(identity);
    const lines = [...report({ at: 10, slot: 0, id: 1, x: 50, y: 60 }), ...report({ at: 10.7, id: 'lift' })];
    expect(feed(reader, lines)[0]).toMatchObject({ durationMs: 700, travelPx: 0 });
  });

  it('measures a swipe by the first finger\'s start, end and farthest travel', () => {
    const reader = new TouchReader(identity);
    const lines = [
      ...report({ at: 5, slot: 0, id: 1, x: 100, y: 1000 }),
      ...report({ at: 5.05, x: 100, y: 800 }),
      ...report({ at: 5.1, x: 100, y: 400 }),
      ...report({ at: 5.15, id: 'lift' }),
    ];
    expect(feed(reader, lines)[0]).toMatchObject({ start: { x: 100, y: 1000 }, end: { x: 100, y: 400 }, travelPx: 600, fingers: 1, durationMs: 150 });
  });

  it('counts two fingers down at once, and ends only when the last one lifts', () => {
    const reader = new TouchReader(identity);
    const lines = [
      ...report({ at: 1, slot: 0, id: 1, x: 100, y: 100 }),
      ...report({ at: 1.02, slot: 1, id: 2, x: 400, y: 400 }),
      ...report({ at: 1.1, slot: 0, id: 'lift' }),
    ];
    expect(feed(reader, lines)).toEqual([]);
    expect(reader.touching).toBe(true);
    const [gesture] = feed(reader, report({ at: 1.2, slot: 1, id: 'lift' }));
    expect(gesture).toMatchObject({ fingers: 2, durationMs: 200 });
  });

  it('follows the lowest slot still down as the first finger', () => {
    const reader = new TouchReader(identity);
    const lines = [
      ...report({ at: 1, slot: 0, id: 1, x: 100, y: 100 }),
      ...report({ at: 1.02, slot: 1, id: 2, x: 900, y: 900 }),
      ...report({ at: 1.04, slot: 0, id: 'lift' }),
      ...report({ at: 1.06, slot: 1, x: 950, y: 950 }),
      ...report({ at: 1.08, id: 'lift' }),
    ];
    const [gesture] = feed(reader, lines);
    expect(gesture?.end).toEqual({ x: 950, y: 950 });
  });

  it('reads a second tap on the same spot, which has no position lines, at that spot', () => {
    // The kernel suppresses values that did not change, so the second touch
    // reports only a tracking id. It must not come out at 0,0.
    const reader = new TouchReader(identity);
    const first = feed(reader, [...report({ at: 1, slot: 0, id: 1, x: 640, y: 1500 }), ...report({ at: 1.05, id: 'lift' })]);
    const second = feed(reader, [...report({ at: 2, id: 2 }), ...report({ at: 2.05, id: 'lift' })]);
    expect(first[0]?.start).toEqual({ x: 640, y: 1500 });
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ start: { x: 640, y: 1500 }, end: { x: 640, y: 1500 }, travelPx: 0 });
  });

  it('keeps one slot\'s position apart from another\'s', () => {
    const reader = new TouchReader(identity);
    feed(reader, [...report({ at: 1, slot: 0, id: 1, x: 10, y: 20 }), ...report({ at: 1.05, id: 'lift' })]);
    const [gesture] = feed(reader, [...report({ at: 2, slot: 1, id: 2, x: 700, y: 800 }), ...report({ at: 2.05, id: 'lift' })]);
    expect(gesture?.start).toEqual({ x: 700, y: 800 });
  });

  it('treats a tracking id of ffffffff as a lift, not as a finger', () => {
    const reader = new TouchReader(identity);
    feed(reader, report({ at: 1, slot: 0, id: 1, x: 5, y: 5 }));
    expect(reader.touching).toBe(true);
    const lift = feed(reader, report({ at: 1.1, id: 'lift' }));
    expect(lift).toHaveLength(1);
    expect(reader.touching).toBe(false);
  });

  it('passes raw positions through the converter given to it', () => {
    const reader = new TouchReader((raw) => ({ x: raw.x / 10, y: raw.y / 10 }));
    const [gesture] = feed(reader, [...report({ at: 1, slot: 0, id: 1, x: 1440, y: 3200 }), ...report({ at: 1.05, id: 'lift' })]);
    expect(gesture?.start).toEqual({ x: 144, y: 320 });
  });

  it('ignores lines that are not events', () => {
    const reader = new TouchReader(identity);
    const noise = ['', 'could not get driver version for /dev/input/event7', '  name: "fts_ts"', 'add device 1: /dev/input/event7', 'garbage [ 1.0]'];
    expect(feed(reader, noise)).toEqual([]);
    expect(reader.touching).toBe(false);
    const [gesture] = feed(reader, [...noise, ...report({ at: 3, slot: 0, id: 1, x: 8, y: 9 }), ...noise, ...report({ at: 3.05, id: 'lift' })]);
    expect(gesture?.start).toEqual({ x: 8, y: 9 });
  });

  it('gives nothing for a report with no finger down', () => {
    const reader = new TouchReader(identity);
    expect(feed(reader, report({ at: 1 }))).toEqual([]);
  });

  it('dates the touch on this computer\'s clock using the offset', () => {
    const reader = new TouchReader(identity);
    const [gesture] = feed(reader, [...report({ at: 100, slot: 0, id: 1, x: 1, y: 1 }), ...report({ at: 100.25, id: 'lift' })], 7000);
    expect(gesture?.downAt).toBeCloseTo(107_000, 0);
    expect(gesture?.upAt).toBeCloseTo(107_250, 0);
  });

  it('takes the offset from the line that arrived fastest, not from a late one', () => {
    const reader = new TouchReader(identity);
    // The down report arrives 400 ms late; the lift arrives promptly at +100.
    const down = report({ at: 50, slot: 0, id: 1, x: 1, y: 1 });
    for (const line of down.slice(0, -1)) reader.read(line, 50_000 + 400);
    reader.read(down.at(-1)!, 50_000 + 400);
    const lift = report({ at: 50.2, id: 'lift' });
    let gesture: TouchGesture | undefined;
    for (const line of lift) gesture = reader.read(line, 50_200 + 100) ?? gesture;
    expect(gesture?.durationMs).toBe(200);
    expect(gesture?.upAt).toBeCloseTo(50_300, 0);
  });
});
