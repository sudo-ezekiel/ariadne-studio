// Replay with the Maestro CLI: one case, or every case (Run all), plus the
// screenshots and HTML reports of runs.
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  RUN_SCREENSHOT_PREFIX,
  RUN_VIDEO_NAME,
  attemptsOutcome,
  caseFlowItems,
  decodePng,
  describeDeviceError,
  describeFlowItem,
  encodePng,
  instrumentForRun,
  readMaestroCommands,
  relocateFlow,
  redactRunFiles,
  resizeImage,
  runReportHtml,
  runReportRows,
  screenSimilarity,
  suiteCounts,
  suiteOrder,
  suitePassed,
  suiteReportHtml,
  summarizeRun,
  toMaestroYaml,
  type MaestroRunResult,
  type RunMaestroOptions,
  type RunCommand,
  type RunSummary,
  type SuiteRun,
  type TestedOn,
  type TestCase,
} from '@ariadne/core';
import type { RunView, SuiteView } from '../shared/api-types.ts';
import {
  HttpError,
  blockNames,
  captureScratch,
  caseFlow,
  caseNames,
  reportNames,
  exists,
  projectEnv,
  readId,
  readSavedCase,
  sendPng,
  writeChainFlows,
} from './common.ts';
import { enqueue, suiteRunning, toRunView, type ServerState } from './state.ts';

type RunOptions = {
  deviceId: string;
  suiteId?: string;
  attempt?: number;
};

/** Adds the similarity of each replayed screenshot to the screenshot recorded for the same step. */
async function addSimilarity(state: ServerState, testCase: TestCase, summary: RunSummary): Promise<RunSummary> {
  const items = caseFlowItems(testCase);
  const steps = [];
  for (const result of summary.steps) {
    const item = items[result.flowIndex];
    const recorded = item?.kind === 'step' ? item.step.screenshot : undefined;
    // A relaunch replays a launchApp, which has no screenshot after it (see instrumentForRun).
    if (!recorded || !result.replayScreenshot || item?.kind !== 'step' || item.step.kind === 'relaunch') {
      steps.push(result);
      continue;
    }
    try {
      const [a, b] = await Promise.all([readFile(state.project.path(recorded)), readFile(state.project.path(result.replayScreenshot))]);
      steps.push({ ...result, similarity: screenSimilarity(decodePng(a), decodePng(b)) });
    } catch {
      // A screenshot that is missing or unreadable means no comparison, not a failure.
      steps.push(result);
    }
  }
  return { ...summary, steps };
}

/** Moves the video Maestro saved for a run to runs/<runId>/video.mp4, beside the report that links to it. */
async function keepRunVideo(debugDir: string, flowDirName: string): Promise<string | undefined> {
  const saved = join(debugDir, flowDirName, 'startRecording', `${RUN_VIDEO_NAME}.mp4`);
  if (!(await exists(saved))) return undefined;
  const kept = join(debugDir, 'video.mp4');
  await rename(saved, kept);
  return kept;
}

/**
 * Puts the case's steps beside the phone in the run video. A video without
 * them is still worth keeping, so nothing here can fail the run.
 */
async function frameVideo(state: ServerState, testCase: TestCase, summary: RunSummary, commands: readonly RunCommand[], device: string): Promise<void> {
  if (!summary.video) return;
  const ffmpeg = state.maestro.findFfmpeg();
  if (!ffmpeg) return;
  try {
    const started = Date.now();
    await state.maestro.frameVideo({
      video: state.project.path(summary.video),
      caseName: testCase.name,
      appId: testCase.appId,
      device,
      passed: summary.passed,
      rows: runReportRows(testCase, summary, await reportNames(state)),
      commands,
      ffmpeg,
    });
    console.log(`[studio] framed the video of ${summary.runId} in ${Date.now() - started} ms`);
  } catch (error) {
    console.error(`[studio] kept the phone video of ${summary.runId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * On a Xiaomi phone Maestro's launchApp does nothing until its driver may open
 * apps, and it still reports success, so a run would fail at its first tap with
 * a message about the wrong thing. Stop before that and say what to do. Returns
 * the Maestro options the phone needs: its driver stays, as every install asks.
 */
async function phoneRunOptions(state: ServerState, deviceId: string): Promise<{ keepDriver?: boolean }> {
  const xiaomi = await state.phoneTools.xiaomi(deviceId).catch(() => undefined);
  if (!xiaomi) return {};
  if (!xiaomi.driverOpensApps) {
    throw new HttpError(409, 'PHONE_NOT_READY', 'This Xiaomi phone stops Maestro from opening apps, so a run would fail at its first step. Open Set up a device and press Prepare this phone.');
  }
  return { keepDriver: true };
}

/** Runs Maestro, then ends the driver if the run left it on the phone, so the studio can read the screen again. */
async function runMaestroOnPhone(state: ServerState, options: RunMaestroOptions): Promise<MaestroRunResult> {
  try {
    return await state.maestro.run(options);
  } finally {
    if (options.keepDriver) await state.phoneTools.stopDriver(options.deviceId).catch(() => undefined);
  }
}

/**
 * Runs one saved case with Maestro and writes its summary. The caller owns
 * the device session: it must be closed, because Maestro brings its own
 * UiAutomator driver and only one can own the device.
 *
 * Maestro runs runs/<runId>/flow.yaml: the case flow with a screenshot after
 * every command and runFlow paths pointing back into flows/ and blocks/.
 * flows/<caseId>.yaml is rewritten from the case first, as are the flows of
 * every case it starts from, so the case JSON stays the source of truth.
 */
export async function runCase(state: ServerState, caseId: string, options: RunOptions): Promise<RunSummary> {
  const { project } = state;
  const phoneOptions = await phoneRunOptions(state, options.deviceId);
  let maestroBin: string;
  try {
    maestroBin = state.maestro.findBin();
  } catch (error) {
    throw new HttpError(500, 'MAESTRO_NOT_FOUND', error instanceof Error ? error.message : String(error));
  }
  const [testCase] = await writeChainFlows(state, caseId);
  const env = await projectEnv(state);
  const flow = await caseFlow(state, testCase!);
  const runId = await project.allocateRunId(caseId);
  const debugDir = project.runDir(runId);
  const ranFlowPath = `${debugDir}${sep}flow.yaml`;
  await mkdir(debugDir, { recursive: true });
  const { runVideo } = await project.readSettings();
  await writeFile(ranFlowPath, toMaestroYaml(instrumentForRun(flow, project.flowsDirFrom(debugDir), { video: runVideo === true })), 'utf8');

  console.log(`[studio] replay ${caseId} on ${options.deviceId}: running ${project.relative(ranFlowPath)}`);
  const startedAt = new Date().toISOString();
  let result: MaestroRunResult;
  try {
    result = await runMaestroOnPhone(state, {
      maestroBin,
      deviceId: options.deviceId,
      flowPath: ranFlowPath,
      debugDir,
      env,
      cwd: project.dir,
      androidHome: state.maestro.androidHome(),
      timeoutMs: state.maestro.timeoutMs,
      ...phoneOptions,
    });
  } catch (error) {
    throw new HttpError(500, 'MAESTRO_FAILED', `Could not run Maestro: ${error instanceof Error ? error.message : String(error)}`);
  }
  const finishedAt = new Date().toISOString();
  const read = await readMaestroCommands(debugDir);
  const video = runVideo && read ? await keepRunVideo(debugDir, read.flowDirName) : undefined;
  // Searched for signs of a device problem before redactRunFiles below hides the .env values in it.
  const diagnostics =
    result.exitCode === 0
      ? undefined
      : [
          await readFile(result.outputFile, 'utf8').catch(() => ''),
          await readFile(`${debugDir}${sep}maestro.log`, 'utf8').catch(() => ''),
          // Android drops a blocked launch silently: only the device log shows it.
          read ? await readFile(join(debugDir, read.flowDirName, 'logs', 'device-logcat.txt'), 'utf8').catch(() => '') : '',
        ].join('\n');
  let summary = summarizeRun({
    runId,
    caseId,
    flowFile: project.relative(project.flowPath(caseId)),
    startedAt,
    finishedAt,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    flow,
    commands: read?.commands,
    ...(read ? { flowDir: `${project.relative(debugDir)}/${read.flowDirName}` } : {}),
    outputFile: project.relative(result.outputFile),
    env,
    screenshotPrefix: RUN_SCREENSHOT_PREFIX,
    ...(diagnostics ? { diagnostics } : {}),
    ranFlowFile: project.relative(ranFlowPath),
    ...(video ? { video: project.relative(video) } : {}),
    ...(options.suiteId ? { suiteId: options.suiteId } : {}),
    ...(options.attempt ? { attempt: options.attempt } : {}),
  });
  summary = await addSimilarity(state, testCase!, summary);
  if (read) await frameVideo(state, testCase!, summary, read.commands, options.deviceId);
  await project.saveRun(summary);
  // Everything above has read Maestro's files; now hide the .env values Maestro wrote into them.
  await redactRunFiles(debugDir, env).catch((error: unknown) =>
    console.error(`[studio] could not hide .env values in ${project.relative(debugDir)}: ${error instanceof Error ? error.message : String(error)}`),
  );
  console.log(
    `[studio] replay ${caseId}: exit ${result.exitCode} after ${Math.round(result.durationMs / 1000)} s, ${summary.passed ? 'passed' : 'failed'}, run ${runId}`,
  );
  return summary;
}

/** What runPrefixWithMaestro runs: the start of a case, as the case's own flow would run it. */
export type MaestroPrefix = {
  /** The case being recorded or edited; names runs/_partial/<caseId>.yaml. */
  caseId: string;
  /** The part of the case to run: its blocks or start case, and the steps kept. */
  partial: TestCase;
  /** Leave out the leading launchApp: for a block run in the middle of a recording. */
  skipLaunch?: boolean;
  /** Says what was being done, for errors: "Running the case up to step 3". */
  what: string;
};

/**
 * Runs the start of a case with the Maestro CLI instead of agent-device,
 * because a block in it uses commands outside Ariadne's subset. The flow is
 * the one the case emits (launchApp, then each runFlow with its env), so the
 * recording starts where a run will be. It is written to
 * runs/_partial/<caseId>.yaml, Maestro gets the device and the .env values,
 * and the session is reopened afterwards without a relaunch, as for Run.
 * Maestro's output is kept beside it, with .env values hidden, only when the
 * run fails. A failure is a 502 that names the block and quotes Maestro.
 */
export async function runPrefixWithMaestro(state: ServerState, prefix: MaestroPrefix): Promise<void> {
  const { project } = state;
  let maestroBin: string;
  try {
    maestroBin = state.maestro.findBin();
  } catch (error) {
    throw new HttpError(500, 'MAESTRO_NOT_FOUND', error instanceof Error ? error.message : String(error));
  }
  const deviceId = state.session.deviceId;
  if (!deviceId) throw new HttpError(409, 'NO_SESSION', 'No device connected. Pick a device, enter the app id and click Connect first.');
  const phoneOptions = await phoneRunOptions(state, deviceId);
  if (prefix.partial.startFrom) await writeChainFlows(state, prefix.partial.startFrom);
  const env = await projectEnv(state);
  const flowPath = project.partialFlowPath(prefix.caseId);
  const dir = dirname(flowPath);
  const debugDir = join(dir, `${prefix.caseId}-maestro`);
  const written = await caseFlow(state, prefix.partial);
  const skipped = prefix.skipLaunch ? 1 : 0;
  const flow = relocateFlow({ ...written, steps: written.steps.slice(skipped) }, project.flowsDirFrom(dir));
  await rm(debugDir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(flowPath, toMaestroYaml(flow), 'utf8');

  console.log(`[studio] ${prefix.what} on ${deviceId}: running ${project.relative(flowPath)} with Maestro`);
  let result: MaestroRunResult;
  try {
    result = await withSessionHandedToMaestro(state, () =>
      runMaestroOnPhone(state, {
        maestroBin,
        deviceId,
        flowPath,
        debugDir,
        env,
        cwd: project.dir,
        androidHome: state.maestro.androidHome(),
        timeoutMs: state.maestro.timeoutMs,
        ...phoneOptions,
      }),
    );
  } catch (error) {
    throw new HttpError(500, 'MAESTRO_FAILED', `Could not run Maestro: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(flowPath, { force: true });
  }
  const read = await readMaestroCommands(debugDir);
  const summary = summarizeRun({
    runId: prefix.caseId,
    caseId: prefix.caseId,
    flowFile: project.relative(flowPath),
    startedAt: '',
    finishedAt: '',
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    flow,
    commands: read?.commands,
    outputFile: project.relative(result.outputFile),
    env,
  });
  await redactRunFiles(debugDir, env).catch(() => undefined);
  if (summary.passed) {
    await rm(debugDir, { recursive: true, force: true });
    console.log(`[studio] ${prefix.what}: Maestro passed after ${Math.round(result.durationMs / 1000)} s`);
    return;
  }
  const failed = summary.steps.find((step) => step.status === 'failed');
  const item = failed ? caseFlowItems(prefix.partial)[failed.flowIndex + skipped] : undefined;
  const reason = failed?.error ?? summary.error ?? `Maestro exited with code ${result.exitCode}; see ${summary.outputFile}.`;
  const blockFile = item?.kind === 'block' ? item.file : item?.kind === 'step' && item.step.kind === 'block' ? item.step.file : undefined;
  let message: string;
  if (blockFile) {
    const name = (await blockNames(state)).get(blockFile);
    message = `The block ${name ? `"${name}" (${blockFile})` : blockFile} failed in Maestro: ${reason}`;
  } else if (item) {
    const names = await caseNames(state);
    const blocks = await blockNames(state);
    const described = describeFlowItem(item, prefix.partial.appId, { caseName: (id) => names.get(id), blockName: (file) => blocks.get(file) });
    message = `${prefix.what} failed in Maestro at "${described}": ${reason}`;
  } else {
    message = `${prefix.what} failed in Maestro: ${reason}`;
  }
  console.error(`[studio] ${prefix.what}: ${message}`);
  throw new HttpError(502, 'MAESTRO_PREFIX_FAILED', message);
}

/** The device a replay runs on: the open session's, else the last one used, else the case's. */
async function replayDevice(state: ServerState, fallback?: string): Promise<string> {
  const settings = await state.project.readSettings();
  const deviceId = state.session.deviceId ?? settings.lastDeviceId ?? fallback;
  if (!deviceId || !(await state.session.listDevices()).some((device) => device.id === deviceId)) {
    throw new HttpError(400, 'NO_DEVICE', `Device ${deviceId ?? '(none)'} is not connected. Boot or connect it, then try again.`);
  }
  return deviceId;
}

/** Closes the studio's session for Maestro and reopens it (without a relaunch) when `task` ends. */
async function withSessionHandedToMaestro<T>(state: ServerState, task: () => Promise<T>): Promise<T> {
  const { session } = state;
  const previous = session.isOpen && session.deviceId && session.appId ? { deviceId: session.deviceId, appId: session.appId } : undefined;
  if (previous) await session.close();
  try {
    return await task();
  } finally {
    if (previous) {
      try {
        await session.open(previous);
        await captureScratch(state);
      } catch (error) {
        state.latest = undefined;
        console.error(`[studio] could not reopen ${previous.deviceId} after replay: ${describeDeviceError(error).message}`);
      }
    }
  }
}

async function runView(state: ServerState, summary: RunSummary): Promise<RunView> {
  const testCase = await state.project.readCase(summary.caseId).catch(() => undefined);
  return toRunView(summary, testCase?.editedAt);
}

function suiteView(run: SuiteRun): SuiteView {
  return { ...run, counts: suiteCounts(run), passed: suitePassed(run), reportUrl: `/api/suites/${encodeURIComponent(run.suiteId)}/report` };
}

/** What a failed run failed at, as a sentence. */
async function failedStepText(state: ServerState, testCase: TestCase, summary: RunSummary): Promise<string | undefined> {
  const failed = summary.steps.find((step) => step.status === 'failed');
  if (!failed) return summary.error;
  const item = caseFlowItems(testCase)[failed.flowIndex];
  if (!item) return failed.error;
  const names = await caseNames(state);
  const blocks = await blockNames(state);
  return describeFlowItem(item, testCase.appId, { caseName: (id) => names.get(id), blockName: (file) => blocks.get(file) });
}

/** The phone and the version of each app Run all is about to test, for its evidence pack. Never stops Run all. */
async function readTestedOn(state: ServerState, suite: SuiteRun): Promise<TestedOn | undefined> {
  const appIds: string[] = [];
  for (const item of suite.cases) {
    if (item.outcome === 'muted') continue;
    const testCase = await state.project.readCase(item.caseId).catch(() => undefined);
    if (testCase) appIds.push(testCase.appId);
  }
  try {
    return await state.phoneTools.testedOn(suite.deviceId, [...new Set(appIds)]);
  } catch (error) {
    console.error(`[studio] could not read the phone and app versions for ${suite.suiteId}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function runSuite(state: ServerState, job: { run: SuiteRun; stopRequested: boolean }): Promise<void> {
  const { project } = state;
  const suite = job.run;
  const save = () => project.saveSuite(suite).catch((error: unknown) => console.error(`[studio] could not save ${suite.suiteId}:`, error));
  await save();
  const testedOn = await readTestedOn(state, suite);
  if (testedOn) {
    suite.testedOn = testedOn;
    await save();
  }
  try {
    await withSessionHandedToMaestro(state, async () => {
      for (const item of suite.cases) {
        if (item.outcome === 'muted') continue;
        if (job.stopRequested) break;
        item.outcome = 'running';
        await save();
        // Results of the attempts that count; a run lost to a device problem
        // is retried once on top of them and does not make the case flaky.
        const attempts: boolean[] = [];
        const maxAttempts = suite.retryFailed ? 2 : 1;
        let deviceRetried = false;
        let lastDeviceProblem: string | undefined;
        for (let attempt = 1; attempts.length < maxAttempts; attempt++) {
          try {
            const summary = await runCase(state, item.caseId, { deviceId: suite.deviceId, suiteId: suite.suiteId, attempt });
            item.runIds.push(summary.runId);
            lastDeviceProblem = summary.deviceProblem;
            if (summary.passed) {
              attempts.push(true);
              delete item.failedStep;
              break;
            }
            if (summary.deviceProblem && !deviceRetried) {
              deviceRetried = true;
              item.note = `Run ${attempt} was retried: ${summary.deviceProblem.replace(/ This is not a test failure; run it again\.$/, '')}`;
              continue;
            }
            attempts.push(false);
            const testCase = await project.readCase(item.caseId);
            const failedAt = await failedStepText(state, testCase, summary);
            if (failedAt) item.failedStep = failedAt;
          } catch (error) {
            item.outcome = 'error';
            item.error = error instanceof Error ? error.message : String(error);
            break;
          }
          if (job.stopRequested) break;
        }
        if (item.outcome !== 'error') item.outcome = attemptsOutcome(attempts);
        // Failing because of the device again is not the case's fault either.
        if (item.outcome === 'failed' && lastDeviceProblem) {
          item.outcome = 'error';
          item.error = lastDeviceProblem;
        }
        if (item.outcome === 'pending') item.outcome = 'error';
        await save();
      }
    });
  } finally {
    suite.status = job.stopRequested ? 'stopped' : 'finished';
    suite.finishedAt = new Date().toISOString();
    await save();
    const counts = suiteCounts(suite);
    console.log(`[studio] run all ${suite.suiteId} ${suite.status}: ${JSON.stringify(counts)}`);
  }
}

/** Data URL of a project image, downscaled to `maxWidth` when it is wider. */
async function imageDataUrl(state: ServerState, projectRelative: string, maxWidth = 540): Promise<string | undefined> {
  try {
    const bytes = await readFile(state.project.path(projectRelative));
    let png: Uint8Array = bytes;
    try {
      const image = decodePng(bytes);
      if (image.width > maxWidth) {
        png = encodePng(resizeImage(image, maxWidth, Math.round((image.height * maxWidth) / image.width)));
      }
    } catch {
      // Not a PNG we can read: inline it as it is.
    }
    return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  } catch {
    return undefined;
  }
}

/** Resolves every image a report needs up front, so the pure HTML builders can stay synchronous. */
export async function imageMap(state: ServerState, paths: Array<string | undefined>, maxWidth?: number): Promise<(path: string) => string | undefined> {
  const map = new Map<string, string>();
  for (const path of new Set(paths.filter((item): item is string => Boolean(item)))) {
    const url = await imageDataUrl(state, path, maxWidth);
    if (url) map.set(path, url);
  }
  return (path) => map.get(path);
}

/** The bytes a `Range: bytes=a-b` header asks for; undefined sends the whole file. */
function byteRange(header: string | undefined, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header ?? '');
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end ? { start, end } : undefined;
}

/** Confines a project-relative path from a run summary to that run's directory. */
function runFile(state: ServerState, runId: string, projectRelative: string): string {
  const runDir = state.project.runDir(runId);
  let path: string;
  try {
    path = state.project.path(projectRelative);
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'The run summary points outside the project.');
  }
  if (!path.startsWith(runDir + sep)) throw new HttpError(400, 'BAD_REQUEST', 'The run summary points outside its run directory.');
  return path;
}

export function registerReplayRoutes(app: FastifyInstance, state: ServerState): void {
  app.post('/api/cases/:caseId/replay', async (request): Promise<RunView> => {
    const caseId = readId(request.params, 'caseId');
    if (state.recorder?.active) {
      throw new HttpError(409, 'CASE_ACTIVE', 'Finish or discard the case being recorded before running a case.');
    }
    const testCase = await readSavedCase(state, caseId);
    return enqueue(state, async () => {
      const deviceId = await replayDevice(state, testCase.deviceId);
      const summary = await withSessionHandedToMaestro(state, async () => {
        const first = await runCase(state, caseId, { deviceId });
        if (first.passed || !first.deviceProblem) return first;
        // The device, not the app, failed (for example adb dropped the
        // connection). Both runs are kept; the case is judged on the second.
        console.log(`[studio] replay ${caseId}: retrying once, ${first.deviceProblem}`);
        return runCase(state, caseId, { deviceId, attempt: 2 });
      });
      return runView(state, summary);
    });
  });

  app.get('/api/runs/:runId', async (request): Promise<RunView> => {
    const runId = readId(request.params, 'runId');
    const summary = await state.project.readRun(runId).catch(() => undefined);
    if (!summary) throw new HttpError(404, 'NOT_FOUND', `No run ${runId}.`);
    return runView(state, summary);
  });

  app.get('/api/runs/:runId/screenshot', async (request, reply) => {
    const runId = readId(request.params, 'runId');
    const summary = await state.project.readRun(runId).catch(() => undefined);
    if (!summary?.failureScreenshot) throw new HttpError(404, 'NOT_FOUND', 'This run has no failure screenshot.');
    const path = runFile(state, runId, summary.failureScreenshot);
    if (!(await exists(path))) throw new HttpError(404, 'NOT_FOUND', 'The failure screenshot is missing.');
    return sendPng(reply, path);
  });

  app.get('/api/runs/:runId/shots/:name', async (request, reply) => {
    const runId = readId(request.params, 'runId');
    const name = (request.params as { name?: string }).name ?? '';
    if (!new RegExp(`^${RUN_SCREENSHOT_PREFIX}\\d{3,}$`).test(name)) throw new HttpError(400, 'BAD_REQUEST', 'Unknown screenshot.');
    const summary = await state.project.readRun(runId).catch(() => undefined);
    const step = summary?.steps.find((item) => item.replayScreenshot?.endsWith(`/${name}.png`));
    if (!step?.replayScreenshot) throw new HttpError(404, 'NOT_FOUND', 'This run has no such screenshot.');
    const path = runFile(state, runId, step.replayScreenshot);
    if (!(await exists(path))) throw new HttpError(404, 'NOT_FOUND', 'The screenshot is missing.');
    return sendPng(reply, path);
  });

  // Named video.mp4 so the report's relative link works here and from runs/<runId>/report.html on disk.
  app.get('/api/runs/:runId/video.mp4', async (request, reply) => {
    const runId = readId(request.params, 'runId');
    const summary = await state.project.readRun(runId).catch(() => undefined);
    if (!summary?.video) throw new HttpError(404, 'NOT_FOUND', 'This run has no video.');
    const path = runFile(state, runId, summary.video);
    const info = await stat(path).catch(() => undefined);
    if (!info) throw new HttpError(404, 'NOT_FOUND', 'The video is missing.');
    reply.header('accept-ranges', 'bytes').header('cache-control', 'no-store').type('video/mp4');
    const range = byteRange(request.headers.range, info.size);
    if (!range) return reply.header('content-length', info.size).send(createReadStream(path));
    return reply
      .status(206)
      .header('content-range', `bytes ${range.start}-${range.end}/${info.size}`)
      .header('content-length', range.end - range.start + 1)
      .send(createReadStream(path, range));
  });

  app.get('/api/runs/:runId/report', async (request, reply) => {
    const runId = readId(request.params, 'runId');
    const summary = await state.project.readRun(runId).catch(() => undefined);
    if (!summary) throw new HttpError(404, 'NOT_FOUND', `No run ${runId}.`);
    const testCase = await readSavedCase(state, summary.caseId);
    const rows = runReportRows(testCase, summary, await reportNames(state));
    const image = await imageMap(state, [...rows.flatMap((row) => [row.recorded, row.replayed]), summary.failureScreenshot]);
    const html = runReportHtml({
      caseName: testCase.name,
      caseId: testCase.id,
      appId: testCase.appId,
      run: summary,
      rows,
      image,
      stale: Boolean(testCase.editedAt && summary.startedAt < testCase.editedAt),
    });
    await writeFile(`${state.project.runDir(runId)}${sep}report.html`, html, 'utf8');
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  });

  app.post('/api/suite/run', async (request, reply) => {
    if (suiteRunning(state)) throw new HttpError(409, 'SUITE_RUNNING', 'Run all is already running.');
    if (state.recorder?.active) throw new HttpError(409, 'CASE_ACTIVE', 'Finish or discard the case being recorded first.');
    const retryFailed = (request.body as { retryFailed?: unknown } | undefined)?.retryFailed !== false;
    const cases = suiteOrder(await state.project.listCases());
    if (cases.length === 0) throw new HttpError(400, 'NO_CASES', 'There are no saved cases to run.');
    const deviceId = await replayDevice(state);
    // Checked again after the await: two clicks must not start two suites.
    if (suiteRunning(state)) throw new HttpError(409, 'SUITE_RUNNING', 'Run all is already running.');
    // The previous suite may not have reached disk yet; its id is taken too.
    const suiteId = await state.project.allocateSuiteId(new Date(), state.suite ? [state.suite.run.suiteId] : []);
    if (suiteRunning(state)) throw new HttpError(409, 'SUITE_RUNNING', 'Run all is already running.');
    const run: SuiteRun = {
      suiteId,
      startedAt: new Date().toISOString(),
      status: 'running',
      retryFailed,
      deviceId,
      cases: cases.map((item) => ({ caseId: item.id, name: item.name, outcome: item.muted ? 'muted' : 'pending', runIds: [] })),
    };
    const job = { run, stopRequested: false, done: Promise.resolve() };
    state.suite = job;
    // Queued behind any device work in flight; holds the queue until the suite ends.
    job.done = enqueue(state, () => runSuite(state, job)).catch((error: unknown) => {
      console.error(`[studio] run all ${suiteId} failed:`, error);
    });
    return reply.status(202).send(suiteView(run));
  });

  app.post('/api/suite/stop', async () => {
    if (!state.suite || !suiteRunning(state)) throw new HttpError(409, 'NO_SUITE', 'Run all is not running.');
    state.suite.stopRequested = true;
    return suiteView(state.suite.run);
  });

  app.get('/api/suite/current', async (): Promise<SuiteView | null> => {
    if (state.suite) return suiteView(state.suite.run);
    const [latest] = await state.project.listSuites(1);
    return latest ? suiteView(latest) : null;
  });

  app.get('/api/suites', async (): Promise<SuiteView[]> => (await state.project.listSuites()).map(suiteView));

  app.get('/api/suites/:suiteId/report', async (request, reply) => {
    const suiteId = readId(request.params, 'suiteId');
    const suite =
      state.suite?.run.suiteId === suiteId ? state.suite.run : await state.project.readSuite(suiteId).catch(() => undefined);
    if (!suite) throw new HttpError(404, 'NOT_FOUND', `No suite run ${suiteId}.`);
    const cases = [];
    for (const item of suite.cases) {
      const lastRunId = item.runIds.at(-1);
      const summary = lastRunId ? await state.project.readRun(lastRunId).catch(() => undefined) : undefined;
      cases.push({
        name: item.name,
        caseId: item.caseId,
        outcome: item.outcome,
        attempts: item.runIds.length,
        ...(item.failedStep ? { failedStep: item.failedStep } : {}),
        ...(item.note ? { note: item.note } : {}),
        ...(item.error ? { error: item.error } : summary && !summary.passed && summary.error ? { error: summary.error } : {}),
        ...(summary && !summary.passed && summary.failureScreenshot ? { failureScreenshot: summary.failureScreenshot } : {}),
      });
    }
    const image = await imageMap(state, cases.map((item) => item.failureScreenshot));
    const html = suiteReportHtml(suite, cases, image);
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  });
}
