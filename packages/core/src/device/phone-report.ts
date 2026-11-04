// What a support report says about a phone: enough to see why something
// behaved as it did, nothing about the person holding it. No serial number, no
// list of apps, no accounts: only whether Ariadne's own helpers are there.
import type { PhoneShell } from './xiaomi.ts';
import { readXiaomiPhone } from './xiaomi.ts';
import { findTouchScreen, parseDensity, parseHomeApp, parseRotation, type Rotation, type TouchScreen } from './touch.ts';

export type PhoneReport = {
  maker?: string;
  model?: string;
  android?: string;
  sdk?: string;
  /** One UI's number, on a Samsung. */
  oneUi?: string;
  /** MIUI's or HyperOS's version, on a Xiaomi. */
  miui?: string;
  hyperOs?: string;
  screen?: string;
  density?: number;
  rotation?: Rotation;
  navigation?: 'buttons' | 'gestures';
  longPressMs?: number;
  keyboardApp?: string;
  homeApp?: string;
  /** Undefined when adb could not find a touchscreen, so Use the phone cannot work. */
  touchScreen?: TouchScreen;
  helperInstalled?: boolean;
  driverInstalled?: boolean;
  /** Set on Xiaomi's phones only. */
  driverOpensApps?: boolean;
};

const HELPER_PACKAGE = 'com.callstack.agentdevice.snapshothelper';
const DRIVER_PACKAGE = 'dev.mobile.maestro';
const NAVIGATION_MODE_GESTURES = '2';

const defined = (value: string): string | undefined => (value && value !== 'null' ? value : undefined);

/** Reads what it can: a phone that refuses one command still reports the rest. */
export async function readPhoneReport(shell: PhoneShell): Promise<PhoneReport> {
  const read = (...args: string[]) => shell(args).then((output) => output.trim(), () => '');
  const prop = async (name: string) => defined(await read('getprop', name));
  const [maker, model, android, sdk, oneUi, miui, hyperOs] = await Promise.all(
    ['ro.product.manufacturer', 'ro.product.model', 'ro.build.version.release', 'ro.build.version.sdk', 'ro.build.version.oneui', 'ro.miui.ui.version.name', 'ro.mi.os.version.name'].map(prop),
  );
  const [size, density, input, navigation, xiaomiGestures, longPress, keyboard, home, touch, packages] = await Promise.all([
    read('wm', 'size'),
    read('wm', 'density'),
    read('dumpsys', 'input'),
    read('settings', 'get', 'secure', 'navigation_mode'),
    read('settings', 'get', 'global', 'force_fsg_nav_bar'),
    read('settings', 'get', 'secure', 'long_press_timeout'),
    read('settings', 'get', 'secure', 'default_input_method'),
    read('cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME'),
    read('getevent', '-pl'),
    read('pm', 'list', 'packages'),
  ]);
  const installed = (name: string) => packages.split(/\r?\n/).some((line) => line.trim() === `package:${name}`);
  const xiaomi = await readXiaomiPhone(shell).catch(() => undefined);
  const screen = /(\d+x\d+)\s*$/.exec(size)?.[1];
  const densityValue = parseDensity(density);
  const homeApp = parseHomeApp(home);
  const touchScreen = findTouchScreen(touch);
  const keyboardApp = defined(keyboard.split('/')[0] ?? '');
  return {
    ...(maker ? { maker } : {}),
    ...(model ? { model } : {}),
    ...(android ? { android } : {}),
    ...(sdk ? { sdk } : {}),
    ...(oneUi ? { oneUi } : {}),
    ...(miui ? { miui } : {}),
    ...(hyperOs ? { hyperOs } : {}),
    ...(screen ? { screen } : {}),
    ...(densityValue ? { density: densityValue } : {}),
    ...(input ? { rotation: parseRotation(input) } : {}),
    ...(navigation ? { navigation: navigation === NAVIGATION_MODE_GESTURES || xiaomiGestures === '1' ? ('gestures' as const) : ('buttons' as const) } : {}),
    ...(Number(longPress) ? { longPressMs: Number(longPress) } : {}),
    ...(keyboardApp ? { keyboardApp } : {}),
    ...(homeApp ? { homeApp } : {}),
    ...(touchScreen ? { touchScreen } : {}),
    ...(packages ? { helperInstalled: installed(HELPER_PACKAGE), driverInstalled: installed(DRIVER_PACKAGE) } : {}),
    ...(xiaomi ? { driverOpensApps: xiaomi.driverOpensApps } : {}),
  };
}
