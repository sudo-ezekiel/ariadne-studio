// Recording from a finger on the phone. The mirror resolves a click before it
// presses, but a finger has already pressed by the time the studio hears of
// it, so while this runs the studio snapshots the screen constantly and reads
// each touch against the last snapshot from before it. What the touch meant is
// decided in @ariadne/core's phone-steps; this file owns the loop and the
// recorder calls.
//
// getevent is effectively a keylogger: a touch on the on-screen keyboard is a
// key press. Touches are never logged or stored, keyboard ones are dropped once
// their place is known, and text comes from the field, never from positions.
// A password field's text is not read at all.
import { appendFile, copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  DriverInstallRefused,
  TouchReader,
  describeDeviceError,
  focusedField,
  foregroundApp,
  percentOfScreen,
  readGesture,
  touchToViewport,
  typedChange,
  type CaseStep,
  type DeviceSnapshot,
  type GestureScreens,
  type PhoneAction,
  type PhoneInput,
  type PhoneScreen,
  type Point,
  type Recorder,
  type Rotation,
  type StepReview,
  type TouchGesture,
  type Viewport,
} from '@ariadne/core';
import type { PhonePrepareResponse, PhoneStatus } from '../shared/api-types.ts';
import { HttpError, MAX_SWIPE_MS, MIN_SWIPE_MS, captureInto, captureScratch, projectEnv, requireCase, requireSession } from './common.ts';
import { enqueue, type ServerState } from './state.ts';

/** Pause between snapshots; a snapshot itself takes about 100 ms on a phone. */
const SNAPSHOT_GAP_MS = 20;
/** Snapshots kept to read touches against. */
const HISTORY = 40;
/** How long a touch waits for a snapshot that began after it... */
const AT_TOUCH_WAIT_MS = 250;
/** ...and longer just after a field took focus, when that snapshot says whether the touch was a key. */
const OPENING_WAIT_MS = 1000;
/** A keyboard reported by now is reported at all: it took up to 860 ms on the test phone. */
const KEYBOARD_OPENS_WITHIN_MS = 1500;
/** Screenshots wait until the screen has had time to settle after the last touch... */
const EVIDENCE_DELAY_MS = 900;
/** ...but a long burst of touches does not put them off for ever. */
const EVIDENCE_LIMIT_MS = 4000;
/** About three seconds of failures in a row means the phone is gone or locked. */
const MAX_SNAPSHOT_FAILURES = 25;
/** A touch read against a snapshot older than this may be against an old screen. */
const STALE_SNAPSHOT_MS = 1000;
/** The notification shade: not part of the app, though it covers it. */
const SYSTEM_UI = 'com.android.systemui';

type SeenScreen = PhoneScreen & { app?: string; outside: boolean };

type Typing = {
  key: string;
  password: boolean;
  start: string;
  value: string;
  /** Keys pressed in a password field, whose text is not read. */
  secretKeys: number;
};

type PendingEvidence = { path: string; step: CaseStep };

/** Keeps the snapshot timings of about a quarter of an hour. */
const TIMINGS_KEPT = 4000;
/**
 * What one session of recording did, for a diagnostics report. Only counts and
 * timings: this outlives the session, and holds no touch and no text.
 */
type SessionCounts = {
  gestures: Record<string, number>;
  reviews: Record<string, number>;
  snapshotMs: number[];
  snapshotFailures: number;
  pauses: number;
  keyboardShownAfterMs: number[];
};

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export class PhoneCapture {
  private readonly reader: TouchReader;
  private readonly history: SeenScreen[] = [];
  private readonly deviceId: string;
  private readonly appId: string;
  private viewport: Viewport | undefined;
  private rotation: Rotation = 0;
  private stopped = false;
  private paused = false;
  private cameBack = false;
  private revision = 0;
  private noticeCount = 0;
  private notice: string | undefined;
  private typing: Typing | undefined;
  /** When the field being followed took focus. */
  private focusedAt = 0;
  private pending: PendingEvidence[] = [];
  private oldestPendingAt = 0;
  private lastUpAt = 0;
  private readonly startedAt = new Date().toISOString();
  private readonly counts: SessionCounts = { gestures: {}, reviews: {}, snapshotMs: [], snapshotFailures: 0, pauses: 0, keyboardShownAfterMs: [] };
  /** The field whose keyboard has not shown yet, for how long a keyboard takes to be reported. */
  private awaitingKeyboard = false;
  private gestures: Promise<void> = Promise.resolve();
  private loop: Promise<void> = Promise.resolve();
  private stopWatching: () => void = () => undefined;

  constructor(
    private readonly state: ServerState,
    private readonly input: PhoneInput,
  ) {
    this.deviceId = state.session.deviceId!;
    this.appId = state.session.appId!;
    this.reader = new TouchReader((raw) => this.toViewport(raw));
  }

  async start(): Promise<void> {
    this.rotation = await this.state.phoneTools.rotation(this.deviceId);
    this.stopWatching = this.state.phoneTools.watch(
      this.deviceId,
      this.input.screen.path,
      (line) => this.onLine(line),
      () => this.fail('The phone stopped sending touches. Check the cable, then start again.'),
    );
    this.loop = this.watchScreen();
  }

  status(): PhoneStatus {
    return {
      active: true,
      paused: this.paused,
      revision: this.revision,
      ...(this.notice ? { notice: { id: this.noticeCount, text: this.notice } } : {}),
    };
  }

  /** Ends the capture: finishes what is in hand, then leaves the screen current for the end checks. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopWatching();
    await this.loop;
    await this.gestures;
    const last = this.history.at(-1);
    if (last && !last.outside) this.noteField(last);
    await this.flushTyping();
    const pending = this.pending;
    this.pending = [];
    await enqueue(this.state, async () => {
      await this.captureFor(pending);
      if (pending.length === 0) await captureScratch(this.state);
    }).catch((error: unknown) => console.error(`[studio] phone recording ended without a last screen: ${describeDeviceError(error).message}`));
    await this.saveCounts().catch((error: unknown) => console.error(`[studio] could not save the phone session's counts: ${String(error)}`));
  }

  private async saveCounts(): Promise<void> {
    const { snapshotMs, ...counts } = this.counts;
    const sorted = [...snapshotMs].sort((a, b) => a - b);
    const line = {
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      appId: this.appId,
      touchScreen: this.input.screen,
      longPressMs: this.input.longPressMs,
      gestureNavigation: this.input.gestureNavigation,
      ...counts,
      snapshots: { count: sorted.length, medianMs: sorted[sorted.length >> 1] ?? 0, maxMs: sorted.at(-1) ?? 0 },
      ...(this.state.phoneError ? { stoppedBy: this.state.phoneError } : {}),
    };
    const path = this.state.project.path('diagnostics/phone-sessions.jsonl');
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(line)}\n`, 'utf8');
  }

  private toViewport(raw: Point): Point {
    return this.viewport ? touchToViewport(raw, this.input.screen, this.viewport, this.rotation) : { x: 0, y: 0 };
  }

  private onLine(line: string): void {
    const gesture = this.reader.read(line, Date.now());
    if (!gesture) return;
    this.lastUpAt = gesture.upAt;
    this.gestures = this.gestures
      .then(() => this.handle(gesture))
      .catch((error: unknown) => console.error(`[studio] could not record a touch: ${describeDeviceError(error).message}`));
  }

  private async watchScreen(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      try {
        await this.see();
        failures = 0;
        await this.takeDueEvidence();
      } catch (error) {
        failures += 1;
        this.counts.snapshotFailures += 1;
        if (failures >= MAX_SNAPSHOT_FAILURES) {
          this.fail(`Lost sight of the phone's screen: ${describeDeviceError(error).message}`);
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_GAP_MS));
    }
  }

  private async see(): Promise<void> {
    let startedAt = 0;
    const snapshot = await enqueue(this.state, (): Promise<DeviceSnapshot> => {
      startedAt = Date.now();
      return this.state.session.snapshot();
    });
    const endedAt = Date.now();
    const { viewport } = snapshot;
    this.counts.snapshotMs.push(endedAt - startedAt);
    if (this.counts.snapshotMs.length > TIMINGS_KEPT) this.counts.snapshotMs.shift();
    if (this.awaitingKeyboard && snapshot.keyboard) {
      this.awaitingKeyboard = false;
      this.counts.keyboardShownAfterMs.push(startedAt - this.focusedAt);
    }
    if (this.viewport && (this.viewport.width !== viewport.width || this.viewport.height !== viewport.height)) {
      this.rotation = await this.state.phoneTools.rotation(this.deviceId);
    }
    this.viewport = viewport;
    const screen: PhoneScreen = { nodes: snapshot.nodes, viewport, startedAt, endedAt, ...(snapshot.keyboard ? { keyboard: snapshot.keyboard } : {}) };
    const app = foregroundApp(screen);
    this.trackApp(app);
    if (!this.paused) this.noteField(screen);
    this.history.push({ ...screen, ...(app ? { app } : {}), outside: this.paused });
    if (this.history.length > HISTORY) this.history.shift();
  }

  /** Home, the launcher or the notification shade pause recording until the app is back. */
  private trackApp(app: string | undefined): void {
    if (app === this.appId && this.paused) {
      this.paused = false;
      this.cameBack = true;
      this.revision += 1;
    } else if (app !== undefined && !this.paused && (app === this.input.homeApp || app === SYSTEM_UI)) {
      this.paused = true;
      this.counts.pauses += 1;
      this.revision += 1;
    }
  }

  private async screensFor(gesture: TouchGesture): Promise<(GestureScreens & { before: SeenScreen; blank: boolean }) | undefined> {
    const keyboardOpening = this.typing !== undefined && gesture.downAt - this.focusedAt < KEYBOARD_OPENS_WITHIN_MS;
    const until = Date.now() + (keyboardOpening ? OPENING_WAIT_MS : AT_TOUCH_WAIT_MS);
    while (!this.history.some((screen) => screen.startedAt >= gesture.downAt) && Date.now() < until && !this.stopped) {
      await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_GAP_MS));
    }
    const finished = this.history.filter((screen) => screen.endedAt <= gesture.downAt);
    const usable = finished.filter((screen) => screen.app !== undefined);
    const before = usable.at(-1);
    if (!before) return undefined;
    const prior = usable.at(-2);
    const atTouch = this.history.find((screen) => screen.startedAt >= gesture.downAt);
    return {
      before,
      ...(prior ? { prior } : {}),
      ...(atTouch ? { atTouch } : {}),
      ...(keyboardOpening ? { keyboardOpening } : {}),
      blank: finished.at(-1) !== before || gesture.downAt - before.endedAt > STALE_SNAPSHOT_MS,
    };
  }

  private async handle(gesture: TouchGesture): Promise<void> {
    const screens = await this.screensFor(gesture);
    if (!screens || screens.before.outside) {
      this.typing = undefined;
      return;
    }
    const action = readGesture(gesture, screens, this.input);
    bump(this.counts.gestures, action.kind);
    await this.apply(action, screens, screens.blank ? 'screen-moving' : undefined);
  }

  private async apply(action: PhoneAction, screens: GestureScreens, moving: StepReview | undefined): Promise<void> {
    const { before } = screens;
    if (action.kind === 'keyboard') {
      this.noteField(this.sameFieldLater(screens) ?? before);
      if (this.typing?.password) this.typing.secretKeys += 1;
      if (!action.submits) return;
      await this.flushTyping();
      this.record('pressKey', undefined, (recorder, screenshot) => recorder.recordPressKey('enter', screenshot));
      return;
    }
    this.noteField(before);
    await this.flushTyping();
    switch (action.kind) {
      case 'tap': {
        const { node, point } = action;
        this.recordElement(
          'tap',
          (recorder, screenshot) => recorder.recordTap(node, point, before.viewport, screenshot, before.nodes),
          action.review ?? moving,
        );
        return;
      }
      case 'longPress': {
        const { node, point } = action;
        this.recordElement(
          'longPress',
          (recorder, screenshot) => recorder.recordLongPress(node, point, before.viewport, screenshot, before.nodes),
          action.review ?? moving,
        );
        return;
      }
      case 'swipe': {
        const from = percentOfScreen(action.from, before.viewport);
        const to = percentOfScreen(action.to, before.viewport);
        if (from.xPercent === to.xPercent && from.yPercent === to.yPercent) return;
        const duration = Math.min(MAX_SWIPE_MS, Math.max(MIN_SWIPE_MS, action.durationMs));
        this.record('swipe', undefined, (recorder, screenshot) => recorder.recordSwipe(from, to, duration, screenshot));
        return;
      }
      case 'back':
        this.record('back', undefined, (recorder, screenshot) => recorder.recordBack(screenshot));
        return;
      case 'home':
        this.record('pressKey', undefined, (recorder, screenshot) => recorder.recordPressKey('home', screenshot));
        return;
      case 'recents':
        this.tell('Recent apps was not recorded: Maestro cannot replay it.');
        return;
      case 'multiTouch':
        this.tell('A two-finger gesture was not recorded: Maestro cannot replay it.');
        return;
      case 'ignored':
        return;
    }
  }

  private tell(text: string): void {
    this.noticeCount += 1;
    this.notice = text;
    this.revision += 1;
  }

  /** Records a tap or long press; a point selector always needs a look, however it came about. */
  private recordElement(kind: 'tap' | 'longPress', write: (recorder: Recorder, screenshot: string) => CaseStep, review: StepReview | undefined): void {
    const step = this.record(kind, undefined, write, review);
    if (step.kind === kind && step.selector.kind === 'point' && !step.review) {
      this.state.recorder?.flagForReview(step, 'no-element');
      bump(this.counts.reviews, 'no-element');
    }
  }

  private record(
    kind: CaseStep['kind'],
    text: string | undefined,
    write: (recorder: Recorder, screenshot: string) => CaseStep,
    review?: StepReview,
  ): CaseStep {
    const recorder = requireCase(this.state);
    const evidence = this.state.project.evidencePath(recorder.caseId!, recorder.evidenceNumberForNext(kind, text));
    const step = write(recorder, evidence.relative);
    // Leaving the app comes first: a run cannot do that, whatever else is true of the step.
    const flag = this.cameBack ? 'left-app' : review;
    this.cameBack = false;
    if (flag) {
      recorder.flagForReview(step, flag);
      bump(this.counts.reviews, flag);
    }
    if (this.pending.length === 0) this.oldestPendingAt = Date.now();
    if (!this.pending.some((item) => item.path === evidence.absolute)) this.pending.push({ path: evidence.absolute, step });
    this.revision += 1;
    return step;
  }

  /** A snapshot from after the touch, when it still shows the same field: it has the last key typed. */
  private sameFieldLater({ atTouch, before }: GestureScreens): PhoneScreen | undefined {
    if (!atTouch) return undefined;
    const field = focusedField(before.nodes);
    return field && focusedField(atTouch.nodes)?.key === field.key ? atTouch : undefined;
  }

  /**
   * Follows the focused field. It runs on every snapshot, so `start` is the
   * text from before typing began and text that arrives without key presses
   * (a paste, autofill) still counts. Text not written yet keeps its place when
   * focus moves on; the next gesture writes it.
   */
  private noteField(screen: PhoneScreen): void {
    const field = focusedField(screen.nodes);
    if (!field) return;
    const typing = this.typing;
    if (typing?.key === field.key) {
      typing.value = field.value;
      return;
    }
    if (typing && (typing.value !== typing.start || typing.secretKeys > 0)) return;
    this.typing = { key: field.key, password: field.password, start: field.value, value: field.value, secretKeys: 0 };
    this.focusedAt = screen.startedAt;
    this.awaitingKeyboard = !screen.keyboard;
  }

  private async flushTyping(): Promise<void> {
    const typing = this.typing;
    if (!typing) return;
    if (typing.password) {
      if (typing.secretKeys === 0) return;
      typing.secretKeys = 0;
      const keys = Object.keys(await projectEnv(this.state)).sort();
      const key = keys.find((candidate) => /pass/i.test(candidate)) ?? 'PASSWORD';
      const text = `\${${key}}`;
      this.record('type', text, (recorder, screenshot) => recorder.recordInput(text, screenshot), 'password');
      return;
    }
    if (typing.value === typing.start) return;
    const { erase, text } = typedChange(typing.start, typing.value);
    typing.start = typing.value;
    if (erase > 0) this.record('erase', undefined, (recorder, screenshot) => recorder.recordErase(erase, screenshot), 'edited-text');
    if (!text) return;
    // Text equal to a saved value is written as its ${KEY}, as when typing from the studio.
    const env = await projectEnv(this.state);
    const saved = Object.keys(env)
      .sort()
      .find((candidate) => env[candidate] === text);
    const recorded = saved ? `\${${saved}}` : text;
    this.record('type', recorded, (recorder, screenshot) => recorder.recordInput(recorded, screenshot));
  }

  private async takeDueEvidence(): Promise<void> {
    if (this.pending.length === 0 || this.reader.touching) return;
    const now = Date.now();
    if (now < this.lastUpAt + EVIDENCE_DELAY_MS && now < this.oldestPendingAt + EVIDENCE_LIMIT_MS) return;
    const pending = this.pending;
    this.pending = [];
    await enqueue(this.state, () => this.captureFor(pending));
    this.revision += 1;
  }

  /** One screenshot serves every step waiting for one; steps it cannot serve lose theirs. */
  private async captureFor(pending: readonly PendingEvidence[]): Promise<void> {
    const [first, ...others] = pending;
    if (!first) return;
    try {
      await mkdir(dirname(first.path), { recursive: true });
      await captureInto(this.state, first.path);
      for (const other of others) await copyFile(first.path, other.path);
    } catch (error) {
      for (const item of pending) delete item.step.screenshot;
      console.error(`[studio] no screenshot for a phone step: ${describeDeviceError(error).message}`);
    }
  }

  private fail(message: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.state.phoneError = message;
    void stopPhoneCapture(this.state);
  }
}

/** Stops recording from the phone, if it is on. Never call this inside enqueue: it waits for queued work. */
export async function stopPhoneCapture(state: ServerState): Promise<void> {
  const capture = state.phone;
  if (!capture) return;
  state.phone = undefined;
  await capture.stop();
}

function phoneStatus(state: ServerState): PhoneStatus {
  if (state.phone) return state.phone.status();
  return { active: false, paused: false, revision: 0, ...(state.phoneError ? { error: state.phoneError } : {}) };
}

/** Puts Maestro's driver on the phone, saying why when it does not go on. */
async function installDriver(state: ServerState, deviceId: string): Promise<void> {
  let maestroBin: string;
  try {
    maestroBin = state.maestro.findBin();
  } catch (error) {
    throw new HttpError(500, 'MAESTRO_NOT_FOUND', error instanceof Error ? error.message : String(error));
  }
  try {
    await state.phoneTools.installDriver(deviceId, maestroBin);
  } catch (error) {
    if (error instanceof DriverInstallRefused) {
      throw new HttpError(502, 'PHONE_REFUSED_INSTALL', 'The phone did not allow the install. Watch the phone, tap Install when it asks, and press Prepare this phone again.');
    }
    throw new HttpError(502, 'DRIVER_INSTALL_FAILED', `Could not install Maestro's driver: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function registerPhoneRoutes(app: FastifyInstance, state: ServerState): void {
  app.get('/api/phone', async (): Promise<PhoneStatus> => phoneStatus(state));

  app.post('/api/phone/start', async (): Promise<PhoneStatus> => {
    requireSession(state);
    requireCase(state);
    if (state.phone) return phoneStatus(state);
    state.phoneError = undefined;
    return enqueue(state, async () => {
      const input = await state.phoneTools.read(state.session.deviceId!);
      if (!input) throw new HttpError(409, 'NO_TOUCHSCREEN', 'Ariadne cannot read the touchscreen of this device, so record on the screen here instead.');
      const capture = new PhoneCapture(state, input);
      await capture.start();
      state.phone = capture;
      return phoneStatus(state);
    });
  });

  app.post('/api/phone/stop', async (): Promise<PhoneStatus> => {
    await stopPhoneCapture(state);
    return phoneStatus(state);
  });

  /** Gets a Xiaomi phone ready for Run: installs Maestro's driver if needed and lets it open apps. */
  app.post('/api/phone/prepare', async (request): Promise<PhonePrepareResponse> => {
    const deviceId = (request.body as { deviceId?: unknown } | undefined)?.deviceId;
    if (typeof deviceId !== 'string' || !deviceId.trim()) throw new HttpError(400, 'BAD_REQUEST', 'Expected the "deviceId" of a phone.');
    await stopPhoneCapture(state);
    return enqueue(state, async () => {
      const before = await state.phoneTools.xiaomi(deviceId);
      if (!before) throw new HttpError(409, 'NOT_XIAOMI', 'Only Xiaomi, Redmi and POCO phones need this.');
      if (!before.driverInstalled) await installDriver(state, deviceId);
      await state.phoneTools.allowDriver(deviceId);
      return { ready: (await state.phoneTools.xiaomi(deviceId))?.driverOpensApps === true };
    });
  });
}
