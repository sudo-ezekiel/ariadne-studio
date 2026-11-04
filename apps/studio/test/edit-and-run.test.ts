// Milestones 3 and 4 through the HTTP API: starting from a saved case, the new
// actions, editing saved cases, replay screenshots and reports, Run all, and
// test case documents. The device and Maestro are fakes. The fake Maestro
// plays the flow file it is given and writes what the real one writes:
// <flow name>/commands.json, the takeScreenshot PNGs and output.txt.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  LOOKS_DIFFERENT_BELOW,
  encodePng,
  parseMaestroFlow,
  type CaseStep,
  type DeviceSnapshot,
  type MaestroRunResult,
  type MaestroSelector,
  type MaestroStep,
  type OpenOptions,
  type Point,
  type RunMaestroOptions,
  type SuiteRun,
  type TestCase,
} from '@ariadne/core';
import type { CaseDetailResponse, CurrentCaseView, ProjectInfo, RunView, SuiteView } from '../src/shared/api-types.ts';
import { buildServer } from '../src/server/index.ts';
import type { DeviceLike, MaestroTools } from '../src/server/state.ts';
import type { FrameRunVideoInput } from '../src/server/run-video.ts';

const APP = 'com.android.settings';
const DEVICE = 'emulator-5556';

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

function labels(screen: ScreenName): string[] {
  return screens[screen].flatMap((node) => (node.label ? [node.label] : []));
}

// Each fake screen is a few grey boxes ([top, bottom, left, right] as fractions,
// then luminance), different enough for the similarity check to tell apart.
const SHAPES: Record<ScreenName, Array<[number, number, number, number, number]>> = {
  home: [[0.15, 0.19, 0.1, 0.6, 40], [0.25, 0.29, 0.1, 0.75, 40], [0.35, 0.39, 0.1, 0.5, 40]],
  network: [[0.1, 0.35, 0, 1, 70], [0.45, 0.5, 0.1, 0.9, 40], [0.6, 0.65, 0.1, 0.9, 40]],
  login: [[0.4, 0.46, 0.05, 0.95, 120], [0.55, 0.6, 0.3, 0.7, 30]],
};

function drawScreen(screen: ScreenName): Buffer {
  const width = 108;
  const height = 240;
  const data = new Uint8Array(width * height).fill(242);
  for (const [top, bottom, left, right, luminance] of SHAPES[screen]) {
    for (let y = Math.round(top * height); y < Math.round(bottom * height); y++) {
      for (let x = Math.round(left * width); x < Math.round(right * width); x++) data[y * width + x] = luminance;
    }
  }
  return encodePng({ width, height, channels: 1, data });
}

const IMAGES: Record<ScreenName, Buffer> = { home: drawScreen('home'), network: drawScreen('network'), login: drawScreen('login') };

/** Where a flow step leaves the fake app: tapping "Network & internet" on home is the only way forward. */
function nextScreen(step: MaestroStep, screen: ScreenName): ScreenName {
  switch (step.kind) {
    case 'launchApp':
    case 'back':
      return 'home';
    case 'tapOn':
      return screen === 'home' && step.selector.kind === 'text' && step.selector.value === 'Network & internet' ? 'network' : screen;
    default:
      return screen;
  }
}

/** The text a tapOn or assertVisible step needs to find on screen. */
function neededText(step: MaestroStep): string | undefined {
  return (step.kind === 'tapOn' || step.kind === 'assertVisible') && step.selector.kind === 'text' ? step.selector.value : undefined;
}

/** In-memory stand-in for DeviceSession. replayFlow plays the flow file, nested runFlow files included. */
class FakeDevice implements DeviceLike {
  screen: ScreenName = 'home';
  target: { deviceId: string; appId: string } | undefined;
  opens = 0;
  relaunches = 0;
  taps: Point[] = [];
  typed: string[] = [];
  links: string[] = [];
  keyboardHidden = 0;
  /** Every replay with the flow text as it was when it ran (partial flows are deleted afterwards). */
  replays: Array<{ path: string; env: Record<string, string>; yaml: string }> = [];
  failReplay: ((path: string) => boolean) | undefined;

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
    this.opens++;
    this.target = { deviceId: options.deviceId, appId: options.appId };
  }
  async relaunchApp() {
    this.relaunches++;
    this.screen = 'home';
  }
  async snapshot(): Promise<DeviceSnapshot> {
    return { nodes: screens[this.screen], viewport: { width: 1080, height: 2400 }, takenAt: new Date().toISOString() };
  }
  async capture(screenshotPath: string) {
    mkdirSync(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, IMAGES[this.screen]);
    return { ...(await this.snapshot()), screenshotPath };
  }
  async tapAt(point: Point) {
    this.taps.push(point);
    if (this.screen === 'home' && point.y < 600) this.screen = 'network';
  }
  async typeText(text: string) {
    this.typed.push(text);
  }
  async back() {
    this.screen = 'home';
  }
  async scroll() {}
  async openLink(url: string) {
    this.links.push(url);
  }
  async hideKeyboard() {
    this.keyboardHidden++;
  }
  /** Gestures, keys and rotations done directly, in order, as "key volumeUp" or "orientation landscape". */
  direct: string[] = [];
  async longPressAt(point: Point) {
    this.direct.push(`longPress ${point.x},${point.y}`);
  }
  async doubleTapAt(point: Point) {
    this.direct.push(`doubleTap ${point.x},${point.y}`);
  }
  async swipe() {}
  async pinch() {}
  async pressKey(key: string) {
    this.direct.push(`key ${key}`);
  }
  async setOrientation(value: string) {
    this.direct.push(`orientation ${value}`);
  }
  async replayFlow(path: string, env: Readonly<Record<string, string>>) {
    const yaml = await readFile(path, 'utf8');
    this.replays.push({ path, env: { ...env }, yaml });
    if (this.failReplay?.(path)) {
      this.screen = 'login';
      throw new AppError('REPLAY_DIVERGENCE', 'Replay failed at step 2 (tapOn "Internet"): element not found.');
    }
    return { replayed: await this.play(path) };
  }
  private async play(path: string): Promise<number> {
    let count = 0;
    for (const step of parseMaestroFlow(await readFile(path, 'utf8')).steps) {
      if (step.kind === 'runFlow') {
        count += await this.play(resolve(dirname(path), step.file));
        continue;
      }
      const text = neededText(step);
      if (text !== undefined && !labels(this.screen).includes(text)) {
        throw new AppError('REPLAY_DIVERGENCE', `Replay failed: "${text}" is not on the screen.`);
      }
      this.screen = nextScreen(step, this.screen);
      count++;
    }
    return count;
  }
  async close() {
    this.target = undefined;
  }
}

type EntryExtra = { error?: string; artifacts?: Array<{ type: string; path: string }> };

/** One commands.json entry, shaped like Maestro 2.12 writes them. */
function commandEntry(name: string, args: Record<string, unknown>, sequenceNumber: number, depth: number, status: string, extra: EntryExtra = {}) {
  const command = { [name]: { optional: false, ...args } };
  return {
    command,
    metadata: {
      status,
      timestamp: Date.now(),
      duration: 25,
      sequenceNumber,
      depth,
      evaluatedCommand: command,
      ...(extra.error ? { error: { message: extra.error, debugMessage: extra.error } } : {}),
      ...(extra.artifacts ? { artifacts: extra.artifacts } : {}),
    },
  };
}

function selectorArgs(selector: MaestroSelector): Record<string, unknown> {
  switch (selector.kind) {
    case 'text':
      return { textRegex: selector.value };
    case 'id':
      return { idRegex: selector.value };
    case 'point':
      return { point: `${selector.xPercent}%,${selector.yPercent}%` };
  }
}

function commandOf(step: MaestroStep, appId: string): [string, Record<string, unknown>] {
  switch (step.kind) {
    case 'launchApp':
      return ['launchAppCommand', { appId }];
    case 'tapOn':
      return ['tapOnElement', { selector: selectorArgs(step.selector), retryIfNoChange: false, waitUntilVisible: false, longPress: false }];
    case 'assertVisible':
      return ['assertConditionCommand', { condition: { visible: selectorArgs(step.selector) } }];
    case 'back':
      return ['backPressCommand', {}];
    case 'inputText':
      return ['inputTextCommand', { text: step.text }];
    case 'hideKeyboard':
      return ['hideKeyboardCommand', {}];
    case 'openLink':
      return ['openLinkCommand', { link: step.link }];
    default:
      return [`${step.kind}Command`, {}];
  }
}

/** What happens to the first step command of a run: a failure, or Maestro stopping while it runs. */
type Breakage = 'FAILED' | 'RUNNING';

/**
 * Plays the flow it is given on its own copy of the fake app. Like Maestro it
 * stops at the first failure and leaves later commands out of commands.json.
 */
class FakeMaestro {
  calls: Array<{ name: string; options: RunMaestroOptions; yaml: string; sessionOpen: boolean }> = [];
  /** Per flow name, consumed one per run: forces the first step command to fail or hang. */
  breaks = new Map<string, Breakage[]>();
  /** takeScreenshot path to the screen it shows instead of the real one. */
  shotScreens = new Map<string, ScreenName>();
  /** This many next runs lose the device mid-run, the way adb reports "device offline". */
  offlineRuns = 0;
  /** Written to <flow>/logs/device-logcat.txt of every run, the device log Maestro saves. */
  deviceLog: string | undefined;
  private readonly device: FakeDevice;
  private gate: Promise<void> | undefined;
  private openGate: (() => void) | undefined;

  constructor(device: FakeDevice) {
    this.device = device;
  }

  /** Runs wait until release(). */
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
    const yaml = await readFile(options.flowPath, 'utf8');
    const flow = parseMaestroFlow(yaml);
    const name = flow.name ?? 'flow';
    this.calls.push({ name, options, yaml, sessionOpen: this.device.isOpen });
    if (this.gate) await this.gate;
    const flowDir = join(options.debugDir, name);
    await mkdir(flowDir, { recursive: true });
    const entries: unknown[] = [
      commandEntry('defineVariablesCommand', { env: { MAESTRO_FILENAME: 'flow', MAESTRO_DEVICE_UDID: options.deviceId } }, 0, 0, 'COMPLETED'),
      commandEntry('applyConfigurationCommand', { config: { appId: flow.appId, name } }, 1, 0, 'COMPLETED'),
    ];
    const offline = this.offlineRuns > 0;
    if (offline) this.offlineRuns--;
    let breakage: Breakage | undefined = offline ? 'RUNNING' : this.breaks.get(name)?.shift();
    let screen: ScreenName = 'home';
    const saveShot = async (file: string, shown: ScreenName) => {
      await mkdir(dirname(join(flowDir, file)), { recursive: true });
      await writeFile(join(flowDir, file), IMAGES[shown]);
    };
    const play = async (steps: readonly MaestroStep[], baseDir: string, depth: number): Promise<boolean> => {
      for (const step of steps) {
        const sequence = entries.length;
        if (step.kind === 'takeScreenshot') {
          const file = `takeScreenshot/${step.path}.png`;
          await saveShot(file, this.shotScreens.get(step.path) ?? screen);
          entries.push(
            commandEntry('takeScreenshotCommand', { path: step.path, optional: step.optional ?? false }, sequence, depth, 'COMPLETED', {
              artifacts: [{ type: 'TAKE_SCREENSHOT', path: file }],
            }),
          );
          continue;
        }
        if (step.kind === 'runFlow') {
          // Maestro lists a runFlow before the commands inside it.
          entries.push(undefined);
          const file = resolve(baseDir, step.file);
          const found = existsSync(file);
          const passed = found && (await play(parseMaestroFlow(await readFile(file, 'utf8')).steps, dirname(file), depth + 1));
          const error = found ? 'A command in the flow failed' : `Flow file ${step.file} does not exist`;
          const status = passed ? 'COMPLETED' : 'FAILED';
          entries[sequence] = commandEntry('runFlowCommand', { sourceDescription: step.file }, sequence, depth, status, passed ? {} : { error });
          if (!passed) return false;
          continue;
        }
        const [command, args] = commandOf(step, flow.appId);
        const text = neededText(step);
        let status: string = 'COMPLETED';
        let error: string | undefined;
        if (breakage && depth === 0 && step.kind !== 'launchApp') {
          status = breakage;
          breakage = undefined;
          if (status === 'FAILED') error = 'Element not found (made to fail by the test)';
        } else if (text !== undefined && !labels(screen).includes(text)) {
          status = 'FAILED';
          error = step.kind === 'tapOn' ? `Element not found: Text matching regex: ${text}` : `Assertion is false: "${text}" is visible`;
        }
        const extra: EntryExtra = {};
        if (status === 'FAILED') {
          const file = `screenshots/step-${String(sequence + 1).padStart(3, '0')}-${command}.png`;
          await saveShot(file, screen);
          extra.error = error;
          extra.artifacts = [{ type: 'SCREENSHOT', path: file }];
        }
        entries.push(commandEntry(command, args, sequence, depth, status, extra));
        if (status !== 'COMPLETED') return false;
        screen = nextScreen(step, screen);
      }
      return true;
    };
    const passed = await play(flow.steps, dirname(options.flowPath), 0);
    await writeFile(join(flowDir, 'commands.json'), JSON.stringify(entries, null, 2));
    if (this.deviceLog !== undefined) {
      await mkdir(join(flowDir, 'logs'), { recursive: true });
      await writeFile(join(flowDir, 'logs', 'device-logcat.txt'), this.deviceLog);
    }
    const outputFile = join(options.debugDir, 'output.txt');
    await writeFile(
      outputFile,
      offline ? `Command failed (host:transport:${options.deviceId}): device offline\n` : passed ? 'Flow Passed\n' : 'Flow Failed\n',
    );
    return { exitCode: passed ? 0 : 1, durationMs: 1500, outputFile, timedOut: false };
  };
}

let dir: string;
let device: FakeDevice;
let maestro: FakeMaestro;
let app: FastifyInstance;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function call(method: Method, url: string, payload?: object) {
  const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
  return { status: response.statusCode, body: response.headers['content-type']?.includes('json') ? response.json() : response.body };
}

/** Polls without Date, so it also works while a test freezes the clock. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((wake) => setTimeout(wake, 5));
  }
  throw new Error('Gave up waiting');
}

async function currentSuite(): Promise<SuiteView> {
  return (await call('GET', '/api/suite/current')).body as SuiteView;
}

async function finishedSuite(): Promise<SuiteView> {
  const suite = await until(currentSuite, (value) => value.status !== 'running');
  // The status flips before the file is written; wait for the file too.
  await until(
    async () => JSON.parse(await readFile(join(dir, 'runs', '_suites', `${suite.suiteId}.json`), 'utf8')) as SuiteRun,
    (saved) => saved.status === suite.status,
  );
  return suite;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ariadne-studio-edit-run-'));
  device = new FakeDevice();
  maestro = new FakeMaestro(device);
  app = await buildServer({
    projectDir: dir,
    session: device,
    // No ffmpeg, so the fake mp4 bytes of the run video tests are never handed to the machine's.
    maestro: { run: (options) => maestro.run(options), findBin: () => '/opt/maestro/bin/maestro', androidHome: () => undefined, findFfmpeg: () => undefined },
  });
});

afterEach(async () => {
  vi.useRealTimers();
  // A suite still held by the fake Maestro must end before the project goes away.
  maestro.release();
  const suite = await currentSuite().catch(() => null);
  if (suite?.status === 'running') await until(currentSuite, (value) => value.status !== 'running').catch(() => undefined);
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function openSession(appId = APP) {
  expect((await call('POST', '/api/session/open', { deviceId: DEVICE, appId })).status).toBe(200);
}

// Taps by position, as the mirror sends them.
const tapNetwork = () => call('POST', '/api/action/tap', { x: 1000, y: 500 }); // "Network & internet" on home
const tapInternet = () => call('POST', '/api/action/tap', { x: 300, y: 475 }); // "Internet" on network
const tapSims = () => call('POST', '/api/action/tap', { x: 300, y: 675 }); // "SIMs" on network
const pressBack = () => call('POST', '/api/action/back');

type Recording = { blocks?: string[]; startFrom?: string; picks?: number[] };

/** Records and finishes a case; `picks` are candidate ids on the final screen. */
async function recordCase(name: string, actions: Array<() => Promise<{ status: number }>>, options: Recording = {}): Promise<string> {
  const { picks, ...start } = options;
  const started = await call('POST', '/api/case/start', { name, ...start });
  expect(started.status).toBe(200);
  for (const action of actions) expect((await action()).status).toBe(200);
  const finished = await call('POST', '/api/case/finish', picks ? { picks } : undefined);
  expect(finished.status).toBe(200);
  return started.body.caseId as string;
}

async function readCaseFile(caseId: string): Promise<TestCase> {
  return JSON.parse(await readFile(join(dir, 'cases', `${caseId}.json`), 'utf8')) as TestCase;
}

async function evidenceFiles(caseId: string): Promise<string[]> {
  return (await readdir(join(dir, 'evidence', caseId))).sort();
}

function labelsOf(screen: { nodes: Array<{ label?: string }> }): string[] {
  return screen.nodes.flatMap((node) => (node.label ? [node.label] : []));
}

function stepRows(steps: readonly CaseStep[]): Array<[number, string, string | undefined]> {
  return steps.map((step) => [step.index, step.kind === 'tap' && step.selector.kind === 'text' ? `tap ${step.selector.value}` : step.kind, step.screenshot]);
}

async function writeBlock(file: string, body: string) {
  await mkdir(join(dir, 'blocks'), { recursive: true });
  await writeFile(join(dir, 'blocks', file), `appId: ${APP}\n---\n${body}`);
}

const LONG_AGO = '2026-10-01T09:00:00.000Z';

function tapStep(index: number, text: string): CaseStep {
  return { index, kind: 'tap', selector: { kind: 'text', value: text }, point: { x: 300, y: 475 }, at: LONG_AGO };
}

/** Writes a case file directly, for tests that need a fixed createdAt order. */
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

/** Entry name to text content of a zip, read through its central directory. */
function unzipTexts(file: Buffer): Map<string, string> {
  const end = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = file.readUInt16LE(end + 10);
  let at = file.readUInt32LE(end + 16);
  const texts = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const method = file.readUInt16LE(at + 10);
    const compressedSize = file.readUInt32LE(at + 20);
    const nameLength = file.readUInt16LE(at + 28);
    const extraLength = file.readUInt16LE(at + 30);
    const commentLength = file.readUInt16LE(at + 32);
    const localOffset = file.readUInt32LE(at + 42);
    const name = file.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = localOffset + 30 + file.readUInt16LE(localOffset + 26) + file.readUInt16LE(localOffset + 28);
    const raw = file.subarray(start, start + compressedSize);
    texts.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString('utf8'));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return texts;
}

function inlinedImages(html: string): number {
  return html.match(/<img class="shot" src="data:image\/png;base64,/g)?.length ?? 0;
}

describe('start from a saved case', () => {
  it('replays the saved case, writing the flows of its whole chain first, and records from where it ends', async () => {
    await writeFile(join(dir, '.env'), 'USERNAME=ba@example.com\n');
    await openSession();
    const root = await recordCase('Open network', [tapNetwork]);
    const middle = await recordCase('Open internet', [tapInternet], { startFrom: root });
    // Flows on disk are regenerated from the case files before a replay.
    await writeFile(join(dir, 'flows', `${root}.yaml`), 'appId: edited.by.hand\n---\n- back\n');
    await rm(join(dir, 'flows', `${middle}.yaml`));
    const relaunches = device.relaunches;
    device.screen = 'login';

    const started = await call('POST', '/api/case/start', { name: 'Check SIMs', startFrom: middle });
    expect(started.status).toBe(200);
    const child = started.body.caseId as string;
    expect(device.relaunches).toBe(relaunches + 1);
    expect(device.replays.at(-1)).toMatchObject({ path: join(dir, 'flows', `${middle}.yaml`), env: { USERNAME: 'ba@example.com' } });
    expect(await readFile(join(dir, 'flows', `${root}.yaml`), 'utf8')).toBe(
      ['appId: com.android.settings', 'name: Open network', '---', '- launchApp', '- tapOn:', '    text: "Network & internet"', ''].join('\n'),
    );
    expect(existsSync(join(dir, 'flows', `${middle}.yaml`))).toBe(true);
    expect(labelsOf(started.body.screen)).toEqual(['Internet', 'SIMs']);
    expect((await call('GET', '/api/case/current')).body).toMatchObject({ id: child, startFrom: middle, preconditionBlocks: [], steps: [] });

    expect((await tapSims()).body.step).toMatchObject({ index: 1, selector: { kind: 'text', value: 'SIMs' } });
    const finished = await call('POST', '/api/case/finish');
    expect(finished.body.yaml).toBe(
      [
        'appId: com.android.settings',
        'name: Check SIMs',
        '---',
        '- runFlow:',
        `    file: ${middle}.yaml`,
        '    env:',
        '      USERNAME: "${USERNAME}"',
        '- tapOn:',
        '    text: "SIMs"',
        '',
      ].join('\n'),
    );
    expect(finished.body.yaml).not.toContain('launchApp');
    expect(await readCaseFile(child)).toMatchObject({ startFrom: middle, preconditionBlocks: [] });

    const childDetail = (await call('GET', `/api/cases/${child}`)).body as CaseDetailResponse;
    expect(childDetail.parent).toEqual({ id: middle, name: 'Open internet' });
    expect(childDetail.dependents).toEqual([]);
    const middleDetail = (await call('GET', `/api/cases/${middle}`)).body as CaseDetailResponse;
    expect(middleDetail.parent).toEqual({ id: root, name: 'Open network' });
    expect(middleDetail.dependents).toEqual([{ id: child, name: 'Check SIMs' }]);
    const rootDetail = (await call('GET', `/api/cases/${root}`)).body as CaseDetailResponse;
    expect(rootDetail.parent).toBeUndefined();
    expect(rootDetail.dependents).toEqual([{ id: middle, name: 'Open internet' }]);

    const project = (await call('GET', '/api/project')).body as ProjectInfo;
    expect(Object.fromEntries(project.cases.map((item) => [item.id, item.dependents]))).toEqual({ [root]: 1, [middle]: 1, [child]: 0 });
  });

  it('keeps a case that others start from until they are gone', async () => {
    await openSession();
    const parent = await recordCase('Parent', [tapNetwork]);
    const child = await recordCase('Child', [tapInternet], { startFrom: parent });
    const refused = await call('DELETE', `/api/cases/${parent}`);
    expect(refused).toMatchObject({ status: 409, body: { error: { code: 'HAS_DEPENDENTS', message: expect.stringContaining(child) } } });
    expect(existsSync(join(dir, 'cases', `${parent}.json`))).toBe(true);
    expect(existsSync(join(dir, 'flows', `${parent}.yaml`))).toBe(true);
    expect((await call('DELETE', `/api/cases/${child}`)).status).toBe(200);
    expect((await call('DELETE', `/api/cases/${parent}`)).status).toBe(200);
    expect(await readdir(join(dir, 'cases'))).toEqual([]);
  });

  it('refuses blocks together with a saved case, unknown cases and cases of another app', async () => {
    await writeBlock('second.yaml', '- back\n');
    await openSession();
    const parent = await recordCase('Parent', [tapNetwork]);
    const replays = device.replays.length;
    expect(await call('POST', '/api/case/start', { name: 'X', blocks: ['blocks/second.yaml'], startFrom: parent })).toMatchObject({
      status: 400,
      body: { error: { code: 'BLOCKS_AND_START' } },
    });
    expect(await call('POST', '/api/case/start', { name: 'X', startFrom: 'no-such-case' })).toMatchObject({
      status: 404,
      body: { error: { code: 'NOT_FOUND' } },
    });
    expect((await call('POST', '/api/case/start', { name: 'X', startFrom: '../cases/x' })).status).toBe(400);
    expect((await call('POST', '/api/case/start', { name: 'X', startFrom: 7 })).status).toBe(400);
    await openSession('com.example');
    expect(await call('POST', '/api/case/start', { name: 'X', startFrom: parent })).toMatchObject({
      status: 409,
      body: { error: { code: 'WRONG_APP', message: expect.stringContaining(APP) } },
    });
    expect(device.replays).toHaveLength(replays);
    expect((await call('GET', '/api/case/current')).body).toBeNull();
    expect(await readdir(join(dir, 'cases'))).toEqual([`${parent}.json`]);
  });

  it('reports a failing replay of the saved case as 502 and starts no case', async () => {
    await openSession();
    const parent = await recordCase('Parent', [tapNetwork]);
    device.failReplay = (path) => path.endsWith(`${parent}.yaml`);
    const failed = await call('POST', '/api/case/start', { name: 'Child', startFrom: parent });
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('REPLAY_DIVERGENCE');
    expect(failed.body.error.message).toMatch(new RegExp(`^The case ${parent} failed: Replay failed at step 2`));
    expect((await call('GET', '/api/case/current')).body).toBeNull();
    // The mirror shows where the replay stopped.
    expect(labelsOf((await call('GET', '/api/screen')).body)).toEqual(['Password']);
    expect(await readdir(join(dir, 'cases'))).toEqual([`${parent}.json`]);
  });

  // Source bug: DELETE only refuses a case that saved cases start from (and the
  // case open in the recorder). A case being recorded with startFrom is not saved
  // yet, so its parent can be deleted under it; Finish then saves a case whose
  // start case is gone, and its replay fails with 409 BROKEN_CHAIN.
  it('refuses to delete the case that the case being recorded starts from', async () => {
    await openSession();
    const parent = await recordCase('Parent', [tapNetwork]);
    expect((await call('POST', '/api/case/start', { name: 'Child', startFrom: parent })).status).toBe(200);
    expect((await call('DELETE', `/api/cases/${parent}`)).status).toBe(409);
  });
});

describe('relaunch, hide keyboard and open link', () => {
  it('records each as one step and one Maestro command while recording', async () => {
    await openSession();
    const started = await call('POST', '/api/case/start', { name: 'More actions' });
    const caseId = started.body.caseId as string;
    await tapNetwork();
    const relaunches = device.relaunches;
    const relaunched = await call('POST', '/api/action/relaunch');
    expect(relaunched.body.step).toMatchObject({ index: 2, kind: 'relaunch', screenshot: `evidence/${caseId}/step-002.png` });
    expect(device.relaunches).toBe(relaunches + 1);
    expect(labelsOf(relaunched.body.screen)).toEqual(['Network & internet', 'Connected devices']);
    const hidden = await call('POST', '/api/action/hide-keyboard');
    expect(hidden.body.step).toMatchObject({ index: 3, kind: 'hideKeyboard', screenshot: `evidence/${caseId}/step-003.png` });
    expect(device.keyboardHidden).toBe(1);
    const linked = await call('POST', '/api/action/open-link', { url: ' https://example.com/claims?id=7 ' });
    expect(linked.body.step).toMatchObject({ index: 4, kind: 'openLink', url: 'https://example.com/claims?id=7' });
    const deep = await call('POST', '/api/action/open-link', { url: 'myapp://claims/123' });
    expect(deep.body.step).toMatchObject({ index: 5, kind: 'openLink', url: 'myapp://claims/123' });
    expect(device.links).toEqual(['https://example.com/claims?id=7', 'myapp://claims/123']);

    const finished = await call('POST', '/api/case/finish');
    expect(finished.body.yaml).toBe(
      [
        'appId: com.android.settings',
        'name: More actions',
        '---',
        '- launchApp',
        '- tapOn:',
        '    text: "Network & internet"',
        '- launchApp',
        '- hideKeyboard',
        '- openLink: "https://example.com/claims?id=7"',
        '- openLink: "myapp://claims/123"',
        '',
      ].join('\n'),
    );
    expect(await evidenceFiles(caseId)).toEqual(['step-001.png', 'step-002.png', 'step-003.png', 'step-004.png', 'step-005.png']);
  });

  it('only acts on the device when no case is recording', async () => {
    for (const [url, payload] of [
      ['/api/action/relaunch', undefined],
      ['/api/action/hide-keyboard', undefined],
      ['/api/action/open-link', { url: 'https://example.com' }],
    ] as const) {
      expect(await call('POST', url, payload)).toMatchObject({ status: 409, body: { error: { code: 'NO_SESSION' } } });
    }
    await openSession();
    device.screen = 'network';
    const relaunched = await call('POST', '/api/action/relaunch');
    expect(relaunched.status).toBe(200);
    expect(relaunched.body.step).toBeUndefined();
    expect(device.screen).toBe('home');
    const hidden = await call('POST', '/api/action/hide-keyboard');
    expect(hidden.status).toBe(200);
    expect(hidden.body.step).toBeUndefined();
    expect(device.keyboardHidden).toBe(1);
    const linked = await call('POST', '/api/action/open-link', { url: 'myapp://claims/123' });
    expect(linked.status).toBe(200);
    expect(linked.body.step).toBeUndefined();
    expect(device.links).toEqual(['myapp://claims/123']);
    expect(await readdir(join(dir, 'evidence'))).toEqual([]);
    expect(await readdir(join(dir, 'cases'))).toEqual([]);
  });

  it('refuses links that are not web links or app deep links', async () => {
    await openSession();
    await call('POST', '/api/case/start', { name: 'Links' });
    for (const url of [
      'file:///etc/passwd',
      'FILE:///etc/passwd',
      'javascript:alert(1)',
      'javascript://%0Aalert(1)',
      'content://com.android.contacts/contacts',
      'claims',
      'open the claims page',
      'https://',
      '//example.com/claims',
      'https://example.com/a b',
      `https://example.com/${'a'.repeat(2000)}`,
    ]) {
      expect(await call('POST', '/api/action/open-link', { url }), url).toMatchObject({ status: 400, body: { error: { code: 'BAD_LINK' } } });
    }
    expect((await call('POST', '/api/action/open-link', { url: '  ' })).status).toBe(400);
    expect((await call('POST', '/api/action/open-link', {})).status).toBe(400);
    expect(device.links).toEqual([]);
    expect((await call('GET', '/api/case/current')).body.steps).toEqual([]);
  });
});

describe('re-record from a step and insert steps', () => {
  /** Three steps (open network, tap Internet, back) checking both home entries at the end. */
  async function recordEditBase(): Promise<string> {
    await openSession();
    return recordCase('Edit me', [tapNetwork, tapInternet, pressBack], { picks: [0, 1] });
  }

  function partialPath(caseId: string): string {
    return join(dir, 'runs', '_partial', `${caseId}.yaml`);
  }

  const FIRST_STEP_ONLY = ['appId: com.android.settings', 'name: Edit me', '---', '- launchApp', '- tapOn:', '    text: "Network & internet"', ''].join('\n');

  it('re-records from step N: replays steps before it, pre-ticks old end checks, then replaces the rest', async () => {
    const caseId = await recordEditBase();
    const before = await readCaseFile(caseId);
    expect(before.expectations.map((item) => item.selector)).toEqual([
      { kind: 'text', value: 'Network & internet' },
      { kind: 'text', value: 'Connected devices' },
    ]);
    const relaunches = device.relaunches;

    const edit = await call('POST', `/api/cases/${caseId}/edit`, { mode: 'rerecord', step: 2 });
    expect(edit.status).toBe(200);
    expect(edit.body.caseId).toBe(caseId);
    expect(device.relaunches).toBe(relaunches + 1);
    expect(device.replays.at(-1)).toMatchObject({ path: partialPath(caseId), yaml: FIRST_STEP_ONLY });
    expect(existsSync(partialPath(caseId))).toBe(false);
    expect(labelsOf(edit.body.screen)).toEqual(['Internet', 'SIMs']);
    const current = (await call('GET', '/api/case/current')).body as CurrentCaseView;
    expect(current.editing).toEqual({ mode: 'rerecord', keptSteps: 1, tailSteps: 0 });
    expect(stepRows(current.steps)).toEqual([[1, 'tap Network & internet', `evidence/${caseId}/step-001.png`]]);
    expect(current.expectations).toEqual([]);

    // New screenshots are numbered after every existing one.
    expect((await tapSims()).body.step).toMatchObject({ index: 2, screenshot: `evidence/${caseId}/step-004.png` });
    // Neither old end check is on this screen, so nothing is pre-ticked.
    const onNetwork = await call('GET', '/api/case/candidates');
    expect(onNetwork.body.candidates.map((item: { label: string }) => item.label)).toEqual(['Internet', 'SIMs']);
    expect(onNetwork.body.preselected).toBeUndefined();
    expect((await pressBack()).body.step).toMatchObject({ index: 3, kind: 'back', screenshot: `evidence/${caseId}/step-005.png` });
    const onHome = await call('GET', '/api/case/candidates');
    expect(onHome.body.candidates.map((item: { label: string }) => item.label)).toEqual(['Network & internet', 'Connected devices']);
    expect(onHome.body.preselected).toEqual([0, 1]);

    const finished = await call('POST', '/api/case/finish', { picks: [1] });
    expect(finished.status).toBe(200);
    const saved = await readCaseFile(caseId);
    expect(stepRows(saved.steps)).toEqual([
      [1, 'tap Network & internet', `evidence/${caseId}/step-001.png`],
      [2, 'tap SIMs', `evidence/${caseId}/step-004.png`],
      [3, 'back', `evidence/${caseId}/step-005.png`],
    ]);
    expect(saved.expectations.map((item) => item.selector)).toEqual([{ kind: 'text', value: 'Connected devices' }]);
    expect(saved.createdAt).toBe(before.createdAt);
    expect(saved.editedAt).toEqual(expect.any(String));
    expect(saved.editedAt! > before.createdAt).toBe(true);
    // Screenshots of the replaced steps go; the kept step's stays.
    expect(await evidenceFiles(caseId)).toEqual(['step-001.png', 'step-004.png', 'step-005.png']);
    expect(finished.body.yaml).toBe(
      [
        'appId: com.android.settings',
        'name: Edit me',
        '---',
        '- launchApp',
        '- tapOn:',
        '    text: "Network & internet"',
        '- tapOn:',
        '    text: "SIMs"',
        '- back',
        '- assertVisible:',
        '    text: "Connected devices"',
        '',
      ].join('\n'),
    );
    expect((await call('GET', '/api/case/current')).body).toBeNull();
  });

  it('inserts steps after step N and keeps the rest of the case and its end checks', async () => {
    const caseId = await recordEditBase();
    const before = await readCaseFile(caseId);
    const edit = await call('POST', `/api/cases/${caseId}/edit`, { mode: 'insert', after: 1 });
    expect(edit.status).toBe(200);
    expect(device.replays.at(-1)).toMatchObject({ path: partialPath(caseId), yaml: FIRST_STEP_ONLY });
    expect(existsSync(partialPath(caseId))).toBe(false);
    const current = (await call('GET', '/api/case/current')).body as CurrentCaseView;
    expect(current.editing).toEqual({ mode: 'insert', keptSteps: 1, tailSteps: 2 });
    expect(current.steps).toHaveLength(1);
    expect(current.expectations).toEqual(before.expectations);
    expect((await call('GET', '/api/case/candidates')).body.preselected).toBeUndefined();

    expect((await tapSims()).body.step).toMatchObject({ index: 2, screenshot: `evidence/${caseId}/step-004.png` });
    const finished = await call('POST', '/api/case/finish');
    expect(finished.status).toBe(200);
    const saved = await readCaseFile(caseId);
    expect(stepRows(saved.steps)).toEqual([
      [1, 'tap Network & internet', `evidence/${caseId}/step-001.png`],
      [2, 'tap SIMs', `evidence/${caseId}/step-004.png`],
      [3, 'tap Internet', `evidence/${caseId}/step-002.png`],
      [4, 'back', `evidence/${caseId}/step-003.png`],
    ]);
    expect(saved.expectations).toEqual(before.expectations);
    expect(saved.editedAt).toEqual(expect.any(String));
    expect(await evidenceFiles(caseId)).toEqual(['step-001.png', 'step-002.png', 'step-003.png', 'step-004.png']);
    expect(finished.body.yaml.endsWith('- back\n- assertVisible:\n    text: "Network & internet"\n- assertVisible:\n    text: "Connected devices"\n')).toBe(
      true,
    );
  });

  it('inserts at the very start: the partial flow is only the launch', async () => {
    const caseId = await recordEditBase();
    expect((await call('POST', `/api/cases/${caseId}/edit`, { mode: 'insert', after: 0 })).status).toBe(200);
    expect(device.replays.at(-1)?.yaml).toBe(['appId: com.android.settings', 'name: Edit me', '---', '- launchApp', ''].join('\n'));
    expect((await call('GET', '/api/case/current')).body.editing).toEqual({ mode: 'insert', keptSteps: 0, tailSteps: 3 });
  });

  it('leaves the saved case and its screenshots untouched when an edit is discarded', async () => {
    const caseId = await recordEditBase();
    const caseFile = await readFile(join(dir, 'cases', `${caseId}.json`), 'utf8');
    const flowFile = await readFile(join(dir, 'flows', `${caseId}.yaml`), 'utf8');
    const secondShot = await readFile(join(dir, 'evidence', caseId, 'step-002.png'));
    await call('POST', `/api/cases/${caseId}/edit`, { mode: 'rerecord', step: 2 });
    await tapSims();
    await pressBack();
    expect(await evidenceFiles(caseId)).toEqual(['step-001.png', 'step-002.png', 'step-003.png', 'step-004.png', 'step-005.png']);

    const discarded = await call('POST', '/api/case/discard');
    expect(discarded).toEqual({ status: 200, body: { ok: true, caseId, restored: true } });
    expect(await readFile(join(dir, 'cases', `${caseId}.json`), 'utf8')).toBe(caseFile);
    expect(await readFile(join(dir, 'flows', `${caseId}.yaml`), 'utf8')).toBe(flowFile);
    expect(await evidenceFiles(caseId)).toEqual(['step-001.png', 'step-002.png', 'step-003.png']);
    expect((await readFile(join(dir, 'evidence', caseId, 'step-002.png'))).equals(secondShot)).toBe(true);
    expect((await call('GET', '/api/case/current')).body).toBeNull();
    expect(((await call('GET', `/api/cases/${caseId}`)).body as CaseDetailResponse).case.editedAt).toBeUndefined();
  });

  it('deletes the partial flow and opens no recorder when the replay up to step N fails', async () => {
    const caseId = await recordEditBase();
    device.failReplay = (path) => path.includes('_partial');
    const failed = await call('POST', `/api/cases/${caseId}/edit`, { mode: 'insert', after: 2 });
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('REPLAY_DIVERGENCE');
    expect(failed.body.error.message).toMatch(/^Running the case up to step 2 failed: Replay failed at step 2/);
    expect(device.replays.at(-1)?.path).toBe(partialPath(caseId));
    expect(existsSync(partialPath(caseId))).toBe(false);
    expect(await readdir(join(dir, 'flows'))).toEqual([`${caseId}.yaml`]);
    expect((await call('GET', '/api/case/current')).body).toBeNull();
    expect(labelsOf((await call('GET', '/api/screen')).body)).toEqual(['Password']);

    device.failReplay = undefined;
    expect((await call('POST', `/api/cases/${caseId}/edit`, { mode: 'insert', after: 2 })).status).toBe(200);
  });

  it('replays the start case chain as part of the partial flow', async () => {
    await openSession();
    const parent = await recordCase('Parent', [tapNetwork]);
    const child = await recordCase('Child', [tapInternet, tapSims], { startFrom: parent });
    await rm(join(dir, 'flows', `${parent}.yaml`));
    const edit = await call('POST', `/api/cases/${child}/edit`, { mode: 'rerecord', step: 2 });
    expect(edit.status).toBe(200);
    expect(device.replays.at(-1)?.yaml).toBe(
      // Written to runs/_partial/, so the parent's flow is found back in flows/.
      ['appId: com.android.settings', 'name: Child', '---', '- runFlow:', `    file: ../../flows/${parent}.yaml`, '- tapOn:', '    text: "Internet"', ''].join('\n'),
    );
    expect(existsSync(join(dir, 'flows', `${parent}.yaml`))).toBe(true);
    expect(labelsOf(edit.body.screen)).toEqual(['Internet', 'SIMs']);
    await call('POST', '/api/case/finish');
    expect(await readCaseFile(child)).toMatchObject({ startFrom: parent, preconditionBlocks: [] });
  });

  it('never merges new typing into a typing step kept from the saved case', async () => {
    await openSession();
    const caseId = await recordCase('Search', [() => call('POST', '/api/action/type', { text: 'wi' }), pressBack]);
    await call('POST', `/api/cases/${caseId}/edit`, { mode: 'rerecord', step: 2 });
    const typed = await call('POST', '/api/action/type', { text: 'fi' });
    expect(typed.body.step).toMatchObject({ index: 2, kind: 'type', text: 'fi', screenshot: `evidence/${caseId}/step-003.png` });
    await call('POST', '/api/case/finish');
    const saved = await readCaseFile(caseId);
    expect(saved.steps.map((step) => (step.kind === 'type' ? step.text : step.kind))).toEqual(['wi', 'fi']);
    expect(await evidenceFiles(caseId)).toEqual(['step-001.png', 'step-003.png']);
  });

  it('refuses bad step numbers, a missing session, another recording and another app', async () => {
    const caseId = await recordEditBase();
    const url = `/api/cases/${caseId}/edit`;
    for (const body of [
      { mode: 'rerecord', step: 0 },
      { mode: 'rerecord', step: 4 },
      { mode: 'rerecord', step: 1.5 },
      { mode: 'rerecord', step: 'two' },
      { mode: 'rerecord' },
      { mode: 'insert', after: -1 },
      { mode: 'insert', after: 4 },
      { mode: 'insert' },
    ]) {
      expect(await call('POST', url, body), JSON.stringify(body)).toMatchObject({ status: 400, body: { error: { code: 'BAD_STEP' } } });
    }
    expect(await call('POST', url, { mode: 'replace', step: 1 })).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
    expect((await call('POST', '/api/cases/no-such-case/edit', { mode: 'rerecord', step: 1 })).status).toBe(404);
    expect((await call('POST', '/api/cases/Bad..Id/edit', { mode: 'rerecord', step: 1 })).status).toBe(400);
    expect(device.replays).toEqual([]);

    // While a case is open in the recorder, no other edit starts, and the case
    // being edited cannot be changed or deleted underneath it.
    expect((await call('POST', url, { mode: 'rerecord', step: 3 })).status).toBe(200);
    expect(await call('POST', url, { mode: 'rerecord', step: 1 })).toMatchObject({ status: 409, body: { error: { code: 'CASE_ACTIVE' } } });
    for (const [method, path, payload] of [
      ['PATCH', `/api/cases/${caseId}`, { name: 'Other' }],
      ['PATCH', `/api/cases/${caseId}/steps/1`, { title: 'Other' }],
      ['DELETE', `/api/cases/${caseId}/steps/1`, undefined],
      ['DELETE', `/api/cases/${caseId}/expectations/1`, undefined],
      ['POST', `/api/cases/${caseId}/split`, { atStep: 1 }],
      ['POST', `/api/cases/${caseId}/replay`, undefined],
      ['DELETE', `/api/cases/${caseId}`, undefined],
    ] as const) {
      expect(await call(method, path, payload), `${method} ${path}`).toMatchObject({ status: 409, body: { error: { code: 'CASE_ACTIVE' } } });
    }
    await call('POST', '/api/case/discard');

    await openSession('com.example');
    expect(await call('POST', url, { mode: 'rerecord', step: 1 })).toMatchObject({ status: 409, body: { error: { code: 'WRONG_APP' } } });
    await call('POST', '/api/session/close');
    expect(await call('POST', url, { mode: 'rerecord', step: 1 })).toMatchObject({ status: 409, body: { error: { code: 'NO_SESSION' } } });
  });

  // Source bug: the spec (section 11) says evidence files are numbered by a
  // per-case counter that never reuses a number. The counter restarts from the
  // highest file on disk, so once the step with the highest number is deleted,
  // the next new step gets that number again; a Markdown export written before
  // the delete then shows the new screen for the deleted step.
  it('never gives a new screenshot the number of a deleted step', async () => {
    const caseId = await recordEditBase();
    expect((await call('DELETE', `/api/cases/${caseId}/steps/3`)).status).toBe(200);
    expect((await call('POST', `/api/cases/${caseId}/edit`, { mode: 'insert', after: 2 })).status).toBe(200);
    const added = await pressBack();
    expect(added.body.step.screenshot).not.toBe(`evidence/${caseId}/step-003.png`);
  });
});

describe('editing a saved case', () => {
  it('renames and mutes a case without marking it edited', async () => {
    await openSession();
    const caseId = await recordCase('Old name', [tapNetwork]);
    const renamed = await call('PATCH', `/api/cases/${caseId}`, { name: '  New name  ', muted: true });
    expect(renamed.status).toBe(200);
    const detail = renamed.body as CaseDetailResponse;
    expect(detail.case).toMatchObject({ id: caseId, name: 'New name', muted: true });
    expect(detail.case.editedAt).toBeUndefined();
    expect(detail.yaml).toContain('name: New name\n');
    expect(await readCaseFile(caseId)).toMatchObject({ name: 'New name', muted: true });
    expect(((await call('GET', '/api/project')).body as ProjectInfo).cases).toEqual([
      expect.objectContaining({ id: caseId, name: 'New name', muted: true }),
    ]);

    const unmuted = (await call('PATCH', `/api/cases/${caseId}`, { muted: false })).body as CaseDetailResponse;
    expect('muted' in unmuted.case).toBe(false);
    expect(unmuted.case.name).toBe('New name');
    expect((await readCaseFile(caseId)).editedAt).toBeUndefined();

    expect((await call('PATCH', `/api/cases/${caseId}`, { name: '   ' })).status).toBe(400);
    expect((await call('PATCH', `/api/cases/${caseId}`, { name: 'x'.repeat(201) })).status).toBe(400);
    expect((await call('PATCH', `/api/cases/${caseId}`, { muted: 'yes' })).status).toBe(400);
    expect((await call('PATCH', '/api/cases/no-such-case', { name: 'X' })).status).toBe(404);
    expect((await readCaseFile(caseId)).name).toBe('New name');
  });

  it('sets and clears step titles and notes without marking the case edited', async () => {
    await openSession();
    const caseId = await recordCase('Notes', [tapNetwork, tapInternet]);
    const titled = (await call('PATCH', `/api/cases/${caseId}/steps/1`, { title: ' Open the network page ', note: 'Internet and SIMs are listed' }))
      .body as CaseDetailResponse;
    expect(titled.case.steps[0]).toMatchObject({ index: 1, title: 'Open the network page', note: 'Internet and SIMs are listed' });
    expect(titled.case.steps[1]?.title).toBeUndefined();
    expect(titled.case.editedAt).toBeUndefined();

    const noTitle = (await call('PATCH', `/api/cases/${caseId}/steps/1`, { title: '' })).body as CaseDetailResponse;
    expect(noTitle.case.steps[0]?.title).toBeUndefined();
    expect(noTitle.case.steps[0]?.note).toBe('Internet and SIMs are listed');
    const noNote = (await call('PATCH', `/api/cases/${caseId}/steps/1`, { note: '' })).body as CaseDetailResponse;
    expect('note' in noNote.case.steps[0]!).toBe(false);
    expect((await readCaseFile(caseId)).steps[0]).not.toHaveProperty('title');
    expect((await readCaseFile(caseId)).editedAt).toBeUndefined();

    for (const step of ['0', '3', '-1', '1.5', 'x']) {
      expect(await call('PATCH', `/api/cases/${caseId}/steps/${step}`, { title: 'T' }), step).toMatchObject({
        status: 400,
        body: { error: { code: 'BAD_STEP' } },
      });
    }
    expect((await call('PATCH', `/api/cases/${caseId}/steps/1`, { title: 'x'.repeat(201) })).status).toBe(400);
    expect((await call('PATCH', `/api/cases/${caseId}/steps/1`, { note: 5 })).status).toBe(400);
  });

  it('deletes a step: renumbers the rest, marks the case edited and removes that screenshot only', async () => {
    await openSession();
    const caseId = await recordCase('Three steps', [tapNetwork, tapInternet, pressBack]);
    const deleted = await call('DELETE', `/api/cases/${caseId}/steps/2`);
    expect(deleted.status).toBe(200);
    const detail = deleted.body as CaseDetailResponse;
    expect(stepRows(detail.case.steps)).toEqual([
      [1, 'tap Network & internet', `evidence/${caseId}/step-001.png`],
      [2, 'back', `evidence/${caseId}/step-003.png`],
    ]);
    expect(detail.case.editedAt).toEqual(expect.any(String));
    expect(detail.yaml).not.toContain('text: "Internet"');
    expect(await readFile(join(dir, 'flows', `${caseId}.yaml`), 'utf8')).toBe(detail.yaml);
    expect(await evidenceFiles(caseId)).toEqual(['step-001.png', 'step-003.png']);
    expect(await call('DELETE', `/api/cases/${caseId}/steps/3`)).toMatchObject({ status: 400, body: { error: { code: 'BAD_STEP' } } });
    expect(await call('DELETE', `/api/cases/${caseId}/steps/0`)).toMatchObject({ status: 400, body: { error: { code: 'BAD_STEP' } } });
    expect((await call('DELETE', '/api/cases/no-such-case/steps/1')).status).toBe(404);
  });

  it('deletes an end check', async () => {
    await openSession();
    const caseId = await recordCase('Checks', [tapNetwork, pressBack], { picks: [0, 1] });
    const deleted = await call('DELETE', `/api/cases/${caseId}/expectations/1`);
    expect(deleted.status).toBe(200);
    const detail = deleted.body as CaseDetailResponse;
    expect(detail.case.expectations.map((item) => item.selector)).toEqual([{ kind: 'text', value: 'Connected devices' }]);
    expect(detail.case.steps).toHaveLength(2);
    expect(detail.case.editedAt).toEqual(expect.any(String));
    expect(detail.yaml.endsWith('- back\n- assertVisible:\n    text: "Connected devices"\n')).toBe(true);
    expect(await call('DELETE', `/api/cases/${caseId}/expectations/2`)).toMatchObject({ status: 400, body: { error: { code: 'BAD_STEP' } } });
    expect(await call('DELETE', `/api/cases/${caseId}/expectations/0`)).toMatchObject({ status: 400, body: { error: { code: 'BAD_STEP' } } });
  });

  it('duplicates a case with copies of its screenshots under a new id', async () => {
    await openSession();
    const caseId = await recordCase('Original', [tapNetwork, pressBack], { picks: [1] });
    // Muted and edited: the copy starts fresh on both.
    await call('PATCH', `/api/cases/${caseId}`, { muted: true });
    expect((await call('DELETE', `/api/cases/${caseId}/expectations/1`)).status).toBe(200);
    expect(await readCaseFile(caseId)).toMatchObject({ muted: true, editedAt: expect.any(String) });

    const copied = await call('POST', `/api/cases/${caseId}/duplicate`);
    expect(copied.status).toBe(200);
    const copy = copied.body as CaseDetailResponse;
    const copyId = copy.case.id;
    expect(copyId).not.toBe(caseId);
    expect(copy.case.name).toBe('Original (copy)');
    expect(copy.case.muted).toBeUndefined();
    expect(copy.case.editedAt).toBeUndefined();
    expect(copy.runs).toEqual([]);
    expect(copy.case.steps.map((step) => step.screenshot)).toEqual([`evidence/${copyId}/step-001.png`, `evidence/${copyId}/step-002.png`]);
    for (const file of ['step-001.png', 'step-002.png']) {
      expect((await readFile(join(dir, 'evidence', copyId, file))).equals(await readFile(join(dir, 'evidence', caseId, file)))).toBe(true);
    }
    expect(await readFile(join(dir, 'flows', `${copyId}.yaml`), 'utf8')).toBe(copy.yaml);
    expect(copy.yaml).toContain('name: Original (copy)\n');

    const named = (await call('POST', `/api/cases/${caseId}/duplicate`, { name: 'Second copy' })).body as CaseDetailResponse;
    expect(named.case.name).toBe('Second copy');
    expect(new Set([caseId, copyId, named.case.id]).size).toBe(3);

    // Each copy owns its screenshots: deleting one leaves the others whole.
    expect((await call('DELETE', `/api/cases/${copyId}`)).status).toBe(200);
    expect(await evidenceFiles(caseId)).toEqual(['step-001.png', 'step-002.png']);
    expect(await evidenceFiles(named.case.id)).toEqual(['step-001.png', 'step-002.png']);
    expect((await call('POST', '/api/cases/no-such-case/duplicate')).status).toBe(404);
  });

  it('splits at step N: the first N steps become a start case and the rest starts from it', async () => {
    await writeBlock('second.yaml', '- back\n');
    await openSession();
    const caseId = await recordCase('Long case', [tapNetwork, tapInternet, pressBack], { blocks: ['blocks/second.yaml'], picks: [1] });

    const split = await call('POST', `/api/cases/${caseId}/split`, { atStep: 2 });
    expect(split.status).toBe(200);
    const detail = split.body as CaseDetailResponse;
    const firstId = detail.parent!.id;
    expect(detail.parent).toEqual({ id: firstId, name: 'Long case, start' });

    const first = await readCaseFile(firstId);
    expect(first).toMatchObject({ name: 'Long case, start', preconditionBlocks: [{ file: 'blocks/second.yaml' }], expectations: [] });
    expect(first.startFrom).toBeUndefined();
    expect(stepRows(first.steps)).toEqual([
      [1, 'tap Network & internet', `evidence/${firstId}/step-001.png`],
      [2, 'tap Internet', `evidence/${firstId}/step-002.png`],
    ]);
    for (const file of ['step-001.png', 'step-002.png']) {
      expect((await readFile(join(dir, 'evidence', firstId, file))).equals(await readFile(join(dir, 'evidence', caseId, file)))).toBe(true);
    }
    expect(await readFile(join(dir, 'flows', `${firstId}.yaml`), 'utf8')).toBe(
      [
        'appId: com.android.settings',
        'name: Long case, start',
        '---',
        '- launchApp',
        '- runFlow:',
        '    file: ../blocks/second.yaml',
        '- tapOn:',
        '    text: "Network & internet"',
        '- tapOn:',
        '    text: "Internet"',
        '',
      ].join('\n'),
    );

    const rest = await readCaseFile(caseId);
    expect(rest).toMatchObject({ name: 'Long case', startFrom: firstId, preconditionBlocks: [] });
    expect(stepRows(rest.steps)).toEqual([[1, 'back', `evidence/${caseId}/step-003.png`]]);
    expect(rest.expectations.map((item) => item.selector)).toEqual([{ kind: 'text', value: 'Connected devices' }]);
    expect(rest.editedAt).toEqual(expect.any(String));
    expect(detail.yaml).toBe(
      [
        'appId: com.android.settings',
        'name: Long case',
        '---',
        '- runFlow:',
        `    file: ${firstId}.yaml`,
        '- back',
        '- assertVisible:',
        '    text: "Connected devices"',
        '',
      ].join('\n'),
    );
    expect(((await call('GET', `/api/cases/${firstId}`)).body as CaseDetailResponse).dependents).toEqual([{ id: caseId, name: 'Long case' }]);

    // Splitting a case that starts from a saved case keeps that start case.
    const again = (await call('POST', `/api/cases/${caseId}/split`, { atStep: 1, name: 'Go back' })).body as CaseDetailResponse;
    const secondId = again.parent!.id;
    expect(again.parent).toEqual({ id: secondId, name: 'Go back' });
    expect(await readCaseFile(secondId)).toMatchObject({ startFrom: firstId, preconditionBlocks: [], expectations: [] });
    expect(await readCaseFile(caseId)).toMatchObject({ startFrom: secondId, steps: [] });
    expect(((await call('GET', `/api/cases/${firstId}`)).body as CaseDetailResponse).dependents).toEqual([{ id: secondId, name: 'Go back' }]);
  });

  it('refuses split points outside the case', async () => {
    await openSession();
    const caseId = await recordCase('Two steps', [tapNetwork, tapInternet]);
    for (const atStep of [0, 3, -1, 1.5, 'one', undefined]) {
      expect(await call('POST', `/api/cases/${caseId}/split`, { atStep }), String(atStep)).toMatchObject({
        status: 400,
        body: { error: { code: 'BAD_STEP' } },
      });
    }
    expect((await call('POST', `/api/cases/${caseId}/split`, { atStep: 1, name: 'x'.repeat(201) })).status).toBe(400);
    expect((await call('POST', '/api/cases/no-such-case/split', { atStep: 1 })).status).toBe(404);
    expect(await readdir(join(dir, 'cases'))).toEqual([`${caseId}.json`]);
    expect((await readCaseFile(caseId)).steps).toHaveLength(2);
  });
});

describe('replay screenshots and reports', () => {
  /** Opens network, goes back, and checks "Connected devices" at the end. */
  async function recordReplayBase(): Promise<string> {
    await openSession();
    return recordCase('Replay me', [tapNetwork, pressBack], { picks: [1] });
  }

  async function replay(caseId: string): Promise<RunView> {
    const replayed = await call('POST', `/api/cases/${caseId}/replay`);
    expect(replayed.status).toBe(200);
    return replayed.body as RunView;
  }

  it('runs an instrumented copy of the flow and compares each replayed screen with the recorded one', async () => {
    const caseId = await recordReplayBase();
    // The screen after Back looks different on replay.
    maestro.shotScreens.set('after-003', 'login');
    const run = await replay(caseId);
    const runDir = join(dir, 'runs', run.runId);

    expect(maestro.calls).toHaveLength(1);
    expect(maestro.calls[0]!.sessionOpen).toBe(false);
    expect(maestro.calls[0]!.options).toMatchObject({ flowPath: join(runDir, 'flow.yaml'), debugDir: runDir, deviceId: DEVICE });
    expect(maestro.calls[0]!.yaml).toBe(
      [
        'appId: com.android.settings',
        'name: Replay me',
        '---',
        '- launchApp',
        '- tapOn:',
        '    text: "Network & internet"',
        '- takeScreenshot:',
        '    path: after-002',
        '    optional: true',
        '- back',
        '- takeScreenshot:',
        '    path: after-003',
        '    optional: true',
        '- assertVisible:',
        '    text: "Connected devices"',
        '- takeScreenshot:',
        '    path: after-004',
        '    optional: true',
        '',
      ].join('\n'),
    );
    expect(await readFile(join(runDir, 'flow.yaml'), 'utf8')).toBe(maestro.calls[0]!.yaml);
    expect(await readFile(join(dir, 'flows', `${caseId}.yaml`), 'utf8')).not.toContain('takeScreenshot');

    expect(run).toMatchObject({
      caseId,
      passed: true,
      exitCode: 0,
      ranFlowFile: `runs/${run.runId}/flow.yaml`,
      reportUrl: `/api/runs/${run.runId}/report`,
      stale: false,
    });
    const shots = `runs/${run.runId}/Replay me/takeScreenshot`;
    const shotUrl = (name: string) => `/api/runs/${run.runId}/shots/${name}`;
    expect(run.steps).toMatchObject([
      { flowIndex: 0, status: 'passed', step: { kind: 'launchApp' } },
      { flowIndex: 1, status: 'passed', replayScreenshot: `${shots}/after-002.png`, replayScreenshotUrl: shotUrl('after-002'), similarity: 100 },
      { flowIndex: 2, status: 'passed', replayScreenshot: `${shots}/after-003.png`, replayScreenshotUrl: shotUrl('after-003') },
      { flowIndex: 3, status: 'passed', replayScreenshot: `${shots}/after-004.png`, replayScreenshotUrl: shotUrl('after-004') },
    ]);
    // No screenshot follows launchApp; an end check has no recorded screen to compare with.
    expect(run.steps[0]!.replayScreenshot).toBeUndefined();
    expect(run.steps[2]!.similarity).toBeLessThan(LOOKS_DIFFERENT_BELOW);
    expect(run.steps[3]!.similarity).toBeUndefined();

    const summary = JSON.parse(await readFile(join(runDir, 'summary.json'), 'utf8'));
    expect(summary.steps).toEqual(run.steps.map(({ replayScreenshotUrl: _url, ...step }) => step));
    expect((await call('GET', `/api/runs/${run.runId}`)).body).toEqual(run);
  });

  it('points runFlow at the start case and blocks from inside the run directory', async () => {
    await writeBlock('second.yaml', '- back\n');
    await openSession();
    const parent = await recordCase('Parent', [tapNetwork], { blocks: ['blocks/second.yaml'] });
    const child = await recordCase('Child', [tapInternet], { startFrom: parent });

    const childRun = await replay(child);
    expect(childRun.passed).toBe(true);
    expect(maestro.calls[0]!.yaml).toContain(`- runFlow:\n    file: ../../flows/${parent}.yaml\n- takeScreenshot:\n    path: after-001\n`);
    expect(childRun.steps.map((step) => [step.status, step.replayScreenshot?.split('/').pop(), step.similarity])).toEqual([
      ['passed', 'after-001.png', undefined],
      ['passed', 'after-002.png', 100],
    ]);
    const parentRun = await replay(parent);
    expect(parentRun.passed).toBe(true);
    expect(maestro.calls[1]!.yaml).toContain('- runFlow:\n    file: ../../blocks/second.yaml\n- takeScreenshot:\n    path: after-002\n');
  });

  it('serves replay screenshots by name and refuses bad names and paths outside the run', async () => {
    const caseId = await recordReplayBase();
    const run = await replay(caseId);
    const step = run.steps[1]!;
    const shot = await app.inject({ method: 'GET', url: step.replayScreenshotUrl! });
    expect(shot.statusCode).toBe(200);
    expect(shot.headers['content-type']).toBe('image/png');
    expect(shot.rawPayload.equals(await readFile(join(dir, step.replayScreenshot!)))).toBe(true);

    const base = `/api/runs/${run.runId}/shots`;
    for (const name of ['after-2', 'step-001', 'after-002.png', '..%2Fsummary', '..%2F..%2F..%2Fcases%2Fx', 'after-002%2F..', '%2Fetc%2Fpasswd']) {
      expect((await call('GET', `${base}/${name}`)).status, name).toBe(400);
    }
    expect((await call('GET', `${base}/after-999`)).status).toBe(404);
    expect((await call('GET', `/api/runs/..%2F${run.runId}/shots/after-002`)).status).toBe(400);
    expect((await call('GET', '/api/runs/no-such-run/shots/after-002')).status).toBe(404);

    // A summary edited to point somewhere else is not followed, even to a file that exists.
    const summaryPath = join(dir, 'runs', run.runId, 'summary.json');
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    summary.steps[1].replayScreenshot = `evidence/${caseId}/after-002.png`;
    summary.steps[2].replayScreenshot = '../outside/after-003.png';
    await writeFile(summaryPath, JSON.stringify(summary));
    await writeFile(join(dir, 'evidence', caseId, 'after-002.png'), IMAGES.home);
    expect(await call('GET', `${base}/after-002`)).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
    expect(await call('GET', `${base}/after-003`)).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
  });

  it('writes a self-contained HTML report with recorded and replayed screens side by side', async () => {
    const caseId = await recordReplayBase();
    maestro.shotScreens.set('after-003', 'login');
    const run = await replay(caseId);
    const report = await app.inject({ method: 'GET', url: run.reportUrl });
    expect(report.statusCode).toBe(200);
    expect(report.headers['content-type']).toBe('text/html; charset=utf-8');
    const html = report.body;
    expect(html).toContain('<h1>Replay me</h1>');
    expect(html).toContain(run.runId);
    // Two steps with both screens, plus the replayed screen after the end check.
    expect(inlinedImages(html)).toBe(5);
    expect(html).not.toMatch(/src="(?!data:)/);
    expect(html).toContain('100% alike');
    expect(html).toContain('looks different');
    expect(await readFile(join(dir, 'runs', run.runId, 'report.html'), 'utf8')).toBe(html);
    expect((await call('GET', '/api/runs/no-such-run/report')).status).toBe(404);
    expect((await call('GET', '/api/runs/Bad..Id/report')).status).toBe(400);
  });

  it('marks runs that started before the last edit as stale', async () => {
    const caseId = await recordReplayBase();
    const run = await replay(caseId);
    expect(run.stale).toBe(false);
    expect(((await call('GET', `/api/cases/${caseId}`)).body as CaseDetailResponse).health).toMatchObject({
      status: 'passed',
      stale: false,
      recent: [{ runId: run.runId, passed: true }],
    });

    // A rename keeps runs current; deleting an end check does not.
    await call('PATCH', `/api/cases/${caseId}`, { name: 'Renamed' });
    expect(((await call('GET', `/api/runs/${run.runId}`)).body as RunView).stale).toBe(false);
    await call('DELETE', `/api/cases/${caseId}/expectations/1`);
    expect(((await call('GET', `/api/runs/${run.runId}`)).body as RunView).stale).toBe(true);
    const detail = (await call('GET', `/api/cases/${caseId}`)).body as CaseDetailResponse;
    expect(detail.runs.map((item) => [item.runId, item.stale])).toEqual([[run.runId, true]]);
    expect(detail.health).toMatchObject({ status: 'never', stale: true, recent: [] });
    expect((await app.inject({ method: 'GET', url: run.reportUrl })).body).toContain('The case was edited after this run.');

    const next = await replay(caseId);
    expect(next.stale).toBe(false);
    const project = (await call('GET', '/api/project')).body as ProjectInfo;
    expect(project.cases[0]!.health).toMatchObject({ status: 'passed', stale: false, recent: [{ runId: next.runId }] });
  });

  it('blames the step that was still running when Maestro stopped', async () => {
    const caseId = await recordReplayBase();
    maestro.breaks.set('Replay me', ['RUNNING']);
    const run = await replay(caseId);
    expect(run.passed).toBe(false);
    expect(run.steps.map((step) => step.status)).toEqual(['passed', 'failed', 'not-run', 'not-run']);
    expect(run.steps[1]!.error).toBeUndefined();
    expect(run.error).toMatch(/during step 2\b/);
    expect(run.error).toContain(`runs/${run.runId}/output.txt`);
  });
});

describe('run all', () => {
  it('runs every case parent first, skips muted ones, retries a failure once and saves the suite', async () => {
    // Created before its start case, so only the start-from tree puts it second.
    await saveCase('child', 'Child', '2026-10-01T10:00:00.000Z', { startFrom: 'root', steps: [tapStep(1, 'Internet')] });
    await saveCase('root', 'Root', '2026-10-02T10:00:00.000Z');
    await saveCase('quiet', 'Quiet', '2026-10-03T10:00:00.000Z', { muted: true });
    await saveCase('broken', 'Broken', '2026-10-04T10:00:00.000Z', {
      expectations: [{ selector: { kind: 'text', value: 'Nope' }, at: LONG_AGO }],
    });
    maestro.breaks.set('Child', ['FAILED']);
    await openSession();
    const opens = device.opens;
    maestro.hold();

    const started = await call('POST', '/api/suite/run');
    expect(started.status).toBe(202);
    const suiteId = (started.body as SuiteView).suiteId;
    expect(suiteId).toMatch(/^suite-\d{8}-\d{6}$/);
    expect(started.body).toMatchObject({ status: 'running', retryFailed: true, deviceId: DEVICE, reportUrl: `/api/suites/${suiteId}/report` });
    expect((started.body as SuiteView).cases.map((item) => [item.caseId, item.name])).toEqual([
      ['root', 'Root'],
      ['child', 'Child'],
      ['quiet', 'Quiet'],
      ['broken', 'Broken'],
    ]);
    expect((started.body as SuiteView).cases[2]!.outcome).toBe('muted');

    await until(async () => maestro.calls.length, (count) => count === 1);
    const running = await currentSuite();
    expect(running.status).toBe('running');
    expect(running.cases[0]!.outcome).toBe('running');
    expect((await call('GET', '/api/session')).body).toEqual({ open: false });
    expect(((await call('GET', '/api/project')).body as ProjectInfo).suiteRunning).toBe(true);
    expect((await call('GET', '/api/cases/root')).status).toBe(200);
    for (const [method, url, payload] of [
      ['POST', '/api/suite/run', undefined],
      ['POST', '/api/session/open', { deviceId: DEVICE, appId: APP }],
      ['POST', '/api/session/close', undefined],
      ['POST', '/api/case/start', { name: 'New' }],
      ['POST', '/api/action/tap', { x: 1, y: 1 }],
      ['POST', '/api/cases/root/replay', undefined],
      ['POST', '/api/cases/root/edit', { mode: 'rerecord', step: 1 }],
      ['PATCH', '/api/cases/root', { name: 'Renamed' }],
      ['PUT', '/api/project', { appId: 'com.example' }],
      ['DELETE', '/api/cases/broken', undefined],
    ] as const) {
      expect(await call(method, url, payload), `${method} ${url}`).toMatchObject({ status: 409, body: { error: { code: 'SUITE_RUNNING' } } });
    }
    expect(existsSync(join(dir, 'cases', 'broken.json'))).toBe(true);

    maestro.release();
    const done = await finishedSuite();
    expect(done).toMatchObject({
      suiteId,
      status: 'finished',
      passed: false,
      counts: { passed: 1, flaky: 1, muted: 1, failed: 1, pending: 0, running: 0, error: 0 },
    });
    expect(done.finishedAt).toEqual(expect.any(String));
    expect(done.cases.map((item) => [item.caseId, item.outcome, item.runIds.length])).toEqual([
      ['root', 'passed', 1],
      ['child', 'flaky', 2],
      ['quiet', 'muted', 0],
      ['broken', 'failed', 2],
    ]);
    expect(done.cases[1]!.failedStep).toBeUndefined();
    expect(done.cases[3]!.failedStep).toBe('Check that "Nope" is visible');
    expect(maestro.calls.map((item) => item.name)).toEqual(['Root', 'Child', 'Child', 'Broken', 'Broken']);
    expect(maestro.calls.every((item) => !item.sessionOpen)).toBe(true);

    const { counts: _counts, passed: _passed, reportUrl: _reportUrl, ...suite } = done;
    expect(JSON.parse(await readFile(join(dir, 'runs', '_suites', `${suiteId}.json`), 'utf8'))).toEqual(suite);
    const childRuns: RunView[] = [];
    for (const runId of done.cases[1]!.runIds) childRuns.push((await call('GET', `/api/runs/${runId}`)).body as RunView);
    expect(childRuns.map((run) => [run.suiteId, run.attempt, run.passed])).toEqual([
      [suiteId, 1, false],
      [suiteId, 2, true],
    ]);

    // The session is handed back once, after the last case.
    expect((await call('GET', '/api/session')).body).toEqual({ open: true, deviceId: DEVICE, appId: APP });
    expect(device.opens).toBe(opens + 1);
    expect(((await call('GET', '/api/suites')).body as SuiteView[]).map((item) => [item.suiteId, item.status])).toEqual([[suiteId, 'finished']]);

    const report = await app.inject({ method: 'GET', url: done.reportUrl });
    expect(report.statusCode).toBe(200);
    expect(report.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(report.body).toContain('flaky (2 attempts)');
    expect(report.body).toContain('failed (2 attempts)');
    expect(report.body).toContain('Failed at: Check that &quot;Nope&quot; is visible');
    // Only the failed case has a screen to show.
    expect(inlinedImages(report.body)).toBe(1);

    const project = (await call('GET', '/api/project')).body as ProjectInfo;
    expect(project.suiteRunning).toBe(false);
    const byId = new Map(project.cases.map((item) => [item.id, item]));
    expect(byId.get('root')).toMatchObject({ dependents: 1, health: { status: 'passed', flaky: false, failedRecently: 0 } });
    expect(byId.get('child')).toMatchObject({ dependents: 0, health: { status: 'passed', flaky: true, failedRecently: 1 } });
    expect(byId.get('child')!.health.recent.map((dot) => [dot.passed, dot.suiteId])).toEqual([
      [true, suiteId],
      [false, suiteId],
    ]);
    expect(byId.get('quiet')).toMatchObject({ muted: true, dependents: 0, health: { status: 'never', recent: [], flaky: false } });
    expect(byId.get('broken')).toMatchObject({ health: { status: 'failed', flaky: false, failedRecently: 2 } });
  });

  it('stops after the case that is running and hands the device back', async () => {
    await saveCase('first', 'First', '2026-10-01T10:00:00.000Z');
    await saveCase('second', 'Second', '2026-10-02T10:00:00.000Z');
    await saveCase('third', 'Third', '2026-10-03T10:00:00.000Z');
    await openSession();
    expect(await call('POST', '/api/suite/stop')).toMatchObject({ status: 409, body: { error: { code: 'NO_SUITE' } } });
    maestro.hold();
    const started = (await call('POST', '/api/suite/run')).body as SuiteView;
    await until(async () => maestro.calls.length, (count) => count === 1);

    const stopping = await call('POST', '/api/suite/stop');
    expect(stopping).toMatchObject({ status: 200, body: { suiteId: started.suiteId, status: 'running' } });
    maestro.release();
    const done = await finishedSuite();
    expect(done.status).toBe('stopped');
    expect(done.cases.map((item) => item.outcome)).toEqual(['passed', 'pending', 'pending']);
    expect(done.passed).toBe(false);
    expect(maestro.calls.map((item) => item.name)).toEqual(['First']);
    expect((await call('GET', '/api/session')).body).toMatchObject({ open: true, deviceId: DEVICE });
    expect((await app.inject({ method: 'GET', url: done.reportUrl })).body).toContain('(stopped before the end)');
    expect(await call('POST', '/api/suite/stop')).toMatchObject({ status: 409, body: { error: { code: 'NO_SUITE' } } });
    // The device is free again.
    expect((await pressBack()).status).toBe(200);
  });

  it('refuses to start with no saved cases or while recording, and runs a failure once without retry', async () => {
    await openSession();
    expect(await call('GET', '/api/suite/current')).toEqual({ status: 200, body: null });
    expect(await call('POST', '/api/suite/run')).toMatchObject({ status: 400, body: { error: { code: 'NO_CASES' } } });
    await saveCase('broken', 'Broken', '2026-10-01T10:00:00.000Z', { expectations: [{ selector: { kind: 'text', value: 'Nope' }, at: LONG_AGO }] });
    await call('POST', '/api/case/start', { name: 'Busy' });
    expect(await call('POST', '/api/suite/run')).toMatchObject({ status: 409, body: { error: { code: 'CASE_ACTIVE' } } });
    await call('POST', '/api/case/discard');

    const started = await call('POST', '/api/suite/run', { retryFailed: false });
    expect(started).toMatchObject({ status: 202, body: { retryFailed: false } });
    const done = await finishedSuite();
    expect(done.cases).toMatchObject([{ caseId: 'broken', outcome: 'failed', runIds: [expect.any(String)] }]);
    expect(maestro.calls).toHaveLength(1);
    expect((await call('GET', '/api/suites/suite-19990101-000000/report')).status).toBe(404);
    expect((await call('GET', '/api/suites/Bad..Id/report')).status).toBe(400);
  });

  // Source bug: suite ids have one-second resolution and, unlike case and run
  // ids, are not made unique, so a second Run all that starts in the same
  // second (easy when every case is muted or errors at once) overwrites
  // runs/_suites/<suiteId>.json and the first result is lost.
  it('keeps both results of two Run all that start in the same second', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T10:15:42.000Z') });
    await saveCase('quiet', 'Quiet', '2026-10-01T10:00:00.000Z', { muted: true });
    await openSession();
    const first = (await call('POST', '/api/suite/run')).body as SuiteView;
    await finishedSuite();
    const second = (await call('POST', '/api/suite/run')).body as SuiteView;
    await finishedSuite();
    expect(second.suiteId).not.toBe(first.suiteId);
    expect((await call('GET', '/api/suites')).body).toHaveLength(2);
  });
});

describe('test case documents', () => {
  it('exports one case as Markdown, HTML and an Excel workbook under exports/', async () => {
    await openSession();
    const caseId = await recordCase('Export me', [tapNetwork, pressBack], { picks: [1] });
    await call('PATCH', `/api/cases/${caseId}/steps/1`, { title: 'Open the network page', note: 'Internet and SIMs are listed' });
    const get = (format: string) => app.inject({ method: 'GET', url: `/api/cases/${caseId}/export?format=${format}` });

    const md = await get('md');
    expect(md.statusCode).toBe(200);
    expect(md.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(md.headers['content-disposition']).toBe(`attachment; filename="${caseId}.md"`);
    expect(md.body).toContain('# Export me\n');
    expect(md.body).toContain(`| 1 | Open the network page | Internet and SIMs are listed | ![Screen after step 1](../evidence/${caseId}/step-001.png) |`);
    expect(md.body).toContain(`| 2 | Press Back |  | ![Screen after step 2](../evidence/${caseId}/step-002.png) |`);
    expect(md.body).toContain('- "Connected devices" is visible');
    expect(await readFile(join(dir, 'exports', `${caseId}.md`), 'utf8')).toBe(md.body);
    // The links work from where the file is written.
    expect(existsSync(join(dir, 'exports', '..', 'evidence', caseId, 'step-001.png'))).toBe(true);

    const html = await get('html');
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(html.headers['content-disposition']).toBe(`attachment; filename="${caseId}.html"`);
    expect(html.body).toContain('Open the network page');
    expect(inlinedImages(html.body)).toBe(2);
    expect(html.body).toContain(`src="data:image/png;base64,${(await readFile(join(dir, 'evidence', caseId, 'step-001.png'))).toString('base64')}"`);
    expect(html.body).not.toMatch(/src="(?!data:)/);
    expect(await readFile(join(dir, 'exports', `${caseId}.html`), 'utf8')).toBe(html.body);

    const xlsx = await get('xlsx');
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(xlsx.headers['content-disposition']).toBe(`attachment; filename="${caseId}.xlsx"`);
    expect(xlsx.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
    expect((await readFile(join(dir, 'exports', `${caseId}.xlsx`))).equals(xlsx.rawPayload)).toBe(true);
    const sheets = [...unzipTexts(xlsx.rawPayload)].filter(([name]) => name.startsWith('xl/')).map(([, text]) => text).join('\n');
    for (const text of ['Export me', 'Open the network page', 'Internet and SIMs are listed', `evidence/${caseId}/step-002.png`]) {
      expect(sheets, text).toContain(text);
    }

    expect(await readdir(join(dir, 'exports'))).toEqual([`${caseId}.html`, `${caseId}.md`, `${caseId}.xlsx`].sort());
    for (const format of ['pdf', 'MD', '']) {
      expect(await call('GET', `/api/cases/${caseId}/export?format=${format}`), format).toMatchObject({
        status: 400,
        body: { error: { code: 'BAD_FORMAT' } },
      });
    }
    expect((await call('GET', `/api/cases/${caseId}/export`)).status).toBe(400);
    expect((await call('GET', '/api/cases/no-such-case/export?format=md')).status).toBe(404);
  });

  it('exports every case, start cases first, and refuses unknown formats and empty projects', async () => {
    expect(await call('GET', '/api/export?format=md')).toMatchObject({ status: 400, body: { error: { code: 'NO_CASES' } } });
    await openSession();
    const caseId = await recordCase('Whole case', [tapNetwork, tapInternet]);
    // The start case made by a split is newer than the case that starts from it.
    const startId = ((await call('POST', `/api/cases/${caseId}/split`, { atStep: 1 })).body as CaseDetailResponse).parent!.id;

    const md = await app.inject({ method: 'GET', url: '/api/export?format=md' });
    expect(md.statusCode).toBe(200);
    expect(md.headers['content-disposition']).toBe('attachment; filename="test-cases.md"');
    expect(md.body.indexOf('# Whole case, start\n')).toBeGreaterThanOrEqual(0);
    expect(md.body.indexOf('# Whole case, start\n')).toBeLessThan(md.body.indexOf('# Whole case\n'));
    expect(md.body).toContain('\n---\n\n');
    expect(md.body).toContain('Do everything in the case "Whole case, start"');
    expect(md.body).toContain(`../evidence/${startId}/step-001.png`);
    expect(md.body).toContain(`../evidence/${caseId}/step-002.png`);

    const html = await app.inject({ method: 'GET', url: '/api/export?format=html' });
    expect(html.headers['content-disposition']).toBe('attachment; filename="test-cases.html"');
    expect(html.body).toContain('<title>Test cases for com.android.settings</title>');
    expect(inlinedImages(html.body)).toBe(2);

    const xlsx = await app.inject({ method: 'GET', url: '/api/export?format=xlsx' });
    expect(xlsx.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(xlsx.headers['content-disposition']).toBe('attachment; filename="test-cases.xlsx"');
    expect(xlsx.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
    const sheets = [...unzipTexts(xlsx.rawPayload).values()].join('\n');
    expect(sheets).toContain('Whole case, start');

    expect(await readdir(join(dir, 'exports'))).toEqual(['test-cases.html', 'test-cases.md', 'test-cases.xlsx']);
    expect(await call('GET', '/api/export?format=docx')).toMatchObject({ status: 400, body: { error: { code: 'BAD_FORMAT' } } });
    expect(await call('GET', '/api/export')).toMatchObject({ status: 400, body: { error: { code: 'BAD_FORMAT' } } });
  });
});

describe('project', () => {
  it('lists each case with its recent runs, status, flakiness and dependents', async () => {
    await openSession();
    const parent = await recordCase('Parent', [tapNetwork]);
    const child = await recordCase('Child', [tapInternet], { startFrom: parent });
    const first = (await call('POST', `/api/cases/${parent}/replay`)).body as RunView;
    maestro.breaks.set('Parent', ['FAILED']);
    const second = (await call('POST', `/api/cases/${parent}/replay`)).body as RunView;
    expect([first.passed, second.passed]).toEqual([true, false]);

    const project = (await call('GET', '/api/project')).body as ProjectInfo;
    expect(project.suiteRunning).toBe(false);
    const parentItem = project.cases.find((item) => item.id === parent)!;
    expect(parentItem).toMatchObject({
      name: 'Parent',
      stepCount: 1,
      dependents: 1,
      health: { status: 'failed', flaky: true, failedRecently: 1, stale: false },
    });
    expect(parentItem.health.recent.map((dot) => [dot.runId, dot.passed])).toEqual([
      [second.runId, false],
      [first.runId, true],
    ]);
    expect(project.cases.find((item) => item.id === child)).toMatchObject({
      startFrom: parent,
      dependents: 0,
      health: { status: 'never', recent: [], flaky: false, stale: false },
    });
  });
});

describe('device problems', () => {
  it('retries a single replay once when the device drops, and leaves that run out of the history', async () => {
    await openSession();
    const caseId = await recordCase('Drop once', [tapNetwork, pressBack]);
    maestro.offlineRuns = 1;
    const run = (await call('POST', `/api/cases/${caseId}/replay`)).body as RunView;
    expect(run).toMatchObject({ passed: true, attempt: 2 });
    expect(maestro.calls).toHaveLength(2);
    const detail = (await call('GET', `/api/cases/${caseId}`)).body as CaseDetailResponse;
    expect(detail.runs).toHaveLength(2);
    expect(detail.runs[1]).toMatchObject({ passed: false });
    expect(detail.runs[1]!.deviceProblem).toMatch(/connection to the device dropped/);
    expect(detail.health).toMatchObject({ status: 'passed', flaky: false, failedRecently: 0 });
    expect(detail.health.recent.map((dot) => dot.runId)).toEqual([run.runId]);
  });

  it('does not retry an app failure, and says plainly when the device failed twice', async () => {
    await openSession();
    const caseId = await recordCase('App fails', [tapNetwork]);
    maestro.breaks.set('App fails', ['FAILED']);
    const failed = (await call('POST', `/api/cases/${caseId}/replay`)).body as RunView;
    expect(failed.passed).toBe(false);
    expect(failed.deviceProblem).toBeUndefined();
    expect(maestro.calls).toHaveLength(1);

    maestro.offlineRuns = 2;
    const lost = (await call('POST', `/api/cases/${caseId}/replay`)).body as RunView;
    expect(lost).toMatchObject({ passed: false, attempt: 2 });
    expect(lost.deviceProblem).toMatch(/not a test failure/);
    expect(maestro.calls).toHaveLength(3);
  });

  it('says the phone stopped Maestro when the device log shows a blocked launch of the app', async () => {
    await openSession();
    const caseId = await recordCase('Blocked launch', [tapNetwork]);
    maestro.deviceLog =
      'D/ActivityStarterImpl( 2644): MIUILOG- Permission Denied Activity : Intent { act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] flg=0x10000000 pkg=com.android.settings cmp=com.android.settings/.MainSettings }\n';
    maestro.breaks.set('Blocked launch', ['FAILED', 'FAILED']);
    const run = (await call('POST', `/api/cases/${caseId}/replay`)).body as RunView;
    expect(run.passed).toBe(false);
    expect(run.deviceProblem).toMatch(/phone stopped Maestro from opening the app/);
    expect(run.deviceProblem).not.toMatch(/run it again/);
  });

  it('does not blame the device when the log shows another app being blocked', async () => {
    await openSession();
    const caseId = await recordCase('Other app blocked', [tapNetwork]);
    maestro.deviceLog =
      'W/ActivityTaskManager: Background activity launch blocked! [callingPackage: com.facebook.katana; callingUid: 10123]\nI/ActivityTaskManager: Abort background activity starts from 10690\n';
    maestro.breaks.set('Other app blocked', ['FAILED']);
    const run = (await call('POST', `/api/cases/${caseId}/replay`)).body as RunView;
    expect(run.passed).toBe(false);
    expect(run.deviceProblem).toBeUndefined();
    expect(maestro.calls).toHaveLength(1);
  });

  it('does not read the device log of a run that passed', async () => {
    await openSession();
    const caseId = await recordCase('Passes anyway', [tapNetwork]);
    maestro.deviceLog = 'W/ActivityTaskManager: Background activity launch blocked! [callingPackage: dev.mobile.maestro; callingUid: 10690]\n';
    const run = (await call('POST', `/api/cases/${caseId}/replay`)).body as RunView;
    expect(run.passed).toBe(true);
    expect(run.deviceProblem).toBeUndefined();
  });

  it('Run all retries a device drop without calling the case flaky', async () => {
    await openSession();
    const caseId = await recordCase('Suite drop', [tapNetwork, pressBack]);
    maestro.offlineRuns = 1;
    expect((await call('POST', '/api/suite/run', { retryFailed: false })).status).toBe(202);
    const suite = await finishedSuite();
    const item = suite.cases.find((entry) => entry.caseId === caseId)!;
    expect(item.outcome).toBe('passed');
    expect(item.runIds).toHaveLength(2);
    expect(item.note).toMatch(/retried: The connection to the device dropped/);
  });
});

describe('replaying steps agent-device cannot replay', () => {
  const header = ['appId: com.android.settings', '---'];

  it('re-records after keys, a rotation and a point double tap by doing those through the device session', async () => {
    await openSession();
    await saveCase('keys', 'Keys', LONG_AGO, {
      steps: [
        tapStep(1, 'Network & internet'),
        { index: 2, kind: 'pressKey', key: 'volumeUp', at: LONG_AGO },
        { index: 3, kind: 'orientation', value: 'landscape', at: LONG_AGO },
        { index: 4, kind: 'doubleTap', selector: { kind: 'point', xPercent: 10, yPercent: 20 }, point: { x: 108, y: 480 }, at: LONG_AGO },
        tapStep(5, 'Internet'),
        { index: 6, kind: 'back', at: LONG_AGO },
      ],
    });
    const edit = await call('POST', '/api/cases/keys/edit', { mode: 'rerecord', step: 6 });
    expect(edit.status).toBe(200);
    expect(device.replays.map((replay) => replay.yaml)).toEqual([
      [header[0], 'name: Keys', header[1], '- launchApp', '- tapOn:', '    text: "Network & internet"', ''].join('\n'),
      [header[0], 'name: Keys', header[1], '- tapOn:', '    text: "Internet"', ''].join('\n'),
    ]);
    expect(device.direct).toEqual(['key volumeUp', 'orientation landscape', 'doubleTap 108,480']);
    expect(existsSync(join(dir, 'flows', '.studio-partial-keys.yaml'))).toBe(false);
  });

  it('writes out the chain of a start case that has such steps, instead of running its flow', async () => {
    await openSession();
    await saveCase('parent', 'Parent', LONG_AGO, {
      steps: [tapStep(1, 'Network & internet'), { index: 2, kind: 'pressKey', key: 'volumeDown', at: LONG_AGO }],
    });
    const started = await call('POST', '/api/case/start', { name: 'Child', startFrom: 'parent' });
    expect(started.status).toBe(200);
    expect(device.replays.map((replay) => replay.yaml)).toEqual([
      [header[0], 'name: Parent', header[1], '- launchApp', '- tapOn:', '    text: "Network & internet"', ''].join('\n'),
    ]);
    expect(device.direct).toEqual(['key volumeDown']);
    expect(labelsOf(started.body.screen)).toEqual(['Internet', 'SIMs']);
    expect(existsSync(join(dir, 'flows', '.studio-partial-parent.yaml'))).toBe(false);
  });
});

describe('run video', () => {
  const VIDEO = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  async function setRunVideo(on: boolean): Promise<void> {
    expect((await call('PUT', '/api/project/run-video', { on })).status).toBe(200);
  }

  async function recordVideoBase(): Promise<string> {
    await openSession();
    return recordCase('Video me', [tapNetwork, pressBack]);
  }

  async function replay(caseId: string): Promise<RunView> {
    const replayed = await call('POST', `/api/cases/${caseId}/replay`);
    expect(replayed.status).toBe(200);
    return replayed.body as RunView;
  }

  /**
   * The fake Maestro reads flows with parseMaestroFlow, which does not know the
   * recording commands, so this runs the flow without them and then adds what
   * Maestro writes for them: top-level recording commands in commands.json and,
   * when `mp4` is given, the video under <flow name>/startRecording/.
   */
  function recordingRunner(options: { mp4?: Buffer; stopRuns?: boolean } = {}): void {
    const { mp4, stopRuns = true } = options;
    const plain = maestro.run;
    vi.spyOn(maestro, 'run').mockImplementation(async (run) => {
      const yaml = await readFile(run.flowPath, 'utf8');
      // Drops "- startRecording:" with its indented lines, and "- stopRecording".
      const bare = yaml
        .split('\n')
        .filter((line, index, lines) => {
          if (line === '- stopRecording' || line === '- startRecording:') return false;
          let start = index;
          while (start > 0 && lines[start]!.startsWith('    ')) start--;
          return lines[start] !== '- startRecording:';
        })
        .join('\n');
      const barePath = join(dirname(run.flowPath), 'flow-bare.yaml');
      await writeFile(barePath, bare, 'utf8');
      const result = await plain({ ...run, flowPath: barePath });
      const flowDir = join(run.debugDir, parseMaestroFlow(bare).name ?? 'flow');
      const commandsFile = join(flowDir, 'commands.json');
      const entries = JSON.parse(await readFile(commandsFile, 'utf8')) as unknown[];
      const withRecording = [
        ...entries.slice(0, 2),
        commandEntry('startRecordingCommand', { path: 'run-video' }, 90, 0, 'COMPLETED'),
        ...entries.slice(2),
        ...(stopRuns ? [commandEntry('stopRecordingCommand', {}, 91, 0, 'COMPLETED')] : []),
      ];
      await writeFile(commandsFile, JSON.stringify(withRecording, null, 2));
      if (mp4) {
        await mkdir(join(flowDir, 'startRecording'), { recursive: true });
        await writeFile(join(flowDir, 'startRecording', 'run-video.mp4'), mp4);
      }
      return result;
    });
  }

  it('reports runVideo false by default', async () => {
    const project = (await call('GET', '/api/project')).body as ProjectInfo;
    expect(project.runVideo).toBe(false);
  });

  it('turns the run video on and off in project.json and returns the project', async () => {
    const on = await call('PUT', '/api/project/run-video', { on: true });
    expect(on.status).toBe(200);
    expect((on.body as ProjectInfo).runVideo).toBe(true);
    expect(JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))).toMatchObject({ runVideo: true });
    expect(((await call('GET', '/api/project')).body as ProjectInfo).runVideo).toBe(true);

    const off = await call('PUT', '/api/project/run-video', { on: false });
    expect(off.status).toBe(200);
    expect((off.body as ProjectInfo).runVideo).toBe(false);
    expect(JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))).toMatchObject({ runVideo: false });
  });

  it('rejects a run video setting that is not a boolean, and leaves the setting alone', async () => {
    await setRunVideo(true);
    for (const payload of [{ on: 'true' }, { on: 1 }, { on: null }, { other: true }]) {
      const response = await call('PUT', '/api/project/run-video', payload);
      expect(response.status, JSON.stringify(payload)).toBe(400);
    }
    expect((await call('PUT', '/api/project/run-video')).status).toBe(400);
    expect(((await call('GET', '/api/project')).body as ProjectInfo).runVideo).toBe(true);
  });

  it('runs a flow with startRecording first and stopRecording last when the video is on, and keeps them out of flows/', async () => {
    const caseId = await recordVideoBase();
    await setRunVideo(true);
    recordingRunner();
    const run = await replay(caseId);
    const ran = await readFile(join(dir, 'runs', run.runId, 'flow.yaml'), 'utf8');
    expect(ran).toContain('- startRecording:\n    path: run-video\n    optional: true\n');
    expect(ran.trimEnd().endsWith('- stopRecording')).toBe(true);
    expect(ran.indexOf('startRecording')).toBeLessThan(ran.indexOf('- launchApp'));
    const committed = await readFile(join(dir, 'flows', `${caseId}.yaml`), 'utf8');
    expect(committed).not.toContain('startRecording');
    expect(committed).not.toContain('stopRecording');
  });

  it('runs a flow with no recording commands when the video is off', async () => {
    const caseId = await recordVideoBase();
    const run = await replay(caseId);
    const ran = await readFile(join(dir, 'runs', run.runId, 'flow.yaml'), 'utf8');
    expect(ran).not.toContain('startRecording');
    expect(ran).not.toContain('stopRecording');
    expect(run.videoUrl).toBeUndefined();
    const committed = await readFile(join(dir, 'flows', `${caseId}.yaml`), 'utf8');
    expect(committed).not.toContain('Recording');
  });

  it('moves the video Maestro saved to runs/<runId>/video.mp4 and links it, with steps still lined up', async () => {
    const caseId = await recordVideoBase();
    await setRunVideo(true);
    recordingRunner({ mp4: VIDEO });
    const run = await replay(caseId);
    expect(run.passed).toBe(true);
    expect(run.videoUrl).toBe(`/api/runs/${run.runId}/video.mp4`);
    const summary = JSON.parse(await readFile(join(dir, 'runs', run.runId, 'summary.json'), 'utf8')) as { video?: string };
    expect(summary.video).toBe(`runs/${run.runId}/video.mp4`);
    expect(await readFile(join(dir, 'runs', run.runId, 'video.mp4'))).toEqual(VIDEO);
    expect(existsSync(join(dir, 'runs', run.runId, 'Video me', 'startRecording', 'run-video.mp4'))).toBe(false);
    // Recording commands do not count as steps.
    expect(run.steps.map((step) => step.status)).toEqual(['passed', 'passed', 'passed']);
    expect(run.steps.some((step) => step.warning)).toBe(false);
  });

  it('succeeds without a video when none was written', async () => {
    const caseId = await recordVideoBase();
    await setRunVideo(true);
    recordingRunner();
    const run = await replay(caseId);
    expect(run.passed).toBe(true);
    expect(run.videoUrl).toBeUndefined();
    const summary = JSON.parse(await readFile(join(dir, 'runs', run.runId, 'summary.json'), 'utf8')) as object;
    expect(summary).not.toHaveProperty('video');
    expect((await call('GET', `/api/runs/${run.runId}/video.mp4`)).status).toBe(404);
  });

  it('keeps the video of a failed run and still blames the failing step', async () => {
    const caseId = await recordVideoBase();
    await setRunVideo(true);
    maestro.breaks.set('Video me', ['FAILED']);
    recordingRunner({ mp4: VIDEO, stopRuns: false });
    const run = await replay(caseId);
    expect(run.passed).toBe(false);
    expect(run.steps.map((step) => step.status)).toEqual(['passed', 'failed', 'not-run']);
    expect(run.videoUrl).toBe(`/api/runs/${run.runId}/video.mp4`);
    expect(await readFile(join(dir, 'runs', run.runId, 'video.mp4'))).toEqual(VIDEO);
  });

  describe('framing the video with the steps', () => {
    /** Starts the studio again on the same project with these tools in place of the defaults. */
    async function rebuild(tools: Partial<MaestroTools>): Promise<void> {
      await app.close();
      app = await buildServer({
        projectDir: dir,
        session: device,
        maestro: { run: (options) => maestro.run(options), findBin: () => '/opt/maestro/bin/maestro', androidHome: () => undefined, ...tools },
      });
    }

    async function framedRun(tools: Partial<MaestroTools>, options: { video?: boolean } = {}): Promise<RunView> {
      const caseId = await recordVideoBase();
      await rebuild(tools);
      if (options.video !== false) await setRunVideo(true);
      recordingRunner({ mp4: VIDEO });
      return replay(caseId);
    }

    it('hands the kept video, the case and the commands to frameVideo once, and still reports the video', async () => {
      const inputs: FrameRunVideoInput[] = [];
      const frameVideo = vi.fn(async (input: FrameRunVideoInput) => {
        inputs.push(input);
      });
      const run = await framedRun({ findFfmpeg: () => '/fake/ffmpeg', frameVideo });
      expect(frameVideo).toHaveBeenCalledTimes(1);
      const input = inputs[0]!;
      expect(input).toMatchObject({
        video: join(dir, 'runs', run.runId, 'video.mp4'),
        caseName: 'Video me',
        appId: APP,
        device: DEVICE,
        passed: true,
        ffmpeg: '/fake/ffmpeg',
      });
      expect(input.rows.map((row) => row.number)).toEqual([1, 2, 3]);
      expect(input.rows[1]!.label).toContain('Network & internet');
      expect(input.rows.map((row) => row.status)).toEqual(['passed', 'passed', 'passed']);
      expect(input.rows.every((row) => typeof row.startedAt === 'number')).toBe(true);
      const names = input.commands.map((command) => command.name);
      expect(names).toContain('startRecordingCommand');
      expect(names).toContain('stopRecordingCommand');
      expect(run.passed).toBe(true);
      expect(run.videoUrl).toBe(`/api/runs/${run.runId}/video.mp4`);
    });

    it('keeps the phone video and the run when frameVideo throws', async () => {
      const frameVideo = vi.fn(async () => {
        throw new Error('ffmpeg fell over');
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const run = await framedRun({ findFfmpeg: () => '/fake/ffmpeg', frameVideo });
      expect(frameVideo).toHaveBeenCalledTimes(1);
      expect(run.passed).toBe(true);
      expect(run.videoUrl).toBe(`/api/runs/${run.runId}/video.mp4`);
      expect(await readFile(join(dir, 'runs', run.runId, 'video.mp4'))).toEqual(VIDEO);
      const summary = JSON.parse(await readFile(join(dir, 'runs', run.runId, 'summary.json'), 'utf8')) as { video?: string };
      expect(summary.video).toBe(`runs/${run.runId}/video.mp4`);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('ffmpeg fell over'));
    });

    it('does not call frameVideo when there is no ffmpeg', async () => {
      const frameVideo = vi.fn(async () => undefined);
      const run = await framedRun({ findFfmpeg: () => undefined, frameVideo });
      expect(frameVideo).not.toHaveBeenCalled();
      expect(run.videoUrl).toBe(`/api/runs/${run.runId}/video.mp4`);
      expect(await readFile(join(dir, 'runs', run.runId, 'video.mp4'))).toEqual(VIDEO);
    });

    it('does not call frameVideo when the run video is off', async () => {
      const frameVideo = vi.fn(async () => undefined);
      const run = await framedRun({ findFfmpeg: () => '/fake/ffmpeg', frameVideo }, { video: false });
      expect(frameVideo).not.toHaveBeenCalled();
      expect(run.videoUrl).toBeUndefined();
    });

    it('does not call frameVideo when Maestro saved no video', async () => {
      const frameVideo = vi.fn(async () => undefined);
      const caseId = await recordVideoBase();
      await rebuild({ findFfmpeg: () => '/fake/ffmpeg', frameVideo });
      await setRunVideo(true);
      recordingRunner();
      const run = await replay(caseId);
      expect(run.videoUrl).toBeUndefined();
      expect(frameVideo).not.toHaveBeenCalled();
    });

    it('reports videoHasSteps according to whether ffmpeg is found', async () => {
      expect(((await call('GET', '/api/project')).body as ProjectInfo).videoHasSteps).toBe(false);
      await rebuild({ findFfmpeg: () => '/fake/ffmpeg' });
      expect(((await call('GET', '/api/project')).body as ProjectInfo).videoHasSteps).toBe(true);
      await rebuild({ findFfmpeg: () => undefined });
      expect(((await call('GET', '/api/project')).body as ProjectInfo).videoHasSteps).toBe(false);
    });

    it('hides .env values in the error text it hands to frameVideo', async () => {
      const secret = 'hunter2-s3cret-value';
      await writeFile(join(dir, '.env'), `PASSWORD=${secret}\n`);
      const inputs: FrameRunVideoInput[] = [];
      const frameVideo = vi.fn(async (input: FrameRunVideoInput) => {
        inputs.push(input);
      });
      const caseId = await recordVideoBase();
      await rebuild({ findFfmpeg: () => '/fake/ffmpeg', frameVideo });
      await setRunVideo(true);
      maestro.breaks.set('Video me', ['FAILED']);
      recordingRunner({ mp4: VIDEO, stopRuns: false });
      // Maestro echoes evaluated commands, so a failure can quote a typed password.
      const recorded = vi.mocked(maestro.run).getMockImplementation()!;
      vi.mocked(maestro.run).mockImplementation(async (run) => {
        const result = await recorded(run);
        const commandsFile = join(run.debugDir, 'Video me', 'commands.json');
        const text = (await readFile(commandsFile, 'utf8')).replaceAll('made to fail by the test', `typed ${secret} and it failed`);
        await writeFile(commandsFile, text);
        return result;
      });
      const run = await replay(caseId);
      expect(run.passed).toBe(false);
      expect(frameVideo).toHaveBeenCalledTimes(1);
      const failed = inputs[0]!.rows.find((row) => row.status === 'failed');
      expect(failed?.error).toContain('typed ${PASSWORD} and it failed');
      expect(JSON.stringify(inputs[0]!.rows)).not.toContain(secret);
    });
  });

  describe('GET /api/runs/:runId/video.mp4', () => {
    async function videoRun(): Promise<RunView> {
      const caseId = await recordVideoBase();
      await setRunVideo(true);
      recordingRunner({ mp4: VIDEO });
      return replay(caseId);
    }

    async function fetchVideo(runId: string, range?: string) {
      return app.inject({ method: 'GET', url: `/api/runs/${runId}/video.mp4`, ...(range ? { headers: { range } } : {}) });
    }

    it('sends the whole file with its type and byte-range support', async () => {
      const run = await videoRun();
      const response = await fetchVideo(run.runId);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('video/mp4');
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(response.rawPayload).toEqual(VIDEO);
    });

    it('answers a byte range with 206 and exactly those bytes', async () => {
      const run = await videoRun();
      const response = await fetchVideo(run.runId, 'bytes=2-5');
      expect(response.statusCode).toBe(206);
      expect(response.headers['content-range']).toBe('bytes 2-5/10');
      expect(response.headers['content-length']).toBe('4');
      expect(response.rawPayload).toEqual(VIDEO.subarray(2, 6));
    });

    it('answers an open-ended range through the last byte', async () => {
      const run = await videoRun();
      const response = await fetchVideo(run.runId, 'bytes=4-');
      expect(response.statusCode).toBe(206);
      expect(response.headers['content-range']).toBe('bytes 4-9/10');
      expect(response.rawPayload).toEqual(VIDEO.subarray(4));
    });

    it('clamps a range that ends past the file', async () => {
      const run = await videoRun();
      const response = await fetchVideo(run.runId, 'bytes=6-500');
      expect(response.statusCode).toBe(206);
      expect(response.headers['content-range']).toBe('bytes 6-9/10');
      expect(response.rawPayload).toEqual(VIDEO.subarray(6));
    });

    it('sends the whole file with 200 for a range it cannot read or that starts past the end', async () => {
      const run = await videoRun();
      for (const range of ['bytes=abc', 'items=1-2', 'bytes=-3', 'bytes=1-2,4-5', 'bytes=10-', 'bytes=50-60', 'bytes=5-2']) {
        const response = await fetchVideo(run.runId, range);
        expect(response.statusCode, range).toBe(200);
        expect(response.headers['content-range'], range).toBeUndefined();
        expect(response.rawPayload, range).toEqual(VIDEO);
      }
    });

    it('returns 404 for a run without a video and for an unknown run', async () => {
      const caseId = await recordVideoBase();
      const run = await replay(caseId);
      expect((await fetchVideo(run.runId)).statusCode).toBe(404);
      expect((await fetchVideo('no-such-run-20261101-000000')).statusCode).toBe(404);
    });

    it('returns 404 when the summary names a video that is gone', async () => {
      const run = await videoRun();
      await rm(join(dir, 'runs', run.runId, 'video.mp4'));
      expect((await fetchVideo(run.runId)).statusCode).toBe(404);
    });

    it('returns 400 when the summary points outside the run folder', async () => {
      const run = await videoRun();
      await writeFile(join(dir, 'secret.mp4'), 'secret');
      const summaryFile = join(dir, 'runs', run.runId, 'summary.json');
      const summary = JSON.parse(await readFile(summaryFile, 'utf8')) as Record<string, unknown>;
      for (const video of [`flows/${run.caseId}.yaml`, 'project.json', `runs/${run.runId}-other/video.mp4`, '../secret.mp4']) {
        await writeFile(summaryFile, JSON.stringify({ ...summary, video }));
        const response = await fetchVideo(run.runId);
        expect(response.statusCode, video).toBe(400);
        expect(response.body, video).not.toContain('secret');
      }
    });
  });
});
