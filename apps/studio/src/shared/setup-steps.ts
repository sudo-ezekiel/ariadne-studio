// What the device setup guide shows, worked out from the live checks. It lives
// here so the server and the UI agree on what is missing, and so it can be
// tested without a browser.
import type { AdbDevice, SetupInfo, ToolId } from './api-types.ts';

export const MIN_JAVA = 17;

/** How long a phone stays waiting on "Allow USB debugging?" before the guide offers the fix. */
export const ALLOW_HELP_AFTER_MS = 30_000;

export function javaIsUsable(java: SetupInfo['java']): boolean {
  return java.found && (java.major === undefined || java.major >= MIN_JAVA);
}

/** What "Set up this computer" would fetch, in the order it fetches them. */
export function missingTools(info: SetupInfo): ToolId[] {
  const missing: ToolId[] = [];
  if (!info.adb.found) missing.push('adb');
  if (!javaIsUsable(info.java)) missing.push('java');
  if (!info.maestro.found) missing.push('maestro');
  return missing;
}

export type WalkthroughStep = 'tools' | 'phone' | 'allow' | 'ready';

export type Walkthrough = {
  step: WalkthroughStep;
  /** The phone or emulator the step is about. */
  device?: AdbDevice;
};

/**
 * The one step the tester is on. It follows from what adb sees, so the guide
 * moves on by itself when a phone is plugged in or allows this computer.
 */
export function walkthrough(info: SetupInfo): Walkthrough {
  if (!info.adb.found) return { step: 'tools' };
  const ready = info.devices.find((device) => device.state === 'device');
  if (ready) return { step: 'ready', device: ready };
  const waiting = info.devices.find((device) => !device.emulator) ?? info.devices[0];
  return waiting ? { step: 'allow', device: waiting } : { step: 'phone' };
}

/**
 * Whether the guide opens by itself when the studio starts: Ariadne cannot work
 * yet, or this project has never connected and nothing is ready. Someone who
 * has connected before starts straight at the Device card, even with no phone
 * plugged in yet.
 */
export function opensByItself(info: SetupInfo, connected: boolean, lastDeviceId: string | undefined): boolean {
  if (connected) return false;
  if (!info.adb.found) return true;
  return !lastDeviceId && !info.devices.some((device) => device.state === 'device');
}
