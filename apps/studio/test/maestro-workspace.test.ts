// A project kept beside an existing Maestro workspace (project.json `paths`),
// and blocks that only the Maestro CLI can run. The device and Maestro are
// fakes that log what they were asked to do, in order.
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseBlockFlow, type DeviceSnapshot, type MaestroRunResult, type OpenOptions, type RunMaestroOptions } from '@ariadne/core';
import type { ProjectInfo } from '../src/shared/api-types.ts';
import { buildServer } from '../src/server/index.ts';
import type { DeviceLike } from '../src/server/state.ts';

const APP = 'com.android.settings';
const DEVICE = 'emulator-5560';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

class FakeDevice implements DeviceLike {
  target: { deviceId: string; appId: string } | undefined;
  /** 'open', 'relaunch', 'close' and 'replay <file name>', in order. */
  events: string[] = [];
  replays: Array<{ path: string; yaml: string }> = [];

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
  async pressKey() {}
  async setOrientation() {}
  async replayFlow(path: string) {
    this.replays.push({ path, yaml: await readFile(path, 'utf8') });
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

/**
 * Checks that every runFlow of the flow it runs points at a file that exists,
 * as Maestro would, and writes commands.json. `failAt` fails that command.
 */
class FakeMaestro {
  calls: Array<{ flowPath: string; yaml: string; env: Record<string, string>; sessionOpen: boolean }> = [];
  failAt: { index: number; error: string } | undefined;
  constructor(private readonly device: FakeDevice) {}

  readonly run = async (options: RunMaestroOptions): Promise<MaestroRunResult> => {
    const yaml = await readFile(options.flowPath, 'utf8');
    this.calls.push({ flowPath: options.flowPath, yaml, env: { ...options.env }, sessionOpen: this.device.isOpen });
    const outline = parseBlockFlow(yaml);
    const entries: unknown[] = [];
    let passed = true;
    outline.commands.forEach((command, index) => {
      if (!passed) return;
      const name = command.kind === 'step' ? command.step.kind : command.command;
      let error = this.failAt?.index === index ? this.failAt.error : undefined;
      if (command.kind === 'step' && command.step.kind === 'runFlow' && !existsSync(resolve(dirname(options.flowPath), command.step.file))) {
        error = `Flow file ${command.step.file} does not exist`;
      }
      passed = error === undefined;
      entries.push(entry(`${name}Command`, index, passed ? 'COMPLETED' : 'FAILED', error));
    });
    const flowDir = join(options.debugDir, outline.name ?? 'flow');
    await mkdir(flowDir, { recursive: true });
    await writeFile(join(flowDir, 'commands.json'), JSON.stringify(entries));
    // Maestro logs typed values in clear; the studio must hide them.
    await writeFile(join(options.debugDir, 'maestro.log'), `env ${JSON.stringify(options.env)}\n`);
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

const SUBFLOWS = () => join(repo, '.maestro', 'subflows');
const RECORDED = () => join(repo, '.maestro', 'recorded');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ariadne-studio-workspace-'));
  repo = join(root, 'app-repo');
  project = join(repo, '.ariadne');
  await mkdir(SUBFLOWS(), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, 'project.json'),
    JSON.stringify({ appId: APP, platform: 'android', paths: { blocks: ['../.maestro/subflows'], flows: '../.maestro/recorded' } }),
  );
  await writeFile(join(project, '.env'), 'USERNAME=ba@example.com\n');
  await writeFile(join(SUBFLOWS(), 'plain.yaml'), `appId: ${APP}\nname: Plain\n---\n- launchApp\n- tapOn: "Network & internet"\n`);
  await writeFile(
    join(SUBFLOWS(), 'scripted.yaml'),
    `appId: ${APP}\nname: Scripted\n---\n- launchApp\n- runScript: hello.js\n- inputText: "\${USERNAME}"\n`,
  );
  device = new FakeDevice();
  maestro = new FakeMaestro(device);
  app = await buildServer({ projectDir: project, session: device, maestro: { run: maestro.run, findBin: () => '/opt/maestro', androidHome: () => undefined } });
  expect((await call('POST', '/api/session/open', { deviceId: DEVICE, appId: APP })).status).toBe(200);
  device.events = [];
});

afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

async function files(dir: string): Promise<string[]> {
  // Recursive readdir uses the OS separator; compare with forward slashes.
  return ((await readdir(dir, { recursive: true })) as string[]).map((name) => name.split(sep).join('/')).sort();
}

describe('a project beside a Maestro workspace', () => {
  it('lists the team blocks by project path and says where flows go', async () => {
    const info = (await call('GET', '/api/project')).body as ProjectInfo;
    expect(info.paths).toEqual({ blocks: [SUBFLOWS()], flows: RECORDED() });
    expect(info.blocks.map((block) => [block.file, block.runsWith, block.maestroOnly])).toEqual([
      ['../.maestro/subflows/plain.yaml', 'agent-device', undefined],
      ['../.maestro/subflows/scripted.yaml', 'maestro', ['runScript']],
    ]);
    expect(info.blocks[1]!.steps).toEqual(['Start the app', 'runScript (runs in Maestro)', 'Type the USERNAME value from .env']);
  });

  it('records with a team block and writes only <caseId>.yaml into the flows folder, with a relative runFlow', async () => {
    const started = await call('POST', '/api/case/start', { name: 'Plain start', blocks: ['../.maestro/subflows/plain.yaml'] });
    expect(started.status).toBe(200);
    expect(device.replays.map((replay) => replay.path)).toEqual([join(SUBFLOWS(), 'plain.yaml')]);
    const finished = await call('POST', '/api/case/finish');
    const caseId = started.body.caseId as string;
    expect(finished.body.flowFile).toBe(`../.maestro/recorded/${caseId}.yaml`);
    expect(finished.body.yaml).toContain('file: ../subflows/plain.yaml');
    expect(await files(join(repo, '.maestro'))).toEqual(['recorded', `recorded/${caseId}.yaml`, 'subflows', 'subflows/plain.yaml', 'subflows/scripted.yaml']);

    // Run writes its copy under runs/ with the paths rewritten, and the flows folder stays as it was.
    const run = await call('POST', `/api/cases/${caseId}/replay`);
    expect(run.status).toBe(200);
    expect(run.body.passed).toBe(true);
    expect(maestro.calls.at(-1)!.yaml).toContain('file: ../../../.maestro/subflows/plain.yaml');
    expect(await readdir(RECORDED())).toEqual([`${caseId}.yaml`]);

    expect((await call('DELETE', `/api/cases/${caseId}`)).status).toBe(200);
    expect(await readdir(RECORDED())).toEqual([]);
    expect(await readdir(SUBFLOWS())).toEqual(['plain.yaml', 'scripted.yaml']);
  });

  it('refuses a block outside the block folders, even one that exists', async () => {
    await writeFile(join(repo, '.maestro', 'elsewhere.yaml'), `appId: ${APP}\n---\n- back\n`);
    const refused = await call('POST', '/api/case/start', { name: 'X', blocks: ['../.maestro/elsewhere.yaml'] });
    expect(refused).toMatchObject({ status: 400, body: { error: { code: 'UNKNOWN_BLOCK' } } });
    expect(refused.body.error.message).toContain('../.maestro/subflows/');
    expect(device.events).toEqual([]);
  });
});

describe('blocks that run with Maestro', () => {
  it('runs the start of the case with Maestro, the same flow the case emits, and records from where it ends', async () => {
    const started = await call('POST', '/api/case/start', { name: 'Scripted start', blocks: ['../.maestro/subflows/plain.yaml', '../.maestro/subflows/scripted.yaml'] });
    expect(started.status).toBe(200);
    const caseId = started.body.caseId as string;
    expect(device.replays).toEqual([]);
    // The session is closed for Maestro and reopened without a relaunch.
    expect(device.events).toEqual(['close', 'open']);
    const [call0] = maestro.calls;
    expect(call0!.sessionOpen).toBe(false);
    expect(call0!.flowPath).toBe(join(project, 'runs', '_partial', `${caseId}.yaml`));
    expect(call0!.env).toEqual({ USERNAME: 'ba@example.com' });
    expect(call0!.yaml).toBe(
      [
        `appId: ${APP}`,
        'name: Scripted start',
        '---',
        '- launchApp',
        '- runFlow:',
        '    file: ../../../.maestro/subflows/plain.yaml',
        '    env:',
        '      USERNAME: "${USERNAME}"',
        '- runFlow:',
        '    file: ../../../.maestro/subflows/scripted.yaml',
        '    env:',
        '      USERNAME: "${USERNAME}"',
        '',
      ].join('\n'),
    );
    // Nothing is left behind: not the partial flow, not Maestro's output.
    expect(await readdir(join(project, 'runs', '_partial'))).toEqual([]);

    const finished = await call('POST', '/api/case/finish');
    expect(finished.body.yaml).toContain('file: ../subflows/scripted.yaml');
  });

  it('names the block that failed and quotes Maestro, and keeps Maestro output with .env values hidden', async () => {
    maestro.failAt = { index: 2, error: 'Element not found: Text matching regex: Wi-Fi' };
    const failed = await call('POST', '/api/case/start', { name: 'Fails', blocks: ['../.maestro/subflows/plain.yaml', '../.maestro/subflows/scripted.yaml'] });
    expect(failed.status).toBe(502);
    expect(failed.body.error.message).toBe(
      'The block "Scripted" (../.maestro/subflows/scripted.yaml) failed in Maestro: Element not found: Text matching regex: Wi-Fi',
    );
    expect((await call('GET', '/api/case/current')).body).toBeNull();
    expect(device.isOpen).toBe(true);
    const [kept] = await readdir(join(project, 'runs', '_partial'));
    const log = await readFile(join(project, 'runs', '_partial', kept!, 'maestro.log'), 'utf8');
    expect(log).not.toContain('ba@example.com');
    expect(log).toContain('${USERNAME}');
  });

  it('runs a Maestro block in the middle of a recording without a launchApp before it', async () => {
    const started = await call('POST', '/api/case/start', { name: 'Mid' });
    expect(started.status).toBe(200);
    device.events = [];
    const ran = await call('POST', '/api/case/block', { file: '../.maestro/subflows/scripted.yaml' });
    expect(ran.status).toBe(200);
    expect(ran.body.step).toMatchObject({ kind: 'block', file: '../.maestro/subflows/scripted.yaml' });
    expect(device.events).toEqual(['close', 'open']);
    expect(maestro.calls.at(-1)!.yaml).toBe(
      [`appId: ${APP}`, 'name: Mid', '---', '- runFlow:', '    file: ../../../.maestro/subflows/scripted.yaml', '    env:', '      USERNAME: "${USERNAME}"', ''].join('\n'),
    );
  });

  it('re-records a case whose start case uses a Maestro block with Maestro', async () => {
    const parent = await call('POST', '/api/case/start', { name: 'Parent', blocks: ['../.maestro/subflows/scripted.yaml'] });
    await call('POST', '/api/action/back');
    await call('POST', '/api/case/finish');
    const child = await call('POST', '/api/case/start', { name: 'Child', startFrom: parent.body.caseId });
    expect(child.status).toBe(200);
    expect(maestro.calls.at(-1)!.yaml).toContain(`file: ../../../.maestro/recorded/${parent.body.caseId}.yaml`);
    await call('POST', '/api/action/back');
    await call('POST', '/api/action/back');
    await call('POST', '/api/case/finish');
    const before = maestro.calls.length;
    const edit = await call('POST', `/api/cases/${child.body.caseId}/edit`, { mode: 'rerecord', step: 2 });
    expect(edit.status).toBe(200);
    expect(maestro.calls).toHaveLength(before + 1);
    expect(maestro.calls.at(-1)!.yaml).toContain('- back');
    expect(device.replays).toEqual([]);
    expect(await readdir(RECORDED())).toEqual([`${child.body.caseId}.yaml`, `${parent.body.caseId}.yaml`].sort());
  });
});
