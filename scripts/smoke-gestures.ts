// End-to-end proof for Milestone 6 (gestures and phone buttons), with no
// browser: drives the studio server in-process (buildServer plus inject, the
// routes the UI calls) against a real Android device and the Settings app,
// then runs the recorded case with Maestro. Exits non-zero on the first problem.
//
//   Not recording: Recent apps and Zoom in work and record nothing.
//   Recording "Gestures on Settings": Recent apps and Zoom out are refused
//   (Maestro cannot replay them), then swipe up, swipe down, long press
//   "Network & internet", double tap the page title, Back, Volume up, Rotate
//   to landscape and back, Home, Relaunch app, tap "Search settings", type,
//   Enter, Back out of search. Saved and run with Maestro: it must pass with a screenshot after
//   every step but launchApp.
//   Edited: steps added after the rotation back to portrait, so the partial
//   replay runs swipes, the long press and double tap through agent-device
//   and Volume up and the rotations through the device session. A check is
//   added there and the case is run again; it must pass.
//
// The project is a fresh temporary directory unless SMOKE_PROJECT_DIR is set.
// The agent-device session is "smoke-gestures" unless ARIADNE_SESSION_NAME is
// set, so a studio on another device with its usual session is not disturbed.
//
// Environment overrides:
//   SMOKE_DEVICE          adb serial of the device (default emulator-5556)
//   SMOKE_PROJECT_DIR     project directory (default: a new temp directory)
//   ARIADNE_SESSION_NAME  agent-device session name (default smoke-gestures)
//   MAESTRO_BIN, ANDROID_HOME as for the studio

import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DeviceSession, LOOKS_DIFFERENT_BELOW, type CaseStep } from '@ariadne/core';
import { buildServer } from '../apps/studio/src/server/index.ts';
import type { ActionResponse, CaseDetailResponse, CaseStartResponse, RunView, ScreenState, SnapshotNodeLite } from '../apps/studio/src/shared/api-types.ts';

const deviceId = process.env.SMOKE_DEVICE ?? 'emulator-5556';
const sessionName = process.env.ARIADNE_SESSION_NAME ?? 'smoke-gestures';
const APP = 'com.android.settings';

function log(message: string): void {
  console.log(`[smoke-gestures] ${message}`);
}

class SmokeFailure extends Error {}

/** Throws, so main's finally still closes the device session before the exit. */
function fail(message: string): never {
  throw new SmokeFailure(message);
}

function check(condition: unknown, message: string): void {
  if (!condition) fail(message);
}

type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;

async function call<T>(method: 'GET' | 'POST', url: string, payload?: object): Promise<{ status: number; body: T }> {
  const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
  const type = String(response.headers['content-type'] ?? '');
  return { status: response.statusCode, body: (type.includes('json') ? response.json() : response.body) as T };
}

async function ok<T>(method: 'GET' | 'POST', url: string, payload?: object): Promise<T> {
  const response = await call<T>(method, url, payload);
  if (response.status >= 300) fail(`${method} ${url} -> ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}

/** One recorded action: checks the step kind it recorded and returns the screen after it. */
async function step(url: string, payload: object | undefined, kind: CaseStep['kind']): Promise<ScreenState> {
  const response = await ok<ActionResponse>('POST', url, payload);
  check(response.step?.kind === kind, `${url}: recorded ${response.step?.kind ?? 'nothing'}, expected ${kind}`);
  log(`   step ${response.step!.index} ${kind}${'selector' in response.step! ? ` ${JSON.stringify(response.step.selector)}` : ''}`);
  return response.screen;
}

function labels(screen: ScreenState): string {
  return screen.nodes.map((node) => node.label).filter(Boolean).join(' | ');
}

function findLabel(screen: ScreenState, pattern: RegExp, where: (node: SnapshotNodeLite) => boolean = () => true): SnapshotNodeLite | undefined {
  return screen.nodes.find((node) => node.rect && node.label && pattern.test(node.label) && node.rect.height > 0 && where(node));
}

function centre(node: SnapshotNodeLite): { x: number; y: number } {
  const rect = node.rect!;
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

function at(screen: ScreenState, xFraction: number, yFraction: number): { x: number; y: number } {
  return { x: Math.round(screen.width * xFraction), y: Math.round(screen.height * yFraction) };
}

function printRun(label: string, run: RunView): void {
  log(`${label}: ${run.passed ? 'PASSED' : 'FAILED'} (exit ${run.exitCode}) ${run.runId}`);
  if (run.deviceProblem) log(`   ${run.deviceProblem}`);
  if (run.error) log(`   ${run.error}`);
  for (const result of run.steps) {
    const shot = result.replayScreenshot ? ' shot' : '';
    const sim = result.similarity !== undefined ? ` ${result.similarity}%` : '';
    log(`   ${String(result.flowIndex + 1).padStart(2)} ${result.status.padEnd(7)} ${result.step?.kind ?? '?'}${shot}${sim}${result.error ? `  ${result.error}` : ''}`);
  }
}

/** Runs the case with Maestro; it must pass with a replay screenshot after every step but launchApp. */
async function runAndCheck(caseId: string, label: string): Promise<RunView> {
  const run = await ok<RunView>('POST', `/api/cases/${caseId}/replay`);
  printRun(label, run);
  check(run.passed, `${label} failed`);
  for (const result of run.steps) {
    if (result.step?.kind === 'launchApp') continue;
    check(result.replayScreenshot, `${label}: row ${result.flowIndex + 1} (${result.step?.kind}) has no screenshot`);
    check(existsSync(join(projectDir, result.replayScreenshot!)), `${label}: ${result.replayScreenshot} is missing on disk`);
  }
  const different = run.steps.filter((result) => result.similarity !== undefined && result.similarity < LOOKS_DIFFERENT_BELOW);
  if (different.length > 0) log(`${label}: looks different at ${different.map((result) => `row ${result.flowIndex + 1} ${result.similarity}%`).join(', ')}`);
  return run;
}

let projectDir = '';

async function main(): Promise<void> {
  projectDir = resolve(process.env.SMOKE_PROJECT_DIR ?? (await mkdtemp(join(tmpdir(), 'ariadne-smoke-gestures-'))));
  await writeFile(join(projectDir, 'project.json'), JSON.stringify({ appId: APP, platform: 'android', lastDeviceId: deviceId }, null, 2));
  log(`project ${projectDir}, device ${deviceId}, session ${sessionName}`);
  const adb = join(process.env.ANDROID_HOME ?? join(process.env.HOME ?? '', 'Android/Sdk'), 'platform-tools/adb');
  const devices = execFileSync(adb, ['devices'], { encoding: 'utf8' });
  check(devices.includes(`${deviceId}\tdevice`), `${deviceId} is not in adb devices`);
  // Settings search runs in its own package, which relaunching Settings does not
  // close; a run that stopped in search would leave it on top.
  for (const pkg of [APP, 'com.google.android.settings.intelligence']) execFileSync(adb, ['-s', deviceId, 'shell', 'am', 'force-stop', pkg]);
  execFileSync(adb, ['-s', deviceId, 'shell', 'settings', 'put', 'system', 'user_rotation', '0']);
  execFileSync(adb, ['-s', deviceId, 'shell', 'input', 'keyevent', 'KEYCODE_HOME']);

  const session = new DeviceSession({ sessionName, cwd: projectDir });
  app = await buildServer({ projectDir, session });
  try {
    await ok<ScreenState>('POST', '/api/session/open', { deviceId, appId: APP });

    log('not recording: Zoom in and Recent apps work and record nothing');
    const zoomed = await ok<ActionResponse>('POST', '/api/action/pinch', { zoom: 'in' });
    check(!zoomed.step, 'Zoom in recorded a step');
    const recents = await ok<ActionResponse>('POST', '/api/action/key', { key: 'appSwitch' });
    check(!recents.step, 'Recent apps recorded a step');

    log('recording "Gestures on Settings"');
    const started = await ok<CaseStartResponse>('POST', '/api/case/start', { name: 'Gestures on Settings' });
    let screen = started.screen;
    for (const [url, payload] of [
      ['/api/action/key', { key: 'appSwitch' }],
      ['/api/action/pinch', { zoom: 'out' }],
    ] as const) {
      const refused = await call<{ error: { code: string } }>('POST', url, payload);
      check(refused.status === 409 && refused.body.error.code === 'LIVE_ONLY', `${url} while recording: expected 409 LIVE_ONLY, got ${refused.status}`);
    }

    screen = await step('/api/action/swipe', { from: at(screen, 0.5, 0.75), to: at(screen, 0.5, 0.35), durationMs: 500 }, 'swipe');
    screen = await step('/api/action/swipe', { from: at(screen, 0.5, 0.3), to: at(screen, 0.5, 0.85), durationMs: 500 }, 'swipe');

    const network = findLabel(screen, /^Network & internet$/);
    if (!network) fail(`no "Network & internet" on the Settings home screen; labels: ${labels(screen)}`);
    screen = await step('/api/action/long-press', centre(network), 'longPress');
    // On Settings a long press on a row opens it once the finger lifts: nothing handles the long click.
    const title = findLabel(screen, /^Network & internet$/, (node) => (node.rect?.y ?? 0) < screen.height * 0.3);
    if (!title) fail(`long press did not open Network & internet; labels: ${labels(screen)}`);
    screen = await step('/api/action/double-tap', centre(title), 'doubleTap');
    screen = await step('/api/action/back', undefined, 'back');
    check(findLabel(screen, /^Network & internet$/, (node) => (node.rect?.y ?? 0) > screen.height * 0.2), `Back did not return to the Settings home; labels: ${labels(screen)}`);

    screen = await step('/api/action/key', { key: 'volumeUp' }, 'pressKey');
    screen = await step('/api/action/rotate', { orientation: 'landscape' }, 'orientation');
    check(screen.width > screen.height, `after Rotate to landscape the screen is ${screen.width}x${screen.height}`);
    screen = await step('/api/action/rotate', { orientation: 'portrait' }, 'orientation');
    check(screen.width < screen.height, `after Rotate to portrait the screen is ${screen.width}x${screen.height}`);
    screen = await step('/api/action/key', { key: 'home' }, 'pressKey');
    screen = await step('/api/action/relaunch', undefined, 'relaunch');

    const search = findLabel(screen, /^Search (S|s)ettings$/);
    if (!search) fail(`no "Search settings" after relaunching; labels: ${labels(screen)}`);
    screen = await step('/api/action/tap', centre(search), 'tap');
    screen = await step('/api/action/type', { text: 'wifi' }, 'type');
    screen = await step('/api/action/key', { key: 'enter' }, 'pressKey');
    // Leave search, so the next launch of Settings does not come back to it.
    screen = await step('/api/action/back', undefined, 'back');
    if (!findLabel(screen, /^Search (S|s)ettings$/)) screen = await step('/api/action/back', undefined, 'back');
    check(findLabel(screen, /^Search (S|s)ettings$/), `Back did not leave search; labels: ${labels(screen)}`);

    const finished = await ok<{ caseId: string; yaml: string }>('POST', '/api/case/finish', { picks: [] });
    const caseId = finished.caseId;
    log(`saved ${caseId}:\n${finished.yaml}`);
    for (const line of ['- longPressOn:', '- doubleTapOn:', '- swipe:\n    start: "50%, 75%"\n    end: "50%, 35%"\n    duration: 500', '- pressKey: Volume Up', '- setOrientation: LANDSCAPE_LEFT', '- setOrientation: PORTRAIT', '- pressKey: Home', '- pressKey: Enter']) {
      check(finished.yaml.includes(line), `the flow lacks ${JSON.stringify(line)}`);
    }

    await runAndCheck(caseId, 'run 1');

    log('add steps after step 8 (Rotate to portrait): replay the gestures, keys and rotations up to there');
    const edit = await ok<CaseStartResponse>('POST', `/api/cases/${caseId}/edit`, { mode: 'insert', after: 8 });
    screen = edit.screen;
    check(screen.width < screen.height, `after replaying up to step 8 the screen is ${screen.width}x${screen.height}`);
    const row = findLabel(screen, /^Network & internet$/);
    if (!row) fail(`replay up to step 8 did not end on the Settings home; labels: ${labels(screen)}`);
    await step('/api/case/expect', centre(row), 'expect');
    await ok('POST', '/api/case/finish', { picks: [] });
    const detail = await ok<CaseDetailResponse>('GET', `/api/cases/${caseId}`);
    const kinds = detail.case.steps.map((item) => item.kind).join(',');
    check(
      kinds.startsWith('swipe,swipe,longPress,doubleTap,back,pressKey,orientation,orientation,expect,pressKey,relaunch,tap,type,pressKey,back'),
      `after the edit the steps are ${kinds}`,
    );

    await runAndCheck(caseId, 'run 2');

    await ok('POST', '/api/session/close');
    log(`PASSED. Project left in ${projectDir}`);
  } finally {
    // Closes the agent-device session, so the device is free for the next tool.
    await app.close();
    execFileSync(adb, ['-s', deviceId, 'shell', 'settings', 'put', 'system', 'user_rotation', '0']);
  }
}

main().catch((error: unknown) => {
  console.error('[smoke-gestures] FAIL:', error instanceof SmokeFailure ? error.message : error);
  process.exit(1);
});
