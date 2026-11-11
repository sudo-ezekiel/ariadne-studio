// Helpers shared by the route modules.
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FastifyReply } from 'fastify';
import {
  agentDeviceReplays,
  SYSTEM_UI,
  blackPicture,
  caseToFlow,
  elementName,
  expectationCandidates,
  foregroundApp,
  looksLikeHomeApp,
  pointOnScreen,
  relocateFlow,
  replaySegments,
  screenView,
  selectorOnScreen,
  toMaestroYaml,
  type DirectAction,
  type ExpectationCandidate,
  type MaestroFlow,
  type MaestroSelector,
  type MaestroStep,
  type Recorder,
  type TestCase,
  type DescribeNames,
} from '@ariadne/core';
import { MAX_WAIT_SECONDS } from '../shared/api-types.ts';
import { capturingScreenshot, scratchScreenshot, type Latest, type ServerState } from './state.ts';

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

/** The `seconds` of a wait: a whole number from 1 to MAX_WAIT_SECONDS. */
export function readSeconds(body: unknown): number {
  const { seconds } = (body ?? {}) as { seconds?: unknown };
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_SECONDS) {
    throw new HttpError(400, 'BAD_REQUEST', `A wait is 1 to ${MAX_WAIT_SECONDS} seconds.`);
  }
  return seconds;
}

/** A 1-based step number from the URL, from `min` to `max`. */
export function readStepNumber(params: unknown, key: string, max: number, min = 1): number {
  const raw = (params as Record<string, string | undefined>)[key];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, 'BAD_STEP', `Step ${raw ?? ''} does not exist; this case has ${max} step(s).`);
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

export function readPicks(body: unknown): number[] {
  const picks = ((body ?? {}) as { picks?: unknown }).picks;
  if (picks === undefined) return [];
  if (!Array.isArray(picks) || !picks.every((pick) => Number.isInteger(pick) && pick >= 0)) {
    throw new HttpError(400, 'BAD_PICK', 'Expected "picks" to be a list of candidate ids.');
  }
  return [...new Set(picks as number[])];
}

/** The end checks ticked. Same snapshot as GET /api/case/candidates, so the same ids mean the same elements. */
export function pickedCandidates(state: ServerState, picks: readonly number[]): ExpectationCandidate[] {
  const screen = state.offered ?? state.latest;
  const candidates = screen ? expectationCandidates(screen.nodes, screen.viewport) : [];
  return picks.map((pick) => {
    const candidate = candidates[pick];
    if (!candidate) throw new HttpError(400, 'BAD_PICK', `There is no candidate ${pick} on the current screen.`);
    return candidate;
  });
}

/**
 * Refuses to start or change anything while a recording is going. Call it inside
 * the queue: a request checked before it can be overtaken by the one in front.
 */
export function requireNoRecording(state: ServerState): void {
  if (state.recorder?.active) throw new HttpError(409, 'CASE_ACTIVE', 'Finish or discard the recording first.');
}

/**
 * For a queued change to a recording: refuses one that ended or was replaced
 * while the request waited, so it cannot end the recording that came after it.
 */
export function requireRecording(state: ServerState, recorder: Recorder): void {
  if (state.recorder !== recorder) throw new HttpError(409, 'NO_CASE', 'That recording has already ended.');
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

/**
 * Whether the lock screen is up. A phone that has answered before and now cannot
 * counts as locked, because a lock screen may be what it is showing. One that has
 * never answered counts as unlocked: it may only word it differently, and the
 * studio would show nothing at all on it otherwise.
 */
export async function phoneLocked(state: ServerState): Promise<boolean> {
  const { deviceId } = state.session;
  if (!deviceId) return false;
  const locked = await state.phoneTools.locked(deviceId).catch(() => undefined);
  if (locked === undefined) return state.lockAnswered === deviceId;
  state.lockAnswered = deviceId;
  return locked;
}

/** Puts a finished picture at `path`. A rename swaps it whole, but cannot cross drives, and Windows can refuse one over a file being read. */
async function movePicture(from: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await rename(from, path);
  } catch {
    await copyFile(from, path);
    await rm(from, { force: true });
  }
}

/** Captures the screen into `path` and makes it the latest screen. */
export async function captureInto(state: ServerState, path: string): Promise<Latest> {
  // `path` can be the file the mirror is showing, so the picture lands elsewhere
  // and only reaches `path` once the lock has been checked.
  const capture = await state.session.capture(capturingScreenshot(state));
  // Asked after the capture, so a phone that locked during it counts. The lock
  // screen can show private messages, so neither its picture nor its text stays.
  let locked: boolean;
  try {
    locked = await phoneLocked(state);
    if (locked) await writeFile(capture.screenshotPath, blackPicture(capture.viewport));
    await movePicture(capture.screenshotPath, path);
  } catch (error) {
    await rm(capture.screenshotPath, { force: true }).catch(() => undefined);
    throw error;
  }
  const saved = { ...capture, screenshotPath: path };
  if (locked) {
    state.latest = { ...saved, nodes: [], keyboard: undefined, hidden: true };
    return state.latest;
  }
  const view = screenView(capture.nodes, await readFile(path).catch(() => new Uint8Array()));
  const front = view === 'hidden' ? undefined : foregroundApp(capture);
  const elsewhere = front && front !== state.session.appId && front !== SYSTEM_UI ? { app: front, home: looksLikeHomeApp(front) } : undefined;
  state.latest = { ...saved, ...(view === 'hidden' ? { hidden: true } : {}), ...(view === 'secure' ? { secure: true } : {}), ...(elsewhere ? { elsewhere } : {}) };
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
    case 'wait':
      return pause(action.seconds * 1000);
    case 'waitFor':
      return waitForElement(state, action.selector, action.seconds * 1000);
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How often a wait until looks at the screen again. */
const WAIT_FOR_POLL_MS = 500;

/**
 * Looks at the screen until an element matches `selector`, and fails when `ms`
 * have gone by without one, as Maestro's extendedWaitUntil does.
 */
async function waitForElement(state: ServerState, selector: MaestroSelector, ms: number): Promise<void> {
  // A deadline that is not a number never comes, and the loop would never end.
  if (!(ms > 0 && Number.isFinite(ms))) throw new Error(`A wait until needs more than 0 seconds, not ${ms / 1000}.`);
  const deadline = Date.now() + ms;
  for (;;) {
    if (selectorOnScreen((await state.session.snapshot()).nodes, selector)) return;
    const left = deadline - Date.now();
    if (left <= 0) {
      const seconds = ms / 1000;
      throw new Error(`Waited ${seconds} ${seconds === 1 ? 'second' : 'seconds'} for ${elementName(selector)} and it never appeared.`);
    }
    await pause(Math.min(WAIT_FOR_POLL_MS, left));
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
