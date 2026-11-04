// Export diagnostics: one zip a tester can send back when something does not
// work on their phone, from a company whose phones and apps we cannot see. It
// may leave the company, so what goes in is chosen one piece at a time, and
// everything that is text passes through clean() on the way:
//   in:  versions, the setup checks, phone facts, the studio log, case steps,
//        run results, and counts from recording on the phone.
//   out: .env (values are removed wherever they appear), typed text (only its
//        length), block values, full links, serial numbers, home folders. Key
//        positions are never kept anywhere to begin with.
// Screenshots can show anything on the phone, so they go in only when asked.
import { readFile, readdir } from 'node:fs/promises';
import { homedir, release, userInfo } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { isEnvPlaceholder, zip, type CaseStep, type TestCase, type ZipEntry } from '@ariadne/core';
import { exists, projectEnv } from './common.ts';
import { checkSetup, type SetupTools } from './setup.ts';
import type { ServerState } from './state.ts';

/** Enough history to see a pattern without sending a project's whole life. */
const RUNS_PER_CASE = 3;
const MAX_RUNS = 30;
const MAX_SCREENSHOTS = 100;
const MAX_DEVICE_LOG_LINES = 400;
/** What explains a failure on a phone; the rest of a device log is other apps' business. */
const DEVICE_LOG_LINES = /Background activity|Permission Denied Activity|INSTALL_|INJECT_EVENTS|dev\.mobile\.maestro|agentdevice/;

const README = `Ariadne diagnostics

This file was made by Export diagnostics in Ariadne Studio, to send to whoever
is helping with a problem. Look through it before sending it if you like: it is
an ordinary zip of text files.

summary.json          Ariadne and tool versions, this computer's system, phone facts
                      (maker, model, Android version, navigation, keyboard app).
                      No serial number and no list of your apps.
log.txt               The studio's log.
phone-sessions.jsonl  Counts from recording on the phone: how many taps, swipes and
                      key presses, how fast the screen could be read. No positions.
cases/                Your cases: steps and the names of elements tapped. Names come
                      from the app's screen, so they can show what was on it. Typed
                      text is replaced by its length.
runs/                 Results of recent runs and Maestro's output.
screenshots/          Only there if you ticked the box. They can show anything that
                      was on the phone, so check them first.

Never in this file: your saved values from .env (they are removed wherever they
appear), passwords, or where keys were pressed on the keyboard. Ariadne does not
keep key positions at all. Text you typed is removed from Maestro's output too,
though a very short entry, such as two digits, can only be removed where Maestro
says it typed something.
`;

function safeHost(url: string): string {
  try {
    return new URL(url).host || 'link';
  } catch {
    return 'link';
  }
}

function plainStep(step: CaseStep): CaseStep {
  if (step.kind === 'type') return isEnvPlaceholder(step.text) ? step : { ...step, text: `(${step.text.length} characters)` };
  if (step.kind === 'openLink') return { ...step, url: `(a link to ${safeHost(step.url)})` };
  if (step.kind === 'block' && step.values) return { ...step, values: Object.fromEntries(Object.keys(step.values).map((key) => [key, '(set)'])) };
  return step;
}

function plainCase(testCase: TestCase): TestCase {
  return {
    ...testCase,
    deviceId: '<phone>',
    steps: testCase.steps.map(plainStep),
    preconditionBlocks: testCase.preconditionBlocks.map((use) => ({ file: use.file })),
  };
}

/** A run's JSON names each command, and Maestro's commands include what was typed. */
function withoutTypedText(_key: string, value: unknown): unknown {
  return (value as { kind?: unknown } | null)?.kind === 'inputText' ? { ...(value as object), text: '(typed text)' } : value;
}

/** Below this, text cannot be found safely by searching for it: "12" is in too many other words. */
const SEARCHABLE_LENGTH = 3;
/** Saved values shorter than this get a stricter search, whole tokens only: a PIN is still a secret. */
const WHOLE_VALUE_LENGTH = 4;

const asJson = (text: string) => JSON.stringify(text).slice(1, -1);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^\\${}()|[\]\\]/g, '\\$&');
}

type Hidden = { env: Readonly<Record<string, string>>; typed: readonly string[]; phones: readonly string[]; paths: ReadonlyArray<[string, string]> };

/**
 * What every piece of text goes through on its way into the zip. Each value is
 * looked for as written and as JSON writes it, because most of the file is
 * JSON: a backslash in a Windows path or a quote in a password is escaped there.
 */
function cleaner({ env, typed, phones, paths }: Hidden): (text: string) => string {
  const pairs: Array<[string, string]> = [
    ...Object.entries(env)
      .filter(([, value]) => value.length >= WHOLE_VALUE_LENGTH)
      .map(([key, value]): [string, string] => [value, `\${${key}}`]),
    ...typed.filter((text) => text.length >= SEARCHABLE_LENGTH).map((text): [string, string] => [text, '(typed text)']),
    ...phones.filter(Boolean).map((serial): [string, string] => [serial, '<phone>']),
    ...paths.filter(([from]) => from),
  ];
  const everyForm = pairs.flatMap(([from, to]): Array<[string, string]> => [[from, to], [asJson(from), to]]).sort((a, b) => b[0].length - a[0].length);
  const shortValues = Object.entries(env).filter(([, value]) => value.length > 0 && value.length < WHOLE_VALUE_LENGTH);
  return (text) => {
    let cleaned = text.replace(/Input text .*/g, 'Input text (hidden)');
    for (const [from, to] of everyForm) cleaned = cleaned.split(from).join(to);
    for (const [key, value] of shortValues) cleaned = cleaned.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(value)}(?![A-Za-z0-9])`, 'g'), `\${${key}}`);
    return cleaned;
  };
}

async function deviceLogLines(dir: string): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  const logs = entries.filter((entry) => entry.isFile() && entry.name === 'device-logcat.txt');
  const lines: string[] = [];
  for (const entry of logs) {
    const text = await readFile(join(entry.parentPath, entry.name), 'utf8').catch(() => '');
    lines.push(...text.split(/\r?\n/).filter((line) => DEVICE_LOG_LINES.test(line)));
  }
  return lines.length > 0 ? lines.slice(-MAX_DEVICE_LOG_LINES).join('\n') : undefined;
}

async function runEntries(state: ServerState, caseIds: readonly string[], clean: (text: string) => string): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  let taken = 0;
  for (const caseId of caseIds) {
    for (const run of (await state.project.listRuns(caseId)).slice(0, RUNS_PER_CASE)) {
      if (taken >= MAX_RUNS) return entries;
      taken += 1;
      const dir = state.project.runDir(run.runId);
      entries.push({ name: `runs/${run.runId}/summary.json`, data: clean(JSON.stringify(run, withoutTypedText, 2)) });
      for (const file of ['output.txt', 'maestro.log']) {
        const path = join(dir, file);
        if (await exists(path)) entries.push({ name: `runs/${run.runId}/${file}`, data: clean(await readFile(path, 'utf8')) });
      }
      const deviceLog = await deviceLogLines(dir);
      if (deviceLog) entries.push({ name: `runs/${run.runId}/device-log-filtered.txt`, data: clean(deviceLog) });
    }
  }
  return entries;
}

/** A case file can be edited by hand, and one odd path must not cost the tester their whole report. */
async function readProjectFile(state: ServerState, path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(state.project.path(path));
  } catch {
    return undefined;
  }
}

async function screenshotEntries(state: ServerState, cases: readonly TestCase[]): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  for (const testCase of cases) {
    for (const step of testCase.steps) {
      if (!step.screenshot || entries.length >= MAX_SCREENSHOTS) continue;
      const data = await readProjectFile(state, step.screenshot);
      if (data) entries.push({ name: `screenshots/${testCase.id}/step-${String(step.index).padStart(3, '0')}.png`, data });
    }
  }
  return entries;
}

/** Facts for each phone adb can reach now; a phone that fails to answer is reported as such. */
async function phoneFacts(state: ServerState, setup: Awaited<ReturnType<typeof checkSetup>>): Promise<unknown[]> {
  return Promise.all(
    setup.devices.map(async (device) => {
      const base = { state: device.state, emulator: device.emulator, ...(device.model ? { model: device.model } : {}) };
      if (device.state !== 'device') return base;
      return { ...base, ...(await state.phoneTools.report(device.serial).catch((error: unknown) => ({ unreadable: String(error) }))) };
    }),
  );
}

export type DiagnosticsOptions = { appVersion: string; setup: SetupTools };

export async function buildDiagnostics(state: ServerState, options: DiagnosticsOptions, screenshots: boolean): Promise<Buffer> {
  const env = await projectEnv(state);
  const setup = await checkSetup(options.setup);
  const settings = await state.project.readSettings();
  const summaries = await state.project.listCases();
  const cases = await Promise.all(summaries.map((item) => state.project.readCase(item.id)));
  const clean = cleaner({
    env,
    typed: cases.flatMap((testCase) => testCase.steps.flatMap((step) => (step.kind === 'type' && !isEnvPlaceholder(step.text) ? [step.text] : []))),
    phones: [...setup.devices.map((device) => device.serial), ...cases.map((testCase) => testCase.deviceId), state.session.deviceId ?? ''],
    paths: [
      [state.project.dir, '<project>'],
      [homedir(), '~'],
      [userInfo().username, '<user>'],
    ],
  });

  const summary = {
    exportedAt: new Date().toISOString(),
    ariadne: { version: options.appVersion, screenshotsIncluded: screenshots },
    computer: { platform: process.platform, release: release(), arch: process.arch, node: process.version },
    tools: { adb: setup.adb, emulator: setup.emulator, maestro: setup.maestro, java: setup.java },
    project: { appId: settings.appId, cases: cases.length, savedValues: Object.keys(env).length },
    connected: { open: state.session.isOpen, ...(state.session.appId ? { appId: state.session.appId } : {}) },
    phones: await phoneFacts(state, setup),
  };

  const sessionsFile = state.project.path('diagnostics/phone-sessions.jsonl');
  const entries: ZipEntry[] = [
    { name: 'README.txt', data: README },
    { name: 'summary.json', data: clean(JSON.stringify(summary, null, 2)) },
    { name: 'log.txt', data: clean((state.log?.lines() ?? []).join('\n')) },
    ...((await exists(sessionsFile)) ? [{ name: 'phone-sessions.jsonl', data: clean(await readFile(sessionsFile, 'utf8')) }] : []),
    ...cases.map((testCase) => ({ name: `cases/${testCase.id}.json`, data: clean(JSON.stringify(plainCase(testCase), null, 2)) })),
    ...(await runEntries(state, summaries.map((item) => item.id), clean)),
    ...(screenshots ? await screenshotEntries(state, cases) : []),
  ];
  return zip(entries);
}

export function registerDiagnosticsRoutes(app: FastifyInstance, state: ServerState, options: DiagnosticsOptions): void {
  app.get('/api/diagnostics', async (request, reply) => {
    const { screenshots } = request.query as { screenshots?: string };
    const data = await buildDiagnostics(state, options, screenshots === '1');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    return reply
      .header('content-disposition', `attachment; filename="ariadne-diagnostics-${stamp}.zip"`)
      .type('application/zip')
      .send(data);
  });
}
