// What the evidence pack says the Run all ran on. A fake adb shell answers by
// command line with output shaped like a real phone's, and records every
// command so the tests can also see what was never asked.
import { describe, expect, it } from 'vitest';
import { appVersionText, parseAppVersion, readTestedOn } from '../src/device/tested-on.ts';
import type { PhoneShell } from '../src/device/xiaomi.ts';

type Answers = Record<string, string | Error>;

function phone(answers: Answers): { shell: PhoneShell; calls: string[] } {
  const calls: string[] = [];
  const shell: PhoneShell = async (args) => {
    const line = args.join(' ');
    calls.push(line);
    const answer = answers[line];
    if (answer instanceof Error) throw answer;
    return answer ?? '';
  };
  return { shell, calls };
}

// The part of `dumpsys package` that matters, as Android 14 prints it: the code
// line carries minSdk and targetSdk after it, the name is on a line of its own.
const BANK_DUMP = `Packages:
  Package [com.example.bank] (a1b2c3d):
    userId=10234
    pkg=Package{4f5e6a7 com.example.bank}
    codePath=/data/app/~~x==/com.example.bank-y==
    versionCode=241 minSdk=26 targetSdk=34
    versionName=2.4.1
    splits=[base]
`;

describe('parseAppVersion', () => {
  it('reads the code and the name from dumpsys package output', () => {
    expect(parseAppVersion(BANK_DUMP)).toEqual({ versionName: '2.4.1', versionCode: '241' });
  });

  it('takes the first block when an updated system app is listed twice', () => {
    const dump = `Packages:
  Package [com.android.chrome] (aaa):
    versionCode=650 minSdk=29 targetSdk=34
    versionName=120.0.1
Hidden system packages:
  Package [com.android.chrome] (bbb):
    versionCode=500 minSdk=29 targetSdk=33
    versionName=100.0.0
`;
    expect(parseAppVersion(dump)).toEqual({ versionName: '120.0.1', versionCode: '650' });
  });

  it('leaves out a versionName of null', () => {
    expect(parseAppVersion('    versionCode=7 minSdk=21 targetSdk=33\n    versionName=null\n')).toEqual({ versionCode: '7' });
  });

  it('keeps a name with spaces and reads past Windows line ends', () => {
    expect(parseAppVersion('    versionCode=9 minSdk=21\r\n    versionName=3.0 beta 2\r\n')).toEqual({ versionName: '3.0 beta 2', versionCode: '9' });
  });

  it('returns an empty object when no package is described', () => {
    expect(parseAppVersion('')).toEqual({});
    expect(parseAppVersion('Unable to find package: com.example.gone\n')).toEqual({});
  });
});

describe('appVersionText', () => {
  it('shows the name with the code in brackets', () => {
    expect(appVersionText({ appId: 'a.b', versionName: '2.4.1', versionCode: '241' })).toBe('2.4.1 (241)');
  });

  it('shows the name alone', () => {
    expect(appVersionText({ appId: 'a.b', versionName: '2.4.1' })).toBe('2.4.1');
  });

  it('shows the code alone', () => {
    expect(appVersionText({ appId: 'a.b', versionCode: '241' })).toBe('241');
  });

  it('is undefined when the phone gave neither', () => {
    expect(appVersionText({ appId: 'a.b' })).toBeUndefined();
  });
});

describe('readTestedOn', () => {
  const props: Answers = {
    'getprop ro.product.manufacturer': 'Xiaomi\n',
    'getprop ro.product.model': '23129RAA4G\n',
    'getprop ro.build.version.release': '14\n',
  };

  it('reads maker, model and Android release, trimmed', async () => {
    const { shell } = phone(props);
    expect(await readTestedOn(shell, [])).toEqual({ maker: 'Xiaomi', model: '23129RAA4G', android: '14', apps: [] });
  });

  it('reads each app version from dumpsys package', async () => {
    const { shell, calls } = phone({ ...props, 'dumpsys package com.example.bank': BANK_DUMP });
    const result = await readTestedOn(shell, ['com.example.bank']);
    expect(result.apps).toEqual([{ appId: 'com.example.bank', versionName: '2.4.1', versionCode: '241' }]);
    expect(calls).toContain('dumpsys package com.example.bank');
  });

  it('asks once for an app id given twice', async () => {
    const { shell, calls } = phone({ ...props, 'dumpsys package com.example.bank': BANK_DUMP });
    const result = await readTestedOn(shell, ['com.example.bank', 'com.example.bank']);
    expect(result.apps).toHaveLength(1);
    expect(calls.filter((line) => line.startsWith('dumpsys'))).toEqual(['dumpsys package com.example.bank']);
  });

  it('never sends an app id that is not a package name to the shell, but still lists it', async () => {
    const { shell, calls } = phone(props);
    const bad = ['com.example.bank; rm -rf /sdcard', 'has space.app', 'nodots', '1com.example', 'com..example', ''];
    const result = await readTestedOn(shell, bad);
    expect(result.apps).toEqual(bad.map((appId) => ({ appId })));
    expect(calls.filter((line) => line.startsWith('dumpsys'))).toEqual([]);
  });

  it('lets the rest report when a command is refused', async () => {
    const { shell } = phone({
      'getprop ro.product.manufacturer': new Error('device offline'),
      'getprop ro.product.model': 'Pixel 9\n',
      'getprop ro.build.version.release': '15\n',
      'dumpsys package com.example.one': new Error('timeout'),
      'dumpsys package com.example.two': BANK_DUMP,
    });
    expect(await readTestedOn(shell, ['com.example.one', 'com.example.two'])).toEqual({
      model: 'Pixel 9',
      android: '15',
      apps: [{ appId: 'com.example.one' }, { appId: 'com.example.two', versionName: '2.4.1', versionCode: '241' }],
    });
  });

  it('leaves out properties the phone answers with nothing or null', async () => {
    const { shell } = phone({ 'getprop ro.product.manufacturer': '\n', 'getprop ro.product.model': 'null\n' });
    expect(await readTestedOn(shell, [])).toEqual({ apps: [] });
  });

  it('lists apps in the order they were given', async () => {
    const { shell } = phone(props);
    const result = await readTestedOn(shell, ['com.z.last', 'com.a.first', 'com.m.middle', 'com.z.last']);
    expect(result.apps.map((app) => app.appId)).toEqual(['com.z.last', 'com.a.first', 'com.m.middle']);
  });

  describe('emulator detection', () => {
    const detect = async (extra: Answers) => (await readTestedOn(phone({ ...props, ...extra }).shell, [])).emulator;

    it('is true when ro.kernel.qemu is 1', async () => {
      expect(await detect({ 'getprop ro.kernel.qemu': '1\n', 'getprop ro.hardware': 'qcom\n' })).toBe(true);
    });

    it('is true when ro.boot.qemu is 1', async () => {
      expect(await detect({ 'getprop ro.boot.qemu': '1\n', 'getprop ro.hardware': 'qcom\n' })).toBe(true);
    });

    it('is true for ro.hardware ranchu or goldfish', async () => {
      expect(await detect({ 'getprop ro.hardware': 'ranchu\n' })).toBe(true);
      expect(await detect({ 'getprop ro.hardware': 'goldfish\n' })).toBe(true);
    });

    it('is false for a real phone board such as qcom or mt6789', async () => {
      expect(await detect({ 'getprop ro.hardware': 'qcom\n', 'getprop ro.kernel.qemu': '0\n' })).toBe(false);
      expect(await detect({ 'getprop ro.hardware': 'mt6789\n' })).toBe(false);
    });

    it('is absent when no emulator property could be read', async () => {
      const result = await readTestedOn(phone(props).shell, []);
      expect(result).not.toHaveProperty('emulator');
    });

    it('is absent when every emulator property is refused', async () => {
      const refuse = new Error('offline');
      const result = await readTestedOn(
        phone({ ...props, 'getprop ro.kernel.qemu': refuse, 'getprop ro.boot.qemu': refuse, 'getprop ro.hardware': refuse }).shell,
        [],
      );
      expect(result).not.toHaveProperty('emulator');
    });

    it('is still true when only the qemu flag is read and the hardware is refused', async () => {
      expect(await detect({ 'getprop ro.kernel.qemu': '1\n', 'getprop ro.hardware': new Error('x') })).toBe(true);
    });

    it('is not decided by a qemu value other than 1', async () => {
      expect(await detect({ 'getprop ro.kernel.qemu': '0\n' })).toBeUndefined();
    });

    it('is true for ro.hardware vbox86, the Genymotion VirtualBox board', async () => {
      expect(await detect({ 'getprop ro.hardware': 'vbox86\n' })).toBe(true);
    });

    it('is true for a Genymotion or Genymobile maker in any case, even on a real-looking board', async () => {
      for (const maker of ['Genymotion', 'genymotion', 'GENYMOTION', 'Genymobile', 'genymobile']) {
        expect(await detect({ 'getprop ro.product.manufacturer': `${maker}\n`, 'getprop ro.hardware': 'qcom\n' })).toBe(true);
      }
    });

    it('is still true for a Genymotion maker when ro.hardware is refused', async () => {
      expect(await detect({ 'getprop ro.product.manufacturer': 'Genymotion\n', 'getprop ro.hardware': new Error('x') })).toBe(true);
    });

    it('is true when ro.build.characteristics lists emulator, over a real-looking board', async () => {
      for (const characteristics of ['emulator\n', 'nosdcard,emulator\n', 'nosdcard, emulator\n', 'emulator,tablet\n']) {
        expect(await detect({ 'getprop ro.build.characteristics': characteristics, 'getprop ro.hardware': 'qcom\n' })).toBe(true);
      }
    });

    it('is still true for an emulator characteristic when ro.hardware is refused', async () => {
      expect(await detect({ 'getprop ro.build.characteristics': 'nosdcard,emulator\n', 'getprop ro.hardware': new Error('x') })).toBe(true);
    });

    it('is not made true by characteristics that only resemble emulator', async () => {
      for (const characteristics of ['default\n', 'nosdcard\n', 'emulator2\n', 'notemulator\n', 'nosdcard,emulator2\n']) {
        expect(await detect({ 'getprop ro.build.characteristics': characteristics, 'getprop ro.hardware': 'qcom\n' })).toBe(false);
      }
    });

    it('stays absent for characteristics without the emulator word when ro.hardware is refused', async () => {
      expect(await detect({ 'getprop ro.build.characteristics': 'default\n', 'getprop ro.hardware': new Error('x') })).toBeUndefined();
    });

    it('is false for a real phone with a Xiaomi maker, qcom board and default characteristics', async () => {
      expect(
        await detect({ 'getprop ro.hardware': 'qcom\n', 'getprop ro.build.characteristics': 'default\n', 'getprop ro.kernel.qemu': '0\n' }),
      ).toBe(false);
    });
  });
});
