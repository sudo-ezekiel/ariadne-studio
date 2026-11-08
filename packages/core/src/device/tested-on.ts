// What a Run all ran on, for the evidence pack: the phone's model and Android
// version, and the version of each app under test. Read when Run all starts,
// because by the time someone signs the pack the phone may hold another build.
// No serial number: the pack is handed to people outside the team.
import type { PhoneShell } from './xiaomi.ts';

export type AppVersion = {
  appId: string;
  /** What the app shows as its version, e.g. 2.4.1. */
  versionName?: string;
  /** The build number Android compares, e.g. 241. */
  versionCode?: string;
};

export type TestedOn = {
  maker?: string;
  model?: string;
  android?: string;
  /** True for an Android emulator, false for a real phone, absent when the phone did not say. */
  emulator?: boolean;
  /** One entry per app id asked for, in that order; an app the phone did not report has no version. */
  apps: AppVersion[];
};

// An Android package name; anything else never reaches the phone's shell.
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

const defined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed !== 'null' ? trimmed : undefined;
};

/**
 * Version of the package `dumpsys package <id>` describes. An app updated over
 * a version built into the phone is listed twice; the first is the one in use.
 */
export function parseAppVersion(dumpsys: string): { versionName?: string; versionCode?: string } {
  const versionCode = defined(/^\s*versionCode=(\d+)/m.exec(dumpsys)?.[1]);
  const versionName = defined(/^\s*versionName=(.*)$/m.exec(dumpsys)?.[1]);
  return { ...(versionName ? { versionName } : {}), ...(versionCode ? { versionCode } : {}) };
}

// Boards emulators report: Google's (ranchu, goldfish) and Genymotion's VirtualBox one (vbox86).
// A real phone reports its own board, so any other board counts as a real phone.
const EMULATOR_HARDWARE = new Set(['ranchu', 'goldfish', 'vbox86']);
// Genymotion's maker names, for its images that report a board of their own.
const EMULATOR_MAKERS = new Set(['genymotion', 'genymobile']);

/** "2.4.1 (241)", or whichever half the phone gave; undefined when it gave neither. */
export function appVersionText(app: AppVersion): string | undefined {
  if (app.versionName && app.versionCode) return `${app.versionName} (${app.versionCode})`;
  return app.versionName ?? app.versionCode;
}

/** Reads what it can: a phone that refuses one command still reports the rest. */
export async function readTestedOn(shell: PhoneShell, appIds: readonly string[]): Promise<TestedOn> {
  const read = (...args: string[]) => shell(args).then((output) => output, () => '');
  const [maker, model, android, kernelQemu, bootQemu, hardware, characteristics] = await Promise.all(
    ['ro.product.manufacturer', 'ro.product.model', 'ro.build.version.release', 'ro.kernel.qemu', 'ro.boot.qemu', 'ro.hardware', 'ro.build.characteristics'].map(
      async (name) => defined(await read('getprop', name)),
    ),
  );
  const emulatorSign =
    kernelQemu === '1' ||
    bootQemu === '1' ||
    (hardware !== undefined && EMULATOR_HARDWARE.has(hardware)) ||
    (maker !== undefined && EMULATOR_MAKERS.has(maker.toLowerCase())) ||
    // A comma-separated list; emulator images built from Android's own sources say "emulator" in it.
    (characteristics?.split(',').some((part) => part.trim() === 'emulator') ?? false);
  const emulator = emulatorSign ? true : hardware !== undefined ? false : undefined;
  const apps: AppVersion[] = [];
  for (const appId of new Set(appIds)) {
    const version = PACKAGE_NAME.test(appId) ? parseAppVersion(await read('dumpsys', 'package', appId)) : {};
    apps.push({ appId, ...version });
  }
  return {
    ...(maker ? { maker } : {}),
    ...(model ? { model } : {}),
    ...(android ? { android } : {}),
    ...(emulator !== undefined ? { emulator } : {}),
    apps,
  };
}
