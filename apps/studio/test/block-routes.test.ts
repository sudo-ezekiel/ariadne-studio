// The Blocks tab routes: writing, reading, changing and deleting a setup block
// file, picking an element on the screen for a step, trying a block, and saving
// a setting's value to .env. The device is a fake that records what it was
// asked to do; none of these tests reach a real phone.
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMaestroFlow, type DeviceSnapshot, type OpenOptions, type Point, type TestCase } from '@ariadne/core';
import type { BlockDetail, CandidatesResponse, ProjectInfo, ScreenPick } from '../src/shared/api-types.ts';
import { buildServer } from '../src/server/index.ts';
import type { DeviceLike } from '../src/server/state.ts';

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
    mkdirSync(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, PNG);
    return { ...(await this.snapshot()), screenshotPath };
  }
  async tapAt(point: Point) {
    this.presses.push(`tap ${point.x},${point.y}`);
  }
  async typeText(text: string) {
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
