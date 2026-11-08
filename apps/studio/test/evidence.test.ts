// The evidence pack of a Run all through the HTTP API: Run all reads the phone
// and app versions before the first case and keeps them on the suite, and
// GET /api/suites/:id/evidence turns a finished suite into one HTML page. The
// device and Maestro are fakes, cut down from the ones in edit-and-run.test.ts:
// the fake Maestro plays the flow it is given and writes commands.json and the
// takeScreenshot PNGs the way the real one does.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  encodePng,
  parseMaestroFlow,
  type CaseStep,
  type DeviceSnapshot,
  type MaestroRunResult,
  type MaestroStep,
  type OpenOptions,
  type PhoneInputTools,
  type RunMaestroOptions,
  type SuiteRun,
  type TestCase,
  type TestedOn,
} from '@ariadne/core';
import type { SuiteView } from '../src/shared/api-types.ts';
import { buildServer } from '../src/server/index.ts';
import type { DeviceLike } from '../src/server/state.ts';

const APP = 'com.android.settings';
const OTHER_APP = 'com.example.bank';
const DEVICE = 'emulator-5556';
const LONG_AGO = '2026-10-01T09:00:00.000Z';

type Node = DeviceSnapshot['nodes'][number];
type ScreenName = 'home' | 'network';

function row(index: number, y: number, title: string): Node[] {
  return [
    { index, depth: 1, rect: { x: 0, y, width: 1080, height: 200 }, hittable: true },
    { index: index + 1, depth: 2, parentIndex: index, rect: { x: 200, y: y + 40, width: 400, height: 70 }, label: title, identifier: 'android:id/title' },
  ];
}

const screens: Record<ScreenName, Node[]> = {
  home: [...row(0, 400, 'Network & internet'), ...row(2, 600, 'Connected devices')],
  network: [...row(0, 400, 'Internet'), ...row(2, 600, 'SIMs')],
};

const labels = (screen: ScreenName) => screens[screen].flatMap((node) => (node.label ? [node.label] : []));

function drawScreen(luminance: number): Buffer {
  const width = 108;
  const height = 240;
  const data = new Uint8Array(width * height).fill(242);
  for (let y = 40; y < 90; y++) for (let x = 10; x < 80; x++) data[y * width + x] = luminance;
  return encodePng({ width, height, channels: 1, data });
}

const IMAGES: Record<ScreenName, Buffer> = { home: drawScreen(40), network: drawScreen(90) };

/** In-memory stand-in for DeviceSession: Run all only needs it to be open on a device. */
class FakeDevice implements DeviceLike {
  target: { deviceId: string; appId: string } | undefined;
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
  async close() {
    this.target = undefined;
  }
  async relaunchApp() {}
  async snapshot(): Promise<DeviceSnapshot> {
    return { nodes: screens.home, viewport: { width: 1080, height: 2400 }, takenAt: new Date().toISOString() };
  }
  async capture(screenshotPath: string) {
    await mkdir(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, IMAGES.home);
    return { ...(await this.snapshot()), screenshotPath };
  }
  async tapAt() {}
  async typeText() {}
  async back() {}
  async scroll() {}
  async openLink() {}
  async hideKeyboard() {}
  async longPressAt() {}
  async doubleTapAt() {}
  async swipe() {}
  async pinch() {}
  async pressKey() {}
  async setOrientation() {}
  async replayFlow(): Promise<{ replayed: number }> {
    throw new AppError('REPLAY_DIVERGENCE', 'not used by these tests');
  }
}

function commandEntry(name: string, args: Record<string, unknown>, sequenceNumber: number, status: string, extra: { error?: string; artifacts?: Array<{ type: string; path: string }> } = {}) {
  const command = { [name]: { optional: false, ...args } };
  return {
    command,
    metadata: {
      status,
      timestamp: Date.now(),
      duration: 25,
      sequenceNumber,
      depth: 0,
      evaluatedCommand: command,
      ...(extra.error ? { error: { message: extra.error, debugMessage: extra.error } } : {}),
      ...(extra.artifacts ? { artifacts: extra.artifacts } : {}),
    },
  };
}

function commandOf(step: MaestroStep, appId: string): [string, Record<string, unknown>] {
  const selector = (value: string) => ({ textRegex: value });
  switch (step.kind) {
    case 'launchApp':
      return ['launchAppCommand', { appId }];
    case 'tapOn':
      return ['tapOnElement', { selector: step.selector.kind === 'text' ? selector(step.selector.value) : {}, retryIfNoChange: false, waitUntilVisible: false, longPress: false }];
    case 'assertVisible':
      return ['assertConditionCommand', { condition: { visible: step.selector.kind === 'text' ? selector(step.selector.value) : {} } }];
    default:
      return [`${step.kind}Command`, {}];
  }
}

/** Plays a flow on its own copy of the fake app, stopping at the first failure like Maestro. */
class FakeMaestro {
  calls: string[] = [];
  private gate: Promise<void> | undefined;
  private openGate: (() => void) | undefined;

  hold(): void {
    this.gate = new Promise((done) => {
      this.openGate = done;
    });
  }
  release(): void {
    this.openGate?.();
    this.gate = undefined;
  }

  readonly run = async (options: RunMaestroOptions): Promise<MaestroRunResult> => {
    const flow = parseMaestroFlow(await readFile(options.flowPath, 'utf8'));
    const name = flow.name ?? 'flow';
    this.calls.push(name);
    if (this.gate) await this.gate;
    const flowDir = join(options.debugDir, name);
    await mkdir(flowDir, { recursive: true });
    const entries: unknown[] = [
      commandEntry('defineVariablesCommand', { env: { MAESTRO_FILENAME: 'flow', MAESTRO_DEVICE_UDID: options.deviceId } }, 0, 'COMPLETED'),
      commandEntry('applyConfigurationCommand', { config: { appId: flow.appId, name } }, 1, 'COMPLETED'),
    ];
    let screen: ScreenName = 'home';
    let passed = true;
    for (const step of flow.steps) {
      const sequence = entries.length;
      if (step.kind === 'takeScreenshot') {
        const file = `takeScreenshot/${step.path}.png`;
        await mkdir(dirname(join(flowDir, file)), { recursive: true });
        await writeFile(join(flowDir, file), IMAGES[screen]);
        entries.push(commandEntry('takeScreenshotCommand', { path: step.path }, sequence, 'COMPLETED', { artifacts: [{ type: 'TAKE_SCREENSHOT', path: file }] }));
        continue;
      }
      const [command, args] = commandOf(step, flow.appId);
      const text = (step.kind === 'tapOn' || step.kind === 'assertVisible') && step.selector.kind === 'text' ? step.selector.value : undefined;
      if (text !== undefined && !labels(screen).includes(text)) {
        const file = `screenshots/step-${String(sequence + 1).padStart(3, '0')}-${command}.png`;
        await mkdir(dirname(join(flowDir, file)), { recursive: true });
        await writeFile(join(flowDir, file), IMAGES[screen]);
        entries.push(commandEntry(command, args, sequence, 'FAILED', { error: `Assertion is false: "${text}" is visible`, artifacts: [{ type: 'SCREENSHOT', path: file }] }));
        passed = false;
        break;
      }
      entries.push(commandEntry(command, args, sequence, 'COMPLETED'));
      if (step.kind === 'launchApp') screen = 'home';
      if (step.kind === 'tapOn' && screen === 'home' && text === 'Network & internet') screen = 'network';
    }
    await writeFile(join(flowDir, 'commands.json'), JSON.stringify(entries, null, 2));
    const outputFile = join(options.debugDir, 'output.txt');
    await writeFile(outputFile, passed ? 'Flow Passed\n' : 'Flow Failed\n');
    return { exitCode: passed ? 0 : 1, durationMs: 1500, outputFile, timedOut: false };
  };
}

let dir: string;
let device: FakeDevice;
let maestro: FakeMaestro;
let app: FastifyInstance;
let testedOn: ReturnType<typeof vi.fn<PhoneInputTools['testedOn']>>;

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
  return { status: response.statusCode, headers: response.headers, body: response.headers['content-type']?.includes('json') ? response.json() : response.body };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((wake) => setTimeout(wake, 5));
  }
  throw new Error('Gave up waiting');
}

const currentSuite = async () => (await call('GET', '/api/suite/current')).body as SuiteView;

async function readSavedSuite(suiteId: string): Promise<SuiteRun> {
  return JSON.parse(await readFile(join(dir, 'runs', '_suites', `${suiteId}.json`), 'utf8')) as SuiteRun;
}

/** Starts Run all and waits until it has finished and reached disk. */
async function runAll(): Promise<SuiteView> {
  const started = await call('POST', '/api/suite/run');
  expect(started.status).toBe(202);
  const suite = await until(currentSuite, (value) => value.status !== 'running');
  await until(() => readSavedSuite(suite.suiteId), (saved) => saved.status === suite.status);
  return suite;
}

function tapStep(index: number, text: string): CaseStep {
  return { index, kind: 'tap', selector: { kind: 'text', value: text }, point: { x: 300, y: 475 }, at: LONG_AGO };
}

async function saveCase(id: string, name: string, createdAt: string, extra: Partial<TestCase> = {}): Promise<void> {
  const testCase: TestCase = {
    id,
    name,
    appId: APP,
    createdAt,
    deviceId: DEVICE,
    preconditionBlocks: [],
    steps: [tapStep(1, 'Network & internet')],
    expectations: [],
    ...extra,
  };
  await writeFile(join(dir, 'cases', `${id}.json`), `${JSON.stringify(testCase, null, 2)}\n`);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ariadne-studio-evidence-'));
  device = new FakeDevice();
  maestro = new FakeMaestro();
  testedOn = vi.fn<PhoneInputTools['testedOn']>(async () => ({ apps: [] }));
  app = await buildServer({
    projectDir: dir,
    session: device,
    maestro: { run: (options) => maestro.run(options), findBin: () => '/opt/maestro/bin/maestro', androidHome: () => undefined, findFfmpeg: () => undefined },
    phoneTools: { testedOn },
  });
  expect((await call('POST', '/api/session/open', { deviceId: DEVICE, appId: APP })).status).toBe(200);
});

afterEach(async () => {
  vi.restoreAllMocks();
  maestro.release();
  const suite = await currentSuite().catch(() => null);
  if (suite?.status === 'running') await until(currentSuite, (value) => value.status !== 'running').catch(() => undefined);
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const PHONE: TestedOn = {
  maker: 'Xiaomi',
  model: '23129RAA4G',
  android: '14',
  apps: [
    { appId: APP, versionName: '15', versionCode: '1500' },
    { appId: OTHER_APP, versionName: '2.4.1', versionCode: '241' },
  ],
};

describe('Run all reads what it ran on', () => {
  it('stores the phone and the app versions on the suite, asking for the app ids of the cases that run', async () => {
    await saveCase('one', 'One', '2026-10-01T10:00:00.000Z');
    await saveCase('two', 'Two', '2026-10-02T10:00:00.000Z', { appId: OTHER_APP });
    await saveCase('three', 'Three', '2026-10-03T10:00:00.000Z');
    await saveCase('quiet', 'Quiet', '2026-10-04T10:00:00.000Z', { appId: 'com.example.muted', muted: true });
    testedOn.mockResolvedValue(PHONE);

    const suite = await runAll();

    expect(testedOn).toHaveBeenCalledTimes(1);
    expect(testedOn).toHaveBeenCalledWith(DEVICE, [APP, OTHER_APP]);
    expect((await readSavedSuite(suite.suiteId)).testedOn).toEqual(PHONE);
    expect(suite.testedOn).toEqual(PHONE);
  });

  it('reads the phone before the first case runs', async () => {
    await saveCase('one', 'One', '2026-10-01T10:00:00.000Z');
    testedOn.mockResolvedValue(PHONE);
    maestro.hold();
    await call('POST', '/api/suite/run');
    await until(async () => maestro.calls.length, (count) => count === 1);
    expect(testedOn).toHaveBeenCalledTimes(1);
    // Saved before the case finished, so a pack made from a stopped Run all still has it.
    const current = await currentSuite();
    expect(current.testedOn).toEqual(PHONE);
    expect((await readSavedSuite(current.suiteId)).testedOn).toEqual(PHONE);
    maestro.release();
    await until(currentSuite, (value) => value.status !== 'running');
  });

  it('finishes normally, with no testedOn on the suite, when the phone cannot be read', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await saveCase('one', 'One', '2026-10-01T10:00:00.000Z');
    testedOn.mockRejectedValue(new Error('adb: device offline'));

    const suite = await runAll();

    expect(suite.status).toBe('finished');
    expect(suite.cases.map((item) => item.outcome)).toEqual(['passed']);
    expect(suite).not.toHaveProperty('testedOn');
    expect(await readSavedSuite(suite.suiteId)).not.toHaveProperty('testedOn');
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('adb: device offline'));
  });
});

describe('GET /api/suites/:suiteId/evidence', () => {
  const evidence = (suiteId: string, query = '') => call('GET', `/api/suites/${suiteId}/evidence${query}`);

  async function finishedSuite(): Promise<string> {
    await saveCase('root', 'Root case', '2026-10-01T10:00:00.000Z', { expectations: [{ selector: { kind: 'text', value: 'Internet' }, at: LONG_AGO }] });
    await saveCase('broken', 'Broken case', '2026-10-02T10:00:00.000Z', { expectations: [{ selector: { kind: 'text', value: 'Nope' }, at: LONG_AGO }] });
    await saveCase('quiet', 'Quiet case', '2026-10-03T10:00:00.000Z', { muted: true });
    testedOn.mockResolvedValue(PHONE);
    return (await runAll()).suiteId;
  }

  it('answers 400 for an id that is not a suite id', async () => {
    expect(await evidence('Bad..Id')).toMatchObject({ status: 400 });
  });

  it('answers 404 for a suite that was never run', async () => {
    expect(await evidence('suite-19990101-000000')).toMatchObject({ status: 404, body: { error: { code: 'NOT_FOUND' } } });
  });

  it('answers 409 while that suite is running', async () => {
    await saveCase('one', 'One', '2026-10-01T10:00:00.000Z');
    maestro.hold();
    const suiteId = ((await call('POST', '/api/suite/run')).body as SuiteView).suiteId;
    await until(async () => maestro.calls.length, (count) => count === 1);
    expect(await evidence(suiteId)).toMatchObject({ status: 409, body: { error: { code: 'SUITE_RUNNING' } } });
    maestro.release();
    await until(currentSuite, (value) => value.status !== 'running');
    await until(() => readSavedSuite(suiteId), (saved) => saved.status === 'finished');
    expect((await evidence(suiteId)).status).toBe(200);
  });

  it('refuses a release or a tester of more than 200 characters, and takes exactly 200', async () => {
    const suiteId = await finishedSuite();
    const long = 'x'.repeat(201);
    expect(await evidence(suiteId, `?release=${long}`)).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
    expect(await evidence(suiteId, `?testedBy=${long}`)).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
    expect((await evidence(suiteId, `?release=${'x'.repeat(200)}&testedBy=${'y'.repeat(200)}`)).status).toBe(200);
  });

  it('refuses a release given twice', async () => {
    const suiteId = await finishedSuite();
    expect(await evidence(suiteId, '?release=a&release=b')).toMatchObject({ status: 400 });
  });

  it('turns control characters in the release and tester into spaces', async () => {
    const suiteId = await finishedSuite();
    const response = await evidence(suiteId, `?release=${encodeURIComponent('Rel\r\nease\t5')}&testedBy=${encodeURIComponent('Ma\u0000ria')}`);
    expect(response.status).toBe(200);
    expect(response.body).toContain('<th>Release</th><td>Rel ease 5</td>');
    expect(response.body).toContain('<th>Tested by</th><td>Ma ria</td>');
    expect(response.body).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
  });

  it('counts the 200 characters after control characters are replaced and the text trimmed', async () => {
    const suiteId = await finishedSuite();
    const padded = `\n${'x'.repeat(200)}\n`;
    expect((await evidence(suiteId, `?release=${encodeURIComponent(padded)}`)).status).toBe(200);
  });

  it('escapes the release and tester in the page', async () => {
    const suiteId = await finishedSuite();
    const response = await evidence(suiteId, `?release=${encodeURIComponent('<script>alert(1)</script>')}&testedBy=${encodeURIComponent('"Q" & R')}`);
    expect(response.body).not.toContain('<script>alert(1)');
    expect(response.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(response.body).toContain('&quot;Q&quot; &amp; R');
  });

  it('answers with an HTML page and writes the same page under exports/', async () => {
    const suiteId = await finishedSuite();
    const response = await evidence(suiteId, `?release=${encodeURIComponent('Release 5.1')}&testedBy=${encodeURIComponent('Maria P.')}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain('<th>Release</th><td>Release 5.1</td>');
    expect(response.body).toContain('<tr><th>Tested by</th><td>Maria P.</td><td></td><td></td></tr>');
    expect(await readFile(join(dir, 'exports', `evidence-${suiteId}.html`), 'utf8')).toBe(response.body);
  });

  it('answers 200 while evidencePack is off, because the setting only decides whether the studio shows the button', async () => {
    const suiteId = await finishedSuite();
    const project = await call('GET', '/api/project');
    expect((project.body as { evidencePack: boolean }).evidencePack).toBe(false);
    expect((await evidence(suiteId)).status).toBe(200);
  });

  it('shows the phone, the app versions, the verdict and one section per case that ran', async () => {
    const suiteId = await finishedSuite();
    const html = (await evidence(suiteId)).body as string;

    expect(html).toContain('Xiaomi 23129RAA4G, Android 14');
    expect(html).toContain(`<code>${APP}</code> 15 (1500)`);
    expect(html).toContain(`<code>${OTHER_APP}</code> 2.4.1 (241)`);
    expect(html).toContain('1 of 3 cases did not pass.');
    // Root and Broken ran; Quiet is muted and has no section.
    expect(html).toContain('id="case-1"');
    expect(html).toContain('id="case-2"');
    expect(html).not.toContain('id="case-3"');
    expect(html).toContain('Not run: muted');
    expect(html).toContain('Failed at: Check that &quot;Nope&quot; is visible');
  });

  it('inlines the screens of the run as data URLs', async () => {
    const suiteId = await finishedSuite();
    const html = (await evidence(suiteId)).body as string;
    expect(html).toMatch(/<img class="shot" src="data:image\/[a-z]+;base64,/);
    expect(html).not.toMatch(/src="(runs|evidence)\//);
  });

  // Deleting a case also deletes its runs, so the pack has no section for it, only the summary row.
  it('keeps a case deleted after Run all in the summary, marked as deleted', async () => {
    const suiteId = await finishedSuite();
    expect((await call('DELETE', '/api/cases/root')).status).toBe(200);
    expect(existsSync(join(dir, 'cases', 'root.json'))).toBe(false);

    const html = (await evidence(suiteId)).body as string;

    expect(html).toContain('Root case');
    expect(html).toContain('The case was deleted after Run all.');
    expect(html).not.toContain('id="case-1"');
    expect(html).toContain('Broken case');
  });

  it('marks a case edited after its run', async () => {
    const suiteId = await finishedSuite();
    const file = join(dir, 'cases', 'root.json');
    const saved = JSON.parse(await readFile(file, 'utf8')) as TestCase;
    await writeFile(file, JSON.stringify({ ...saved, editedAt: new Date(Date.now() + 60_000).toISOString() }));
    const html = (await evidence(suiteId)).body as string;
    expect(html).toContain('The case was edited after this run.');
  });

  it('falls back to the app ids of the cases when Run all could not read versions', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await saveCase('one', 'One', '2026-10-01T10:00:00.000Z');
    testedOn.mockRejectedValue(new Error('offline'));
    const suiteId = (await runAll()).suiteId;
    const html = (await evidence(suiteId)).body as string;
    expect(html).toContain(`<code>${APP}</code> version not read`);
    expect(html).toContain('<th>Device</th><td>not read</td>');
    expect(html).toContain('Every case that ran passed.');
  });

  it('names an emulator or a real phone in the Device row, from what Run all read', async () => {
    await saveCase('one', 'One', '2026-10-01T10:00:00.000Z');
    testedOn.mockResolvedValue({ ...PHONE, emulator: true });
    const emulator = (await evidence((await runAll()).suiteId)).body as string;
    expect(emulator).toContain('<th>Device</th><td>Emulator: Xiaomi 23129RAA4G, Android 14</td>');
    testedOn.mockResolvedValue({ ...PHONE, emulator: false });
    const real = (await evidence((await runAll()).suiteId)).body as string;
    expect(real).toContain('<th>Device</th><td>Real phone: Xiaomi 23129RAA4G, Android 14</td>');
  });

  it('shows a case reference in the cases table and the case section, and none when no case has one', async () => {
    await saveCase('root', 'Root case', '2026-10-01T10:00:00.000Z', { reference: 'REQ-4.2 <b>' });
    await saveCase('other', 'Other case', '2026-10-02T10:00:00.000Z');
    const withReference = (await evidence((await runAll()).suiteId)).body as string;
    expect(withReference).toContain('<th>Reference</th>');
    expect(withReference).toContain('<td>REQ-4.2 &lt;b&gt;</td><td><a href="#case-1">Root case</a></td>');
    expect(withReference).toContain('reference REQ-4.2 &lt;b&gt;');
    expect(withReference).not.toContain('<b>');

    await call('PATCH', '/api/cases/root', { reference: '' });
    const without = (await evidence((await runAll()).suiteId)).body as string;
    expect(without).not.toContain('<th>Reference</th>');
    expect(without).not.toContain('reference REQ');
  });

  describe('written details', () => {
    it('shows the second signature role, and refuses more than 40 characters', async () => {
      const suiteId = await finishedSuite();
      expect(((await evidence(suiteId, `?signoffRole=${encodeURIComponent('  Reviewed by ')}`)).body as string)).toContain('<tr><th>Reviewed by</th><td></td>');
      expect(((await evidence(suiteId)).body as string)).toContain('<tr><th>Accepted by</th>');
      expect((await evidence(suiteId, `?signoffRole=${'r'.repeat(40)}`)).status).toBe(200);
      expect(await evidence(suiteId, `?signoffRole=${'r'.repeat(41)}`)).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
    });

    it('escapes the second signature role', async () => {
      const suiteId = await finishedSuite();
      const html = (await evidence(suiteId, `?signoffRole=${encodeURIComponent('<i>Boss</i>')}`)).body as string;
      expect(html).toContain('<th>&lt;i&gt;Boss&lt;/i&gt;</th>');
      expect(html).not.toContain('<i>Boss');
    });

    it('keeps line breaks in the known issues, turns CRLF into LF and other control characters into spaces', async () => {
      const suiteId = await finishedSuite();
      const text = 'Login slow\r\nPayment <script>x</script>\rThird\u0007line\tend';
      const html = (await evidence(suiteId, `?knownIssues=${encodeURIComponent(text)}`)).body as string;
      expect(html).toContain('<div class="written">Login slow\nPayment &lt;script&gt;x&lt;/script&gt;\nThird line end</div>');
      expect(html).not.toContain('\r');
      expect(html).not.toContain('<script>x');
    });

    it('takes exactly 1000 characters of known issues and refuses 1001', async () => {
      const suiteId = await finishedSuite();
      expect((await evidence(suiteId, `?knownIssues=${'k'.repeat(1000)}`)).status).toBe(200);
      expect(await evidence(suiteId, `?knownIssues=${'k'.repeat(1001)}`)).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
    });

    it('does not count the trimmed line breaks around the known issues', async () => {
      const suiteId = await finishedSuite();
      const padded = `\n\n${'k'.repeat(1000)}\n\n`;
      expect((await evidence(suiteId, `?knownIssues=${encodeURIComponent(padded)}`)).status).toBe(200);
    });

    it('shows the conclusion on one line, and refuses more than 200 characters', async () => {
      const suiteId = await finishedSuite();
      const html = (await evidence(suiteId, `?conclusion=${encodeURIComponent('Ready\nto ship <b>')}`)).body as string;
      expect(html).toContain('<th>Conclusion</th><td><div class="written">Ready to ship &lt;b&gt;</div></td>');
      expect((await evidence(suiteId, `?conclusion=${'c'.repeat(200)}`)).status).toBe(200);
      expect(await evidence(suiteId, `?conclusion=${'c'.repeat(201)}`)).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
    });

    it('refuses each of the new texts given twice', async () => {
      const suiteId = await finishedSuite();
      for (const key of ['signoffRole', 'knownIssues', 'conclusion', 'screens']) {
        expect((await evidence(suiteId, `?${key}=a&${key}=b`)).status, key).toBe(400);
      }
    });

    it('leaves Known issues and Conclusion empty when not given or blank', async () => {
      const suiteId = await finishedSuite();
      const html = (await evidence(suiteId, '?knownIssues=%20%0A&conclusion=%20')).body as string;
      expect(html).toContain('<th>Known issues</th><td><div class="written"></div></td>');
      expect(html).toContain('<th>Conclusion</th><td><div class="written"></div></td>');
    });
  });

  describe('screens', () => {
    const shots = (html: string) => html.split('<img class="shot"').length - 1;

    it('refuses a value other than all or checks', async () => {
      const suiteId = await finishedSuite();
      for (const value of ['none', 'ALL', '', 'checks,all']) {
        expect(await evidence(suiteId, `?screens=${value}`), value).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
      }
    });

    it('says After every step by default and with all, and the checks wording with checks', async () => {
      const suiteId = await finishedSuite();
      expect((await evidence(suiteId)).body).toContain('<th>Screens</th><td>After every step.</td>');
      expect((await evidence(suiteId, '?screens=all')).body).toContain('<th>Screens</th><td>After every step.</td>');
      expect((await evidence(suiteId, '?screens=checks')).body).toContain('<th>Screens</th><td>After checks and after a step that failed.</td>');
    });

    it('inlines fewer screens with checks than with all for the same suite, and still some', async () => {
      const suiteId = await finishedSuite();
      const all = shots((await evidence(suiteId, '?screens=all')).body as string);
      const checks = shots((await evidence(suiteId, '?screens=checks')).body as string);
      expect(checks).toBeGreaterThan(0);
      expect(checks).toBeLessThan(all);
    });

    it('writes the page of the last request under exports/', async () => {
      const suiteId = await finishedSuite();
      const checks = (await evidence(suiteId, '?screens=checks')).body;
      expect(await readFile(join(dir, 'exports', `evidence-${suiteId}.html`), 'utf8')).toBe(checks);
    });
  });

  describe('record fingerprints', () => {
    const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const sectionOf = (html: string, number: number) => html.slice(html.indexOf(`id="case-${number}"`), html.indexOf(`id="case-${number + 1}"`) === -1 ? undefined : html.indexOf(`id="case-${number + 1}"`));

    it('shows the SHA-256 of the saved suite file with its project path', async () => {
      const suiteId = await finishedSuite();
      const bytes = await readFile(join(dir, 'runs', '_suites', `${suiteId}.json`));
      const html = (await evidence(suiteId)).body as string;
      expect(html).toContain(`<th>Record</th><td><code>runs/_suites/${suiteId}.json</code><div class="hash">SHA-256 <code>${sha(bytes)}</code></div></td>`);
    });

    it('shows each case the SHA-256 of the summary.json of its last run', async () => {
      const suiteId = await finishedSuite();
      const saved = await readSavedSuite(suiteId);
      const html = (await evidence(suiteId)).body as string;
      const ran = saved.cases.filter((item) => item.runIds.length > 0);
      expect(ran.length).toBeGreaterThanOrEqual(2);
      for (const item of ran) {
        const lastRunId = item.runIds.at(-1)!;
        const bytes = await readFile(join(dir, 'runs', lastRunId, 'summary.json'));
        const index = saved.cases.findIndex((other) => other.caseId === item.caseId) + 1;
        expect(sectionOf(html, index)).toContain(`Results from <code>runs/${lastRunId}/summary.json</code><div class="hash">SHA-256 <code>${sha(bytes)}</code></div>`);
      }
    });

    it('follows the file on disk when the suite file changes between packs', async () => {
      const suiteId = await finishedSuite();
      const file = join(dir, 'runs', '_suites', `${suiteId}.json`);
      const before = ((await evidence(suiteId)).body as string).match(/Record<\/th>.*?<code>([0-9a-f]{64})<\/code>/s)![1];
      const saved = JSON.parse(await readFile(file, 'utf8')) as SuiteRun;
      await writeFile(file, `${JSON.stringify({ ...saved, retryFailed: false }, null, 2)}\n`);
      const after = ((await evidence(suiteId)).body as string).match(/Record<\/th>.*?<code>([0-9a-f]{64})<\/code>/s)![1];
      expect(after).toBe(sha(await readFile(file)));
      expect(after).not.toBe(before);
    });

    it('shows no results line for a case that did not run', async () => {
      const suiteId = await finishedSuite();
      const saved = await readSavedSuite(suiteId);
      expect(saved.cases.some((item) => item.outcome === 'muted')).toBe(true);
      const html = (await evidence(suiteId)).body as string;
      // Two cases ran, so two "Results from" lines; the muted one has no section.
      expect(html.split('Results from').length - 1).toBe(2);
    });
  });
});
