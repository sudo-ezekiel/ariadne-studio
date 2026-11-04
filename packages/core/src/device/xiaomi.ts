// Xiaomi, Redmi and POCO phones (MIUI and HyperOS) ask on the phone before
// every adb install, and stop apps from opening other apps from the
// background. Maestro's driver opens the app under test that way, so its
// launchApp silently does nothing there (seen 2026-11-04 on a POCO F5 Pro with
// HyperOS 3: "MIUILOG- Permission Denied Activity", and Maestro still reported
// the command as completed). The driver needs that one permission, and has to
// stay installed between runs to keep it. Checked there the same day: the same
// launchApp flow failed with this op at ignore and passed with it at allow.

/** Maestro's two driver packages. */
const DRIVER_PACKAGES = ['dev.mobile.maestro', 'dev.mobile.maestro.test'] as const;
/** MIUI's app operation for "Open new windows while running in the background". */
const BACKGROUND_START_OP = '10021';

export type XiaomiPhone = {
  /** Maestro's driver is on the phone. */
  driverInstalled: boolean;
  /** The driver may open apps, so launchApp works. */
  driverOpensApps: boolean;
};

/** Runs `adb shell` with these arguments on one phone and returns what it printed. */
export type PhoneShell = (args: string[]) => Promise<string>;

/** `appops get <package> <op>` prints a line such as `MIUIOP(10021): allow; time=...`. */
export function appOpAllowed(output: string): boolean {
  return /:\s*allow\b/.test(output);
}

/** Undefined for any phone that is not Xiaomi's. */
export async function readXiaomiPhone(shell: PhoneShell): Promise<XiaomiPhone | undefined> {
  const miui = (await shell(['getprop', 'ro.miui.ui.version.name'])).trim();
  const hyperOs = (await shell(['getprop', 'ro.mi.os.version.name'])).trim();
  if (!miui && !hyperOs) return undefined;
  // Both, because the phone asks for each: accepting one prompt and missing the other leaves half a driver.
  const installed = new Set((await shell(['pm', 'list', 'packages', DRIVER_PACKAGES[0]])).split(/\r?\n/).map((line) => line.trim().replace(/^package:/, '')));
  const driverInstalled = DRIVER_PACKAGES.every((name) => installed.has(name));
  if (!driverInstalled) return { driverInstalled, driverOpensApps: false };
  return { driverInstalled, driverOpensApps: appOpAllowed(await shell(['appops', 'get', DRIVER_PACKAGES[0], BACKGROUND_START_OP])) };
}

/**
 * Ends a driver left on the phone. It keeps running after Maestro exits, since
 * only uninstalling it would have stopped it, and while it runs nothing else
 * can read the screen: agent-device fails with "helper output could not be parsed".
 */
export async function stopDriver(shell: PhoneShell): Promise<void> {
  for (const name of DRIVER_PACKAGES) await shell(['am', 'force-stop', name]);
}

/** Lets Maestro's driver open apps. This touches only the driver's own packages. */
export async function allowDriverToOpenApps(shell: PhoneShell): Promise<void> {
  for (const name of DRIVER_PACKAGES) await shell(['appops', 'set', name, BACKGROUND_START_OP, 'allow']);
}
