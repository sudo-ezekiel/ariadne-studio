// Setup blocks with values (which test user a log in block uses), blocks run in
// the middle of a recording, test users saved to .env, and the edits that must
// keep working on a case with a block step in it. The device is a fake that
// records what it was asked to do, in order.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError, parseMaestroFlow, testUsers, type CaseStep, type DeviceSnapshot, type MaestroStep, type OpenOptions, type Point, type TestCase } from '@ariadne/core';
import type { CaseDetailResponse, CurrentCaseView, ProjectInfo } from '../src/shared/api-types.ts';
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
type ScreenName = 'home' | 'network' | 'login';

function row(index: number, y: number, title: string): Node[] {
  return [
    { index, depth: 1, rect: { x: 0, y, width: 1080, height: 200 }, hittable: true },
    { index: index + 1, depth: 2, parentIndex: index, rect: { x: 200, y: y + 40, width: 400, height: 70 }, label: title, identifier: 'android:id/title' },
  ];
}

const screens: Record<ScreenName, Node[]> = {
  home: [...row(0, 400, 'Network & internet'), ...row(2, 600, 'Connected devices')],
  network: [...row(0, 400, 'Internet'), ...row(2, 600, 'SIMs')],
  login: [{ index: 0, depth: 1, rect: { x: 0, y: 400, width: 1080, height: 150 }, label: 'Password', password: true, focused: true, editable: true }],
};

function labels(screen: { nodes: Array<{ label?: string }> }): string[] {
  return screen.nodes.flatMap((node) => (node.label ? [node.label] : []));
}

/** In-memory stand-in for DeviceSession that logs every call that matters to blocks, in order. */
class FakeDevice implements DeviceLike {
  screen: ScreenName = 'home';
  target: { deviceId: string; appId: string } | undefined;
  /** 'relaunch' and 'replay <file name>', in the order they happened. */
  events: string[] = [];
  /** Every replay with the env it got and the flow text as it was then (partial flows are deleted afterwards). */
  replays: Array<{ path: string; env: Record<string, string>; yaml: string }> = [];
  /** The error a replay of this file throws, if any. */
  failReplay: ((path: string) => Error | undefined) | undefined;
  /** Screen a replay of this file name leaves the app on. */
  leavesScreen = new Map<string, ScreenName>();

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
    this.screen = 'home';
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
    if (this.screen === 'home' && point.y < 600) this.screen = 'network';
  }
  async typeText(_text: string) {}
  async back() {
    this.screen = 'home';
  }
  async scroll() {}
  async openLink() {}
  async hideKeyboard() {}
  async longPressAt() {}
  async doubleTapAt() {}
  async swipe() {}
  async pinch() {}
  async pressKey() {}
  async setOrientation() {}
  async replayFlow(path: string, env: Readonly<Record<string, string>>) {
    const yaml = await readFile(path, 'utf8').catch(() => '');
    this.replays.push({ path, env: { ...env }, yaml });
    this.events.push(`replay ${basename(path)}`);
    const failure = this.failReplay?.(path);
    if (failure) {
      this.screen = 'login';
      throw failure;
    }
    this.screen = this.leavesScreen.get(basename(path)) ?? this.screen;
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
  return { status: response.statusCode, body: response.headers['content-type']?.includes('json') ? response.json() : response.body };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ariadne-studio-blocks-'));
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

const LOGIN = ['- launchApp:', '    clearState: true', '- inputText: "${USERNAME}"', '- inputText: "${PASSWORD}"', ''].join('\n');

// Saved values for two test users, and what the fake device must be given for them.
const TEST_USERS = {
  SUPERVISOR_USERNAME: 'sup@example.com',
  SUPERVISOR_PASSWORD: 'hunter22',
  AGENT_MARIA_USERNAME: 'maria@example.com',
  AGENT_MARIA_PASSWORD: 'maria-pass-9',
};
const AS_SUPERVISOR = { USERNAME: '${SUPERVISOR_USERNAME}', PASSWORD: '${SUPERVISOR_PASSWORD}' };
const AS_MARIA = { USERNAME: '${AGENT_MARIA_USERNAME}', PASSWORD: '${AGENT_MARIA_PASSWORD}' };
const PASS_THROUGH = Object.fromEntries(Object.keys(TEST_USERS).map((key) => [key, `\${${key}}`]));

const tapNetwork = () => call('POST', '/api/action/tap', { x: 1000, y: 500 }); // "Network & internet" on home
const pressBack = () => call('POST', '/api/action/back');

type Use = string | { file: string; values?: Record<string, string> };

async function startCase(name: string, blocks?: Use[]) {
  return call('POST', '/api/case/start', { name, ...(blocks ? { blocks } : {}) });
}

async function readCaseFile(caseId: string): Promise<TestCase> {
  return JSON.parse(await readFile(join(dir, 'cases', `${caseId}.json`), 'utf8')) as TestCase;
}

async function evidenceFiles(caseId: string): Promise<string[]> {
  return (await readdir(join(dir, 'evidence', caseId))).sort();
}

function runFlowsIn(yaml: string): Array<Extract<MaestroStep, { kind: 'runFlow' }>> {
  return parseMaestroFlow(yaml).steps.filter((step): step is Extract<MaestroStep, { kind: 'runFlow' }> => step.kind === 'runFlow');
}

/** A flow as a list of words, to compare its order at a glance. */
function shape(yaml: string): string[] {
  return parseMaestroFlow(yaml).steps.map((step) => {
    switch (step.kind) {
      case 'runFlow':
        return `runFlow ${step.file}`;
      case 'tapOn':
        return `tapOn ${step.selector.kind === 'text' ? step.selector.value : step.selector.kind}`;
      default:
        return step.kind;
    }
  });
}

async function caseFilesAreEmpty(): Promise<boolean> {
  return (await readdir(join(dir, 'cases'))).length === 0;
}

describe('starting a case with block values', () => {
  const ALL_ENV = { ...TEST_USERS, USERNAME: 'ba@example.com', PASSWORD: 'ba-secret-1' };

  it('runs each block with the project env under its resolved values, and saves references', async () => {
    await writeEnv(ALL_ENV);
    await writeBlock('login.yaml', LOGIN);
    await writeBlock('second.yaml', '- back\n');
    await openSession();
    const started = await startCase('Two users', [
      // A saved value pasted as text is saved as a reference to it.
      { file: 'blocks/login.yaml', values: { USERNAME: '${SUPERVISOR_USERNAME}', PASSWORD: 'hunter22' } },
      'blocks/second.yaml',
      { file: 'blocks/login.yaml', values: AS_MARIA },
    ]);
    expect(started.status).toBe(200);

    expect(device.replays.map((replay) => [basename(replay.path), replay.env])).toEqual([
      ['login.yaml', { ...ALL_ENV, USERNAME: 'sup@example.com', PASSWORD: 'hunter22' }],
      ['second.yaml', ALL_ENV],
      ['login.yaml', { ...ALL_ENV, USERNAME: 'maria@example.com', PASSWORD: 'maria-pass-9' }],
    ]);

    const finished = await call('POST', '/api/case/finish');
    expect(finished.status).toBe(200);
    const caseId = started.body.caseId as string;
    const saved = await readCaseFile(caseId);
    expect(saved.preconditionBlocks).toStrictEqual([
      { file: 'blocks/login.yaml', values: AS_SUPERVISOR },
      { file: 'blocks/second.yaml' },
      { file: 'blocks/login.yaml', values: AS_MARIA },
    ]);

    const passThrough = Object.fromEntries(Object.keys(ALL_ENV).map((key) => [key, `\${${key}}`]));
    const yaml = await readFile(join(dir, 'flows', `${caseId}.yaml`), 'utf8');
    expect(yaml).toBe(finished.body.yaml);
    expect(shape(yaml)).toEqual(['launchApp', 'runFlow ../blocks/login.yaml', 'runFlow ../blocks/second.yaml', 'runFlow ../blocks/login.yaml']);
    expect(runFlowsIn(yaml).map((step) => step.env)).toEqual([
      { ...passThrough, ...AS_SUPERVISOR },
      passThrough,
      { ...passThrough, ...AS_MARIA },
    ]);

    // No secret reaches the case file or the flow, only the names of saved values.
    const caseJson = await readFile(join(dir, 'cases', `${caseId}.json`), 'utf8');
    for (const text of [caseJson, yaml]) {
      for (const secret of Object.values(ALL_ENV)) expect(text).not.toContain(secret);
    }
  });

  it('drops empty values, so the block runs with the project env alone', async () => {
    await writeEnv(ALL_ENV);
    await writeBlock('login.yaml', LOGIN);
    await openSession();
    const started = await startCase('Empty values', [{ file: 'blocks/login.yaml', values: { USERNAME: '', PASSWORD: '' } }]);
    expect(started.status).toBe(200);
    expect(device.replays.map((replay) => replay.env)).toEqual([ALL_ENV]);
    await call('POST', '/api/case/finish');
    const saved = await readCaseFile(started.body.caseId);
    expect(saved.preconditionBlocks).toStrictEqual([{ file: 'blocks/login.yaml' }]);
  });

  it('keeps plain text for a setting that is not a secret, in the case file and in the flow', async () => {
    await writeBlock('search.yaml', '- inputText: "${POLICY_NUMBER}"\n');
    await openSession();
    const started = await startCase('Search', [{ file: 'blocks/search.yaml', values: { POLICY_NUMBER: '12345' } }]);
    expect(started.status).toBe(200);
    expect(device.replays.map((replay) => replay.env)).toEqual([{ POLICY_NUMBER: '12345' }]);
    const finished = await call('POST', '/api/case/finish');
    expect((await readCaseFile(started.body.caseId)).preconditionBlocks).toStrictEqual([{ file: 'blocks/search.yaml', values: { POLICY_NUMBER: '12345' } }]);
    expect(runFlowsIn(finished.body.yaml as string)[0]!.env).toEqual({ POLICY_NUMBER: '12345' });
  });

  it('does not restart the app before the first block, only before later blocks that begin by launching it', async () => {
    await writeBlock('login.yaml', LOGIN);
    await writeBlock('second.yaml', '- back\n');
    await writeBlock('late.yaml', '- back\n- launchApp\n');
    await openSession();
    expect((await startCase('Order', ['blocks/login.yaml', 'blocks/login.yaml', 'blocks/second.yaml', 'blocks/late.yaml'])).status).toBe(200);
    expect(device.events).toEqual(['relaunch', 'replay login.yaml', 'relaunch', 'replay login.yaml', 'replay second.yaml', 'replay late.yaml']);

    await call('POST', '/api/case/discard');
    device.events = [];
    expect((await startCase('Plain first', ['blocks/second.yaml', 'blocks/login.yaml'])).status).toBe(200);
    expect(device.events).toEqual(['relaunch', 'replay second.yaml', 'relaunch', 'replay login.yaml']);

    await call('POST', '/api/case/discard');
    device.events = [];
    expect((await startCase('No blocks')).status).toBe(200);
    expect(device.events).toEqual(['relaunch']);
  });

  describe('refuses values that cannot be used', () => {
    const SEARCH = [
      '- inputText: "${USERNAME}"',
      '- inputText: "${PASSWORD}"',
      '- inputText: "${COUNTRY}"',
      '- inputText: "${POLICY_NUMBER}"',
      '',
    ].join('\n');
    const refused: Array<[string, Record<string, string>, RegExp]> = [
      ['a setting the block does not use', { NOPE: 'x' }, /no setting called NOPE/],
      ['a setting the block gives a default in its own env header', { COUNTRY: 'DE' }, /no setting called COUNTRY/],
      ['a reference to a value that is not saved', { USERNAME: '${NOBODY_USERNAME}' }, /no saved value called NOBODY_USERNAME/],
      ['typed text for a secret', { PASSWORD: 'typed-secret' }, /looks like a secret/],
      ['text mixed with a reference', { USERNAME: 'maria-${SUPERVISOR_USERNAME}' }, /not a mix/],
      ['a value over several lines', { POLICY_NUMBER: 'a\nb' }, /one line/],
      ['a value over 200 characters', { POLICY_NUMBER: 'x'.repeat(201) }, /at most 200/],
      ['a name that is not a variable name', { 'bad name': 'x' }, /not a variable name/],
    ];

    beforeEach(async () => {
      await writeEnv(TEST_USERS);
      await writeBlock('search.yaml', SEARCH, 'name: Search policy\nenv:\n  COUNTRY: GR\n');
      await writeBlock('ok.yaml', '- back\n');
      await openSession();
    });

    it.each(refused)('%s', async (_what, values, message) => {
      const response = await startCase('Refused', [{ file: 'blocks/search.yaml', values }]);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('BAD_BLOCK_VALUE');
      expect(response.body.error.message).toMatch(/^Search policy: /);
      expect(response.body.error.message).toMatch(message);
      expect(device.events).toEqual([]);
      expect((await call('GET', '/api/case/current')).body).toBeNull();
      expect(await caseFilesAreEmpty()).toBe(true);
    });

    it('runs nothing when a later block has bad values', async () => {
      const response = await startCase('Refused', ['blocks/ok.yaml', { file: 'blocks/search.yaml', values: { PASSWORD: 'typed-secret' } }]);
      expect(response).toMatchObject({ status: 400, body: { error: { code: 'BAD_BLOCK_VALUE' } } });
      expect(device.events).toEqual([]);
    });

    it('names the block by its file name when it has no name of its own', async () => {
      await writeBlock('plain.yaml', '- inputText: "${PASSWORD}"\n');
      const response = await startCase('Refused', [{ file: 'blocks/plain.yaml', values: { PASSWORD: 'typed-secret' } }]);
      expect(response.body.error.message).toMatch(/^plain: /);
    });

    it('refuses any value for a block with nothing to set', async () => {
      const response = await startCase('Refused', [{ file: 'blocks/ok.yaml', values: { USERNAME: 'x' } }]);
      expect(response).toMatchObject({ status: 400, body: { error: { code: 'BAD_BLOCK_VALUE', message: expect.stringMatching(/^ok: .*no setting called USERNAME/) } } });
    });

    it('accepts the settings that are allowed, at the 200 character limit', async () => {
      const response = await startCase('Allowed', [{ file: 'blocks/search.yaml', values: { USERNAME: '${SUPERVISOR_USERNAME}', POLICY_NUMBER: 'x'.repeat(200) } }]);
      expect(response.status).toBe(200);
    });

    it('still reports an unknown or broken block as UNKNOWN_BLOCK, with values or without', async () => {
      await writeBlock('broken.yaml', 'pressKey: Enter\n');
      for (const use of [{ file: 'blocks/missing.yaml', values: AS_SUPERVISOR }, { file: 'blocks/broken.yaml', values: AS_SUPERVISOR }]) {
        expect(await startCase('Refused', [use])).toMatchObject({ status: 400, body: { error: { code: 'UNKNOWN_BLOCK' } } });
      }
      expect(device.events).toEqual([]);
    });
  });

  describe('refuses a block that is not written as a path or { file, values }', () => {
    const bodies: Array<[string, unknown[]]> = [
      ['a number', [42]],
      ['null', [null]],
      ['a list', [['blocks/second.yaml']]],
      ['an object without a file', [{}]],
      ['values without a file', [{ values: {} }]],
      ['a file that is not text', [{ file: 7 }]],
      ['values that are text', [{ file: 'blocks/second.yaml', values: 'USERNAME' }]],
      ['values that are a list', [{ file: 'blocks/second.yaml', values: ['a'] }]],
      ['values that are null', [{ file: 'blocks/second.yaml', values: null }]],
      ['a value that is not text', [{ file: 'blocks/second.yaml', values: { A: 1 } }]],
      ['a value that is an object', [{ file: 'blocks/second.yaml', values: { A: { B: 'c' } } }]],
    ];

    it.each(bodies)('%s', async (_what, blocks) => {
      await writeBlock('second.yaml', '- back\n');
      await openSession();
      const response = await call('POST', '/api/case/start', { name: 'Shape', blocks });
      expect(response).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
      expect(device.events).toEqual([]);
    });
  });

  describe('when a block fails', () => {
    beforeEach(async () => {
      await writeEnv({ ...TEST_USERS, USERNAME: 'ba@example.com' });
      await writeFile(join(dir, 'project.json'), `${JSON.stringify({ appId: APP, platform: 'android', env: { API_HOST: 'https://internal.example.com' } })}\n`);
      await writeBlock('login.yaml', LOGIN);
      await writeBlock('second.yaml', '- back\n');
      await openSession();
    });

    it('answers 502 and hides every saved value in the message, from .env and project.json', async () => {
      device.failReplay = (path) =>
        basename(path) === 'login.yaml'
          ? new Error('Typing sup@example.com failed, the password hunter22 was rejected at https://internal.example.com/login for ba@example.com')
          : undefined;
      const failed = await startCase('Fails', [{ file: 'blocks/login.yaml', values: AS_SUPERVISOR }]);
      expect(failed.status).toBe(502);
      const message = failed.body.error.message as string;
      expect(message).toMatch(/^Block blocks\/login\.yaml failed: /);
      for (const secret of ['sup@example.com', 'hunter22', 'https://internal.example.com', 'ba@example.com']) expect(message).not.toContain(secret);
      for (const key of ['SUPERVISOR_USERNAME', 'SUPERVISOR_PASSWORD', 'API_HOST', 'USERNAME']) expect(message).toContain(`\${${key}}`);
      expect(JSON.stringify(failed.body)).not.toContain('hunter22');
    });

    it('starts no case, and leaves the mirror on the screen where the block stopped', async () => {
      device.failReplay = () => new Error('boom');
      expect((await startCase('Fails', [{ file: 'blocks/login.yaml', values: AS_SUPERVISOR }])).status).toBe(502);
      expect((await call('GET', '/api/case/current')).body).toBeNull();
      expect(labels((await call('GET', '/api/screen')).body)).toEqual(['Password']);
      expect(await caseFilesAreEmpty()).toBe(true);
    });

    it('names the block that failed and does not run the ones after it', async () => {
      device.failReplay = (path) => (basename(path) === 'second.yaml' ? new Error('no luck') : undefined);
      const failed = await startCase('Fails', ['blocks/login.yaml', 'blocks/second.yaml', 'blocks/login.yaml']);
      expect(failed.status).toBe(502);
      expect(failed.body.error.message).toMatch(/^Block blocks\/second\.yaml failed: /);
      expect(device.events).toEqual(['relaunch', 'replay login.yaml', 'replay second.yaml']);
    });
  });
});

describe('POST /api/case/block', () => {
  beforeEach(async () => {
    await writeEnv(TEST_USERS);
    await writeBlock('login.yaml', LOGIN);
    await writeBlock('second.yaml', '- back\n');
    await writeBlock('open-settings.yaml', '- tapOn: "Network & internet"\n');
    await writeBlock('broken.yaml', 'pressKey: Enter\n');
  });

  it('needs a device and a case being recorded', async () => {
    const body = { file: 'blocks/second.yaml' };
    expect(await call('POST', '/api/case/block', body)).toMatchObject({ status: 409, body: { error: { code: 'NO_SESSION' } } });
    await openSession();
    expect(await call('POST', '/api/case/block', body)).toMatchObject({ status: 409, body: { error: { code: 'NO_CASE' } } });
    expect(device.events).toEqual([]);
  });

  it('answers 409 for a missing session or case even when the block is unknown', async () => {
    expect(await call('POST', '/api/case/block', { file: 'blocks/missing.yaml' })).toMatchObject({ status: 409, body: { error: { code: 'NO_SESSION' } } });
    await openSession();
    expect(await call('POST', '/api/case/block', { file: 'blocks/missing.yaml' })).toMatchObject({ status: 409, body: { error: { code: 'NO_CASE' } } });
  });

  it('refuses a request that does not name a block', async () => {
    await openSession();
    await startCase('Mid');
    for (const body of [undefined, {}, { values: AS_MARIA }, { file: 7 }, { file: 'blocks/second.yaml', values: 'x' }, { file: 'blocks/second.yaml', values: { A: 1 } }]) {
      expect(await call('POST', '/api/case/block', body as object), JSON.stringify(body)).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
    }
    expect((await call('GET', '/api/case/current')).body.steps).toEqual([]);
  });

  it('refuses an unknown or broken block and bad values without running anything or recording a step', async () => {
    await openSession();
    await startCase('Mid');
    device.events = [];
    expect(await call('POST', '/api/case/block', { file: 'blocks/missing.yaml' })).toMatchObject({ status: 400, body: { error: { code: 'UNKNOWN_BLOCK' } } });
    expect(await call('POST', '/api/case/block', { file: 'blocks/broken.yaml' })).toMatchObject({ status: 400, body: { error: { code: 'UNKNOWN_BLOCK', message: expect.stringContaining('list of commands') } } });
    const typed = await call('POST', '/api/case/block', { file: 'blocks/login.yaml', values: { USERNAME: '${SUPERVISOR_USERNAME}', PASSWORD: 'typed-secret' } });
    expect(typed).toMatchObject({ status: 400, body: { error: { code: 'BAD_BLOCK_VALUE' } } });
    expect(typed.body.error.message).toMatch(/^login: .*PASSWORD looks like a secret/);
    expect(await call('POST', '/api/case/block', { file: 'blocks/login.yaml', values: { USERNAME: '${NOBODY_USERNAME}' } })).toMatchObject({ status: 400, body: { error: { code: 'BAD_BLOCK_VALUE' } } });
    expect(await call('POST', '/api/case/block', { file: 'blocks/second.yaml', values: { USERNAME: 'x' } })).toMatchObject({ status: 400, body: { error: { code: 'BAD_BLOCK_VALUE' } } });
    expect(device.events).toEqual([]);
    expect((await call('GET', '/api/case/current')).body.steps).toEqual([]);
  });

  it('runs the block with its resolved values and records one step with a screenshot', async () => {
    await openSession();
    const caseId = (await startCase('Mid')).body.caseId as string;
    device.events = [];
    const response = await call('POST', '/api/case/block', { file: 'blocks/login.yaml', values: { USERNAME: '${AGENT_MARIA_USERNAME}', PASSWORD: 'maria-pass-9' } });
    expect(response.status).toBe(200);
    expect(response.body.step).toMatchObject({
      index: 1,
      kind: 'block',
      file: 'blocks/login.yaml',
      // The pasted saved value was saved as a reference.
      values: AS_MARIA,
      screenshot: `evidence/${caseId}/step-001.png`,
      screenshotUrl: expect.stringContaining(`/api/evidence/${caseId}/step-001.png`),
    });
    expect(labels(response.body.screen)).toEqual(['Network & internet', 'Connected devices']);

    expect(device.replays).toHaveLength(1);
    expect(device.replays[0]).toMatchObject({ path: join(dir, 'blocks', 'login.yaml'), env: { ...TEST_USERS, USERNAME: 'maria@example.com', PASSWORD: 'maria-pass-9' } });
    expect(existsSync(join(dir, 'evidence', caseId, 'step-001.png'))).toBe(true);
    const shot = await app.inject({ method: 'GET', url: response.body.step.screenshotUrl });
    expect(shot.statusCode).toBe(200);
    expect(shot.headers['content-type']).toBe('image/png');
    const current = (await call('GET', '/api/case/current')).body as CurrentCaseView;
    expect(current.steps).toHaveLength(1);
    expect(current.steps[0]).toMatchObject({ kind: 'block', file: 'blocks/login.yaml', values: AS_MARIA });
  });

  it('records a block without values as a step with no values key', async () => {
    await openSession();
    await startCase('Mid');
    const response = await call('POST', '/api/case/block', { file: 'blocks/second.yaml' });
    expect(response.status).toBe(200);
    expect(response.body.step).not.toHaveProperty('values');
    // An empty value is dropped before the block is checked, so it sets nothing.
    const empty = await call('POST', '/api/case/block', { file: 'blocks/second.yaml', values: { USERNAME: '' } });
    expect(empty.status).toBe(200);
    expect(empty.body.step).not.toHaveProperty('values');
    const none = await call('POST', '/api/case/block', { file: 'blocks/second.yaml', values: {} });
    expect(none.status).toBe(200);
    expect(none.body.step).not.toHaveProperty('values');
  });

  it('restarts the app first only when the block begins by launching it', async () => {
    await openSession();
    await startCase('Mid');
    device.events = [];
    await call('POST', '/api/case/block', { file: 'blocks/login.yaml', values: AS_SUPERVISOR });
    await call('POST', '/api/case/block', { file: 'blocks/second.yaml' });
    await call('POST', '/api/case/block', { file: 'blocks/login.yaml', values: AS_MARIA });
    expect(device.events).toEqual(['relaunch', 'replay login.yaml', 'replay second.yaml', 'relaunch', 'replay login.yaml']);
  });

  it('restarts the app even for the first block of a case that started with the same block', async () => {
    await openSession();
    await startCase('Both', [{ file: 'blocks/login.yaml', values: AS_SUPERVISOR }]);
    expect(device.events).toEqual(['relaunch', 'replay login.yaml']);
    await call('POST', '/api/case/block', { file: 'blocks/login.yaml', values: AS_MARIA });
    expect(device.events).toEqual(['relaunch', 'replay login.yaml', 'relaunch', 'replay login.yaml']);
  });

  it('records the screen the block left the app on', async () => {
    device.leavesScreen.set('open-settings.yaml', 'network');
    await openSession();
    await startCase('Mid');
    const response = await call('POST', '/api/case/block', { file: 'blocks/open-settings.yaml' });
    expect(labels(response.body.screen)).toEqual(['Internet', 'SIMs']);
    expect(labels((await call('GET', '/api/screen')).body)).toEqual(['Internet', 'SIMs']);
  });

  it('puts the block between the steps around it, in the case file and in the flow', async () => {
    await openSession();
    const started = await startCase('Two users', [{ file: 'blocks/login.yaml', values: AS_SUPERVISOR }]);
    const caseId = started.body.caseId as string;
    expect((await tapNetwork()).body.step).toMatchObject({ index: 1, kind: 'tap' });
    const block = await call('POST', '/api/case/block', { file: 'blocks/login.yaml', values: AS_MARIA });
    expect(block.body.step).toMatchObject({ index: 2, kind: 'block', screenshot: `evidence/${caseId}/step-002.png` });
    expect((await tapNetwork()).body.step).toMatchObject({ index: 3, kind: 'tap', screenshot: `evidence/${caseId}/step-003.png` });
    const finished = await call('POST', '/api/case/finish');
    expect(finished.status).toBe(200);

    const saved = await readCaseFile(caseId);
    expect(saved.steps.map((step) => step.kind)).toEqual(['tap', 'block', 'tap']);
    expect(saved.steps[1]).toMatchObject({ kind: 'block', file: 'blocks/login.yaml', values: AS_MARIA });
    expect(await evidenceFiles(caseId)).toEqual(['step-001.png', 'step-002.png', 'step-003.png']);

    const yaml = finished.body.yaml as string;
    expect(shape(yaml)).toEqual([
      'launchApp',
      'runFlow ../blocks/login.yaml',
      'tapOn Network & internet',
      'runFlow ../blocks/login.yaml',
      'tapOn Network & internet',
    ]);
    expect(runFlowsIn(yaml).map((step) => step.env)).toEqual([
      { ...PASS_THROUGH, ...AS_SUPERVISOR },
      { ...PASS_THROUGH, ...AS_MARIA },
    ]);
    for (const secret of Object.values(TEST_USERS)) {
      expect(yaml).not.toContain(secret);
      expect(JSON.stringify(saved)).not.toContain(secret);
    }
  });

  it('can run the same block twice in a row', async () => {
    await openSession();
    const caseId = (await startCase('Twice')).body.caseId as string;
    await call('POST', '/api/case/block', { file: 'blocks/second.yaml' });
    await call('POST', '/api/case/block', { file: 'blocks/second.yaml' });
    expect((await call('GET', '/api/case/current')).body.steps.map((step: CaseStep) => [step.index, step.kind])).toEqual([[1, 'block'], [2, 'block']]);
    expect(await readdir(join(dir, 'evidence', caseId)).then((files) => files.sort())).toEqual(['step-001.png', 'step-002.png']);
  });

  describe('when the block fails', () => {
    it('answers 502 with the saved values hidden, records no step and uses up no screenshot number', async () => {
      await openSession();
      const caseId = (await startCase('Mid')).body.caseId as string;
      expect((await tapNetwork()).body.step).toMatchObject({ index: 1 });
      device.failReplay = (path) => (basename(path) === 'login.yaml' ? new AppError('REPLAY_DIVERGENCE', 'Replay failed at step 3 (inputText "maria@example.com"): password maria-pass-9 not accepted.') : undefined);
      const failed = await call('POST', '/api/case/block', { file: 'blocks/login.yaml', values: AS_MARIA });
      expect(failed.status).toBe(502);
      expect(failed.body.error.code).toBe('REPLAY_DIVERGENCE');
      const message = failed.body.error.message as string;
      expect(message).toMatch(/^Block blocks\/login\.yaml failed: Replay failed at step 3/);
      expect(message).not.toContain('maria@example.com');
      expect(message).not.toContain('maria-pass-9');
      expect(message).toContain('${AGENT_MARIA_USERNAME}');
      expect(message).toContain('${AGENT_MARIA_PASSWORD}');

      // No step, and the mirror shows where the block stopped.
      expect((await call('GET', '/api/case/current')).body.steps).toHaveLength(1);
      expect(labels((await call('GET', '/api/screen')).body)).toEqual(['Password']);

      // The next step takes the number the failed block never used.
      device.failReplay = undefined;
      device.screen = 'home';
      const next = await tapNetwork();
      expect(next.body.step).toMatchObject({ index: 2, screenshot: `evidence/${caseId}/step-002.png` });
    });
  });
});

describe('test users', () => {
  const SIGN_IN = ['- inputText: "${USERNAME}"', '- inputText: "${PASSWORD}"', ''].join('\n');

  async function saveUser(name: string, values: Record<string, string>) {
    return call('POST', '/api/project/test-users', { name, values });
  }

  it('saves a test user as PREFIX_VARIABLE values in .env and returns the project', async () => {
    const response = await saveUser('Supervisor', { USERNAME: 'sup@example.com', PASSWORD: 'hunter22' });
    expect(response.status).toBe(200);
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('SUPERVISOR_USERNAME=sup@example.com\nSUPERVISOR_PASSWORD=hunter22\n');
    const project = response.body as ProjectInfo;
    expect(project.envKeys).toEqual(['SUPERVISOR_PASSWORD', 'SUPERVISOR_USERNAME']);
    expect(project).toHaveProperty('blocks');
    expect(project).toHaveProperty('cases');
    expect(JSON.stringify(response.body)).not.toContain('sup@example.com');
    expect(JSON.stringify(response.body)).not.toContain('hunter22');
  });

  it('turns the name into the prefix, and keeps what .env already holds', async () => {
    await writeFile(join(dir, '.env'), '# accounts\nUSERNAME=ba@example.com\n');
    expect((await saveUser('Agent Maria', { USERNAME: 'maria@example.com' })).status).toBe(200);
    expect((await saveUser('  qa-2  ', { PIN: '4821' })).status).toBe(200);
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('# accounts\nUSERNAME=ba@example.com\nAGENT_MARIA_USERNAME=maria@example.com\nQA_2_PIN=4821\n');
  });

  it('is offered on a block that uses those settings, and starts a case as that user', async () => {
    await writeBlock('sign-in.yaml', SIGN_IN);
    await writeBlock('other.yaml', '- inputText: "${COUNTRY}"\n');
    await saveUser('Supervisor', { USERNAME: 'sup@example.com', PASSWORD: 'hunter22' });
    const project = (await call('GET', '/api/project')).body as ProjectInfo;
    const signIn = project.blocks.find((block) => block.file === 'blocks/sign-in.yaml')!;
    const other = project.blocks.find((block) => block.file === 'blocks/other.yaml')!;
    expect(signIn.settable).toEqual(['PASSWORD', 'USERNAME']);
    const users = testUsers(signIn.settable!, project.envKeys);
    expect(users.map((user) => user.label)).toEqual(['Supervisor']);
    expect(testUsers(other.settable!, project.envKeys)).toEqual([]);

    await openSession();
    const started = await startCase('As supervisor', [{ file: 'blocks/sign-in.yaml', values: users[0]!.values }]);
    expect(started.status).toBe(200);
    expect(device.replays[0]!.env).toMatchObject({ USERNAME: 'sup@example.com', PASSWORD: 'hunter22' });
  });

  it('refuses a name that gives no prefix', async () => {
    for (const name of ['1st', '!!!', '', '   ', 'A'.repeat(41), 'Μαρία']) {
      expect(await saveUser(name, { USERNAME: 'x' }), JSON.stringify(name)).toMatchObject({ status: 400, body: { error: { code: 'BAD_TEST_USER' } } });
    }
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });

  it('refuses a request without a name or values, with an empty value, or with a bad setting name', async () => {
    const bad: unknown[] = [
      undefined,
      {},
      { name: 'Supervisor' },
      { name: 7, values: { USERNAME: 'x' } },
      { name: 'Supervisor', values: {} },
      { name: 'Supervisor', values: [] },
      { name: 'Supervisor', values: 'USERNAME=x' },
      { name: 'Supervisor', values: { USERNAME: 1 } },
      { name: 'Supervisor', values: { USERNAME: '' } },
      { name: 'Supervisor', values: { USERNAME: 'x', PASSWORD: '' } },
      { name: 'Supervisor', values: { 'bad name': 'x' } },
      { name: 'Supervisor', values: { '1ST': 'x' } },
      { name: 'Supervisor', values: { '': 'x' } },
    ];
    for (const body of bad) {
      expect(await call('POST', '/api/project/test-users', body as object), JSON.stringify(body)).toMatchObject({ status: 400, body: { error: { code: 'BAD_TEST_USER' } } });
    }
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });

  it('answers 409 when a saved value of that name exists, and writes none of the user', async () => {
    await writeFile(join(dir, '.env'), 'SUPERVISOR_PASSWORD=old-secret\n');
    const clash = await saveUser('Supervisor', { USERNAME: 'sup@example.com', PASSWORD: 'new-secret' });
    expect(clash).toMatchObject({ status: 409, body: { error: { code: 'BAD_TEST_USER', message: expect.stringContaining('SUPERVISOR_PASSWORD') } } });
    expect(JSON.stringify(clash.body)).not.toContain('old-secret');
    expect(JSON.stringify(clash.body)).not.toContain('new-secret');
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('SUPERVISOR_PASSWORD=old-secret\n');
  });

  it('answers 409 for a clash with project.json env, and for saving the same user twice', async () => {
    await writeFile(join(dir, 'project.json'), `${JSON.stringify({ appId: APP, platform: 'android', env: { AGENT_USERNAME: 'a@example.com' } })}\n`);
    expect(await saveUser('Agent', { USERNAME: 'b@example.com' })).toMatchObject({ status: 409 });
    expect((await saveUser('Supervisor', { USERNAME: 'sup@example.com' })).status).toBe(200);
    expect(await saveUser('supervisor', { USERNAME: 'other@example.com' })).toMatchObject({ status: 409 });
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('SUPERVISOR_USERNAME=sup@example.com\n');
  });

  it('refuses a value with a line break, without writing it', async () => {
    const response = await saveUser('Supervisor', { USERNAME: 'a\nb' });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(response.body.error.message).toMatch(/one line/);
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });

  it('keeps a value with spaces or quotes exactly as typed', async () => {
    expect((await saveUser('Supervisor', { PASSWORD: ' pass "word" ' })).status).toBe(200);
    expect((await call('GET', '/api/project')).status).toBe(200);
    await writeBlock('sign-in.yaml', '- inputText: "${PASSWORD}"\n');
    await openSession();
    await startCase('Spaces', [{ file: 'blocks/sign-in.yaml', values: { PASSWORD: '${SUPERVISOR_PASSWORD}' } }]);
    expect(device.replays[0]!.env.PASSWORD).toBe(' pass "word" ');
  });
});

describe('GET /api/project for blocks and saved values', () => {
  async function project(): Promise<ProjectInfo> {
    const response = await call('GET', '/api/project');
    expect(response.status).toBe(200);
    return response.body as ProjectInfo;
  }

  it('lists the keys of saved values from .env and project.json, sorted and once each, and no value', async () => {
    await writeFile(join(dir, '.env'), 'ZED=zed-value\nSHARED=env-wins\nALPHA=alpha-value\n');
    await writeFile(join(dir, 'project.json'), `${JSON.stringify({ appId: APP, platform: 'android', env: { SHARED: 'json-value', BETA: 'beta-value' } })}\n`);
    const info = await project();
    expect(info.envKeys).toEqual(['ALPHA', 'BETA', 'SHARED', 'ZED']);
    const text = JSON.stringify(info);
    for (const value of ['zed-value', 'env-wins', 'alpha-value', 'json-value', 'beta-value']) expect(text).not.toContain(value);
  });

  it('has an empty envKeys list when nothing is saved', async () => {
    expect((await project()).envKeys).toEqual([]);
  });

  it('lists what a case may set: the variables the block does not give a default', async () => {
    await writeBlock('search.yaml', '- inputText: "${POLICY_NUMBER}"\n- inputText: "${COUNTRY}"\n- inputText: "${CITY}"\n', 'env:\n  COUNTRY: GR\n  CITY: Athens\n');
    await writeBlock('all-defaults.yaml', '- inputText: "${COUNTRY}"\n', 'env:\n  COUNTRY: GR\n');
    await writeBlock('none.yaml', '- back\n');
    const blocks = (await project()).blocks;
    const byFile = (file: string) => blocks.find((block) => block.file === file)!;
    expect(byFile('blocks/search.yaml')).toMatchObject({ variables: ['CITY', 'COUNTRY', 'POLICY_NUMBER'], settable: ['POLICY_NUMBER'] });
    expect(byFile('blocks/all-defaults.yaml')).toMatchObject({ variables: ['COUNTRY'] });
    expect(byFile('blocks/all-defaults.yaml')).not.toHaveProperty('settable');
    expect(byFile('blocks/none.yaml')).not.toHaveProperty('settable');
  });

  it('counts a variable set by .env as settable too', async () => {
    await writeBlock('sign-in.yaml', '- inputText: "${USERNAME}"\n');
    await writeEnv({ USERNAME: 'ba@example.com' });
    expect((await project()).blocks[0]).toMatchObject({ settable: ['USERNAME'] });
    expect((await project()).blocks[0]).not.toHaveProperty('missingVariables');
  });

  it('marks a block that clears the app data, wherever the launch is', async () => {
    await writeBlock('first.yaml', '- launchApp:\n    clearState: true\n');
    await writeBlock('later.yaml', '- tapOn: "Settings"\n- launchApp:\n    clearState: true\n');
    await writeBlock('keeps.yaml', '- launchApp\n');
    await writeBlock('keeps-explicit.yaml', '- launchApp:\n    clearState: false\n');
    await writeBlock('none.yaml', '- back\n');
    const blocks = (await project()).blocks;
    const cleared = Object.fromEntries(blocks.map((block) => [block.file.replace('blocks/', ''), block.clearsAppData]));
    expect(cleared).toEqual({
      'first.yaml': true,
      'later.yaml': true,
      'keeps.yaml': undefined,
      'keeps-explicit.yaml': undefined,
      'none.yaml': undefined,
    });
    expect(blocks.find((block) => block.file === 'blocks/keeps.yaml')).not.toHaveProperty('clearsAppData');
  });

  it('shows both for a block run with Maestro, from the commands it can read', async () => {
    await writeBlock('maestro.yaml', '- waitForAnimationToEnd\n- launchApp:\n    clearState: true\n- inputText: "${PASSWORD}"\n');
    const [block] = (await project()).blocks;
    expect(block).toMatchObject({ file: 'blocks/maestro.yaml', runsWith: 'maestro', settable: ['PASSWORD'], clearsAppData: true });
  });

  it('shows neither for a file that is not a Maestro flow', async () => {
    await writeBlock('broken.yaml', 'pressKey: Enter\n');
    const [block] = (await project()).blocks;
    expect(block).toEqual({ file: 'blocks/broken.yaml', name: 'broken', error: expect.stringContaining('list of commands') });
  });
});

// The edits of Waldo's test builder on a case that has a block run in the middle.
describe('editing a case with a block step in the middle', () => {
  const MARIA_ENV = { ...PASS_THROUGH, ...AS_MARIA };

  /** Steps: 1 tap, 2 the block as Maria, 3 tap. Evidence step-001 to step-003. */
  async function recordMidCase(): Promise<string> {
    await writeEnv(TEST_USERS);
    await writeBlock('login.yaml', LOGIN);
    await openSession();
    const started = await startCase('Mid block');
    expect(started.status).toBe(200);
    expect((await tapNetwork()).status).toBe(200);
    expect((await call('POST', '/api/case/block', { file: 'blocks/login.yaml', values: AS_MARIA })).status).toBe(200);
    expect((await tapNetwork()).status).toBe(200);
    expect((await call('POST', '/api/case/finish')).status).toBe(200);
    return started.body.caseId as string;
  }

  const MID_SHAPE = ['launchApp', 'tapOn Network & internet', 'runFlow ../blocks/login.yaml', 'tapOn Network & internet'];

  function rows(steps: readonly CaseStep[]): Array<[number, string, string | undefined]> {
    return steps.map((step) => [step.index, step.kind, step.screenshot]);
  }

  it('is recorded as the case file and flow say', async () => {
    const caseId = await recordMidCase();
    const saved = await readCaseFile(caseId);
    expect(rows(saved.steps)).toEqual([
      [1, 'tap', `evidence/${caseId}/step-001.png`],
      [2, 'block', `evidence/${caseId}/step-002.png`],
      [3, 'tap', `evidence/${caseId}/step-003.png`],
    ]);
    const detail = (await call('GET', `/api/cases/${caseId}`)).body as CaseDetailResponse;
    expect(shape(detail.yaml)).toEqual(MID_SHAPE);
    expect(runFlowsIn(detail.yaml)[0]!.env).toEqual(MARIA_ENV);
    expect(detail.case.steps[1]).toMatchObject({ kind: 'block', file: 'blocks/login.yaml', values: AS_MARIA, screenshotUrl: expect.any(String) });
  });

  it('deleting a step before the block moves the block up in the flow', async () => {
    const caseId = await recordMidCase();
    const deleted = await call('DELETE', `/api/cases/${caseId}/steps/1`);
    expect(deleted.status).toBe(200);
    const detail = deleted.body as CaseDetailResponse;
    expect(rows(detail.case.steps as CaseStep[])).toEqual([
      [1, 'block', `evidence/${caseId}/step-002.png`],
      [2, 'tap', `evidence/${caseId}/step-003.png`],
    ]);
    expect(detail.case.steps[0]).toMatchObject({ values: AS_MARIA });
    expect(shape(detail.yaml)).toEqual(['launchApp', 'runFlow ../blocks/login.yaml', 'tapOn Network & internet']);
    expect(runFlowsIn(detail.yaml)[0]!.env).toEqual(MARIA_ENV);
    expect(await readFile(join(dir, 'flows', `${caseId}.yaml`), 'utf8')).toBe(detail.yaml);
    expect(await evidenceFiles(caseId)).toEqual(['step-002.png', 'step-003.png']);
  });

  it('deleting the block step takes its runFlow and its screenshot out, and nothing else', async () => {
    const caseId = await recordMidCase();
    const deleted = await call('DELETE', `/api/cases/${caseId}/steps/2`);
    expect(deleted.status).toBe(200);
    const detail = deleted.body as CaseDetailResponse;
    expect(rows(detail.case.steps as CaseStep[])).toEqual([
      [1, 'tap', `evidence/${caseId}/step-001.png`],
      [2, 'tap', `evidence/${caseId}/step-003.png`],
    ]);
    expect(shape(detail.yaml)).toEqual(['launchApp', 'tapOn Network & internet', 'tapOn Network & internet']);
    expect(detail.case.editedAt).toEqual(expect.any(String));
    expect(await evidenceFiles(caseId)).toEqual(['step-001.png', 'step-003.png']);
  });

  it('deleting a step after the block leaves the runFlow in place', async () => {
    const caseId = await recordMidCase();
    const detail = (await call('DELETE', `/api/cases/${caseId}/steps/3`)).body as CaseDetailResponse;
    expect(shape(detail.yaml)).toEqual(['launchApp', 'tapOn Network & internet', 'runFlow ../blocks/login.yaml']);
    expect(detail.case.steps[1]).toMatchObject({ index: 2, kind: 'block', values: AS_MARIA });
    expect(await evidenceFiles(caseId)).toEqual(['step-001.png', 'step-002.png']);
  });

  it('a title and a note on the block step change neither its values nor the flow', async () => {
    const caseId = await recordMidCase();
    const before = (await call('GET', `/api/cases/${caseId}`)).body as CaseDetailResponse;
    const patched = await call('PATCH', `/api/cases/${caseId}/steps/2`, { title: 'Switch to Maria', note: 'Maria sees her own inbox' });
    expect(patched.status).toBe(200);
    const detail = patched.body as CaseDetailResponse;
    expect(detail.case.steps[1]).toMatchObject({ kind: 'block', title: 'Switch to Maria', note: 'Maria sees her own inbox', values: AS_MARIA });
    expect(detail.yaml).toBe(before.yaml);
    expect(detail.case.editedAt).toBeUndefined();
  });

  it('splitting after the block keeps it in the start case, with its screenshot copied', async () => {
    const caseId = await recordMidCase();
    const split = await call('POST', `/api/cases/${caseId}/split`, { atStep: 2 });
    expect(split.status).toBe(200);
    const detail = split.body as CaseDetailResponse;
    const firstId = detail.parent!.id;

    const first = await readCaseFile(firstId);
    expect(rows(first.steps)).toEqual([
      [1, 'tap', `evidence/${firstId}/step-001.png`],
      [2, 'block', `evidence/${firstId}/step-002.png`],
    ]);
    expect(first.steps[1]).toMatchObject({ file: 'blocks/login.yaml', values: AS_MARIA });
    expect(await evidenceFiles(firstId)).toEqual(['step-001.png', 'step-002.png']);
    const firstYaml = await readFile(join(dir, 'flows', `${firstId}.yaml`), 'utf8');
    expect(shape(firstYaml)).toEqual(['launchApp', 'tapOn Network & internet', 'runFlow ../blocks/login.yaml']);
    expect(runFlowsIn(firstYaml)[0]!.env).toEqual(MARIA_ENV);

    const rest = await readCaseFile(caseId);
    expect(rest.startFrom).toBe(firstId);
    expect(rows(rest.steps)).toEqual([[1, 'tap', `evidence/${caseId}/step-003.png`]]);
    expect(shape(detail.yaml)).toEqual([`runFlow ${firstId}.yaml`, 'tapOn Network & internet']);
  });

  it('splitting before the block puts the block in the case that starts from the first', async () => {
    const caseId = await recordMidCase();
    const split = await call('POST', `/api/cases/${caseId}/split`, { atStep: 1 });
    expect(split.status).toBe(200);
    const detail = split.body as CaseDetailResponse;
    const firstId = detail.parent!.id;

    const first = await readCaseFile(firstId);
    expect(first.steps.map((step) => step.kind)).toEqual(['tap']);
    const firstYaml = await readFile(join(dir, 'flows', `${firstId}.yaml`), 'utf8');
    expect(shape(firstYaml)).toEqual(['launchApp', 'tapOn Network & internet']);

    const rest = await readCaseFile(caseId);
    expect(rows(rest.steps)).toEqual([
      [1, 'block', `evidence/${caseId}/step-002.png`],
      [2, 'tap', `evidence/${caseId}/step-003.png`],
    ]);
    expect(rest.steps[0]).toMatchObject({ values: AS_MARIA });
    // The start case leads with one runFlow; the block step comes right after it.
    expect(shape(detail.yaml)).toEqual([`runFlow ${firstId}.yaml`, 'runFlow ../blocks/login.yaml', 'tapOn Network & internet']);
    expect(runFlowsIn(detail.yaml)[1]!.env).toEqual(MARIA_ENV);
  });

  it('splitting at the block step itself ends the start case with it', async () => {
    const caseId = await recordMidCase();
    const split = await call('POST', `/api/cases/${caseId}/split`, { atStep: 2, name: 'Up to Maria' });
    const detail = split.body as CaseDetailResponse;
    expect(detail.parent).toEqual({ id: expect.any(String), name: 'Up to Maria' });
    expect((await readCaseFile(detail.parent!.id)).steps.at(-1)).toMatchObject({ kind: 'block', values: AS_MARIA });
  });

  it('duplicates the case with the block step, its values and a copy of its screenshot', async () => {
    const caseId = await recordMidCase();
    const original = (await call('GET', `/api/cases/${caseId}`)).body as CaseDetailResponse;
    const copied = await call('POST', `/api/cases/${caseId}/duplicate`);
    expect(copied.status).toBe(200);
    const copy = copied.body as CaseDetailResponse;
    expect(copy.case.id).not.toBe(caseId);
    expect(copy.case.steps[1]).toMatchObject({ kind: 'block', file: 'blocks/login.yaml', values: AS_MARIA, screenshot: `evidence/${copy.case.id}/step-002.png` });
    expect(shape(copy.yaml)).toEqual(MID_SHAPE);
    expect(runFlowsIn(copy.yaml)[0]!.env).toEqual(MARIA_ENV);
    expect(await evidenceFiles(copy.case.id)).toEqual(['step-001.png', 'step-002.png', 'step-003.png']);
    // The original is as it was.
    expect(((await call('GET', `/api/cases/${caseId}`)).body as CaseDetailResponse).yaml).toBe(original.yaml);
    expect(await evidenceFiles(caseId)).toEqual(['step-001.png', 'step-002.png', 'step-003.png']);
  });

  it('inserting before the block replays only what is before it, and the block moves down', async () => {
    const caseId = await recordMidCase();
    const edit = await call('POST', `/api/cases/${caseId}/edit`, { mode: 'insert', after: 1 });
    expect(edit.status).toBe(200);
    const replayed = device.replays.at(-1)!;
    expect(replayed.path).toBe(join(dir, 'runs', '_partial', `${caseId}.yaml`));
    expect(shape(replayed.yaml)).toEqual(['launchApp', 'tapOn Network & internet']);
    expect(existsSync(replayed.path)).toBe(false);
    expect(((await call('GET', '/api/case/current')).body as CurrentCaseView).editing).toEqual({ mode: 'insert', keptSteps: 1, tailSteps: 2 });

    expect((await pressBack()).body.step).toMatchObject({ index: 2, kind: 'back', screenshot: `evidence/${caseId}/step-004.png` });
    const finished = await call('POST', '/api/case/finish');
    expect(finished.status).toBe(200);
    const saved = await readCaseFile(caseId);
    expect(rows(saved.steps)).toEqual([
      [1, 'tap', `evidence/${caseId}/step-001.png`],
      [2, 'back', `evidence/${caseId}/step-004.png`],
      [3, 'block', `evidence/${caseId}/step-002.png`],
      [4, 'tap', `evidence/${caseId}/step-003.png`],
    ]);
    expect(saved.steps[2]).toMatchObject({ file: 'blocks/login.yaml', values: AS_MARIA });
    expect(shape(finished.body.yaml as string)).toEqual(['launchApp', 'tapOn Network & internet', 'back', 'runFlow ../blocks/login.yaml', 'tapOn Network & internet']);
    expect(runFlowsIn(finished.body.yaml as string)[0]!.env).toEqual(MARIA_ENV);
    expect(await evidenceFiles(caseId)).toEqual(['step-001.png', 'step-002.png', 'step-003.png', 'step-004.png']);
  });

  it('inserting after the block replays the block with its values first', async () => {
    const caseId = await recordMidCase();
    expect((await call('POST', `/api/cases/${caseId}/edit`, { mode: 'insert', after: 2 })).status).toBe(200);
    const replayed = device.replays.at(-1)!;
    expect(shape(replayed.yaml)).toEqual(['launchApp', 'tapOn Network & internet', 'runFlow ../../blocks/login.yaml']);
    expect(runFlowsIn(replayed.yaml)[0]!.env).toEqual(MARIA_ENV);
    expect(((await call('GET', '/api/case/current')).body as CurrentCaseView).steps.map((step) => step.kind)).toEqual(['tap', 'block']);

    await pressBack();
    const finished = await call('POST', '/api/case/finish');
    expect(shape(finished.body.yaml as string)).toEqual(['launchApp', 'tapOn Network & internet', 'runFlow ../blocks/login.yaml', 'back', 'tapOn Network & internet']);
    expect((await readCaseFile(caseId)).steps.map((step) => step.kind)).toEqual(['tap', 'block', 'back', 'tap']);
  });

  it('inserting at the very start keeps the block in the tail', async () => {
    const caseId = await recordMidCase();
    expect((await call('POST', `/api/cases/${caseId}/edit`, { mode: 'insert', after: 0 })).status).toBe(200);
    expect(shape(device.replays.at(-1)!.yaml)).toEqual(['launchApp']);
    expect(((await call('GET', '/api/case/current')).body as CurrentCaseView).editing).toEqual({ mode: 'insert', keptSteps: 0, tailSteps: 3 });
    const finished = await call('POST', '/api/case/finish');
    expect(shape(finished.body.yaml as string)).toEqual(MID_SHAPE);
  });

  it('re-recording from a step after the block replays the block, then replaces the rest', async () => {
    const caseId = await recordMidCase();
    expect((await call('POST', `/api/cases/${caseId}/edit`, { mode: 'rerecord', step: 3 })).status).toBe(200);
    const replayed = device.replays.at(-1)!;
    expect(shape(replayed.yaml)).toEqual(['launchApp', 'tapOn Network & internet', 'runFlow ../../blocks/login.yaml']);
    expect(runFlowsIn(replayed.yaml)[0]!.env).toEqual(MARIA_ENV);
    await pressBack();
    const finished = await call('POST', '/api/case/finish');
    const saved = await readCaseFile(caseId);
    expect(rows(saved.steps)).toEqual([
      [1, 'tap', `evidence/${caseId}/step-001.png`],
      [2, 'block', `evidence/${caseId}/step-002.png`],
      [3, 'back', `evidence/${caseId}/step-004.png`],
    ]);
    expect(saved.steps[1]).toMatchObject({ values: AS_MARIA });
    expect(shape(finished.body.yaml as string)).toEqual(['launchApp', 'tapOn Network & internet', 'runFlow ../blocks/login.yaml', 'back']);
    // The replaced step's screenshot goes; the block's stays.
    expect(await evidenceFiles(caseId)).toEqual(['step-001.png', 'step-002.png', 'step-004.png']);
  });

  it('re-recording from the block step replaces the block', async () => {
    const caseId = await recordMidCase();
    expect((await call('POST', `/api/cases/${caseId}/edit`, { mode: 'rerecord', step: 2 })).status).toBe(200);
    expect(shape(device.replays.at(-1)!.yaml)).toEqual(['launchApp', 'tapOn Network & internet']);
    await pressBack();
    const finished = await call('POST', '/api/case/finish');
    expect((await readCaseFile(caseId)).steps.map((step) => step.kind)).toEqual(['tap', 'back']);
    expect(shape(finished.body.yaml as string)).toEqual(['launchApp', 'tapOn Network & internet', 'back']);
    expect(await evidenceFiles(caseId)).toEqual(['step-001.png', 'step-004.png']);
  });

  it('a block can be added in the middle of an edit, too', async () => {
    const caseId = await recordMidCase();
    expect((await call('POST', `/api/cases/${caseId}/edit`, { mode: 'insert', after: 1 })).status).toBe(200);
    const added = await call('POST', '/api/case/block', { file: 'blocks/login.yaml', values: AS_SUPERVISOR });
    expect(added.status).toBe(200);
    expect(added.body.step).toMatchObject({ index: 2, kind: 'block', screenshot: `evidence/${caseId}/step-004.png` });
    const finished = await call('POST', '/api/case/finish');
    const saved = await readCaseFile(caseId);
    expect(saved.steps.map((step) => [step.index, step.kind])).toEqual([[1, 'tap'], [2, 'block'], [3, 'block'], [4, 'tap']]);
    expect(runFlowsIn(finished.body.yaml as string).map((step) => step.env)).toEqual([
      { ...PASS_THROUGH, ...AS_SUPERVISOR },
      MARIA_ENV,
    ]);
  });

  it('discarding an edit leaves the block step as it was saved', async () => {
    const caseId = await recordMidCase();
    const before = await readCaseFile(caseId);
    expect((await call('POST', `/api/cases/${caseId}/edit`, { mode: 'insert', after: 1 })).status).toBe(200);
    await call('POST', '/api/case/block', { file: 'blocks/login.yaml', values: AS_SUPERVISOR });
    const discarded = await call('POST', '/api/case/discard');
    expect(discarded.body).toMatchObject({ ok: true, restored: true });
    expect(await readCaseFile(caseId)).toEqual(before);
    expect(await evidenceFiles(caseId)).toEqual(['step-001.png', 'step-002.png', 'step-003.png']);
  });

  it('keeps the values of the blocks before the case through duplicate, edit and split', async () => {
    await writeEnv(TEST_USERS);
    await writeBlock('login.yaml', LOGIN);
    await openSession();
    const started = await startCase('Both kinds', [{ file: 'blocks/login.yaml', values: AS_SUPERVISOR }]);
    const caseId = started.body.caseId as string;
    await tapNetwork();
    await call('POST', '/api/case/block', { file: 'blocks/login.yaml', values: AS_MARIA });
    await tapNetwork();
    expect((await call('POST', '/api/case/finish')).status).toBe(200);
    const lead = [{ file: 'blocks/login.yaml', values: AS_SUPERVISOR }];
    const SUPERVISOR_ENV = { ...PASS_THROUGH, ...AS_SUPERVISOR };
    const BOTH = ['launchApp', 'runFlow ../blocks/login.yaml', 'tapOn Network & internet', 'runFlow ../blocks/login.yaml', 'tapOn Network & internet'];

    const copy = (await call('POST', `/api/cases/${caseId}/duplicate`)).body as CaseDetailResponse;
    expect(copy.case.preconditionBlocks).toEqual(lead);
    expect(shape(copy.yaml)).toEqual(BOTH);
    expect(runFlowsIn(copy.yaml).map((step) => step.env)).toEqual([SUPERVISOR_ENV, MARIA_ENV]);

    // Opening the case for an edit replays its blocks with their values, and keeps them.
    expect((await call('POST', `/api/cases/${caseId}/edit`, { mode: 'insert', after: 2 })).status).toBe(200);
    expect(runFlowsIn(device.replays.at(-1)!.yaml).map((step) => step.env)).toEqual([SUPERVISOR_ENV, MARIA_ENV]);
    expect(((await call('GET', '/api/case/current')).body as CurrentCaseView).preconditionBlocks).toEqual(lead);
    expect((await call('POST', '/api/case/finish')).status).toBe(200);
    expect((await readCaseFile(caseId)).preconditionBlocks).toEqual(lead);

    // The start case of a split keeps the blocks and their values; the rest runs them through it.
    const split = (await call('POST', `/api/cases/${caseId}/split`, { atStep: 2 })).body as CaseDetailResponse;
    const first = await readCaseFile(split.parent!.id);
    expect(first.preconditionBlocks).toEqual(lead);
    const firstYaml = await readFile(join(dir, 'flows', `${first.id}.yaml`), 'utf8');
    expect(runFlowsIn(firstYaml).map((step) => step.env)).toEqual([SUPERVISOR_ENV, MARIA_ENV]);
    expect((await readCaseFile(caseId)).preconditionBlocks).toEqual([]);
  });

  it('exports the block step with the user it runs as', async () => {
    const caseId = await recordMidCase();
    await call('PATCH', `/api/cases/${caseId}/steps/3`, { title: 'Open the network page again' });
    const exported = await call('GET', `/api/cases/${caseId}/export?format=md`);
    expect(exported.status).toBe(200);
    const text = exported.body as string;
    expect(text).toContain('Run the block blocks/login.yaml as Agent Maria');
    expect(text).toContain('Open the network page again');
    for (const secret of Object.values(TEST_USERS)) expect(text).not.toContain(secret);
  });
});

describe('case files from before blocks had values', () => {
  async function writeOldCase(): Promise<string> {
    const id = 'old-case-20261001-0900';
    const old = {
      id,
      name: 'Old case',
      appId: APP,
      createdAt: '2026-10-01T09:00:00.000Z',
      deviceId: DEVICE,
      preconditionBlocks: ['blocks/second.yaml'],
      steps: [{ index: 1, kind: 'tap', selector: { kind: 'text', value: 'Network & internet' }, point: { x: 1, y: 2 }, at: '2026-10-01T09:00:00.000Z' }],
      expectations: [],
    };
    await writeFile(join(dir, 'cases', `${id}.json`), `${JSON.stringify(old, null, 2)}\n`);
    return id;
  }

  it('shows the bare paths as blocks, and saves them as blocks when the case is edited', async () => {
    await writeBlock('second.yaml', '- back\n');
    const id = await writeOldCase();
    const detail = (await call('GET', `/api/cases/${id}`)).body as CaseDetailResponse;
    expect(detail.case.preconditionBlocks).toEqual([{ file: 'blocks/second.yaml' }]);

    const patched = await call('PATCH', `/api/cases/${id}`, { name: 'Old case, renamed' });
    expect(patched.status).toBe(200);
    expect((await readCaseFile(id)).preconditionBlocks).toStrictEqual([{ file: 'blocks/second.yaml' }]);
    expect(shape((patched.body as CaseDetailResponse).yaml)).toEqual(['launchApp', 'runFlow ../blocks/second.yaml', 'tapOn Network & internet']);
  });

  it('keeps the blocks when the case is opened for an insert and finished', async () => {
    await writeBlock('second.yaml', '- back\n');
    const id = await writeOldCase();
    await openSession();
    expect((await call('POST', `/api/cases/${id}/edit`, { mode: 'insert', after: 1 })).status).toBe(200);
    await pressBack();
    const finished = await call('POST', '/api/case/finish');
    expect(finished.status).toBe(200);
    expect((await readCaseFile(id)).preconditionBlocks).toStrictEqual([{ file: 'blocks/second.yaml' }]);
    expect(shape(finished.body.yaml as string)).toEqual(['launchApp', 'runFlow ../blocks/second.yaml', 'tapOn Network & internet', 'back']);
  });

  it('can be split and duplicated', async () => {
    await writeBlock('second.yaml', '- back\n');
    const id = await writeOldCase();
    const copy = (await call('POST', `/api/cases/${id}/duplicate`)).body as CaseDetailResponse;
    expect(copy.case.preconditionBlocks).toEqual([{ file: 'blocks/second.yaml' }]);
    const split = (await call('POST', `/api/cases/${id}/split`, { atStep: 1 })).body as CaseDetailResponse;
    expect((await readCaseFile(split.parent!.id)).preconditionBlocks).toStrictEqual([{ file: 'blocks/second.yaml' }]);
  });
});
