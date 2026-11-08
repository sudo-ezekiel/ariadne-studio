// What recording from the phone asks of adb: the touchscreen and its settings,
// and the stream of raw touches. The stream's lines are positions on the
// screen, so they include keys pressed on the on-screen keyboard: never log
// them. Reading them is in touch.ts, deciding what they mean in phone-steps.ts.
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { installMaestroDriver } from '../replay/maestro-driver.ts';
import { parseKeyguardShowing } from './hidden-screen.ts';
import { readPhoneReport, type PhoneReport } from './phone-report.ts';
import { adbPath } from './session.ts';
import { readTestedOn, type TestedOn } from './tested-on.ts';
import { findTouchScreen, parseDensity, parseHomeApp, parseRotation, type Rotation, type TouchScreen } from './touch.ts';
import { allowDriverToOpenApps, readXiaomiPhone, stopDriver, type XiaomiPhone } from './xiaomi.ts';

const execFileAsync = promisify(execFile);

const ADB_TIMEOUT_MS = 10_000;
// `dumpsys package <app>` can pass Node's 1 MB default for an app with many components.
const ADB_MAX_OUTPUT = 16 * 1024 * 1024;
/** Android's default before a press counts as long; phones may set their own. */
const DEFAULT_LONG_PRESS_MS = 400;
/** Android's touch slop: a finger may wander this far, in dp, and still be a tap. */
const TOUCH_SLOP_DP = 8;
const NAVIGATION_MODE_GESTURES = '2';

export type PhoneInput = {
  screen: TouchScreen;
  longPressMs: number;
  touchSlopPx: number;
  /** Back and Home are edge swipes on this phone, not buttons. */
  gestureNavigation: boolean;
  /** The launcher, so recording can tell when the tester left the app. */
  homeApp?: string;
};

export type PhoneInputTools = {
  read: (deviceId: string) => Promise<PhoneInput | undefined>;
  rotation: (deviceId: string) => Promise<Rotation>;
  /** Streams getevent lines until the returned function is called; `onEnd` runs if adb stops by itself. */
  watch: (deviceId: string, path: string, onLine: (line: string) => void, onEnd: () => void) => () => void;
  /** What Maestro needs on a Xiaomi phone; undefined on any other device. */
  xiaomi: (deviceId: string) => Promise<XiaomiPhone | undefined>;
  allowDriver: (deviceId: string) => Promise<void>;
  /** Facts about the phone for a diagnostics report. */
  report: (deviceId: string) => Promise<PhoneReport>;
  /** The phone's model and Android version, and each app's version, for an evidence pack. */
  testedOn: (deviceId: string, appIds: readonly string[]) => Promise<TestedOn>;
  /** Whether the lock screen is up; undefined when Android does not say. */
  locked: (deviceId: string) => Promise<boolean | undefined>;
  /** Ends Maestro's driver when a run leaves it on the phone. */
  stopDriver: (deviceId: string) => Promise<void>;
  /** Puts Maestro's driver on the phone, asking on the phone first on Xiaomi's. */
  installDriver: (deviceId: string, maestroBin: string) => Promise<void>;
};

async function shell(deviceId: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(adbPath(), ['-s', deviceId, 'shell', ...args], { timeout: ADB_TIMEOUT_MS, maxBuffer: ADB_MAX_OUTPUT, windowsHide: true });
  return stdout;
}

/** The phone's touchscreen and touch settings; undefined when it has no touchscreen adb can read. */
async function readPhoneInput(deviceId: string): Promise<PhoneInput | undefined> {
  const screen = findTouchScreen(await shell(deviceId, 'getevent', '-pl'));
  if (!screen) return undefined;
  const [longPress, density, navigation, xiaomiGestures, home] = await Promise.all([
    shell(deviceId, 'settings', 'get', 'secure', 'long_press_timeout'),
    shell(deviceId, 'wm', 'density'),
    shell(deviceId, 'settings', 'get', 'secure', 'navigation_mode'),
    shell(deviceId, 'settings', 'get', 'global', 'force_fsg_nav_bar'),
    shell(deviceId, 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME'),
  ]);
  const homeApp = parseHomeApp(home);
  return {
    screen,
    longPressMs: Number(longPress.trim()) || DEFAULT_LONG_PRESS_MS,
    touchSlopPx: (TOUCH_SLOP_DP * (parseDensity(density) ?? 160)) / 160,
    gestureNavigation: navigation.trim() === NAVIGATION_MODE_GESTURES || xiaomiGestures.trim() === '1',
    ...(homeApp ? { homeApp } : {}),
  };
}

function watchTouches(deviceId: string, path: string, onLine: (line: string) => void, onEnd: () => void): () => void {
  const child = spawn(adbPath(), ['-s', deviceId, 'exec-out', 'getevent', '-lt', path], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let stopped = false;
  createInterface({ input: child.stdout }).on('line', onLine);
  const ended = () => {
    if (!stopped) onEnd();
    stopped = true;
  };
  child.on('close', ended);
  child.on('error', ended);
  return () => {
    stopped = true;
    child.kill();
  };
}

export const phoneInputTools: PhoneInputTools = {
  read: readPhoneInput,
  rotation: async (deviceId) => parseRotation(await shell(deviceId, 'dumpsys', 'input')),
  watch: watchTouches,
  xiaomi: (deviceId) => readXiaomiPhone((args) => shell(deviceId, ...args)),
  allowDriver: (deviceId) => allowDriverToOpenApps((args) => shell(deviceId, ...args)),
  report: (deviceId) => readPhoneReport((args) => shell(deviceId, ...args)),
  testedOn: (deviceId, appIds) => readTestedOn((args) => shell(deviceId, ...args), appIds),
  // Filtered on the phone: the rest of the dump names what is on screen, notifications too.
  locked: async (deviceId) => parseKeyguardShowing(await shell(deviceId, 'dumpsys window | grep isKeyguardShowing=')),
  stopDriver: (deviceId) => stopDriver((args) => shell(deviceId, ...args)),
  installDriver: installMaestroDriver,
};
