import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError, type DeviceSnapshot, type MaestroRunner, type OpenOptions, type Point } from '@ariadne/core';
import { buildServer } from '../src/server/index.ts';
import type { DeviceLike } from '../src/server/state.ts';

// A real commands.json from a failing Maestro run: launchApp and a tap pass,
// the assertVisible after them fails, and the back after that never runs.
const FAILING_RUN = new URL('../../../packages/core/test/fixtures/maestro-commands-fail.json', import.meta.url);
const FAILURE_SHOT = 'screenshots/step-005-assertCondition-This_text_does_not_exist.png';

type Node = DeviceSnapshot['nodes'][number];

// Smallest valid PNG (1x1), so the image routes have something to stream.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

function row(index: number, y: number, title: string, extra: Partial<Node> = {}): Node[] {
  return [
    { index, depth: 1, rect: { x: 0, y, width: 1080, height: 200 }, hittable: true },
    { index: index + 1, depth: 2, parentIndex: index, rect: { x: 200, y: y + 40, width: 400, height: 70 }, label: title, identifier: 'android:id/title', ...extra },
  ];
}

const screens: Record<string, Node[]> = {
  home: [...row(0, 400, 'Network & internet'), ...row(2, 600, 'Connected devices')],
  network: [...row(0, 400, 'Internet'), ...row(2, 600, 'SIMs')],
  login: [{ index: 0, depth: 1, rect: { x: 0, y: 400, width: 1080, height: 150 }, label: 'Password', password: true, focused: true, editable: true }],
};

/** In-memory stand-in for DeviceSession: tapping a title opens a fixed next screen. */
class FakeDevice implements DeviceLike {
  screen = 'home';
  target: { deviceId: string; appId: string } | undefined;
  taps: Point[] = [];
  typed: string[] = [];
  scrolls: string[] = [];
  replays: Array<{ path: string; env: Record<string, string> }> = [];
  failNextTap = false;

  get isOpen() { return this.target !== undefined; }
  get deviceId() { return this.target?.deviceId; }
  get appId() { return this.target?.appId; }

  async listDevices() {
    return [{ id: 'emulator-5556', name: 'Pixel', platform: 'android', kind: 'emulator', booted: true }];
  }
  async open(options: OpenOptions) {
    this.target = { deviceId: options.deviceId, appId: options.appId };
  }
  async relaunchApp() {
    this.screen = 'home';
  }
  async snapshot(): Promise<DeviceSnapshot> {
    return { nodes: screens[this.screen]!, viewport: { width: 1080, height: 2400 }, takenAt: new Date().toISOString() };
  }
  async capture(screenshotPath: string) {
    mkdirSync(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, PNG);
    return { ...(await this.snapshot()), screenshotPath };
  }
  async tapAt(point: Point) {
    if (this.failNextTap) {
      this.failNextTap = false;
      throw Object.assign(new Error('Device went away'), { code: 'COMMAND_FAILED' });
    }
    this.taps.push(point);
    if (this.screen === 'home' && point.y < 600) this.screen = 'network';
  }
  async typeText(text: string) {
    this.typed.push(text);
  }
  async back() {
    this.screen = 'home';
  }
  async scroll(direction: 'down' | 'up') {
    this.scrolls.push(direction);
  }
  links: string[] = [];
  keyboardHidden = 0;
  async openLink(url: string) {
    this.links.push(url);
  }
  async hideKeyboard() {
    this.keyboardHidden++;
  }
  /** Gestures, keys and rotations, in order, as "longPress 540,500" or "key home". */
  gestures: string[] = [];
  landscape = false;
  async longPressAt(point: Point) {
    this.gestures.push(`longPress ${point.x},${point.y}`);
  }
  async doubleTapAt(point: Point) {
    this.gestures.push(`doubleTap ${point.x},${point.y}`);
  }
  async swipe(from: Point, to: Point, durationMs: number) {
    this.gestures.push(`swipe ${from.x},${from.y} ${to.x},${to.y} ${durationMs}`);
  }
  async pinch(scale: number) {
    this.gestures.push(`pinch ${scale}`);
  }
  async pressKey(key: string) {
    this.gestures.push(`key ${key}`);
  }
  async setOrientation(value: 'portrait' | 'landscape') {
    this.gestures.push(`orientation ${value}`);
    this.landscape = value === 'landscape';
  }
  async replayFlow(path: string, env: Readonly<Record<string, string>>) {
    this.replays.push({ path, env: { ...env } });
    if (path.endsWith('bad.yaml')) {
      this.screen = 'login';
      throw new AppError('REPLAY_DIVERGENCE', 'Replay failed at step 2 (assertVisible "Nope"): Maestro visible condition did not match.');
    }
    if (path.endsWith('open-settings.yaml')) this.screen = 'network';
    return { replayed: 3 };
  }
  async close() {
    this.target = undefined;
  }
}

let dir: string;
let device: FakeDevice;
let app: FastifyInstance;
let runMaestro: MaestroRunner;

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) {
  const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
  return { status: response.statusCode, body: response.headers['content-type']?.includes('json') ? response.json() : response.body };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ariadne-studio-test-'));
  device = new FakeDevice();
  runMaestro = async () => {
    throw new Error('Maestro was not expected to run in this test');
  };
  app = await buildServer({
    projectDir: dir,
    session: device,
    maestro: { run: (options) => runMaestro(options), findBin: () => '/opt/maestro/bin/maestro', androidHome: () => undefined },
  });
});

async function openAndStart(name: string, blocks?: string[]) {
  await call('POST', '/api/session/open', { deviceId: 'emulator-5556', appId: 'com.android.settings' });
  const started = await call('POST', '/api/case/start', { name, ...(blocks ? { blocks } : {}) });
  expect(started.status).toBe(200);
  return started.body.caseId as string;
}

async function writeBlock(file: string, body: string) {
  await mkdir(join(dir, 'blocks'), { recursive: true });
  await writeFile(join(dir, 'blocks', file), `appId: com.android.settings\n---\n${body}`);
}

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('studio server', () => {
  it('records a case of three taps and a back into flow, case and evidence files', async () => {
    expect((await call('GET', '/api/devices')).body).toEqual([
      { id: 'emulator-5556', name: 'Pixel', platform: 'android', kind: 'emulator', booted: true },
    ]);
    const opened = await call('POST', '/api/session/open', { deviceId: 'emulator-5556', appId: 'com.android.settings' });
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ width: 1080, height: 2400 });
    expect((await call('GET', '/api/project')).body).toMatchObject({ appId: 'com.android.settings', lastDeviceId: 'emulator-5556' });

    const started = await call('POST', '/api/case/start', { name: 'Open network' });
    expect(started.status).toBe(200);
    const caseId: string = started.body.caseId;

    // Tap the blank right side of the first row: the row resolves to its title.
    const first = await call('POST', '/api/action/tap', { x: 1000, y: 500 });
    expect(first.body.step).toMatchObject({ index: 1, kind: 'tap', selector: { kind: 'text', value: 'Network & internet' } });
    expect(first.body.resolved).toMatchObject({ hittable: true });
    expect(device.taps[0]).toEqual({ x: 540, y: 500 });
    const second = await call('POST', '/api/action/tap', { x: 300, y: 475 });
    expect(second.body.step.selector).toEqual({ kind: 'text', value: 'Internet' });
    const back = await call('POST', '/api/action/back');
    expect(back.body.step).toMatchObject({ index: 3, kind: 'back' });
    const third = await call('POST', '/api/action/tap', { x: 300, y: 675 });
    expect(third.body.step.selector).toEqual({ kind: 'text', value: 'Connected devices' });

    const current = await call('GET', '/api/case/current');
    expect(current.body.steps).toHaveLength(4);
    const shot = await app.inject({ method: 'GET', url: current.body.steps[0].screenshotUrl });
    expect(shot.statusCode).toBe(200);
    expect(shot.headers['content-type']).toBe('image/png');

    const finished = await call('POST', '/api/case/finish');
    expect(finished.body).toMatchObject({ caseId, flowFile: `flows/${caseId}.yaml` });
    expect(await readFile(join(dir, 'flows', `${caseId}.yaml`), 'utf8')).toBe(
      [
        'appId: com.android.settings',
        'name: Open network',
        '---',
        '- launchApp',
        '- tapOn:',
        '    text: "Network & internet"',
        '- tapOn:',
        '    text: "Internet"',
        '- back',
        '- tapOn:',
        '    text: "Connected devices"',
        '',
      ].join('\n'),
    );
    const saved = JSON.parse(await readFile(join(dir, 'cases', `${caseId}.json`), 'utf8'));
    expect(saved.steps).toHaveLength(4);
    expect((await readdir(join(dir, 'evidence', caseId))).sort()).toEqual([
      'step-001.png',
      'step-002.png',
      'step-003.png',
      'step-004.png',
    ]);
    expect((await call('GET', '/api/case/current')).body).toBeNull();
    expect((await call('GET', '/api/project')).body.cases).toEqual([
      expect.objectContaining({ id: caseId, stepCount: 4 }),
    ]);
  });

  it('serves the latest screen without recording when no case is active', async () => {
    await call('POST', '/api/session/open', { deviceId: 'emulator-5556', appId: 'com.android.settings' });
    const tapped = await call('POST', '/api/action/tap', { x: 300, y: 475 });
    expect(tapped.body.step).toBeUndefined();
    expect(tapped.body.screen.nodes.map((node: { label?: string }) => node.label).filter(Boolean)).toEqual(['Internet', 'SIMs']);
    const image = await app.inject({ method: 'GET', url: '/api/screen/image?ts=1' });
    expect(image.statusCode).toBe(200);
  });

  it('answers client mistakes with 4xx codes', async () => {
    expect(await call('POST', '/api/action/tap', { x: 1, y: 1 })).toMatchObject({ status: 409, body: { error: { code: 'NO_SESSION' } } });
    expect(await call('POST', '/api/case/finish')).toMatchObject({ status: 409, body: { error: { code: 'NO_CASE' } } });
    await call('POST', '/api/session/open', { deviceId: 'emulator-5556', appId: 'com.android.settings' });
    expect((await call('POST', '/api/action/tap', { x: 'a' })).status).toBe(400);
    expect((await call('POST', '/api/case/start', { name: ' ' })).status).toBe(400);
    expect((await call('GET', '/api/evidence/..%2Fx/step-001.png')).status).toBe(400);
  });

  it('refuses to record typing into a password field', async () => {
    await call('POST', '/api/session/open', { deviceId: 'emulator-5556', appId: 'com.example' });
    await call('POST', '/api/case/start', { name: 'Login' });
    device.screen = 'login';
    await call('POST', '/api/action/back'); // capture the login screen as latest
    device.screen = 'login';
    await call('POST', '/api/action/tap', { x: 500, y: 450 });
    const typed = await call('POST', '/api/action/type', { text: 'hunter2' });
    expect(typed).toMatchObject({ status: 400, body: { error: { code: 'PASSWORD_FIELD' } } });
    expect(device.typed).toEqual([]);
  });

  it('merges consecutive typing and passes device errors through as 5xx', async () => {
    await call('POST', '/api/session/open', { deviceId: 'emulator-5556', appId: 'com.example' });
    await call('POST', '/api/case/start', { name: 'Search' });
    await call('POST', '/api/action/type', { text: 'wi' });
    const merged = await call('POST', '/api/action/type', { text: 'fi' });
    expect(merged.body.step).toMatchObject({ index: 1, kind: 'type', text: 'wifi' });
    device.failNextTap = true;
    const failed = await call('POST', '/api/action/tap', { x: 300, y: 475 });
    expect(failed.status).toBe(502);
    expect(failed.body.error.message).toContain('Device went away');
    const discarded = await call('POST', '/api/case/discard');
    expect(discarded.status).toBe(200);
  });

  it('runs ticked blocks in order before recording, and refuses unknown or broken ones', async () => {
    await writeBlock('open-settings.yaml', '- launchApp\n- tapOn: "Network & internet"\n');
    await writeBlock('second.yaml', '- back\n');
    // Not a list of commands, so not a Maestro flow at all.
    await writeBlock('broken.yaml', 'pressKey: Enter\n');
    await writeFile(join(dir, '.env'), 'USERNAME=ba@example.com\n');
    await call('POST', '/api/session/open', { deviceId: 'emulator-5556', appId: 'com.android.settings' });

    expect(await call('POST', '/api/case/start', { name: 'X', blocks: ['blocks/missing.yaml'] })).toMatchObject({
      status: 400,
      body: { error: { code: 'UNKNOWN_BLOCK' } },
    });
    expect(await call('POST', '/api/case/start', { name: 'X', blocks: ['blocks/broken.yaml'] })).toMatchObject({
      status: 400,
      body: { error: { code: 'UNKNOWN_BLOCK', message: expect.stringContaining('list of commands') } },
    });
    expect((await call('POST', '/api/case/start', { name: 'X', blocks: 'blocks/second.yaml' })).status).toBe(400);
    expect(device.replays).toEqual([]);

    const started = await call('POST', '/api/case/start', { name: 'With blocks', blocks: ['blocks/second.yaml', 'blocks/open-settings.yaml'] });
    expect(started.status).toBe(200);
    expect(device.replays).toEqual([
      { path: join(dir, 'blocks', 'second.yaml'), env: { USERNAME: 'ba@example.com' } },
      { path: join(dir, 'blocks', 'open-settings.yaml'), env: { USERNAME: 'ba@example.com' } },
    ]);
    // The recording starts on the screen the last block ended on.
    expect(started.body.screen.nodes.map((node: { label?: string }) => node.label).filter(Boolean)).toEqual(['Internet', 'SIMs']);
    const finished = await call('POST', '/api/case/finish');
    expect(finished.body.yaml).toBe(
      [
        'appId: com.android.settings',
        'name: With blocks',
        '---',
        '- launchApp',
        '- runFlow:',
        '    file: ../blocks/second.yaml',
        '    env:',
        '      USERNAME: "${USERNAME}"',
        '- runFlow:',
        '    file: ../blocks/open-settings.yaml',
        '    env:',
        '      USERNAME: "${USERNAME}"',
        '',
      ].join('\n'),
    );
  });

  describe('GET /api/project blocks', () => {
    const LOGIN = [
      '- launchApp:',
      '    clearState: true',
      '- tapOn: "Log in"',
      '- tapOn:',
      '    id: com.android.settings:id/user_name',
      '- inputText: "${USERNAME}"',
      '- inputText: "${PASSWORD}"',
      '- hideKeyboard',
      '- tapOn: "Sign in"',
      '- assertVisible: "Welcome"',
      '',
    ].join('\n');

    async function blocksOf() {
      const response = await call('GET', '/api/project');
      expect(response.status).toBe(200);
      return response.body.blocks as Array<Record<string, unknown>>;
    }

    it('describes the steps, lists the variables and names the ones .env does not set', async () => {
      await writeBlock('login.yaml', LOGIN);
      await writeFile(join(dir, '.env'), 'USERNAME=ba@example.com\n');
      expect(await blocksOf()).toEqual([
        {
          file: 'blocks/login.yaml',
          name: 'login',
          stepCount: 8,
          steps: [
            'Start the app with its data cleared',
            'Tap "Log in"',
            'Tap the user name element',
            'Type the USERNAME value from .env',
            'Type the PASSWORD value from .env',
            'Hide the keyboard',
            'Tap "Sign in"',
            'Check that "Welcome" is visible',
          ],
          variables: ['PASSWORD', 'USERNAME'],
          missingVariables: ['PASSWORD'],
          settable: ['PASSWORD', 'USERNAME'],
          clearsAppData: true,
          runsWith: 'agent-device',
        },
      ]);
    });

    it('never sends a variable value to the UI', async () => {
      await writeBlock('login.yaml', LOGIN);
      await writeFile(join(dir, '.env'), 'USERNAME=ba@example.com\nPASSWORD=hunter2\n');
      const response = await app.inject({ method: 'GET', url: '/api/project' });
      expect(response.body).not.toContain('hunter2');
      expect(response.body).not.toContain('ba@example.com');
    });

    it('reports every variable as missing when there is no .env', async () => {
      await writeBlock('login.yaml', LOGIN);
      const [block] = await blocksOf();
      expect(block).toMatchObject({ variables: ['PASSWORD', 'USERNAME'], missingVariables: ['PASSWORD', 'USERNAME'] });
    });

    it('leaves out missingVariables once .env sets everything, and both fields for a block with none', async () => {
      await writeBlock('login.yaml', LOGIN);
      await writeBlock('plain.yaml', '- launchApp\n- back\n');
      await writeFile(join(dir, '.env'), 'USERNAME=ba@example.com\nPASSWORD=hunter2\n');
      const blocks = await blocksOf();
      expect(blocks.map((block) => block.file)).toEqual(['blocks/login.yaml', 'blocks/plain.yaml']);
      expect(blocks[0]).toMatchObject({ variables: ['PASSWORD', 'USERNAME'] });
      expect(blocks[0]).not.toHaveProperty('missingVariables');
      expect(blocks[1]).toEqual({ file: 'blocks/plain.yaml', name: 'plain', stepCount: 2, steps: ['Start the app', 'Press Back'], runsWith: 'agent-device' });
    });

    it('counts a variable as set by .env, by project.json env or by the block header env', async () => {
      await mkdir(join(dir, 'blocks'), { recursive: true });
      await writeFile(
        join(dir, 'blocks', 'three-sources.yaml'),
        [
          'appId: com.android.settings',
          'env:',
          '  FROM_HEADER: fallback',
          '---',
          '- inputText: "${FROM_ENV}"',
          '- inputText: "${FROM_PROJECT_JSON}"',
          '- inputText: "${FROM_HEADER}"',
          '- inputText: "${NOWHERE}"',
          '',
        ].join('\n'),
      );
      await writeFile(join(dir, '.env'), 'FROM_ENV=1\n');
      await writeFile(join(dir, 'project.json'), `${JSON.stringify({ appId: 'com.android.settings', platform: 'android', env: { FROM_PROJECT_JSON: '2' } })}\n`);
      const [block] = await blocksOf();
      expect(block).toMatchObject({
        variables: ['FROM_ENV', 'FROM_HEADER', 'FROM_PROJECT_JSON', 'NOWHERE'],
        missingVariables: ['NOWHERE'],
      });
    });

    it('does not treat ${output.id} style expressions as variables', async () => {
      await writeBlock('expr.yaml', ['- inputText: "${output.id}"', '- inputText: "${PASSWORD}"', ''].join('\n'));
      const [block] = await blocksOf();
      expect(block).toMatchObject({ variables: ['PASSWORD'], missingVariables: ['PASSWORD'] });
    });

    it('lists a block outside the supported Maestro subset as run with Maestro, with the steps it can describe', async () => {
      await writeBlock('maestro.yaml', '- waitForAnimationToEnd\n- inputText: "${PASSWORD}"\n');
      const [block] = await blocksOf();
      expect(block).toEqual({
        file: 'blocks/maestro.yaml',
        name: 'maestro',
        stepCount: 2,
        steps: ['waitForAnimationToEnd (runs in Maestro)', 'Type the PASSWORD value from .env'],
        variables: ['PASSWORD'],
        missingVariables: ['PASSWORD'],
        settable: ['PASSWORD'],
        runsWith: 'maestro',
        maestroOnly: ['waitForAnimationToEnd'],
      });
    });

    it('shows the error and no steps or variables for a file that is not a Maestro flow', async () => {
      await writeBlock('broken.yaml', 'pressKey: Enter\n');
      const [block] = await blocksOf();
      expect(block).toEqual({ file: 'blocks/broken.yaml', name: 'broken', error: expect.stringContaining('list of commands') });
    });

    it('uses the name from the block header', async () => {
      await mkdir(join(dir, 'blocks'), { recursive: true });
      await writeFile(join(dir, 'blocks', 'a.yaml'), 'appId: com.android.settings\nname: Log in as BA\n---\n- launchApp\n');
      const [block] = await blocksOf();
      expect(block).toMatchObject({ file: 'blocks/a.yaml', name: 'Log in as BA', steps: ['Start the app'] });
    });
  });

  it('reports a failing block as 502, shows where it stopped and starts no case', async () => {
    await writeBlock('bad.yaml', '- launchApp\n- assertVisible: "Nope"\n');
    await call('POST', '/api/session/open', { deviceId: 'emulator-5556', appId: 'com.android.settings' });
    const failed = await call('POST', '/api/case/start', { name: 'Broken', blocks: ['blocks/bad.yaml'] });
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('REPLAY_DIVERGENCE');
    expect(failed.body.error.message).toMatch(/^Block blocks\/bad\.yaml failed: Replay failed at step 2/);
    expect((await call('GET', '/api/case/current')).body).toBeNull();
    const screen = await call('GET', '/api/screen');
    expect(screen.body.nodes[0]).toMatchObject({ label: 'Password' });
    expect(await readdir(join(dir, 'cases'))).toEqual([]);
  });

  it('records typed text that equals an env value as its ${KEY}, and types the real text', async () => {
    await writeFile(join(dir, '.env'), 'USERNAME=ba@example.com\nPASSWORD=hunter2\n');
    const caseId = await openAndStart('Login');
    const user = await call('POST', '/api/action/type', { text: 'ba@example.com' });
    expect(user.body.step).toMatchObject({ index: 1, kind: 'type', text: '${USERNAME}' });
    device.screen = 'login';
    await call('POST', '/api/action/back'); // capture the login screen, focused password field
    device.screen = 'login';
    const password = await call('POST', '/api/action/type', { text: 'hunter2' });
    expect(password.status).toBe(200);
    expect(password.body.step).toMatchObject({ index: 3, kind: 'type', text: '${PASSWORD}' });
    // Anything else in a password field is refused and never reaches the device.
    const refused = await call('POST', '/api/action/type', { text: 'hunter3' });
    expect(refused).toMatchObject({ status: 400, body: { error: { code: 'PASSWORD_FIELD' } } });
    expect(refused.body.error.message).toContain(join(dir, '.env'));
    expect(device.typed).toEqual(['ba@example.com', 'hunter2']);
    await call('POST', '/api/case/finish');
    const caseJson = await readFile(join(dir, 'cases', `${caseId}.json`), 'utf8');
    const yaml = await readFile(join(dir, 'flows', `${caseId}.yaml`), 'utf8');
    for (const text of [caseJson, yaml]) {
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('ba@example.com');
    }
    expect(yaml).toContain('- inputText: "${PASSWORD}"');
  });

  it('records an inline expect without touching the device', async () => {
    const caseId = await openAndStart('Expect');
    const expected = await call('POST', '/api/case/expect', { x: 300, y: 475 });
    expect(expected.status).toBe(200);
    expect(expected.body.step).toMatchObject({
      index: 1,
      kind: 'expect',
      selector: { kind: 'text', value: 'Network & internet' },
      screenshot: `evidence/${caseId}/step-001.png`,
    });
    expect(expected.body.resolved).toMatchObject({ label: 'Network & internet' });
    expect(device.taps).toEqual([]);
    expect(existsSync(join(dir, 'evidence', caseId, 'step-001.png'))).toBe(true);
    expect(await call('POST', '/api/case/expect', { x: 10, y: 10 })).toMatchObject({
      status: 400,
      body: { error: { code: 'NO_ELEMENT', message: 'Nothing with a name or id here. Click on a text or a control.' } },
    });
    const finished = await call('POST', '/api/case/finish');
    expect(finished.body.yaml).toContain('- assertVisible:\n    text: "Network & internet"\n');
    expect((await call('POST', '/api/case/expect', { x: 300, y: 475 })).status).toBe(409);
  });

  it('records scrolls and refuses an unknown direction', async () => {
    await openAndStart('Scroll');
    const down = await call('POST', '/api/action/scroll', { direction: 'down' });
    expect(down.body.step).toMatchObject({ index: 1, kind: 'scroll', direction: 'down' });
    await call('POST', '/api/action/scroll', { direction: 'up' });
    expect(device.scrolls).toEqual(['down', 'up']);
    expect((await call('POST', '/api/action/scroll', { direction: 'left' })).status).toBe(400);
    const finished = await call('POST', '/api/case/finish');
    expect(finished.body.yaml).toContain('- scroll\n- swipe:\n    direction: DOWN\n');
  });

  it('offers expectation candidates and appends the picked ones on finish', async () => {
    const caseId = await openAndStart('Pick');
    await call('POST', '/api/action/tap', { x: 1000, y: 500 });
    const listed = await call('GET', '/api/case/candidates');
    expect(listed.body.candidates.map(({ id, label }: { id: number; label: string }) => ({ id, label }))).toEqual([
      { id: 0, label: 'Internet' },
      { id: 1, label: 'SIMs' },
    ]);
    expect(await call('POST', '/api/case/finish', { picks: [2] })).toMatchObject({ status: 400, body: { error: { code: 'BAD_PICK' } } });
    expect((await call('GET', '/api/case/current')).body).not.toBeNull();
    const finished = await call('POST', '/api/case/finish', { picks: [1] });
    expect(finished.status).toBe(200);
    expect(finished.body.yaml.endsWith('- assertVisible:\n    text: "SIMs"\n')).toBe(true);
    const saved = JSON.parse(await readFile(join(dir, 'cases', `${caseId}.json`), 'utf8'));
    expect(saved.expectations).toEqual([
      expect.objectContaining({ selector: { kind: 'text', value: 'SIMs' }, node: expect.objectContaining({ label: 'SIMs' }) }),
    ]);
  });

  it('replays a saved case with Maestro, records the result and reopens the session', async () => {
    await writeFile(join(dir, '.env'), 'PASSWORD=hunter2\n');
    const caseId = await openAndStart('Fail check');
    await call('POST', '/api/action/tap', { x: 1000, y: 500 });
    await call('POST', '/api/case/expect', { x: 300, y: 475 });
    await call('POST', '/api/action/back');
    expect((await call('POST', `/api/cases/${caseId}/replay`)).status).toBe(409); // still recording
    const finished = await call('POST', '/api/case/finish');
    // A hand edit to the flow file does not survive: Maestro runs what the case JSON says.
    const flowFile = join(dir, 'flows', `${caseId}.yaml`);
    await writeFile(flowFile, 'appId: edited.by.hand\n---\n- back\n');

    let sessionOpenDuringRun: boolean | undefined;
    let flowAtRun: string | undefined;
    const calls: Parameters<MaestroRunner>[0][] = [];
    runMaestro = async (options) => {
      calls.push(options);
      sessionOpenDuringRun = device.isOpen;
      flowAtRun = await readFile(options.flowPath, 'utf8');
      const flowDir = join(options.debugDir, 'Fail check');
      await mkdir(join(flowDir, 'screenshots'), { recursive: true });
      await writeFile(join(flowDir, 'commands.json'), await readFile(FAILING_RUN));
      await writeFile(join(flowDir, FAILURE_SHOT), PNG);
      const outputFile = join(options.debugDir, 'output.txt');
      await writeFile(outputFile, 'Assertion is false');
      return { exitCode: 1, durationMs: 21_000, outputFile, timedOut: false };
    };
    const replayed = await call('POST', `/api/cases/${caseId}/replay`);
    expect(replayed.status).toBe(200);
    const run = replayed.body;
    expect(run).toMatchObject({ caseId, flowFile: `flows/${caseId}.yaml`, exitCode: 1, passed: false });
    expect(run.runId).toMatch(new RegExp(`^${caseId}-\\d{8}-\\d{6}$`));
    expect(run.steps.map((step: { status: string }) => step.status)).toEqual(['passed', 'passed', 'failed', 'not-run']);
    expect(run.steps[2]).toMatchObject({ step: { kind: 'assertVisible' }, error: expect.stringContaining('is visible') });
    expect(run.failureScreenshot).toBe(`runs/${run.runId}/Fail check/${FAILURE_SHOT}`);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      maestroBin: '/opt/maestro/bin/maestro',
      deviceId: 'emulator-5556',
      flowPath: join(dir, 'runs', run.runId, 'flow.yaml'),
      debugDir: join(dir, 'runs', run.runId),
      env: { PASSWORD: 'hunter2' },
    });
    expect(sessionOpenDuringRun).toBe(false);
    // Maestro runs a copy with a screenshot after each command; the case flow stays clean.
    expect(flowAtRun).toContain('takeScreenshot');
    expect(finished.body.yaml).not.toContain('takeScreenshot');
    expect(await readFile(flowFile, 'utf8')).toBe(finished.body.yaml);
    expect((await call('GET', '/api/session')).body).toEqual({ open: true, deviceId: 'emulator-5556', appId: 'com.android.settings' });

    const shot = await app.inject({ method: 'GET', url: run.screenshotUrl });
    expect(shot.statusCode).toBe(200);
    expect(shot.headers['content-type']).toBe('image/png');
    expect(JSON.parse(await readFile(join(dir, 'runs', run.runId, 'summary.json'), 'utf8'))).toEqual(
      Object.fromEntries(Object.entries(run).filter(([key]) => !['screenshotUrl', 'reportUrl', 'stale'].includes(key))),
    );
    const detail = await call('GET', `/api/cases/${caseId}`);
    expect(detail.body.case.steps).toHaveLength(3);
    expect(detail.body.yaml).toContain('name: Fail check');
    expect(detail.body.runs.map((item: { runId: string }) => item.runId)).toEqual([run.runId]);

    expect((await call('POST', '/api/cases/no-such-case/replay')).status).toBe(404);
    expect((await call('GET', '/api/runs/..%2Fx/screenshot')).status).toBe(400);
  });

  it('refuses to replay on a device that is not connected', async () => {
    const caseId = await openAndStart('Offline');
    await call('POST', '/api/case/finish');
    await call('POST', '/api/session/close');
    await writeFile(join(dir, 'project.json'), JSON.stringify({ appId: 'com.android.settings', platform: 'android', lastDeviceId: 'emulator-9999' }));
    expect(await call('POST', `/api/cases/${caseId}/replay`)).toMatchObject({ status: 400, body: { error: { code: 'NO_DEVICE' } } });
  });

  it('deletes a saved case with its flow, screenshots and runs', async () => {
    const caseId = await openAndStart('Delete me');
    await call('POST', '/api/action/tap', { x: 1000, y: 500 });
    await call('POST', '/api/case/finish');
    await mkdir(join(dir, 'runs', `${caseId}-20261031-101542`), { recursive: true });
    await writeFile(join(dir, 'runs', `${caseId}-20261031-101542`, 'output.txt'), 'ok');
    expect((await call('DELETE', '/api/cases/Bad..Id')).status).toBe(400);
    expect(await call('DELETE', `/api/cases/${caseId}`)).toEqual({ status: 200, body: { ok: true } });
    expect(await readdir(join(dir, 'cases'))).toEqual([]);
    expect(await readdir(join(dir, 'flows'))).toEqual([]);
    expect(await readdir(join(dir, 'evidence'))).toEqual([]);
    expect(await readdir(join(dir, 'runs'))).toEqual([]);
    expect((await call('GET', `/api/cases/${caseId}`)).status).toBe(404);
    expect((await call('DELETE', `/api/cases/${caseId}`)).status).toBe(404);
  });
});

describe('gestures and phone buttons', () => {
  it('records a long press and a double tap on the element a tap would hit, pressing its centre', async () => {
    await openAndStart('Gestures');
    const held = await call('POST', '/api/action/long-press', { x: 1000, y: 500 });
    expect(held.body.step).toMatchObject({ index: 1, kind: 'longPress', selector: { kind: 'text', value: 'Network & internet' } });
    expect(held.body.resolved).toMatchObject({ hittable: true });
    const twice = await call('POST', '/api/action/double-tap', { x: 300, y: 2300 });
    expect(twice.body.step).toMatchObject({ index: 2, kind: 'doubleTap', selector: { kind: 'point', xPercent: 28, yPercent: 96 } });
    expect(device.gestures).toEqual(['longPress 540,500', 'doubleTap 300,2300']);
    expect((await call('POST', '/api/action/long-press', { x: 'a' })).status).toBe(400);
    const finished = await call('POST', '/api/case/finish');
    expect(finished.body.yaml).toContain('- longPressOn:\n    text: "Network & internet"\n- doubleTapOn:\n    point: "28%,96%"\n');
  });

  it('records a swipe in whole percentages with its duration kept between 100 and 2000 ms', async () => {
    await openAndStart('Swipes');
    const left = await call('POST', '/api/action/swipe', { from: { x: 864, y: 1200 }, to: { x: 216, y: 1210 }, durationMs: 5000 });
    expect(left.body.step).toMatchObject({ kind: 'swipe', from: { xPercent: 80, yPercent: 50 }, to: { xPercent: 20, yPercent: 50 }, durationMs: 2000 });
    // The device drags the same rounded line the step records.
    expect(device.gestures).toEqual(['swipe 864,1200 216,1200 2000']);
    const quick = await call('POST', '/api/action/swipe', { from: { x: 540, y: 10 }, to: { x: 540, y: 1500 }, durationMs: 20 });
    expect(quick.body.step).toMatchObject({ from: { xPercent: 50, yPercent: 0 }, durationMs: 100 });
    expect(await call('POST', '/api/action/swipe', { from: { x: 540, y: 1200 }, to: { x: 541, y: 1201 }, durationMs: 300 })).toMatchObject({
      status: 400,
      body: { error: { code: 'BAD_SWIPE' } },
    });
    expect((await call('POST', '/api/action/swipe', { from: { x: 1, y: 1 }, to: { x: 2, y: 2 } })).status).toBe(400);
    const finished = await call('POST', '/api/case/finish');
    expect(finished.body.yaml).toContain('- swipe:\n    start: "80%, 50%"\n    end: "20%, 50%"\n    duration: 2000\n');
  });

  it('records phone keys and rotation, and keeps Recent apps and zoom out of recordings', async () => {
    await call('POST', '/api/session/open', { deviceId: 'emulator-5556', appId: 'com.android.settings' });
    // Not recording: everything works and nothing is recorded.
    expect((await call('POST', '/api/action/key', { key: 'appSwitch' })).body.step).toBeUndefined();
    expect((await call('POST', '/api/action/pinch', { zoom: 'in' })).status).toBe(200);
    await call('POST', '/api/case/start', { name: 'Keys' });
    for (const key of ['home', 'volumeUp', 'volumeDown', 'power', 'enter']) {
      expect((await call('POST', '/api/action/key', { key })).body.step).toMatchObject({ kind: 'pressKey', key });
    }
    expect((await call('POST', '/api/action/rotate', { orientation: 'landscape' })).body.step).toMatchObject({ kind: 'orientation', value: 'landscape' });
    expect(await call('POST', '/api/action/key', { key: 'appSwitch' })).toMatchObject({ status: 409, body: { error: { code: 'LIVE_ONLY' } } });
    expect(await call('POST', '/api/action/pinch', { zoom: 'out' })).toMatchObject({ status: 409, body: { error: { code: 'LIVE_ONLY' } } });
    expect((await call('POST', '/api/action/key', { key: 'menu' })).status).toBe(400);
    expect((await call('POST', '/api/action/rotate', { orientation: 'sideways' })).status).toBe(400);
    expect((await call('POST', '/api/action/pinch', { zoom: 'far' })).status).toBe(400);
    expect(device.gestures).toEqual([
      'key appSwitch',
      'pinch 1.5',
      'key home',
      'key volumeUp',
      'key volumeDown',
      'key power',
      'key enter',
      'orientation landscape',
    ]);
    const finished = await call('POST', '/api/case/finish');
    expect(finished.body.yaml).toContain(
      '- pressKey: Home\n- pressKey: Volume Up\n- pressKey: Volume Down\n- pressKey: Power\n- pressKey: Enter\n- setOrientation: LANDSCAPE_LEFT\n',
    );
  });
});
