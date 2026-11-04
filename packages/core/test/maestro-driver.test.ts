import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { zip } from '../src/export/zip.ts';
import { DriverInstallRefused, installMaestroDriver } from '../src/replay/maestro-driver.ts';

// A fake Android SDK whose adb is a script, found through ANDROID_HOME, so
// nothing here can reach a real device. The script logs each call's
// arguments and the size of the APK it was given, and fails with the text in
// fail.txt when that file exists.
const describeUnix = process.platform === 'win32' ? describe.skip : describe;

describeUnix('installMaestroDriver', () => {
  let root: string;
  let maestroBin: string;
  let savedHome: string | undefined;
  let savedRoot: string | undefined;

  beforeEach(async () => {
    savedHome = process.env.ANDROID_HOME;
    savedRoot = process.env.ANDROID_SDK_ROOT;
    root = await mkdtemp(join(tmpdir(), 'ariadne-driver-test-'));
    const sdk = join(root, 'sdk');
    await mkdir(join(sdk, 'platform-tools'), { recursive: true });
    await writeFile(
      join(sdk, 'platform-tools', 'adb'),
      `#!/bin/sh
dir="$(dirname "$0")"
for a in "$@"; do last="$a"; done
echo "$*" >> "$dir/calls.txt"
echo "$(cat "$last")" >> "$dir/contents.txt"
if [ -f "$dir/fail.txt" ]; then cat "$dir/fail.txt" >&2; exit 1; fi
echo Success
`,
    );
    await chmod(join(sdk, 'platform-tools', 'adb'), 0o755);
    process.env.ANDROID_HOME = sdk;
    delete process.env.ANDROID_SDK_ROOT;

    await mkdir(join(root, 'maestro', 'bin'), { recursive: true });
    await mkdir(join(root, 'maestro', 'lib'), { recursive: true });
    maestroBin = join(root, 'maestro', 'bin', 'maestro');
    await writeFile(maestroBin, '#!/bin/sh\n');
    await writeFile(
      join(root, 'maestro', 'lib', 'maestro-client-2.1.0.jar'),
      zip([
        { name: 'unrelated.txt', data: 'x' },
        { name: 'maestro-server.apk', data: 'SERVER-APK' },
        { name: 'maestro-app.apk', data: 'APP-APK' },
      ]),
    );
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.ANDROID_HOME;
    else process.env.ANDROID_HOME = savedHome;
    if (savedRoot !== undefined) process.env.ANDROID_SDK_ROOT = savedRoot;
    await rm(root, { recursive: true, force: true });
  });

  const calls = async () => (await readFile(join(root, 'sdk', 'platform-tools', 'calls.txt'), 'utf8')).trim().split('\n');
  const contents = async () => (await readFile(join(root, 'sdk', 'platform-tools', 'contents.txt'), 'utf8')).trim().split('\n');
  const failWith = (text: string) => writeFile(join(root, 'sdk', 'platform-tools', 'fail.txt'), text);

  it('installs the app APK and then the server APK with install -r -t on the given device', async () => {
    await installMaestroDriver('R58M123', maestroBin);
    const lines = await calls();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^-s R58M123 install -r -t .*maestro-app\.apk$/);
    expect(lines[1]).toMatch(/^-s R58M123 install -r -t .*maestro-server\.apk$/);
    expect(await contents()).toEqual(['APP-APK', 'SERVER-APK']);
  });

  it('rejects with DriverInstallRefused when the phone says INSTALL_FAILED_USER_RESTRICTED', async () => {
    await failWith('adb: failed to install x.apk: Failure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]');
    await expect(installMaestroDriver('R58M123', maestroBin)).rejects.toBeInstanceOf(DriverInstallRefused);
  });

  it('rejects with an error naming another INSTALL_FAILED code, and not as a refusal', async () => {
    await failWith('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]');
    const error = await installMaestroDriver('R58M123', maestroBin).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DriverInstallRefused);
    expect((error as Error).message).toBe('INSTALL_FAILED_INSUFFICIENT_STORAGE');
  });

  it('stops after the first APK fails', async () => {
    await failWith('Failure [INSTALL_FAILED_OLDER_SDK]');
    await expect(installMaestroDriver('R58M123', maestroBin)).rejects.toThrow('INSTALL_FAILED_OLDER_SDK');
    expect(await calls()).toHaveLength(1);
  });

  it('removes its temporary folder after a successful install', async () => {
    await installMaestroDriver('R58M123', maestroBin);
    const apk = (await calls())[0]!.split(' ').at(-1)!;
    expect(existsSync(dirname(apk))).toBe(false);
  });

  it('removes its temporary folder after a failed install', async () => {
    await failWith('Failure [INSTALL_FAILED_USER_RESTRICTED]');
    await installMaestroDriver('R58M123', maestroBin).catch(() => undefined);
    const apk = (await calls())[0]!.split(' ').at(-1)!;
    expect(existsSync(dirname(apk))).toBe(false);
  });

  it('finds lib/ beside the real binary when maestro is a symlink elsewhere', async () => {
    const elsewhere = join(root, 'elsewhere', 'bin');
    await mkdir(elsewhere, { recursive: true });
    const link = join(elsewhere, 'maestro');
    await symlink(maestroBin, link);
    await installMaestroDriver('R58M123', link);
    expect(await calls()).toHaveLength(2);
  });

  it('says which jar entry is missing, and installs nothing', async () => {
    await writeFile(join(root, 'maestro', 'lib', 'maestro-client-2.1.0.jar'), zip([{ name: 'maestro-server.apk', data: 'S' }]));
    await expect(installMaestroDriver('R58M123', maestroBin)).rejects.toThrow('maestro-app.apk');
    expect(existsSync(join(root, 'sdk', 'platform-tools', 'calls.txt'))).toBe(false);
  });

  it('says so when lib/ has no maestro-client jar', async () => {
    await rm(join(root, 'maestro', 'lib', 'maestro-client-2.1.0.jar'));
    await expect(installMaestroDriver('R58M123', maestroBin)).rejects.toThrow(/No maestro-client jar/);
  });
});
