// The Blocks tab routes: writing, reading, changing and deleting a setup block
// file, picking an element on the screen for a step, trying a block, and saving
// a setting's value to .env. The device is a fake that records what it was
// asked to do; none of these tests reach a real phone.
import { existsSync, mkdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { inspect } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore, parseMaestroFlow, type DeviceSnapshot, type OpenOptions, type Point, type TestCase } from '@ariadne/core';
import type { BlockDetail, CandidatesResponse, ProjectInfo, ScreenPick } from '../src/shared/api-types.ts';
import { buildServer } from '../src/server/index.ts';
import type { DeviceLike } from '../src/server/state.ts';

// Counts how often a request reaches the device queue, then does what enqueue
// always does. The overlapping-request tests use the count to know a request is
// waiting in the queue, instead of guessing with a timer.
const queued = vi.hoisted(() => ({ count: 0, listeners: new Set<() => void>() }));
vi.mock('../src/server/state.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/server/state.ts')>();
  return {
    ...original,
    enqueue: <T>(...args: Parameters<typeof original.enqueue>) => {
      queued.count += 1;
      for (const listener of [...queued.listeners]) listener();
      return original.enqueue(...args) as Promise<T>;
    },
  };
});

const APP = 'com.android.settings';
const DEVICE = 'emulator-5556';

// Smallest valid PNG (1x1), so the image routes have something to stream.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

type Node = DeviceSnapshot['nodes'][number];
type ScreenName = 'home' | 'login';

const screens: Record<ScreenName, Node[]> = {
  home: [
    { index: 0, depth: 1, rect: { x: 0, y: 400, width: 1080, height: 200 }, hittable: true },
    { index: 1, depth: 2, parentIndex: 0, rect: { x: 200, y: 440, width: 400, height: 70 }, label: 'Network & internet', identifier: 'android:id/title' },
  ],
  login: [{ index: 0, depth: 1, rect: { x: 0, y: 400, width: 1080, height: 150 }, label: 'Password', password: true, focused: true, editable: true }],
};

/** In-memory stand-in for DeviceSession. Counts what the pick route must never do, and logs replays. */
class FakeDevice implements DeviceLike {
  screen: ScreenName = 'home';
  target: { deviceId: string; appId: string } | undefined;
  /** Taps, typing and the like: anything that would change the phone. */
  presses: string[] = [];
  /** 'relaunch' and 'replay <file name>', in the order they happened. */
  events: string[] = [];
  replays: Array<{ path: string; env: Record<string, string> }> = [];
  failReplay: Error | undefined;
  /** Makes typeText throw, as a device does when the keyboard is gone. */
  failType: Error | undefined;
  /** Runs inside the next replay, so a test can look at the studio while a block is on the phone. */
  onReplay: (() => Promise<void>) | undefined;
  /** The next capture says it has started, then waits: that holds the queue so a test can line requests up behind it. */
  holdNext: { entered: () => void; until: Promise<void> } | undefined;

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
    return [{ id: DEVICE, name: 'Pixel', platform: 'android', kind: 'emulator', booted: true }];
  }
  async open(options: OpenOptions) {
    this.target = { deviceId: options.deviceId, appId: options.appId };
  }
  async relaunchApp() {
    this.events.push('relaunch');
  }
  async snapshot(): Promise<DeviceSnapshot> {
    return { nodes: screens[this.screen], viewport: { width: 1080, height: 2400 }, takenAt: new Date().toISOString() };
  }
  async capture(screenshotPath: string) {
    const hold = this.holdNext;
    this.holdNext = undefined;
    if (hold) {
      hold.entered();
      await hold.until;
    }
    mkdirSync(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, PNG);
    return { ...(await this.snapshot()), screenshotPath };
  }
  async tapAt(point: Point) {
    this.presses.push(`tap ${point.x},${point.y}`);
  }
  async typeText(text: string) {
    if (this.failType) throw this.failType;
    this.presses.push(`type ${text}`);
  }
  async back() {
    this.presses.push('back');
  }
  async scroll() {
    this.presses.push('scroll');
  }
  async openLink() {
    this.presses.push('link');
  }
  async hideKeyboard() {
    this.presses.push('hideKeyboard');
  }
  async longPressAt() {
    this.presses.push('longPress');
  }
  async doubleTapAt() {
    this.presses.push('doubleTap');
  }
  async swipe() {
    this.presses.push('swipe');
  }
  async pinch() {
    this.presses.push('pinch');
  }
  async pressKey() {
    this.presses.push('key');
  }
  async setOrientation() {
    this.presses.push('orientation');
  }
  async replayFlow(path: string, env: Readonly<Record<string, string>>) {
    this.replays.push({ path, env: { ...env } });
    this.events.push(`replay ${basename(path)}`);
    await this.onReplay?.();
    if (this.failReplay) throw this.failReplay;
    return { replayed: 1 };
  }
  async close() {
    this.target = undefined;
  }
}

let dir: string;
let device: FakeDevice;
let app: FastifyInstance;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function call(method: Method, url: string, payload?: object) {
  const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
  return { status: response.statusCode, text: response.body, body: response.headers['content-type']?.includes('json') ? response.json() : response.body };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ariadne-studio-block-routes-'));
  device = new FakeDevice();
  app = await buildServer({
    projectDir: dir,
    session: device,
    maestro: { run: async () => { throw new Error('Maestro was not expected to run in this test'); }, findBin: () => '/opt/maestro/bin/maestro', androidHome: () => undefined },
  });
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function openSession() {
  expect((await call('POST', '/api/session/open', { deviceId: DEVICE, appId: APP })).status).toBe(200);
}

async function writeBlock(file: string, body: string, header = '') {
  await mkdir(join(dir, 'blocks'), { recursive: true });
  await writeFile(join(dir, 'blocks', file), `appId: ${APP}\n${header}---\n${body}`);
}

async function writeEnv(env: Record<string, string>) {
  await writeFile(join(dir, '.env'), `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
}

/** A saved case on disk that sets up with the given blocks. */
async function writeCaseUsing(id: string, name: string, files: string[]) {
  const testCase: TestCase = {
    id,
    name,
    appId: APP,
    createdAt: '2026-11-01T10:00:00.000Z',
    deviceId: DEVICE,
    preconditionBlocks: files.map((file) => ({ file })),
    steps: [],
    expectations: [],
  };
  await mkdir(join(dir, 'cases'), { recursive: true });
  await writeFile(join(dir, 'cases', `${id}.json`), `${JSON.stringify(testCase, null, 2)}\n`);
}

const blockFiles = async () => (await readdir(join(dir, 'blocks'))).sort();
const readBlockFile = (file: string) => readFile(join(dir, 'blocks', file), 'utf8');

const LOGIN_STEPS = [
  { kind: 'launchApp' },
  { kind: 'tapOn', selector: { kind: 'text', value: 'Log in' } },
  { kind: 'inputText', text: '${EMAIL}' },
];

describe('POST /api/blocks', () => {
  it('writes a file that parses and answers its detail', async () => {
    const saved = await call('POST', '/api/blocks', { name: 'Log in', appId: APP, steps: LOGIN_STEPS });
    expect(saved.status).toBe(200);
    const detail = saved.body as BlockDetail;
    expect(detail).toEqual({ file: 'blocks/log-in.yaml', name: 'Log in', appId: APP, steps: LOGIN_STEPS, fixed: [], usedBy: [], hasComments: false });
    const flow = parseMaestroFlow(await readBlockFile('log-in.yaml'));
    expect(flow).toMatchObject({ appId: APP, name: 'Log in', steps: LOGIN_STEPS });
  });

  it('numbers the file of a second block with the same name', async () => {
    await call('POST', '/api/blocks', { name: 'Log in', appId: APP, steps: LOGIN_STEPS });
    const second = await call('POST', '/api/blocks', { name: 'Log in', appId: APP, steps: LOGIN_STEPS });
    expect(second.body.file).toBe('blocks/log-in-2.yaml');
  });

  it('refuses a request with no app id and writes nothing', async () => {
    const refused = await call('POST', '/api/blocks', { name: 'Log in', steps: LOGIN_STEPS });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('BAD_BLOCK');
    expect(refused.body.error.message).toMatch(/app id/);
    expect(await blockFiles()).toEqual([]);
  });

  it.each([
    ['an unknown kind of step', [{ kind: 'nope' }]],
    ['a tap with no selector', [{ kind: 'tapOn' }]],
    ['a null step', [null]],
    ['no steps', []],
    ['an empty tap target', [{ kind: 'tapOn', selector: { kind: 'text', value: '' } }]],
  ])('refuses %s with 400 BAD_BLOCK and writes nothing', async (_what, steps) => {
    const refused = await call('POST', '/api/blocks', { name: 'Log in', appId: APP, steps });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('BAD_BLOCK');
    expect(await blockFiles()).toEqual([]);
  });

  it.each([
    ['no name', { appId: APP, steps: LOGIN_STEPS }],
    ['steps that are not a list', { name: 'Log in', appId: APP, steps: 'back' }],
    ['a blank name', { name: '   ', appId: APP, steps: LOGIN_STEPS }],
  ])('refuses a request with %s', async (_what, body) => {
    const refused = await call('POST', '/api/blocks', body);
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('BAD_BLOCK');
    expect(await blockFiles()).toEqual([]);
  });

  it('answers 409 CASE_ACTIVE while a case is recording and writes nothing', async () => {
    await openSession();
    expect((await call('POST', '/api/case/start', { name: 'Recording' })).status).toBe(200);
    const refused = await call('POST', '/api/blocks', { name: 'Log in', appId: APP, steps: LOGIN_STEPS });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CASE_ACTIVE');
    expect(await blockFiles()).toEqual([]);
  });

  it('saves typed text equal to a .env value as its ${KEY}, so the secret is not in the file', async () => {
    await writeEnv({ PASSWORD: 'hunter22-secret' });
    const saved = await call('POST', '/api/blocks', { name: 'Log in', appId: APP, steps: [{ kind: 'inputText', text: 'hunter22-secret' }] });
    expect(saved.status).toBe(200);
    const [file] = await blockFiles();
    expect(await readBlockFile(file!)).not.toContain('hunter22-secret');
    expect(saved.text).not.toContain('hunter22-secret');
    expect(saved.body.steps).toEqual([{ kind: 'inputText', text: '${PASSWORD}' }]);
  });
});

describe('GET /api/blocks/detail', () => {
  it('answers the steps, the values the header fixes, the users and whether the file has comments', async () => {
    await writeBlock('morning.yaml', '# keep this note\n- launchApp\n- inputText: "${EMAIL}"\n', 'name: Morning\nenv:\n  REGION: eu\n');
    await writeCaseUsing('uses-morning', 'Morning case', ['blocks/morning.yaml']);
    const detail = await call('GET', '/api/blocks/detail?file=blocks/morning.yaml');
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual({
      file: 'blocks/morning.yaml',
      name: 'Morning',
      appId: APP,
      steps: [{ kind: 'launchApp' }, { kind: 'inputText', text: '${EMAIL}' }],
      fixed: ['REGION'],
      usedBy: ['Morning case'],
      hasComments: true,
    });
  });

  it('reports no comments for a file without any', async () => {
    await writeBlock('plain.yaml', '- launchApp\n');
    expect((await call('GET', '/api/blocks/detail?file=blocks/plain.yaml')).body.hasComments).toBe(false);
  });

  it('answers 404 UNKNOWN_BLOCK for a file that exists but is not a block', async () => {
    expect((await readdir(dir))).toContain('project.json');
    const missing = await call('GET', '/api/blocks/detail?file=project.json');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('UNKNOWN_BLOCK');
  });

  it('answers 404 UNKNOWN_BLOCK for a block that is not there, and without a file', async () => {
    expect((await call('GET', '/api/blocks/detail?file=blocks/nothing.yaml')).body.error.code).toBe('UNKNOWN_BLOCK');
    expect((await call('GET', '/api/blocks/detail')).status).toBe(404);
  });

  it('answers 409 BLOCK_NOT_EDITABLE for a file with a runScript', async () => {
    await writeBlock('scripted.yaml', '- launchApp\n- runScript: setup.js\n');
    const refused = await call('GET', '/api/blocks/detail?file=blocks/scripted.yaml');
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('BLOCK_NOT_EDITABLE');
  });
});

describe('PUT /api/blocks/detail', () => {
  it('keeps the file, its app id and its header values when the name and steps change', async () => {
    await mkdir(join(dir, 'blocks'), { recursive: true });
    await writeFile(join(dir, 'blocks', 'morning.yaml'), 'appId: com.other.app\nname: Morning\nenv:\n  REGION: eu\n---\n- launchApp\n');
    const saved = await call('PUT', '/api/blocks/detail?file=blocks/morning.yaml', { name: 'Evening', appId: 'com.ignored', steps: [{ kind: 'back' }] });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ file: 'blocks/morning.yaml', name: 'Evening', appId: 'com.other.app', steps: [{ kind: 'back' }], fixed: ['REGION'] });
    expect(await blockFiles()).toEqual(['morning.yaml']);
    expect(parseMaestroFlow(await readBlockFile('morning.yaml'))).toEqual({ appId: 'com.other.app', name: 'Evening', env: { REGION: 'eu' }, steps: [{ kind: 'back' }] });
  });

  it('refuses steps that break the rules and leaves the file as it was', async () => {
    await writeBlock('morning.yaml', '- launchApp\n');
    const before = await readBlockFile('morning.yaml');
    const refused = await call('PUT', '/api/blocks/detail?file=blocks/morning.yaml', { name: 'Morning', steps: [] });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('BAD_BLOCK');
    expect(await readBlockFile('morning.yaml')).toBe(before);
  });

  it('answers 409 BLOCK_NOT_EDITABLE for a file with a runScript and leaves it alone', async () => {
    await writeBlock('scripted.yaml', '- runScript: setup.js\n');
    const before = await readBlockFile('scripted.yaml');
    const refused = await call('PUT', '/api/blocks/detail?file=blocks/scripted.yaml', { name: 'Scripted', steps: [{ kind: 'back' }] });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('BLOCK_NOT_EDITABLE');
    expect(await readBlockFile('scripted.yaml')).toBe(before);
  });

  it('answers 409 CASE_ACTIVE while a case is recording', async () => {
    await writeBlock('morning.yaml', '- launchApp\n');
    await openSession();
    await call('POST', '/api/case/start', { name: 'Recording' });
    const refused = await call('PUT', '/api/blocks/detail?file=blocks/morning.yaml', { name: 'Morning', steps: [{ kind: 'back' }] });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CASE_ACTIVE');
  });
});

describe('DELETE /api/blocks/detail', () => {
  it('removes a block nothing uses', async () => {
    await writeBlock('spare.yaml', '- launchApp\n');
    const removed = await call('DELETE', '/api/blocks/detail?file=blocks/spare.yaml');
    expect(removed.status).toBe(200);
    expect(await blockFiles()).toEqual([]);
  });

  it('answers 409 BLOCK_IN_USE naming the case that uses it, and keeps the file', async () => {
    await writeBlock('login.yaml', '- launchApp\n');
    await writeCaseUsing('smoke', 'Smoke test', ['blocks/login.yaml']);
    const refused = await call('DELETE', '/api/blocks/detail?file=blocks/login.yaml');
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('BLOCK_IN_USE');
    expect(refused.body.error.message).toContain('Smoke test');
    expect(await blockFiles()).toEqual(['login.yaml']);
  });

  it('answers 409 BLOCK_IN_USE for a block another block runs', async () => {
    await writeBlock('login.yaml', '- launchApp\n');
    await writeBlock('morning.yaml', '- runFlow: login.yaml\n', 'name: Morning\n');
    const refused = await call('DELETE', '/api/blocks/detail?file=blocks/login.yaml');
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('Morning');
    expect(await blockFiles()).toEqual(['login.yaml', 'morning.yaml']);
  });

  it('answers 404 UNKNOWN_BLOCK for a file that is not a block', async () => {
    const refused = await call('DELETE', '/api/blocks/detail?file=project.json');
    expect(refused.status).toBe(404);
    expect(existsSync(join(dir, 'project.json'))).toBe(true);
  });
});

describe('GET /api/project editable', () => {
  it('is true for a plain block and for one with a wait, and absent for one with runScript', async () => {
    await writeBlock('plain.yaml', '- launchApp\n');
    const saved = await call('POST', '/api/blocks', { name: 'Pause', appId: APP, steps: [{ kind: 'wait', seconds: 5 }] });
    expect(saved.status).toBe(200);
    await writeBlock('scripted.yaml', '- runScript: setup.js\n');
    const { blocks } = (await call('GET', '/api/project')).body as ProjectInfo;
    const byFile = new Map(blocks.map((block) => [block.file, block]));
    expect(byFile.get('blocks/plain.yaml')?.editable).toBe(true);
    expect(byFile.get('blocks/pause.yaml')).toMatchObject({ editable: true, runsWith: 'maestro' });
    expect(byFile.get('blocks/scripted.yaml')).not.toHaveProperty('editable');
  });
});

describe('POST /api/screen/pick', () => {
  it('answers the selector for the element at the point and presses nothing', async () => {
    await openSession();
    const pick = await call('POST', '/api/screen/pick', { x: 300, y: 475 });
    expect(pick.status).toBe(200);
    const body = pick.body as ScreenPick;
    // The row title has a resource id, which is steadier than its text.
    expect(body.selector).toMatchObject({ kind: 'id', value: 'android:id/title' });
    expect(body.resolved?.label).toBe('Network & internet');
    expect(body.password).toBe(false);
    expect(device.presses).toEqual([]);
  });

  it('answers password true for a password field', async () => {
    await openSession();
    device.screen = 'login';
    // The pick reads the screen the studio last captured, as the mirror keeps it fresh.
    expect((await call('POST', '/api/screen/refresh')).status).toBe(200);
    const pick = await call('POST', '/api/screen/pick', { x: 500, y: 450 });
    expect(pick.status).toBe(200);
    expect(pick.body.password).toBe(true);
    expect(device.presses).toEqual([]);
  });

  it('answers 409 NO_SESSION without a device', async () => {
    const refused = await call('POST', '/api/screen/pick', { x: 300, y: 475 });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('NO_SESSION');
  });

  it('answers 400 for a point that is not numbers', async () => {
    await openSession();
    expect((await call('POST', '/api/screen/pick', { x: 'left', y: 475 })).status).toBe(400);
  });
});

describe('POST /api/blocks/try', () => {
  beforeEach(async () => {
    await writeEnv({ GREETING_SAVED: 'hello-secret', API_TOKEN: 'tok-12345' });
    await writeBlock('greet.yaml', '- inputText: "${GREETING}"\n');
    await writeBlock('fresh.yaml', '- launchApp\n- inputText: "${GREETING}"\n');
  });

  it('replays the block on the device and records no step', async () => {
    await openSession();
    const tried = await call('POST', '/api/blocks/try', { file: 'blocks/greet.yaml' });
    expect(tried.status).toBe(200);
    expect(tried.body).toHaveProperty('nodes');
    expect(device.events).toEqual(['replay greet.yaml']);
    expect(device.replays[0]!.path).toBe(join(dir, 'blocks', 'greet.yaml'));
    expect(existsSync(join(dir, 'evidence')) ? await readdir(join(dir, 'evidence')) : []).toEqual([]);
    expect(await readdir(join(dir, 'cases'))).toEqual([]);
  });

  it('gives the replay the values, with a reference replaced by the saved value', async () => {
    await openSession();
    const tried = await call('POST', '/api/blocks/try', { file: 'blocks/greet.yaml', values: { GREETING: '${GREETING_SAVED}' } });
    expect(tried.status).toBe(200);
    expect(device.replays[0]!.env).toMatchObject({ GREETING: 'hello-secret', API_TOKEN: 'tok-12345' });
  });

  it('gives the replay plain text as it was typed', async () => {
    await openSession();
    await call('POST', '/api/blocks/try', { file: 'blocks/greet.yaml', values: { GREETING: 'hi there' } });
    expect(device.replays[0]!.env.GREETING).toBe('hi there');
  });

  it('relaunches the app first for a block that starts with launchApp', async () => {
    await openSession();
    await call('POST', '/api/blocks/try', { file: 'blocks/fresh.yaml' });
    expect(device.events).toEqual(['relaunch', 'replay fresh.yaml']);
  });

  it('answers 409 CASE_ACTIVE while a case is recording and replays nothing', async () => {
    await openSession();
    await call('POST', '/api/case/start', { name: 'Recording' });
    const refused = await call('POST', '/api/blocks/try', { file: 'blocks/greet.yaml' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CASE_ACTIVE');
    expect(device.replays).toEqual([]);
  });

  it('answers 409 NO_SESSION without a device', async () => {
    const refused = await call('POST', '/api/blocks/try', { file: 'blocks/greet.yaml' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('NO_SESSION');
  });

  it('answers 400 UNKNOWN_BLOCK for a block that is not there', async () => {
    await openSession();
    const refused = await call('POST', '/api/blocks/try', { file: 'blocks/nothing.yaml' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('UNKNOWN_BLOCK');
  });

  it('answers 502 naming the block, with no .env value in the message', async () => {
    await openSession();
    device.failReplay = new Error('Typing hello-secret failed, the token tok-12345 was rejected');
    const failed = await call('POST', '/api/blocks/try', { file: 'blocks/greet.yaml', values: { GREETING: '${GREETING_SAVED}' } });
    expect(failed.status).toBe(502);
    const message = failed.body.error.message as string;
    expect(message).toMatch(/^Block blocks\/greet\.yaml failed: /);
    expect(failed.text).not.toContain('hello-secret');
    expect(failed.text).not.toContain('tok-12345');
    expect(message).toContain('${GREETING_SAVED}');
  });
});

describe('POST /api/project/saved-values', () => {
  it('writes .env and lists the key but never the value', async () => {
    const saved = await call('POST', '/api/project/saved-values', { values: { EMAIL: 'ba@example.com' } });
    expect(saved.status).toBe(200);
    expect(await readFile(join(dir, '.env'), 'utf8')).toContain('EMAIL=ba@example.com');
    expect((saved.body as ProjectInfo).envKeys).toContain('EMAIL');
    expect(saved.text).not.toContain('ba@example.com');
  });

  it('keeps the values already in .env', async () => {
    await writeEnv({ OLD: 'old-value' });
    await call('POST', '/api/project/saved-values', { values: { EMAIL: 'ba@example.com' } });
    const env = await readFile(join(dir, '.env'), 'utf8');
    expect(env).toContain('OLD=old-value');
    expect(env).toContain('EMAIL=ba@example.com');
  });

  it('answers 409 for a key that exists and leaves its value', async () => {
    await writeEnv({ EMAIL: 'first@example.com' });
    const refused = await call('POST', '/api/project/saved-values', { values: { EMAIL: 'second@example.com' } });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('BAD_SAVED_VALUE');
    expect(await readFile(join(dir, '.env'), 'utf8')).not.toContain('second@example.com');
  });

  it.each([
    ['an empty value', { EMAIL: '' }],
    ['no values', {}],
  ])('answers 400 for %s', async (_what, values) => {
    const refused = await call('POST', '/api/project/saved-values', { values });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('BAD_SAVED_VALUE');
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });

  it.each([
    ['a value that is not text', { values: { EMAIL: 5 } }],
    ['values that are a list', { values: ['a'] }],
    ['no body fields', {}],
  ])('answers 400 for %s', async (_what, body) => {
    expect((await call('POST', '/api/project/saved-values', body)).status).toBe(400);
  });
});

/** Every file under the project as path to text, so a test can look for what must not be there. */
async function projectFiles(root = dir): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) for (const [name, text] of await projectFiles(path)) files.set(name, text);
    else files.set(path, await readFile(path, 'utf8'));
  }
  return files;
}

const folderFiles = async (name: string) => (existsSync(join(dir, name)) ? readdir(join(dir, name)) : []);

/** Reopens the project with these block folders, as project.json lists them. */
async function withBlockFolders(blocks: string[]) {
  await app.close();
  const settings = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'));
  await writeFile(join(dir, 'project.json'), JSON.stringify({ ...settings, paths: { blocks } }));
  app = await buildServer({
    projectDir: dir,
    session: device,
    maestro: { run: async () => { throw new Error('Maestro was not expected to run in this test'); }, findBin: () => '/opt/maestro/bin/maestro', androidHome: () => undefined },
  });
}

async function startBlockRecording(name = 'Open settings') {
  const started = await call('POST', '/api/blocks/record', { name });
  expect(started.status).toBe(200);
  return started.body.caseId as string;
}

const TAP_ROW = { x: 300, y: 475 };

describe('POST /api/blocks/record', () => {
  it('starts recording without restarting the app', async () => {
    await openSession();
    const started = await call('POST', '/api/blocks/record', { name: 'Open settings' });
    expect(started.status).toBe(200);
    expect(started.body.caseId).toEqual(expect.any(String));
    expect(started.body).toHaveProperty('screen');
    expect(device.events).not.toContain('relaunch');
  });

  it('restarts the app when a case starts, which a block recording must not', async () => {
    await openSession();
    await call('POST', '/api/case/start', { name: 'A case' });
    expect(device.events).toContain('relaunch');
  });

  it.each([
    ['no name', {}],
    ['a blank name', { name: '   ' }],
    ['a name that is not text', { name: 5 }],
  ])('answers 400 for %s', async (_what, body) => {
    await openSession();
    const refused = await call('POST', '/api/blocks/record', body);
    expect(refused.status).toBe(400);
    expect((await call('GET', '/api/case/current')).body).toBeNull();
  });

  it('answers 409 NO_SESSION without a device', async () => {
    const refused = await call('POST', '/api/blocks/record', { name: 'Open settings' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('NO_SESSION');
  });

  it('answers 409 CASE_ACTIVE while something is already recording, and keeps that recording', async () => {
    await openSession();
    const id = (await call('POST', '/api/case/start', { name: 'A case' })).body.caseId;
    const refused = await call('POST', '/api/blocks/record', { name: 'Open settings' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CASE_ACTIVE');
    expect((await call('GET', '/api/case/current')).body.id).toBe(id);
  });

  it('marks the current recording forBlock, and a case recording not', async () => {
    await openSession();
    await startBlockRecording();
    expect((await call('GET', '/api/case/current')).body.forBlock).toBe(true);
    await call('POST', '/api/case/discard');
    await call('POST', '/api/case/start', { name: 'A case' });
    expect((await call('GET', '/api/case/current')).body).not.toHaveProperty('forBlock');
  });
});

describe('POST /api/blocks/record/finish', () => {
  it('answers the taps as Maestro steps with no launchApp, and saves nothing', async () => {
    await openSession();
    const id = await startBlockRecording();
    expect((await call('POST', '/api/action/tap', TAP_ROW)).status).toBe(200);
    expect(existsSync(join(dir, 'evidence', id))).toBe(true);
    const finished = await call('POST', '/api/blocks/record/finish', {});
    expect(finished.status).toBe(200);
    expect(finished.body.steps).toEqual([{ kind: 'tapOn', selector: expect.objectContaining({ kind: 'id', value: 'android:id/title' }) }]);
    expect(await folderFiles('cases')).toEqual([]);
    expect(await folderFiles('flows')).toEqual([]);
    expect(await folderFiles('blocks')).toEqual([]);
    expect(existsSync(join(dir, 'evidence', id))).toBe(false);
    expect((await call('GET', '/api/case/current')).body).toBeNull();
  });

  it('answers a Relaunch app during the recording as a launchApp step', async () => {
    await openSession();
    await startBlockRecording();
    await call('POST', '/api/action/tap', TAP_ROW);
    await call('POST', '/api/action/relaunch');
    const finished = await call('POST', '/api/blocks/record/finish', {});
    expect(finished.body.steps.map((step: { kind: string }) => step.kind)).toEqual(['tapOn', 'launchApp']);
  });

  it('adds the ticked end checks as assertVisible steps at the end', async () => {
    await openSession();
    await startBlockRecording();
    await call('POST', '/api/action/back');
    const { candidates } = (await call('GET', '/api/case/candidates')).body as CandidatesResponse;
    expect(candidates.length).toBeGreaterThan(0);
    const finished = await call('POST', '/api/blocks/record/finish', { picks: [candidates[0]!.id] });
    expect(finished.status).toBe(200);
    expect(finished.body.steps).toEqual([{ kind: 'back' }, { kind: 'assertVisible', selector: candidates[0]!.selector }]);
  });

  it('answers 400 BAD_PICK for a pick that is not on the screen, and keeps recording', async () => {
    await openSession();
    const id = await startBlockRecording();
    await call('POST', '/api/action/back');
    await call('GET', '/api/case/candidates');
    const refused = await call('POST', '/api/blocks/record/finish', { picks: [999] });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('BAD_PICK');
    const current = await call('GET', '/api/case/current');
    expect(current.body).toMatchObject({ id, forBlock: true });
    expect(current.body.steps).toHaveLength(1);
  });

  it('answers 409 NO_CASE when nothing is recording', async () => {
    await openSession();
    const refused = await call('POST', '/api/blocks/record/finish', {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('NO_CASE');
  });

  it('answers 409 NOT_RECORDING_BLOCK during a case recording, and keeps it', async () => {
    await openSession();
    const id = (await call('POST', '/api/case/start', { name: 'A case' })).body.caseId;
    const refused = await call('POST', '/api/blocks/record/finish', {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('NOT_RECORDING_BLOCK');
    expect((await call('GET', '/api/case/current')).body.id).toBe(id);
  });

  describe('a block run during the recording', () => {
    beforeEach(async () => {
      await writeBlock('other.yaml', '- launchApp\n');
      await mkdir(join(dir, 'more'), { recursive: true });
      await writeFile(join(dir, 'more', 'inner.yaml'), `appId: ${APP}\n---\n- launchApp\n`);
      await withBlockFolders(['blocks', 'more']);
      await openSession();
      await startBlockRecording();
      const ran = await call('POST', '/api/case/block', { file: 'blocks/other.yaml' });
      expect(ran.status).toBe(200);
    });

    it('comes back as a runFlow relative to the block folder, not the flows folder', async () => {
      const finished = await call('POST', '/api/blocks/record/finish', {});
      expect(finished.body.steps).toEqual([{ kind: 'runFlow', file: 'other.yaml' }]);
    });

    it('is relative to the folder of the block being edited when the body names it', async () => {
      const finished = await call('POST', '/api/blocks/record/finish', { file: 'more/inner.yaml' });
      expect(finished.body.steps).toEqual([{ kind: 'runFlow', file: '../blocks/other.yaml' }]);
    });

    it('answers 404 UNKNOWN_BLOCK for a file that is not a block, and keeps recording', async () => {
      const refused = await call('POST', '/api/blocks/record/finish', { file: 'project.json' });
      expect(refused.status).toBe(404);
      expect(refused.body.error.code).toBe('UNKNOWN_BLOCK');
      expect((await call('GET', '/api/case/current')).body).toMatchObject({ forBlock: true });
    });
  });
});

describe('a block recording and the case routes', () => {
  it('refuses POST /api/case/finish with 409 RECORDING_BLOCK, keeps recording and saves nothing', async () => {
    await openSession();
    const id = await startBlockRecording();
    await call('POST', '/api/action/back');
    const refused = await call('POST', '/api/case/finish', {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('RECORDING_BLOCK');
    expect((await call('GET', '/api/case/current')).body).toMatchObject({ id, forBlock: true });
    expect(await folderFiles('cases')).toEqual([]);
    expect(await folderFiles('flows')).toEqual([]);
  });

  it('is cleared by discard, so the next case recording finishes as a case', async () => {
    await openSession();
    await startBlockRecording();
    expect((await call('POST', '/api/case/discard')).status).toBe(200);
    const next = (await call('POST', '/api/case/start', { name: 'A case' })).body.caseId;
    expect((await call('GET', '/api/case/current')).body).not.toHaveProperty('forBlock');
    const finished = await call('POST', '/api/case/finish', {});
    expect(finished.status).toBe(200);
    expect(await folderFiles('cases')).toEqual([`${next}.json`]);
  });

  it('is cleared by finishing it, so the next case recording finishes as a case', async () => {
    await openSession();
    await startBlockRecording();
    await call('POST', '/api/blocks/record/finish', {});
    await call('POST', '/api/case/start', { name: 'A case' });
    expect((await call('POST', '/api/case/finish', {})).status).toBe(200);
  });
});

describe('typing a password while recording a block', () => {
  const SECRET = 'hunter22-real-password';

  async function recordOnLoginScreen() {
    await openSession();
    await startBlockRecording();
    device.screen = 'login';
    expect((await call('POST', '/api/screen/refresh')).status).toBe(200);
  }

  it('types the real text, records ${PASSWORD}, and leaves the text in no response and no file', async () => {
    await recordOnLoginScreen();
    const typed = await call('POST', '/api/action/type', { text: SECRET });
    expect(typed.status).toBe(200);
    expect(device.presses).toContain(`type ${SECRET}`);
    const current = await call('GET', '/api/case/current');
    const finished = await call('POST', '/api/blocks/record/finish', {});
    expect(finished.body.steps).toEqual([{ kind: 'inputText', text: '${PASSWORD}' }]);
    for (const response of [typed.text, current.text, finished.text]) expect(response).not.toContain(SECRET);
    await call('POST', '/api/blocks', { name: 'Log in', appId: APP, steps: finished.body.steps });
    for (const [path, text] of await projectFiles()) expect(text, path).not.toContain(SECRET);
  });

  it('records a saved key with PASS in its name when there is one', async () => {
    await writeEnv({ ADMIN_PASSCODE: 'saved-passcode-1', EMAIL: 'ba@example.com' });
    await recordOnLoginScreen();
    await call('POST', '/api/action/type', { text: SECRET });
    const finished = await call('POST', '/api/blocks/record/finish', {});
    expect(finished.body.steps).toEqual([{ kind: 'inputText', text: '${ADMIN_PASSCODE}' }]);
  });

  it('records typed text equal to a saved value as that ${KEY}', async () => {
    await writeEnv({ EMAIL: 'ba@example.com' });
    await openSession();
    await startBlockRecording();
    await call('POST', '/api/action/type', { text: 'ba@example.com' });
    const finished = await call('POST', '/api/blocks/record/finish', {});
    expect(finished.body.steps).toEqual([{ kind: 'inputText', text: '${EMAIL}' }]);
    expect(device.presses).toContain('type ba@example.com');
  });

  it('records a saved value typed into a password field as its own key, not the PASS key', async () => {
    await writeEnv({ ADMIN_PASSCODE: 'saved-passcode-1', OTHER_SECRET: SECRET });
    await recordOnLoginScreen();
    await call('POST', '/api/action/type', { text: SECRET });
    const finished = await call('POST', '/api/blocks/record/finish', {});
    expect(finished.body.steps).toEqual([{ kind: 'inputText', text: '${OTHER_SECRET}' }]);
  });

  it('is still refused with 400 PASSWORD_FIELD in a case recording, and nothing is typed', async () => {
    await openSession();
    await call('POST', '/api/case/start', { name: 'A case' });
    device.screen = 'login';
    await call('POST', '/api/screen/refresh');
    const refused = await call('POST', '/api/action/type', { text: SECRET });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('PASSWORD_FIELD');
    expect(refused.text).not.toContain(SECRET);
    expect(device.presses).toEqual([]);
  });
});

describe('GET /api/cases/:caseId/block-draft', () => {
  const tapStep = (index: number, value: string) => ({ index, kind: 'tap', selector: { kind: 'text', value }, point: { x: 1, y: 1 }, at: '2026-11-01T10:00:00.000Z' });
  const check = (value: string) => ({ selector: { kind: 'text', value }, at: '2026-11-01T10:00:00.000Z' });

  async function saveCase(id: string, rest: Partial<TestCase>) {
    const testCase = { id, name: id, appId: APP, createdAt: '2026-11-01T10:00:00.000Z', deviceId: DEVICE, preconditionBlocks: [], steps: [], expectations: [], ...rest };
    await mkdir(join(dir, 'cases'), { recursive: true });
    await writeFile(join(dir, 'cases', `${id}.json`), `${JSON.stringify(testCase, null, 2)}\n`);
  }

  it('answers the launch, the blocks as runFlow, the steps and the end checks', async () => {
    await writeBlock('login.yaml', '- launchApp\n');
    await writeBlock('plain.yaml', '- back\n');
    await writeEnv({ UNRELATED: 'value-1234' });
    await saveCase('smoke', {
      name: 'Smoke',
      preconditionBlocks: [{ file: 'blocks/login.yaml', values: { USERNAME: '${AGENT_USERNAME}' } }, { file: 'blocks/plain.yaml' }],
      steps: [tapStep(1, 'Settings')] as TestCase['steps'],
      expectations: [check('Network') as TestCase['expectations'][number]],
    });
    const draft = await call('GET', '/api/cases/smoke/block-draft');
    expect(draft.status).toBe(200);
    expect(draft.body).toEqual({
      name: 'Smoke',
      appId: APP,
      steps: [
        { kind: 'launchApp' },
        { kind: 'runFlow', file: 'login.yaml', env: { USERNAME: '${AGENT_USERNAME}' } },
        { kind: 'runFlow', file: 'plain.yaml' },
        { kind: 'tapOn', selector: { kind: 'text', value: 'Settings' } },
        { kind: 'assertVisible', selector: { kind: 'text', value: 'Network' } },
      ],
    });
  });

  it('flattens a case that starts from another into one list with one launchApp', async () => {
    await saveCase('parent', { steps: [tapStep(1, 'One')] as TestCase['steps'], expectations: [check('Parent check')] as TestCase['expectations'] });
    await saveCase('child', { startFrom: 'parent', steps: [tapStep(1, 'Two')] as TestCase['steps'], expectations: [check('Child check')] as TestCase['expectations'] });
    const draft = await call('GET', '/api/cases/child/block-draft');
    expect(draft.status).toBe(200);
    expect(draft.body.steps).toEqual([
      { kind: 'launchApp' },
      { kind: 'tapOn', selector: { kind: 'text', value: 'One' } },
      { kind: 'assertVisible', selector: { kind: 'text', value: 'Parent check' } },
      { kind: 'tapOn', selector: { kind: 'text', value: 'Two' } },
      { kind: 'assertVisible', selector: { kind: 'text', value: 'Child check' } },
    ]);
    expect(JSON.stringify(draft.body)).not.toContain('parent.yaml');
  });

  it('flattens three levels, oldest first', async () => {
    await saveCase('a', { steps: [tapStep(1, 'A')] as TestCase['steps'] });
    await saveCase('b', { startFrom: 'a', steps: [tapStep(1, 'B')] as TestCase['steps'] });
    await saveCase('c', { startFrom: 'b', steps: [tapStep(1, 'C')] as TestCase['steps'] });
    const steps = (await call('GET', '/api/cases/c/block-draft')).body.steps;
    expect(steps).toEqual([
      { kind: 'launchApp' },
      { kind: 'tapOn', selector: { kind: 'text', value: 'A' } },
      { kind: 'tapOn', selector: { kind: 'text', value: 'B' } },
      { kind: 'tapOn', selector: { kind: 'text', value: 'C' } },
    ]);
  });

  it('answers 404 for an unknown case', async () => {
    expect((await call('GET', '/api/cases/nothing/block-draft')).status).toBe(404);
  });

  it('answers 409 BROKEN_CHAIN when the case it starts from was removed', async () => {
    await saveCase('orphan', { startFrom: 'gone' });
    const refused = await call('GET', '/api/cases/orphan/block-draft');
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('BROKEN_CHAIN');
  });

  it('writes nothing and leaves the case as it was', async () => {
    await writeBlock('login.yaml', '- launchApp\n');
    await saveCase('smoke', { preconditionBlocks: [{ file: 'blocks/login.yaml' }], steps: [tapStep(1, 'Settings')] as TestCase['steps'] });
    const before = [...(await projectFiles())];
    await call('GET', '/api/cases/smoke/block-draft');
    expect([...(await projectFiles())]).toEqual(before);
  });

  it('gives steps that can be saved as a block and read back unchanged', async () => {
    await writeBlock('login.yaml', '- launchApp\n');
    await saveCase('smoke', {
      name: 'Smoke',
      preconditionBlocks: [{ file: 'blocks/login.yaml', values: { USERNAME: '${AGENT_USERNAME}' } }],
      steps: [tapStep(1, 'Settings')] as TestCase['steps'],
      expectations: [check('Network')] as TestCase['expectations'],
    });
    const draft = (await call('GET', '/api/cases/smoke/block-draft')).body;
    const saved = await call('POST', '/api/blocks', draft);
    expect(saved.status).toBe(200);
    const detail = await call('GET', `/api/blocks/detail?file=${saved.body.file}`);
    expect(detail.body.steps).toEqual(draft.steps);
    expect(detail.body.name).toBe('Smoke');
  });
});

describe('PUT /api/blocks/detail running itself', () => {
  it('refuses a runFlow step that resolves to the block own file, and leaves the file as it was', async () => {
    await writeBlock('a.yaml', '- launchApp\n');
    const before = await readBlockFile('a.yaml');
    const refused = await call('PUT', '/api/blocks/detail?file=blocks/a.yaml', { name: 'A', steps: [{ kind: 'back' }, { kind: 'runFlow', file: 'a.yaml' }] });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('BAD_BLOCK');
    expect(refused.body.error.message).toMatch(/run itself/);
    expect(await readBlockFile('a.yaml')).toBe(before);
  });

  it('refuses the same file written with a detour', async () => {
    await writeBlock('a.yaml', '- launchApp\n');
    const refused = await call('PUT', '/api/blocks/detail?file=blocks/a.yaml', { name: 'A', steps: [{ kind: 'runFlow', file: '../blocks/a.yaml' }] });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/run itself/);
  });

  it('accepts a runFlow to a different block', async () => {
    await writeBlock('a.yaml', '- launchApp\n');
    await writeBlock('b.yaml', '- back\n');
    const saved = await call('PUT', '/api/blocks/detail?file=blocks/a.yaml', { name: 'A', steps: [{ kind: 'runFlow', file: 'b.yaml' }] });
    expect(saved.status).toBe(200);
    expect(saved.body.steps).toEqual([{ kind: 'runFlow', file: 'b.yaml' }]);
  });
});

describe('a block that leads back to itself through another block', () => {
  it('is refused on save with 400 BAD_BLOCK, and the file is left as it was', async () => {
    await writeBlock('a.yaml', '- runFlow: b.yaml\n');
    await writeBlock('b.yaml', '- launchApp\n');
    const before = await readBlockFile('b.yaml');
    const refused = await call('PUT', '/api/blocks/detail?file=blocks/b.yaml', { name: 'B', steps: [{ kind: 'runFlow', file: 'a.yaml' }] });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('BAD_BLOCK');
    expect(refused.body.error.message).toMatch(/run itself/);
    expect(await readBlockFile('b.yaml')).toBe(before);
  });

  it('is accepted when the block it runs does not lead back', async () => {
    await writeBlock('a.yaml', '- launchApp\n');
    await writeBlock('b.yaml', '- launchApp\n');
    const saved = await call('PUT', '/api/blocks/detail?file=blocks/b.yaml', { name: 'B', steps: [{ kind: 'runFlow', file: 'a.yaml' }] });
    expect(saved.status).toBe(200);
  });
});

describe('POST /api/blocks with a runFlow step', () => {
  it('refuses an empty flow file with 400 BAD_BLOCK and writes nothing', async () => {
    const refused = await call('POST', '/api/blocks', { name: 'Chain', appId: APP, steps: [{ kind: 'runFlow', file: '' }] });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('BAD_BLOCK');
    expect(await blockFiles()).toEqual([]);
  });
});

describe('POST /api/blocks leading back to its own new file', () => {
  const runs = (file: string) => [{ kind: 'runFlow', file }];

  it('refuses a runFlow of the file the block would get, and writes nothing', async () => {
    const refused = await call('POST', '/api/blocks', { name: 'Loop', appId: APP, steps: runs('loop.yaml') });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('BAD_BLOCK');
    expect(refused.body.error.message).toMatch(/run itself/);
    expect(await folderFiles('blocks')).toEqual([]);
  });

  it('judges the numbered file the block would get when the plain name is taken', async () => {
    await writeBlock('loop.yaml', '- launchApp\n');
    const refused = await call('POST', '/api/blocks', { name: 'Loop', appId: APP, steps: runs('loop-2.yaml') });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('BAD_BLOCK');
    expect(await blockFiles()).toEqual(['loop.yaml']);
  });

  it('accepts a runFlow of the file that is taken, as the new block gets another file', async () => {
    await writeBlock('loop.yaml', '- launchApp\n');
    const saved = await call('POST', '/api/blocks', { name: 'Loop', appId: APP, steps: runs('loop.yaml') });
    expect(saved.status).toBe(200);
    expect(saved.body.file).toBe('blocks/loop-2.yaml');
    expect(await blockFiles()).toEqual(['loop-2.yaml', 'loop.yaml']);
  });

  it('refuses a loop through a block that runs the file the new block would get', async () => {
    await writeBlock('b.yaml', '- runFlow: x.yaml\n');
    const refused = await call('POST', '/api/blocks', { name: 'X', appId: APP, steps: runs('b.yaml') });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('BAD_BLOCK');
    expect(await blockFiles()).toEqual(['b.yaml']);
  });

  it('answers an ordinary save with its file and writes it', async () => {
    const saved = await call('POST', '/api/blocks', { name: 'Open settings', appId: APP, steps: [{ kind: 'launchApp' }] });
    expect(saved.status).toBe(200);
    expect(saved.body.file).toBe('blocks/open-settings.yaml');
    expect(await blockFiles()).toEqual(['open-settings.yaml']);
  });
});

describe('DELETE /api/blocks/detail of a block run by a broken block', () => {
  it('answers 409 BLOCK_IN_USE naming the broken block, keeps the file, and lists it in usedBy', async () => {
    await writeBlock('login.yaml', '- launchApp\n');
    await writeBlock('morning.yaml', '- runFlow: login.yaml\n- runFlow: missing.yaml\n', 'name: Morning\n');
    const store = await ProjectStore.open(dir);
    const morning = (await store.listBlocks()).find((block) => block.file === 'blocks/morning.yaml');
    expect(morning?.outline).toBeUndefined();

    const refused = await call('DELETE', '/api/blocks/detail?file=blocks/login.yaml');
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('BLOCK_IN_USE');
    // A broken block is listed by its file name, as it has no readable name.
    expect(refused.body.error.message).toContain('morning');
    expect(await blockFiles()).toEqual(['login.yaml', 'morning.yaml']);

    const detail = await call('GET', '/api/blocks/detail?file=blocks/login.yaml');
    expect(detail.body.usedBy).toEqual(['morning']);
  });
});

/**
 * Holds the device queue with a screen refresh that waits on the fake's capture.
 * Whatever is sent while it is held queues up behind it, in the order sent.
 */
async function holdQueue() {
  let release!: () => void;
  let entered!: () => void;
  const until = new Promise<void>((resolve) => { release = resolve; });
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  device.holdNext = { entered, until };
  const refresh = call('POST', '/api/screen/refresh');
  await inside;
  return { release, refresh };
}

/** How long to wait for a request to reach the queue or answer before calling the test broken. */
const QUEUE_WAIT_MS = 10_000;

/**
 * Waits until the request has joined the queue (the count went up) or has
 * already answered, as a request refused early never queues. Fails loudly
 * instead of letting the next request go out in the wrong order.
 */
async function untilQueuedOrAnswered(before: number, answered: Promise<unknown>) {
  let listener!: () => void;
  let timer!: NodeJS.Timeout;
  const joined = new Promise<void>((resolve) => {
    listener = () => {
      if (queued.count > before) resolve();
    };
    queued.listeners.add(listener);
    listener();
  });
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`A request neither reached the queue nor answered within ${QUEUE_WAIT_MS} ms`)), QUEUE_WAIT_MS);
  });
  try {
    await Promise.race([joined, answered, timedOut]);
  } finally {
    queued.listeners.delete(listener);
    clearTimeout(timer);
  }
}

/** Sends the requests one after another without waiting for any answer, with the queue held until all are in it. */
async function sendQueued(requests: Array<() => ReturnType<typeof call>>) {
  const held = await holdQueue();
  const pending: Array<ReturnType<typeof call>> = [];
  for (const send of requests) {
    const before = queued.count;
    const answer = send();
    pending.push(answer);
    await untilQueuedOrAnswered(before, answer);
  }
  held.release();
  const answers = await Promise.all(pending);
  expect((await held.refresh).status).toBe(200);
  return answers;
}

const statusesOf = (answers: Array<{ status: number }>) => answers.map((answer) => answer.status).sort();

describe('requests that overlap', () => {
  describe('two saves that together make a loop', () => {
    it('lets exactly one through, and the blocks on disk do not lead back to each other', async () => {
      await writeBlock('a.yaml', '- launchApp\n');
      await writeBlock('b.yaml', '- launchApp\n');
      const [first, second] = await Promise.all([
        call('PUT', '/api/blocks/detail?file=blocks/a.yaml', { name: 'A', steps: [{ kind: 'runFlow', file: 'b.yaml' }] }),
        call('PUT', '/api/blocks/detail?file=blocks/b.yaml', { name: 'B', steps: [{ kind: 'runFlow', file: 'a.yaml' }] }),
      ]);
      expect(statusesOf([first!, second!])).toEqual([200, 400]);
      const refused = first!.status === 400 ? first! : second!;
      expect(refused.body.error.code).toBe('BAD_BLOCK');
      expect(refused.body.error.message).toMatch(/run itself/);

      const store = await ProjectStore.open(dir);
      const blocks = await store.listBlocks();
      expect(blocks.map((block) => block.file).sort()).toEqual(['blocks/a.yaml', 'blocks/b.yaml']);
      for (const block of blocks) {
        expect(await store.reachesBlock(block.file, block.outline!.ownFlow!.steps), block.file).toBe(false);
      }
    });
  });

  describe('a save and a delete of the same unused block', () => {
    it('removes the file when the delete is last', async () => {
      await writeBlock('spare.yaml', '- launchApp\n');
      await openSession();
      const [saved, removed] = await sendQueued([
        () => call('PUT', '/api/blocks/detail?file=blocks/spare.yaml', { name: 'Spare', steps: [{ kind: 'back' }] }),
        () => call('DELETE', '/api/blocks/detail?file=blocks/spare.yaml'),
      ]);
      expect(saved!.status).toBe(200);
      expect(removed!.status).toBe(200);
      expect(await blockFiles()).toEqual([]);
    });

    it('answers the save 404 UNKNOWN_BLOCK and does not bring the file back when the delete is first', async () => {
      await writeBlock('spare.yaml', '- launchApp\n');
      await openSession();
      const [removed, saved] = await sendQueued([
        () => call('DELETE', '/api/blocks/detail?file=blocks/spare.yaml'),
        () => call('PUT', '/api/blocks/detail?file=blocks/spare.yaml', { name: 'Spare', steps: [{ kind: 'back' }] }),
      ]);
      expect(removed!.status).toBe(200);
      expect(saved!.status).toBe(404);
      expect(saved!.body.error.code).toBe('UNKNOWN_BLOCK');
      expect(await blockFiles()).toEqual([]);
    });
  });

  describe('two new blocks with the same name', () => {
    it('both save, each to a file of its own', async () => {
      await openSession();
      const send = () => call('POST', '/api/blocks', { name: 'Same', appId: APP, steps: [{ kind: 'launchApp' }] });
      const answers = await sendQueued([send, send]);
      expect(statusesOf(answers)).toEqual([200, 200]);
      expect(answers.map((answer) => answer.body.file).sort()).toEqual(['blocks/same-2.yaml', 'blocks/same.yaml']);
      expect(await blockFiles()).toEqual(['same-2.yaml', 'same.yaml']);
    });

    it('both save when sent at once', async () => {
      const send = () => call('POST', '/api/blocks', { name: 'Same', appId: APP, steps: [{ kind: 'launchApp' }] });
      const answers = await Promise.all([send(), send()]);
      expect(statusesOf(answers)).toEqual([200, 200]);
      expect(new Set(answers.map((answer) => answer.body.file)).size).toBe(2);
      expect(await blockFiles()).toHaveLength(2);
    });
  });

  describe('two block recordings', () => {
    it('start exactly one, and the other is refused with 409 CASE_ACTIVE', async () => {
      await openSession();
      const answers = await Promise.all([
        call('POST', '/api/blocks/record', { name: 'First' }),
        call('POST', '/api/blocks/record', { name: 'Second' }),
      ]);
      expect(statusesOf(answers)).toEqual([200, 409]);
      const won = answers.find((answer) => answer.status === 200)!;
      const lost = answers.find((answer) => answer.status === 409)!;
      expect(lost.body.error.code).toBe('CASE_ACTIVE');
      const current = await call('GET', '/api/case/current');
      expect(current.body).toMatchObject({ id: won.body.caseId, forBlock: true });
    });
  });

  describe('a block recording and a case start', () => {
    it('keeps the case a normal case when the case wins, and /api/case/finish saves it', async () => {
      await openSession();
      const [started, refused] = await sendQueued([
        () => call('POST', '/api/case/start', { name: 'A case' }),
        () => call('POST', '/api/blocks/record', { name: 'A block' }),
      ]);
      expect(started!.status).toBe(200);
      expect(refused!.status).toBe(409);
      expect(refused!.body.error.code).toBe('CASE_ACTIVE');
      const current = await call('GET', '/api/case/current');
      expect(current.body.id).toBe(started!.body.caseId);
      expect(current.body).not.toHaveProperty('forBlock');
      expect((await call('POST', '/api/case/finish', {})).status).toBe(200);
      expect(await folderFiles('cases')).toEqual([`${started!.body.caseId}.json`]);
    });

    it('marks the recording for a block when the block wins, and the case start is refused', async () => {
      await openSession();
      const [recording, refused] = await sendQueued([
        () => call('POST', '/api/blocks/record', { name: 'A block' }),
        () => call('POST', '/api/case/start', { name: 'A case' }),
      ]);
      expect(recording!.status).toBe(200);
      expect(refused!.status).toBe(409);
      expect(refused!.body.error.code).toBe('CASE_ACTIVE');
      expect((await call('GET', '/api/case/current')).body).toMatchObject({ id: recording!.body.caseId, forBlock: true });
    });

    it('lets exactly one win when both are sent at the same moment, and the mark agrees with the winner', async () => {
      await openSession();
      const [recording, started] = await Promise.all([
        call('POST', '/api/blocks/record', { name: 'A block' }),
        call('POST', '/api/case/start', { name: 'A case' }),
      ]);
      expect(statusesOf([recording!, started!])).toEqual([200, 409]);
      const current = (await call('GET', '/api/case/current')).body;
      if (recording!.status === 200) expect(current.forBlock).toBe(true);
      else expect(current).not.toHaveProperty('forBlock');
    });
  });

  describe('a block recording and editing a saved case', () => {
    const EDIT = { mode: 'insert', after: 0 };

    it('starts the edit and refuses the recording when the edit is first', async () => {
      await writeCaseUsing('saved', 'Saved', []);
      await openSession();
      const [edit, recording] = await sendQueued([
        () => call('POST', '/api/cases/saved/edit', EDIT),
        () => call('POST', '/api/blocks/record', { name: 'A block' }),
      ]);
      expect(edit!.status).toBe(200);
      expect(recording!.status).toBe(409);
      expect(recording!.body.error.code).toBe('CASE_ACTIVE');
      const current = (await call('GET', '/api/case/current')).body;
      expect(current).toMatchObject({ id: 'saved', editing: { mode: 'insert' } });
      expect(current).not.toHaveProperty('forBlock');
    });

    it('starts the recording and refuses the edit when the recording is first', async () => {
      await writeCaseUsing('saved', 'Saved', []);
      await openSession();
      const [recording, edit] = await sendQueued([
        () => call('POST', '/api/blocks/record', { name: 'A block' }),
        () => call('POST', '/api/cases/saved/edit', EDIT),
      ]);
      expect(recording!.status).toBe(200);
      expect(edit!.status).toBe(409);
      expect(edit!.body.error.code).toBe('CASE_ACTIVE');
      const current = (await call('GET', '/api/case/current')).body;
      expect(current).toMatchObject({ id: recording!.body.caseId, forBlock: true });
      expect(current).not.toHaveProperty('editing');
    });

    it('lets exactly one win when both are sent at the same moment, and forBlock agrees with the winner', async () => {
      await writeCaseUsing('saved', 'Saved', []);
      await openSession();
      const [recording, edit] = await Promise.all([
        call('POST', '/api/blocks/record', { name: 'A block' }),
        call('POST', `/api/cases/saved/edit`, EDIT),
      ]);
      expect(statusesOf([recording!, edit!])).toEqual([200, 409]);
      const current = (await call('GET', '/api/case/current')).body;
      expect(current.forBlock === true).toBe(recording!.status === 200);
    });
  });

  describe('finishing and discarding one block recording', () => {
    it.each([
      ['finish first', () => [call('POST', '/api/blocks/record/finish', {}), call('POST', '/api/case/discard')]],
      ['discard first', () => [call('POST', '/api/case/discard'), call('POST', '/api/blocks/record/finish', {})]],
    ])('lets exactly one end it, the other gets 409 NO_CASE, and nothing is left recording (%s)', async (_order, send) => {
      await openSession();
      await startBlockRecording();
      const answers = await Promise.all(send());
      expect(statusesOf(answers)).toEqual([200, 409]);
      expect(answers.find((answer) => answer.status === 409)!.body.error.code).toBe('NO_CASE');
      expect((await call('GET', '/api/case/current')).body).toBeNull();
    });
  });

  describe('an end that waited while its recording was replaced', () => {
    // Sent in this order with the queue held: finish of recording A, a new
    // recording B, then a discard that was aimed at A. The discard's task runs
    // after B exists, which is the order that used to throw B away.
    it('is refused with 409 NO_CASE and the new recording survives', async () => {
      await openSession();
      await startBlockRecording('First');
      expect((await call('POST', '/api/action/back')).status).toBe(200);
      const [finished, started, discarded] = await sendQueued([
        () => call('POST', '/api/blocks/record/finish', {}),
        () => call('POST', '/api/blocks/record', { name: 'Second' }),
        () => call('POST', '/api/case/discard'),
      ]);
      expect(finished!.status).toBe(200);
      expect(finished!.body.steps).toEqual([{ kind: 'back' }]);
      expect(started!.status).toBe(200);
      expect(discarded!.status).toBe(409);
      expect(discarded!.body.error.code).toBe('NO_CASE');
      const current = (await call('GET', '/api/case/current')).body;
      expect(current).toMatchObject({ id: started!.body.caseId, name: 'Second', forBlock: true });
      expect(current.steps).toHaveLength(0);
    });

    it('is refused for a stale finish too, and the new recording keeps its steps', async () => {
      await openSession();
      await startBlockRecording('First');
      const [discarded, started, finished] = await sendQueued([
        () => call('POST', '/api/case/discard'),
        () => call('POST', '/api/blocks/record', { name: 'Second' }),
        () => call('POST', '/api/blocks/record/finish', {}),
      ]);
      expect(discarded!.status).toBe(200);
      expect(started!.status).toBe(200);
      expect(finished!.status).toBe(409);
      expect(finished!.body.error.code).toBe('NO_CASE');
      expect((await call('GET', '/api/case/current')).body).toMatchObject({ id: started!.body.caseId, name: 'Second', forBlock: true });
    });
  });

  describe('ending a case recording twice', () => {
    it('saves once for two finishes, and the second gets 409 NO_CASE', async () => {
      await openSession();
      await call('POST', '/api/case/start', { name: 'A case' });
      const answers = await Promise.all([call('POST', '/api/case/finish', {}), call('POST', '/api/case/finish', {})]);
      expect(statusesOf(answers)).toEqual([200, 409]);
      expect(answers.find((answer) => answer.status === 409)!.body.error.code).toBe('NO_CASE');
      expect(await folderFiles('cases')).toHaveLength(1);
      expect((await call('GET', '/api/case/current')).body).toBeNull();
    });

    it.each([
      ['finish first', () => [call('POST', '/api/case/finish', {}), call('POST', '/api/case/discard')]],
      ['discard first', () => [call('POST', '/api/case/discard'), call('POST', '/api/case/finish', {})]],
    ])('lets exactly one of a finish and a discard through (%s)', async (_order, send) => {
      await openSession();
      await call('POST', '/api/case/start', { name: 'A case' });
      const answers = await Promise.all(send());
      expect(statusesOf(answers)).toEqual([200, 409]);
      expect(answers.find((answer) => answer.status === 409)!.body.error.code).toBe('NO_CASE');
      expect((await call('GET', '/api/case/current')).body).toBeNull();
    });
  });

  describe('trying a block and starting a block recording', () => {
    beforeEach(async () => {
      await writeBlock('greet.yaml', '- inputText: "hello"\n');
      await openSession();
    });

    it('replays the block only while nothing is recording when the try is first', async () => {
      const seen: unknown[] = [];
      device.onReplay = async () => {
        seen.push((await call('GET', '/api/case/current')).body);
      };
      const [tried, recording] = await sendQueued([
        () => call('POST', '/api/blocks/try', { file: 'blocks/greet.yaml' }),
        () => call('POST', '/api/blocks/record', { name: 'A block' }),
      ]);
      expect(tried!.status).toBe(200);
      expect(recording!.status).toBe(200);
      expect(device.replays).toHaveLength(1);
      expect(seen).toEqual([null]);
    });

    it('refuses the try with 409 CASE_ACTIVE and replays nothing when the recording is first', async () => {
      const [recording, tried] = await sendQueued([
        () => call('POST', '/api/blocks/record', { name: 'A block' }),
        () => call('POST', '/api/blocks/try', { file: 'blocks/greet.yaml' }),
      ]);
      expect(recording!.status).toBe(200);
      expect(tried!.status).toBe(409);
      expect(tried!.body.error.code).toBe('CASE_ACTIVE');
      expect(device.replays).toEqual([]);
    });

    it('never replays while a recording is active when both are sent at the same moment', async () => {
      const seen: unknown[] = [];
      device.onReplay = async () => {
        seen.push((await call('GET', '/api/case/current')).body);
      };
      const [tried, recording] = await Promise.all([
        call('POST', '/api/blocks/try', { file: 'blocks/greet.yaml' }),
        call('POST', '/api/blocks/record', { name: 'A block' }),
      ]);
      expect(recording!.status).toBe(200);
      expect([200, 409]).toContain(tried!.status);
      expect(device.replays).toHaveLength(tried!.status === 200 ? 1 : 0);
      expect(seen.every((current) => current === null)).toBe(true);
    });
  });

  describe('a clean-up that fails', () => {
    // Removing a folder needs write access to the folder that holds it.
    const cannotRemove = process.platform === 'win32' || process.getuid?.() === 0;

    it.skipIf(cannotRemove)('still hands over the steps, ends the recording and logs the folder', async () => {
      await openSession();
      const id = await startBlockRecording();
      expect((await call('POST', '/api/action/back')).status).toBe(200);
      const evidence = join(dir, 'evidence');
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await chmod(evidence, 0o555);
      try {
        const finished = await call('POST', '/api/blocks/record/finish', {});
        expect(finished.status).toBe(200);
        expect(finished.body.steps).toEqual([{ kind: 'back' }]);
        expect((await call('GET', '/api/case/current')).body).toBeNull();
        const text = logged.mock.calls.map((args) => args.map((arg) => String(arg)).join(' ')).join('\n');
        expect(text).toContain(id);
        expect(text).toContain('evidence');
        // The folder really was left behind, so this test is not passing on a clean-up that worked.
        expect(existsSync(join(evidence, id))).toBe(true);
      } finally {
        await chmod(evidence, 0o755);
        logged.mockRestore();
      }
    });
  });

  describe('a password nothing has saved', () => {
    const SECRET = 'hunter22-real-password';

    async function recordOnLoginScreen() {
      await openSession();
      await startBlockRecording();
      device.screen = 'login';
      expect((await call('POST', '/api/screen/refresh')).status).toBe(200);
    }

    /** Everything the studio printed while the spies were on, as one string. */
    function listen() {
      const spies = (['error', 'log', 'warn', 'info'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
      return {
        printed: () => spies.flatMap((spy) => spy.mock.calls).map((args) => args.map((arg) => inspect(arg)).join(' ')).join('\n'),
        stop: () => spies.forEach((spy) => spy.mockRestore()),
      };
    }

    it('is not repeated in a device error: 502 TYPE_FAILED, nothing printed, no step, still recording', async () => {
      await recordOnLoginScreen();
      device.failType = new Error(`keyboard gone while typing ${SECRET}`);
      const output = listen();
      try {
        const failed = await call('POST', '/api/action/type', { text: SECRET });
        expect(failed.status).toBe(502);
        expect(failed.body.error.code).toBe('TYPE_FAILED');
        expect(failed.text).not.toContain(SECRET);
        expect(output.printed()).not.toContain(SECRET);
      } finally {
        output.stop();
      }
      const current = await call('GET', '/api/case/current');
      expect(current.body).toMatchObject({ forBlock: true });
      expect(current.body.steps).toHaveLength(0);
      expect(current.text).not.toContain(SECRET);
    });

    it('still records the step once the device works again', async () => {
      await recordOnLoginScreen();
      device.failType = new Error(`keyboard gone while typing ${SECRET}`);
      expect((await call('POST', '/api/action/type', { text: SECRET })).status).toBe(502);
      device.failType = undefined;
      expect((await call('POST', '/api/action/type', { text: SECRET })).status).toBe(200);
      const finished = await call('POST', '/api/blocks/record/finish', {});
      expect(finished.body.steps).toEqual([{ kind: 'inputText', text: '${PASSWORD}' }]);
    });

    it('leaves a saved value on the normal error path, not TYPE_FAILED', async () => {
      await writeEnv({ OTHER_SECRET: SECRET });
      await recordOnLoginScreen();
      device.failType = new Error('keyboard gone');
      const output = listen();
      try {
        const failed = await call('POST', '/api/action/type', { text: SECRET });
        expect(failed.status).toBe(502);
        expect(failed.body.error.code).not.toBe('TYPE_FAILED');
      } finally {
        output.stop();
      }
      expect((await call('GET', '/api/case/current')).body.steps).toHaveLength(0);
    });
  });
});
