// The device setup guide's checks. Every program the checks would run (adb,
// java, the emulator) goes through SetupTools, so these tests hand in fakes and
// never start a real one.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceLike } from '../src/server/state.ts';
import { buildServer } from '../src/server/index.ts';
import {
  checkSetup,
  defaultSetupTools,
  parseAdbDevices,
  parseAvdList,
  parseJavaVersion,
  type SetupTools,
} from '../src/server/setup.ts';
import type { SetupInfo } from '../src/shared/api-types.ts';

describe('parseAdbDevices', () => {
  it('returns nothing for empty output, only the header or only daemon noise', () => {
    expect(parseAdbDevices('')).toEqual([]);
    expect(parseAdbDevices('\n\n')).toEqual([]);
    expect(parseAdbDevices('List of devices attached\n\n')).toEqual([]);
    expect(parseAdbDevices('* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\n')).toEqual([]);
  });

  it('parses a ready emulator and turns the underscores of its model into spaces', () => {
    const output = [
      'List of devices attached',
      'emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1',
      '',
    ].join('\n');
    expect(parseAdbDevices(output)).toStrictEqual([
      { serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 x86 64', emulator: true },
    ]);
  });

  it('parses a phone that has not allowed USB debugging, without a model', () => {
    const output = 'List of devices attached\nR58M123ABC            unauthorized usb:1-1 transport_id:2\n';
    expect(parseAdbDevices(output)).toStrictEqual([{ serial: 'R58M123ABC', state: 'unauthorized', emulator: false }]);
  });

  it('parses offline devices', () => {
    expect(parseAdbDevices('0123456789ABCDEF       offline usb:1-2 transport_id:3\n')).toStrictEqual([
      { serial: '0123456789ABCDEF', state: 'offline', emulator: false },
    ]);
    expect(parseAdbDevices('emulator-5556\toffline\n')).toStrictEqual([{ serial: 'emulator-5556', state: 'offline', emulator: true }]);
  });

  it('reads the Linux "no permissions" sentence as one state', () => {
    const output = [
      'List of devices attached',
      'HT7A41A01234           no permissions (user in plugdev group; are your udev rules wrong?); see [http://developer.android.com/tools/device.html] usb:1-3 transport_id:4',
      '',
    ].join('\n');
    expect(parseAdbDevices(output)).toStrictEqual([{ serial: 'HT7A41A01234', state: 'no permissions', emulator: false }]);
  });

  it('reads the model of a phone and understands output without -l', () => {
    expect(parseAdbDevices('R58M123ABC device usb:1-1 product:a52q model:SM_A525F device:a52q transport_id:5\n')).toStrictEqual([
      { serial: 'R58M123ABC', state: 'device', model: 'SM A525F', emulator: false },
    ]);
    expect(parseAdbDevices('List of devices attached\nR58M123ABC\tdevice\n')).toStrictEqual([
      { serial: 'R58M123ABC', state: 'device', emulator: false },
    ]);
  });

  it('parses a mixed listing with a header, daemon lines, blank lines and CRLF line endings', () => {
    const output = [
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      'List of devices attached',
      'emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1',
      '',
      'R58M123ABC             unauthorized usb:1-1 transport_id:2',
      '   ',
      '0123456789ABCDEF       offline usb:1-2 transport_id:3',
      'HT7A41A01234           no permissions (user in plugdev group; are your udev rules wrong?); see [http://developer.android.com/tools/device.html] usb:1-3 transport_id:4',
      '',
      '',
    ].join('\r\n');
    expect(parseAdbDevices(output)).toStrictEqual([
      { serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 x86 64', emulator: true },
      { serial: 'R58M123ABC', state: 'unauthorized', emulator: false },
      { serial: '0123456789ABCDEF', state: 'offline', emulator: false },
      { serial: 'HT7A41A01234', state: 'no permissions', emulator: false },
    ]);
  });

  it('skips a line with a serial and nothing else', () => {
    expect(parseAdbDevices('List of devices attached\nlonely\n')).toEqual([]);
  });
});

describe('parseJavaVersion', () => {
  it('reads an OpenJDK 17 banner', () => {
    expect(parseJavaVersion('openjdk version "17.0.12" 2024-07-16\nOpenJDK Runtime Environment (build 17.0.12+7)\n')).toEqual({
      version: '17.0.12',
      major: 17,
    });
  });

  it('reads a version without minor parts', () => {
    expect(parseJavaVersion('openjdk version "21" 2023-09-19')).toEqual({ version: '21', major: 21 });
  });

  it('reads Java 8 as major 8, not 1', () => {
    expect(parseJavaVersion('java version "1.8.0_281"\nJava(TM) SE Runtime Environment (build 1.8.0_281-b09)')).toEqual({
      version: '1.8.0_281',
      major: 8,
    });
  });

  it('reads early access and LTS banners', () => {
    expect(parseJavaVersion('openjdk version "22-ea" 2024-03-19')).toEqual({ version: '22-ea', major: 22 });
    expect(parseJavaVersion('openjdk version "11.0.21" 2023-10-17 LTS')).toEqual({ version: '11.0.21', major: 11 });
  });

  it('finds the banner after other lines the JVM prints first', () => {
    expect(parseJavaVersion('Picked up JAVA_TOOL_OPTIONS: -Xmx512m\nopenjdk version "17.0.12" 2024-07-16\n')).toEqual({
      version: '17.0.12',
      major: 17,
    });
  });

  it('returns undefined for output that is not a version banner', () => {
    expect(parseJavaVersion('')).toBeUndefined();
    expect(parseJavaVersion('bash: java: command not found')).toBeUndefined();
    expect(parseJavaVersion('Unrecognized option: -version')).toBeUndefined();
    expect(parseJavaVersion('openjdk version ""')).toBeUndefined();
    expect(parseJavaVersion('openjdk version "unknown"')).toBeUndefined();
  });
});

describe('parseAvdList', () => {
  it('returns the names, one per line', () => {
    expect(parseAvdList('e2e_tool_dev\nPixel_7_API_34\n')).toEqual(['e2e_tool_dev', 'Pixel_7_API_34']);
  });

  it('skips INFO and WARNING lines and blank lines', () => {
    const output = [
      'INFO    | Storing crashdata in: /tmp/android-user/emu-crash-34.1.20.db, detection is enabled for process: 4242',
      'e2e_tool_dev',
      'WARNING | Unable to open /home/dev/.android/avd/old.avd/config.ini',
      '',
      'Pixel_7_API_34',
      'INFO    | Emulator ready',
      '',
    ].join('\n');
    expect(parseAvdList(output)).toEqual(['e2e_tool_dev', 'Pixel_7_API_34']);
  });

  it('handles CRLF line endings and keeps dots and hyphens in names', () => {
    expect(parseAvdList('Pixel-6.Pro_API-33\r\nWear_OS_Round\r\n')).toEqual(['Pixel-6.Pro_API-33', 'Wear_OS_Round']);
  });

  it('returns nothing when there are no virtual devices', () => {
    expect(parseAvdList('')).toEqual([]);
    expect(parseAvdList('INFO    | nothing here\n')).toEqual([]);
  });
});

// A complete SetupTools whose programs are scripts: `exec` answers the command
// lines in `replies` and rejects any other, as a missing program would.
const SDK = join('/home', 'dev', 'Android', 'Sdk');
const ADB = join(SDK, 'platform-tools', 'adb');
const EMULATOR = join(SDK, 'emulator', 'emulator');

type Reply = string | { stdout?: string; stderr?: string } | Error;

type FakeOptions = {
  home?: string | undefined;
  platform?: NodeJS.Platform;
  path?: string;
  /** Paths `exists` says are there. */
  files?: string[];
  /** Command line ("file arg arg") to what exec does with it. */
  replies?: Record<string, Reply>;
  maestro?: string | Error;
};

type FakeTools = SetupTools & { exec: ReturnType<typeof vi.fn<SetupTools['exec']>>; spawnDetached: ReturnType<typeof vi.fn<SetupTools['spawnDetached']>> };

function fakeTools(options: FakeOptions = {}): FakeTools {
  const { platform = 'linux', path = '', files = [ADB, EMULATOR], replies = {}, maestro = '/opt/maestro/bin/maestro' } = options;
  // `home: undefined` means "no Android home", so it must not fall back to the default.
  const home = 'home' in options ? options.home : SDK;
  const exec = vi.fn<SetupTools['exec']>(async (file, args) => {
    const reply = replies[[file, ...args].join(' ')];
    if (reply === undefined) throw new Error(`spawn ${file} ENOENT`);
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'string') return { stdout: reply, stderr: '' };
    return { stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
  });
  return {
    exec,
    spawnDetached: vi.fn<SetupTools['spawnDetached']>(),
    androidHome: () => home,
    findMaestro: () => {
      if (maestro instanceof Error) throw maestro;
      return maestro;
    },
    platform,
    path,
    exists: (candidate) => files.includes(candidate),
  };
}

const JAVA_17 = { stdout: '', stderr: 'openjdk version "17.0.12" 2024-07-16\nOpenJDK Runtime Environment (build 17.0.12+7)\n' };
const ADB_LIST = `List of devices attached\r\nemulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1\r\n\r\n`;

/** Replies for a computer where everything is installed and one emulator runs. */
function healthyReplies(): Record<string, Reply> {
  return {
    'java -version': JAVA_17,
    [`${ADB} devices -l`]: ADB_LIST,
    [`${ADB} -s emulator-5554 emu avd name`]: 'e2e_tool_dev\r\nOK\r\n',
    [`${EMULATOR} -list-avds`]: 'INFO    | Storing crashdata in: /tmp/emu.db\ne2e_tool_dev\nPixel_7_API_34\n',
  };
}

describe('checkSetup', () => {
  it('reports every tool, the emulators and the running device on a healthy computer', async () => {
    const tools = fakeTools({ replies: healthyReplies() });
    expect(await checkSetup(tools)).toEqual({
      os: 'linux',
      adb: { found: true, path: ADB },
      emulator: { found: true, path: EMULATOR },
      maestro: { found: true, path: '/opt/maestro/bin/maestro' },
      java: { found: true, version: '17.0.12', major: 17 },
      avds: ['e2e_tool_dev', 'Pixel_7_API_34'],
      devices: [{ serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 x86 64', emulator: true, avd: 'e2e_tool_dev' }],
    } satisfies SetupInfo);
  });

  describe('finding adb and the emulator', () => {
    it('looks for them under the Android home, platform-tools/adb and emulator/emulator', async () => {
      const exists = vi.fn((candidate: string) => candidate === ADB || candidate === EMULATOR);
      const info = await checkSetup({ ...fakeTools({ replies: healthyReplies() }), exists });
      expect(info.adb).toEqual({ found: true, path: join(SDK, 'platform-tools', 'adb') });
      expect(info.emulator).toEqual({ found: true, path: join(SDK, 'emulator', 'emulator') });
      expect(exists).toHaveBeenCalledWith(join(SDK, 'platform-tools', 'adb'));
      expect(exists).toHaveBeenCalledWith(join(SDK, 'emulator', 'emulator'));
    });

    it('finds them on PATH when there is no Android home', async () => {
      const bin = join('/usr', 'local', 'bin');
      const tools = fakeTools({
        home: undefined,
        path: ['/usr/bin', bin].join(delimiter),
        files: [join(bin, 'adb'), join(bin, 'emulator')],
        replies: {
          'java -version': JAVA_17,
          [`${join(bin, 'adb')} devices -l`]: 'List of devices attached\nR58M123ABC device usb:1-1 model:Pixel_8\n',
          [`${join(bin, 'emulator')} -list-avds`]: 'e2e_tool_dev\n',
        },
      });
      const info = await checkSetup(tools);
      expect(info.adb).toEqual({ found: true, path: join(bin, 'adb') });
      expect(info.emulator).toEqual({ found: true, path: join(bin, 'emulator') });
      expect(info.avds).toEqual(['e2e_tool_dev']);
      expect(info.devices).toEqual([{ serial: 'R58M123ABC', state: 'device', model: 'Pixel 8', emulator: false }]);
    });

    it('falls back to PATH when the Android home does not have the program', async () => {
      const bin = join('/opt', 'platform-tools');
      const info = await checkSetup(fakeTools({ path: bin, files: [join(bin, 'adb')], replies: {} }));
      expect(info.adb).toEqual({ found: true, path: join(bin, 'adb') });
      expect(info.emulator).toEqual({ found: false });
    });

    it('prefers the Android home over PATH', async () => {
      const bin = join('/usr', 'bin');
      const info = await checkSetup(fakeTools({ path: bin, files: [ADB, join(bin, 'adb'), EMULATOR, join(bin, 'emulator')], replies: healthyReplies() }));
      expect(info.adb.path).toBe(ADB);
      expect(info.emulator.path).toBe(EMULATOR);
    });

    it('skips empty PATH entries', async () => {
      const exists = vi.fn(() => false);
      await checkSetup({ ...fakeTools({ home: undefined, path: `${delimiter}${delimiter}` }), exists });
      expect(exists).not.toHaveBeenCalled();
    });

    it('reports them as not found, and runs neither, when they are nowhere', async () => {
      const tools = fakeTools({ home: undefined, path: '/usr/bin', files: [], replies: { 'java -version': JAVA_17 } });
      const info = await checkSetup(tools);
      expect(info.adb).toEqual({ found: false });
      expect(info.emulator).toEqual({ found: false });
      expect(info.avds).toEqual([]);
      expect(info.devices).toEqual([]);
      expect(tools.exec.mock.calls.map(([file]) => file)).toEqual(['java']);
    });

    it('adds .exe on Windows', async () => {
      const adb = join(SDK, 'platform-tools', 'adb.exe');
      const emulator = join(SDK, 'emulator', 'emulator.exe');
      const tools = fakeTools({
        platform: 'win32',
        files: [adb, emulator],
        replies: { [`${adb} devices -l`]: 'List of devices attached\n', [`${emulator} -list-avds`]: 'e2e_tool_dev\r\n' },
      });
      const info = await checkSetup(tools);
      expect(info.os).toBe('windows');
      expect(info.adb).toEqual({ found: true, path: adb });
      expect(info.emulator).toEqual({ found: true, path: emulator });
      expect(info.avds).toEqual(['e2e_tool_dev']);
    });

    it('does not find the extensionless program on Windows', async () => {
      const info = await checkSetup(fakeTools({ platform: 'win32', files: [ADB, EMULATOR] }));
      expect(info.adb).toEqual({ found: false });
      expect(info.emulator).toEqual({ found: false });
    });
  });

  describe('Maestro and Java', () => {
    it('reports Maestro as not found when looking for it throws', async () => {
      const info = await checkSetup(fakeTools({ maestro: new Error('Maestro is not installed'), replies: healthyReplies() }));
      expect(info.maestro).toEqual({ found: false });
      expect(info.adb.found).toBe(true);
    });

    it('reports Java as not found when running it fails', async () => {
      const replies = { ...healthyReplies(), 'java -version': new Error('spawn java ENOENT') };
      const info = await checkSetup(fakeTools({ replies }));
      expect(info.java).toEqual({ found: false });
    });

    it('reports Java as found, without a version, when the banner cannot be read', async () => {
      const info = await checkSetup(fakeTools({ replies: { ...healthyReplies(), 'java -version': { stderr: 'something unexpected' } } }));
      expect(info.java).toEqual({ found: true });
    });

    it('reads Java 8 as major 8', async () => {
      const info = await checkSetup(fakeTools({ replies: { ...healthyReplies(), 'java -version': { stderr: 'java version "1.8.0_281"\n' } } }));
      expect(info.java).toEqual({ found: true, version: '1.8.0_281', major: 8 });
    });

    it('reads the banner from stdout too', async () => {
      const info = await checkSetup(fakeTools({ replies: { ...healthyReplies(), 'java -version': { stdout: 'openjdk version "21" 2023-09-19\n' } } }));
      expect(info.java).toEqual({ found: true, version: '21', major: 21 });
    });
  });

  describe('devices and emulators', () => {
    it('asks a running emulator which virtual device it is, with adb -s <serial> emu avd name', async () => {
      const tools = fakeTools({ replies: healthyReplies() });
      const info = await checkSetup(tools);
      expect(tools.exec).toHaveBeenCalledWith(ADB, ['-s', 'emulator-5554', 'emu', 'avd', 'name']);
      expect(info.devices[0]?.avd).toBe('e2e_tool_dev');
    });

    it('asks only about emulators that are ready', async () => {
      const listing = [
        'List of devices attached',
        'emulator-5554 device model:sdk_gphone64_x86_64',
        'emulator-5556 offline',
        'R58M123ABC device usb:1-1 model:Pixel_8',
        'HT7A41A01234 unauthorized usb:1-3',
        '',
      ].join('\n');
      const tools = fakeTools({
        replies: { ...healthyReplies(), [`${ADB} devices -l`]: listing },
      });
      const info = await checkSetup(tools);
      const asked = tools.exec.mock.calls.filter(([, args]) => args.includes('emu'));
      expect(asked).toEqual([[ADB, ['-s', 'emulator-5554', 'emu', 'avd', 'name']]]);
      expect(info.devices.map((device) => [device.serial, device.state, device.avd])).toEqual([
        ['emulator-5554', 'device', 'e2e_tool_dev'],
        ['emulator-5556', 'offline', undefined],
        ['R58M123ABC', 'device', undefined],
        ['HT7A41A01234', 'unauthorized', undefined],
      ]);
    });

    it('names each of several running emulators', async () => {
      const listing = 'List of devices attached\nemulator-5554 device\nemulator-5556 device\n';
      const info = await checkSetup(
        fakeTools({
          replies: {
            ...healthyReplies(),
            [`${ADB} devices -l`]: listing,
            [`${ADB} -s emulator-5554 emu avd name`]: 'e2e_tool_dev\r\nOK\r\n',
            [`${ADB} -s emulator-5556 emu avd name`]: 'Pixel_7_API_34\r\nOK\r\n',
          },
        }),
      );
      expect(info.devices.map((device) => device.avd)).toEqual(['e2e_tool_dev', 'Pixel_7_API_34']);
    });

    it('keeps the device, without an avd, when the name cannot be read', async () => {
      const failing = await checkSetup(fakeTools({ replies: { ...healthyReplies(), [`${ADB} -s emulator-5554 emu avd name`]: new Error('timed out') } }));
      expect(failing.devices).toEqual([{ serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 x86 64', emulator: true }]);
      const onlyOk = await checkSetup(fakeTools({ replies: { ...healthyReplies(), [`${ADB} -s emulator-5554 emu avd name`]: 'OK\r\n' } }));
      expect(onlyOk.devices[0]).not.toHaveProperty('avd');
      const empty = await checkSetup(fakeTools({ replies: { ...healthyReplies(), [`${ADB} -s emulator-5554 emu avd name`]: '' } }));
      expect(empty.devices[0]).not.toHaveProperty('avd');
    });

    it('reports no devices when adb devices fails, and still lists the emulators', async () => {
      const info = await checkSetup(fakeTools({ replies: { ...healthyReplies(), [`${ADB} devices -l`]: new Error('adb server is out of date') } }));
      expect(info.devices).toEqual([]);
      expect(info.avds).toEqual(['e2e_tool_dev', 'Pixel_7_API_34']);
    });

    it('reports no emulators when listing them fails, and still lists the devices', async () => {
      const info = await checkSetup(fakeTools({ replies: { ...healthyReplies(), [`${EMULATOR} -list-avds`]: new Error('emulator crashed') } }));
      expect(info.avds).toEqual([]);
      expect(info.devices).toHaveLength(1);
    });

    it('checks the phone that needs USB debugging, so the guide can tell the user to allow it', async () => {
      const info = await checkSetup(
        fakeTools({ replies: { ...healthyReplies(), [`${ADB} devices -l`]: 'List of devices attached\nR58M123ABC unauthorized usb:1-1 transport_id:2\n' } }),
      );
      expect(info.devices).toEqual([{ serial: 'R58M123ABC', state: 'unauthorized', emulator: false }]);
    });
  });

  describe('os', () => {
    it.each([
      ['linux', 'linux'],
      ['darwin', 'mac'],
      ['win32', 'windows'],
      ['freebsd', 'other'],
      ['aix', 'other'],
    ] as const)('maps %s to %s', async (platform, os) => {
      expect((await checkSetup(fakeTools({ platform, files: [] }))).os).toBe(os);
    });
  });

  it('never runs anything it was not given, and runs nothing detached', async () => {
    const tools = fakeTools({ replies: healthyReplies() });
    await checkSetup(tools);
    expect(tools.spawnDetached).not.toHaveBeenCalled();
    const commands = tools.exec.mock.calls.map(([file, args]) => [file, ...args].join(' ')).sort();
    expect(commands).toEqual(
      [
        'java -version',
        `${ADB} devices -l`,
        `${ADB} -s emulator-5554 emu avd name`,
        `${EMULATOR} -list-avds`,
      ].sort(),
    );
  });
});

describe('defaultSetupTools', () => {
  it('uses the Android home and Maestro finders it is given, and the host platform and PATH', () => {
    const tools = defaultSetupTools(() => '/sdk', () => '/maestro');
    expect(tools.androidHome()).toBe('/sdk');
    expect(tools.findMaestro()).toBe('/maestro');
    expect(tools.platform).toBe(process.platform);
    expect(tools.path).toBe(process.env.PATH ?? '');
  });

  it('exec resolves with stdout and stderr, and rejects on a failing exit or a missing program', async () => {
    const tools = defaultSetupTools(() => undefined, () => '');
    const ok = await tools.exec(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err")']);
    expect(ok).toEqual({ stdout: 'out', stderr: 'err' });
    await expect(tools.exec(process.execPath, ['-e', 'process.exit(3)'])).rejects.toThrow();
    await expect(tools.exec(join(tmpdir(), 'ariadne-no-such-program'), [])).rejects.toThrow();
  });

  it('spawnDetached does not throw or crash when the program cannot start', async () => {
    const tools = defaultSetupTools(() => undefined, () => '');
    expect(() => tools.spawnDetached(join(tmpdir(), 'ariadne-no-such-emulator'), ['-avd', 'x'])).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});

// The routes, through the real server so the error bodies and the `setup`
// option of buildServer are covered too.
const unusedDevice = (): DeviceLike => {
  const unused = async (): Promise<never> => {
    throw new Error('The device is not used by the setup routes');
  };
  return {
    isOpen: false,
    deviceId: undefined,
    appId: undefined,
    listDevices: unused,
    snapshot: unused,
    capture: unused,
    tapAt: unused,
    typeText: unused,
    back: unused,
    scroll: unused,
    replayFlow: unused,
    close: unused,
    relaunchApp: unused,
    openLink: unused,
    hideKeyboard: unused,
    longPressAt: unused,
    doubleTapAt: unused,
    swipe: unused,
    pinch: unused,
    pressKey: unused,
    setOrientation: unused,
    open: unused,
  };
};

describe('setup routes', () => {
  let dir: string;
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ariadne-setup-test-'));
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function serve(tools: SetupTools): Promise<FastifyInstance> {
    app = await buildServer({ projectDir: dir, session: unusedDevice(), setup: tools });
    return app;
  }

  async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
    const response = await app!.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: response.statusCode, body: response.json() };
  }

  describe('GET /api/setup', () => {
    it('returns what checkSetup finds', async () => {
      const tools = fakeTools({ replies: healthyReplies() });
      await serve(tools);
      const { status, body } = await call('GET', '/api/setup');
      expect(status).toBe(200);
      expect(body).toEqual({
        os: 'linux',
        adb: { found: true, path: ADB },
        emulator: { found: true, path: EMULATOR },
        maestro: { found: true, path: '/opt/maestro/bin/maestro' },
        java: { found: true, version: '17.0.12', major: 17 },
        avds: ['e2e_tool_dev', 'Pixel_7_API_34'],
        devices: [{ serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 x86 64', emulator: true, avd: 'e2e_tool_dev' }],
      });
    });

    it('checks again on every request', async () => {
      const tools = fakeTools({ replies: healthyReplies() });
      await serve(tools);
      expect((await call('GET', '/api/setup')).body.devices).toHaveLength(1);
      tools.exec.mockImplementation(async (file, args) => {
        if (args.join(' ') === 'devices -l') return { stdout: 'List of devices attached\n', stderr: '' };
        throw new Error(`spawn ${file} ENOENT`);
      });
      expect((await call('GET', '/api/setup')).body.devices).toEqual([]);
    });

    it('answers 200 with everything missing on a bare computer', async () => {
      await serve(fakeTools({ home: undefined, path: '', files: [], maestro: new Error('no maestro'), platform: 'darwin' }));
      const { status, body } = await call('GET', '/api/setup');
      expect(status).toBe(200);
      expect(body).toEqual({
        os: 'mac',
        adb: { found: false },
        emulator: { found: false },
        maestro: { found: false },
        java: { found: false },
        avds: [],
        devices: [],
      });
    });
  });

  describe('POST /api/setup/emulator', () => {
    it('answers 400 when there is no name', async () => {
      const tools = fakeTools({ replies: healthyReplies() });
      await serve(tools);
      for (const payload of [undefined, {}, { name: '' }, { name: '   ' }, { name: 5 }, { name: null }, { name: ['e2e_tool_dev'] }]) {
        const response = await call('POST', '/api/setup/emulator', payload);
        expect(response, JSON.stringify(payload)).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
      }
      expect(tools.spawnDetached).not.toHaveBeenCalled();
    });

    it('answers 404 for a name that -list-avds does not return', async () => {
      const tools = fakeTools({ replies: healthyReplies() });
      await serve(tools);
      const response = await call('POST', '/api/setup/emulator', { name: 'Nexus_5_API_21' });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('UNKNOWN_EMULATOR');
      expect(response.body.error.message).toContain('Nexus_5_API_21');
      // The name must match exactly; nothing is trimmed or case-folded.
      expect((await call('POST', '/api/setup/emulator', { name: 'E2E_TOOL_DEV' })).status).toBe(404);
      expect((await call('POST', '/api/setup/emulator', { name: ' e2e_tool_dev' })).status).toBe(404);
      expect((await call('POST', '/api/setup/emulator', { name: '-wipe-data' })).status).toBe(404);
      expect(tools.spawnDetached).not.toHaveBeenCalled();
    });

    it('answers 404 when the emulator lists no virtual devices at all', async () => {
      const tools = fakeTools({ replies: { ...healthyReplies(), [`${EMULATOR} -list-avds`]: '' } });
      await serve(tools);
      expect((await call('POST', '/api/setup/emulator', { name: 'e2e_tool_dev' })).status).toBe(404);
      expect(tools.spawnDetached).not.toHaveBeenCalled();
    });

    it('answers 409 when there is no emulator program, without running anything', async () => {
      const tools = fakeTools({ home: undefined, path: '/usr/bin', files: [], replies: healthyReplies() });
      await serve(tools);
      const response = await call('POST', '/api/setup/emulator', { name: 'e2e_tool_dev' });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('NO_EMULATOR');
      expect(tools.exec).not.toHaveBeenCalled();
      expect(tools.spawnDetached).not.toHaveBeenCalled();
    });

    it('checks the name before looking for the program', async () => {
      await serve(fakeTools({ files: [] }));
      expect((await call('POST', '/api/setup/emulator', {})).status).toBe(400);
    });

    it('starts the emulator with -avd <name> and answers { ok, name }', async () => {
      const tools = fakeTools({ replies: healthyReplies() });
      await serve(tools);
      const response = await call('POST', '/api/setup/emulator', { name: 'e2e_tool_dev' });
      expect(response).toEqual({ status: 200, body: { ok: true, name: 'e2e_tool_dev' } });
      expect(tools.spawnDetached).toHaveBeenCalledTimes(1);
      expect(tools.spawnDetached).toHaveBeenCalledWith(EMULATOR, ['-avd', 'e2e_tool_dev']);
    });

    it('uses the emulator found on PATH, and .exe on Windows', async () => {
      const bin = join('/sdk', 'emulator');
      const emulator = join(bin, 'emulator.exe');
      const tools = fakeTools({
        platform: 'win32',
        home: undefined,
        path: bin,
        files: [emulator],
        replies: { [`${emulator} -list-avds`]: 'Pixel_7_API_34\r\n' },
      });
      await serve(tools);
      expect((await call('POST', '/api/setup/emulator', { name: 'Pixel_7_API_34' })).body).toEqual({ ok: true, name: 'Pixel_7_API_34' });
      expect(tools.spawnDetached).toHaveBeenCalledWith(emulator, ['-avd', 'Pixel_7_API_34']);
    });

    it('lists the virtual devices with -list-avds before starting one', async () => {
      const tools = fakeTools({ replies: healthyReplies() });
      await serve(tools);
      await call('POST', '/api/setup/emulator', { name: 'Pixel_7_API_34' });
      expect(tools.exec).toHaveBeenCalledWith(EMULATOR, ['-list-avds']);
    });
  });
});
