import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  createAgentDeviceClient,
  normalizeAgentDeviceError,
  type AgentDeviceClient,
  type SnapshotNode,
} from 'agent-device';

export { AppError, isAgentDeviceError } from 'agent-device';
import { androidHome } from '../replay/maestro-bin.ts';
import type { PhoneKey, ScreenOrientation } from '../recorder/case-types.ts';
import type { Point, Rect, Viewport } from './hit-test.ts';

const execFileAsync = promisify(execFile);

/** How long Maestro 2.12 holds a longPressOn. */
const LONG_PRESS_MS = 3000;

/** adb from the Android SDK when there is one, else whatever is on PATH. */
export function adbPath(): string {
  const home = androidHome();
  const candidate = home ? join(home, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : undefined;
  return candidate && existsSync(candidate) ? candidate : 'adb';
}

export type DeviceInfo = {
  id: string;
  name: string;
  platform: string;
  kind: string;
  booted: boolean;
};

export type DeviceSnapshot = {
  nodes: SnapshotNode[];
  viewport: Viewport;
  takenAt: string;
  /** Where the on-screen keyboard is, when it is open. */
  keyboard?: Rect;
};

export type ScreenCapture = DeviceSnapshot & {
  screenshotPath: string;
};

export type DeviceSessionOptions = {
  /** agent-device session name; one session holds one device at a time. */
  sessionName?: string;
  /** Working directory agent-device resolves relative paths against. */
  cwd?: string;
  /** agent-device state directory; defaults to defaultStateDir(). */
  stateDir?: string;
  /** Screenshot downscale factor, 0.01 to 1. */
  screenshotScale?: number;
  /** Injected client, for tests. */
  client?: AgentDeviceClient;
};

export type OpenOptions = {
  deviceId: string;
  appId: string;
  /** Terminate the app first, so the screen matches what Maestro's launchApp produces. */
  relaunch?: boolean;
};

/**
 * agent-device's own default for an installed package: AGENT_DEVICE_STATE_DIR,
 * else ~/.agent-device.
 *
 * The client is always given this explicitly. Without a state dir, the client
 * sends `replay` to a private one-shot daemon instead of the shared one; that
 * daemon cannot use a device this session already holds (DEVICE_IN_USE) and
 * keeps running afterwards. With it, a block replays inside this session.
 */
export function defaultStateDir(): string {
  return process.env.AGENT_DEVICE_STATE_DIR || join(homedir(), '.agent-device');
}

/** Code and message for an agent-device failure, for logs and HTTP responses. */
export function describeDeviceError(error: unknown): { code: string; message: string; hint?: string } {
  const normalized = normalizeAgentDeviceError(error);
  return normalized.hint
    ? { code: normalized.code, message: normalized.message, hint: normalized.hint }
    : { code: normalized.code, message: normalized.message };
}

/** True when a phone would not install the helper agent-device needs: nobody confirmed on the phone, or a maker's policy refused. */
export function installRefused(error: unknown): boolean {
  const normalized = normalizeAgentDeviceError(error);
  return normalized.details?.adbFailure === 'install_failed' || normalized.message.includes('INSTALL_FAILED_USER_RESTRICTED');
}

/**
 * The process of a daemon that started and then stopped making progress, which
 * agent-device's error names. It stalled on about one fresh Windows machine in
 * five (and always under Wine), and while it lives it holds the registration
 * lock, so every later start fails with "Daemon registration busy".
 */
export function stalledDaemon(error: unknown): number | undefined {
  const details = normalizeAgentDeviceError(error).details as { kind?: unknown; reason?: unknown; daemonProcess?: { pid?: unknown } } | undefined;
  if (details?.kind !== 'daemon_startup_failed' || details.reason !== 'startup-stalled') return undefined;
  const pid = details.daemonProcess?.pid;
  // Zero and negative numbers would signal a whole process group, or everything.
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function stopProcess(pid: number): Promise<void> {
  if (process.platform === 'win32') await execFileAsync('taskkill', ['/pid', String(pid), '/t', '/f'], { timeout: 15_000, windowsHide: true });
  else process.kill(pid, 'SIGKILL');
}

function viewportFrom(value: unknown): Viewport | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { width, height } = value as { width?: unknown; height?: unknown };
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) return undefined;
  return { width, height };
}

function keyboardFrom(value: unknown): Rect | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind, frame } = value as { kind?: unknown; frame?: Rect };
  return (kind === 'visible' || kind === 'derived') && frame ? frame : undefined;
}

/**
 * agent-device's JSON serialisation may drop a label or identifier that equals
 * the nearest ancestor's and mark the node with `inheritsLabel` or
 * `inheritsIdentifier`. Selector choice needs the real values, so put them back.
 */
export function restoreInheritedValues(nodes: SnapshotNode[]): SnapshotNode[] {
  if (!nodes.some((node) => node.inheritsLabel || node.inheritsIdentifier)) return nodes;
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  const inherited = (node: SnapshotNode, key: 'label' | 'identifier'): string | undefined => {
    let parent = node.parentIndex === undefined ? undefined : byIndex.get(node.parentIndex);
    while (parent) {
      if (parent[key]) return parent[key];
      parent = parent.parentIndex === undefined ? undefined : byIndex.get(parent.parentIndex);
    }
    return undefined;
  };
  return nodes.map((node) => {
    const restored = { ...node };
    if (node.inheritsLabel && !node.label) restored.label = inherited(node, 'label');
    if (node.inheritsIdentifier && !node.identifier) restored.identifier = inherited(node, 'identifier');
    return restored;
  });
}

/**
 * Thin wrapper over one agent-device client bound to one Android device. No
 * recording logic and no HTTP: methods do one device operation each and let
 * agent-device errors propagate unchanged (use describeDeviceError for display).
 */
export class DeviceSession {
  readonly client: AgentDeviceClient;
  private readonly screenshotScale: number;
  private viewport: Viewport | undefined;
  private target: { deviceId: string; appId: string } | undefined;

  constructor(options: DeviceSessionOptions = {}) {
    this.client =
      options.client ??
      createAgentDeviceClient({
        session: options.sessionName ?? 'studio',
        stateDir: options.stateDir ?? defaultStateDir(),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
    this.screenshotScale = options.screenshotScale ?? 0.5;
  }

  get deviceId(): string | undefined {
    return this.target?.deviceId;
  }

  get appId(): string | undefined {
    return this.target?.appId;
  }

  get isOpen(): boolean {
    return this.target !== undefined;
  }

  /**
   * Runs a call that may be the one that starts agent-device's daemon. If the
   * daemon stalls, ends it and tries once more: nothing recovers while it lives.
   */
  private async startingDaemon<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const pid = stalledDaemon(error);
      if (pid === undefined) throw error;
      console.error(`[studio] agent-device's daemon stalled at start (${describeDeviceError(error).message}). Ending process ${pid} and starting it again.`);
      await stopProcess(pid);
      return call();
    }
  }

  /** Booted Android devices, for the device picker. */
  async listDevices(): Promise<DeviceInfo[]> {
    const devices = await this.startingDaemon(() => this.client.devices.list({ platform: 'android' }));
    return devices
      .filter((device) => device.platform === 'android' && device.booted === true)
      .map((device) => ({
        id: device.id,
        name: device.name,
        platform: device.platform,
        kind: device.kind,
        booted: true,
      }));
  }

  /**
   * Opens (or brings to the front) `appId` on `deviceId`.
   *
   * agent-device's `device` option matches the device name, not its id, so the
   * adb serial is passed as `serial`; for Android the device id from
   * listDevices is that serial.
   *
   * `testIme: false` keeps the device's real keyboard. agent-device otherwise
   * swaps in a headless test keyboard on emulators, and then a recorded Back
   * leaves a screen that, on Maestro replay with the real keyboard showing,
   * only closes the keyboard. Recording against the real keyboard keeps the
   * two in step.
   */
  async open({ deviceId, appId, relaunch = false }: OpenOptions): Promise<void> {
    const result = await this.startingDaemon(() =>
      this.client.apps.open({
        app: appId,
        platform: 'android',
        serial: deviceId,
        foreground: true,
        relaunch,
        testIme: false,
      }),
    );
    this.target = { deviceId, appId };
    this.viewport = viewportFrom(result.snapshot?.viewport) ?? this.viewport;
  }

  /** Restarts the open app from a cold start, matching Maestro's launchApp. */
  async relaunchApp(): Promise<void> {
    if (!this.target) throw new Error('No app is open');
    await this.open({ ...this.target, relaunch: true });
  }

  /** Full accessibility snapshot of the current screen, without a screenshot. */
  async snapshot(): Promise<DeviceSnapshot> {
    const result = await this.client.capture.snapshot({ interactiveOnly: false });
    const viewport = viewportFrom(result.viewport) ?? this.viewport;
    if (!viewport) throw new Error('agent-device did not report the screen size for this snapshot');
    this.viewport = viewport;
    const keyboard = keyboardFrom(result.keyboard);
    return { nodes: restoreInheritedValues(result.nodes), viewport, takenAt: new Date().toISOString(), ...(keyboard ? { keyboard } : {}) };
  }

  /**
   * Snapshot first, then screenshot, so both describe the same screen as
   * closely as possible. The screenshot is written to `screenshotPath`.
   */
  async capture(screenshotPath: string): Promise<ScreenCapture> {
    const snapshot = await this.snapshot();
    await mkdir(dirname(screenshotPath), { recursive: true });
    const shot = await this.client.capture.screenshot({ path: screenshotPath, scale: this.screenshotScale });
    return { ...snapshot, screenshotPath: shot.path || screenshotPath };
  }

  /** Taps at a point in viewport pixels and waits for the UI to settle. */
  async tapAt(point: Point): Promise<void> {
    await this.client.interactions.press({ x: Math.round(point.x), y: Math.round(point.y), settle: true });
  }

  /**
   * Presses and holds at a point in viewport pixels for as long as Maestro's
   * longPressOn does (3 s, also agent-device's replay default), so an app
   * that reacts to the length of a hold sees the same press on replay.
   */
  async longPressAt(point: Point): Promise<void> {
    await this.client.interactions.longPress({ x: Math.round(point.x), y: Math.round(point.y), durationMs: LONG_PRESS_MS, settle: true });
  }

  async doubleTapAt(point: Point): Promise<void> {
    await this.client.interactions.press({ x: Math.round(point.x), y: Math.round(point.y), doubleTap: true, settle: true });
  }

  /**
   * Drags one finger from `from` to `to` (viewport pixels) over `durationMs`.
   * agent-device's own swipe is a fixed 100 ms fling with no duration, so
   * this is a pan, which moves at the speed Maestro's timed swipe does.
   */
  async swipe(from: Point, to: Point, durationMs: number): Promise<void> {
    const x = Math.round(from.x);
    const y = Math.round(from.y);
    await this.client.interactions.pan({ x, y, dx: Math.round(to.x) - x, dy: Math.round(to.y) - y, durationMs: Math.round(durationMs) });
  }

  /** Two-finger pinch around the middle of the screen: above 1 zooms in, below 1 zooms out. */
  async pinch(scale: number): Promise<void> {
    const viewport = this.viewport ?? (await this.snapshot()).viewport;
    await this.client.interactions.pinch({ scale, x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) });
  }

  /**
   * A phone key or button. Recent apps has no Maestro key, so nothing
   * recorded replays it; the studio offers it only while not recording.
   */
  async pressKey(key: PhoneKey | 'appSwitch'): Promise<void> {
    switch (key) {
      case 'home':
        await this.client.command.home();
        return;
      case 'appSwitch':
        await this.client.command.appSwitcher();
        return;
      case 'volumeUp':
        await this.client.command.hardwareButton({ button: 'volume-up' });
        return;
      case 'volumeDown':
        await this.client.command.hardwareButton({ button: 'volume-down' });
        return;
      case 'power':
        await this.client.command.hardwareButton({ button: 'power' });
        return;
      case 'enter':
        await this.client.command.keyboard({ action: 'enter' });
        return;
    }
  }

  /**
   * Rotates the screen and locks it there, as Maestro's setOrientation does.
   * agent-device waits until the display has turned and fails when it does
   * not, for example on a launcher that only runs in portrait.
   */
  async setOrientation(value: ScreenOrientation): Promise<void> {
    await this.client.command.orientation({ orientation: value === 'portrait' ? 'portrait' : 'landscape-left' });
  }

  /** Appends text to the focused field. */
  async typeText(text: string): Promise<void> {
    await this.client.interactions.type({ text });
  }

  /** System back, which is what Maestro's `back` command sends. */
  async back(): Promise<void> {
    await this.client.command.back({ mode: 'system', settle: true });
  }

  /**
   * Opens a URL or deep link the way Maestro's openLink does: a VIEW intent,
   * and the system picks the app that handles it. agent-device can only open
   * a link inside the session's own app (anything else fails, or asks for a
   * new session), so this goes through adb. The link is single-quoted for the
   * device shell, so it cannot run anything there.
   */
  async openLink(url: string): Promise<void> {
    if (!this.target) throw new Error('No app is open');
    const quoted = `'${url.replace(/'/g, `'\\''`)}'`;
    await execFileAsync(adbPath(), ['-s', this.target.deviceId, 'shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', quoted], {
      timeout: 30_000,
      windowsHide: true,
    });
  }

  /** Closes the on-screen keyboard, like Maestro's hideKeyboard. */
  async hideKeyboard(): Promise<void> {
    await this.client.command.keyboard({ action: 'dismiss' });
  }

  /**
   * Scrolls the main scrollable. 'down' swipes up and brings later content
   * into view, which is what Maestro's `scroll` does.
   */
  async scroll(direction: 'down' | 'up'): Promise<void> {
    await this.client.interactions.scroll({ direction, settle: true });
  }

  /**
   * Replays a Maestro flow file (a block) through agent-device inside this
   * session, so the app ends on the screen the block ends on. `env` fills
   * `${KEY}` in the YAML; its values are secrets and are not logged here.
   * A failing command rejects with agent-device's REPLAY_DIVERGENCE error.
   */
  async replayFlow(absolutePath: string, env: Readonly<Record<string, string>>): Promise<{ replayed: number }> {
    if (!this.target) throw new Error('No app is open');
    const result = await this.client.replay.run({
      path: absolutePath,
      backend: 'maestro',
      env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      serial: this.target.deviceId,
      platform: 'android',
      testIme: false,
    });
    // A block that closes its own session would leave the studio without one;
    // reopen it without a relaunch so the screen stays where the block left it.
    if (!result.sessionActive) await this.open({ ...this.target });
    return { replayed: result.replayed };
  }

  async close(): Promise<void> {
    this.target = undefined;
    await this.client.sessions.close();
  }
}
