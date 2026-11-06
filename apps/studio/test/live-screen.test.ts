// The screen here keeps looking at the phone, which moves on by itself: an app
// hands over to a website, a person closes it. Nothing it finds may change what
// a tester has already been offered.
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { encodePng, type DeviceSnapshot, type OpenOptions, type Point, type RawImage } from '@ariadne/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server/index.ts';
import type { DeviceLike } from '../src/server/state.ts';
import type { ActionResponse, CandidatesResponse, CaseFinishResponse, ScreenState } from '../src/shared/api-types.ts';

type SnapshotNode = DeviceSnapshot['nodes'][number];

const VIEWPORT = { width: 1080, height: 2400 };
const APP = 'com.example.bank';

function picture(level: number): Buffer {
  const [width, height] = [108, 240];
  const image: RawImage = { width, height, channels: 1, data: new Uint8Array(width * height).fill(level) };
  return encodePng(image);
}

const LIT = picture(120);
const BLACK = picture(0);

function button(label: string, bundleId: string, y = 1000): SnapshotNode {
  return { index: 0, depth: 1, rect: { x: 100, y, width: 600, height: 200 }, hittable: true, label, identifier: `${bundleId}:id/${label.toLowerCase()}`, bundleId } as SnapshotNode;
}

class MovingPhone implements Partial<DeviceLike> {
  nodes: SnapshotNode[] = [button('Verify', APP)];
  black = false;
  target: { deviceId: string; appId: string } | undefined;
  taps: Point[] = [];

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
    return { nodes: this.nodes, viewport: VIEWPORT, takenAt: new Date().toISOString() };
  }
  async capture(screenshotPath: string) {
    mkdirSync(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, this.black ? BLACK : LIT);
    return { ...(await this.snapshot()), screenshotPath };
  }
  async tapAt(point: Point) {
    this.taps.push(point);
  }
}

describe('a phone that moves on by itself', () => {
  let dir: string;
  let app: FastifyInstance;
  let phone: MovingPhone;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ariadne-live-test-'));
    phone = new MovingPhone();
    app = await buildServer({ projectDir: dir, session: phone as unknown as DeviceLike });
    await call('POST', '/api/session/open', { deviceId: 'phone', appId: APP });
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function call<T>(method: 'GET' | 'POST', url: string, payload?: object) {
    const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    return { status: response.statusCode, body: response.json() as T };
  }

  const look = async () => (await call<ScreenState>('POST', '/api/screen/refresh')).body;

  it('says nothing while the app the case starts from is in front', async () => {
    expect((await look()).elsewhere).toBeUndefined();
  });

  it('says which app is in front when another one is', async () => {
    phone.nodes = [button('Login', 'com.android.chrome')];
    expect((await look()).elsewhere).toEqual({ app: 'com.android.chrome', home: false });
  });

  it('tells the home screen from another app', async () => {
    phone.nodes = [button('Duolingo', 'com.mi.android.globallauncher')];
    expect((await look()).elsewhere).toEqual({ app: 'com.mi.android.globallauncher', home: true });
  });

  it("does not take Android's own notification shade for another app", async () => {
    phone.nodes = [button('Mail', 'com.android.systemui')];
    expect((await look()).elsewhere).toBeUndefined();
  });

  it('goes back to saying nothing when the app is back', async () => {
    phone.nodes = [button('Login', 'com.android.chrome')];
    await look();
    phone.nodes = [button('Verify', APP)];
    expect((await look()).elsewhere).toBeUndefined();
  });

  it('records a tap in another app as a step of the case, by its element', async () => {
    await call('POST', '/api/case/start', { name: 'Handover' });
    phone.nodes = [button('Login', 'com.android.chrome')];
    await look();
    const { status, body } = await call<ActionResponse>('POST', '/api/action/tap', { x: 300, y: 1100 });
    expect(status).toBe(200);
    expect(body.step).toMatchObject({ kind: 'tap', selector: { kind: 'id', value: 'com\\.android\\.chrome:id/login' } });
    expect(phone.taps).toEqual([{ x: 400, y: 1100 }]);
  });

  it('says a screen that blocks screenshots is secure and sends its elements', async () => {
    phone.black = true;
    phone.nodes = [button('Login', 'gr.gov.wallet')];
    const screen = await look();
    expect(screen.secure).toBe(true);
    expect(screen.hidden).toBeUndefined();
    expect(screen.nodes.map((node) => node.label)).toEqual(['Login']);
  });

  it('records on a secure screen in another app', async () => {
    await call('POST', '/api/case/start', { name: 'Secure' });
    phone.black = true;
    phone.nodes = [button('Login', 'gr.gov.wallet')];
    await look();
    const { status, body } = await call<ActionResponse>('POST', '/api/action/tap', { x: 300, y: 1100 });
    expect(status).toBe(200);
    expect(body.step).toMatchObject({ selector: { kind: 'id' } });
  });

  it('keeps the end checks on offer when the screen moves on behind the picker', async () => {
    await call('POST', '/api/case/start', { name: 'Picks' });
    const { candidates } = (await call<CandidatesResponse>('GET', '/api/case/candidates')).body;
    expect(candidates).toHaveLength(1);
    phone.nodes = [button('Something else', APP, 300), button('Verify', APP, 1000)];
    await look();
    const { body } = await call<CaseFinishResponse>('POST', '/api/case/finish', { picks: [candidates[0]!.id] });
    const yaml = await readFile(join(dir, body.flowFile), 'utf8');
    expect(yaml).toContain('id/verify');
    expect(yaml).not.toContain('something');
  });

  it('offers the screen as it is now the next time, not the last one offered', async () => {
    await call('POST', '/api/case/start', { name: 'First' });
    await call('GET', '/api/case/candidates');
    await call('POST', '/api/case/finish', { picks: [] });
    phone.nodes = [button('Later', APP)];
    await look();
    await call('POST', '/api/case/start', { name: 'Second' });
    const { candidates } = (await call<CandidatesResponse>('GET', '/api/case/candidates')).body;
    expect(candidates[0]?.selector).toMatchObject({ value: `${APP.replaceAll('.', '\\.')}:id/later` });
  });
});
