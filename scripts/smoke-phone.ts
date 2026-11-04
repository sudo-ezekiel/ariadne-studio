// End-to-end proof of recording from touches on the phone, with no browser:
// drives the studio server in-process against an emulator and the Settings
// app. Touches are sent with `adb emu event send`, which reaches /dev/input the
// way a finger does (`adb shell input` would not: getevent never sees it), so
// this needs an emulator. Exits non-zero on the first problem.
//
//   Recording "Touches on Settings": tap "Network & internet", Back, swipe up,
//   swipe down, tap the search bar, text arriving in the field, Back out of
//   search, long press a row. Saved and run with Maestro: it must pass.
//   Recording a second case: Home pauses recording, touches on the home screen
//   record nothing, and the first step back in the app is flagged.
//
// Environment overrides:
//   SMOKE_DEVICE          adb serial of an emulator (default emulator-5556)
//   SMOKE_PROJECT_DIR     project directory (default: a new temp directory)
//   ARIADNE_SESSION_NAME  agent-device session name (default smoke-phone)

import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DeviceSession, phoneInputTools, type CaseStep, type PhoneInput } from '@ariadne/core';
import { buildServer } from '../apps/studio/src/server/index.ts';
import type { CaseDetailResponse, CaseStartResponse, CurrentCaseView, PhoneStatus, RunView, ScreenState, SnapshotNodeLite } from '../apps/studio/src/shared/api-types.ts';

const deviceId = process.env.SMOKE_DEVICE ?? 'emulator-5556';
const sessionName = process.env.ARIADNE_SESSION_NAME ?? 'smoke-phone';
const APP = 'com.android.settings';
const STEP_WAIT_MS = 8000;

function log(message: string): void {
  console.log(`[smoke-phone] ${message}`);
}

class SmokeFailure extends Error {}

function fail(message: string): never {
  throw new SmokeFailure(message);
}

function check(condition: unknown, message: string): void {
  if (!condition) fail(message);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;
let input: PhoneInput;

async function ok<T>(method: 'GET' | 'POST', url: string, payload?: object): Promise<T> {
  const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
  if (response.statusCode >= 300) fail(`${method} ${url} -> ${response.statusCode} ${response.body}`);
  return response.json() as T;
}

function emu(...events: string[]): void {
  execFileSync('adb', ['-s', deviceId, 'emu', 'event', 'send', ...events], { encoding: 'utf8' });
}

/** Sends a finger from `from` to `to` in viewport pixels, through the emulator's touchscreen. */
async function touch(screen: ScreenState, from: Point, to: Point = from, holdMs = 70): Promise<void> {
  const raw = (point: Point) => [
    `EV_ABS:ABS_MT_POSITION_X:${Math.round((point.x / screen.width) * input.screen.maxX)}`,
    `EV_ABS:ABS_MT_POSITION_Y:${Math.round((point.y / screen.height) * input.screen.maxY)}`,
  ];
  emu('EV_ABS:ABS_MT_TRACKING_ID:1', ...raw(from), 'EV_ABS:ABS_MT_PRESSURE:80', 'EV_KEY:BTN_TOUCH:1', 'EV_SYN:0:0');
  const moves = from.x === to.x && from.y === to.y ? 0 : 6;
  for (let move = 1; move <= moves; move += 1) {
    const share = move / moves;
    emu(...raw({ x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share }), 'EV_SYN:0:0');
  }
  await sleep(holdMs);
  emu('EV_ABS:ABS_MT_TRACKING_ID:-1', 'EV_KEY:BTN_TOUCH:0', 'EV_SYN:0:0');
}

type Point = { x: number; y: number };

function centre(node: SnapshotNodeLite): Point {
  const rect = node.rect!;
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

async function screenNow(): Promise<ScreenState> {
  return ok<ScreenState>('GET', '/api/screen');
}

function find(screen: ScreenState, pattern: RegExp): SnapshotNodeLite {
  const node = screen.nodes.find((candidate) => !candidate.systemBar && candidate.rect && candidate.label && pattern.test(candidate.label));
  return node ?? fail(`Nothing matching ${pattern} on screen: ${screen.nodes.filter((item) => !item.systemBar).map((item) => item.label).filter(Boolean).join(' | ')}`);
}

async function steps(): Promise<CaseStep[]> {
  return (await ok<CurrentCaseView>('GET', '/api/case/current')).steps;
}

/** Waits for the case to reach `count` steps, then for the screen to catch up with them. */
async function waitForSteps(count: number): Promise<CaseStep[]> {
  const until = Date.now() + STEP_WAIT_MS;
  let seen = await steps();
  while (seen.length < count && Date.now() < until) {
    await sleep(100);
    seen = await steps();
  }
  check(seen.length >= count, `Expected ${count} steps, have ${seen.length}: ${seen.map((step) => step.kind).join(', ')}`);
  await sleep(1600);
  return seen;
}

function describe(step: CaseStep): string {
  return `${step.kind}${'selector' in step ? ` ${JSON.stringify(step.selector)}` : ''}${step.review ? ` [review: ${step.review}]` : ''}`;
}

async function pressBack(screen: ScreenState): Promise<void> {
  if (input.gestureNavigation) {
    await touch(screen, { x: screen.width - 4, y: Math.round(screen.height / 2) }, { x: Math.round(screen.width * 0.6), y: Math.round(screen.height / 2) });
    return;
  }
  const back = screen.nodes.find((node) => node.identifier?.endsWith('/back'));
  await touch(screen, centre(back ?? fail('No Back button on screen')));
}

async function inSearch(): Promise<boolean> {
  const screen = await ok<ScreenState>('POST', '/api/screen/refresh');
  return screen.nodes.some((node) => node.identifier?.includes('settings.intelligence'));
}

async function recordAndRun(): Promise<void> {
  const started = await ok<CaseStartResponse>('POST', '/api/case/start', { name: 'Touches on Settings' });
  await ok<PhoneStatus>('POST', '/api/phone/start');
  await sleep(1000);

  let screen = await screenNow();
  await touch(screen, centre(find(screen, /^Network & internet$/)));
  let seen = await waitForSteps(1);
  check(seen[0]?.kind === 'tap', `First step is ${describe(seen[0]!)}`);
  log(`   1 ${describe(seen[0]!)}`);

  screen = await screenNow();
  await pressBack(screen);
  seen = await waitForSteps(2);
  check(seen[1]?.kind === 'back', `Second step is ${describe(seen[1]!)}`);
  log(`   2 ${describe(seen[1]!)}`);

  screen = await screenNow();
  const middle = Math.round(screen.width / 2);
  await touch(screen, { x: middle, y: Math.round(screen.height * 0.7) }, { x: middle, y: Math.round(screen.height * 0.4) }, 250);
  seen = await waitForSteps(3);
  await touch(screen, { x: middle, y: Math.round(screen.height * 0.4) }, { x: middle, y: Math.round(screen.height * 0.8) }, 250);
  seen = await waitForSteps(4);
  check(seen[2]?.kind === 'swipe' && seen[3]?.kind === 'swipe', `Expected two swipes, got ${seen.slice(2).map(describe).join(', ')}`);
  log(`   3-4 ${seen.slice(2).map(describe).join(', ')}`);

  screen = await screenNow();
  await touch(screen, centre(find(screen, /^search\b/i)));
  seen = await waitForSteps(5);
  log(`   5 ${describe(seen[4]!)}`);

  // Text goes in without touches here; on a real keyboard the touches are dropped and the field read the same way.
  execFileSync('adb', ['-s', deviceId, 'shell', 'input', 'text', 'wifi']);
  await sleep(2500);
  screen = await ok<ScreenState>('POST', '/api/screen/refresh');
  await pressBack(screen);
  seen = await waitForSteps(7);
  check(seen[5]?.kind === 'type' && seen[5].text === 'wifi', `Typing came out as ${describe(seen[5]!)}`);
  check(seen[6]?.kind === 'back', `After typing came ${describe(seen[6]!)}`);
  log(`   6-7 ${seen.slice(5).map(describe).join(', ')}`);

  // One Back may only close the keyboard, depending on the system image.
  if (await inSearch()) {
    await pressBack(await ok<ScreenState>('POST', '/api/screen/refresh'));
    seen = await waitForSteps(8);
  }

  screen = await ok<ScreenState>('POST', '/api/screen/refresh');
  await touch(screen, centre(find(screen, /^Network & internet$/)), undefined, 1200);
  seen = await waitForSteps(seen.length + 1);
  const held = seen.at(-1)!;
  check(held.kind === 'longPress', `A long hold came out as ${describe(held)}`);
  log(`   ${seen.length} ${describe(held)}`);

  check(seen.every((step) => step.at), 'A step has no time');
  await ok<PhoneStatus>('POST', '/api/phone/stop');
  await ok('GET', '/api/case/candidates');
  await ok('POST', '/api/case/finish', { picks: [] });

  const run = await ok<RunView>('POST', `/api/cases/${started.caseId}/replay`);
  log(`Maestro: ${run.passed ? 'PASSED' : 'FAILED'} (exit ${run.exitCode}) ${run.runId}`);
  for (const result of run.steps) log(`   ${String(result.flowIndex + 1).padStart(2)} ${result.status} ${result.step?.kind ?? ''}`);
  check(run.passed, `The recorded case failed: ${run.error ?? run.deviceProblem ?? ''}`);
  await ok<CaseDetailResponse>('GET', `/api/cases/${started.caseId}`);
}

async function leaveAndComeBack(): Promise<void> {
  await ok<CaseStartResponse>('POST', '/api/case/start', { name: 'Leaving the app' });
  await ok<PhoneStatus>('POST', '/api/phone/start');
  await sleep(1000);

  execFileSync('adb', ['-s', deviceId, 'shell', 'input', 'keyevent', 'HOME']);
  await sleep(1500);
  const status = await ok<PhoneStatus>('GET', '/api/phone');
  check(status.paused, 'Recording did not pause on the home screen');
  log('   paused on the home screen');

  const screen = await screenNow();
  const middle = { x: Math.round(screen.width / 2), y: Math.round(screen.height / 2) };
  await touch(screen, middle);
  await sleep(800);
  check((await steps()).length === 0, 'A touch on the home screen was recorded');

  execFileSync('adb', ['-s', deviceId, 'shell', 'monkey', '-p', APP, '-c', 'android.intent.category.LAUNCHER', '1'], { stdio: 'ignore' });
  await sleep(2000);
  check(!(await ok<PhoneStatus>('GET', '/api/phone')).paused, 'Recording did not resume back in the app');

  await touch(await ok<ScreenState>('POST', '/api/screen/refresh'), middle);
  const seen = await waitForSteps(1);
  check(seen[0]?.review === 'left-app', `The first step back is not flagged: ${describe(seen[0]!)}`);
  log(`   resumed, first step ${describe(seen[0]!)}`);

  await ok<PhoneStatus>('POST', '/api/phone/stop');
  await ok('POST', '/api/case/discard');
}

async function main(): Promise<void> {
  check(deviceId.startsWith('emulator-'), 'This smoke test sends touches with adb emu, so SMOKE_DEVICE must be an emulator.');
  const projectDir = resolve(process.env.SMOKE_PROJECT_DIR ?? (await mkdtemp(join(tmpdir(), 'ariadne-smoke-phone-'))));
  log(`project ${projectDir}, device ${deviceId}`);
  const read = await phoneInputTools.read(deviceId);
  input = read ?? fail('No touchscreen found');
  log(`touchscreen ${input.screen.path}, range ${input.screen.maxX}x${input.screen.maxY}, ${input.gestureNavigation ? 'gesture' : 'button'} navigation`);

  if (!existsSync(join(projectDir, 'project.json'))) await writeFile(join(projectDir, 'project.json'), JSON.stringify({ appId: APP, platform: 'android' }), 'utf8');
  // Settings' search is an app of its own, and a run that stopped there would still be on top.
  execFileSync('adb', ['-s', deviceId, 'shell', 'am', 'force-stop', 'com.google.android.settings.intelligence']);
  app = await buildServer({ projectDir, session: new DeviceSession({ sessionName, cwd: projectDir }) });
  try {
    await ok('POST', '/api/session/open', { deviceId, appId: APP });
    log('Recording from touches, then running it');
    await recordAndRun();
    log('Leaving the app and coming back');
    await leaveAndComeBack();
    log('PASSED');
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[smoke-phone] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
