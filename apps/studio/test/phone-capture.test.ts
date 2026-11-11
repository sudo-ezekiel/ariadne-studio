// Recording from a finger on the phone. A fake `watch` feeds `getevent -lt`
// lines into the real server and a fake device stands in for the screen, so
// these tests run the snapshot loop, the gesture reading and the recorder
// together without adb.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriverInstallRefused, type DeviceSnapshot, type MaestroRunner, type OpenOptions, type PhoneInput, type PhoneInputTools, type Point, type Rect, type XiaomiPhone } from '@ariadne/core';
import { buildServer } from '../src/server/index.ts';
import { PhoneCapture } from '../src/server/phone-capture.ts';
import { checkSetup, type SetupTools } from '../src/server/setup.ts';
import { defaultInstallIo, ToolInstaller } from '../src/server/tool-install.ts';
import type { DeviceLike } from '../src/server/state.ts';

type Node = DeviceSnapshot['nodes'][number];

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const APP = 'com.example';
const LAUNCHER = 'com.miui.home';
const VIEWPORT = { width: 1080, height: 2400 };
const KEYBOARD: Rect = { x: 0, y: 1500, width: 1080, height: 800 };
/** A raw range equal to the screen, so raw numbers are pixels. */
const INPUT: PhoneInput = {
  screen: { path: '/dev/input/event7', maxX: 1079, maxY: 2399 },
  longPressMs: 400,
  touchSlopPx: 20,
  gestureNavigation: false,
  homeApp: LAUNCHER,
};

// Where things are on the fake screens.
const SIGN_IN: Point = { x: 500, y: 350 };
const REGISTER: Point = { x: 500, y: 650 };
/** A key on the keyboard, at an unmistakable spot. */
const KEY: Point = { x: 731, y: 1913 };
const ENTER_KEY: Point = { x: 950, y: 2200 };

function field(identifier: string, y: number, extra: Partial<Node> = {}): Node {
  return { index: 0, depth: 2, bundleId: APP, type: 'android.widget.EditText', identifier, editable: true, rect: { x: 0, y, width: 1080, height: 120 }, ...extra } as Node;
}

function appScreen(extra: Node[] = []): Node[] {
  return [
    { index: 0, depth: 1, bundleId: APP, rect: { x: 0, y: 300, width: 1080, height: 100 }, label: 'Sign in', hittable: true } as Node,
    { index: 1, depth: 1, bundleId: APP, rect: { x: 0, y: 600, width: 1080, height: 100 }, label: 'Register', hittable: true } as Node,
    ...extra,
  ];
}

const keyboardNodes = (): Node[] =>
  [
    { index: 0, depth: 1, bundleId: 'com.keyboard', rect: { x: 650, y: 1850, width: 160, height: 120 }, label: 'k', hittable: true },
    { index: 1, depth: 1, bundleId: 'com.keyboard', rect: { x: 900, y: 2150, width: 150, height: 120 }, label: 'Enter', hittable: true },
  ] as Node[];

const launcherScreen = (): Node[] =>
  [{ index: 0, depth: 1, bundleId: LAUNCHER, rect: { x: 0, y: 0, width: 1080, height: 2400 }, label: 'Home screen', hittable: true }] as Node[];

/** The screen the server sees: tests change `nodes` to move the app on. */
class PhoneDevice implements DeviceLike {
  target: { deviceId: string; appId: string } | undefined;
  nodes: Node[] = appScreen();
  keyboard: Rect | undefined;
  snapshots = 0;
  captures = 0;
  openError: Error | undefined;
  /** While set, snapshots wait for it. The captures the studio takes for its own steps do not. */
  held: Promise<void> | undefined;

  get isOpen() { return this.target !== undefined; }
  get deviceId() { return this.target?.deviceId; }
  get appId() { return this.target?.appId; }

  async listDevices() {
    return [{ id: 'R58M123', name: 'Phone', platform: 'android' as const, kind: 'device' as const, booted: true }];
  }
  async open(options: OpenOptions) {
    if (this.openError) throw this.openError;
    this.target = { deviceId: options.deviceId, appId: options.appId };
  }
  async snapshot(): Promise<DeviceSnapshot> {
    await this.held;
    return this.look();
  }
  async capture(screenshotPath: string) {
    this.captures += 1;
    mkdirSync(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, PNG);
    return { ...this.look(), screenshotPath };
  }
  private look(): DeviceSnapshot {
    this.snapshots += 1;
    return { nodes: this.nodes, viewport: VIEWPORT, takenAt: new Date().toISOString(), ...(this.keyboard ? { keyboard: this.keyboard } : {}) };
  }
  async tapAt(_point: Point) {}
  async typeText(_text: string) {}
  async back() {}
  async scroll() {}
  async replayFlow() {
    return { replayed: 0 };
  }
  async close() {
    this.target = undefined;
  }
  async relaunchApp() {}
  async openLink() {}
  async hideKeyboard() {}
  async longPressAt() {}
  async doubleTapAt() {}
  async swipe() {}
  async pinch() {}
  async pressKey() {}
  async setOrientation() {}
}

/** Holds the device's snapshots, though not the studio's own captures, until the returned function is called. */
function holdSnapshots(device: PhoneDevice): () => void {
  let release: () => void = () => undefined;
  device.held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    device.held = undefined;
    release();
  };
}

type Rig = {
  app: FastifyInstance;
  device: PhoneDevice;
  dir: string;
  tools: { read: ReturnType<typeof vi.fn>; watch: ReturnType<typeof vi.fn>; xiaomi: ReturnType<typeof vi.fn>; allowDriver: ReturnType<typeof vi.fn>; installDriver: ReturnType<typeof vi.fn>; stopDriver: ReturnType<typeof vi.fn>; locked: ReturnType<typeof vi.fn> };
  runMaestro: ReturnType<typeof vi.fn<MaestroRunner>>;
  /** Lines in, as getevent would print them. */
  line(text: string): void;
  /** adb stopping by itself. */
  endWatch(): void;
  stopped(): number;
};

let rigs: Rig[] = [];

async function rig(overrides: Partial<PhoneInputTools> = {}, findBin: () => string = () => '/opt/maestro/bin/maestro'): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'ariadne-phone-test-'));
  const device = new PhoneDevice();
  let onLine: (line: string) => void = () => undefined;
  let onEnd: () => void = () => undefined;
  let stops = 0;
  const tools = {
    read: vi.fn(async () => INPUT as PhoneInput | undefined),
    watch: vi.fn((_id: string, _path: string, line: (text: string) => void, end: () => void) => {
      onLine = line;
      onEnd = end;
      return () => {
        stops += 1;
      };
    }),
    xiaomi: vi.fn(async (): Promise<XiaomiPhone | undefined> => undefined),
    allowDriver: vi.fn(async () => undefined),
    installDriver: vi.fn(async (_id: string, _maestroBin: string) => undefined),
    stopDriver: vi.fn(async (_id: string) => undefined),
    locked: vi.fn(async (_id: string): Promise<boolean | undefined> => false),
  };
  const runMaestro = vi.fn<MaestroRunner>(async () => {
    throw new Error('Maestro was not expected to run in this test');
  });
  const app = await buildServer({
    projectDir: dir,
    session: device,
    maestro: { run: runMaestro, findBin, androidHome: () => undefined },
    phoneTools: { rotation: async () => 0, ...tools, ...overrides },
  });
  const made: Rig = { app, device, dir, tools, runMaestro, line: (text) => onLine(text), endWatch: () => onEnd(), stopped: () => stops };
  rigs.push(made);
  return made;
}

beforeEach(() => {
  // The studio logs every request; polling for steps would fill the report.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const made of rigs) {
    await made.app.close();
    await rm(made.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  rigs = [];
});

async function call(r: Rig, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object) {
  const response = await r.app.inject({ method, url, ...(payload ? { payload } : {}) });
  return { status: response.statusCode, body: response.headers['content-type']?.includes('json') ? response.json() : response.body };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** Waits for the snapshot loop to have seen the screen a few times, allowing for the slow listening pace. */
async function settled(r: Rig, count = 3): Promise<void> {
  const target = r.device.snapshots + count;
  await waitFor(() => r.device.snapshots >= target, 'snapshots', 4000 + count * 500);
}

async function currentSteps(r: Rig): Promise<Array<Record<string, any>>> {
  return (await call(r, 'GET', '/api/case/current')).body.steps;
}

async function waitForSteps(r: Rig, count: number): Promise<Array<Record<string, any>>> {
  let steps: Array<Record<string, any>> = [];
  await waitFor(async () => {
    steps = await currentSteps(r);
    return steps.length >= count;
  }, `${count} steps`);
  return steps;
}

const hex = (n: number) => n.toString(16).padStart(8, '0');
function ev(type: string, code: string, value: string): string {
  return `[ ${(Date.now() / 1000).toFixed(6).padStart(12)}] ${type.padEnd(12)} ${code.padEnd(20)} ${value}`;
}
const report = () => ev('EV_SYN', 'SYN_REPORT', '00000000');

/** One finger down and up at a screen position (raw equals pixels in these tests). */
async function finger(r: Rig, at: Point, hold = 30): Promise<void> {
  r.line(ev('EV_ABS', 'ABS_MT_SLOT', hex(0)));
  r.line(ev('EV_ABS', 'ABS_MT_TRACKING_ID', hex(1)));
  r.line(ev('EV_ABS', 'ABS_MT_POSITION_X', hex(at.x)));
  r.line(ev('EV_ABS', 'ABS_MT_POSITION_Y', hex(at.y)));
  r.line(report());
  await sleep(hold);
  r.line(ev('EV_ABS', 'ABS_MT_TRACKING_ID', 'ffffffff'));
  r.line(report());
}

/** Two fingers down together, then both up. */
async function twoFingers(r: Rig, a: Point, b: Point): Promise<void> {
  r.line(ev('EV_ABS', 'ABS_MT_SLOT', hex(0)));
  r.line(ev('EV_ABS', 'ABS_MT_TRACKING_ID', hex(1)));
  r.line(ev('EV_ABS', 'ABS_MT_POSITION_X', hex(a.x)));
  r.line(ev('EV_ABS', 'ABS_MT_POSITION_Y', hex(a.y)));
  r.line(ev('EV_ABS', 'ABS_MT_SLOT', hex(1)));
  r.line(ev('EV_ABS', 'ABS_MT_TRACKING_ID', hex(2)));
  r.line(ev('EV_ABS', 'ABS_MT_POSITION_X', hex(b.x)));
  r.line(ev('EV_ABS', 'ABS_MT_POSITION_Y', hex(b.y)));
  r.line(report());
  await sleep(30);
  r.line(ev('EV_ABS', 'ABS_MT_SLOT', hex(0)));
  r.line(ev('EV_ABS', 'ABS_MT_TRACKING_ID', 'ffffffff'));
  r.line(ev('EV_ABS', 'ABS_MT_SLOT', hex(1)));
  r.line(ev('EV_ABS', 'ABS_MT_TRACKING_ID', 'ffffffff'));
  r.line(report());
}

async function openAndRecord(r: Rig, name = 'Phone case'): Promise<string> {
  expect((await call(r, 'POST', '/api/session/open', { deviceId: 'R58M123', appId: APP })).status).toBe(200);
  const started = await call(r, 'POST', '/api/case/start', { name });
  expect(started.status).toBe(200);
  return started.body.caseId;
}

async function startPhone(r: Rig, caseName?: string): Promise<string> {
  const caseId = await openAndRecord(r, caseName);
  const status = await call(r, 'POST', '/api/phone/start');
  expect(status).toMatchObject({ status: 200, body: { active: true, paused: false } });
  await settled(r);
  return caseId;
}

async function status(r: Rig) {
  return (await call(r, 'GET', '/api/phone')).body;
}

describe('starting to record from the phone', () => {
  it('is refused without a device session', async () => {
    const r = await rig();
    expect(await call(r, 'POST', '/api/phone/start')).toMatchObject({ status: 409, body: { error: { code: 'NO_SESSION' } } });
    expect(r.tools.watch).not.toHaveBeenCalled();
  });

  it('is refused without a case being recorded', async () => {
    const r = await rig();
    await call(r, 'POST', '/api/session/open', { deviceId: 'R58M123', appId: APP });
    expect(await call(r, 'POST', '/api/phone/start')).toMatchObject({ status: 409, body: { error: { code: 'NO_CASE' } } });
    expect(r.tools.watch).not.toHaveBeenCalled();
  });

  it('is refused with 409 NO_TOUCHSCREEN when the device has no touchscreen to read', async () => {
    const r = await rig({ read: async () => undefined });
    await openAndRecord(r);
    expect(await call(r, 'POST', '/api/phone/start')).toMatchObject({ status: 409, body: { error: { code: 'NO_TOUCHSCREEN' } } });
    expect(await status(r)).toMatchObject({ active: false });
    expect(r.tools.watch).not.toHaveBeenCalled();
  });

  it('reports active, not paused, and the same status when started twice', async () => {
    const r = await rig();
    await startPhone(r);
    expect(await call(r, 'POST', '/api/phone/start')).toMatchObject({ status: 200, body: { active: true, paused: false } });
    expect(r.tools.watch).toHaveBeenCalledTimes(1);
  });

  it('reads the touchscreen of the session\'s own device', async () => {
    const r = await rig();
    await startPhone(r);
    expect(r.tools.read).toHaveBeenCalledWith('R58M123');
    expect(r.tools.watch).toHaveBeenCalledWith('R58M123', INPUT.screen.path, expect.any(Function), expect.any(Function));
  });
});

describe('recording touches', () => {
  it('records a tap as a step with a selector for the element touched', async () => {
    const r = await rig();
    await startPhone(r);
    await finger(r, SIGN_IN);
    const [step] = await waitForSteps(r, 1);
    expect(step).toMatchObject({ index: 1, kind: 'tap', selector: { kind: 'text', value: 'Sign in' } });
    expect(step?.review).toBeUndefined();
  });

  it('records taps in the order they were made', async () => {
    const r = await rig();
    await startPhone(r);
    await finger(r, SIGN_IN);
    await waitForSteps(r, 1);
    await finger(r, REGISTER);
    const steps = await waitForSteps(r, 2);
    expect(steps.map((step) => step.selector.value)).toEqual(['Sign in', 'Register']);
  });

  it('records a swipe as a swipe step', async () => {
    const r = await rig();
    await startPhone(r);
    r.line(ev('EV_ABS', 'ABS_MT_SLOT', hex(0)));
    r.line(ev('EV_ABS', 'ABS_MT_TRACKING_ID', hex(1)));
    r.line(ev('EV_ABS', 'ABS_MT_POSITION_X', hex(540)));
    r.line(ev('EV_ABS', 'ABS_MT_POSITION_Y', hex(1800)));
    r.line(report());
    await sleep(20);
    r.line(ev('EV_ABS', 'ABS_MT_POSITION_Y', hex(900)));
    r.line(report());
    await sleep(20);
    r.line(ev('EV_ABS', 'ABS_MT_TRACKING_ID', 'ffffffff'));
    r.line(report());
    const [step] = await waitForSteps(r, 1);
    expect(step).toMatchObject({ kind: 'swipe', from: { xPercent: 50, yPercent: 75 }, to: { xPercent: 50, yPercent: 38 } });
  });

  it('flags a touch on the background, which has no element, as no-element', async () => {
    const r = await rig();
    r.device.nodes = [{ index: 0, depth: 0, bundleId: APP, identifier: 'root', rect: { x: 0, y: 0, width: 1080, height: 2400 } } as Node];
    await startPhone(r);
    await finger(r, { x: 500, y: 1000 });
    const [step] = await waitForSteps(r, 1);
    expect(step).toMatchObject({ kind: 'tap', selector: { kind: 'point' }, review: 'no-element' });
  });

  it('records nothing for a tap on Recent apps and tells the tester', async () => {
    const r = await rig();
    r.device.nodes = appScreen([
      { index: 5, depth: 1, bundleId: 'com.android.systemui', systemBar: 'navigation', identifier: 'com.android.systemui:id/recent_apps', rect: { x: 780, y: 2300, width: 200, height: 100 } } as Node,
    ]);
    await startPhone(r);
    await finger(r, { x: 880, y: 2350 });
    await waitFor(async () => (await status(r)).notice !== undefined, 'a notice');
    const { notice } = await status(r);
    expect(notice.text).toMatch(/Recent apps/);
    expect(await currentSteps(r)).toEqual([]);
  });

  it('records nothing for a two-finger gesture and tells the tester', async () => {
    const r = await rig();
    await startPhone(r);
    await twoFingers(r, { x: 300, y: 800 }, { x: 700, y: 900 });
    await waitFor(async () => (await status(r)).notice !== undefined, 'a notice');
    expect((await status(r)).notice.text).toMatch(/two-finger/i);
    expect(await currentSteps(r)).toEqual([]);
  });

  it('numbers each notice, so a repeated one is seen again', async () => {
    const r = await rig();
    await startPhone(r);
    await twoFingers(r, { x: 300, y: 800 }, { x: 700, y: 900 });
    await waitFor(async () => (await status(r)).notice?.id === 1, 'the first notice');
    await twoFingers(r, { x: 300, y: 800 }, { x: 700, y: 900 });
    await waitFor(async () => (await status(r)).notice?.id === 2, 'the second notice');
  });

  it('shares one screenshot between steps made in a burst, and every step has its file', async () => {
    const r = await rig();
    const caseId = await startPhone(r);
    await finger(r, SIGN_IN);
    await finger(r, REGISTER);
    await waitForSteps(r, 2);
    expect((await call(r, 'POST', '/api/phone/stop')).body.active).toBe(false);
    const steps = await currentSteps(r);
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step.screenshot).toMatch(new RegExp(`^evidence/${caseId}/step-00\\d\\.png$`));
      expect(existsSync(join(r.dir, step.screenshot))).toBe(true);
    }
    expect((await readdir(join(r.dir, 'evidence', caseId))).sort()).toEqual(['step-001.png', 'step-002.png']);
  });
});

describe('recording typing', () => {
  it('records nothing for a key press on the keyboard', async () => {
    const r = await rig();
    r.device.nodes = appScreen([field('f', 900, { focused: true, value: '' }), ...keyboardNodes()]);
    r.device.keyboard = KEYBOARD;
    await startPhone(r);
    await finger(r, KEY);
    await finger(r, KEY);
    await sleep(150);
    expect(await currentSteps(r)).toEqual([]);
    expect((await status(r)).notice).toBeUndefined();
  });

  it('turns text that arrived with no touches (paste, autofill) into a type step at the next gesture', async () => {
    const r = await rig();
    r.device.nodes = appScreen([field('f', 900, { focused: true, value: '' })]);
    await startPhone(r);
    r.device.nodes = appScreen([field('f', 900, { focused: true, value: 'pasted text' })]);
    await settled(r);
    await finger(r, REGISTER);
    const steps = await waitForSteps(r, 2);
    expect(steps.map((step) => step.kind)).toEqual(['type', 'tap']);
    expect(steps[0]?.text).toBe('pasted text');
  });

  it('keeps text waiting when focus moves to another field, and writes it at the next gesture', async () => {
    const r = await rig();
    r.device.nodes = appScreen([field('first', 900, { focused: true, value: '' }), field('second', 1100, { value: '' })]);
    await startPhone(r);
    r.device.nodes = appScreen([field('first', 900, { focused: true, value: 'maria' }), field('second', 1100, { value: '' })]);
    await settled(r);
    r.device.nodes = appScreen([field('first', 900, { value: 'maria' }), field('second', 1100, { focused: true, value: '' })]);
    await settled(r);
    await finger(r, SIGN_IN);
    const steps = await waitForSteps(r, 2);
    expect(steps.map((step) => step.kind)).toEqual(['type', 'tap']);
    expect(steps[0]?.text).toBe('maria');
  });

  it('records an erase flagged edited-text, then the new text, when a field had text and it changed', async () => {
    const r = await rig();
    r.device.nodes = appScreen([field('qty', 900, { focused: true, value: '2' })]);
    await startPhone(r);
    r.device.nodes = appScreen([field('qty', 900, { focused: true, value: '4' })]);
    await settled(r);
    await finger(r, REGISTER);
    const steps = await waitForSteps(r, 3);
    expect(steps.map((step) => step.kind)).toEqual(['erase', 'type', 'tap']);
    expect(steps[0]).toMatchObject({ chars: 1, review: 'edited-text' });
    expect(steps[1]?.text).toBe('4');
    expect(steps[1]?.review).toBeUndefined();
  });

  it('records typed text that equals a saved value as its placeholder', async () => {
    const r = await rig();
    await writeFile(join(r.dir, '.env'), 'USERNAME=maria.k\n');
    r.device.nodes = appScreen([field('user', 900, { focused: true, value: '' })]);
    await startPhone(r);
    r.device.nodes = appScreen([field('user', 900, { focused: true, value: 'maria.k' })]);
    await settled(r);
    await finger(r, REGISTER);
    const steps = await waitForSteps(r, 2);
    expect(steps[0]).toMatchObject({ kind: 'type', text: '${USERNAME}' });
  });

  it('presses Enter when the submit key on the keyboard is touched, and writes the typed text first', async () => {
    const r = await rig();
    r.device.nodes = appScreen([field('q', 900, { focused: true, value: '' }), ...keyboardNodes()]);
    r.device.keyboard = KEYBOARD;
    await startPhone(r);
    r.device.nodes = appScreen([field('q', 900, { focused: true, value: 'cats' }), ...keyboardNodes()]);
    await settled(r);
    await finger(r, ENTER_KEY);
    const steps = await waitForSteps(r, 2);
    expect(steps.map((step) => step.kind)).toEqual(['type', 'pressKey']);
    expect(steps[1]).toMatchObject({ key: 'enter' });
    expect(steps[0]?.text).toBe('cats');
  });
});

describe('a key pressed before the keyboard shows in snapshots', () => {
  const FIELD = (focused: boolean) => field('q', 900, { focused, value: '' });

  it('records no step and keeps the position out of the case and the console when the band appears a snapshot later', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    log.mockClear();
    const r = await rig();
    r.device.nodes = appScreen([FIELD(false)]);
    const caseId = await startPhone(r);
    // The field takes focus, and a key is pressed at once: no band in any snapshot yet.
    r.device.nodes = appScreen([FIELD(true)]);
    await settled(r, 1);
    await finger(r, KEY);
    await sleep(40);
    r.device.nodes = appScreen([FIELD(true), ...keyboardNodes()]);
    r.device.keyboard = KEYBOARD;
    await settled(r);
    await sleep(300);
    expect(await currentSteps(r)).toEqual([]);
    expect((await status(r)).notice).toBeUndefined();

    await call(r, 'POST', '/api/case/finish');
    const caseFile = await readFile(join(r.dir, 'cases', `${caseId}.json`), 'utf8');
    const output = [...log.mock.calls, ...error.mock.calls].map((args) => args.map(String).join(' ')).join('\n');
    for (const text of [caseFile, output]) {
      expect(text).not.toMatch(/\b731\b/);
      expect(text).not.toMatch(/\b1913\b/);
    }
  });

  it('records no step for a key pressed while the keyboard is never reported at all', async () => {
    const r = await rig();
    r.device.nodes = appScreen([FIELD(false)]);
    await startPhone(r);
    r.device.nodes = appScreen([FIELD(true)]);
    await settled(r, 1);
    await finger(r, KEY);
    await sleep(400);
    expect(await currentSteps(r)).toEqual([]);
  });

  it('records a touch low on the screen as a step when it comes 2 seconds after focus and no keyboard was reported', async () => {
    const r = await rig();
    const submit = { index: 9, depth: 1, bundleId: APP, label: 'Submit', hittable: true, rect: { x: 0, y: 2100, width: 1080, height: 150 } } as Node;
    r.device.nodes = appScreen([FIELD(false), submit]);
    await startPhone(r);
    r.device.nodes = appScreen([FIELD(true), submit]);
    await sleep(2000);
    await finger(r, { x: 500, y: 2150 });
    const [step] = await waitForSteps(r, 1);
    expect(step).toMatchObject({ kind: 'tap', selector: { kind: 'text', value: 'Submit' } });
  });
});

describe('typing into a password field', () => {
  const SECRET = 'hunter2-Sup3r';

  async function typePassword(r: Rig): Promise<string> {
    r.device.nodes = appScreen([field('pw', 900, { focused: true, password: true, value: '' }), ...keyboardNodes()]);
    r.device.keyboard = KEYBOARD;
    const caseId = await startPhone(r);
    // The screen now carries the password in every property a node can use.
    r.device.nodes = appScreen([
      field('pw', 900, { focused: true, password: true, value: SECRET, label: SECRET, text: SECRET } as Partial<Node>),
      ...keyboardNodes(),
    ]);
    await finger(r, KEY);
    await settled(r);
    await finger(r, KEY);
    await settled(r);
    await finger(r, REGISTER);
    return caseId;
  }

  it('records a placeholder step flagged password, never the text on the screen', async () => {
    const r = await rig();
    await typePassword(r);
    const steps = await waitForSteps(r, 2);
    expect(steps[0]).toMatchObject({ kind: 'type', text: '${PASSWORD}', review: 'password' });
    expect(steps[1]).toMatchObject({ kind: 'tap' });
    expect(JSON.stringify(await currentSteps(r))).not.toContain(SECRET);
  });

  it('records the email, the tap and the password placeholder, and no erase, when both fields share one identifier', async () => {
    const r = await rig();
    const SHARED = 'RNE__Input__text-input';
    const PASSWORD_AT: Point = { x: 500, y: 1060 };
    const email = (focused: boolean, value: string) => field(SHARED, 800, { focused, value });
    const password = (focused: boolean, value = '') => field(SHARED, 1000, { focused, password: true, value });
    r.device.nodes = appScreen([email(true, ''), password(false), ...keyboardNodes()]);
    r.device.keyboard = KEYBOARD;
    await startPhone(r);
    r.device.nodes = appScreen([email(true, 'ba@example.com'), password(false), ...keyboardNodes()]);
    await settled(r);
    await finger(r, PASSWORD_AT);
    r.device.nodes = appScreen([email(false, 'ba@example.com'), password(true, SECRET), ...keyboardNodes()]);
    await settled(r);
    await finger(r, KEY);
    await settled(r);
    await finger(r, KEY);
    await settled(r);
    await finger(r, REGISTER);
    const steps = await waitForSteps(r, 4);
    expect(steps.map((step) => step.kind)).toEqual(['type', 'tap', 'type', 'tap']);
    expect(steps[0]?.text).toBe('ba@example.com');
    expect(steps[2]).toMatchObject({ text: '${PASSWORD}', review: 'password' });
    expect(steps.some((step) => step.kind === 'erase')).toBe(false);
    expect(JSON.stringify(steps)).not.toContain(SECRET);
  });

  it('uses the saved value whose name mentions pass for the placeholder', async () => {
    const r = await rig();
    await writeFile(join(r.dir, '.env'), 'USERNAME=maria\nADMIN_PASS=whatever\n');
    await typePassword(r);
    const steps = await waitForSteps(r, 2);
    expect(steps[0]).toMatchObject({ text: '${ADMIN_PASS}', review: 'password' });
  });

  it('records no step when a password field is focused and nothing was pressed', async () => {
    const r = await rig();
    r.device.nodes = appScreen([field('pw', 900, { focused: true, password: true, value: SECRET })]);
    await startPhone(r);
    await finger(r, REGISTER);
    const steps = await waitForSteps(r, 1);
    expect(steps.map((step) => step.kind)).toEqual(['tap']);
  });

  it('puts no raw touch position and no password in console output, the case file or the steps', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    log.mockClear();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const r = await rig();
    const caseId = await typePassword(r);
    await waitForSteps(r, 2);
    await call(r, 'POST', '/api/case/finish');

    const output = [...log.mock.calls, ...error.mock.calls, ...warn.mock.calls, ...info.mock.calls].map((args) => args.map(String).join(' ')).join('\n');
    const caseFile = await readFile(join(r.dir, 'cases', `${caseId}.json`), 'utf8');
    const flowFile = await readFile(join(r.dir, 'flows', `${caseId}.yaml`), 'utf8');
    for (const text of [output, caseFile, flowFile]) {
      expect(text).not.toMatch(/\b731\b/);
      expect(text).not.toMatch(/\b1913\b/);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('ABS_MT');
    }
    // Sanity: the spies did see the studio's own request log, so an empty `output` is not a broken spy.
    expect(output).toContain('/api/phone/start');
  });
});

describe('leaving the app', () => {
  it('pauses on the home screen, ignores touches while paused, and resumes when the app is back', async () => {
    const r = await rig();
    await startPhone(r);
    r.device.nodes = launcherScreen();
    await waitFor(async () => (await status(r)).paused === true, 'pause');
    await finger(r, { x: 300, y: 300 });
    await sleep(150);
    expect(await currentSteps(r)).toEqual([]);
    r.device.nodes = appScreen();
    await waitFor(async () => (await status(r)).paused === false, 'resume');
  });

  it('pauses when the notification shade covers the app', async () => {
    const r = await rig();
    await startPhone(r);
    r.device.nodes = [{ index: 0, depth: 1, bundleId: 'com.android.systemui', rect: { x: 0, y: 0, width: 1080, height: 2400 }, label: 'Quick settings', hittable: true } as Node];
    await waitFor(async () => (await status(r)).paused === true, 'pause');
  });

  it('counts each pause and resume as a change in the status revision', async () => {
    const r = await rig();
    await startPhone(r);
    const before = (await status(r)).revision;
    r.device.nodes = launcherScreen();
    await waitFor(async () => (await status(r)).paused === true, 'pause');
    expect((await status(r)).revision).toBeGreaterThan(before);
  });

  it('flags the first step after coming back as left-app', async () => {
    const r = await rig();
    await startPhone(r);
    r.device.nodes = launcherScreen();
    await waitFor(async () => (await status(r)).paused === true, 'pause');
    r.device.nodes = appScreen();
    await waitFor(async () => (await status(r)).paused === false, 'resume');
    await settled(r);
    await finger(r, SIGN_IN);
    await waitForSteps(r, 1);
    await finger(r, REGISTER);
    const steps = await waitForSteps(r, 2);
    expect(steps[0]).toMatchObject({ kind: 'tap', review: 'left-app' });
    expect(steps[1]?.review).toBeUndefined();
  });

  it('puts left-app ahead of screen-moving on the same step', async () => {
    const r = await rig();
    await startPhone(r);
    // A screen with no package between the last app screen and the touch reads as one still moving...
    r.device.nodes = [];
    await settled(r);
    await finger(r, SIGN_IN);
    expect((await waitForSteps(r, 1))[0]).toMatchObject({ kind: 'tap', review: 'screen-moving' });

    // ...and after a trip to the launcher the same situation is flagged left-app.
    r.device.nodes = launcherScreen();
    await waitFor(async () => (await status(r)).paused === true, 'pause');
    r.device.nodes = appScreen();
    await waitFor(async () => (await status(r)).paused === false, 'resume');
    r.device.nodes = [];
    await settled(r);
    await finger(r, REGISTER);
    expect((await waitForSteps(r, 2))[1]).toMatchObject({ kind: 'tap', review: 'left-app' });
  });
});

describe('the lock screen while recording', () => {
  it('records nothing while the phone says it is locked, even with the app in front', async () => {
    const r = await rig();
    await startPhone(r);
    r.tools.locked.mockImplementation(async () => true);
    await waitFor(async () => (await status(r)).paused === true, 'pause');
    await finger(r, SIGN_IN);
    await finger(r, REGISTER);
    await sleep(150);
    expect(await currentSteps(r)).toEqual([]);
  });

  it('stays paused for as long as the phone is locked', async () => {
    const r = await rig();
    await startPhone(r);
    r.tools.locked.mockImplementation(async () => true);
    await waitFor(async () => (await status(r)).paused === true, 'pause');
    const pauses = (await status(r)).revision;
    await settled(r, 10);
    expect(await status(r)).toMatchObject({ paused: true, revision: pauses });
  });

  it('records again once the phone is unlocked and the app is in front', async () => {
    const r = await rig();
    await startPhone(r);
    r.tools.locked.mockImplementation(async () => true);
    await waitFor(async () => (await status(r)).paused === true, 'pause');
    r.tools.locked.mockImplementation(async () => false);
    await waitFor(async () => (await status(r)).paused === false, 'resume');
    await settled(r);
    await finger(r, SIGN_IN);
    expect((await waitForSteps(r, 1))[0]).toMatchObject({ kind: 'tap', review: 'left-app' });
  });

  it('does not resume on unlock while the app is not in front', async () => {
    const r = await rig();
    await startPhone(r);
    r.tools.locked.mockImplementation(async () => true);
    await waitFor(async () => (await status(r)).paused === true, 'pause');
    r.device.nodes = launcherScreen();
    r.tools.locked.mockImplementation(async () => false);
    await settled(r, 10);
    await sleep(1100);
    expect((await status(r)).paused).toBe(true);
  });

  it('treats a phone that has never been able to say as unlocked', async () => {
    const r = await rig();
    // Before the case opens, so the phone never answers at all.
    r.tools.locked.mockImplementation(async () => undefined);
    await startPhone(r);
    await settled(r, 10);
    await sleep(1100);
    expect((await status(r)).paused).toBe(false);
    await finger(r, SIGN_IN);
    expect((await waitForSteps(r, 1))[0]).toMatchObject({ kind: 'tap' });
  });

  it('pauses when a phone that has answered stops saying, and resumes once it answers false again', async () => {
    const r = await rig();
    await startPhone(r);
    expect(r.tools.locked).toHaveBeenCalled();
    r.tools.locked.mockImplementation(async () => undefined);
    await waitFor(async () => (await status(r)).paused === true, 'pause');
    await finger(r, SIGN_IN);
    await sleep(150);
    expect(await currentSteps(r)).toEqual([]);
    r.tools.locked.mockImplementation(async () => false);
    await waitFor(async () => (await status(r)).paused === false, 'resume');
    await settled(r);
    await finger(r, SIGN_IN);
    expect((await waitForSteps(r, 1))[0]).toMatchObject({ kind: 'tap' });
  });

  it('asks the phone at most once a second across many snapshots', async () => {
    const r = await rig();
    await startPhone(r);
    // A touch makes the capture follow, so snapshots come back to back.
    await finger(r, SIGN_IN);
    await waitFor(async () => (await status(r)).following === true, 'following');
    r.tools.locked.mockClear();
    const snapshots = r.device.snapshots;
    const started = Date.now();
    await settled(r, 40);
    const elapsed = Date.now() - started;
    expect(r.device.snapshots - snapshots).toBeGreaterThanOrEqual(40);
    expect(r.tools.locked.mock.calls.length).toBeLessThanOrEqual(Math.floor(elapsed / 1000) + 1);
  });
});

describe('the studio while the phone is the input', () => {
  it('lets a tap from the screen through and records its step', async () => {
    const r = await rig();
    await startPhone(r);
    const response = await call(r, 'POST', '/api/action/tap', { x: SIGN_IN.x, y: SIGN_IN.y });
    expect(response.status).toBe(200);
    expect(response.body.step).toMatchObject({ kind: 'tap', selector: { kind: 'text', value: 'Sign in' } });
    expect(await currentSteps(r)).toMatchObject([{ index: 1, kind: 'tap' }]);
  });

  it('lets running a block through and records it as one step', async () => {
    const r = await rig();
    await mkdir(join(r.dir, 'blocks'), { recursive: true });
    await writeFile(join(r.dir, 'blocks', 'second.yaml'), `appId: ${APP}\n---\n- back\n`);
    await startPhone(r);
    const response = await call(r, 'POST', '/api/case/block', { file: 'blocks/second.yaml' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.step).toMatchObject({ kind: 'block', file: 'blocks/second.yaml' });
    expect(await currentSteps(r)).toMatchObject([{ kind: 'block', file: 'blocks/second.yaml' }]);
  });

  it('still allows a check on the screen', async () => {
    const r = await rig();
    await startPhone(r);
    const response = await call(r, 'POST', '/api/case/expect', { x: SIGN_IN.x, y: SIGN_IN.y });
    expect(response.status).toBe(200);
    expect(response.body.step).toMatchObject({ kind: 'expect' });
  });

  it('lets a wait through, since it touches nothing on the phone', async () => {
    const r = await rig();
    await startPhone(r);
    const response = await call(r, 'POST', '/api/case/wait', { seconds: 5 });
    expect(response.status).toBe(200);
    expect(response.body.step).toMatchObject({ kind: 'wait', seconds: 5 });
  });

  it('refuses to type an unsaved value into a password field the phone moved the focus to since the screen here last looked', async () => {
    const r = await rig();
    const SECRET = 'hunter2-Sup3r';
    const user = (focused: boolean) => field('user', 900, { focused, value: '' });
    const password = (focused: boolean) => field('pw', 1100, { focused, password: true, value: '' });
    r.device.nodes = appScreen([user(true), password(false)]);
    await startPhone(r);
    // A tap on the phone moved the focus; nothing here has captured the screen since.
    r.device.nodes = appScreen([user(false), password(true)]);
    const typed = vi.fn(async (_text: string) => undefined);
    r.device.typeText = typed;
    const response = await call(r, 'POST', '/api/action/type', { text: SECRET });
    expect(response).toMatchObject({ status: 400, body: { error: { code: 'PASSWORD_FIELD' } } });
    expect(typed).not.toHaveBeenCalled();
    expect(JSON.stringify(await currentSteps(r))).not.toContain(SECRET);
  });

  it('allows actions again once the phone is stopped', async () => {
    const r = await rig();
    await startPhone(r);
    await call(r, 'POST', '/api/phone/stop');
    expect((await call(r, 'POST', '/api/action/tap', { x: SIGN_IN.x, y: SIGN_IN.y })).status).toBe(200);
  });

  it('is stopped by finishing the case', async () => {
    const r = await rig();
    await startPhone(r);
    await finger(r, SIGN_IN);
    await waitForSteps(r, 1);
    expect((await call(r, 'POST', '/api/case/finish')).status).toBe(200);
    expect(await status(r)).toMatchObject({ active: false });
    expect(r.stopped()).toBe(1);
  });

  it('is stopped by discarding the case', async () => {
    const r = await rig();
    await startPhone(r);
    expect((await call(r, 'POST', '/api/case/discard')).status).toBe(200);
    expect(await status(r)).toMatchObject({ active: false });
    expect(r.stopped()).toBe(1);
  });

  it('is stopped by closing the session', async () => {
    const r = await rig();
    await startPhone(r);
    await call(r, 'POST', '/api/session/close');
    expect(await status(r)).toMatchObject({ active: false });
    expect(r.stopped()).toBe(1);
  });

  it('stops the touch stream once when stopped twice', async () => {
    const r = await rig();
    await startPhone(r);
    await call(r, 'POST', '/api/phone/stop');
    await call(r, 'POST', '/api/phone/stop');
    expect(r.stopped()).toBe(1);
  });

  it('sets an error and turns off when the touch stream ends by itself', async () => {
    const r = await rig();
    await startPhone(r);
    r.endWatch();
    await waitFor(async () => (await status(r)).active === false, 'the capture to stop');
    expect((await status(r)).error).toMatch(/stopped sending touches/);
  });

  it('clears an earlier error when started again', async () => {
    const r = await rig();
    await startPhone(r);
    r.endWatch();
    await waitFor(async () => (await status(r)).error !== undefined, 'the error');
    expect(await call(r, 'POST', '/api/phone/start')).toMatchObject({ status: 200, body: { active: true } });
    expect((await status(r)).error).toBeUndefined();
  });

  it('serves the screen refresh route for a screen that changed without a step', async () => {
    const r = await rig();
    await call(r, 'POST', '/api/session/open', { deviceId: 'R58M123', appId: APP });
    const refreshed = await call(r, 'POST', '/api/screen/refresh');
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.nodes.map((node: { label?: string }) => node.label)).toEqual(['Sign in', 'Register']);
    r.device.nodes = launcherScreen();
    expect((await call(r, 'POST', '/api/screen/refresh')).body.nodes.map((node: { label?: string }) => node.label)).toEqual(['Home screen']);
  });

  it('refuses a screen refresh without a session', async () => {
    const r = await rig();
    expect(await call(r, 'POST', '/api/screen/refresh')).toMatchObject({ status: 409, body: { error: { code: 'NO_SESSION' } } });
  });
});

describe('the two paces of the capture', () => {
  it('is listening, not following, right after it starts', async () => {
    const r = await rig();
    await openAndRecord(r);
    expect(await call(r, 'POST', '/api/phone/start')).toMatchObject({ status: 200, body: { active: true, following: false } });
    expect(await status(r)).toMatchObject({ active: true, following: false });
  });

  it('is off, and not following, before it starts', async () => {
    const r = await rig();
    expect(await status(r)).toMatchObject({ active: false, following: false });
  });

  it('follows from the first touch and counts that as a change in the revision', async () => {
    const r = await rig();
    await startPhone(r);
    const before = (await status(r)).revision;
    await finger(r, SIGN_IN);
    await waitFor(async () => (await status(r)).following === true, 'following');
    expect((await status(r)).revision).toBeGreaterThan(before);
  });

  it('takes snapshots more slowly while listening than while following', async () => {
    const r = await rig();
    await startPhone(r);
    const listeningFrom = r.device.snapshots;
    await sleep(1000);
    const listening = r.device.snapshots - listeningFrom;
    await finger(r, SIGN_IN);
    await waitFor(async () => (await status(r)).following === true, 'following');
    const followingFrom = r.device.snapshots;
    await sleep(300);
    const following = r.device.snapshots - followingFrom;
    expect(listening).toBeLessThanOrEqual(5);
    expect(following).toBeGreaterThan(listening);
    expect(following).toBeGreaterThanOrEqual(6);
  });

  it('writes the text typed on the phone before a check from the screen, and listens again afterwards', async () => {
    const r = await rig();
    r.device.nodes = appScreen([field('f', 900, { focused: true, value: '' })]);
    await startPhone(r);
    await finger(r, { x: 500, y: 950 });
    await waitForSteps(r, 1);
    r.device.nodes = appScreen([field('f', 900, { focused: true, value: 'maria' })]);
    await settled(r);
    expect((await status(r)).following).toBe(true);
    const checked = await call(r, 'POST', '/api/case/expect', { x: SIGN_IN.x, y: SIGN_IN.y });
    expect(checked.status).toBe(200);
    const steps = await currentSteps(r);
    expect(steps.map((step) => step.kind)).toEqual(['tap', 'type', 'expect']);
    expect(steps[1]?.text).toBe('maria');
    expect((await status(r)).following).toBe(false);
  });

  it('does not write text typed from the screen a second time as the phone\'s typing', async () => {
    const r = await rig();
    r.device.nodes = appScreen([field('f', 900, { focused: true, value: '' })]);
    await startPhone(r);
    r.device.typeText = async (text: string) => {
      r.device.nodes = appScreen([field('f', 900, { focused: true, value: text })]);
    };
    await finger(r, SIGN_IN);
    await waitForSteps(r, 1);
    expect((await call(r, 'POST', '/api/action/type', { text: 'hello' })).status).toBe(200);
    await settled(r);
    await finger(r, REGISTER);
    const steps = await waitForSteps(r, 3);
    await sleep(200);
    const all = await currentSteps(r);
    expect(all.map((step) => step.kind)).toEqual(['tap', 'type', 'tap']);
    expect(all.filter((step) => step.kind === 'type').map((step) => step.text)).toEqual(['hello']);
    expect(steps).toHaveLength(3);
  });
});

describe('a finger on the phone while the screen here is acting', () => {
  const SECRET = 'hunter2-Sup3r';

  /** Delays the moment the studio tells the capture that the screen here has acted; resolves once it has. */
  function slowAnswer(): Promise<void> {
    const original = PhoneCapture.prototype.screenActed;
    return new Promise<void>((resolve) => {
      vi.spyOn(PhoneCapture.prototype, 'screenActed').mockImplementation(function (this: PhoneCapture) {
        setTimeout(() => {
          original.call(this);
          resolve();
        }, 500);
      });
    });
  }

  it('keeps a password typed on the phone while the screen here has not yet been answered', async () => {
    const r = await rig();
    r.device.nodes = appScreen([field('pw', 900, { focused: true, password: true, value: '' }), ...keyboardNodes()]);
    r.device.keyboard = KEYBOARD;
    await startPhone(r);
    // The answer to the screen here is slow to arrive, so the phone is used before screenActed() runs.
    const acted = slowAnswer();
    expect((await call(r, 'POST', '/api/action/tap', { x: SIGN_IN.x, y: SIGN_IN.y })).status).toBe(200);
    r.device.nodes = appScreen([field('pw', 900, { focused: true, password: true, value: SECRET, label: SECRET }), ...keyboardNodes()]);
    await finger(r, KEY);
    await finger(r, KEY);
    await sleep(150);
    await acted;
    await finger(r, REGISTER);
    const steps = await waitForSteps(r, 3);
    expect(steps.map((step) => step.kind)).toEqual(['tap', 'type', 'tap']);
    expect(steps[1]).toMatchObject({ text: '${PASSWORD}', review: 'password' });
    expect(JSON.stringify(steps)).not.toContain(SECRET);
  });

  const typingScreen = (value: string) => appScreen([field('f', 900, { focused: true, value }), ...keyboardNodes()]);

  /** Types `text` from the screen here, and a finger presses a key on the phone while it is being typed. */
  async function typeWhileTouched(r: Rig, text: string): Promise<void> {
    let begin: () => void = () => undefined;
    const begun = new Promise<void>((resolve) => {
      begin = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    r.device.typeText = async (typed: string) => {
      begin();
      await gate;
      r.device.nodes = typingScreen(typed);
    };
    const response = call(r, 'POST', '/api/action/type', { text });
    await begun;
    await finger(r, KEY);
    release();
    expect((await response).status).toBe(200);
  }

  it('records text typed from the screen once when a finger touched the phone while it was typed', async () => {
    const r = await rig();
    r.device.nodes = typingScreen('');
    r.device.keyboard = KEYBOARD;
    await startPhone(r);
    await typeWhileTouched(r, 'maria');
    await finger(r, REGISTER);
    await waitForSteps(r, 2);
    await call(r, 'POST', '/api/phone/stop');
    const steps = await currentSteps(r);
    expect(steps.map((step) => step.kind)).toEqual(['type', 'tap']);
    expect(steps[0]?.text).toBe('maria');
  });

  it('records only what the phone typed after that, not the text typed from the screen again', async () => {
    const r = await rig();
    r.device.nodes = typingScreen('');
    r.device.keyboard = KEYBOARD;
    await startPhone(r);
    await typeWhileTouched(r, 'maria');
    r.device.nodes = typingScreen('maria@example.com');
    await finger(r, KEY);
    await settled(r);
    await finger(r, REGISTER);
    await waitForSteps(r, 2);
    await call(r, 'POST', '/api/phone/stop');
    const steps = await currentSteps(r);
    // The recorder adds the phone's text to the Type step just before it.
    expect(steps.map((step) => step.kind)).toEqual(['type', 'tap']);
    expect(steps[0]?.text).toBe('maria@example.com');
  });

  it('does not record text typed from the screen again for a touch before the phone has been seen since', async () => {
    const r = await rig();
    r.device.nodes = typingScreen('');
    r.device.keyboard = KEYBOARD;
    await startPhone(r);
    let release: () => void = () => undefined;
    r.device.typeText = async (text: string) => {
      r.device.nodes = typingScreen(text);
      release = holdSnapshots(r.device);
    };
    expect((await call(r, 'POST', '/api/action/type', { text: 'maria' })).status).toBe(200);
    // The newest snapshot the touch can be read against is from before the text was typed.
    await finger(r, REGISTER);
    await waitForSteps(r, 2);
    release();
    await call(r, 'POST', '/api/phone/stop');
    const steps = await currentSteps(r);
    expect(steps.map((step) => step.kind)).toEqual(['type', 'tap']);
    expect(steps[0]?.text).toBe('maria');
  });

  it('keeps following when a finger touches the phone while the screen here waits for a touch still being read', async () => {
    const r = await rig();
    await startPhone(r);
    await finger(r, SIGN_IN);
    await waitForSteps(r, 1);
    expect((await status(r)).following).toBe(true);
    const original = PhoneCapture.prototype.yieldToScreen;
    let enter: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    vi.spyOn(PhoneCapture.prototype, 'yieldToScreen').mockImplementation(function (this: PhoneCapture) {
      enter();
      return original.call(this);
    });
    // No snapshot from after this touch comes, so it is still being read when the check arrives.
    const release = holdSnapshots(r.device);
    await finger(r, REGISTER);
    const checked = call(r, 'POST', '/api/case/expect', { x: SIGN_IN.x, y: SIGN_IN.y });
    await entered;
    await finger(r, SIGN_IN);
    // The touch on Register is still being read: its step is not written yet.
    expect(await currentSteps(r)).toHaveLength(1);
    release();
    expect((await checked).status).toBe(200);
    expect((await status(r)).following).toBe(true);
  });
});

describe('a phone start that is no longer wanted when it finishes', () => {
  /** Makes the read of the touchscreen wait until `release()`, and says when it has begun. */
  function slowRead(r: Rig) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let begin: () => void = () => undefined;
    const begun = new Promise<void>((resolve) => {
      begin = resolve;
    });
    r.tools.read.mockImplementation(async () => {
      begin();
      await gate;
      return INPUT;
    });
    return { release, begun };
  }

  /**
   * Says when a request to `url` has run its handler up to the handler's first wait, which for these
   * routes is after the phone start was dropped. Set up before the first request.
   */
  function handled(r: Rig, url: string): Promise<void> {
    return new Promise((resolve) => {
      r.app.addHook('preHandler', async (request) => {
        // The handler is called once the hooks are done, without waiting for the next turn of the event loop.
        if (request.url === url) setImmediate(resolve);
      });
    });
  }

  it('stays off, with the touch watch ended, when a stop came first', async () => {
    const r = await rig();
    await openAndRecord(r);
    const read = slowRead(r);
    const start = call(r, 'POST', '/api/phone/start');
    await read.begun;
    expect((await call(r, 'POST', '/api/phone/stop')).status).toBe(200);
    read.release();
    expect(await start).toMatchObject({ status: 200, body: { active: false } });
    expect(await status(r)).toMatchObject({ active: false });
    expect(r.tools.watch.mock.calls.length).toBe(r.stopped());
  });

  it('stays off, with the touch watch ended, when the case was finished first', async () => {
    const r = await rig();
    const finishing = handled(r, '/api/case/finish');
    await openAndRecord(r);
    await call(r, 'POST', '/api/action/tap', { x: SIGN_IN.x, y: SIGN_IN.y });
    const read = slowRead(r);
    const start = call(r, 'POST', '/api/phone/start');
    await read.begun;
    const finish = call(r, 'POST', '/api/case/finish');
    await finishing;
    read.release();
    expect(await start).toMatchObject({ status: 200, body: { active: false } });
    expect((await finish).status).toBe(200);
    expect(await status(r)).toMatchObject({ active: false });
    expect(r.tools.watch.mock.calls.length).toBe(r.stopped());
  });

  it('stays off, with the touch watch ended, when the case was discarded first', async () => {
    const r = await rig();
    const discarding = handled(r, '/api/case/discard');
    await openAndRecord(r);
    const read = slowRead(r);
    const start = call(r, 'POST', '/api/phone/start');
    await read.begun;
    const discard = call(r, 'POST', '/api/case/discard');
    await discarding;
    read.release();
    expect(await start).toMatchObject({ status: 200, body: { active: false } });
    expect((await discard).status).toBe(200);
    expect(await status(r)).toMatchObject({ active: false });
    expect(r.tools.watch.mock.calls.length).toBe(r.stopped());
  });

  it('stays off, with the touch watch ended, when the session was closed first', async () => {
    const r = await rig();
    const closing = handled(r, '/api/session/close');
    await openAndRecord(r);
    const read = slowRead(r);
    const start = call(r, 'POST', '/api/phone/start');
    await read.begun;
    const closed = call(r, 'POST', '/api/session/close');
    await closing;
    read.release();
    expect(await start).toMatchObject({ status: 200, body: { active: false } });
    expect((await closed).status).toBe(200);
    expect(await status(r)).toMatchObject({ active: false });
    expect(r.tools.watch.mock.calls.length).toBe(r.stopped());
  });

  it('still starts when nothing got in the way of a slow read', async () => {
    const r = await rig();
    await openAndRecord(r);
    const read = slowRead(r);
    const start = call(r, 'POST', '/api/phone/start');
    await read.begun;
    read.release();
    expect((await start).body).toMatchObject({ active: true });
    expect(r.tools.watch).toHaveBeenCalledTimes(1);
    expect(r.stopped()).toBe(0);
  });
});

describe('closing the app after the touch stream ended by itself', () => {
  it('waits for the stop to write the phone session\'s counts', async () => {
    const r = await rig();
    await startPhone(r);
    r.endWatch();
    await r.app.close();
    expect(existsSync(join(r.dir, 'diagnostics', 'phone-sessions.jsonl'))).toBe(true);
  });

  it('also waits for that stop when another capture was started and stopped since', async () => {
    const r = await rig();
    await startPhone(r);
    // The phone's next answer about its lock screen is held, so the first capture cannot finish stopping.
    let ask: () => void = () => undefined;
    const asked = new Promise<void>((resolve) => {
      ask = resolve;
    });
    let answer: () => void = () => undefined;
    const answered = new Promise<boolean>((resolve) => {
      answer = () => resolve(false);
    });
    r.tools.locked.mockImplementationOnce(async () => {
      ask();
      return answered;
    });
    await asked;
    r.endWatch();
    await waitFor(async () => (await status(r)).active === false, 'the capture to stop');
    expect((await call(r, 'POST', '/api/phone/start')).body).toMatchObject({ active: true });
    expect((await call(r, 'POST', '/api/phone/stop')).body).toMatchObject({ active: false });

    let closed = false;
    const closing = r.app.close().then(() => {
      closed = true;
    });
    await sleep(200);
    expect(closed).toBe(false);
    answer();
    await closing;
    const sessions = await readFile(join(r.dir, 'diagnostics', 'phone-sessions.jsonl'), 'utf8');
    expect(sessions.trim().split('\n')).toHaveLength(2);
  });
});

describe('taps from the studio use the same target rules', () => {
  it('records a tap on the background as a position, not as the screen\'s root', async () => {
    const r = await rig();
    r.device.nodes = [
      { index: 0, depth: 0, bundleId: APP, identifier: 'root', rect: { x: 0, y: 0, width: 1080, height: 2400 } } as Node,
      { index: 1, depth: 1, bundleId: APP, label: 'Sign in', hittable: true, rect: { x: 0, y: 300, width: 1080, height: 100 } } as Node,
    ];
    await openAndRecord(r);
    const tapped = await call(r, 'POST', '/api/action/tap', { x: 500, y: 1000 });
    expect(tapped.body.step.selector.kind).toBe('point');
    expect(tapped.body.resolved).toBeUndefined();
    const real = await call(r, 'POST', '/api/action/tap', { x: SIGN_IN.x, y: SIGN_IN.y });
    expect(real.body.step.selector).toEqual({ kind: 'text', value: 'Sign in' });
  });
});

describe('clearing a review flag', () => {
  it('removes the flag from a saved step when the step is patched with review null', async () => {
    const r = await rig();
    r.device.nodes = [{ index: 0, depth: 0, bundleId: APP, identifier: 'root', rect: { x: 0, y: 0, width: 1080, height: 2400 } } as Node];
    const caseId = await startPhone(r);
    await finger(r, { x: 500, y: 1000 });
    await waitForSteps(r, 1);
    expect((await call(r, 'POST', '/api/case/finish')).status).toBe(200);
    const saved = JSON.parse(await readFile(join(r.dir, 'cases', `${caseId}.json`), 'utf8'));
    expect(saved.steps[0].review).toBe('no-element');

    const patched = await call(r, 'PATCH', `/api/cases/${caseId}/steps/1`, { review: null });
    expect(patched.status).toBe(200);
    const after = JSON.parse(await readFile(join(r.dir, 'cases', `${caseId}.json`), 'utf8'));
    expect(after.steps[0]).not.toHaveProperty('review');
  });

  it('keeps the flag when the patch says nothing about it', async () => {
    const r = await rig();
    r.device.nodes = [{ index: 0, depth: 0, bundleId: APP, identifier: 'root', rect: { x: 0, y: 0, width: 1080, height: 2400 } } as Node];
    const caseId = await startPhone(r);
    await finger(r, { x: 500, y: 1000 });
    await waitForSteps(r, 1);
    await call(r, 'POST', '/api/case/finish');
    await call(r, 'PATCH', `/api/cases/${caseId}/steps/1`, { title: 'Press the background' });
    const after = JSON.parse(await readFile(join(r.dir, 'cases', `${caseId}.json`), 'utf8'));
    expect(after.steps[0]).toMatchObject({ review: 'no-element', title: 'Press the background' });
  });
});

describe('connecting to a phone that refuses the install', () => {
  it('answers 502 PHONE_REFUSED_INSTALL for INSTALL_FAILED_USER_RESTRICTED', async () => {
    const r = await rig();
    r.device.openError = new Error('adb: failed to install helper.apk: INSTALL_FAILED_USER_RESTRICTED: Install canceled by user');
    expect(await call(r, 'POST', '/api/session/open', { deviceId: 'R58M123', appId: APP })).toMatchObject({
      status: 502,
      body: { error: { code: 'PHONE_REFUSED_INSTALL' } },
    });
  });

  it('does not rename other open errors', async () => {
    const r = await rig();
    r.device.openError = Object.assign(new Error('Device went away'), { code: 'COMMAND_FAILED' });
    const response = await call(r, 'POST', '/api/session/open', { deviceId: 'R58M123', appId: APP });
    expect(response.status).not.toBe(200);
    expect(response.body.error.code).not.toBe('PHONE_REFUSED_INSTALL');
  });
});

describe('POST /api/phone/prepare', () => {
  const NOT_READY: XiaomiPhone = { driverInstalled: true, driverOpensApps: false };

  it('needs the id of a phone', async () => {
    const r = await rig();
    expect((await call(r, 'POST', '/api/phone/prepare', {})).status).toBe(400);
    expect((await call(r, 'POST', '/api/phone/prepare', { deviceId: '  ' })).status).toBe(400);
  });

  it('refuses a phone that is not Xiaomi\'s and changes nothing on it', async () => {
    const r = await rig();
    r.tools.xiaomi.mockResolvedValue(undefined);
    expect(await call(r, 'POST', '/api/phone/prepare', { deviceId: 'R58M123' })).toMatchObject({ status: 409, body: { error: { code: 'NOT_XIAOMI' } } });
    expect(r.tools.allowDriver).not.toHaveBeenCalled();
    expect(r.runMaestro).not.toHaveBeenCalled();
  });

  it('only allows the driver to open apps when the driver is already installed', async () => {
    const r = await rig();
    let allowed = false;
    r.tools.xiaomi.mockImplementation(async () => ({ driverInstalled: true, driverOpensApps: allowed }));
    r.tools.allowDriver.mockImplementation(async () => {
      allowed = true;
    });
    expect(await call(r, 'POST', '/api/phone/prepare', { deviceId: 'R58M123' })).toMatchObject({ status: 200, body: { ready: true } });
    expect(r.tools.installDriver).not.toHaveBeenCalled();
    expect(r.runMaestro).not.toHaveBeenCalled();
    expect(r.tools.allowDriver).toHaveBeenCalledWith('R58M123');
  });

  it('reports not ready when the permission is still not given afterwards', async () => {
    const r = await rig();
    r.tools.xiaomi.mockResolvedValue(NOT_READY);
    expect(await call(r, 'POST', '/api/phone/prepare', { deviceId: 'R58M123' })).toMatchObject({ status: 200, body: { ready: false } });
  });

  it('takes ready from the phone after allowing, not from the call succeeding', async () => {
    const r = await rig();
    r.tools.xiaomi.mockResolvedValueOnce({ driverInstalled: true, driverOpensApps: true }).mockResolvedValueOnce({ driverInstalled: true, driverOpensApps: false });
    expect((await call(r, 'POST', '/api/phone/prepare', { deviceId: 'R58M123' })).body.ready).toBe(false);
  });

  it('reports not ready when the phone cannot be read afterwards', async () => {
    const r = await rig();
    r.tools.xiaomi.mockResolvedValueOnce(NOT_READY).mockResolvedValueOnce(undefined);
    expect((await call(r, 'POST', '/api/phone/prepare', { deviceId: 'R58M123' })).body.ready).toBe(false);
  });

  it('installs a missing driver with the Maestro path, before allowing it, without running a flow', async () => {
    const r = await rig();
    const order: string[] = [];
    let installed = false;
    r.tools.xiaomi.mockImplementation(async () => ({ driverInstalled: installed, driverOpensApps: installed }));
    r.tools.installDriver.mockImplementation(async () => {
      order.push('install');
      installed = true;
    });
    r.tools.allowDriver.mockImplementation(async () => {
      order.push('allow');
    });
    expect(await call(r, 'POST', '/api/phone/prepare', { deviceId: 'R58M123' })).toMatchObject({ status: 200, body: { ready: true } });
    expect(r.tools.installDriver).toHaveBeenCalledTimes(1);
    expect(r.tools.installDriver).toHaveBeenCalledWith('R58M123', '/opt/maestro/bin/maestro');
    expect(order).toEqual(['install', 'allow']);
    expect(r.runMaestro).not.toHaveBeenCalled();
  });

  it('answers 502 PHONE_REFUSED_INSTALL when the phone refuses the install, and allows nothing', async () => {
    const r = await rig();
    r.tools.xiaomi.mockResolvedValue({ driverInstalled: false, driverOpensApps: false });
    r.tools.installDriver.mockRejectedValue(new DriverInstallRefused('The phone refused the install'));
    expect(await call(r, 'POST', '/api/phone/prepare', { deviceId: 'R58M123' })).toMatchObject({
      status: 502,
      body: { error: { code: 'PHONE_REFUSED_INSTALL' } },
    });
    expect(r.tools.allowDriver).not.toHaveBeenCalled();
  });

  it('answers 502 DRIVER_INSTALL_FAILED with the reason for any other install error', async () => {
    const r = await rig();
    r.tools.xiaomi.mockResolvedValue({ driverInstalled: false, driverOpensApps: false });
    r.tools.installDriver.mockRejectedValue(new Error('INSTALL_FAILED_INSUFFICIENT_STORAGE'));
    const response = await call(r, 'POST', '/api/phone/prepare', { deviceId: 'R58M123' });
    expect(response).toMatchObject({ status: 502, body: { error: { code: 'DRIVER_INSTALL_FAILED' } } });
    expect(response.body.error.message).toContain('INSTALL_FAILED_INSUFFICIENT_STORAGE');
    expect(r.tools.allowDriver).not.toHaveBeenCalled();
  });

  it('answers 500 MAESTRO_NOT_FOUND, without installing, when Maestro is missing', async () => {
    const r = await rig({}, () => {
      throw new Error('Maestro is not installed');
    });
    r.tools.xiaomi.mockResolvedValue({ driverInstalled: false, driverOpensApps: false });
    expect(await call(r, 'POST', '/api/phone/prepare', { deviceId: 'R58M123' })).toMatchObject({
      status: 500,
      body: { error: { code: 'MAESTRO_NOT_FOUND' } },
    });
    expect(r.tools.installDriver).not.toHaveBeenCalled();
    expect(r.tools.allowDriver).not.toHaveBeenCalled();
  });

  it('stops recording from the phone first', async () => {
    const r = await rig();
    await startPhone(r);
    r.tools.xiaomi.mockResolvedValue(undefined);
    await call(r, 'POST', '/api/phone/prepare', { deviceId: 'R58M123' });
    expect(await status(r)).toMatchObject({ active: false });
  });
});

describe('running a case on a Xiaomi phone', () => {
  async function savedCase(r: Rig): Promise<string> {
    const caseId = await openAndRecord(r);
    await call(r, 'POST', '/api/action/tap', { x: SIGN_IN.x, y: SIGN_IN.y });
    await call(r, 'POST', '/api/case/finish');
    return caseId;
  }

  it('is refused with 409 PHONE_NOT_READY when the driver may not open apps, and Maestro does not run', async () => {
    const r = await rig();
    const caseId = await savedCase(r);
    r.tools.xiaomi.mockResolvedValue({ driverInstalled: true, driverOpensApps: false });
    expect(await call(r, 'POST', `/api/cases/${caseId}/replay`)).toMatchObject({ status: 409, body: { error: { code: 'PHONE_NOT_READY' } } });
    expect(r.runMaestro).not.toHaveBeenCalled();
  });

  it('is refused when the driver is not installed at all', async () => {
    const r = await rig();
    const caseId = await savedCase(r);
    r.tools.xiaomi.mockResolvedValue({ driverInstalled: false, driverOpensApps: false });
    expect((await call(r, 'POST', `/api/cases/${caseId}/replay`)).body.error.code).toBe('PHONE_NOT_READY');
  });

  async function runWith(r: Rig, caseId: string) {
    r.runMaestro.mockImplementation(async (options) => {
      await mkdir(options.debugDir, { recursive: true });
      const outputFile = join(options.debugDir, 'output.txt');
      await writeFile(outputFile, 'ok');
      return { exitCode: 0, durationMs: 1, outputFile, timedOut: false };
    });
    return call(r, 'POST', `/api/cases/${caseId}/replay`);
  }

  it('keeps the driver when the phone is ready', async () => {
    const r = await rig();
    const caseId = await savedCase(r);
    r.tools.xiaomi.mockResolvedValue({ driverInstalled: true, driverOpensApps: true });
    expect((await runWith(r, caseId)).status).toBe(200);
    expect(r.runMaestro.mock.calls[0]![0]).toMatchObject({ keepDriver: true });
  });

  it('stops the driver after a run that kept it, once Maestro has finished', async () => {
    const r = await rig();
    const caseId = await savedCase(r);
    r.tools.xiaomi.mockResolvedValue({ driverInstalled: true, driverOpensApps: true });
    const order: string[] = [];
    r.tools.stopDriver.mockImplementation(async () => {
      order.push('stop');
    });
    r.runMaestro.mockImplementation(async (options) => {
      order.push('run');
      await mkdir(options.debugDir, { recursive: true });
      const outputFile = join(options.debugDir, 'output.txt');
      await writeFile(outputFile, 'ok');
      return { exitCode: 0, durationMs: 1, outputFile, timedOut: false };
    });
    expect((await call(r, 'POST', `/api/cases/${caseId}/replay`)).status).toBe(200);
    expect(r.tools.stopDriver).toHaveBeenCalledTimes(1);
    expect(r.tools.stopDriver).toHaveBeenCalledWith('R58M123');
    expect(order).toEqual(['run', 'stop']);
  });

  it('stops the driver when Maestro itself rejects', async () => {
    const r = await rig();
    const caseId = await savedCase(r);
    r.tools.xiaomi.mockResolvedValue({ driverInstalled: true, driverOpensApps: true });
    r.runMaestro.mockRejectedValue(new Error('spawn failed'));
    expect(await call(r, 'POST', `/api/cases/${caseId}/replay`)).toMatchObject({ status: 500, body: { error: { code: 'MAESTRO_FAILED' } } });
    expect(r.tools.stopDriver).toHaveBeenCalledWith('R58M123');
  });

  it('does not stop a driver it did not keep', async () => {
    const r = await rig();
    const caseId = await savedCase(r);
    r.tools.xiaomi.mockResolvedValue(undefined);
    expect((await runWith(r, caseId)).status).toBe(200);
    expect(r.tools.stopDriver).not.toHaveBeenCalled();
  });

  it('does not fail the run when stopping the driver fails', async () => {
    const r = await rig();
    const caseId = await savedCase(r);
    r.tools.xiaomi.mockResolvedValue({ driverInstalled: true, driverOpensApps: true });
    r.tools.stopDriver.mockRejectedValue(new Error('adb: device offline'));
    const response = await runWith(r, caseId);
    expect(response.status).toBe(200);
    expect(response.body.passed).toBe(true);
    expect(r.tools.stopDriver).toHaveBeenCalledTimes(1);
  });

  it('does not keep the driver on a phone that is not Xiaomi\'s', async () => {
    const r = await rig();
    const caseId = await savedCase(r);
    r.tools.xiaomi.mockResolvedValue(undefined);
    expect((await runWith(r, caseId)).status).toBe(200);
    expect(r.runMaestro.mock.calls[0]![0]).not.toHaveProperty('keepDriver');
  });

  it('runs normally when asking the phone fails', async () => {
    const r = await rig();
    const caseId = await savedCase(r);
    r.tools.xiaomi.mockRejectedValue(new Error('adb: device offline'));
    expect((await runWith(r, caseId)).status).toBe(200);
    expect(r.runMaestro.mock.calls[0]![0]).not.toHaveProperty('keepDriver');
  });
});

describe('setup check marks Xiaomi phones', () => {
  const ADB = join('/sdk', 'platform-tools', 'adb');
  function tools(replies: Record<string, string | Error>): SetupTools {
    return {
      exec: async (file, args) => {
        const reply = replies[[file, ...args].join(' ')];
        if (reply === undefined) throw new Error(`spawn ${file} ENOENT`);
        if (reply instanceof Error) throw reply;
        return { stdout: reply, stderr: '' };
      },
      spawnDetached: () => undefined,
      androidHome: () => '/sdk',
      findMaestro: () => '/opt/maestro/bin/maestro',
      javaBin: () => 'java',
      installer: new ToolInstaller(defaultInstallIo(() => '/sdk', {}, 'linux', 'x64')),
      platform: 'linux',
      path: '',
      exists: (candidate) => candidate === ADB,
    };
  }
  const LIST = 'List of devices attached\nR58M123 device usb:1-1 model:POCO_F5_Pro transport_id:2\n';
  const shell = (...args: string[]) => `${ADB} -s R58M123 shell ${args.join(' ')}`;

  it('marks a HyperOS phone with its driver state', async () => {
    const info = await checkSetup(
      tools({
        'java -version': new Error('none'),
        [`${ADB} devices -l`]: LIST,
        [shell('getprop', 'ro.miui.ui.version.name')]: '',
        [shell('getprop', 'ro.mi.os.version.name')]: 'OS3',
        [shell('pm', 'list', 'packages', 'dev.mobile.maestro')]: 'package:dev.mobile.maestro\npackage:dev.mobile.maestro.test\n',
        [shell('appops', 'get', 'dev.mobile.maestro', '10021')]: 'MIUIOP(10021): ignore\n',
      }),
    );
    expect(info.devices).toEqual([{ serial: 'R58M123', state: 'device', model: 'POCO F5 Pro', emulator: false, xiaomi: { driverOpensApps: false } }]);
  });

  it('marks a ready phone as one whose driver opens apps', async () => {
    const info = await checkSetup(
      tools({
        'java -version': new Error('none'),
        [`${ADB} devices -l`]: LIST,
        [shell('getprop', 'ro.miui.ui.version.name')]: 'V14',
        [shell('getprop', 'ro.mi.os.version.name')]: '',
        [shell('pm', 'list', 'packages', 'dev.mobile.maestro')]: 'package:dev.mobile.maestro\npackage:dev.mobile.maestro.test\n',
        [shell('appops', 'get', 'dev.mobile.maestro', '10021')]: 'MIUIOP(10021): allow; time=+1d\n',
      }),
    );
    expect(info.devices[0]?.xiaomi).toEqual({ driverOpensApps: true });
  });

  it('leaves a phone that is not Xiaomi\'s unmarked', async () => {
    const info = await checkSetup(
      tools({
        'java -version': new Error('none'),
        [`${ADB} devices -l`]: LIST,
        [shell('getprop', 'ro.miui.ui.version.name')]: '',
        [shell('getprop', 'ro.mi.os.version.name')]: '',
      }),
    );
    expect(info.devices).toEqual([{ serial: 'R58M123', state: 'device', model: 'POCO F5 Pro', emulator: false }]);
  });

  it('still lists the phone when getprop fails', async () => {
    const info = await checkSetup(
      tools({
        'java -version': new Error('none'),
        [`${ADB} devices -l`]: LIST,
        [shell('getprop', 'ro.miui.ui.version.name')]: new Error('adb: device unauthorized'),
      }),
    );
    expect(info.devices).toEqual([{ serial: 'R58M123', state: 'device', model: 'POCO F5 Pro', emulator: false }]);
  });
});
