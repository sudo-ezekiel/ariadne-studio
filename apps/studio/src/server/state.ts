import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DeviceInfo,
  DeviceSession,
  DeviceSnapshot,
  MaestroRunner,
  OpenOptions,
  PhoneInputTools,
  ProjectStore,
  Recorder,
  RunSummary,
  ScreenCapture,
  CaseStep,
  Expectation,
  SuiteRun,
  TestCase,
} from '@ariadne/core';
import type { CaseView, CurrentCaseView, RunView, ScreenState, SnapshotNodeLite, StepView } from '../shared/api-types.ts';
import type { LogBuffer } from './log-buffer.ts';
import type { PhoneCapture } from './phone-capture.ts';
import type { FrameRunVideoInput } from './run-video.ts';

/** The DeviceSession methods the server uses; tests substitute a fake. */
export type DeviceLike = Pick<
  DeviceSession,
  | 'isOpen'
  | 'deviceId'
  | 'appId'
  | 'listDevices'
  | 'snapshot'
  | 'capture'
  | 'tapAt'
  | 'typeText'
  | 'back'
  | 'scroll'
  | 'replayFlow'
  | 'close'
  | 'relaunchApp'
  | 'openLink'
  | 'hideKeyboard'
  | 'longPressAt'
  | 'doubleTapAt'
  | 'swipe'
  | 'pinch'
  | 'pressKey'
  | 'setOrientation'
> & { open(options: OpenOptions): Promise<void> };

/** How Replay runs the Maestro CLI; tests substitute a fake runner. */
export type MaestroTools = {
  run: MaestroRunner;
  /** Path of the Maestro CLI; throws when it is not installed. */
  findBin: () => string;
  androidHome: () => string | undefined;
  timeoutMs: number;
  /** Path of ffmpeg, which puts the steps beside the phone in a run video; undefined when there is none. */
  findFfmpeg: () => string | undefined;
  /** Replaces a run's phone video with the framed one. Throws to leave the phone video in place. */
  frameVideo: (input: FrameRunVideoInput) => Promise<void>;
};

export type Latest = ScreenCapture & {
  /** The phone showed nothing, because it is asleep or locked. See hidden-screen.ts in core. */
  hidden?: boolean;
  /** The screen blocks screenshots, but its elements came through. */
  secure?: boolean;
  /** What is in front, when it is not the app the case starts from. */
  elsewhere?: { app: string; home: boolean };
};

/** A saved case being changed in the recorder: re-recorded from a step, or extended in the middle. */
export type EditingState = {
  caseId: string;
  mode: 'rerecord' | 'insert';
  keptSteps: number;
  /** Saved steps that go after the new ones on Finish (insert mode). */
  tail: CaseStep[];
  /** The case's end expectations before the edit, to pre-tick in the picker. */
  originalExpectations: Expectation[];
  /** New screenshots are numbered from here; Discard deletes them and nothing else. */
  firstNewEvidence: number;
};

/** Run all, in the background. */
export type SuiteJob = {
  run: SuiteRun;
  stopRequested: boolean;
  done: Promise<void>;
};

/**
 * Everything the server holds: one project, one device session, at most one
 * case being recorded, and the latest capture the UI is looking at.
 */
export type ServerState = {
  project: ProjectStore;
  session: DeviceLike;
  maestro: MaestroTools;
  recorder?: Recorder;
  editing?: EditingState;
  /** The recording is for a block: its steps go to the form, and it never becomes a case. */
  recordingBlock?: boolean;
  suite?: SuiteJob;
  latest?: Latest;
  /** The screen the end checks on offer came from: picks are positions in that list, and the mirror moves on. */
  offered?: Latest;
  /** Where screenshots go when no case is recording them. */
  scratchDir: string;
  /** What touches on the phone need from adb; tests substitute a fake. */
  phoneTools: PhoneInputTools;
  /** The phone that has said whether it is locked: if it stops saying, it counts as locked. */
  lockAnswered?: string;
  /** Recording from a finger on the phone, while that is on. */
  phone?: PhoneCapture;
  /** Why recording from the phone stopped by itself. */
  phoneError?: string;
  /** The end of the studio's log, when it is running for real. */
  log?: LogBuffer;
  /** Serialises device work so overlapping clicks run one after another. */
  queue: Promise<unknown>;
};

export async function createState(project: ProjectStore, session: DeviceLike, maestro: MaestroTools, phoneTools: PhoneInputTools): Promise<ServerState> {
  const scratchDir = await mkdtemp(join(tmpdir(), 'ariadne-studio-'));
  return { project, session, maestro, scratchDir, phoneTools, queue: Promise.resolve() };
}

/** Runs `task` after every previously queued device task has finished. */
export function enqueue<T>(state: ServerState, task: () => Promise<T>): Promise<T> {
  const run = state.queue.then(task, task);
  state.queue = run.catch(() => undefined);
  return run;
}

export function scratchScreenshot(state: ServerState): string {
  return join(state.scratchDir, 'screen.png');
}

/** Where a capture lands first. Nothing serves this file, so a lock screen in it can be dealt with before anyone can read it. */
export function capturingScreenshot(state: ServerState): string {
  return join(state.scratchDir, 'capturing.png');
}

type LiteSource = DeviceSnapshot['nodes'][number];

/** Drops what the UI cannot use: hidden or covered nodes and every field it does not read. */
export function toLiteNode(node: LiteSource): SnapshotNodeLite {
  const lite: SnapshotNodeLite = {};
  if (node.ref) lite.ref = node.ref;
  const role = node.role ?? node.kind;
  if (role) lite.role = role;
  if (node.label) lite.label = node.label;
  if (node.contentDescription) lite.contentDescription = node.contentDescription;
  if (node.identifier) lite.identifier = node.identifier;
  if (node.rect) lite.rect = { ...node.rect };
  if (node.hittable !== undefined) lite.hittable = node.hittable;
  if (node.systemBar) lite.systemBar = node.systemBar;
  return lite;
}

export function toScreenState(latest: Latest): ScreenState {
  return {
    width: latest.viewport.width,
    height: latest.viewport.height,
    imageUrl: `/api/screen/image?ts=${Date.parse(latest.takenAt) || Date.now()}`,
    takenAt: latest.takenAt,
    nodes: latest.nodes
      .filter((node) => node.visibleToUser !== false && node.interactionBlocked === undefined && node.rect)
      .map(toLiteNode),
    ...(latest.hidden ? { hidden: true } : {}),
    ...(latest.secure ? { secure: true } : {}),
    ...(latest.elsewhere ? { elsewhere: latest.elsewhere } : {}),
  };
}

export function evidenceUrl(projectRelative: string): string {
  // evidence/<caseId>/<file> -> /api/evidence/<caseId>/<file>
  const [, caseId, file] = projectRelative.split('/');
  return `/api/evidence/${encodeURIComponent(caseId ?? '')}/${encodeURIComponent(file ?? '')}`;
}

export function toStepView<T extends { screenshot?: string }>(step: T): T & { screenshotUrl?: string } {
  return step.screenshot ? { ...step, screenshotUrl: `${evidenceUrl(step.screenshot)}?ts=${Date.now()}` } : step;
}

export function toCaseView(testCase: TestCase): CaseView {
  return { ...testCase, steps: testCase.steps.map((step) => toStepView(step) as StepView) };
}

export function currentCaseView(state: ServerState): CurrentCaseView | null {
  if (!state.recorder?.active) return null;
  const view = toCaseView(state.recorder.toCase());
  const editing = state.editing;
  if (state.recordingBlock) return { ...view, forBlock: true };
  return editing
    ? { ...view, editing: { mode: editing.mode, keptSteps: editing.keptSteps, tailSteps: editing.tail.length } }
    : view;
}

export function suiteRunning(state: ServerState): boolean {
  return state.suite?.run.status === 'running';
}

/** `editedAt` is the case's, to mark runs that started before its last edit. */
export function toRunView(summary: RunSummary, editedAt?: string): RunView {
  const base = `/api/runs/${encodeURIComponent(summary.runId)}`;
  return {
    ...summary,
    steps: summary.steps.map((step) => {
      const name = step.replayScreenshot?.split('/').pop()?.replace(/\.png$/, '');
      return name ? { ...step, replayScreenshotUrl: `${base}/shots/${encodeURIComponent(name)}` } : step;
    }),
    ...(summary.failureScreenshot ? { screenshotUrl: `${base}/screenshot` } : {}),
    ...(summary.video ? { videoUrl: `${base}/video.mp4` } : {}),
    reportUrl: `${base}/report`,
    stale: Boolean(editedAt && summary.startedAt < editedAt),
  };
}

export type { DeviceInfo };
