// What a support report says about a phone. A fake adb shell answers by command
// line, with output shaped like real phones', so these tests read the same text
// the parsers meet in the field and also see every command that was asked.
import { describe, expect, it } from 'vitest';
import { readPhoneReport } from '../src/device/phone-report.ts';
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

const HOME_COMMAND = 'cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME';

// getevent -pl on a Samsung: a virtual touchpad first, then the real panel.
const SAMSUNG_EVENTS = `add device 1: /dev/input/event5
  name:     "sec_touchpad"
  events:
    ABS (0003): ABS_MT_SLOT           : value 0, min 0, max 9, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_X     : value 0, min 0, max 4095, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 4095, fuzz 0, flat 0, resolution 0
  input props:
    INPUT_PROP_POINTER
add device 2: /dev/input/event6
  name:     "sec_touchscreen"
  events:
    ABS (0003): ABS_MT_SLOT           : value 0, min 0, max 9, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_X     : value 0, min 0, max 1079, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 2339, fuzz 0, flat 0, resolution 0
  input props:
    INPUT_PROP_DIRECT
`;

const SAMSUNG: Answers = {
  'getprop ro.product.manufacturer': 'samsung\n',
  'getprop ro.product.model': 'SM-A546B\n',
  'getprop ro.build.version.release': '14\n',
  'getprop ro.build.version.sdk': '34\n',
  'getprop ro.build.version.oneui': '60100\n',
  'getprop ro.miui.ui.version.name': '\n',
  'getprop ro.mi.os.version.name': '\n',
  'wm size': 'Physical size: 1080x2340\n',
  'wm density': 'Physical density: 450\n',
  'dumpsys input': '  Viewport INTERNAL: displayId=0, orientation=0, logicalFrame=[0, 0, 1080, 2340]\n',
  'settings get secure navigation_mode': '2\n',
  'settings get global force_fsg_nav_bar': 'null\n',
  'settings get secure long_press_timeout': '400\n',
  'settings get secure default_input_method': 'com.samsung.android.honeyboard/.service.HoneyBoardService\n',
  [HOME_COMMAND]: 'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.sec.android.app.launcher/.activities.LauncherActivity\n',
  'getevent -pl': SAMSUNG_EVENTS,
  'pm list packages': 'package:com.sec.android.app.launcher\npackage:com.callstack.agentdevice.snapshothelper\npackage:com.bank.private.app\n',
};

const XIAOMI: Answers = {
  'getprop ro.product.manufacturer': 'Xiaomi\n',
  'getprop ro.product.model': '23049PCD8G\n',
  'getprop ro.build.version.release': '15\n',
  'getprop ro.build.version.sdk': '35\n',
  'getprop ro.build.version.oneui': '\n',
  'getprop ro.miui.ui.version.name': 'V816\n',
  'getprop ro.mi.os.version.name': 'OS3\n',
  'wm size': 'Physical size: 1220x2712\nOverride size: 1080x2400\n',
  'wm density': 'Physical density: 446\nOverride density: 400\n',
  'dumpsys input': '  SurfaceOrientation: 1\n',
  'settings get secure navigation_mode': 'null\n',
  'settings get global force_fsg_nav_bar': '1\n',
  'settings get secure long_press_timeout': '500\n',
  'settings get secure default_input_method': 'com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME\n',
  [HOME_COMMAND]: 'com.miui.home/.launcher.Launcher\n',
  'getevent -pl': `add device 1: /dev/input/event3
  name:     "xiaomi-touch"
  events:
    ABS (0003): ABS_MT_POSITION_X     : value 0, min 0, max 12199, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 27119, fuzz 0, flat 0, resolution 0
  input props:
    INPUT_PROP_DIRECT
`,
  'pm list packages': 'package:com.miui.home\npackage:dev.mobile.maestro\npackage:dev.mobile.maestro.test\n',
  'pm list packages dev.mobile.maestro': 'package:dev.mobile.maestro\npackage:dev.mobile.maestro.test\n',
  'appops get dev.mobile.maestro 10021': 'MIUIOP(10021): allow; time=+2d1h\n',
};

describe('readPhoneReport on a Samsung', () => {
  it('reads the maker, model, versions, screen, navigation, keyboard and launcher', async () => {
    const report = await readPhoneReport(phone(SAMSUNG).shell);
    expect(report).toMatchObject({
      maker: 'samsung',
      model: 'SM-A546B',
      android: '14',
      sdk: '34',
      oneUi: '60100',
      screen: '1080x2340',
      density: 450,
      rotation: 0,
      navigation: 'gestures',
      longPressMs: 400,
      keyboardApp: 'com.samsung.android.honeyboard',
      homeApp: 'com.sec.android.app.launcher',
    });
  });

  it('picks sec_touchscreen, the direct panel, over the sec_touchpad listed before it', async () => {
    const report = await readPhoneReport(phone(SAMSUNG).shell);
    expect(report.touchScreen).toEqual({ path: '/dev/input/event6', maxX: 1079, maxY: 2339 });
  });

  it('leaves out the fields that belong to other makers', async () => {
    const report = await readPhoneReport(phone(SAMSUNG).shell);
    expect(report).not.toHaveProperty('miui');
    expect(report).not.toHaveProperty('hyperOs');
    expect(report).not.toHaveProperty('driverOpensApps');
  });

  it('reports the helper as installed and the driver as missing from the package list without returning the list', async () => {
    const report = await readPhoneReport(phone(SAMSUNG).shell);
    expect(report).toMatchObject({ helperInstalled: true, driverInstalled: false });
    const text = JSON.stringify(report);
    expect(text).not.toContain('com.bank.private.app');
    expect(text).not.toContain('package:');
    expect(text).not.toContain('com.sec.android.app.launcher\\npackage');
  });
});

describe('readPhoneReport on a Xiaomi', () => {
  it('reads HyperOS and MIUI versions and whether the driver opens apps', async () => {
    const report = await readPhoneReport(phone(XIAOMI).shell);
    expect(report).toMatchObject({ maker: 'Xiaomi', miui: 'V816', hyperOs: 'OS3', driverInstalled: true, driverOpensApps: true });
    expect(report).not.toHaveProperty('oneUi');
  });

  it('says the driver does not open apps when the permission is ignore', async () => {
    const report = await readPhoneReport(phone({ ...XIAOMI, 'appops get dev.mobile.maestro 10021': 'MIUIOP(10021): ignore\n' }).shell);
    expect(report.driverOpensApps).toBe(false);
  });

  it('takes the override screen size, the one in effect, and the override density', async () => {
    const report = await readPhoneReport(phone(XIAOMI).shell);
    expect(report).toMatchObject({ screen: '1080x2400', density: 400, rotation: 1 });
  });

  it('reads gesture navigation from force_fsg_nav_bar when navigation_mode is null', async () => {
    const report = await readPhoneReport(phone(XIAOMI).shell);
    expect(report.navigation).toBe('gestures');
  });

  it('accepts a touchscreen with no direct mark when it is the only one', async () => {
    const report = await readPhoneReport(phone(XIAOMI).shell);
    expect(report.touchScreen).toEqual({ path: '/dev/input/event3', maxX: 12199, maxY: 27119 });
  });
});

describe('navigation', () => {
  const base = (extra: Answers) => phone({ ...SAMSUNG, ...extra }).shell;

  it('is gestures when navigation_mode is 2', async () => {
    expect((await readPhoneReport(base({ 'settings get secure navigation_mode': '2\n', 'settings get global force_fsg_nav_bar': 'null\n' }))).navigation).toBe('gestures');
  });

  it('is buttons when navigation_mode is 0', async () => {
    expect((await readPhoneReport(base({ 'settings get secure navigation_mode': '0\n', 'settings get global force_fsg_nav_bar': 'null\n' }))).navigation).toBe('buttons');
  });

  it('is buttons for the three-button mode 1 as well', async () => {
    expect((await readPhoneReport(base({ 'settings get secure navigation_mode': '1\n', 'settings get global force_fsg_nav_bar': '0\n' }))).navigation).toBe('buttons');
  });

  it('is gestures when force_fsg_nav_bar is 1, whatever navigation_mode says', async () => {
    expect((await readPhoneReport(base({ 'settings get secure navigation_mode': '0\n', 'settings get global force_fsg_nav_bar': '1\n' }))).navigation).toBe('gestures');
  });

  it('is left out when navigation_mode could not be read at all', async () => {
    const report = await readPhoneReport(base({ 'settings get secure navigation_mode': new Error('adb: closed') }));
    expect(report).not.toHaveProperty('navigation');
  });
});

describe('settings that come back null', () => {
  const nulls: Answers = {
    'settings get secure long_press_timeout': 'null\n',
    'settings get secure default_input_method': 'null\n',
    'getprop ro.build.version.oneui': 'null\n',
  };

  it('leaves out a null long-press time', async () => {
    expect(await readPhoneReport(phone({ ...SAMSUNG, ...nulls }).shell)).not.toHaveProperty('longPressMs');
  });

  it('leaves out a null keyboard rather than naming an app "null"', async () => {
    const report = await readPhoneReport(phone({ ...SAMSUNG, ...nulls }).shell);
    expect(report).not.toHaveProperty('keyboardApp');
  });

  it('leaves out a null property', async () => {
    expect(await readPhoneReport(phone({ ...SAMSUNG, ...nulls }).shell)).not.toHaveProperty('oneUi');
  });

  it('leaves out a long-press time of zero', async () => {
    expect(await readPhoneReport(phone({ ...SAMSUNG, 'settings get secure long_press_timeout': '0\n' }).shell)).not.toHaveProperty('longPressMs');
  });

  it('leaves out every field of a report where every answer is null', async () => {
    const allNull = Object.fromEntries(Object.keys(SAMSUNG).map((key) => [key, 'null\n']));
    const report = await readPhoneReport(phone(allNull).shell);
    expect(JSON.stringify(report)).not.toContain('null');
  });
});

describe('a phone where some commands fail', () => {
  it('still reports what the other commands gave', async () => {
    const report = await readPhoneReport(
      phone({
        ...SAMSUNG,
        'dumpsys input': new Error('adb: device offline'),
        'wm size': new Error('Permission denied'),
        'getevent -pl': new Error('adb: closed'),
        'pm list packages': new Error('Security exception'),
      }).shell,
    );
    expect(report).toMatchObject({ maker: 'samsung', model: 'SM-A546B', android: '14', navigation: 'gestures', keyboardApp: 'com.samsung.android.honeyboard' });
    for (const missing of ['rotation', 'screen', 'touchScreen', 'helperInstalled', 'driverInstalled']) {
      expect(report).not.toHaveProperty(missing);
    }
  });

  it('gives an empty report, and does not throw, when every command fails', async () => {
    const shell: PhoneShell = async () => {
      throw new Error('adb: no devices');
    };
    expect(await readPhoneReport(shell)).toEqual({});
  });

  it('leaves out Xiaomi facts when the Xiaomi check itself fails', async () => {
    const report = await readPhoneReport(phone({ ...XIAOMI, 'appops get dev.mobile.maestro 10021': new Error('boom') }).shell);
    expect(report).toMatchObject({ maker: 'Xiaomi', miui: 'V816' });
    expect(report).not.toHaveProperty('driverOpensApps');
  });
});

describe('finding the helper and the driver', () => {
  const withPackages = (packages: string) => phone({ ...SAMSUNG, 'pm list packages': packages }).shell;

  it('finds the driver by its exact package name', async () => {
    const report = await readPhoneReport(withPackages('package:dev.mobile.maestro\n'));
    expect(report.driverInstalled).toBe(true);
  });

  it('does not count dev.mobile.maestro.test alone as the driver', async () => {
    const report = await readPhoneReport(withPackages('package:dev.mobile.maestro.test\n'));
    expect(report.driverInstalled).toBe(false);
  });

  it('does not count a package that only starts with the helper name', async () => {
    const report = await readPhoneReport(withPackages('package:com.callstack.agentdevice.snapshothelper.other\n'));
    expect(report.helperInstalled).toBe(false);
  });

  it('does not count a package that only contains the helper name', async () => {
    const report = await readPhoneReport(withPackages('package:x.com.callstack.agentdevice.snapshothelper\n'));
    expect(report.helperInstalled).toBe(false);
  });

  it('reads a list with Windows line endings', async () => {
    const report = await readPhoneReport(withPackages('package:com.callstack.agentdevice.snapshothelper\r\npackage:dev.mobile.maestro\r\n'));
    expect(report).toMatchObject({ helperInstalled: true, driverInstalled: true });
  });

  it('says neither is installed for a list with other apps only', async () => {
    const report = await readPhoneReport(withPackages('package:com.android.settings\n'));
    expect(report).toMatchObject({ helperInstalled: false, driverInstalled: false });
  });

  it('says nothing about either when the list could not be read', async () => {
    const report = await readPhoneReport(withPackages(''));
    expect(report).not.toHaveProperty('helperInstalled');
    expect(report).not.toHaveProperty('driverInstalled');
  });
});

describe('what the report asks the phone', () => {
  it('asks only for the facts it reports, nothing that lists accounts', async () => {
    const { shell, calls } = phone(SAMSUNG);
    await readPhoneReport(shell);
    expect(calls.filter((call) => !call.startsWith('getprop ')).sort()).toEqual(
      [
        'wm size',
        'wm density',
        'dumpsys input',
        'settings get secure navigation_mode',
        'settings get global force_fsg_nav_bar',
        'settings get secure long_press_timeout',
        'settings get secure default_input_method',
        HOME_COMMAND,
        'getevent -pl',
        'pm list packages',
      ].sort(),
    );
    for (const call of calls) {
      expect(call).not.toMatch(/account|content query|contacts|sms|call_log|dumpsys (?!input)/i);
    }
  });

  it('asks for a Xiaomi phone\'s extras only from Maestro\'s own packages', async () => {
    const { shell, calls } = phone(XIAOMI);
    await readPhoneReport(shell);
    expect(calls).toContain('pm list packages dev.mobile.maestro');
    expect(calls).toContain('appops get dev.mobile.maestro 10021');
    expect(calls.filter((call) => call.startsWith('appops'))).toEqual(['appops get dev.mobile.maestro 10021']);
  });

  it('never returns a serial number or a package list in any shape', async () => {
    const report = await readPhoneReport(phone({ ...SAMSUNG, 'getprop ro.serialno': 'R58M123456' }).shell);
    const text = JSON.stringify(report);
    expect(text).not.toContain('R58M123456');
    expect(Object.keys(report).sort()).toEqual(
      ['android', 'density', 'driverInstalled', 'helperInstalled', 'homeApp', 'keyboardApp', 'longPressMs', 'maker', 'model', 'navigation', 'oneUi', 'rotation', 'screen', 'sdk', 'touchScreen'].sort(),
    );
  });
});
