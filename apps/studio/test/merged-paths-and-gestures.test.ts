// Milestone 5 (project.json `paths` beside a Maestro workspace, blocks that need
// Maestro) together with Milestone 6 (gestures and phone buttons that agent-device
// cannot replay). Each feature has its own tests; these cover where they meet:
// scratch flows in runs/_partial with relocated runFlow paths, direct steps between
// agent-device segments, and the Maestro prefix. The device and Maestro are fakes.
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseBlockFlow, type DeviceSnapshot, type MaestroRunResult, type OpenOptions, type RunMaestroOptions } from '@ariadne/core';
import type { ProjectInfo } from '../src/shared/api-types.ts';
import { buildServer } from '../src/server/index.ts';
import type { DeviceLike } from '../src/server/state.ts';

const APP = 'com.android.settings';
const DEVICE = 'emulator-5560';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

type Replay = {
  path: string;
  yaml: string;
  /** runFlow targets of the replayed file, as resolved from the file's own folder. */
  resolved: string[];
  /** Whether every resolved runFlow target existed when the replay ran. */
  allExist: boolean;
};

class FakeDevice implements DeviceLike {
  target: { deviceId: string; appId: string } | undefined;
  /** 'open', 'relaunch', 'close', 'replay <file>', 'pressKey <key>', 'orientation <value>', in order. */
  events: string[] = [];
  replays: Replay[] = [];

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
    return [{ id: DEVICE, name: 'e2e_tool_dev', platform: 'android', kind: 'emulator', booted: true }];
  }
  async open(options: OpenOptions) {
    this.events.push(options.relaunch ? 'relaunch' : 'open');
    this.target = { deviceId: options.deviceId, appId: options.appId };
  }
  async relaunchApp() {
    this.events.push('relaunch');
  }
  async snapshot(): Promise<DeviceSnapshot> {
    const nodes = [{ index: 0, depth: 1, rect: { x: 0, y: 400, width: 1080, height: 200 }, label: 'Internet', hittable: true }];
    return { nodes, viewport: { width: 1080, height: 2400 }, takenAt: new Date().toISOString() };
  }
  async capture(screenshotPath: string) {
    mkdirSync(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, PNG);
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
  async pressKey(key: string) {
    this.events.push(`pressKey ${key}`);
  }
  async setOrientation(value: string) {
    this.events.push(`orientation ${value}`);
  }
  async replayFlow(path: string) {
    const yaml = await readFile(path, 'utf8');
    const resolved = parseBlockFlow(yaml)
      .commands.flatMap((command) => (command.kind === 'step' && command.step.kind === 'runFlow' ? [resolve(dirname(path), command.step.file)] : []));
    this.replays.push({ path, yaml, resolved, allExist: resolved.every((file) => existsSync(file)) });
    this.events.push(`replay ${basename(path)}`);
    return { replayed: 1 };
  }
  async close() {
    this.events.push('close');
    this.target = undefined;
  }
}

function entry(name: string, sequenceNumber: number, status: string, error?: string) {
  return { command: { [name]: {} }, metadata: { status, sequenceNumber, depth: 0, duration: 10, ...(error ? { error: { message: error } } : {}) } };
}

/** Passes every command, but fails a runFlow whose file does not exist, as Maestro would. */
class FakeMaestro {
  calls: Array<{ flowPath: string; yaml: string }> = [];
  constructor(private readonly device: FakeDevice) {}

  readonly run = async (options: RunMaestroOptions): Promise<MaestroRunResult> => {
    const yaml = await readFile(options.flowPath, 'utf8');
    this.calls.push({ flowPath: options.flowPath, yaml });
    expect(this.device.isOpen).toBe(false);
    const outline = parseBlockFlow(yaml);
    const entries: unknown[] = [];
    let passed = true;
    outline.commands.forEach((command, index) => {
      if (!passed) return;
      const name = command.kind === 'step' ? command.step.kind : command.command;
      let error: string | undefined;
      if (command.kind === 'step' && command.step.kind === 'runFlow' && !existsSync(resolve(dirname(options.flowPath), command.step.file))) {
        error = `Flow file ${command.step.file} does not exist`;
      }
      passed = error === undefined;
      entries.push(entry(`${name}Command`, index, passed ? 'COMPLETED' : 'FAILED', error));
    });
    const flowDir = join(options.debugDir, outline.name ?? 'flow');
    await mkdir(flowDir, { recursive: true });
    await writeFile(join(flowDir, 'commands.json'), JSON.stringify(entries));
    const outputFile = join(options.debugDir, 'output.txt');
    await writeFile(outputFile, passed ? 'Flow Passed\n' : 'Flow Failed\n');
    return { exitCode: passed ? 0 : 1, durationMs: 100, outputFile, timedOut: false };
  };
}

let root: string;
let repo: string;
let project: string;
let device: FakeDevice;
let maestro: FakeMaestro;
let app: FastifyInstance;

type Method = 'GET' | 'POST' | 'DELETE';

async function call(method: Method, url: string, payload?: object) {
  const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
  return { status: response.statusCode, body: response.headers['content-type']?.includes('json') ? response.json() : response.body };
}

async function ok(method: Method, url: string, payload?: object) {
  const result = await call(method, url, payload);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

const MAESTRO_DIR = () => join(repo, '.maestro');
const SUBFLOWS = () => join(MAESTRO_DIR(), 'subflows');
const RECORDED = () => join(MAESTRO_DIR(), 'recorded');
const PLAIN = '../.maestro/subflows/plain.yaml';
const SCRIPTED = '../.maestro/subflows/scripted.yaml';

async function files(dir: string): Promise<string[]> {
  return ((await readdir(dir, { recursive: true })) as string[]).sort();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ariadne-studio-merged-'));
  repo = join(root, 'app-repo');
  project = join(repo, '.ariadne');
  await mkdir(SUBFLOWS(), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, 'project.json'),
    JSON.stringify({ appId: APP, platform: 'android', paths: { blocks: ['../.maestro/subflows'], flows: '../.maestro/recorded' } }),
  );
  await writeFile(join(SUBFLOWS(), 'plain.yaml'), `appId: ${APP}\nname: Plain\n---\n- launchApp\n- tapOn: "Network & internet"\n`);
  await writeFile(join(SUBFLOWS(), 'scripted.yaml'), `appId: ${APP}\nname: Scripted\n---\n- launchApp\n- runScript: hello.js\n`);
  device = new FakeDevice();
  maestro = new FakeMaestro(device);
  app = await buildServer({ projectDir: project, session: device, maestro: { run: maestro.run, findBin: () => '/opt/maestro', androidHome: () => undefined } });
  await ok('POST', '/api/session/open', { deviceId: DEVICE, appId: APP });
  device.events = [];
});

afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

/** Records and saves a case: starts with `start`, does each action, finishes. Returns its id. */
async function recordCase(
  start: { name: string; blocks?: string[]; startFrom?: string },
  actions: Array<[url: string, body?: object]>,
): Promise<string> {
  const started = await ok('POST', '/api/case/start', start);
  for (const [url, body] of actions) await ok('POST', url, body);
  await ok('POST', '/api/case/finish');
  return started.caseId as string;
}

const TAP_INTERNET: [string, object] = ['/api/action/tap', { x: 300, y: 475 }];
const BACK: [string] = ['/api/action/back'];
const VOLUME_UP: [string, object] = ['/api/action/key', { key: 'volumeUp' }];
const LANDSCAPE: [string, object] = ['/api/action/rotate', { orientation: 'landscape' }];

describe('re-record in a project with external paths, kept steps that agent-device cannot replay', () => {
  it('replays agent-device segments from runs/_partial with resolving runFlow paths, and does the key and rotation between them', async () => {
    // Steps: 1 back, 2 volumeUp, 3 landscape, 4 tap, 5 back.
    const caseId = await recordCase({ name: 'Gestures', blocks: [PLAIN] }, [BACK, VOLUME_UP, LANDSCAPE, TAP_INTERNET, BACK]);
    const before = await files(MAESTRO_DIR());
    expect(before).toEqual(['recorded', `recorded/${caseId}.yaml`, 'subflows', 'subflows/plain.yaml', 'subflows/scripted.yaml']);
    device.events = [];
    device.replays = [];

    await ok('POST', `/api/cases/${caseId}/edit`, { mode: 'rerecord', step: 5 });

    const scratch = join(project, 'runs', '_partial', `${caseId}.yaml`);
    expect(device.events).toEqual(['relaunch', `replay ${caseId}.yaml`, 'pressKey volumeUp', 'orientation landscape', `replay ${caseId}.yaml`]);
    expect(device.replays.map((replay) => replay.path)).toEqual([scratch, scratch]);
    // First segment: launchApp, the block, back. Second: the tap after the rotation.
    expect(device.replays[0]!.yaml).toBe(
      [`appId: ${APP}`, 'name: Gestures', '---', '- launchApp', '- runFlow:', '    file: ../../../.maestro/subflows/plain.yaml', '- back', ''].join('\n'),
    );
    expect(device.replays[1]!.yaml).not.toContain('runFlow');
    expect(device.replays[1]!.yaml).toContain('- tapOn:');
    expect(device.replays[0]!.resolved).toEqual([join(SUBFLOWS(), 'plain.yaml')]);
    expect(device.replays.every((replay) => replay.allExist)).toBe(true);

    // The scratch file is gone, and the Maestro workspace holds what it did before.
    expect(existsSync(scratch)).toBe(false);
    expect(await readdir(join(project, 'runs', '_partial'))).toEqual([]);
    expect(await files(MAESTRO_DIR())).toEqual(before);
    expect(maestro.calls).toEqual([]);
  });

  it('keeps the same order when inserting after a step, and leaves nothing behind when the device fails mid-replay', async () => {
    const caseId = await recordCase({ name: 'Insert', blocks: [PLAIN] }, [VOLUME_UP, LANDSCAPE, BACK]);
    device.events = [];
    device.replays = [];
    const failing = device.replayFlow.bind(device);
    let count = 0;
    device.replayFlow = async (path: string) => {
      const result = await failing(path);
      if (++count === 2) throw new Error('device lost');
      return result;
    };

    const failed = await call('POST', `/api/cases/${caseId}/edit`, { mode: 'insert', after: 3 });
    expect(failed.status).toBe(502);
    expect(failed.body.error.message).toContain('Running the case up to step 3 failed');
    expect(device.events).toEqual(['relaunch', `replay ${caseId}.yaml`, 'pressKey volumeUp', 'orientation landscape', `replay ${caseId}.yaml`]);
    expect(await readdir(join(project, 'runs', '_partial'))).toEqual([]);
    expect((await call('GET', '/api/case/current')).body).toBeNull();
    expect(await readdir(RECORDED())).toEqual([`${caseId}.yaml`]);
  });
});

describe('re-record in a project with external paths, a block that needs Maestro', () => {
  it('runs the whole prefix with Maestro, keys and rotation included, and replays nothing on agent-device', async () => {
    const caseId = await recordCase({ name: 'Scripted gestures', blocks: [SCRIPTED] }, [VOLUME_UP, LANDSCAPE, TAP_INTERNET, BACK]);
    const before = await files(MAESTRO_DIR());
    device.events = [];
    device.replays = [];
    const calls = maestro.calls.length;

    await ok('POST', `/api/cases/${caseId}/edit`, { mode: 'rerecord', step: 4 });

    expect(maestro.calls).toHaveLength(calls + 1);
    const run = maestro.calls.at(-1)!;
    expect(run.flowPath).toBe(join(project, 'runs', '_partial', `${caseId}.yaml`));
    expect(run.yaml).toBe(
      [
        `appId: ${APP}`,
        'name: Scripted gestures',
        '---',
        '- launchApp',
        '- runFlow:',
        '    file: ../../../.maestro/subflows/scripted.yaml',
        '- pressKey: Volume Up',
        '- setOrientation: LANDSCAPE_LEFT',
        '- tapOn:',
        '    text: "Internet"',
        '',
      ].join('\n'),
    );
    expect(device.replays).toEqual([]);
    expect(device.events.filter((event) => event.startsWith('replay') || event.startsWith('pressKey') || event.startsWith('orientation'))).toEqual([]);
    expect(await readdir(join(project, 'runs', '_partial'))).toEqual([]);
    expect(await files(MAESTRO_DIR())).toEqual(before);
  });
});

describe('/api/case/start from a case in an external flows folder', () => {
  it('replays a parent with a rotation step by step, with the block path relocated for runs/_partial', async () => {
    const parent = await recordCase({ name: 'Parent', blocks: [PLAIN] }, [TAP_INTERNET, LANDSCAPE, BACK]);
    device.events = [];
    device.replays = [];

    const child = await ok('POST', '/api/case/start', { name: 'Child', startFrom: parent });

    const scratch = join(project, 'runs', '_partial', `${parent}.yaml`);
    expect(device.events).toEqual(['relaunch', `replay ${parent}.yaml`, 'orientation landscape', `replay ${parent}.yaml`]);
    expect(device.replays.map((replay) => replay.path)).toEqual([scratch, scratch]);
    // Never the parent's own flow file: that one contains the setOrientation agent-device refuses.
    expect(device.replays.map((replay) => replay.path)).not.toContain(join(RECORDED(), `${parent}.yaml`));
    expect(device.replays[0]!.yaml).toContain('file: ../../../.maestro/subflows/plain.yaml');
    expect(device.replays[0]!.resolved).toEqual([join(SUBFLOWS(), 'plain.yaml')]);
    expect(device.replays.every((replay) => replay.allExist)).toBe(true);
    expect(device.replays.map((replay) => replay.yaml).join('\n')).not.toContain('setOrientation');
    expect(existsSync(scratch)).toBe(false);
    expect(child.caseId).not.toBe(parent);
  });

  it('expands a grandparent chain: the grandparent runs, then its rotation, then the parent steps', async () => {
    const grand = await recordCase({ name: 'Grand', blocks: [PLAIN] }, [LANDSCAPE]);
    const parent = await recordCase({ name: 'Parent', startFrom: grand }, [TAP_INTERNET]);
    device.events = [];
    device.replays = [];

    await ok('POST', '/api/case/start', { name: 'Child', startFrom: parent });

    expect(device.events).toEqual(['relaunch', `replay ${parent}.yaml`, 'orientation landscape', `replay ${parent}.yaml`]);
    expect(device.replays[0]!.resolved).toEqual([join(SUBFLOWS(), 'plain.yaml')]);
    expect(device.replays[0]!.yaml).not.toContain(grand);
    expect(device.replays[1]!.yaml).toContain('- tapOn:');
    expect(device.replays.every((replay) => replay.allExist)).toBe(true);
  });

  it('with only taps in the parent, is one replay of the parent flow file in the external flows folder', async () => {
    const parent = await recordCase({ name: 'Parent', blocks: [PLAIN] }, [TAP_INTERNET, BACK]);
    device.events = [];
    device.replays = [];

    await ok('POST', '/api/case/start', { name: 'Child', startFrom: parent });

    expect(device.events).toEqual(['relaunch', `replay ${parent}.yaml`]);
    expect(device.replays.map((replay) => replay.path)).toEqual([join(RECORDED(), `${parent}.yaml`)]);
    // The flow file keeps its paths relative to its own folder, and they resolve.
    expect(device.replays[0]!.yaml).toContain('file: ../subflows/plain.yaml');
    expect(device.replays[0]!.resolved).toEqual([join(SUBFLOWS(), 'plain.yaml')]);
    expect(device.replays[0]!.allExist).toBe(true);
    expect(existsSync(join(project, 'runs', '_partial', `${parent}.yaml`))).toBe(false);
  });

  it('runs a parent whose block needs Maestro with Maestro, relocated, and replays nothing on agent-device', async () => {
    const parent = await recordCase({ name: 'Parent', blocks: [SCRIPTED] }, [LANDSCAPE, BACK]);
    device.events = [];
    device.replays = [];
    const calls = maestro.calls.length;

    await ok('POST', '/api/case/start', { name: 'Child', startFrom: parent });

    expect(maestro.calls).toHaveLength(calls + 1);
    expect(maestro.calls.at(-1)!.yaml).toContain(`file: ../../../.maestro/recorded/${parent}.yaml`);
    expect(device.replays).toEqual([]);
    expect(device.events).toEqual(['close', 'open']);
  });
});

describe('flows emitted for the new step kinds in an external flows folder', () => {
  async function recordAllKinds(): Promise<string> {
    return recordCase({ name: 'All kinds', blocks: [PLAIN] }, [
      // Off any element, so these record as points.
      ['/api/action/long-press', { x: 300, y: 1500 }],
      ['/api/action/double-tap', { x: 300, y: 1800 }],
      ['/api/action/swipe', { from: { x: 540, y: 1800 }, to: { x: 540, y: 600 }, durationMs: 400 }],
      VOLUME_UP,
      LANDSCAPE,
      BACK,
    ]);
  }

  it('writes the case flow into the flows folder with every new command and runFlow paths relative to that folder', async () => {
    const caseId = await recordAllKinds();
    const yaml = await readFile(join(RECORDED(), `${caseId}.yaml`), 'utf8');
    for (const command of ['longPressOn:', 'doubleTapOn:', 'swipe:', 'pressKey: Volume Up', 'setOrientation: LANDSCAPE_LEFT']) {
      expect(yaml, command).toContain(command);
    }
    expect(yaml).toContain('file: ../subflows/plain.yaml');
    const outline = parseBlockFlow(yaml);
    const targets = outline.commands.flatMap((command) => (command.kind === 'step' && command.step.kind === 'runFlow' ? [command.step.file] : []));
    expect(targets.map((file) => resolve(RECORDED(), file))).toEqual([join(SUBFLOWS(), 'plain.yaml')]);
    expect(outline.maestroOnly).toEqual([]);
  });

  it('writes the Run copy to runs/<runId>/flow.yaml with the same commands and runFlow paths that resolve from there', async () => {
    const caseId = await recordAllKinds();
    const run = await ok('POST', `/api/cases/${caseId}/replay`);
    expect(run.passed).toBe(true);

    const ran = maestro.calls.at(-1)!;
    expect(ran.flowPath).toBe(join(project, 'runs', run.runId as string, 'flow.yaml'));
    expect(ran.yaml).toContain('file: ../../../.maestro/subflows/plain.yaml');
    const outline = parseBlockFlow(ran.yaml);
    const kinds = outline.commands.flatMap((command) => (command.kind === 'step' ? [command.step.kind] : []));
    for (const kind of ['longPressOn', 'doubleTapOn', 'swipe', 'pressKey', 'setOrientation']) expect(kinds, kind).toContain(kind);
    const targets = outline.commands.flatMap((command) => (command.kind === 'step' && command.step.kind === 'runFlow' ? [command.step.file] : []));
    expect(targets.map((file) => resolve(dirname(ran.flowPath), file))).toEqual([join(SUBFLOWS(), 'plain.yaml')]);
    // The flows folder still holds only the case flow.
    expect(await readdir(RECORDED())).toEqual([`${caseId}.yaml`]);
  });
});

describe('classifying blocks that use the new commands, in an external block folder', () => {
  async function addBlock(name: string, commands: string): Promise<void> {
    await writeFile(join(SUBFLOWS(), `${name}.yaml`), `appId: ${APP}\nname: ${name}\n---\n${commands}\n`);
  }

  async function runsWith(name: string): Promise<string | undefined> {
    const info = (await ok('GET', '/api/project')) as ProjectInfo;
    return info.blocks.find((block) => block.file === `../.maestro/subflows/${name}.yaml`)?.runsWith;
  }

  it('classes a long press on a text selector as agent-device, which replays it', async () => {
    await addBlock('press-text', '- longPressOn: "Internet"');
    expect(await runsWith('press-text')).toBe('agent-device');
  });

  // agentDeviceReplays() says agent-device cannot replay these; a live block replay
  // would skip them, so such blocks run with Maestro.
  it('classes a block with a long press at a point as maestro, since agent-device cannot replay points', async () => {
    await addBlock('press-point', '- longPressOn:\n    point: "50%,50%"');
    expect(await runsWith('press-point')).toBe('maestro');
  });

  it('classes a block with pressKey: Volume Up as maestro, since agent-device only replays Home, Back and Enter', async () => {
    await addBlock('volume', '- pressKey: Volume Up');
    expect(await runsWith('volume')).toBe('maestro');
  });

  it('classes a block with setOrientation as maestro, since agent-device refuses it', async () => {
    await addBlock('rotate', '- setOrientation: LANDSCAPE_LEFT');
    expect(await runsWith('rotate')).toBe('maestro');
  });

  it('classes a block with pressKey: Home as agent-device, which replays it', async () => {
    await addBlock('home', '- pressKey: Home');
    expect(await runsWith('home')).toBe('agent-device');
  });

  it('starts a case with a Volume Up block through Maestro rather than replaying it on agent-device', async () => {
    await addBlock('volume', '- launchApp\n- pressKey: Volume Up');
    await ok('POST', '/api/case/start', { name: 'Volume', blocks: ['../.maestro/subflows/volume.yaml'] });
    expect(device.replays).toEqual([]);
    expect(maestro.calls).toHaveLength(1);
  });
});
