// End-to-end proof for Milestones 3 and 4, with no browser: drives the studio
// server in-process (buildServer plus inject, the same routes the UI calls)
// against a real Android device and the Android Settings app, then checks
// the results on disk. Exits non-zero on the first problem.
//
//   A  "Open internet settings": block open-settings, tap "Internet", Back,
//      one end check. Replayed.
//   B  starts from the end of A (Waldo-style dependency), taps an entry on
//      the Network & internet screen, Back. Replayed: the run must pass, have
//      a replay screenshot after every step but launchApp, and a similarity
//      score for each recorded step.
//   A  edited: steps inserted after step 1 (an Expect on the Internet
//      screen), then re-recorded from step 3 with the old end check
//      pre-ticked.
//   C  fresh start: tap "Search settings", type, Hide keyboard, Back, Relaunch
//      app, one end check. Replayed.
//   B  split after step 1; the first part becomes its own case.
//   Run all with retry; every case must pass or be flaky, with a report.
//   Exports: Excel, HTML and Markdown for the project and one case; a run
//   report; duplicate, rename, mute, step title, delete step and delete case.
//
// The project is a fresh temporary directory unless SMOKE_PROJECT_DIR is set.
// The agent-device session is named "smoke-studio", so a studio running on
// another device with its usual "studio" session is not disturbed.
//
// Environment overrides:
//   SMOKE_DEVICE       adb serial of the device (default emulator-5556)
//   SMOKE_PROJECT_DIR  project directory (default: a new temp directory)
//   MAESTRO_BIN, ANDROID_HOME as for the studio

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeviceSession, LOOKS_DIFFERENT_BELOW } from '@ariadne/core';
import { buildServer } from '../apps/studio/src/server/index.ts';
import type {
  ActionResponse,
  CandidatesResponse,
  CaseDetailResponse,
  CaseStartResponse,
  ProjectInfo,
  RunView,
  ScreenState,
  SnapshotNodeLite,
  SuiteView,
} from '../apps/studio/src/shared/api-types.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const deviceId = process.env.SMOKE_DEVICE ?? 'emulator-5556';
const APP = 'com.android.settings';

function log(message: string): void {
  console.log(`[smoke-studio] ${message}`);
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

async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object): Promise<{ status: number; body: T; raw: Buffer; type: string }> {
  const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
  const type = String(response.headers['content-type'] ?? '');
  const body = (type.includes('json') ? response.json() : response.body) as T;
  return { status: response.statusCode, body, raw: response.rawPayload, type };
}

async function ok<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object): Promise<T> {
  const response = await call<T>(method, url, payload);
  if (response.status >= 300) fail(`${method} ${url} -> ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}

function findLabel(screen: ScreenState, pattern: RegExp): SnapshotNodeLite | undefined {
  return screen.nodes.find((node) => node.rect && node.label && pattern.test(node.label) && node.rect.height > 0);
}

function centre(node: SnapshotNodeLite): { x: number; y: number } {
  const rect = node.rect!;
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

async function tapLabel(screen: ScreenState, pattern: RegExp, what: string): Promise<ActionResponse> {
  const node = findLabel(screen, pattern);
  if (!node) fail(`${what}: nothing labelled ${pattern} on screen; labels: ${screen.nodes.map((n) => n.label).filter(Boolean).join(' | ')}`);
  return ok<ActionResponse>('POST', '/api/action/tap', centre(node));
}

/** Labels of entries on the Network & internet screen that open a page and come back with Back. */
function networkEntry(screen: ScreenState): SnapshotNodeLite | undefined {
  for (const pattern of [/^SIMs$/, /^Internet$/, /^Hotspot & tethering$/, /^Data Saver$/]) {
    const node = findLabel(screen, pattern);
    if (node && (node.rect?.y ?? 0) > screen.height * 0.15) return node;
  }
  return undefined;
}

async function finish(picks: 'first' | 'none' | 'preselected'): Promise<string> {
  const candidates = await ok<CandidatesResponse>('GET', '/api/case/candidates');
  const chosen = picks === 'first' ? candidates.candidates.slice(0, 1).map((c) => c.id) : picks === 'preselected' ? (candidates.preselected ?? []) : [];
  const finished = await ok<{ caseId: string; yaml: string }>('POST', '/api/case/finish', { picks: chosen });
  return finished.caseId;
}

function printRun(label: string, run: RunView): void {
  const retried = run.attempt === 2 ? ' after a retry: the first run lost the device' : '';
  log(`${label}: ${run.passed ? 'PASSED' : 'FAILED'} (exit ${run.exitCode}) ${run.runId}${retried}`);
  if (run.deviceProblem) log(`   ${run.deviceProblem}`);
  for (const step of run.steps) {
    const shot = step.replayScreenshot ? ' shot' : '';
    const sim = step.similarity !== undefined ? ` ${step.similarity}%` : '';
    log(`   ${String(step.flowIndex + 1).padStart(2)} ${step.status.padEnd(7)} ${step.step?.kind ?? '?'}${shot}${sim}${step.error ? `  ${step.error}` : ''}`);
  }
}

async function replay(caseId: string, label: string): Promise<RunView> {
  const run = await ok<RunView>('POST', `/api/cases/${caseId}/replay`);
  printRun(label, run);
  return run;
}

function checkScreenshots(run: RunView, detail: CaseDetailResponse, label: string): void {
  for (const step of run.steps) {
    const kind = step.step?.kind;
    if (step.status !== 'passed') continue;
    if (kind === 'launchApp') {
      check(!step.replayScreenshot, `${label}: no screenshot expected after launchApp`);
    } else {
      check(step.replayScreenshot, `${label}: row ${step.flowIndex + 1} (${kind}) has no replay screenshot`);
      check(existsSync(join(projectDir, step.replayScreenshot!)), `${label}: ${step.replayScreenshot} is missing on disk`);
    }
  }
  const recordedRows = run.steps.filter((step) => {
    const lead = detail.case.startFrom ? 1 : 1 + detail.case.preconditionBlocks.length;
    const recorded = detail.case.steps[step.flowIndex - lead];
    return recorded && recorded.kind !== 'relaunch' && step.replayScreenshot;
  });
  const scored = recordedRows.filter((step) => step.similarity !== undefined);
  check(scored.length === recordedRows.length, `${label}: ${recordedRows.length - scored.length} recorded step(s) have no similarity score`);
  const different = scored.filter((step) => step.similarity! < LOOKS_DIFFERENT_BELOW);
  if (different.length > 0) {
    log(`${label}: ${different.length} step(s) look different: ${different.map((s) => `row ${s.flowIndex + 1} ${s.similarity}%`).join(', ')}`);
  }
}

let projectDir = '';

async function main(): Promise<void> {
  projectDir = resolve(process.env.SMOKE_PROJECT_DIR ?? (await mkdtemp(join(tmpdir(), 'ariadne-smoke-studio-'))));
  await mkdir(join(projectDir, 'blocks'), { recursive: true });
  await copyFile(join(repoRoot, 'workspace/blocks/open-settings.yaml'), join(projectDir, 'blocks/open-settings.yaml'));
  await writeFile(join(projectDir, 'project.json'), JSON.stringify({ appId: APP, platform: 'android', lastDeviceId: deviceId }, null, 2));
  log(`project ${projectDir}, device ${deviceId}`);
  const adb = join(process.env.ANDROID_HOME ?? join(process.env.HOME ?? '', 'Android/Sdk'), 'platform-tools/adb');
  const devices = execFileSync(adb, ['devices'], { encoding: 'utf8' });
  check(devices.includes(`${deviceId}\tdevice`), `${deviceId} is not in adb devices`);
  // Settings search runs in its own package, which relaunching Settings does not
  // close; a run that stopped in the middle of case C would leave it on top.
  for (const pkg of [APP, 'com.google.android.settings.intelligence']) execFileSync(adb, ['-s', deviceId, 'shell', 'am', 'force-stop', pkg]);
  execFileSync(adb, ['-s', deviceId, 'shell', 'input', 'keyevent', 'KEYCODE_HOME']);

  const session = new DeviceSession({ sessionName: 'smoke-studio', cwd: projectDir });
  app = await buildServer({ projectDir, session });
  try {
    let screen = await ok<ScreenState>('POST', '/api/session/open', { deviceId, appId: APP });

    // Case A: block, tap Internet, Back, one end check.
    log('case A: block open-settings, tap Internet, Back');
    let started = await ok<CaseStartResponse>('POST', '/api/case/start', { name: 'Open internet settings', blocks: ['blocks/open-settings.yaml'] });
    screen = started.screen;
    screen = (await tapLabel(screen, /^Internet$/, 'case A')).screen;
    screen = (await ok<ActionResponse>('POST', '/api/action/back')).screen;
    const caseA = await finish('first');
    let detailA = await ok<CaseDetailResponse>('GET', `/api/cases/${caseA}`);
    check(detailA.case.steps.length === 2 && detailA.case.expectations.length === 1, `case A: expected 2 steps and 1 end check, got ${detailA.case.steps.length} and ${detailA.case.expectations.length}`);

    // Case B: starts from A.
    log('case B: start from the end of A, tap an entry, Back');
    started = await ok<CaseStartResponse>('POST', '/api/case/start', { name: 'Network entry after internet', startFrom: caseA });
    screen = started.screen;
    const entry = networkEntry(screen);
    if (!entry) fail(`case B: not on the Network & internet screen after replaying A; labels: ${screen.nodes.map((n) => n.label).filter(Boolean).join(' | ')}`);
    screen = (await ok<ActionResponse>('POST', '/api/action/tap', centre(entry))).screen;
    screen = (await ok<ActionResponse>('POST', '/api/action/back')).screen;
    const caseB = await finish('none');
    const detailB = await ok<CaseDetailResponse>('GET', `/api/cases/${caseB}`);
    check(detailB.case.startFrom === caseA && detailB.case.preconditionBlocks.length === 0, 'case B: startFrom not saved');
    check(detailB.yaml.includes(`file: ${caseA}.yaml`), `case B: flow does not runFlow ${caseA}.yaml:\n${detailB.yaml}`);
    check(!detailB.yaml.includes('launchApp'), 'case B: flow has its own launchApp');
    check(detailB.parent?.id === caseA, 'case B: detail has no parent');

    const runB = await replay(caseB, 'replay B');
    check(runB.passed, 'replay B failed');
    checkScreenshots(runB, detailB, 'replay B');
    check(runB.ranFlowFile && (await readFile(join(projectDir, runB.ranFlowFile), 'utf8')).includes('takeScreenshot'), 'replay B: the flow that ran has no screenshots');
    check(!(await readFile(join(projectDir, 'flows', `${caseB}.yaml`), 'utf8')).includes('takeScreenshot'), 'replay B: the case flow was changed');

    const report = await call<string>('GET', runB.reportUrl);
    check(report.status === 200 && report.type.includes('text/html') && String(report.body).includes('data:image/png;base64,'), 'run report: not HTML with inline screenshots');
    check(existsSync(join(projectDir, 'runs', runB.runId, 'report.html')), 'run report: report.html not written');
    log(`run report: ${Math.round(report.raw.length / 1024)} KB`);

    // A cannot be deleted while B starts from it.
    const refused = await call<{ error: { code: string } }>('DELETE', `/api/cases/${caseA}`);
    check(refused.status === 409 && refused.body.error.code === 'HAS_DEPENDENTS', 'deleting A was not refused');

    // Edit A: insert an Expect after step 1, then re-record from step 3.
    log('case A: add steps after step 1 (Expect on the Internet screen)');
    started = await ok<CaseStartResponse>('POST', `/api/cases/${caseA}/edit`, { mode: 'insert', after: 1 });
    screen = started.screen;
    const title = findLabel(screen, /^Internet$/);
    if (!title) fail(`edit A: not on the Internet screen after replaying step 1; labels: ${screen.nodes.map((n) => n.label).filter(Boolean).join(' | ')}`);
    await ok<ActionResponse>('POST', '/api/case/expect', centre(title));
    const current = await ok<{ editing?: { mode: string } }>('GET', '/api/case/current');
    check(current.editing?.mode === 'insert', 'edit A: not in insert mode');
    await ok('POST', '/api/case/finish', { picks: [] });
    detailA = await ok<CaseDetailResponse>('GET', `/api/cases/${caseA}`);
    check(detailA.case.steps.map((s) => s.kind).join(',') === 'tap,expect,back', `edit A: steps are ${detailA.case.steps.map((s) => s.kind).join(',')}`);
    check(detailA.case.expectations.length === 1 && detailA.case.editedAt, 'edit A: end check lost or editedAt missing');
    const numbers = detailA.case.steps.map((s) => s.screenshot);
    check(new Set(numbers).size === numbers.length, `edit A: steps share screenshots ${numbers.join(', ')}`);

    log('case A: re-record from step 3 (Back again, old end check pre-ticked)');
    started = await ok<CaseStartResponse>('POST', `/api/cases/${caseA}/edit`, { mode: 'rerecord', step: 3 });
    await ok<ActionResponse>('POST', '/api/action/back');
    const candidates = await ok<CandidatesResponse>('GET', '/api/case/candidates');
    check((candidates.preselected ?? []).length === 1, `re-record A: expected the old end check pre-ticked, got ${JSON.stringify(candidates.preselected)}`);
    await ok('POST', '/api/case/finish', { picks: candidates.preselected });
    detailA = await ok<CaseDetailResponse>('GET', `/api/cases/${caseA}`);
    check(detailA.case.steps.length === 3 && detailA.case.expectations.length === 1, 're-record A: wrong shape');
    check(detailA.runs.every((run) => run.stale) && detailA.health.recent.length === 0, 're-record A: old runs not marked stale');

    // Case C: typing, Hide keyboard, Relaunch.
    log('case C: search, type, Hide keyboard, Back, Relaunch app');
    started = await ok<CaseStartResponse>('POST', '/api/case/start', { name: 'Search then relaunch' });
    screen = started.screen;
    screen = (await tapLabel(screen, /^Search (S|s)ettings$/, 'case C')).screen;
    await ok<ActionResponse>('POST', '/api/action/type', { text: 'wifi' });
    await ok<ActionResponse>('POST', '/api/action/hide-keyboard');
    await ok<ActionResponse>('POST', '/api/action/back');
    screen = (await ok<ActionResponse>('POST', '/api/action/relaunch')).screen;
    const caseC = await finish('first');
    const detailC = await ok<CaseDetailResponse>('GET', `/api/cases/${caseC}`);
    check(detailC.case.steps.map((s) => s.kind).join(',') === 'tap,type,hideKeyboard,back,relaunch', `case C: steps are ${detailC.case.steps.map((s) => s.kind).join(',')}`);
    check(detailC.yaml.includes('- hideKeyboard') && (detailC.yaml.match(/launchApp/g) ?? []).length === 2, `case C: flow is\n${detailC.yaml}`);
    const runC = await replay(caseC, 'replay C');
    check(runC.passed, 'replay C failed');
    checkScreenshots(runC, detailC, 'replay C');

    // Split B after step 1.
    log('case B: split after step 1');
    const split = await ok<CaseDetailResponse>('POST', `/api/cases/${caseB}/split`, { atStep: 1 });
    check(split.case.steps.length === 1 && split.parent && split.parent.id !== caseA, 'split B: wrong shape');
    const firstPart = await ok<CaseDetailResponse>('GET', `/api/cases/${split.parent!.id}`);
    check(firstPart.case.startFrom === caseA && firstPart.case.steps.length === 1, 'split B: first part does not start from A');
    check(firstPart.case.steps[0]?.screenshot?.startsWith(`evidence/${firstPart.case.id}/`), 'split B: screenshot not copied to the new case');

    // Run all.
    log('run all, retrying failures once');
    let suite = await ok<SuiteView>('POST', '/api/suite/run', { retryFailed: true });
    const blocked = await call<{ error: { code: string } }>('POST', '/api/action/back');
    check(blocked.status === 409 && blocked.body.error.code === 'SUITE_RUNNING', 'device actions were not refused during Run all');
    const deadline = Date.now() + 15 * 60_000;
    while (suite.status === 'running') {
      if (Date.now() > deadline) fail('Run all did not finish in 15 minutes');
      await new Promise((done) => setTimeout(done, 3000));
      suite = (await ok<SuiteView | null>('GET', '/api/suite/current'))!;
    }
    for (const item of suite.cases) {
      log(`   ${item.outcome.padEnd(7)} ${item.name}${item.failedStep ? `  at: ${item.failedStep}` : ''}${item.error ? `  ${item.error}` : ''}${item.note ? `  (${item.note})` : ''}`);
    }
    check(suite.cases.length === 4, `run all: expected 4 cases, got ${suite.cases.length}`);
    check(suite.cases.every((item) => item.outcome === 'passed' || item.outcome === 'flaky'), 'run all: a case failed');
    const order = suite.cases.map((item) => item.caseId);
    check(order.indexOf(caseA) < order.indexOf(split.parent!.id) && order.indexOf(split.parent!.id) < order.indexOf(caseB), `run all: parents did not run first: ${order.join(', ')}`);
    const suiteReport = await call<string>('GET', suite.reportUrl);
    check(suiteReport.status === 200 && String(suiteReport.body).includes('Run all'), 'suite report missing');
    const project = await ok<ProjectInfo>('GET', '/api/project');
    check(project.cases.every((item) => item.health.recent.length >= 1), 'project: a case has no run history after Run all');

    // Exports.
    log('exports');
    const xlsx = await call<string>('GET', '/api/export?format=xlsx');
    check(xlsx.status === 200 && xlsx.raw.subarray(0, 2).toString() === 'PK', 'project xlsx is not a zip');
    const listing = execFileSync('unzip', ['-l', join(projectDir, 'exports', 'test-cases.xlsx')], { encoding: 'utf8' });
    for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/styles.xml']) {
      check(listing.includes(part), `project xlsx lacks ${part}`);
    }
    const sheet = execFileSync('unzip', ['-p', join(projectDir, 'exports', 'test-cases.xlsx'), 'xl/worksheets/sheet2.xml'], { encoding: 'utf8' });
    check(sheet.includes('Tap') && sheet.includes('Open internet settings'), 'project xlsx steps sheet lacks the steps');
    const html = await call<string>('GET', `/api/cases/${caseA}/export?format=html`);
    check(String(html.body).includes('data:image/png;base64,') && String(html.body).includes('Expected at the end'), 'case html export incomplete');
    const md = await call<string>('GET', `/api/cases/${caseA}/export?format=md`);
    check(String(md.body).includes(`](../evidence/${caseA}/`), 'case markdown does not link screenshots');

    // Small edits.
    log('duplicate, rename, mute, step title, delete step, delete case');
    const copy = await ok<CaseDetailResponse>('POST', `/api/cases/${caseC}/duplicate`, {});
    check(copy.case.id !== caseC && copy.case.steps.length === detailC.case.steps.length, 'duplicate failed');
    await ok('PATCH', `/api/cases/${copy.case.id}`, { name: 'Search then relaunch, copy', muted: true });
    const titled = await ok<CaseDetailResponse>('PATCH', `/api/cases/${copy.case.id}/steps/1`, { title: 'Open the search', note: 'The search field has focus' });
    check(titled.case.steps[0]?.title === 'Open the search' && titled.case.muted, 'patch failed');
    const shorter = await ok<CaseDetailResponse>('DELETE', `/api/cases/${copy.case.id}/steps/2`);
    check(shorter.case.steps.length === detailC.case.steps.length - 1 && shorter.case.editedAt, 'delete step failed');
    await ok('DELETE', `/api/cases/${copy.case.id}`);

    await ok('POST', '/api/session/close');
    log(`PASSED. Project left in ${projectDir}`);
  } finally {
    // Closes the "smoke-studio" agent-device session, so the device is free for the next tool.
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('[smoke-studio] FAIL:', error instanceof SmokeFailure ? error.message : error);
  process.exit(1);
});
