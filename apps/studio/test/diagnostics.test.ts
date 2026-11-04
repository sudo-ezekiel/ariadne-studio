// Export diagnostics: one zip a tester sends back, which may leave the company.
// The tests run the real server over a real project folder, download the zip
// and open every entry in it, so a promise the README makes is checked against
// the bytes that would be sent. The fake phone, getevent lines and fake adb
// follow phone-capture.test.ts; nothing here runs adb or touches a device.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readZipEntry, type DeviceSnapshot, type OpenOptions, type PhoneInput, type PhoneInputTools, type PhoneReport, type Point, type Rect } from '@ariadne/core';
import { buildServer } from '../src/server/index.ts';
import { captureLog, type LogBuffer } from '../src/server/log-buffer.ts';
import type { SetupTools } from '../src/server/setup.ts';
import type { DeviceLike } from '../src/server/state.ts';

// The report names the computer's home folder and user, so the tests choose
// them: a real username such as "root" could appear in the zip by chance.
const identity = vi.hoisted(() => ({ home: '/home/placeholder', user: 'mtester-diag' }));
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, homedir: () => identity.home, userInfo: () => ({ ...os.userInfo(), username: identity.user }) };
});

type Node = DeviceSnapshot['nodes'][number];

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const APP = 'com.example.claims';
const LAUNCHER = 'com.miui.home';
const VIEWPORT = { width: 1080, height: 2400 };
const KEYBOARD: Rect = { x: 0, y: 1500, width: 1080, height: 800 };
const INPUT: PhoneInput = {
  screen: { path: '/dev/input/event7', maxX: 1079, maxY: 2399 },
  longPressMs: 400,
  touchSlopPx: 20,
  gestureNavigation: false,
  homeApp: LAUNCHER,
};
const REGISTER: Point = { x: 500, y: 650 };
const KEY: Point = { x: 731, y: 1913 };

// Secrets and personal data the zip must not carry.
const PASSWORD = 'hunter2-diag-secret';
const TOKEN = 'tok-live-8812-diag';
const SESSION_KEY = 'sess-4455-diag-key';
const NAME = 'Maria Papadopoulou';
const EMAIL = 'maria.p@example.com';
const LINK = 'https://example.com/claims/123?token=abc456';
const AT = '2026-11-01T09:00:00.000Z';

// ---------------------------------------------------------------- the phone

function field(identifier: string, y: number, extra: Partial<Node> = {}): Node {
  return { index: 0, depth: 2, bundleId: APP, type: 'android.widget.EditText', identifier, editable: true, rect: { x: 0, y, width: 1080, height: 120 }, ...extra } as Node;
}

const appScreen = (extra: Node[] = []): Node[] => [
  { index: 0, depth: 1, bundleId: APP, rect: { x: 0, y: 300, width: 1080, height: 100 }, label: 'Sign in', hittable: true } as Node,
  { index: 1, depth: 1, bundleId: APP, rect: { x: 0, y: 600, width: 1080, height: 100 }, label: 'Register', hittable: true } as Node,
  ...extra,
];

const keyboardNodes = (): Node[] =>
  [
    { index: 0, depth: 1, bundleId: 'com.keyboard', rect: { x: 650, y: 1850, width: 160, height: 120 }, label: 'k', hittable: true },
    { index: 1, depth: 1, bundleId: 'com.keyboard', rect: { x: 900, y: 2150, width: 150, height: 120 }, label: 'Enter', hittable: true },
  ] as Node[];

class PhoneDevice implements DeviceLike {
  target: { deviceId: string; appId: string } | undefined;
  nodes: Node[] = appScreen();
  keyboard: Rect | undefined;
  snapshots = 0;

  get isOpen() { return this.target !== undefined; }
  get deviceId() { return this.target?.deviceId; }
  get appId() { return this.target?.appId; }

  async listDevices() {
    return [{ id: 'R58M123', name: 'Phone', platform: 'android' as const, kind: 'device' as const, booted: true }];
  }
  async open(options: OpenOptions) {
    this.target = { deviceId: options.deviceId, appId: options.appId };
  }
  async snapshot(): Promise<DeviceSnapshot> {
    this.snapshots += 1;
    return { nodes: this.nodes, viewport: VIEWPORT, takenAt: new Date().toISOString(), ...(this.keyboard ? { keyboard: this.keyboard } : {}) };
  }
  async capture(screenshotPath: string) {
    mkdirSync(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, PNG);
    return { ...(await this.snapshot()), screenshotPath };
  }
  async tapAt(_point: Point) {}
  async typeText(_text: string) {}
  async back() {}
  async scroll() {}
  async replayFlow() {
    return { replayed: 0 };
  }
  async close() {
    this.target = undefined;
  }
  async relaunchApp() {}
  async openLink() {}
  async hideKeyboard() {}
  async longPressAt() {}
  async doubleTapAt() {}
  async swipe() {}
  async pinch() {}
  async pressKey() {}
  async setOrientation() {}
}

// ------------------------------------------------------------------ adb

// Built with join, as setup.ts builds its candidates, so the separator is the OS's own.
const ADB = join('/sdk', 'platform-tools', 'adb');

/** The programs the setup check runs, answered from a fixed `adb devices -l`. */
function setupWith(devices: string): Partial<SetupTools> {
  return {
    exec: async (_file, args) => {
      if (args[0] === 'devices') return { stdout: devices, stderr: '' };
      throw new Error('not available in this test');
    },
    spawnDetached: () => undefined,
    androidHome: () => '/sdk',
    findMaestro: () => '/opt/maestro/bin/maestro',
    platform: 'linux',
    path: '',
    exists: (path) => path === ADB,
  };
}

const NO_TOOLS: Partial<SetupTools> = {
  exec: async () => {
    throw new Error('not installed');
  },
  spawnDetached: () => undefined,
  androidHome: () => undefined,
  findMaestro: () => {
    throw new Error('Maestro is not installed');
  },
  platform: 'linux',
  path: '',
  exists: () => false,
};

const PHONES = `List of devices attached
SERIAL-PHONE-R58M device usb:1-1 model:SM_A546B transport_id:2
SERIAL-UNAUTH-77 unauthorized usb:1-2 transport_id:3
SERIAL-BROKEN-42 device usb:1-3 model:Redmi_Note_12 transport_id:4
`;

// ------------------------------------------------------------------ the rig

type Rig = {
  app: FastifyInstance;
  device: PhoneDevice;
  /** The project folder, inside the pretend home folder. */
  dir: string;
  home: string;
  logLines: string[];
  report: ReturnType<typeof vi.fn<(id: string) => Promise<PhoneReport>>>;
  /** Lines in, as getevent would print them. */
  line(text: string): void;
  endWatch(): void;
};

type RigOptions = { setup?: Partial<SetupTools>; appVersion?: string; report?: (id: string) => Promise<PhoneReport> };

let roots: string[] = [];
let rigs: Rig[] = [];

async function rig(options: RigOptions = {}): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-diag-test-'));
  roots.push(root);
  const home = join(root, 'home', identity.user);
  const dir = join(home, 'Documents', 'claims-project');
  identity.home = home;
  const device = new PhoneDevice();
  let onLine: (line: string) => void = () => undefined;
  let onEnd: () => void = () => undefined;
  const refuse = (what: string) => async () => {
    throw new Error(`${what} must not run in a test`);
  };
  const report = vi.fn<(id: string) => Promise<PhoneReport>>(options.report ?? (async () => ({})));
  const phoneTools: PhoneInputTools = {
    read: vi.fn(async () => INPUT as PhoneInput | undefined),
    rotation: async () => 0,
    watch: (_id, _path, line, end) => {
      onLine = line;
      onEnd = end;
      return () => undefined;
    },
    xiaomi: async () => undefined,
    allowDriver: refuse('allowDriver'),
    installDriver: refuse('installDriver'),
    stopDriver: refuse('stopDriver'),
    report,
  };
  const logLines: string[] = [];
  const log: LogBuffer = { lines: () => [...logLines], stop: () => undefined };
  const app = await buildServer({
    projectDir: dir,
    session: device,
    maestro: { run: refuse('Maestro'), findBin: () => '/opt/maestro/bin/maestro', androidHome: () => undefined },
    phoneTools,
    setup: options.setup ?? NO_TOOLS,
    appVersion: options.appVersion ?? '9.9.9-test',
    log,
  });
  const made: Rig = { app, device, dir, home, logLines, report, line: (text) => onLine(text), endWatch: () => onEnd() };
  rigs.push(made);
  return made;
}

beforeEach(() => {
  // The studio logs every request; keep the test output quiet.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const made of rigs) await made.app.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  rigs = [];
  roots = [];
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const until = Date.now() + 4000;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}

async function call(r: Rig, method: 'GET' | 'POST', url: string, payload?: object) {
  const response = await r.app.inject({ method, url, ...(payload ? { payload } : {}) });
  return { status: response.statusCode, body: response.headers['content-type']?.includes('json') ? response.json() : response.body };
}

// -------------------------------------------------------------- reading a zip

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;

/** Every entry of a zip, found from its central directory, so nothing is skipped by not being named. */
function readZip(archive: Buffer): Map<string, Buffer> {
  let end = archive.length - 22;
  while (end >= 0 && archive.readUInt32LE(end) !== END_OF_DIRECTORY) end -= 1;
  expect(end, 'a zip has an end-of-directory record').toBeGreaterThanOrEqual(0);
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let entry = 0; entry < count; entry += 1) {
    expect(archive.readUInt32LE(at)).toBe(DIRECTORY_ENTRY);
    const nameLength = archive.readUInt16LE(at + 28);
    names.push(archive.toString('utf8', at + 46, at + 46 + nameLength));
    at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }
  const files = new Map<string, Buffer>();
  for (const name of names) files.set(name, readZipEntry(archive, name)!);
  expect(files.size, 'no two entries share a name').toBe(names.length);
  return files;
}

async function download(r: Rig, query = ''): Promise<Map<string, Buffer>> {
  const response = await r.app.inject({ method: 'GET', url: `/api/diagnostics${query}` });
  expect(response.statusCode).toBe(200);
  return readZip(response.rawPayload);
}

const text = (files: Map<string, Buffer>, name: string): string => {
  const file = files.get(name);
  if (!file) throw new Error(`The zip has no ${name}; it has ${[...files.keys()].join(', ')}`);
  return file.toString('utf8');
};

/** Where each needle shows up, in an entry's name or its bytes. Empty means clean. */
function leaks(files: Map<string, Buffer>, needles: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [name, data] of files) {
    for (const [label, needle] of Object.entries(needles)) {
      if (name.includes(needle) || data.includes(needle)) found.push(`${label} in ${name}`);
    }
  }
  return found;
}

// ------------------------------------------------------------- project files

async function seed(dir: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [name, data] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), data);
  }
}

type StepJson = Record<string, unknown>;

const caseFile = (id: string, steps: StepJson[] = [], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ id, name: `Case ${id}`, appId: APP, createdAt: AT, deviceId: 'emulator-5554', preconditionBlocks: [], steps, expectations: [], ...extra });

const runId = (caseId: string, n: number) => `${caseId}-20261101-1010${String(n).padStart(2, '0')}`;

/** A saved run with a summary, the way `listRuns` wants it; later `n` is newer. */
function runFiles(caseId: string, n: number, extra: Record<string, string> = {}): Record<string, string> {
  const id = runId(caseId, n);
  const summary = { runId: id, caseId, flowFile: `flows/${caseId}.yaml`, startedAt: `2026-11-01T10:10:${String(n).padStart(2, '0')}.000Z`, finishedAt: AT, exitCode: 1, passed: false, steps: [], outputFile: `runs/${id}/output.txt` };
  return { [`runs/${id}/summary.json`]: JSON.stringify(summary), [`runs/${id}/output.txt`]: `output of ${id}`, ...extra };
}

const tapStep = (index: number, extra: StepJson = {}): StepJson => ({ index, kind: 'tap', selector: { kind: 'text', value: 'Submit' }, point: { x: 10, y: 20 }, at: AT, ...extra });

// ================================================================= privacy

describe('what the zip must not carry', () => {
  const CASE = 'submit-a-claim-20261101-0900';

  /** A project with every kind of secret in every place the export reads. */
  async function sensitiveProject(r: Rig): Promise<void> {
    const username = identity.user;
    await seed(r.dir, {
      '.env': `PASSWORD=${PASSWORD}\nAPI_TOKEN=${TOKEN}\n`,
      'project.json': JSON.stringify({ appId: APP, platform: 'android', env: { SESSION_KEY } }),
      [`cases/${CASE}.json`]: caseFile(
        CASE,
        [
          { index: 1, kind: 'type', text: NAME, at: AT },
          { index: 2, kind: 'type', text: '${PASSWORD}', at: AT },
          { index: 3, kind: 'openLink', url: LINK, at: AT },
          { index: 4, kind: 'block', file: 'blocks/login.yaml', values: { USERNAME: EMAIL, PASSWORD: '${PASSWORD}', NOTE: `plain ${NAME}` }, at: AT },
          tapStep(5, { title: 'Press Submit' }),
        ],
        { preconditionBlocks: [{ file: 'blocks/login.yaml', values: { USERNAME: EMAIL } }] },
      ),
      // Files the export must leave alone, even though they hold the same secrets.
      [`flows/${CASE}.yaml`]: `- inputText: ${NAME}\n- inputText: ${PASSWORD}\n`,
      'blocks/login.yaml': `- inputText: ${PASSWORD}\n`,
      ...runFiles(CASE, 1, {
        [`runs/${runId(CASE, 1)}/output.txt`]: `Running on ${r.home}/Android\ntyping ${PASSWORD} and ${TOKEN} and ${SESSION_KEY}\nflow ${r.dir}/flows/x.yaml\nuser ${username}\n`,
        [`runs/${runId(CASE, 1)}/maestro.log`]: `INFO ${PASSWORD} ${r.dir}/runs ${r.home}/.maestro/logs as ${username}\n`,
        [`runs/${runId(CASE, 1)}/device-logcat.txt`]: [
          `11-04 10:00:01.000 W/ActivityManager: Background activity start blocked for ${PASSWORD} in ${r.home}/data`,
          `11-04 10:00:02.000 I/Bank: balance ${NAME} ${PASSWORD} account 123 is visible`,
          `11-04 10:00:03.000 E/PackageInstaller: INSTALL_FAILED_USER_RESTRICTED ${TOKEN}`,
        ].join('\n'),
        [`runs/${runId(CASE, 1)}/submit/device-logcat.txt`]: `E/dev.mobile.maestro: ${username} could not start ${PASSWORD}\nI/Mail: new message for ${NAME}\n`,
      }),
      'diagnostics/phone-sessions.jsonl': `{"appId":"${APP}","gestures":{"tap":2}}\n`,
    });
    // Both overwrite the run summary written by runFiles with the secret in its error.
    const id = runId(CASE, 1);
    const summary = JSON.parse(await readFile(join(r.dir, 'runs', id, 'summary.json'), 'utf8'));
    summary.error = `Typing ${PASSWORD} failed in ${r.dir}/flows/${CASE}.yaml`;
    await writeFile(join(r.dir, 'runs', id, 'summary.json'), JSON.stringify(summary));
    r.logLines.push(
      '2026-11-04T10:00:00.000Z [studio] GET /api/cases 200 3ms',
      `2026-11-04T10:00:01.000Z ERROR [studio] replay failed in ${r.dir}/flows/x.yaml: password ${PASSWORD}`,
      `2026-11-04T10:00:02.000Z [studio] adb at ${r.home}/Android/Sdk/platform-tools/adb token ${TOKEN}`,
      `2026-11-04T10:00:03.000Z [studio] opened by ${username}`,
    );
  }

  const NEEDLES = (r: Rig): Record<string, string> => ({
    password: PASSWORD,
    token: TOKEN,
    'project.json value': SESSION_KEY,
    'typed name': NAME,
    'block value': EMAIL,
    'link token': 'abc456',
    'link path': '/claims/123',
    'project folder': r.dir,
    'home folder': r.home,
    'os username': identity.user,
  });

  it('carries none of the secrets, the typed name, the link\'s token, the project folder, the home folder or the username, in any entry', async () => {
    const r = await rig();
    await sensitiveProject(r);
    const files = await download(r);
    expect(leaks(files, NEEDLES(r))).toEqual([]);
  });

  it('holds exactly the files it is meant to hold, not .env, project.json, flows or blocks', async () => {
    const r = await rig();
    await sensitiveProject(r);
    const files = await download(r);
    const run = runId(CASE, 1);
    expect([...files.keys()].sort()).toEqual(
      [
        'README.txt',
        'summary.json',
        'log.txt',
        'phone-sessions.jsonl',
        `cases/${CASE}.json`,
        `runs/${run}/summary.json`,
        `runs/${run}/output.txt`,
        `runs/${run}/maestro.log`,
        `runs/${run}/device-log-filtered.txt`,
      ].sort(),
    );
  });

  it('replaces a secret with its ${KEY} in Maestro\'s output, its log and the run summary', async () => {
    const r = await rig();
    await sensitiveProject(r);
    const files = await download(r);
    const run = runId(CASE, 1);
    expect(text(files, `runs/${run}/output.txt`)).toContain('typing ${PASSWORD} and ${API_TOKEN} and ${SESSION_KEY}');
    expect(text(files, `runs/${run}/maestro.log`)).toContain('INFO ${PASSWORD} <project>/runs ~/.maestro/logs as <user>');
    expect(JSON.parse(text(files, `runs/${run}/summary.json`)).error).toContain('Typing ${PASSWORD} failed in <project>/flows/');
  });

  it('writes the project folder as <project>, the home folder as ~ and the username as <user> in the log', async () => {
    const r = await rig();
    await sensitiveProject(r);
    const log = text(await download(r), 'log.txt');
    expect(log).toContain('replay failed in <project>/flows/x.yaml: password ${PASSWORD}');
    expect(log).toContain('adb at ~/Android/Sdk/platform-tools/adb token ${API_TOKEN}');
    expect(log).toContain('opened by <user>');
    expect(log).toContain('GET /api/cases 200 3ms');
  });

  it('keeps a ${PASSWORD} placeholder, turns typed text into its length, a link into its host and block values into their keys', async () => {
    const r = await rig();
    await sensitiveProject(r);
    const saved = JSON.parse(text(await download(r), `cases/${CASE}.json`));
    expect(saved.steps[0]).toMatchObject({ kind: 'type', text: '(18 characters)' });
    expect(NAME).toHaveLength(18);
    expect(saved.steps[1]).toMatchObject({ kind: 'type', text: '${PASSWORD}' });
    expect(saved.steps[2]).toMatchObject({ kind: 'openLink', url: '(a link to example.com)' });
    expect(saved.steps[3]).toMatchObject({ kind: 'block', file: 'blocks/login.yaml', values: { USERNAME: '(set)', PASSWORD: '(set)', NOTE: '(set)' } });
    expect(Object.keys(saved.steps[3].values).sort()).toEqual(['NOTE', 'PASSWORD', 'USERNAME']);
  });

  it('keeps the other steps of a case as they were, and drops the values a case sets on its setup blocks', async () => {
    const r = await rig();
    await sensitiveProject(r);
    const saved = JSON.parse(text(await download(r), `cases/${CASE}.json`));
    expect(saved.steps[4]).toEqual(tapStep(5, { title: 'Press Submit' }));
    expect(saved.preconditionBlocks).toEqual([{ file: 'blocks/login.yaml' }]);
  });

  it('keeps only the host of a link that is not a valid URL as "link"', async () => {
    const r = await rig();
    await seed(r.dir, { 'cases/c-20261101-0900.json': caseFile('c-20261101-0900', [{ index: 1, kind: 'openLink', url: 'not a url with token=zz9981', at: AT }]) });
    const files = await download(r);
    const saved = JSON.parse(text(files, 'cases/c-20261101-0900.json'));
    expect(saved.steps[0].url).toBe('(a link to link)');
    expect(leaks(files, { token: 'zz9981' })).toEqual([]);
  });

  it('counts the characters of a typed text with accents and symbols as the text has them', async () => {
    const r = await rig();
    await seed(r.dir, { 'cases/c-20261101-0900.json': caseFile('c-20261101-0900', [{ index: 1, kind: 'type', text: 'Μαρία Παπαδοπούλου', at: AT }]) });
    const saved = JSON.parse(text(await download(r), 'cases/c-20261101-0900.json'));
    expect(saved.steps[0].text).toBe('(18 characters)');
  });

  it('redacts a saved value that appears in a case title or note', async () => {
    const r = await rig();
    await seed(r.dir, {
      '.env': `PASSWORD=${PASSWORD}\n`,
      'cases/c-20261101-0900.json': caseFile('c-20261101-0900', [tapStep(1, { title: `Use ${PASSWORD}`, note: `then ${PASSWORD} again` })]),
    });
    const files = await download(r);
    expect(leaks(files, { password: PASSWORD })).toEqual([]);
    expect(JSON.parse(text(files, 'cases/c-20261101-0900.json')).steps[0].title).toBe('Use ${PASSWORD}');
  });

  // KNOWN GAP: only a case's own steps lose their typed text. Maestro prints
  // each inputText it runs, so a run's output.txt and maestro.log carry the
  // plain text a tester typed, which the header of diagnostics.ts says stays
  // out. Left failing on purpose.
  it('carries no typed text echoed in Maestro\'s output or log', async () => {
    const r = await rig();
    const id = runId(CASE, 1);
    await seed(r.dir, {
      [`cases/${CASE}.json`]: caseFile(CASE, [{ index: 1, kind: 'type', text: NAME, at: AT }]),
      ...runFiles(CASE, 1, {
        [`runs/${id}/output.txt`]: `Input text ${NAME}... COMPLETED\n`,
        [`runs/${id}/maestro.log`]: `Running inputText: ${NAME}\n`,
      }),
    });
    expect(leaks(await download(r), { 'typed name': NAME })).toEqual([]);
  });

  // KNOWN GAP: clean() runs over JSON text, where a quote or backslash in a
  // value is written escaped (pa\"ss\\w0rd), so redactValues does not find it.
  // A saved value with a quote or backslash in a case's note leaks. Left failing on purpose.
  it('redacts a saved value that has a quote and a backslash in it, as it is written inside JSON', async () => {
    const r = await rig();
    const tricky = 'pa"ss\\w0rd-diag-9';
    await seed(r.dir, {
      'project.json': JSON.stringify({ appId: APP, platform: 'android', env: { TRICKY: tricky } }),
      'cases/c-20261101-0900.json': caseFile('c-20261101-0900', [tapStep(1, { note: `typed ${tricky} here` })]),
    });
    const files = await download(r);
    expect(leaks(files, { raw: tricky, 'as written in JSON': JSON.stringify(tricky).slice(1, -1) })).toEqual([]);
  });

  // KNOWN GAP: plainCase() leaves a case's deviceId alone, and for a phone that
  // is its adb serial number, which the README says is not in the file.
  it('carries no serial number of a phone anywhere in the zip', async () => {
    const r = await rig({ setup: setupWith(PHONES), report: async () => ({ maker: 'samsung' }) });
    await seed(r.dir, { 'cases/c-20261101-0900.json': caseFile('c-20261101-0900', [], { deviceId: 'SERIAL-PHONE-R58M' }) });
    const files = await download(r);
    expect(leaks(files, { serial: 'SERIAL-PHONE-R58M', 'unauthorized serial': 'SERIAL-UNAUTH-77', 'broken serial': 'SERIAL-BROKEN-42' })).toEqual([]);
  });

  it('redacts a saved value of exactly 4 characters, the shortest redactValues takes', async () => {
    const r = await rig();
    await seed(r.dir, { '.env': 'PIN=1234\n', 'cases/c-20261101-0900.json': caseFile('c-20261101-0900', [tapStep(1, { note: 'pin 1234 here' })]) });
    const saved = JSON.parse(text(await download(r), 'cases/c-20261101-0900.json'));
    expect(saved.steps[0].note).toBe('pin ${PIN} here');
  });

  it('removes a saved value too short to search for, where it stands alone', async () => {
    const r = await rig();
    await seed(r.dir, { '.env': 'PIN=739\n', 'cases/c-20261101-0900.json': caseFile('c-20261101-0900', [tapStep(1, { note: 'pin 739 here, order 17395' })]) });
    const saved = JSON.parse(text(await download(r), 'cases/c-20261101-0900.json'));
    expect(saved.steps[0].note).toBe('pin ${PIN} here, order 17395');
  });
});

// ============================================================ key positions

describe('recording on the phone leaves no key positions in the zip', () => {
  const SECRET = 'hunter2-Sup3r';
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  const ev = (type: string, code: string, value: string) => `[ ${(Date.now() / 1000).toFixed(6).padStart(12)}] ${type.padEnd(12)} ${code.padEnd(20)} ${value}`;
  const report = () => ev('EV_SYN', 'SYN_REPORT', '00000000');

  async function finger(r: Rig, at: Point, hold = 30): Promise<void> {
    r.line(ev('EV_ABS', 'ABS_MT_SLOT', hex(0)));
    r.line(ev('EV_ABS', 'ABS_MT_TRACKING_ID', hex(1)));
    r.line(ev('EV_ABS', 'ABS_MT_POSITION_X', hex(at.x)));
    r.line(ev('EV_ABS', 'ABS_MT_POSITION_Y', hex(at.y)));
    r.line(report());
    await sleep(hold);
    r.line(ev('EV_ABS', 'ABS_MT_TRACKING_ID', 'ffffffff'));
    r.line(report());
  }

  async function steps(r: Rig, count: number): Promise<Array<Record<string, any>>> {
    let found: Array<Record<string, any>> = [];
    await waitFor(async () => {
      found = (await call(r, 'GET', '/api/case/current')).body.steps;
      return found.length >= count;
    }, `${count} steps`);
    return found;
  }

  async function startPhone(r: Rig): Promise<string> {
    expect((await call(r, 'POST', '/api/session/open', { deviceId: 'R58M123', appId: APP })).status).toBe(200);
    const started = await call(r, 'POST', '/api/case/start', { name: 'Phone case' });
    expect(started.status).toBe(200);
    expect((await call(r, 'POST', '/api/phone/start')).status).toBe(200);
    const target = r.device.snapshots + 3;
    await waitFor(() => r.device.snapshots >= target, 'snapshots');
    return started.body.caseId;
  }

  const settled = async (r: Rig) => {
    const target = r.device.snapshots + 3;
    await waitFor(() => r.device.snapshots >= target, 'snapshots');
  };

  /** Two key presses in a password field, whose text is on the screen, then a tap outside the keyboard. */
  async function recordPassword(r: Rig): Promise<string> {
    r.device.nodes = appScreen([field('pw', 900, { focused: true, password: true, value: '' }), ...keyboardNodes()]);
    r.device.keyboard = KEYBOARD;
    const caseId = await startPhone(r);
    r.device.nodes = appScreen([field('pw', 900, { focused: true, password: true, value: SECRET, label: SECRET, text: SECRET } as Partial<Node>), ...keyboardNodes()]);
    await finger(r, KEY);
    await settled(r);
    await finger(r, KEY);
    await settled(r);
    await finger(r, REGISTER);
    await steps(r, 2);
    return caseId;
  }

  const SESSION_KEYS = ['appId', 'endedAt', 'gestureNavigation', 'gestures', 'keyboardShownAfterMs', 'longPressMs', 'pauses', 'reviews', 'snapshotFailures', 'snapshots', 'startedAt', 'touchScreen'];

  async function sessionLines(r: Rig): Promise<Array<Record<string, any>>> {
    const raw = await readFile(join(r.dir, 'diagnostics', 'phone-sessions.jsonl'), 'utf8');
    return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  it('has no coordinates, no touch events and no password from a recording with keyboard touches', async () => {
    const r = await rig();
    const caseId = await recordPassword(r);
    expect((await call(r, 'POST', '/api/case/finish')).status).toBe(200);
    const files = await download(r);
    expect([...files.keys()]).toContain('phone-sessions.jsonl');
    for (const [name, data] of files) {
      const body = data.toString('utf8');
      expect(body, name).not.toMatch(/\b731\b/);
      expect(body, name).not.toMatch(/\b1913\b/);
      expect(body, name).not.toMatch(/\b0*2db\b|\b0*779\b/i);
      expect(body, name).not.toContain('ABS_MT');
      expect(body, name).not.toContain('SYN_REPORT');
      expect(body, name).not.toContain(SECRET);
    }
    expect(JSON.parse(text(files, `cases/${caseId}.json`)).steps[0]).toMatchObject({ kind: 'type', text: '${PASSWORD}', review: 'password' });
  });

  it('holds in phone-sessions.jsonl only the known keys, so a new field with touch data fails here', async () => {
    const r = await rig();
    await recordPassword(r);
    await call(r, 'POST', '/api/case/finish');
    const [session, ...others] = readZipLines(await download(r));
    expect(others).toEqual([]);
    expect(Object.keys(session!).sort()).toEqual(SESSION_KEYS);
    expect(Object.keys(session!.touchScreen).sort()).toEqual(['maxX', 'maxY', 'path']);
    expect(Object.keys(session!.snapshots).sort()).toEqual(['count', 'maxMs', 'medianMs']);
    expect(session).toMatchObject({ appId: APP, longPressMs: 400, gestureNavigation: false, touchScreen: INPUT.screen });
  });

  it('holds only numbers under the gesture, review, timing and count fields', async () => {
    const r = await rig();
    await recordPassword(r);
    await call(r, 'POST', '/api/case/finish');
    const [session] = readZipLines(await download(r));
    for (const group of [session!.gestures, session!.reviews, session!.snapshots]) {
      for (const value of Object.values(group)) expect(typeof value).toBe('number');
    }
    for (const value of session!.keyboardShownAfterMs) expect(typeof value).toBe('number');
    expect(Number.isInteger(session!.pauses)).toBe(true);
    expect(Number.isInteger(session!.snapshotFailures)).toBe(true);
    expect(Array.isArray(session!.keyboardShownAfterMs)).toBe(true);
    expect(session!.snapshots.count).toBeGreaterThan(0);
  });

  it('counts the keyboard touches and the tap as they were made', async () => {
    const r = await rig();
    await recordPassword(r);
    await call(r, 'POST', '/api/case/finish');
    const [session] = readZipLines(await download(r));
    expect(session!.gestures).toEqual({ keyboard: 2, tap: 1 });
    expect(session!.reviews).toEqual({ password: 1 });
    expect(session!.pauses).toBe(0);
  });

  function readZipLines(files: Map<string, Buffer>): Array<Record<string, any>> {
    return text(files, 'phone-sessions.jsonl').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  it('writes one line for each session', async () => {
    const r = await rig();
    r.device.nodes = appScreen();
    await startPhone(r);
    await finger(r, REGISTER);
    await steps(r, 1);
    expect((await call(r, 'POST', '/api/phone/stop')).body.active).toBe(false);
    expect((await call(r, 'POST', '/api/phone/start')).status).toBe(200);
    await settled(r);
    expect((await call(r, 'POST', '/api/phone/stop')).body.active).toBe(false);
    const lines = await sessionLines(r);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.gestures).toEqual({ tap: 1 });
    expect(lines[1]!.gestures).toEqual({});
  });

  it('does not set stoppedBy when the tester stopped the recording', async () => {
    const r = await rig();
    await startPhone(r);
    await call(r, 'POST', '/api/phone/stop');
    expect(await sessionLines(r)).toEqual([expect.not.objectContaining({ stoppedBy: expect.anything() })]);
  });

  it('sets stoppedBy when the phone stopped sending touches', async () => {
    const r = await rig();
    await startPhone(r);
    r.endWatch();
    await waitFor(async () => (await call(r, 'GET', '/api/phone')).body.active === false, 'the capture to stop');
    await waitFor(async () => {
      try {
        return (await sessionLines(r)).length === 1;
      } catch {
        return false;
      }
    }, 'the counts to be saved');
    const [line] = await sessionLines(r);
    expect(line!.stoppedBy).toMatch(/stopped sending touches/);
    expect(Object.keys(line!).sort()).toEqual([...SESSION_KEYS, 'stoppedBy'].sort());
  });

  it('stops normally, and says so on the console, when the counts cannot be written', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await rig();
    // A file where the folder should be makes the write fail.
    await writeFile(join(r.dir, 'diagnostics'), 'not a folder');
    await startPhone(r);
    const stopped = await call(r, 'POST', '/api/phone/stop');
    expect(stopped).toMatchObject({ status: 200, body: { active: false } });
    expect(error.mock.calls.map((args) => args.map(String).join(' ')).join('\n')).toMatch(/could not save the phone session's counts/);
    expect((await call(r, 'POST', '/api/case/finish')).status).toBe(200);
  });

  it('still exports when the counts could not be written, with no phone-sessions.jsonl', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await rig();
    await writeFile(join(r.dir, 'diagnostics'), 'not a folder');
    await startPhone(r);
    await call(r, 'POST', '/api/phone/stop');
    const files = await download(r);
    expect(files.has('phone-sessions.jsonl')).toBe(false);
  });
});

// ============================================================== screenshots

describe('screenshots', () => {
  const CASE = 'shots-20261101-0900';
  const withShots = async (r: Rig, count = 2) => {
    const steps = Array.from({ length: count }, (_, i) => tapStep(i + 1, { screenshot: `evidence/${CASE}/step-${String(i + 1).padStart(3, '0')}.png` }));
    const pictures = Object.fromEntries(steps.map((step) => [step.screenshot as string, PNG]));
    await seed(r.dir, { [`cases/${CASE}.json`]: caseFile(CASE, steps), ...pictures });
  };

  it('are not in the zip by default, though the case has them', async () => {
    const r = await rig();
    await withShots(r);
    const files = await download(r);
    expect([...files.keys()].filter((name) => name.startsWith('screenshots/') || name.endsWith('.png'))).toEqual([]);
    expect(JSON.parse(text(files, 'summary.json')).ariadne.screenshotsIncluded).toBe(false);
  });

  it('are not in the zip when screenshots=0', async () => {
    const r = await rig();
    await withShots(r);
    expect([...(await download(r, '?screenshots=0')).keys()].some((name) => name.startsWith('screenshots/'))).toBe(false);
  });

  it('are in the zip, byte for byte, with ?screenshots=1', async () => {
    const r = await rig();
    await withShots(r);
    const files = await download(r, '?screenshots=1');
    expect([...files.keys()].filter((name) => name.startsWith('screenshots/')).sort()).toEqual([`screenshots/${CASE}/step-001.png`, `screenshots/${CASE}/step-002.png`]);
    expect(files.get(`screenshots/${CASE}/step-001.png`)!.equals(PNG)).toBe(true);
    expect(JSON.parse(text(files, 'summary.json')).ariadne.screenshotsIncluded).toBe(true);
  });

  it('stop at 100, however many steps have one', async () => {
    const r = await rig();
    // One picture shared by every step is enough: the cap counts entries.
    const steps = Array.from({ length: 130 }, (_, i) => tapStep(i + 1, { screenshot: `evidence/${CASE}/shared.png` }));
    await seed(r.dir, { [`cases/${CASE}.json`]: caseFile(CASE, steps), [`evidence/${CASE}/shared.png`]: PNG });
    const files = await download(r, '?screenshots=1');
    expect([...files.keys()].filter((name) => name.startsWith('screenshots/'))).toHaveLength(100);
  });

  it('count across cases against the same cap of 100', async () => {
    const r = await rig();
    const steps = (n: number) => Array.from({ length: n }, (_, i) => tapStep(i + 1, { screenshot: 'evidence/shared.png' }));
    await seed(r.dir, {
      'cases/a-20261101-0900.json': caseFile('a-20261101-0900', steps(60), { createdAt: '2026-11-01T09:00:00.000Z' }),
      'cases/b-20261101-0901.json': caseFile('b-20261101-0901', steps(60), { createdAt: '2026-11-01T09:01:00.000Z' }),
      'evidence/shared.png': PNG,
    });
    const names = [...(await download(r, '?screenshots=1')).keys()].filter((name) => name.startsWith('screenshots/'));
    expect(names).toHaveLength(100);
  });

  it('are skipped, without failing the export, for a step whose file is missing', async () => {
    const r = await rig();
    await withShots(r, 3);
    await rm(join(r.dir, 'evidence', CASE, 'step-002.png'));
    const files = await download(r, '?screenshots=1');
    expect([...files.keys()].filter((name) => name.startsWith('screenshots/')).sort()).toEqual([`screenshots/${CASE}/step-001.png`, `screenshots/${CASE}/step-003.png`]);
  });

  it('are not read for a step with none', async () => {
    const r = await rig();
    await seed(r.dir, { [`cases/${CASE}.json`]: caseFile(CASE, [tapStep(1)]) });
    const files = await download(r, '?screenshots=1');
    expect([...files.keys()].some((name) => name.startsWith('screenshots/'))).toBe(false);
  });

  // KNOWN GAP: ProjectStore.path() throws for a path outside the project, and
  // screenshotEntries does not catch it, so one such step (a hand-edited or
  // imported case) fails the whole export with a 500. Left failing on purpose.
  it('do not read a file outside the project, and do not fail the export, for a step that points out of it', async () => {
    const r = await rig();
    const outside = join(dirname(r.dir), 'outside-secret.png');
    await writeFile(outside, 'OUTSIDE-FILE-CONTENT');
    await seed(r.dir, { [`cases/${CASE}.json`]: caseFile(CASE, [tapStep(1, { screenshot: '../outside-secret.png' })]) });
    const response = await r.app.inject({ method: 'GET', url: '/api/diagnostics?screenshots=1' });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.includes('OUTSIDE-FILE-CONTENT')).toBe(false);
  });
});

// ================================================================ device log

describe('the device log', () => {
  const CASE = 'logs-20261101-0900';
  const RUN = runId(CASE, 1);
  const filtered = async (r: Rig, logs: Record<string, string>): Promise<string | undefined> => {
    await seed(r.dir, { [`cases/${CASE}.json`]: caseFile(CASE), ...runFiles(CASE, 1, logs) });
    const files = await download(r);
    return files.get(`runs/${RUN}/device-log-filtered.txt`)?.toString('utf8');
  };

  it('keeps a line for each thing that explains a failure and drops other apps\' lines', async () => {
    const r = await rig();
    const kept = [
      'W/ActivityManager: Background activity start blocked',
      'W/MIUILOG: Permission Denied Activity opening',
      'E/PackageInstaller: INSTALL_FAILED_USER_RESTRICTED',
      'E/InputDispatcher: INJECT_EVENTS permission denied',
      'I/dev.mobile.maestro: driver started',
      'I/agentdevice: helper ready',
    ];
    const dropped = ['I/Bank: balance is 100', 'D/Chrome: visited https://private.example/inbox', 'I/WhatsApp: message from Maria', ''];
    const log = await filtered(r, { [`runs/${RUN}/device-logcat.txt`]: [...kept.slice(0, 3), ...dropped, ...kept.slice(3)].join('\n') });
    expect(log!.split('\n')).toEqual(kept);
  });

  it('is not in the zip when no line matches', async () => {
    const r = await rig();
    expect(await filtered(r, { [`runs/${RUN}/device-logcat.txt`]: 'I/Bank: balance is 100\nI/Mail: new message' })).toBeUndefined();
  });

  it('is not in the zip when the run has no device log', async () => {
    const r = await rig();
    expect(await filtered(r, {})).toBeUndefined();
  });

  it('reads Windows line endings without a stray carriage return', async () => {
    const r = await rig();
    const log = await filtered(r, { [`runs/${RUN}/device-logcat.txt`]: 'I/dev.mobile.maestro: one\r\nI/Bank: x\r\nI/agentdevice: two\r\n' });
    expect(log).toBe('I/dev.mobile.maestro: one\nI/agentdevice: two');
  });

  it('gathers device logs from folders inside the run', async () => {
    const r = await rig();
    const log = await filtered(r, {
      [`runs/${RUN}/device-logcat.txt`]: 'I/agentdevice: top',
      [`runs/${RUN}/flow/device-logcat.txt`]: 'I/agentdevice: nested',
    });
    expect(log!.split('\n').sort()).toEqual(['I/agentdevice: nested', 'I/agentdevice: top']);
  });

  it('keeps the last 400 matching lines of a long log', async () => {
    const r = await rig();
    const lines = Array.from({ length: 650 }, (_, i) => `I/agentdevice: line ${String(i).padStart(3, '0')}${i % 2 ? '' : ' (even)'}`);
    const log = await filtered(r, { [`runs/${RUN}/device-logcat.txt`]: lines.join('\n') });
    const kept = log!.split('\n');
    expect(kept).toHaveLength(400);
    expect(kept[0]).toContain('line 250');
    expect(kept.at(-1)).toContain('line 649');
  });

  it('counts only matching lines toward the 400, not the other apps\' lines between them', async () => {
    const r = await rig();
    const lines = Array.from({ length: 500 }, (_, i) => [`I/agentdevice: match ${i}`, `I/Bank: filler ${i}`]).flat();
    const kept = (await filtered(r, { [`runs/${RUN}/device-logcat.txt`]: lines.join('\n') }))!.split('\n');
    expect(kept).toHaveLength(400);
    expect(kept[0]).toBe('I/agentdevice: match 100');
    expect(kept.join('\n')).not.toContain('filler');
  });
});

// ==================================================================== limits

describe('how much history goes in', () => {
  it('takes the newest three runs of a case', async () => {
    const r = await rig();
    const CASE = 'busy-20261101-0900';
    await seed(r.dir, { [`cases/${CASE}.json`]: caseFile(CASE), ...[1, 2, 3, 4, 5].reduce((all, n) => ({ ...all, ...runFiles(CASE, n) }), {}) });
    const files = await download(r);
    const summaries = [...files.keys()].filter((name) => name.endsWith('/summary.json') && name.startsWith('runs/')).sort();
    expect(summaries).toEqual([3, 4, 5].map((n) => `runs/${runId(CASE, n)}/summary.json`));
    expect(text(files, `runs/${runId(CASE, 5)}/output.txt`)).toBe(`output of ${runId(CASE, 5)}`);
    expect([...files.keys()].some((name) => name.includes(runId(CASE, 1)) || name.includes(runId(CASE, 2)))).toBe(false);
  });

  it('takes three runs from each case', async () => {
    const r = await rig();
    const A = 'a-20261101-0900';
    const B = 'b-20261101-0901';
    await seed(r.dir, {
      [`cases/${A}.json`]: caseFile(A, [], { createdAt: '2026-11-01T09:00:00.000Z' }),
      [`cases/${B}.json`]: caseFile(B, [], { createdAt: '2026-11-01T09:01:00.000Z' }),
      ...[1, 2, 3, 4].reduce((all, n) => ({ ...all, ...runFiles(A, n), ...runFiles(B, n) }), {}),
    });
    const names = [...(await download(r)).keys()].filter((name) => name.endsWith('/summary.json') && name.startsWith('runs/'));
    expect(names.filter((name) => name.includes(`runs/${A}-`))).toHaveLength(3);
    expect(names.filter((name) => name.includes(`runs/${B}-`))).toHaveLength(3);
  });

  it('stops at 30 runs in all', async () => {
    const r = await rig();
    const ids = Array.from({ length: 12 }, (_, i) => `case${String(i).padStart(2, '0')}-20261101-09${String(i).padStart(2, '0')}`);
    const files: Record<string, string> = {};
    ids.forEach((id, i) => {
      files[`cases/${id}.json`] = caseFile(id, [], { createdAt: `2026-11-01T09:${String(i).padStart(2, '0')}:00.000Z` });
      for (const n of [1, 2, 3, 4]) Object.assign(files, runFiles(id, n));
    });
    await seed(r.dir, files);
    const names = [...(await download(r)).keys()].filter((name) => name.endsWith('/summary.json') && name.startsWith('runs/'));
    expect(names).toHaveLength(30);
  });

  it('takes a case\'s runs only, not those of another case whose id begins the same', async () => {
    const r = await rig();
    const A = 'claim-20261101-0900';
    const B = `${A}-2`;
    await seed(r.dir, { [`cases/${A}.json`]: caseFile(A), ...runFiles(A, 1), ...runFiles(B, 1) });
    const names = [...(await download(r)).keys()].filter((name) => name.startsWith('runs/'));
    expect(names.every((name) => name.startsWith(`runs/${A}-2026`))).toBe(true);
    expect(names.length).toBeGreaterThan(0);
  });

  it('leaves out a run that has no summary', async () => {
    const r = await rig();
    const CASE = 'half-20261101-0900';
    await seed(r.dir, { [`cases/${CASE}.json`]: caseFile(CASE), [`runs/${runId(CASE, 1)}/output.txt`]: 'stopped early' });
    expect([...(await download(r)).keys()].some((name) => name.startsWith('runs/'))).toBe(false);
  });
});

// =================================================================== contents

describe('what goes in the zip', () => {
  it('has a README that states what is never in it', async () => {
    const r = await rig();
    const readme = text(await download(r), 'README.txt');
    expect(readme).toMatch(/Ariadne diagnostics/);
    expect(readme).toMatch(/Never in this file/);
    expect(readme).toMatch(/No serial number and no list of your apps/);
    expect(readme).toMatch(/Only there if you ticked the box/);
  });

  it('puts the app version it was given in summary.json', async () => {
    const r = await rig({ appVersion: '3.4.5-diag' });
    const summary = JSON.parse(text(await download(r), 'summary.json'));
    expect(summary.ariadne).toEqual({ version: '3.4.5-diag', screenshotsIncluded: false });
  });

  it('names the computer\'s system and the project\'s counts in summary.json, with no saved value', async () => {
    const r = await rig();
    await seed(r.dir, { '.env': `PASSWORD=${PASSWORD}\nAPI_TOKEN=${TOKEN}\n`, 'project.json': JSON.stringify({ appId: APP, platform: 'android', env: { K: 'value-from-project' } }), 'cases/c-20261101-0900.json': caseFile('c-20261101-0900') });
    const summary = JSON.parse(text(await download(r), 'summary.json'));
    expect(summary.computer).toMatchObject({ platform: process.platform, arch: process.arch, node: process.version });
    expect(summary.project).toEqual({ appId: APP, cases: 1, savedValues: 3 });
    expect(Date.parse(summary.exportedAt)).not.toBeNaN();
  });

  it('reports the tools the setup check found', async () => {
    const r = await rig({ setup: setupWith('List of devices attached\n') });
    const { tools } = JSON.parse(text(await download(r), 'summary.json'));
    expect(tools.adb).toEqual({ found: true, path: ADB });
    expect(tools.maestro).toEqual({ found: true, path: '/opt/maestro/bin/maestro' });
    expect(tools.emulator).toEqual({ found: false });
    expect(tools.java).toEqual({ found: false });
  });

  it('reports each phone adb lists, with its facts and no serial number', async () => {
    const r = await rig({ setup: setupWith(PHONES), report: async () => ({ maker: 'samsung', model: 'SM-A546B', android: '14', navigation: 'gestures', keyboardApp: 'com.samsung.android.honeyboard' }) });
    const raw = text(await download(r), 'summary.json');
    const summary = JSON.parse(raw);
    expect(summary.phones).toHaveLength(3);
    expect(summary.phones[0]).toEqual({ state: 'device', emulator: false, model: 'SM-A546B', maker: 'samsung', android: '14', navigation: 'gestures', keyboardApp: 'com.samsung.android.honeyboard' });
    expect(raw).not.toMatch(/SERIAL-/);
    for (const phone of summary.phones) expect(Object.keys(phone)).not.toContain('serial');
  });

  it('asks only phones in the "device" state for their facts', async () => {
    const r = await rig({ setup: setupWith(PHONES), report: async () => ({ maker: 'samsung' }) });
    await download(r);
    expect(r.report.mock.calls.map(([id]) => id).sort()).toEqual(['SERIAL-BROKEN-42', 'SERIAL-PHONE-R58M']);
  });

  it('lists a phone in the "unauthorized" state without asking it anything', async () => {
    const r = await rig({ setup: setupWith(PHONES), report: async () => ({ maker: 'samsung' }) });
    const { phones } = JSON.parse(text(await download(r), 'summary.json'));
    expect(phones[1]).toEqual({ state: 'unauthorized', emulator: false });
    expect(r.report).not.toHaveBeenCalledWith('SERIAL-UNAUTH-77');
  });

  it('gives "unreadable" for a phone that fails to answer, and the export still succeeds', async () => {
    const r = await rig({
      setup: setupWith(PHONES),
      report: async (id) => {
        if (id === 'SERIAL-BROKEN-42') throw new Error('adb: device offline');
        return { maker: 'samsung' };
      },
    });
    const { phones } = JSON.parse(text(await download(r), 'summary.json'));
    expect(phones[2]).toEqual({ state: 'device', emulator: false, model: 'Redmi Note 12', unreadable: 'Error: adb: device offline' });
    expect(phones[0]).toMatchObject({ maker: 'samsung' });
    expect(phones[0]).not.toHaveProperty('unreadable');
  });

  // KNOWN GAP: `unreadable` is String(error) from adb, and adb's errors name the
  // serial ("device 'X' not found"). Nothing scrubs it. Left failing on purpose.
  it('keeps the serial out of an unreadable message that names it', async () => {
    const r = await rig({
      setup: setupWith(PHONES),
      report: async (id) => {
        throw new Error(`adb: device '${id}' not found`);
      },
    });
    const files = await download(r);
    expect(leaks(files, { serial: 'SERIAL-PHONE-R58M', broken: 'SERIAL-BROKEN-42' })).toEqual([]);
  });

  it('says whether the studio is connected, and to which app', async () => {
    const r = await rig();
    expect(JSON.parse(text(await download(r), 'summary.json')).connected).toEqual({ open: false });
    await call(r, 'POST', '/api/session/open', { deviceId: 'R58M123', appId: APP });
    expect(JSON.parse(text(await download(r), 'summary.json')).connected).toEqual({ open: true, appId: APP });
  });

  it('puts the studio\'s log in log.txt, one line each, in order', async () => {
    const r = await rig();
    r.logLines.push('first line', 'second line');
    expect(text(await download(r), 'log.txt')).toBe('first line\nsecond line');
  });

  it('answers with a zip content type and an attachment filename with a timestamp', async () => {
    const r = await rig();
    const response = await r.app.inject({ method: 'GET', url: '/api/diagnostics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/zip/);
    expect(response.headers['content-disposition']).toMatch(/^attachment; filename="ariadne-diagnostics-\d{8}-\d{4}\.zip"$/);
    expect(response.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('works with no cases, no runs, no log and no device', async () => {
    const r = await rig();
    const files = await download(r);
    expect([...files.keys()].sort()).toEqual(['README.txt', 'log.txt', 'summary.json']);
    const summary = JSON.parse(text(files, 'summary.json'));
    expect(summary.phones).toEqual([]);
    expect(summary.project.cases).toBe(0);
    expect(text(files, 'log.txt')).toBe('');
  });

  it('works for a server started with no log buffer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ariadne-diag-test-'));
    roots.push(root);
    const app = await buildServer({ projectDir: join(root, 'p'), session: new PhoneDevice(), setup: NO_TOOLS, maestro: { findBin: () => '/x', androidHome: () => undefined } });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/diagnostics' });
      expect(response.statusCode).toBe(200);
      expect(readZip(response.rawPayload).get('log.txt')!.toString('utf8')).toBe('');
      expect(JSON.parse(readZip(response.rawPayload).get('summary.json')!.toString('utf8')).ariadne.version).toBe('development');
    } finally {
      await app.close();
    }
  });
});

// =================================================================== the log

describe('captureLog', () => {
  const ISO = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';

  /** Console methods replaced by spies, so the real output stays quiet and can be checked. */
  function quietConsole() {
    return { log: vi.spyOn(console, 'log').mockImplementation(() => undefined), warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined), error: vi.spyOn(console, 'error').mockImplementation(() => undefined) };
  }

  it('keeps each line with a timestamp, with WARN and ERROR marked and log left plain', () => {
    quietConsole();
    const log = captureLog();
    try {
      console.log('plain');
      console.warn('careful');
      console.error('broken');
      const [plain, warn, error] = log.lines();
      expect(plain).toMatch(new RegExp(`^${ISO} plain$`));
      expect(warn).toMatch(new RegExp(`^${ISO} WARN careful$`));
      expect(error).toMatch(new RegExp(`^${ISO} ERROR broken$`));
    } finally {
      log.stop();
    }
  });

  it('formats arguments the way console does', () => {
    quietConsole();
    const log = captureLog();
    try {
      console.log('opened %s in %d ms', 'project', 12);
      console.log('state', { a: 1 }, [2]);
      expect(log.lines()[0]).toMatch(/ opened project in 12 ms$/);
      expect(log.lines()[1]).toMatch(/ state \{ a: 1 \} \[ 2 \]$/);
    } finally {
      log.stop();
    }
  });

  it('drops the oldest lines past the limit', () => {
    quietConsole();
    const log = captureLog(3);
    try {
      for (const n of [1, 2, 3, 4, 5]) console.log(`line ${n}`);
      expect(log.lines().map((line) => line.replace(/^\S+ /, ''))).toEqual(['line 3', 'line 4', 'line 5']);
    } finally {
      log.stop();
    }
  });

  it('keeps exactly the limit when that many were logged', () => {
    quietConsole();
    const log = captureLog(3);
    try {
      for (const n of [1, 2, 3]) console.log(`line ${n}`);
      expect(log.lines()).toHaveLength(3);
    } finally {
      log.stop();
    }
  });

  it('still reaches the original console with the original arguments', () => {
    const spies = quietConsole();
    const log = captureLog();
    try {
      console.log('a %s', 'b', 3);
      console.warn('w');
      console.error('e', { x: 1 });
      expect(spies.log).toHaveBeenCalledWith('a %s', 'b', 3);
      expect(spies.warn).toHaveBeenCalledWith('w');
      expect(spies.error).toHaveBeenCalledWith('e', { x: 1 });
    } finally {
      log.stop();
    }
  });

  it('restores the console on stop, and keeps nothing after it', () => {
    const spies = quietConsole();
    const log = captureLog();
    expect(console.log).not.toBe(spies.log);
    console.log('during');
    log.stop();
    expect(console.log).toBe(spies.log);
    expect(console.warn).toBe(spies.warn);
    expect(console.error).toBe(spies.error);
    console.log('after');
    console.error('after');
    expect(log.lines()).toHaveLength(1);
  });

  it('hands out a copy of its lines', () => {
    quietConsole();
    const log = captureLog();
    try {
      console.log('one');
      log.lines().push('injected');
      log.lines().length = 0;
      expect(log.lines()).toHaveLength(1);
    } finally {
      log.stop();
    }
  });

  it('reaches the zip through a real studio\'s request log', async () => {
    quietConsole();
    const log = captureLog();
    try {
      const root = await mkdtemp(join(tmpdir(), 'ariadne-diag-test-'));
      roots.push(root);
      const app = await buildServer({ projectDir: join(root, 'p'), session: new PhoneDevice(), setup: NO_TOOLS, maestro: { findBin: () => '/x', androidHome: () => undefined }, log });
      try {
        await app.inject({ method: 'GET', url: '/api/setup' });
        const response = await app.inject({ method: 'GET', url: '/api/diagnostics' });
        expect(readZip(response.rawPayload).get('log.txt')!.toString('utf8')).toMatch(/\[studio\] GET \/api\/setup 200 \d+ms/);
      } finally {
        await app.close();
      }
    } finally {
      log.stop();
    }
  });
});
