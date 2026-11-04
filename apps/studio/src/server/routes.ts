import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  MAESTRO_KEY_OF,
  Recorder,
  agentDeviceReplays,
  caseHealth,
  checkValues,
  chooseSelector,
  describeDeviceError,
  evidenceNumber,
  describeMaestroStep,
  expectationCandidates,
  focusedPasswordField,
  installRefused,
  normalizeValues,
  percentOfScreen,
  pointOnScreen,
  redactValues,
  resolveValues,
  testUserPrefix,
  rectCenter,
  resolveTapTarget,
  type BlockInfo,
  type BlockUse,
  type CaseStep,
  type MaestroSelector,
  type MaestroStep,
  type PhoneKey,
  type Point,
  type TestCase,
} from '@ariadne/core';
import type {
  ActionResponse,
  CandidatesResponse,
  CaseFinishResponse,
  CaseListItem,
  CaseStartResponse,
  ProjectInfo,
  SessionInfo,
  TestUserRequest,
} from '../shared/api-types.ts';
import { registerCaseRoutes } from './cases.ts';
import {
  HttpError,
  ID_PATTERN,
  MAX_SWIPE_MS,
  MIN_SWIPE_MS,
  captureInto,
  captureScratch,
  deviceReplaySteps,
  exists,
  nowIso,
  projectEnv,
  readSavedCase,
  replayNeedsMaestro,
  replayOnDevice,
  requireCase,
  requireSession,
  saveCaseAndFlow,
  sendPng,
  writeChainFlows,
} from './common.ts';
import { registerExportRoutes } from './exports.ts';
import { registerFileRoutes } from './files.ts';
import { registerPhoneRoutes, stopPhoneCapture } from './phone-capture.ts';
import { registerReplayRoutes, runPrefixWithMaestro } from './replay.ts';
import {
  currentCaseView,
  enqueue,
  scratchScreenshot,
  suiteRunning,
  toLiteNode,
  toScreenState,
  toStepView,
  type Latest,
  type ServerState,
} from './state.ts';

export { HttpError } from './common.ts';

/** After this long the last snapshot may no longer match the screen, so taps re-snapshot first. */
const STALE_SNAPSHOT_MS = 5_000;

function readPoint(body: unknown): Point {
  const { x, y } = (body ?? {}) as { x?: unknown; y?: unknown };
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new HttpError(400, 'BAD_REQUEST', 'Expected { x, y } in viewport pixels.');
  }
  return { x, y };
}

function readString(body: unknown, key: string): string {
  const value = (body ?? {}) as Record<string, unknown>;
  if (typeof value[key] !== 'string' || !(value[key] as string).trim()) {
    throw new HttpError(400, 'BAD_REQUEST', `Expected a non-empty "${key}".`);
  }
  return value[key] as string;
}

function isValues(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((item) => typeof item === 'string');
}

/** One block as a request names it: a path, or { file, values }. */
function readBlockUse(raw: unknown): BlockUse {
  if (typeof raw === 'string') return { file: raw };
  const { file, values } = (raw ?? {}) as { file?: unknown; values?: unknown };
  if (typeof file !== 'string' || (values !== undefined && !isValues(values))) {
    throw new HttpError(
      400,
      'BAD_REQUEST',
      'Expected a block as its project path, such as "blocks/login.yaml", or { "file": "blocks/login.yaml", "values": { "USERNAME": "${AGENT_USERNAME}" } }.',
    );
  }
  return values === undefined ? { file } : { file, values };
}

function readBlocks(body: unknown): BlockUse[] {
  const blocks = ((body ?? {}) as { blocks?: unknown }).blocks;
  if (blocks === undefined) return [];
  if (!Array.isArray(blocks)) {
    throw new HttpError(400, 'BAD_REQUEST', 'Expected "blocks" to be a list of block paths (project paths such as "blocks/login.yaml").');
  }
  return blocks.map(readBlockUse);
}

/** The block variables a case may set: used by the block, with no default in its own env header. */
function settableVariables(block: BlockInfo): string[] {
  const { outline } = block;
  return outline ? outline.variables.filter((key) => outline.env?.[key] === undefined) : [];
}

/** The project's block folders, project-relative, for messages. */
function blockFolders(state: ServerState): string {
  return state.project
    .resolvedPaths()
    .blockDirs.map((dir) => `${state.project.relative(dir)}/`)
    .join(', ');
}

/**
 * Checks that a block exists and can run, and that its values are allowed;
 * returns it with its values normalized (a pasted saved value becomes its
 * ${KEY}). Throws a 400 that names the problem.
 */
async function prepareBlockUse(state: ServerState, use: BlockUse, env: Readonly<Record<string, string>>): Promise<PreparedBlock> {
  const info = (await state.project.listBlocks()).find((candidate) => candidate.file === use.file);
  if (!info) throw new HttpError(400, 'UNKNOWN_BLOCK', `There is no block ${use.file} in the project's block folders (${blockFolders(state)}).`);
  if (info.error) throw new HttpError(400, 'UNKNOWN_BLOCK', `Block ${use.file} cannot be used: ${info.error}`);
  let path: string;
  try {
    path = state.project.blockPath(use.file);
  } catch (error) {
    throw new HttpError(400, 'UNKNOWN_BLOCK', error instanceof Error ? error.message : String(error));
  }
  const first = info.outline?.commands[0];
  const launchesApp = first?.kind === 'step' && first.step.kind === 'launchApp';
  const runsWithMaestro = info.runsWith === 'maestro';
  const values = normalizeValues(use.values, env);
  if (!values) return { use: { file: use.file }, path, launchesApp, runsWithMaestro };
  const problem = checkValues(values, settableVariables(info), await state.project.envKeys());
  if (problem) throw new HttpError(400, 'BAD_BLOCK_VALUE', `${info.name}: ${problem}`);
  return { use: { file: use.file, values }, path, launchesApp, runsWithMaestro };
}

/**
 * A block ready to run: its use with normalized values, its absolute path,
 * whether it begins by launching the app, and whether it needs the Maestro CLI.
 */
type PreparedBlock = { use: BlockUse; path: string; launchesApp: boolean; runsWithMaestro: boolean };

/**
 * Runs a block on the device with its values; a failure leaves the mirror
 * where it stopped and hides saved values. Maestro's launchApp stops a
 * running app and starts it again, while agent-device's only brings it to
 * the front (seen on 2026-11-02: the Settings search screen stayed open), so
 * a block that begins with launchApp gets a real restart first and records
 * on the screen the run will see.
 */
async function runBlockNow(state: ServerState, block: PreparedBlock, env: Readonly<Record<string, string>>, what: string): Promise<void> {
  const { use } = block;
  try {
    if (block.launchesApp) await state.session.relaunchApp();
    await state.session.replayFlow(block.path, { ...env, ...resolveValues(use.values, env) });
  } catch (error) {
    await captureScratch(state).catch(() => undefined);
    const described = describeDeviceError(error);
    throw new HttpError(502, described.code, redactValues(`${what} failed: ${described.message}`, env));
  }
}



/**
 * Runs a saved case on the device to record from where it ends, when its
 * chain has steps agent-device cannot replay (see replayOnDevice). Fails the
 * way runBlockNow does.
 */
async function replayCaseNow(state: ServerState, testCase: TestCase, steps: readonly MaestroStep[], env: Readonly<Record<string, string>>): Promise<void> {
  const scratchPath = state.project.partialFlowPath(testCase.id);
  try {
    await replayOnDevice(state, { appId: testCase.appId, name: testCase.name }, steps, env, scratchPath);
  } catch (error) {
    await captureScratch(state).catch(() => undefined);
    const described = describeDeviceError(error);
    throw new HttpError(502, described.code, redactValues(`The case ${testCase.id} failed: ${described.message}`, env));
  } finally {
    await rm(scratchPath, { force: true });
  }
}

function readPicks(body: unknown): number[] {
  const picks = ((body ?? {}) as { picks?: unknown }).picks;
  if (picks === undefined) return [];
  if (!Array.isArray(picks) || !picks.every((pick) => Number.isInteger(pick) && pick >= 0)) {
    throw new HttpError(400, 'BAD_PICK', 'Expected "picks" to be a list of candidate ids.');
  }
  return [...new Set(picks as number[])];
}

/** http(s) links and app deep links (scheme://...); nothing that could be a shell or file trick. */
function readLink(body: unknown): string {
  const url = readString(body, 'url').trim();
  if (url.length > 2000 || !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+$/.test(url) || /^(file|content|javascript):/i.test(url)) {
    throw new HttpError(400, 'BAD_LINK', 'Expected a link such as https://example.com/claims or myapp://claims/123.');
  }
  return url;
}

/** Zoom in and Zoom out pinch around the middle of the screen by these factors. */
const ZOOM_IN_SCALE = 1.5;
const ZOOM_OUT_SCALE = 0.67;

const PHONE_KEYS = Object.keys(MAESTRO_KEY_OF) as PhoneKey[];

function readSwipe(body: unknown): { from: Point; to: Point; durationMs: number } {
  const { from, to, durationMs } = (body ?? {}) as { from?: unknown; to?: unknown; durationMs?: unknown };
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
    throw new HttpError(400, 'BAD_REQUEST', 'Expected { from: { x, y }, to: { x, y }, durationMs } in viewport pixels and milliseconds.');
  }
  return { from: readPoint(from), to: readPoint(to), durationMs };
}

/**
 * Controls Maestro 2.12 has no command for (Recent apps, pinch) work on the
 * device but are never recorded: a step that cannot be replayed would only
 * make the case fail on its first run.
 */
function refuseWhileRecording(state: ServerState, what: string): void {
  if (state.recorder?.active) {
    throw new HttpError(409, 'LIVE_ONLY', `${what} is off while recording: Maestro cannot replay it. Finish or discard the recording first.`);
  }
}

function sameSelector(a: MaestroSelector, b: MaestroSelector): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function projectInfo(state: ServerState): Promise<ProjectInfo> {
  const settings = await state.project.readSettings();
  const blocks = await state.project.listBlocks();
  const envKeyList = await state.project.envKeys();
  const envKeys = new Set(envKeyList);
  const summaries = await state.project.listCases();
  const cases: CaseListItem[] = [];
  for (const summary of summaries) {
    const runs = await state.project.listRuns(summary.id);
    cases.push({
      ...summary,
      health: caseHealth(runs, summary.editedAt),
      dependents: summaries.filter((item) => item.startFrom === summary.id).length,
    });
  }
  const paths = state.project.resolvedPaths();
  return {
    dir: state.project.dir,
    paths: { blocks: paths.blockDirs, flows: paths.flowsDir },
    appId: settings.appId,
    platform: settings.platform,
    runVideo: settings.runVideo === true,
    videoHasSteps: state.maestro.findFfmpeg() !== undefined,
    ...(settings.lastDeviceId ? { lastDeviceId: settings.lastDeviceId } : {}),
    blocks: blocks.map((block) => {
      const { outline } = block;
      const variables = outline?.variables ?? [];
      const missing = variables.filter((key) => !envKeys.has(key) && outline?.env?.[key] === undefined);
      const settable = settableVariables(block);
      const clears = outline?.commands.some((command) => command.kind === 'step' && command.step.kind === 'launchApp' && command.step.clearState) ?? false;
      return {
        file: block.file,
        name: block.name,
        ...(outline
          ? {
              stepCount: outline.commands.length,
              steps: outline.commands.map((command) => (command.kind === 'step' ? describeMaestroStep(command.step) : `${command.command} (runs in Maestro)`)),
            }
          : {}),
        ...(variables.length > 0 ? { variables } : {}),
        ...(missing.length > 0 ? { missingVariables: missing } : {}),
        ...(settable.length > 0 ? { settable } : {}),
        ...(clears ? { clearsAppData: true } : {}),
        ...(block.runsWith ? { runsWith: block.runsWith } : {}),
        ...(outline && outline.maestroOnly.length > 0 ? { maestroOnly: outline.maestroOnly } : {}),
        ...(block.error ? { error: block.error } : {}),
      };
    }),
    envKeys: envKeyList,
    cases,
    suiteRunning: suiteRunning(state),
  };
}

/** The latest snapshot, re-taken (without a screenshot) when it is too old to trust. */
async function freshLatest(state: ServerState): Promise<Latest> {
  let latest = state.latest;
  if (!latest || Date.now() - Date.parse(latest.takenAt) > STALE_SNAPSHOT_MS) {
    const fresh = await state.session.snapshot();
    latest = { ...fresh, screenshotPath: latest?.screenshotPath ?? scratchScreenshot(state) };
    state.latest = latest;
  }
  return latest;
}

/**
 * Runs a device action, records `record`'s step when a case is active, and
 * captures the screen into the step's evidence file (or the scratch file).
 */
async function recordedAction(
  state: ServerState,
  act: () => Promise<void>,
  record?: (recorder: Recorder, screenshot: string) => CaseStep,
  kind?: CaseStep['kind'],
  text?: string,
): Promise<ActionResponse> {
  await act();
  let screenshotPath = scratchScreenshot(state);
  let step: CaseStep | undefined;
  const recorder = state.recorder;
  if (record && kind && recorder?.active && recorder.caseId) {
    const evidence = state.project.evidencePath(recorder.caseId, recorder.evidenceNumberForNext(kind, text));
    step = record(recorder, evidence.relative);
    screenshotPath = evidence.absolute;
  }
  const screen = toScreenState(await captureInto(state, screenshotPath));
  return { ...(step ? { step: toStepView(step) } : {}), screen };
}

export function registerRoutes(app: FastifyInstance, state: ServerState): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      if (error.status >= 500) console.error(`[studio] ${request.method} ${request.url} failed: ${error.code}: ${error.message}`);
      return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(status).send({ error: { code: 'BAD_REQUEST', message } });
    }
    // Anything else came from the device layer; pass agent-device's message through.
    const described = describeDeviceError(error);
    request.log.error(error);
    console.error(`[studio] ${request.method} ${request.url} failed: ${described.code}: ${described.message}`);
    const message = described.hint ? `${described.message} (${described.hint})` : described.message;
    return reply.status(502).send({ error: { code: described.code, message } });
  });

  // While Run all holds the device, anything that would change the device or
  // the cases waits for it to end; reading stays possible.
  app.addHook('preHandler', async (request) => {
    if (!suiteRunning(state) || request.method === 'GET' || request.url.startsWith('/api/suite/stop')) return;
    if (!request.url.startsWith('/api/')) return;
    throw new HttpError(409, 'SUITE_RUNNING', 'Run all is running. Wait for it to finish, or stop it.');
  });

  // While the tester is using the phone, the phone is the input; only a check goes through the screen here.
  app.addHook('preHandler', async (request) => {
    if (!state.phone || !(request.url.startsWith('/api/action/') || request.url.startsWith('/api/case/block'))) return;
    throw new HttpError(409, 'USING_THE_PHONE', 'You are recording from the phone. Press Stop using the phone to use the screen here.');
  });

  app.get('/api/project', async () => projectInfo(state));

  app.put('/api/project', async (request) => {
    const appId = readString(request.body, 'appId').trim();
    await state.project.updateSettings({ appId });
    return projectInfo(state);
  });

  app.put('/api/project/run-video', async (request) => {
    const on = (request.body as { on?: unknown } | undefined)?.on;
    if (typeof on !== 'boolean') throw new HttpError(400, 'BAD_REQUEST', 'Say whether to keep run videos.');
    await state.project.updateSettings({ runVideo: on });
    return projectInfo(state);
  });

  app.get('/api/devices', async () => state.session.listDevices());

  app.get('/api/session', async (): Promise<SessionInfo> => ({
    open: state.session.isOpen,
    ...(state.session.deviceId ? { deviceId: state.session.deviceId } : {}),
    ...(state.session.appId ? { appId: state.session.appId } : {}),
  }));

  app.post('/api/session/open', async (request) => {
    const deviceId = readString(request.body, 'deviceId').trim();
    const appId = readString(request.body, 'appId').trim();
    if (state.recorder?.active) {
      throw new HttpError(409, 'CASE_ACTIVE', 'Finish or discard the current case before opening another app.');
    }
    return enqueue(state, async () => {
      if (state.session.isOpen && state.session.deviceId !== deviceId) await state.session.close();
      try {
        await state.session.open({ deviceId, appId });
      } catch (error) {
        if (!installRefused(error)) throw error;
        throw new HttpError(
          502,
          'PHONE_REFUSED_INSTALL',
          'The phone did not allow the install Ariadne needs. Watch the phone, tap Install when it asks, and press Connect again. On Xiaomi, Redmi and POCO phones, turn on Install via USB in Developer options first.',
        );
      }
      await state.project.updateSettings({ appId, lastDeviceId: deviceId });
      return toScreenState(await captureScratch(state));
    });
  });

  app.post('/api/session/close', async () => {
    await stopPhoneCapture(state);
    return enqueue(state, async () => {
      if (state.session.isOpen) await state.session.close();
      state.latest = undefined;
      return { ok: true };
    });
  });

  app.get('/api/screen', async () => {
    if (!state.latest) throw new HttpError(404, 'NO_SCREEN', 'Nothing has been captured yet.');
    return toScreenState(state.latest);
  });

  /** Takes a new look at the device, for a screen that changed without a step. */
  app.post('/api/screen/refresh', async () => {
    requireSession(state);
    return enqueue(state, async () => toScreenState(await captureScratch(state)));
  });

  app.get('/api/screen/image', async (_request, reply) => {
    if (!state.latest || !(await exists(state.latest.screenshotPath))) {
      throw new HttpError(404, 'NO_SCREEN', 'Nothing has been captured yet.');
    }
    return sendPng(reply, state.latest.screenshotPath);
  });

  app.post('/api/action/tap', async (request): Promise<ActionResponse> => {
    const point = readPoint(request.body);
    requireSession(state);
    return enqueue(state, async () => {
      const latest = await freshLatest(state);
      const node = resolveTapTarget(latest.nodes, point, latest.viewport);
      // Press the centre of the resolved node: that is what Maestro taps on replay.
      const response = await recordedAction(
        state,
        () => state.session.tapAt(node?.rect ? rectCenter(node.rect) : point),
        (recorder, screenshot) => recorder.recordTap(node, point, latest.viewport, screenshot, latest.nodes),
        'tap',
      );
      return { ...response, ...(node ? { resolved: toLiteNode(node) } : {}) };
    });
  });

  app.post('/api/action/type', async (request): Promise<ActionResponse> => {
    const text = (request.body as { text?: unknown } | undefined)?.text;
    if (typeof text !== 'string' || text.length === 0) {
      throw new HttpError(400, 'BAD_REQUEST', 'Expected a non-empty "text".');
    }
    requireSession(state);
    return enqueue(state, async () => {
      const recorder = state.recorder;
      // Text equal to a project env value is recorded as its ${KEY}; the device
      // still gets the real text. That is how secrets stay out of case files.
      let recordedText = text;
      if (recorder?.active) {
        const env = await projectEnv(state);
        const key = Object.keys(env)
          .sort()
          .find((candidate) => env[candidate] === text);
        if (key) {
          recordedText = `\${${key}}`;
        } else if (state.latest && focusedPasswordField(state.latest.nodes)) {
          throw new HttpError(
            400,
            'PASSWORD_FIELD',
            `This is a password field. Put the password in ${join(state.project.dir, '.env')} (for example PASSWORD=...) and type exactly that value; the case then records \${PASSWORD} instead of the secret.`,
          );
        }
      }
      return recordedAction(
        state,
        () => state.session.typeText(text),
        (active, screenshot) => active.recordInput(recordedText, screenshot),
        'type',
        recordedText,
      );
    });
  });

  app.post('/api/action/back', async (): Promise<ActionResponse> => {
    requireSession(state);
    return enqueue(state, () =>
      recordedAction(state, () => state.session.back(), (recorder, screenshot) => recorder.recordBack(screenshot), 'back'),
    );
  });

  app.post('/api/action/scroll', async (request): Promise<ActionResponse> => {
    const direction = (request.body as { direction?: unknown } | undefined)?.direction;
    if (direction !== 'down' && direction !== 'up') {
      throw new HttpError(400, 'BAD_REQUEST', 'Expected { direction: "down" } or { direction: "up" }.');
    }
    requireSession(state);
    return enqueue(state, () =>
      recordedAction(
        state,
        () => state.session.scroll(direction),
        (recorder, screenshot) => recorder.recordScroll(direction, screenshot),
        'scroll',
      ),
    );
  });

  app.post('/api/action/relaunch', async (): Promise<ActionResponse> => {
    requireSession(state);
    return enqueue(state, () =>
      recordedAction(state, () => state.session.relaunchApp(), (recorder, screenshot) => recorder.recordRelaunch(screenshot), 'relaunch'),
    );
  });

  app.post('/api/action/open-link', async (request): Promise<ActionResponse> => {
    const url = readLink(request.body);
    requireSession(state);
    return enqueue(state, () =>
      recordedAction(state, () => state.session.openLink(url), (recorder, screenshot) => recorder.recordOpenLink(url, screenshot), 'openLink'),
    );
  });

  app.post('/api/action/hide-keyboard', async (): Promise<ActionResponse> => {
    requireSession(state);
    return enqueue(state, () =>
      recordedAction(
        state,
        () => state.session.hideKeyboard(),
        (recorder, screenshot) => recorder.recordHideKeyboard(screenshot),
        'hideKeyboard',
      ),
    );
  });

  // Press and hold, and double tap: resolved to an element exactly like a tap.
  for (const [url, kind] of [
    ['/api/action/long-press', 'longPress'],
    ['/api/action/double-tap', 'doubleTap'],
  ] as const) {
    app.post(url, async (request): Promise<ActionResponse> => {
      const point = readPoint(request.body);
      requireSession(state);
      return enqueue(state, async () => {
        const latest = await freshLatest(state);
        const node = resolveTapTarget(latest.nodes, point, latest.viewport);
        const at = node?.rect ? rectCenter(node.rect) : point;
        const response = await recordedAction(
          state,
          () => (kind === 'longPress' ? state.session.longPressAt(at) : state.session.doubleTapAt(at)),
          (recorder, screenshot) =>
            kind === 'longPress'
              ? recorder.recordLongPress(node, point, latest.viewport, screenshot, latest.nodes)
              : recorder.recordDoubleTap(node, point, latest.viewport, screenshot, latest.nodes),
          kind,
        );
        return { ...response, ...(node ? { resolved: toLiteNode(node) } : {}) };
      });
    });
  }

  app.post('/api/action/swipe', async (request): Promise<ActionResponse> => {
    const { from, to, durationMs } = readSwipe(request.body);
    requireSession(state);
    return enqueue(state, async () => {
      const { viewport } = await freshLatest(state);
      // The device gets the same rounded percentages the step records, so recording and replay drag the same line.
      const start = percentOfScreen(from, viewport);
      const end = percentOfScreen(to, viewport);
      if (start.xPercent === end.xPercent && start.yPercent === end.yPercent) {
        throw new HttpError(400, 'BAD_SWIPE', 'The swipe is too short. Drag further across the screen.');
      }
      const duration = Math.min(MAX_SWIPE_MS, Math.max(MIN_SWIPE_MS, Math.round(durationMs)));
      return recordedAction(
        state,
        () => state.session.swipe(pointOnScreen(start, viewport), pointOnScreen(end, viewport), duration),
        (recorder, screenshot) => recorder.recordSwipe(start, end, duration, screenshot),
        'swipe',
      );
    });
  });

  app.post('/api/action/key', async (request): Promise<ActionResponse> => {
    const key = (request.body as { key?: unknown } | undefined)?.key;
    if (key !== 'appSwitch' && !PHONE_KEYS.includes(key as PhoneKey)) {
      throw new HttpError(400, 'BAD_REQUEST', `Expected { key } with one of ${[...PHONE_KEYS, 'appSwitch'].join(', ')}.`);
    }
    requireSession(state);
    if (key === 'appSwitch') {
      refuseWhileRecording(state, 'Recent apps');
      return enqueue(state, () => recordedAction(state, () => state.session.pressKey('appSwitch')));
    }
    const phoneKey = key as PhoneKey;
    return enqueue(state, () =>
      recordedAction(
        state,
        () => state.session.pressKey(phoneKey),
        (recorder, screenshot) => recorder.recordPressKey(phoneKey, screenshot),
        'pressKey',
      ),
    );
  });

  app.post('/api/action/rotate', async (request): Promise<ActionResponse> => {
    const orientation = (request.body as { orientation?: unknown } | undefined)?.orientation;
    if (orientation !== 'portrait' && orientation !== 'landscape') {
      throw new HttpError(400, 'BAD_REQUEST', 'Expected { orientation: "portrait" } or { orientation: "landscape" }.');
    }
    requireSession(state);
    return enqueue(state, () =>
      recordedAction(
        state,
        () => state.session.setOrientation(orientation),
        (recorder, screenshot) => recorder.recordOrientation(orientation, screenshot),
        'orientation',
      ),
    );
  });

  app.post('/api/action/pinch', async (request): Promise<ActionResponse> => {
    const zoom = (request.body as { zoom?: unknown } | undefined)?.zoom;
    if (zoom !== 'in' && zoom !== 'out') {
      throw new HttpError(400, 'BAD_REQUEST', 'Expected { zoom: "in" } or { zoom: "out" }.');
    }
    requireSession(state);
    refuseWhileRecording(state, zoom === 'in' ? 'Zoom in' : 'Zoom out');
    return enqueue(state, () => recordedAction(state, () => state.session.pinch(zoom === 'in' ? ZOOM_IN_SCALE : ZOOM_OUT_SCALE)));
  });

  /** Runs a setup block now, in the middle of the case, and records it as one step. */
  app.post('/api/case/block', async (request): Promise<ActionResponse> => {
    const requested = readBlockUse(request.body);
    requireSession(state);
    requireCase(state);
    const env = await projectEnv(state);
    const block = await prepareBlockUse(state, requested, env);
    const { use } = block;
    return enqueue(state, async () => {
      if (block.runsWithMaestro) {
        // Maestro's own launchApp restarts the app, so no relaunch first.
        const testCase = state.recorder!.toCase();
        const step: CaseStep = { index: 1, kind: 'block', file: use.file, ...(use.values ? { values: use.values } : {}), at: nowIso() };
        await runPrefixWithMaestro(state, {
          caseId: testCase.id,
          partial: { ...testCase, preconditionBlocks: [], steps: [step], expectations: [] },
          skipLaunch: true,
          what: `Block ${use.file}`,
        });
      } else {
        await runBlockNow(state, block, env, `Block ${use.file}`);
      }
      return recordedAction(
        state,
        async () => undefined,
        (recorder, screenshot) => recorder.recordBlock(use.file, screenshot, use.values),
        'block',
      );
    });
  });

  /**
   * Saves a test user as saved values in .env: "Supervisor" with USERNAME and
   * PASSWORD becomes SUPERVISOR_USERNAME and SUPERVISOR_PASSWORD, which a
   * block using USERNAME and PASSWORD then offers as "Supervisor".
   */
  app.post('/api/project/test-users', async (request): Promise<ProjectInfo> => {
    const { name, values } = (request.body ?? {}) as Partial<TestUserRequest>;
    if (typeof name !== 'string' || !isValues(values) || Object.keys(values).length === 0) {
      throw new HttpError(400, 'BAD_TEST_USER', 'Expected { name, values } with a value for each setting, such as { "USERNAME": "...", "PASSWORD": "..." }.');
    }
    const prefix = testUserPrefix(name);
    if (!prefix) throw new HttpError(400, 'BAD_TEST_USER', 'A test user needs a name that starts with a letter, such as "Supervisor" or "Agent Maria".');
    const saved: Record<string, string> = {};
    for (const [variable, value] of Object.entries(values)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new HttpError(400, 'BAD_TEST_USER', `"${variable}" is not a setting name.`);
      if (!value) throw new HttpError(400, 'BAD_TEST_USER', `Enter a value for ${variable}.`);
      saved[`${prefix}_${variable}`] = value;
    }
    try {
      await state.project.addEnvValues(saved);
    } catch (error) {
      throw new HttpError(409, 'BAD_TEST_USER', error instanceof Error ? error.message : String(error));
    }
    return projectInfo(state);
  });

  app.post('/api/case/start', async (request): Promise<CaseStartResponse> => {
    const name = readString(request.body, 'name').trim();
    const blocks = readBlocks(request.body);
    const startFromRaw = (request.body as { startFrom?: unknown } | undefined)?.startFrom;
    if (startFromRaw !== undefined && (typeof startFromRaw !== 'string' || !ID_PATTERN.test(startFromRaw))) {
      throw new HttpError(400, 'BAD_REQUEST', 'Expected "startFrom" to be the id of a saved case.');
    }
    const startFrom = startFromRaw as string | undefined;
    if (startFrom && blocks.length > 0) {
      throw new HttpError(400, 'BLOCKS_AND_START', 'Start from a saved case or from blocks, not both: the saved case runs its own blocks.');
    }
    requireSession(state);
    if (state.recorder?.active) {
      throw new HttpError(409, 'CASE_ACTIVE', 'A case is already being recorded. Finish or discard it first.');
    }
    const startEnv = await projectEnv(state);
    const prepared: PreparedBlock[] = [];
    for (const block of blocks) prepared.push(await prepareBlockUse(state, block, startEnv));
    if (startFrom) {
      const parent = await readSavedCase(state, startFrom);
      if (parent.appId !== state.session.appId) {
        throw new HttpError(409, 'WRONG_APP', `The case "${parent.name}" is for ${parent.appId}. Open that app first.`);
      }
    }
    const preconditionBlocks = prepared.map((block) => block.use);
    const withMaestro = await replayNeedsMaestro(state, { preconditionBlocks, steps: [], ...(startFrom ? { startFrom } : {}) });
    return enqueue(state, async () => {
      const deviceId = state.session.deviceId!;
      const appId = state.session.appId!;
      const caseId = await state.project.allocateCaseId(name);
      if (withMaestro) {
        // Maestro runs the start of the case exactly as the case's flow will.
        const partial = { id: caseId, name, appId, deviceId, createdAt: nowIso(), preconditionBlocks, ...(startFrom ? { startFrom } : {}), steps: [], expectations: [] };
        await runPrefixWithMaestro(state, { caseId, partial, what: 'Getting the app ready to record' });
      } else {
        // The flow starts with Maestro's launchApp, which restarts the app; restart
        // it here too so the recording begins on the screen the replay will see.
        await state.session.relaunchApp();
        const env = await projectEnv(state);
        if (startFrom) {
          const [parent] = await writeChainFlows(state, startFrom);
          const steps = await deviceReplaySteps(state, parent!, await state.project.envKeys());
          if (steps.every(agentDeviceReplays)) {
            // The app was just restarted, and the case's flow begins with launchApp.
            const parentFlow = { use: { file: state.project.relative(state.project.flowPath(startFrom)) }, path: state.project.flowPath(startFrom) };
            await runBlockNow(state, { ...parentFlow, launchesApp: false, runsWithMaestro: false }, env, `The case ${startFrom}`);
          } else {
            await replayCaseNow(state, parent!, steps, env);
          }
        }
        // The first block follows a fresh restart already; later ones that launch the app get their own.
        for (const [position, block] of prepared.entries()) {
          await runBlockNow(state, { ...block, launchesApp: block.launchesApp && position > 0 }, env, `Block ${block.use.file}`);
        }
      }
      const screen = toScreenState(await captureScratch(state));
      const recorder = new Recorder();
      recorder.start({
        id: caseId,
        name,
        appId,
        deviceId,
        preconditionBlocks,
        ...(startFrom ? { startFrom } : {}),
        envKeys: await state.project.envKeys(),
      });
      state.recorder = recorder;
      state.editing = undefined;
      return { caseId, screen };
    });
  });

  app.post('/api/case/expect', async (request): Promise<ActionResponse> => {
    const point = readPoint(request.body);
    requireSession(state);
    const recorder = requireCase(state);
    return enqueue(state, async () => {
      const latest = await freshLatest(state);
      const node = resolveTapTarget(latest.nodes, point, latest.viewport);
      if (!node || chooseSelector(node, latest.nodes, point, latest.viewport).kind === 'point') {
        throw new HttpError(400, 'NO_ELEMENT', 'Nothing with a name or id here. Click on a text or a control.');
      }
      // No device action: the step's evidence is the screen the BA looked at.
      const evidence = state.project.evidencePath(recorder.caseId!, recorder.evidenceNumberForNext('expect'));
      let screenshot: string | undefined;
      if (await exists(latest.screenshotPath)) {
        await mkdir(dirname(evidence.absolute), { recursive: true });
        await copyFile(latest.screenshotPath, evidence.absolute);
        screenshot = evidence.relative;
      }
      const step = recorder.recordExpect(node, point, latest.viewport, screenshot, latest.nodes);
      return { step: toStepView(step), screen: toScreenState(latest), resolved: toLiteNode(node) };
    });
  });

  app.get('/api/case/candidates', async (): Promise<CandidatesResponse> => {
    requireCase(state);
    requireSession(state);
    return enqueue(state, async () => {
      const latest = await freshLatest(state);
      const candidates = expectationCandidates(latest.nodes, latest.viewport);
      const previous = state.editing?.mode === 'rerecord' ? state.editing.originalExpectations : [];
      const preselected = candidates
        .filter((candidate) => previous.some((expectation) => sameSelector(expectation.selector, candidate.selector)))
        .map((candidate) => candidate.id);
      return preselected.length > 0 ? { candidates, preselected } : { candidates };
    });
  });

  app.post('/api/case/finish', async (request): Promise<CaseFinishResponse> => {
    const picks = readPicks(request.body);
    const recorder = requireCase(state);
    await stopPhoneCapture(state);
    return enqueue(state, async () => {
      const editing = state.editing;
      if (editing?.mode !== 'insert') {
        // Same snapshot as GET /api/case/candidates, so the same ids mean the same elements.
        const candidates = state.latest ? expectationCandidates(state.latest.nodes, state.latest.viewport) : [];
        const chosen = picks.map((pick) => {
          const candidate = candidates[pick];
          if (!candidate) throw new HttpError(400, 'BAD_PICK', `There is no candidate ${pick} on the current screen.`);
          return candidate;
        });
        if (editing) recorder.clearExpectations();
        for (const candidate of chosen) recorder.addExpectation({ selector: candidate.selector, node: candidate.node });
      }
      const testCase = recorder.toCase();
      if (editing?.mode === 'insert') {
        testCase.steps = [...testCase.steps, ...editing.tail].map((step, position) => ({ ...step, index: position + 1 }));
      }
      if (editing) {
        // Screenshots of replaced steps are no longer referenced by anything.
        const original = await state.project.readCase(editing.caseId).catch(() => undefined);
        const kept = new Set(testCase.steps.map((step) => step.screenshot));
        for (const step of original?.steps ?? []) {
          if (step.screenshot && !kept.has(step.screenshot)) await rm(state.project.path(step.screenshot), { force: true });
        }
      }
      const saved = await saveCaseAndFlow(state, testCase);
      state.recorder = undefined;
      state.editing = undefined;
      return {
        caseId: testCase.id,
        flowPath: saved.flowPath,
        flowFile: state.project.relative(saved.flowPath),
        yaml: saved.yaml,
      };
    });
  });

  app.post('/api/case/discard', async () => {
    const recorder = requireCase(state);
    await stopPhoneCapture(state);
    return enqueue(state, async () => {
      const caseId = recorder.caseId!;
      const editing = state.editing;
      state.recorder = undefined;
      state.editing = undefined;
      if (editing) {
        // The saved case is untouched; only the screenshots of the new steps go.
        const dir = state.project.evidenceDir(caseId);
        for (const name of await readdir(dir).catch(() => [] as string[])) {
          const number = evidenceNumber(name);
          if (number !== undefined && number >= editing.firstNewEvidence) await rm(join(dir, name), { force: true });
        }
        return { ok: true, caseId, restored: true };
      }
      // Nothing references these screenshots once the case is gone.
      await rm(state.project.evidenceDir(caseId), { recursive: true, force: true });
      return { ok: true, caseId };
    });
  });

  app.get('/api/case/current', async () => currentCaseView(state));

  app.get('/api/evidence/:caseId/:file', async (request, reply) => {
    const { caseId, file } = request.params as { caseId: string; file: string };
    if (!ID_PATTERN.test(caseId) || !/^step-\d{3,}\.png$/.test(file)) {
      throw new HttpError(400, 'BAD_REQUEST', 'Unknown evidence file.');
    }
    const path = state.project.path(`evidence/${caseId}/${file}`);
    if (!(await exists(path))) throw new HttpError(404, 'NOT_FOUND', 'No such screenshot.');
    return sendPng(reply, path);
  });

  registerCaseRoutes(app, state);
  registerReplayRoutes(app, state);
  registerExportRoutes(app, state);
  registerFileRoutes(app, state);
  registerPhoneRoutes(app, state);
}

