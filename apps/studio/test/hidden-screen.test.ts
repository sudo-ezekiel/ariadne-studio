// A phone that is asleep or locked: nothing is pressed, nothing is recorded, and
// the studio comes back by itself when the phone does.
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { encodePng, type DeviceSnapshot, type OpenOptions, type Point, type RawImage } from '@ariadne/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server/index.ts';
import type { DeviceLike } from '../src/server/state.ts';
import type { ActionResponse, CaseStartResponse, ScreenState } from '../src/shared/api-types.ts';

const VIEWPORT = { width: 1080, height: 2400 };

function picture(level: number): Buffer {
  const [width, height] = [108, 240];
  const image: RawImage = { width, height, channels: 1, data: new Uint8Array(width * height).fill(level) };
  return encodePng(image);
}

const BLACK = picture(0);
const LIT = picture(120);
const BUTTON = { index: 0, depth: 1, rect: { x: 100, y: 1000, width: 300, height: 200 }, hittable: true, label: 'Seven', identifier: 'calc:id/digit_7' };

/** Awake, it shows one button. Asleep, a black picture and nothing else. */
class SleepyPhone implements Partial<DeviceLike> {
  asleep = false;
  /** A secure screen: a black picture, but its elements come through. */
  secure = false;
  target: { deviceId: string; appId: string } | undefined;
  taps: Point[] = [];
  keys: string[] = [];
  backs = 0;
  swipes = 0;

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
  async relaunchApp() {}
  async close() {
    this.target = undefined;
  }
  async snapshot(): Promise<DeviceSnapshot> {
    return { nodes: this.asleep ? [] : [BUTTON], viewport: VIEWPORT, takenAt: new Date().toISOString() };
  }
  async capture(screenshotPath: string) {
    mkdirSync(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, this.asleep || this.secure ? BLACK : LIT);
    return { ...(await this.snapshot()), screenshotPath };
  }
  async tapAt(point: Point) {
    this.taps.push(point);
  }
  async back() {
    this.backs += 1;
  }
  async swipe() {
    this.swipes += 1;
  }
  async pressKey(key: string) {
    this.keys.push(key);
    if (key === 'power') this.asleep = false;
  }
}

describe('a phone that shows nothing', () => {
  let dir: string;
  let app: FastifyInstance;
  let phone: SleepyPhone;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ariadne-hidden-test-'));
    phone = new SleepyPhone();
    app = await buildServer({ projectDir: dir, session: phone as unknown as DeviceLike });
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
  const tap = () => call<ActionResponse>('POST', '/api/action/tap', { x: 250, y: 1100 });
  const startCase = () => call<CaseStartResponse>('POST', '/api/case/start', { name: 'Sum' });
  const steps = async () => (await call<{ steps: unknown[] }>('GET', '/api/case/current')).body.steps;

  it('says the screen is fine when it is', async () => {
    expect((await connect()).body.hidden).toBeUndefined();
    expect((await tap()).status).toBe(200);
    expect(phone.taps).toHaveLength(1);
  });

  it('tells the studio as soon as a capture shows nothing', async () => {
    phone.asleep = true;
    expect((await connect()).body.hidden).toBe(true);
  });

  it('does not press or record anything on a screen that shows nothing', async () => {
    await connect();
    await startCase();
    phone.asleep = true;
    await call('POST', '/api/screen/refresh');
    const { status, body } = await tap();
    expect(status).toBe(409);
    expect(body.error?.code).toBe('SCREEN_HIDDEN');
    expect(body.error?.message).toContain('nothing was pressed or recorded');
    expect(phone.taps).toEqual([]);
    expect(await steps()).toEqual([]);
  });

  it('stops a case that starts on a phone that is asleep at its first tap, not after four blind ones', async () => {
    await connect();
    phone.asleep = true;
    const started = await startCase();
    expect(started.status).toBe(200);
    expect(started.body.screen.hidden).toBe(true);
    expect((await tap()).status).toBe(409);
    expect(phone.taps).toEqual([]);
    expect(await steps()).toEqual([]);
  });

  it('refuses every action that aims at the screen, not only a tap', async () => {
    await connect();
    phone.asleep = true;
    await call('POST', '/api/screen/refresh');
    expect((await call('POST', '/api/action/back')).status).toBe(409);
    expect((await call('POST', '/api/action/swipe', { from: { x: 100, y: 1000 }, to: { x: 100, y: 300 }, durationMs: 300 })).status).toBe(409);
    expect(phone.backs).toBe(0);
    expect(phone.swipes).toBe(0);
  });

  it('notices a phone that went to sleep while its screen sat here', async () => {
    await connect();
    await startCase();
    phone.asleep = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3_600_000);
    const { status, body } = await tap();
    expect(status).toBe(409);
    expect(body.error?.code).toBe('SCREEN_HIDDEN');
    expect(phone.taps).toEqual([]);
    expect(await steps()).toEqual([]);
  });

  it('asks the tester to look again when the phone woke after the click was aimed', async () => {
    await connect();
    phone.asleep = true;
    await call('POST', '/api/screen/refresh');
    phone.asleep = false;
    const { status, body } = await tap();
    expect(status).toBe(409);
    expect(body.error?.message).toContain('back');
    expect(phone.taps).toEqual([]);
    expect((await call<ScreenState>('GET', '/api/screen')).body.hidden).toBeUndefined();
    expect((await tap()).status).toBe(200);
    expect(phone.taps).toHaveLength(1);
  });

  it('comes back by itself when the screen is looked at again', async () => {
    await connect();
    phone.asleep = true;
    expect((await call<ScreenState>('POST', '/api/screen/refresh')).body.hidden).toBe(true);
    phone.asleep = false;
    expect((await call<ScreenState>('POST', '/api/screen/refresh')).body.hidden).toBeUndefined();
  });

  it('still lets the Power key through, to wake a phone nobody can reach', async () => {
    await connect();
    phone.asleep = true;
    await call('POST', '/api/screen/refresh');
    const { status, body } = await call<ActionResponse>('POST', '/api/action/key', { key: 'power' });
    expect(status).toBe(200);
    expect(phone.keys).toEqual(['power']);
    expect(body.screen.hidden).toBeUndefined();
  });

  it('records on a secure screen, whose picture is black but whose elements come through', async () => {
    phone.secure = true;
    const connected = (await connect()).body;
    expect(connected.hidden).toBeUndefined();
    expect(connected.secure).toBe(true);
    await startCase();
    const { status, body } = await tap();
    expect(status).toBe(200);
    expect(body.step).toMatchObject({ selector: { kind: 'id' } });
    expect(phone.taps).toHaveLength(1);
  });

  it('keeps no step and no picture from a refused tap', async () => {
    await connect();
    const { body } = await startCase();
    phone.asleep = true;
    await call('POST', '/api/screen/refresh');
    await tap();
    await expect(readFile(join(dir, 'evidence', body.caseId, 'step-001.png'))).rejects.toThrow();
  });
});
