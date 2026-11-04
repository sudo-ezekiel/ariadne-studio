// End-to-end proof for Milestones 1 and 2, with no browser: record cases on
// the Android Settings app through @ariadne/core exactly as the studio server
// does, write them under workspace/flows/, replay them with the Maestro CLI,
// and check that a failing run is parsed into the right per-step result.
// Exits non-zero if recording, replay or the failure check goes wrong.
//
// Targets are chosen by reading the snapshot, never fixed coordinates.
//
// Case A starts like a studio case with a precondition block: the app is
// restarted and blocks/open-settings.yaml is replayed through agent-device
// inside the recording session (it opens "Network & internet"). Then:
//   1. Back, to the Settings home screen
//   2. Scroll down
//   3. tap a safe entry that was not on screen before the scroll ("System"
//      when it is one of them)                                   -> text selector
//   4. Expect the page title, an inline assertVisible           -> id selector
//   5. Back
// and the case is finished with the first expectation candidate of the final
// screen. The scroll is emitted as scrollUntilVisible on the tapped entry.
//
// Case B has no block: Scroll down is the very first step after launchApp,
// then a tap on an entry the scroll revealed, then Back, finished with no
// end expectation. A plain Maestro `scroll` here runs before the list is drawn
// and scrolls nothing; scrollUntilVisible waits for it.
//
// Maestro replays both flows and every step must pass; each result is saved
// as runs/<runId>/summary.json, like a studio Replay. Then a copy of case A's
// flow with an assertVisible on a text that does not exist, inserted before
// the final Back, is run. That run must exit 1, the inserted step must be
// reported as failed with Maestro's message and screenshot, and the Back
// after it as not run.
//
// The emulator may be shared with other tools. If another process launches a
// different app on it mid-run (seen in logcat), the attempt is retried.
//
// Environment overrides:
//   SMOKE_DEVICE       adb serial of the device (default emulator-5556)
//   SMOKE_PROJECT_DIR  project directory (default <repo>/workspace)
//   SMOKE_ATTEMPTS     attempts when another app interferes (default 2)
//   MAESTRO_BIN        Maestro CLI path (default ~/.maestro/bin/maestro, then PATH)
//   ANDROID_HOME       Android SDK (default ~/Android/Sdk when it exists)

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DeviceSession,
  ProjectStore,
  Recorder,
  androidHome,
  chooseSelector,
  describeDeviceError,
  describeSelector,
  escapeMaestroRegex,
  expectationCandidates,
  findMaestro,
  isAgentDeviceError,
  parseMaestroFlow,
  readMaestroCommands,
  rectCenter,
  resolveNodeAt,
  runMaestro,
  summarizeRun,
  toMaestroYaml,
  type CaseStep,
  type DeviceSnapshot,
  type MaestroFlow,
  type MaestroStep,
  type Point,
  type RunSummary,
  type ScreenCapture,
} from '@ariadne/core';

type Node = DeviceSnapshot['nodes'][number];

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const projectDir = resolve(process.env.SMOKE_PROJECT_DIR ?? join(repoRoot, 'workspace'));
const deviceId = process.env.SMOKE_DEVICE ?? 'emulator-5556';
const attempts = Math.max(1, Number(process.env.SMOKE_ATTEMPTS ?? 2));
const appId = 'com.android.settings';
const sessionName = 'ariadne-smoke';
const block = 'blocks/open-settings.yaml';
const missingText = 'This text does not exist anywhere';
const maestroTimeoutMs = 5 * 60_000;

// Entries that leave the Settings app, change device state for everyone on
// the emulator, or are slow to load. Rows with a switch are skipped as well.
const UNSAFE_ENTRY = /google|airplane|reset|erase|delete|remove|sign out|log out|emergency|battery saver|hotspot|tethering/i;
// Only the Settings home screen has these.
const HOME_MARKER = /:id\/(settings_homepage_container|search_action_bar)$/;

class InterferenceError extends Error {}

function log(message: string): void {
  console.log(`[smoke] ${message}`);
}

function fail(message: string): never {
  throw new Error(message);
}

function adbPath(): string {
  const sdk = androidHome();
  const inSdk = sdk ? join(sdk, 'platform-tools', 'adb') : undefined;
  return inSdk && existsSync(inSdk) ? inSdk : 'adb';
}

function adb(...args: string[]): string {
  return execFileSync(adbPath(), ['-s', deviceId, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Device clock in logcat's -T format, so later reads only see what happened after it. */
function deviceTime(): string | undefined {
  try {
    return adb('shell', 'date', '+%m-%d %H:%M:%S.000').trim();
  } catch {
    return undefined;
  }
}

/**
 * Apps other than `appId` started from a shell since `since`. Settings opening
 * its own sub-screens is not a shell start, and Maestro's launchApp starts
 * `appId` itself, so anything listed here came from another process.
 */
function foreignLaunches(since: string | undefined): string[] {
  if (!since) return [];
  try {
    const lines = adb('logcat', '-d', '-v', 'time', '-T', since, '-s', 'ActivityTaskManager:I').split('\n');
    return lines
      .filter((line) => line.includes('START u0') && line.includes('from uid 2000'))
      .map((line) => ({ line, pkg: /cmp=([^/\s]+)\//.exec(line)?.[1] }))
      .filter(({ pkg }) => pkg && pkg !== appId)
      .map(({ line, pkg }) => `${line.slice(0, 18)} ${pkg}`);
  } catch {
    return [];
  }
}

function byIndexMap(nodes: Node[]): Map<number, Node> {
  return new Map(nodes.map((node) => [node.index, node]));
}

/** Nearest hittable ancestor, which is the tappable row a title belongs to. */
function rowOf(node: Node, byIndex: Map<number, Node>): Node | undefined {
  let current = node.parentIndex === undefined ? undefined : byIndex.get(node.parentIndex);
  while (current) {
    if (current.hittable) return current;
    current = current.parentIndex === undefined ? undefined : byIndex.get(current.parentIndex);
  }
  return undefined;
}

function isInside(inner: Node, outer: Node, byIndex: Map<number, Node>): boolean {
  let current: Node | undefined = inner;
  while (current) {
    if (current === outer) return true;
    current = current.parentIndex === undefined ? undefined : byIndex.get(current.parentIndex);
  }
  return false;
}

function navBarTop(snapshot: DeviceSnapshot): number {
  return Math.min(
    snapshot.viewport.height,
    ...snapshot.nodes.filter((node) => node.systemBar === 'navigation' && node.rect).map((node) => node.rect!.y),
  );
}

/**
 * Settings entries on screen, top to bottom: preference titles (android:id/title)
 * inside a tappable row that is fully on screen and has no switch in it.
 */
function settingsEntries(snapshot: DeviceSnapshot): Node[] {
  const { nodes } = snapshot;
  const byIndex = byIndexMap(nodes);
  const bottom = navBarTop(snapshot);
  return nodes
    .filter(
      (node) =>
        node.identifier === 'android:id/title' &&
        node.label?.trim() &&
        !node.systemBar &&
        node.rect &&
        node.rect.y > 0 &&
        node.rect.y + node.rect.height < bottom &&
        !UNSAFE_ENTRY.test(node.label),
    )
    .filter((title) => {
      const row = rowOf(title, byIndex);
      if (!row?.rect || row.rect.y + row.rect.height > bottom) return false;
      return !nodes.some((node) => node.checked !== undefined && isInside(node, row, byIndex));
    })
    .sort((a, b) => a.rect!.y - b.rect!.y || a.rect!.x - b.rect!.x);
}

/** A labelled, non-interactive page title with a resource-id no other node shares. */
function pageTitleWithId(snapshot: DeviceSnapshot): Node | undefined {
  const counts = new Map<string, number>();
  for (const node of snapshot.nodes) {
    if (node.identifier) counts.set(node.identifier, (counts.get(node.identifier) ?? 0) + 1);
  }
  return snapshot.nodes.find(
    (node) =>
      node.identifier?.endsWith(':id/collapsing_toolbar') &&
      counts.get(node.identifier) === 1 &&
      node.label?.trim() &&
      node.rect &&
      !node.hittable,
  );
}

function isHome(snapshot: DeviceSnapshot): boolean {
  return snapshot.nodes.some((node) => node.identifier && HOME_MARKER.test(node.identifier));
}

function foregroundPackages(snapshot: DeviceSnapshot): Set<string> {
  return new Set(
    snapshot.nodes.filter((node) => !node.systemBar && node.bundleId).map((node) => node.bundleId as string),
  );
}

/** Presses Back until the Settings home screen shows; relaunches as a last resort. */
async function goHome(session: DeviceSession): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const snapshot = await session.snapshot();
    if (isHome(snapshot)) return true;
    if (!foregroundPackages(snapshot).has(appId) && attempt > 0) break;
    await session.back();
  }
  await session.open({ deviceId, appId, relaunch: true });
  return isHome(await session.snapshot());
}

type Recorded = { caseId: string; flowPath: string; steps: CaseStep[] };

function describeStep(step: MaestroStep | undefined): string {
  if (!step) return '(no step)';
  switch (step.kind) {
    case 'tapOn':
    case 'assertVisible':
    case 'assertNotVisible':
      return `${step.kind} ${describeSelector(step.selector)}`;
    case 'runFlow':
      return `runFlow ${step.file}`;
    case 'inputText':
      return 'inputText';
    case 'swipe':
      return 'direction' in step ? `swipe ${step.direction}` : `swipe ${step.start.xPercent}%,${step.start.yPercent}% to ${step.end.xPercent}%,${step.end.yPercent}%`;
    case 'scrollUntilVisible':
      return `scrollUntilVisible ${step.direction} ${describeSelector(step.selector)}`;
    default:
      return step.kind;
  }
}

function printRun(label: string, summary: RunSummary): void {
  console.log(`\n----- ${label}: exit ${summary.exitCode}, ${summary.passed ? 'PASSED' : 'FAILED'} -----`);
  for (const result of summary.steps) {
    const duration = result.durationMs === undefined ? '' : ` ${result.durationMs} ms`;
    console.log(`  ${String(result.flowIndex + 1).padStart(2)}. ${result.status.padEnd(7)} ${describeStep(result.step)}${duration}`);
    if (result.error) console.log(`        error: ${result.error}`);
    if (result.warning) console.log(`        warning: ${result.warning}`);
  }
  if (summary.error) console.log(`  ${summary.error}`);
  if (summary.failureScreenshot) console.log(`  failure screenshot: ${summary.failureScreenshot}`);
  console.log('-----\n');
}

/** The studio's recording actions, in the studio's order, for one case. */
type Recording = {
  latest: () => ScreenCapture;
  tap: (target: Node, description: string) => Promise<void>;
  expectVisible: (target: Node, description: string) => Promise<void>;
  back: () => Promise<void>;
  scrollDown: () => Promise<void>;
  /** Adds the first expectation candidate of the current screen, as the picker would. */
  pickFirstCandidate: () => void;
};

type CaseScript = {
  name: string;
  blocks: string[];
  record: (recording: Recording) => Promise<void>;
  /** Step kinds the recording must produce, comma separated. */
  expectedKinds: string;
  expectedEndExpectations: number;
};

async function recordCase(store: ProjectStore, scratchDir: string, script: CaseScript): Promise<Recorded> {
  const session = new DeviceSession({ sessionName, cwd: projectDir });
  const since = deviceTime();
  let opened = false;
  try {
    const devices = await session.listDevices();
    if (!devices.some((device) => device.id === deviceId)) {
      fail(`${deviceId} is not a booted Android device. Booted: ${devices.map((d) => d.id).join(', ') || 'none'}`);
    }

    const started = Date.now();
    await session.open({ deviceId, appId, relaunch: true });
    opened = true;
    if (!(await goHome(session))) fail('Could not reach the Settings home screen');
    let latest: ScreenCapture = await session.capture(join(scratchDir, 'open.png'));
    log(`opened ${appId} on ${deviceId}: ${latest.nodes.length} nodes, ${latest.viewport.width}x${latest.viewport.height}, ${Date.now() - started} ms`);

    // Start a case as the studio does: restart the app, replay the ticked
    // blocks inside this session, and record from where the last one ends.
    const caseId = await store.allocateCaseId(script.name);
    const recorder = new Recorder();
    await session.relaunchApp();
    if (!(await goHome(session))) fail('Could not reach the Settings home screen after relaunch');
    for (const file of script.blocks) {
      const replayStarted = Date.now();
      const { replayed } = await session.replayFlow(store.path(file), {});
      log(`${file}: ${replayed} commands replayed through agent-device in ${Date.now() - replayStarted} ms`);
    }
    latest = await session.capture(join(scratchDir, 'start.png'));
    if (!session.isOpen) fail('The device session closed while the blocks ran');
    recorder.start({ id: caseId, name: script.name, appId, deviceId, preconditionBlocks: script.blocks.map((file) => ({ file })), envKeys: [] });
    log(`case ${caseId} started${script.blocks.length > 0 ? ` after ${script.blocks.join(', ')}; the session stayed open` : ''}`);

    const checkForeground = () => {
      const launches = foreignLaunches(since);
      if (launches.length > 0) throw new InterferenceError(`another process launched: ${launches.join('; ')}`);
    };

    const recording: Recording = {
      latest: () => latest,

      // Same order as the studio's tap handler: resolve the node, press its
      // centre, record the step, capture into the step's evidence path.
      tap: async (target, description) => {
        const point: Point = rectCenter(target.rect!);
        const node = resolveNodeAt(latest.nodes, point);
        await session.tapAt(node?.rect ? rectCenter(node.rect) : point);
        const evidence = store.evidencePath(caseId, recorder.evidenceNumberForNext('tap'));
        const step = recorder.recordTap(node, point, latest.viewport, evidence.relative, latest.nodes);
        latest = await session.capture(evidence.absolute);
        checkForeground();
        if (step.kind !== 'tap' || step.selector.kind === 'point') {
          fail(`Tap on ${description} was recorded as a point, expected an id or text selector`);
        }
        log(`step ${step.index}: tap ${description} -> ${describeSelector(step.selector)}`);
      },

      // Same as the studio's expect handler: no device action, the step's
      // screenshot is a copy of the screen being looked at.
      expectVisible: async (target, description) => {
        const point: Point = rectCenter(target.rect!);
        const node = resolveNodeAt(latest.nodes, point);
        if (!node || chooseSelector(node, latest.nodes, point, latest.viewport).kind === 'point') {
          fail(`Nothing with a name or id at ${description}`);
        }
        const evidence = store.evidencePath(caseId, recorder.evidenceNumberForNext('expect'));
        await mkdir(dirname(evidence.absolute), { recursive: true });
        await copyFile(latest.screenshotPath, evidence.absolute);
        const step = recorder.recordExpect(node, point, latest.viewport, evidence.relative, latest.nodes);
        if (step.kind !== 'expect') fail('Expected an expect step');
        log(`step ${step.index}: expect ${description} -> ${describeSelector(step.selector)}`);
      },

      back: async () => {
        await session.back();
        const evidence = store.evidencePath(caseId, recorder.evidenceNumberForNext('back'));
        const step = recorder.recordBack(evidence.relative);
        latest = await session.capture(evidence.absolute);
        checkForeground();
        log(`step ${step.index}: back`);
      },

      scrollDown: async () => {
        await session.scroll('down');
        const evidence = store.evidencePath(caseId, recorder.evidenceNumberForNext('scroll'));
        const step = recorder.recordScroll('down', evidence.relative);
        latest = await session.capture(evidence.absolute);
        checkForeground();
        log(`step ${step.index}: scroll down`);
      },

      pickFirstCandidate: () => {
        const candidates = expectationCandidates(latest.nodes, latest.viewport);
        const pick = candidates[0] ?? fail('No expectation candidate on the final screen');
        recorder.addExpectation({ selector: pick.selector, node: pick.node });
        log(`end expectation: "${pick.label}" -> ${describeSelector(pick.selector)} (first of ${candidates.length} candidates)`);
      },
    };

    await script.record(recording);

    const testCase = recorder.toCase();
    const saved = await store.saveCase(testCase, recorder.toFlow());
    const screenshots = testCase.steps.filter((step) => step.screenshot && existsSync(store.path(step.screenshot)));
    log(`saved ${store.relative(saved.casePath)} and ${store.relative(saved.flowPath)}`);
    log(`${screenshots.length} screenshots in evidence/${caseId}/`);
    const kinds = testCase.steps.map((step) => step.kind).join(', ');
    if (kinds !== script.expectedKinds || screenshots.length !== testCase.steps.length || testCase.expectations.length !== script.expectedEndExpectations) {
      fail(
        `Expected ${script.expectedKinds} with a screenshot each and ${script.expectedEndExpectations} end expectation(s); ` +
          `got ${kinds} with ${screenshots.length} screenshots and ${testCase.expectations.length}`,
      );
    }
    console.log(`\n----- ${store.relative(saved.flowPath)} -----\n${saved.yaml}-----\n`);
    return { caseId, flowPath: saved.flowPath, steps: testCase.steps };
  } catch (error) {
    // A failure caused by another app taking the screen is worth a retry.
    const launches = error instanceof InterferenceError ? [] : foreignLaunches(since);
    if (launches.length > 0) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new InterferenceError(`${reason}; another process launched: ${launches.join('; ')}`);
    }
    throw error;
  } finally {
    // Maestro drives the device through its own UiAutomator driver; release ours first.
    if (opened) await session.close().catch((error) => log(`close failed: ${String(error)}`));
  }
}

/**
 * Scrolls down and taps a safe entry that was not on screen before the
 * scroll ("System" when it is one of them), so the replay has to scroll to
 * reach it. Falls back to the first safe entry, and says so, when the scroll
 * brought nothing new into view.
 */
async function scrollAndTapNewEntry(recording: Recording): Promise<void> {
  const titles = (snapshot: DeviceSnapshot) =>
    snapshot.nodes.filter((node) => node.identifier === 'android:id/title' && node.label).map((node) => node.label!);
  const before = new Set(titles(recording.latest()));
  await recording.scrollDown();
  const entries = settingsEntries(recording.latest());
  const revealed = entries.filter((entry) => !before.has(entry.label!));
  const target = revealed.find((entry) => entry.label === 'System') ?? revealed[0];
  if (target) {
    log(`the scroll revealed ${revealed.map((entry) => `"${entry.label}"`).join(', ')}; tapping "${target.label}"`);
    await recording.tap(target, `"${target.label}"`);
    return;
  }
  const fallback = entries[0] ?? fail('No safe Settings entry after scrolling');
  log(`FALLBACK USED: the scroll revealed no new safe entry; tapping the first safe entry "${fallback.label}" instead`);
  await recording.tap(fallback, `"${fallback.label}"`);
}

const caseWithBlock: CaseScript = {
  name: 'Smoke settings navigation',
  blocks: [block],
  expectedKinds: 'back, scroll, tap, expect, back',
  expectedEndExpectations: 1,
  record: async (recording) => {
    if (!recording.latest().nodes.some((node) => node.label === 'Internet')) {
      fail(`After ${block} the screen is not "Network & internet"`);
    }
    await recording.back();
    if (!isHome(recording.latest())) fail('Back after the block did not reach the Settings home screen');
    await scrollAndTapNewEntry(recording);
    const latest = recording.latest();
    const title = pageTitleWithId(latest) ?? fail('No page title with a unique resource-id on the opened page');
    await recording.expectVisible(title, `page title "${title.label}" (${title.identifier})`);
    await recording.back();
    recording.pickFirstCandidate();
  },
};

const caseScrollFirst: CaseScript = {
  name: 'Smoke scroll first',
  blocks: [],
  expectedKinds: 'scroll, tap, back',
  expectedEndExpectations: 0,
  record: async (recording) => {
    if (!isHome(recording.latest())) fail('The case did not start on the Settings home screen');
    await scrollAndTapNewEntry(recording);
    await recording.back();
  },
};

type MaestroOutcome = { summary: RunSummary; launches: string[] };

/** Runs one flow with Maestro, the same way the studio's Replay does, and writes summary.json. */
async function runFlow(
  store: ProjectStore,
  maestro: string,
  options: { runId: string; caseId: string; flowPath: string; flow: MaestroFlow },
): Promise<MaestroOutcome> {
  const debugDir = store.runDir(options.runId);
  await rm(debugDir, { recursive: true, force: true });
  log(`maestro test ${store.relative(options.flowPath)}; debug output in ${store.relative(debugDir)}`);
  const since = deviceTime();
  const startedAt = new Date().toISOString();
  const result = await runMaestro({
    maestroBin: maestro,
    deviceId,
    flowPath: options.flowPath,
    debugDir,
    env: {},
    cwd: projectDir,
    androidHome: androidHome(),
    timeoutMs: maestroTimeoutMs,
  });
  const read = await readMaestroCommands(debugDir);
  const summary = summarizeRun({
    runId: options.runId,
    caseId: options.caseId,
    flowFile: store.relative(options.flowPath),
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    flow: options.flow,
    commands: read?.commands,
    ...(read ? { flowDir: `${store.relative(debugDir)}/${read.flowDirName}` } : {}),
    outputFile: store.relative(result.outputFile),
  });
  await store.saveRun(summary);
  log(`maestro exited with ${result.exitCode} after ${Math.round(result.durationMs / 1000)} s; Maestro's output (${summary.outputFile}):`);
  console.log((await readFile(result.outputFile, 'utf8')).trimEnd());
  return { summary, launches: foreignLaunches(since) };
}

/** Replays the recorded case; every step must pass. */
async function replayRecorded(store: ProjectStore, recorded: Recorded, maestro: string): Promise<MaestroOutcome> {
  const flow = parseMaestroFlow(await readFile(recorded.flowPath, 'utf8'));
  const runId = await store.allocateRunId(recorded.caseId);
  const outcome = await runFlow(store, maestro, { runId, caseId: recorded.caseId, flowPath: recorded.flowPath, flow });
  printRun(`replay ${runId}`, outcome.summary);
  return outcome;
}

function replayPassed(summary: RunSummary): boolean {
  return summary.exitCode === 0 && summary.passed && summary.steps.every((step) => step.status === 'passed');
}

/**
 * Runs a copy of the flow with an assertVisible on a missing text before the
 * final Back, and checks that the result names that step as failed (with
 * Maestro's message and screenshot) and the Back as not run.
 */
async function proveFailureParsing(store: ProjectStore, recorded: Recorded, maestro: string): Promise<MaestroOutcome & { problems: string[] }> {
  const flow = parseMaestroFlow(await readFile(recorded.flowPath, 'utf8'));
  const backIndex = flow.steps.map((step) => step.kind).lastIndexOf('back');
  if (backIndex < 0) fail('The recorded flow has no back step');
  const failing: MaestroFlow = {
    ...flow,
    name: 'Smoke failure check',
    steps: [
      ...flow.steps.slice(0, backIndex),
      { kind: 'assertVisible', selector: { kind: 'text', value: escapeMaestroRegex(missingText) } },
      ...flow.steps.slice(backIndex),
    ],
  };
  const tempFlow = store.path(`flows/smoke-fail-${recorded.caseId}.yaml`);
  await writeFile(tempFlow, toMaestroYaml(failing));
  try {
    const runId = `smoke-fail-${recorded.caseId}`;
    const outcome = await runFlow(store, maestro, { runId, caseId: recorded.caseId, flowPath: tempFlow, flow: failing });
    printRun(`failure check ${runId}`, outcome.summary);
    const { summary } = outcome;
    const inserted = summary.steps[backIndex];
    const finalBack = summary.steps[backIndex + 1];
    const problems: string[] = [];
    if (summary.exitCode !== 1) problems.push(`exit code ${summary.exitCode}, expected 1`);
    if (inserted?.status !== 'failed' || !inserted.error) problems.push(`step ${backIndex + 1} is ${inserted?.status ?? 'missing'} without an error, expected failed with one`);
    if (!summary.failureScreenshot || !existsSync(store.path(summary.failureScreenshot))) problems.push('no failure screenshot on disk');
    if (finalBack?.step?.kind !== 'back' || finalBack.status !== 'not-run') problems.push(`the final back is ${finalBack?.status ?? 'missing'}, expected not-run`);
    if (summary.steps.slice(0, backIndex).some((step) => step.status !== 'passed')) problems.push('a step before the inserted one did not pass');
    return { ...outcome, problems };
  } finally {
    await rm(tempFlow, { force: true });
  }
}

/** Leaves the emulator on the Settings home screen for whoever uses it next. */
async function leaveOnSettingsHome(): Promise<void> {
  const session = new DeviceSession({ sessionName, cwd: projectDir });
  try {
    await session.open({ deviceId, appId });
    log(await goHome(session) ? 'emulator left on the Settings home screen' : 'could not confirm the Settings home screen');
  } catch (error) {
    log(`could not return to the Settings home screen: ${describeDeviceError(error).message}`);
  } finally {
    await session.close().catch(() => undefined);
  }
}

/** Records a case and replays it; retries the pair when another app interferes. */
async function recordAndReplay(store: ProjectStore, scratchDir: string, maestro: string, script: CaseScript): Promise<Recorded> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    log(`${script.name}: attempt ${attempt} of ${attempts}`);
    let recorded: Recorded;
    try {
      recorded = await recordCase(store, scratchDir, script);
    } catch (error) {
      if (error instanceof InterferenceError && attempt < attempts) {
        log(`recording disturbed (${error.message}); retrying`);
        continue;
      }
      throw error;
    }
    const result = await replayRecorded(store, recorded, maestro);
    if (replayPassed(result.summary)) {
      log(`PASS: ${script.name}: Maestro replayed the recorded flow, ${result.summary.steps.length} of ${result.summary.steps.length} steps passed (${result.summary.runId})`);
      return recorded;
    }
    if (result.launches.length > 0) {
      log(`replay disturbed: another process launched ${result.launches.join('; ')}`);
      if (attempt < attempts) {
        await leaveOnSettingsHome();
        continue;
      }
    }
    fail(`${script.name}: Maestro replay of the recorded flow did not pass every step`);
  }
  return fail(`${script.name}: no attempt produced a replayable case`);
}

async function main(): Promise<void> {
  const maestro = findMaestro();
  log(`project ${projectDir}`);
  log(`device ${deviceId}, app ${appId}, maestro ${maestro}`);
  const store = await ProjectStore.open(projectDir);
  await store.updateSettings({ appId, lastDeviceId: deviceId });
  if (!existsSync(store.path(block))) fail(`${block} is missing from the project`);
  const scratchDir = await mkdtemp(join(tmpdir(), 'ariadne-smoke-'));

  try {
    const withBlock = await recordAndReplay(store, scratchDir, maestro, caseWithBlock);

    let failureProved = false;
    for (let attempt = 1; attempt <= attempts && !failureProved; attempt++) {
      const result = await proveFailureParsing(store, withBlock, maestro);
      if (result.problems.length === 0) {
        const failed = result.summary.steps.find((step) => step.status === 'failed')!;
        const notRun = result.summary.steps.filter((step) => step.status === 'not-run').length;
        log(`PASS: the failing run was parsed: step ${failed.flowIndex + 1} failed ("${failed.error}"), ${notRun} step(s) not run, screenshot ${result.summary.failureScreenshot}`);
        failureProved = true;
      } else if (result.launches.length > 0 && attempt < attempts) {
        log(`failure check disturbed: another process launched ${result.launches.join('; ')}; retrying`);
        await leaveOnSettingsHome();
      } else {
        fail(`The failing run was not parsed as expected: ${result.problems.join('; ')}`);
      }
    }

    await recordAndReplay(store, scratchDir, maestro, caseScrollFirst);
    log('PASS: all checks');
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  const message = isAgentDeviceError(error)
    ? `agent-device ${describeDeviceError(error).code}: ${describeDeviceError(error).message}`
    : error instanceof Error
      ? error.message
      : String(error);
  console.error(`[smoke] FAIL: ${message}`);
  exitCode = 1;
}
await leaveOnSettingsHome();
// The agent-device client keeps its daemon connection open; exit explicitly.
process.exit(exitCode);
