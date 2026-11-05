// Helpers shared by the route modules.
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FastifyReply } from 'fastify';
import {
  agentDeviceReplays,
  SYSTEM_UI,
  blackPicture,
  caseToFlow,
  foregroundApp,
  looksLikeHomeApp,
  pointOnScreen,
  relocateFlow,
  replaySegments,
  screenView,
  toMaestroYaml,
  type DirectAction,
  type MaestroFlow,
  type MaestroStep,
  type Recorder,
  type TestCase,
  type DescribeNames,
} from '@ariadne/core';
import { scratchScreenshot, type Latest, type ServerState } from './state.ts';

/** An error with a stable code the UI can show: 4xx for client mistakes, 5xx for device or tool failures. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A recorded drag lasts at least this long and at most this long, whatever the mouse or finger did. */
export const MIN_SWIPE_MS = 100;
export const MAX_SWIPE_MS = 2000;

/** Case and run ids are slugs; anything else in a URL is refused before it reaches the filesystem. */
export const ID_PATTERN = /^[a-z0-9-]+$/;

export function readId(params: unknown, key: 'caseId' | 'runId' | 'suiteId'): string {
  const value = (params as Record<string, string | undefined>)[key];
  if (!value || !ID_PATTERN.test(value)) {
    throw new HttpError(400, 'BAD_REQUEST', `Unknown ${key === 'caseId' ? 'case' : key === 'runId' ? 'run' : 'suite run'}.`);
  }
  return value;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function sendPng(reply: FastifyReply, path: string): FastifyReply {
  return reply.header('cache-control', 'no-store').type('image/png').send(createReadStream(path));
}

export function requireSession(state: ServerState): void {
  if (!state.session.isOpen) {
    throw new HttpError(409, 'NO_SESSION', 'No device connected. Pick a device, enter the app id and click Connect first.');
  }
}

export function requireCase(state: ServerState): Recorder {
  if (!state.recorder?.active) throw new HttpError(409, 'NO_CASE', 'No case is being recorded. Start a case first.');
  return state.recorder;
}

/** Values for ${KEY} in flows: project.json env, overridden by .env. Secrets; never logged. */
export async function projectEnv(state: ServerState): Promise<Record<string, string>> {
  const settings = await state.project.readSettings();
  return { ...(settings.env ?? {}), ...(await state.project.readEnv()) };
}

/** Whether the lock screen is up. A phone that cannot say counts as unlocked. */
export async function phoneLocked(state: ServerState): Promise<boolean> {
  const { deviceId } = state.session;
  if (!deviceId) return false;
  return (await state.phoneTools.locked(deviceId).catch(() => undefined)) === true;
}

/** Captures the screen into `path` and makes it the latest screen. */
export async function captureInto(state: ServerState, path: string): Promise<Latest> {
  const capture = await state.session.capture(path);
  // Asked after the capture, so a phone that locked during it counts. The lock
  // screen can show private messages, so neither its picture nor its text stays.
  if (await phoneLocked(state)) {
    await writeFile(capture.screenshotPath, blackPicture(capture.viewport));
    state.latest = { ...capture, nodes: [], keyboard: undefined, hidden: true };
    return state.latest;
  }
  const view = screenView(capture.nodes, await readFile(capture.screenshotPath).catch(() => new Uint8Array()));
  const front = view === 'hidden' ? undefined : foregroundApp(capture);
  const elsewhere = front && front !== state.session.appId && front !== SYSTEM_UI ? { app: front, home: looksLikeHomeApp(front) } : undefined;
  state.latest = { ...capture, ...(view === 'hidden' ? { hidden: true } : {}), ...(view === 'secure' ? { secure: true } : {}), ...(elsewhere ? { elsewhere } : {}) };
  return state.latest;
}

export async function captureScratch(state: ServerState): Promise<Latest> {
  return captureInto(state, scratchScreenshot(state));
}

export async function readSavedCase(state: ServerState, caseId: string): Promise<TestCase> {
  if (!(await exists(state.project.casePath(caseId)))) throw new HttpError(404, 'NOT_FOUND', `No saved case ${caseId}.`);
  return state.project.readCase(caseId);
}

/** Case id to name for every saved case, for descriptions of start-from steps. */
export async function caseNames(state: ServerState): Promise<Map<string, string>> {
  return new Map((await state.project.listCases()).map((item) => [item.id, item.name]));
}

/** Block file to name, for descriptions of block steps. */
export async function blockNames(state: ServerState): Promise<Map<string, string>> {
  return new Map((await state.project.listBlocks()).map((block) => [block.file, block.name]));
}

/** How reports and run videos name the blocks and cases a case starts from. */
export async function reportNames(state: ServerState): Promise<DescribeNames> {
  const [names, blocks] = await Promise.all([caseNames(state), blockNames(state)]);
  return { caseName: (id) => names.get(id), blockName: (file) => blocks.get(file) };
}

/** The flow of a case as it is written to the project's flows folder. */
export async function caseFlow(state: ServerState, testCase: TestCase, envKeys?: readonly string[]): Promise<MaestroFlow> {
  return caseToFlow(testCase, envKeys ?? (await state.project.envKeys()), state.project);
}

/** Saves the case JSON and regenerates its flow. */
export async function saveCaseAndFlow(state: ServerState, testCase: TestCase): Promise<{ flowPath: string; yaml: string }> {
  return state.project.saveCase(testCase, await caseFlow(state, testCase));
}

/**
 * Writes the flows of `caseId` and of every case it starts from, from their
 * case files, so a replay never runs a stale parent. Returns the chain,
 * nearest first. A broken chain is a client-visible 409.
 */
export async function writeChainFlows(state: ServerState, caseId: string): Promise<TestCase[]> {
  let chain: TestCase[];
  try {
    chain = await state.project.startChain(caseId);
  } catch (error) {
    throw new HttpError(409, 'BROKEN_CHAIN', error instanceof Error ? error.message : String(error));
  }
  const envKeys = await state.project.envKeys();
  for (const testCase of chain) await state.project.writeFlow(testCase.id, await caseFlow(state, testCase, envKeys));
  return chain;
}

/**
 * True when replaying the start of a case needs the Maestro CLI: one of its
 * blocks, block steps, or the cases it starts from (with theirs) uses
 * commands agent-device does not replay. Decided from the files alone.
 */
export async function replayNeedsMaestro(
  state: ServerState,
  testCase: Pick<TestCase, 'preconditionBlocks' | 'steps' | 'startFrom'>,
): Promise<boolean> {
  const maestroBlocks = new Set((await state.project.listBlocks()).filter((block) => block.runsWith === 'maestro').map((block) => block.file));
  if (maestroBlocks.size === 0) return false;
  let chain: Array<Pick<TestCase, 'preconditionBlocks' | 'steps'>> = [testCase];
  if (testCase.startFrom) {
    try {
      chain = [...chain, ...(await state.project.startChain(testCase.startFrom))];
    } catch (error) {
      throw new HttpError(409, 'BROKEN_CHAIN', error instanceof Error ? error.message : String(error));
    }
  }
  return chain.some(
    (item) =>
      item.preconditionBlocks.some((use) => maestroBlocks.has(use.file)) ||
      item.steps.some((step) => step.kind === 'block' && maestroBlocks.has(step.file)),
  );
}

/**
 * The commands that bring the device to the end of `testCase`, for a replay
 * through agent-device. A case that starts from another begins with a runFlow
 * of the other case's flow; when that chain has a command agent-device cannot
 * replay (see device-replay.ts), its commands are written out in place of the
 * runFlow so the studio can do those itself. Otherwise the runFlow stays, and
 * the replay is the flow Maestro runs.
 */
export async function deviceReplaySteps(state: ServerState, testCase: TestCase, envKeys: readonly string[]): Promise<MaestroStep[]> {
  const steps = (await caseFlow(state, testCase, envKeys)).steps;
  if (!testCase.startFrom) return steps;
  const parentSteps = await deviceReplaySteps(state, await state.project.readCase(testCase.startFrom), envKeys);
  if (parentSteps.every(agentDeviceReplays)) return steps;
  return [...parentSteps, ...steps.slice(1)];
}

async function performDirect(state: ServerState, action: DirectAction): Promise<void> {
  switch (action.kind) {
    case 'pressKey':
      return state.session.pressKey(action.key);
    case 'orientation':
      return state.session.setOrientation(action.value);
    case 'longPress':
    case 'doubleTap': {
      const at = pointOnScreen(action.point, (await state.session.snapshot()).viewport);
      return action.kind === 'longPress' ? state.session.longPressAt(at) : state.session.doubleTapAt(at);
    }
  }
}

/**
 * Replays `steps` (case flow commands, runFlow paths relative to the flows
 * folder) on the device inside the studio's session. Runs of commands
 * agent-device replays are written to `scratchPath`, with runFlow paths
 * rewritten for where it is, and replayed there; the ones it cannot replay
 * are done through the device session in between. A flow agent-device
 * replays in full is one replay of one file, as before.
 */
export async function replayOnDevice(
  state: ServerState,
  flow: { appId: string; name?: string },
  steps: readonly MaestroStep[],
  env: Readonly<Record<string, string>>,
  scratchPath: string,
): Promise<void> {
  for (const segment of replaySegments(steps)) {
    if (segment.kind === 'direct') {
      await performDirect(state, segment.action);
      continue;
    }
    const header = flow.name === undefined ? { appId: flow.appId } : { appId: flow.appId, name: flow.name };
    const relocated = relocateFlow({ ...header, steps: segment.steps }, state.project.flowsDirFrom(dirname(scratchPath)));
    await mkdir(dirname(scratchPath), { recursive: true });
    await writeFile(scratchPath, toMaestroYaml(relocated), 'utf8');
    await state.session.replayFlow(scratchPath, env);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
