// What the device setup guide checks: the Android tools, Maestro, Java, the
// devices adb sees (including phones that have not allowed USB debugging yet,
// which agent-device's device list leaves out) and the emulators that exist.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { readXiaomiPhone } from '@ariadne/core';
import type { AdbDevice, SetupInfo, ToolCheck } from '../shared/api-types.ts';
import { HttpError } from './common.ts';

/** The parts of the operating system the checks use; tests substitute fakes. */
export type SetupTools = {
  /** Runs a program to completion; rejects when it cannot start, fails or times out. */
  exec: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** Starts a program that outlives the request, such as the emulator. */
  spawnDetached: (file: string, args: string[]) => void;
  androidHome: () => string | undefined;
  /** Path of the Maestro CLI; throws when it is not installed. */
  findMaestro: () => string;
  platform: NodeJS.Platform;
  /** PATH, to find programs that are not in the Android SDK. */
  path: string;
  exists: (path: string) => boolean;
};

const EXEC_TIMEOUT_MS = 10_000;

export function defaultSetupTools(androidHome: () => string | undefined, findMaestro: () => string): SetupTools {
  return {
    exec: (file, args) =>
      new Promise((resolvePromise, reject) => {
        execFile(file, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
          if (error) reject(error);
          else resolvePromise({ stdout, stderr });
        });
      }),
    spawnDetached: (file, args) => {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
      // A failed start surfaces as the emulator never appearing; it must not crash the server.
      child.on('error', () => undefined);
      child.unref();
    },
    androidHome,
    findMaestro,
    platform: process.platform,
    path: process.env.PATH ?? '',
    exists: existsSync,
  };
}

function osName(platform: NodeJS.Platform): SetupInfo['os'] {
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'windows';
  return 'other';
}

/** A program in the Android SDK (`sdkDir/name`), else on PATH. */
function findProgram(tools: SetupTools, sdkDir: string, name: string): string | undefined {
  const file = tools.platform === 'win32' ? `${name}.exe` : name;
  const home = tools.androidHome();
  const candidates = home ? [join(home, sdkDir, file)] : [];
  for (const dir of tools.path.split(delimiter)) {
    if (dir) candidates.push(join(dir, file));
  }
  return candidates.find((candidate) => tools.exists(candidate));
}

/**
 * Parses `adb devices -l`. A line is the serial, the state and key:value
 * details; the "no permissions" state of a Linux phone without a udev rule
 * runs on as a sentence, so it is matched before splitting.
 */
export function parseAdbDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) continue;
    const [serial, ...rest] = line.split(/\s+/);
    if (!serial || rest.length === 0) continue;
    const details = rest.join(' ');
    const state = details.startsWith('no permissions') ? 'no permissions' : rest[0]!;
    const model = /\bmodel:(\S+)/.exec(details)?.[1];
    devices.push({
      serial,
      state,
      ...(model ? { model: model.replace(/_/g, ' ') } : {}),
      emulator: serial.startsWith('emulator-'),
    });
  }
  return devices;
}

/** `java -version` prints to stderr: `openjdk version "17.0.12" ...` or, for Java 8, `java version "1.8.0_281"`. */
export function parseJavaVersion(output: string): { version: string; major: number } | undefined {
  const version = /version "([^"]+)"/.exec(output)?.[1];
  if (!version) return undefined;
  const parts = version.split(/[._-]/).map(Number);
  const major = parts[0] === 1 ? parts[1] : parts[0];
  return major !== undefined && Number.isFinite(major) ? { version, major } : undefined;
}

/** `emulator -list-avds` prints one name per line, sometimes after INFO or WARNING lines. */
export function parseAvdList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9._-]+$/.test(line));
}

async function checkJava(tools: SetupTools): Promise<SetupInfo['java']> {
  try {
    const { stdout, stderr } = await tools.exec('java', ['-version']);
    const parsed = parseJavaVersion(`${stderr}\n${stdout}`);
    return parsed ? { found: true, version: parsed.version, major: parsed.major } : { found: true };
  } catch {
    return { found: false };
  }
}

function checkMaestro(tools: SetupTools): ToolCheck {
  try {
    return { found: true, path: tools.findMaestro() };
  } catch {
    return { found: false };
  }
}

async function listAvds(tools: SetupTools, emulator: string | undefined): Promise<string[]> {
  if (!emulator) return [];
  try {
    return parseAvdList((await tools.exec(emulator, ['-list-avds'])).stdout);
  } catch {
    return [];
  }
}

async function listAdbDevices(tools: SetupTools, adb: string | undefined): Promise<AdbDevice[]> {
  if (!adb) return [];
  let devices: AdbDevice[];
  try {
    devices = parseAdbDevices((await tools.exec(adb, ['devices', '-l'])).stdout);
  } catch {
    return [];
  }
  // Which virtual device each running emulator is, so the guide does not offer to start it again.
  // Xiaomi's phones need a step of their own before Run works.
  return Promise.all(
    devices.map(async (device) => {
      if (device.state !== 'device') return device;
      if (!device.emulator) {
        try {
          const shell = async (args: string[]) => (await tools.exec(adb, ['-s', device.serial, 'shell', ...args])).stdout;
          const xiaomi = await readXiaomiPhone(shell);
          return xiaomi ? { ...device, xiaomi: { driverOpensApps: xiaomi.driverOpensApps } } : device;
        } catch {
          return device;
        }
      }
      try {
        const avd = (await tools.exec(adb, ['-s', device.serial, 'emu', 'avd', 'name'])).stdout.split(/\r?\n/)[0]?.trim();
        return avd && avd !== 'OK' ? { ...device, avd } : device;
      } catch {
        return device;
      }
    }),
  );
}

export async function checkSetup(tools: SetupTools): Promise<SetupInfo> {
  const adb = findProgram(tools, 'platform-tools', 'adb');
  const emulator = findProgram(tools, 'emulator', 'emulator');
  const [java, avds, devices] = await Promise.all([checkJava(tools), listAvds(tools, emulator), listAdbDevices(tools, adb)]);
  return {
    os: osName(tools.platform),
    adb: adb ? { found: true, path: adb } : { found: false },
    emulator: emulator ? { found: true, path: emulator } : { found: false },
    maestro: checkMaestro(tools),
    java,
    avds,
    devices,
  };
}

export function registerSetupRoutes(app: FastifyInstance, tools: SetupTools): void {
  app.get('/api/setup', async (): Promise<SetupInfo> => checkSetup(tools));

  /** Starts an emulator the user created in Android Studio; only names `emulator -list-avds` returns are accepted. */
  app.post('/api/setup/emulator', async (request) => {
    const name = ((request.body ?? {}) as { name?: unknown }).name;
    if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'BAD_REQUEST', 'Expected the "name" of an emulator.');
    const emulator = findProgram(tools, 'emulator', 'emulator');
    if (!emulator) {
      throw new HttpError(409, 'NO_EMULATOR', 'The Android emulator is not installed. Install Android Studio, or set ANDROID_HOME to your Android SDK.');
    }
    const avds = await listAvds(tools, emulator);
    if (!avds.includes(name)) throw new HttpError(404, 'UNKNOWN_EMULATOR', `There is no emulator called ${name} on this computer.`);
    tools.spawnDetached(emulator, ['-avd', name]);
    return { ok: true, name };
  });
}
