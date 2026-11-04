// Maestro's Android driver is two APKs inside the jar the CLI runs from.
// Maestro installs them for a run and removes them afterwards, unless it is
// told --no-reinstall-driver, which also means it will not install them at
// all: with none on the phone it dies with "Device server died". A phone that
// must keep the driver therefore gets it from here.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { adbPath } from '../device/session.ts';
import { readZipEntry } from '../export/zip.ts';

const execFileAsync = promisify(execFile);

const DRIVER_APKS = ['maestro-app.apk', 'maestro-server.apk'] as const;
/** adb waits while the phone asks, and the phone gives up by itself. */
const INSTALL_TIMEOUT_MS = 60_000;

/** The phone said no, or nobody answered it in time. */
export class DriverInstallRefused extends Error {}

async function clientJar(maestroBin: string): Promise<string> {
  const lib = join(dirname(await realpath(maestroBin)), '..', 'lib');
  const name = (await readdir(lib)).find((file) => /^maestro-client.*\.jar$/.test(file));
  if (!name) throw new Error(`No maestro-client jar in ${lib}`);
  return join(lib, name);
}

async function installApk(deviceId: string, path: string): Promise<void> {
  try {
    await execFileAsync(adbPath(), ['-s', deviceId, 'install', '-r', '-t', path], { timeout: INSTALL_TIMEOUT_MS, windowsHide: true });
  } catch (error) {
    const { stdout, stderr, message } = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${stdout ?? ''} ${stderr ?? ''} ${message ?? ''}`;
    if (output.includes('INSTALL_FAILED_USER_RESTRICTED')) throw new DriverInstallRefused('The phone refused the install');
    throw new Error(/INSTALL_FAILED_[A-Z_]+/.exec(output)?.[0] ?? message ?? 'adb install failed');
  }
}

export async function installMaestroDriver(deviceId: string, maestroBin: string): Promise<void> {
  const jar = await readFile(await clientJar(maestroBin));
  const dir = await mkdtemp(join(tmpdir(), 'ariadne-driver-'));
  try {
    for (const name of DRIVER_APKS) {
      const apk = readZipEntry(jar, name);
      if (!apk) throw new Error(`The Maestro jar has no ${name}`);
      const path = join(dir, name);
      await writeFile(path, apk);
      await installApk(deviceId, path);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
