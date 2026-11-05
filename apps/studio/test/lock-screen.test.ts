// A lit lock screen looks like any screen, with real text on it (notifications
// too), so only Android can say it is up. These tests let a fake phone say so
// and check that the studio keeps neither the picture nor the text, presses
// nothing, and records nothing. The wait step shares the file because it is the
// one action that touches no device, which is why the lock screen matters to it.
import { mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { blackPicture, encodePng, SYSTEM_UI, type DeviceSnapshot, type OpenOptions, type PhoneInputTools, type Point, type RawImage } from '@ariadne/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server/index.ts';
import type { DeviceLike } from '../src/server/state.ts';
import { MAX_WAIT_SECONDS, type ActionResponse, type CaseStartResponse, type ScreenState } from '../src/shared/api-types.ts';

const VIEWPORT = { width: 1080, height: 2400 };

function picture(level: number): Buffer {
  const [width, height] = [108, 240];
  const image: RawImage = { width, height, channels: 1, data: new Uint8Array(width * height).fill(level) };
  return encodePng(image);
}

const LIT = picture(120);
const BUTTON = { index: 0, depth: 1, rect: { x: 100, y: 1000, width: 300, height: 200 }, hittable: true, label: 'Seven', identifier: 'calc:id/digit_7' };
/** What a lock screen shows on a phone whose keyguard is not System UI: private text and a PIN pad. */
const LOCK_NODES = [
  { index: 0, depth: 1, bundleId: SYSTEM_UI, rect: { x: 0, y: 200, width: 1080, height: 200 }, label: 'Message from Mum: the code is 4711', hittable: true },
  { index: 1, depth: 1, bundleId: 'com.maker.keyguard', rect: { x: 100, y: 1000, width: 300, height: 200 }, label: 'PIN pad 1', hittable: true },
];

/** Shows one button, or a lock screen when `lockUp` is set. It lights the screen either way, as a lit lock screen does. */
class LockablePhone implements Partial<DeviceLike> {
  lockUp = false;
  target: { deviceId: string; appId: string } | undefined;
  /** Where each capture was asked to write. */
  captured: string[] = [];
  taps: Point[] = [];
  keys: string[] = [];
  /** Every other call that does something on the device. */
  actions: string[] = [];
  replays = 0;

  get isOpen() {
    return this.target !== undefined;
  }
  get deviceId() {
    return this.target?.deviceId;
  }
  get appId() {
    return this.target?.appId;
  }
  async listDevices() {
    return [];
  }
  async open(options: OpenOptions) {
    this.target = { deviceId: options.deviceId, appId: options.appId };
  }
  async close() {
    this.target = undefined;
  }
  async snapshot(): Promise<DeviceSnapshot> {
    return { nodes: this.lockUp ? LOCK_NODES : [BUTTON], viewport: VIEWPORT, takenAt: new Date().toISOString() };
  }
  async capture(screenshotPath: string) {
    mkdirSync(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, LIT);
    this.captured.push(screenshotPath);
    return { ...(await this.snapshot()), screenshotPath };
  }
  async tapAt(point: Point) {
    this.taps.push(point);
  }
  async pressKey(key: string) {
    this.keys.push(key);
  }
  async relaunchApp() {
    this.actions.push('relaunch');
  }
  async back() {
    this.actions.push('back');
  }
  async typeText() {
    this.actions.push('type');
  }
  async scroll() {
    this.actions.push('scroll');
  }
  async swipe() {
    this.actions.push('swipe');
  }
  async openLink() {
    this.actions.push('openLink');
  }
  async hideKeyboard() {
    this.actions.push('hideKeyboard');
  }
  async longPressAt() {
    this.actions.push('longPress');
  }
  async doubleTapAt() {
    this.actions.push('doubleTap');
  }
  async replayFlow() {
    this.replays += 1;
    return { replayed: 1 };
  }
}

describe('the lock screen', () => {
  let dir: string;
  let app: FastifyInstance;
  let phone: LockablePhone;
  /** What the phone says when asked. */
  let locked: () => Promise<boolean | undefined>;
  let asked: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ariadne-lock-test-'));
    phone = new LockablePhone();
    asked = 0;
    locked = async () => phone.lockUp;
    const phoneTools: Partial<PhoneInputTools> = {
      locked: async () => {
        asked += 1;
        return locked();
      },
    };
    app = await buildServer({ projectDir: dir, session: phone as unknown as DeviceLike, phoneTools });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function call<T>(method: 'GET' | 'POST', url: string, payload?: object) {
    const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    return { status: response.statusCode, body: response.json() as T & { error?: { code: string; message: string } } };
  }

  const connect = () => call<ScreenState>('POST', '/api/session/open', { deviceId: 'phone', appId: 'calc' });
  const refresh = () => call<ScreenState>('POST', '/api/screen/refresh');
  const tap = () => call<ActionResponse>('POST', '/api/action/tap', { x: 250, y: 1100 });
  /** Starting a case relaunches the app; that is not what the tests below look for. */
  const startCase = async () => {
    const started = await call<CaseStartResponse>('POST', '/api/case/start', { name: 'Sum' });
    phone.actions.length = 0;
    return started;
  };
  const wait = (seconds: unknown) => call<ActionResponse>('POST', '/api/case/wait', { seconds });
  const steps = async () => (await call<{ steps: Array<Record<string, unknown>> }>('GET', '/api/case/current')).body.steps;
  const black = blackPicture(VIEWPORT);

  /** Pretends an hour has gone by, so the latest screen is stale. */
  function anHourLater() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3_600_000);
  }

  describe('capturing', () => {
    it('hides the screen and drops its elements when the phone says it is locked', async () => {
      await connect();
      phone.lockUp = true;
      const { status, body } = await refresh();
      expect(status).toBe(200);
      expect(body.hidden).toBe(true);
      expect(body.nodes).toHaveLength(0);
    });

    it('overwrites the picture on disk with a black one, not what the phone showed', async () => {
      await connect();
      phone.lockUp = true;
      await refresh();
      const written = await readFile(phone.captured.at(-1)!);
      expect(written.equals(LIT)).toBe(false);
      expect(written.equals(black)).toBe(true);
    });

    it('keeps the lock screen text out of the latest screen', async () => {
      await connect();
      phone.lockUp = true;
      await refresh();
      const screen = await call<ScreenState>('GET', '/api/screen');
      expect(JSON.stringify(screen.body)).not.toContain('Message from Mum');
      expect(JSON.stringify(screen.body)).not.toContain('PIN pad');
      expect(screen.body.hidden).toBe(true);
    });

    it('keeps the elements and the picture of an unlocked phone', async () => {
      const { body } = await connect();
      expect(body.hidden).toBeUndefined();
      expect(body.nodes.length).toBeGreaterThan(0);
      expect((await readFile(phone.captured.at(-1)!)).equals(LIT)).toBe(true);
    });

    it('shows the screen again once the phone is unlocked', async () => {
      await connect();
      phone.lockUp = true;
      expect((await refresh()).body.hidden).toBe(true);
      phone.lockUp = false;
      const { body } = await refresh();
      expect(body.hidden).toBeUndefined();
      expect(body.nodes.length).toBeGreaterThan(0);
    });

    it('blacks out the evidence file of a step made while locked', async () => {
      await connect();
      const { body } = await startCase();
      phone.lockUp = true;
      const pressed = await call<ActionResponse>('POST', '/api/action/key', { key: 'volumeUp' });
      expect(pressed.status).toBe(200);
      expect(phone.keys).toEqual(['volumeUp']);
      const folder = join(dir, 'evidence', body.caseId);
      const files = await readdir(folder);
      expect(files).toHaveLength(1);
      expect((await readFile(join(folder, files[0]!))).equals(black)).toBe(true);
    });

    it.each([
      ['rejects', async () => Promise.reject(new Error('adb: device offline'))],
      ['says nothing', async () => undefined],
    ])('leaves the capture as it is when the phone %s', async (_what, answer) => {
      locked = answer;
      phone.lockUp = true;
      const { body } = await connect();
      expect(body.hidden).toBeUndefined();
      expect(body.nodes.length).toBeGreaterThan(0);
      expect((await readFile(phone.captured.at(-1)!)).equals(LIT)).toBe(true);
    });
  });

  describe('acting', () => {
    it('refuses a tap when the phone locked since the last capture, and presses and records nothing', async () => {
      await connect();
      await startCase();
      phone.lockUp = true;
      const { status, body } = await tap();
      expect(status).toBe(409);
      expect(body.error?.code).toBe('SCREEN_HIDDEN');
      expect(phone.taps).toEqual([]);
      expect(await steps()).toEqual([]);
    });

    it('still refuses a tap after the latest hidden screen has gone stale and the phone shows an app again', async () => {
      await connect();
      await startCase();
      phone.lockUp = true;
      await refresh();
      phone.lockUp = false;
      anHourLater();
      const { status, body } = await tap();
      expect(status).toBe(409);
      expect(body.error?.code).toBe('SCREEN_HIDDEN');
      expect(phone.taps).toEqual([]);
      expect(await steps()).toEqual([]);
    });

    it('does not check against a lock screen the phone showed after the latest screen went stale', async () => {
      await connect();
      await startCase();
      phone.lockUp = true;
      anHourLater();
      const { status, body } = await call<ActionResponse>('POST', '/api/case/expect', { x: 250, y: 1100 });
      expect(status).toBe(400);
      expect(body.error?.code).toBe('NO_ELEMENT');
      const screen = await call<ScreenState>('GET', '/api/screen');
      expect(JSON.stringify(screen.body)).not.toContain('Message from Mum');
      expect(JSON.stringify(screen.body)).not.toContain('PIN pad');
      expect(screen.body.hidden).toBe(true);
      expect(await steps()).toEqual([]);
    });

    it('refuses to run a block, and the block never runs', async () => {
      await connect();
      await startCase();
      await mkdir(join(dir, 'blocks'), { recursive: true });
      await writeFile(join(dir, 'blocks', 'hide.yaml'), 'appId: calc\n---\n- hideKeyboard\n');
      phone.lockUp = true;
      const { status, body } = await call<ActionResponse>('POST', '/api/case/block', { file: 'blocks/hide.yaml' });
      expect(status).toBe(409);
      expect(body.error?.code).toBe('SCREEN_HIDDEN');
      expect(phone.replays).toBe(0);
      expect(phone.actions).toEqual([]);
      expect(await steps()).toEqual([]);
    });
  });

  describe('POST /api/case/wait', () => {
    it('records a wait step and touches nothing on the device', async () => {
      await connect();
      await startCase();
      const { status, body } = await wait(20);
      expect(status).toBe(200);
      expect(body.step).toMatchObject({ kind: 'wait', seconds: 20 });
      expect(await steps()).toHaveLength(1);
      expect(phone.taps).toEqual([]);
      expect(phone.keys).toEqual([]);
      expect(phone.actions).toEqual([]);
      expect(phone.replays).toBe(0);
    });

    it('does not really wait while recording', async () => {
      await connect();
      await startCase();
      const started = Date.now();
      await wait(MAX_WAIT_SECONDS);
      expect(Date.now() - started).toBeLessThan(5000);
    });

    it('accepts the longest wait and a one second wait', async () => {
      await connect();
      await startCase();
      expect((await wait(1)).status).toBe(200);
      expect((await wait(MAX_WAIT_SECONDS)).status).toBe(200);
      expect(await steps()).toMatchObject([{ kind: 'wait', seconds: 1 }, { kind: 'wait', seconds: MAX_WAIT_SECONDS }]);
    });

    it.each([[0], [-1], [MAX_WAIT_SECONDS + 1], [1.5], ['20'], [null], [undefined]])('refuses %s seconds with 400 and records nothing', async (seconds) => {
      await connect();
      await startCase();
      const { status, body } = await wait(seconds);
      expect(status).toBe(400);
      expect(body.error?.code).toBe('BAD_REQUEST');
      expect(await steps()).toEqual([]);
    });

    it('refuses a request with no body', async () => {
      await connect();
      await startCase();
      const response = await app.inject({ method: 'POST', url: '/api/case/wait' });
      expect(response.statusCode).toBe(400);
    });

    it('is refused with 409 NO_CASE when no case is being recorded', async () => {
      await connect();
      const { status, body } = await wait(20);
      expect(status).toBe(409);
      expect(body.error?.code).toBe('NO_CASE');
    });

    it('is refused with 409 NO_SESSION when no phone is connected', async () => {
      const { status, body } = await wait(20);
      expect(status).toBe(409);
      expect(body.error?.code).toBe('NO_SESSION');
    });

    it('is refused with 409 SCREEN_HIDDEN while the phone is locked', async () => {
      await connect();
      await startCase();
      phone.lockUp = true;
      const { status, body } = await wait(20);
      expect(status).toBe(409);
      expect(body.error?.code).toBe('SCREEN_HIDDEN');
      expect(await steps()).toEqual([]);
    });
  });
});
