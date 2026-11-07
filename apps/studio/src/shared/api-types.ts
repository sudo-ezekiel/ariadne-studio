// Request and response shapes shared by the studio server and UI. Type-only
// imports from core keep Node code out of the browser bundle.
import type {
  BlockUse,
  CaseHealth,
  CaseStep,
  ExpectationCandidate,
  MaestroSelector,
  MaestroStep,
  PhoneKey,
  Point,
  Rect,
  RunSummary,
  ScrollDirection,
  ScreenOrientation,
  StepResult,
  SuiteCounts,
  SuiteRun,
  TestCase,
} from '@ariadne/core/types';

/** The node fields the UI needs: rects for outlines, names for the hover caption. */
export type SnapshotNodeLite = {
  ref?: string;
  /** agent-device's `role`, or its normalized `kind` when (as on Android) there is no role. */
  role?: string;
  /** Visible text on Android (agent-device has no separate `text` field), else the accessible name. */
  label?: string;
  contentDescription?: string;
  identifier?: string;
  rect?: Rect;
  hittable?: boolean;
  systemBar?: 'status' | 'navigation';
};

export type ScreenState = {
  /** Viewport size in device pixels; node rects and tap points use this space. */
  width: number;
  height: number;
  imageUrl: string;
  takenAt: string;
  nodes: SnapshotNodeLite[];
  /** The phone shows nothing, because it is asleep or locked: nothing can be pressed or recorded until it is back. */
  hidden?: boolean;
  /** The screen blocks screenshots, so the picture is black, but its elements came through and can be recorded. */
  secure?: boolean;
  /** What is in front, when it is not the app the case starts from. */
  elsewhere?: { app: string; home: boolean };
};

export type ApiErrorBody = { error: { code: string; message: string } };

export type DeviceInfo = {
  id: string;
  name: string;
  platform: string;
  kind: string;
  booted: boolean;
};

export type BlockSummary = {
  file: string;
  name: string;
  stepCount?: number;
  /** What each command of the block does, in words. */
  steps?: string[];
  /** ${KEY} variables the block uses. */
  variables?: string[];
  /** Variables the block uses that neither .env, project.json nor the block itself sets. */
  missingVariables?: string[];
  /**
   * Variables a case can set on this block: the ones without a default in
   * the block's own env header (Maestro would ignore a value set on those).
   */
  settable?: string[];
  /** The block clears the app's data (launchApp with clearState), so it undoes what came before it. */
  clearsAppData?: boolean;
  /**
   * How the studio runs it: agent-device, or the Maestro CLI for a block
   * that uses commands outside Ariadne's subset (slower to start). Unset
   * when `error` is.
   */
  runsWith?: 'agent-device' | 'maestro';
  /** The commands and header keys only Maestro runs, e.g. ["runScript"]. */
  maestroOnly?: string[];
  /** Set when the file is not a Maestro flow at all; such a block cannot be used. */
  error?: string;
  /** Ariadne reads every command and key of the file, so the Blocks tab can change it. */
  editable?: boolean;
};

/** A block opened in the Blocks tab. */
export type BlockDetail = {
  file: string;
  name: string;
  appId: string;
  steps: MaestroStep[];
  /** Variables the file gives a value in its own header, which a case cannot change. */
  fixed: string[];
  /** The names of the saved cases and other blocks that run it. */
  usedBy: string[];
  /** Saving rewrites the file from its steps, so comments in it would go. */
  hasComments: boolean;
};

export type BlockSaveRequest = {
  name: string;
  steps: MaestroStep[];
  /** Which app a new block is for. An existing block keeps its own. */
  appId?: string;
};

/** A saved case as a new block, for the form to open unsaved. */
export type CaseBlockDraft = { name: string; appId: string; steps: MaestroStep[] };

/** The steps of a recording made for a block, ready to add to the form. */
export type BlockRecordingResponse = { steps: MaestroStep[] };

/** What a click on the screen would press, for a step of a block. */
export type ScreenPick = {
  selector: MaestroSelector;
  /** The element is a password field, so typing into it must use a setting. */
  password: boolean;
  resolved?: SnapshotNodeLite;
};

export type SavedValuesRequest = { values: Record<string, string> };

export type CaseSummary = {
  id: string;
  name: string;
  createdAt: string;
  stepCount: number;
  startFrom?: string;
  editedAt?: string;
  muted?: boolean;
};

/** A saved case in the list: its recent runs and how many cases start from it. */
export type CaseListItem = CaseSummary & { health: CaseHealth; dependents: number };

export type ProjectInfo = {
  dir: string;
  /** Absolute block folders and flows folder, from project.json `paths` or the defaults. */
  paths: { blocks: string[]; flows: string };
  appId: string;
  platform: 'android';
  lastDeviceId?: string;
  blocks: BlockSummary[];
  /** Names of the saved values in .env and project.json env; never their values. */
  envKeys: string[];
  cases: CaseListItem[];
  /** True while Run all is going; device actions are refused until it ends. */
  suiteRunning: boolean;
  /** Keep a video of each run. */
  runVideo: boolean;
  /** False when this machine has no ffmpeg, so run videos show the phone without the steps. */
  videoHasSteps: boolean;
};

export type SessionInfo = { open: boolean; deviceId?: string; appId?: string };

/** One row of the Files sidebar. `path` is project-relative with forward slashes; send it back to list or open the entry. */
export type FileEntry = { path: string; name: string; kind: 'folder' | 'file' };

export type FileRootsResponse = { roots: FileEntry[] };

export type FileListResponse = { entries: FileEntry[] };

/** A file opened from the sidebar, read only. `truncated` means only the start of the file came back. */
export type FileContent = { path: string; name: string } & (
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'image'; url: string }
  | { kind: 'other'; size: number }
);

export type StepView = CaseStep & { screenshotUrl?: string };

export type CaseView = Omit<TestCase, 'steps'> & { steps: StepView[] };

/** Set while a saved case is being re-recorded from a step or extended in the middle. */
export type EditingInfo = {
  mode: 'rerecord' | 'insert';
  /** Steps kept from the saved case before the new ones. */
  keptSteps: number;
  /** Saved steps that go after the new ones (insert mode). */
  tailSteps: number;
};

export type CurrentCaseView = CaseView & {
  editing?: EditingInfo;
  /** These steps go into a block on Finish, and no case is saved. */
  forBlock?: boolean;
};

export type EditRequest = { mode: 'rerecord'; step: number } | { mode: 'insert'; after: number };

export type ActionResponse = {
  /** The step recorded by this action, when a case is active. */
  step?: StepView;
  screen: ScreenState;
  /** The node a tap resolved to, for the highlight outline. */
  resolved?: SnapshotNodeLite;
};

export type CaseStartRequest = {
  name: string;
  /** Blocks replayed in this order before recording: paths such as "blocks/login.yaml", or with values set. */
  blocks?: Array<string | BlockUse>;
  /** A saved case to replay first instead of blocks; the new case starts where it ends. */
  startFrom?: string;
};

export type CaseStartResponse = { caseId: string; screen: ScreenState };

export type ScrollRequest = { direction: ScrollDirection };

/** POST /api/action/swipe: a drag in viewport pixels; the step keeps whole percentages and 100 to 2000 ms. */
export type SwipeRequest = { from: Point; to: Point; durationMs: number };

/** POST /api/action/key. `appSwitch` (Recent apps) works only while not recording: Maestro has no key for it. */
export type KeyRequest = { key: PhoneKey | 'appSwitch' };

/** POST /api/action/rotate: the orientation to turn the screen to. */
export type RotateRequest = { orientation: ScreenOrientation };

/** POST /api/action/pinch: zoom around the middle of the screen; never recorded (Maestro has no pinch). */
export type PinchRequest = { zoom: 'in' | 'out' };

export type CandidatesResponse = {
  candidates: ExpectationCandidate[];
  /** Ids to tick at first: when re-recording, the old end expectations that are still on screen. */
  preselected?: number[];
};

/** Candidate ids from GET /api/case/candidates, appended as end-of-case assertVisible. */
export type CaseFinishRequest = { picks?: number[] };

export type CaseFinishResponse = {
  caseId: string;
  /** Absolute path of the written flow. */
  flowPath: string;
  /** Same path relative to the project directory. */
  flowFile: string;
  yaml: string;
};

export type StepResultView = StepResult & { replayScreenshotUrl?: string };

export type RunView = Omit<RunSummary, 'steps'> & {
  steps: StepResultView[];
  /** Maestro's screenshot of the failing step, when there is one. */
  screenshotUrl?: string;
  /** The run video, when "Keep a video of each run" was on. */
  videoUrl?: string;
  /** Self-contained HTML report of this run. */
  reportUrl: string;
  /** The case was edited after this run started; its rows may not line up. */
  stale: boolean;
};

export type CaseRef = { id: string; name: string };

export type CaseDetailResponse = {
  case: CaseView;
  /** flows/<caseId>.yaml as it is on disk. */
  yaml: string;
  /** Newest first. */
  runs: RunView[];
  health: CaseHealth;
  /** The case this one starts from. */
  parent?: CaseRef;
  /** Cases that start from this one. */
  dependents: CaseRef[];
};

export type CasePatch = { name?: string; muted?: boolean };
/** `review: null` says someone has looked at a flagged step. */
export type StepPatch = { title?: string; note?: string; review?: null };

export type SuiteView = SuiteRun & { counts: SuiteCounts; passed: boolean; reportUrl: string };

/** A program the studio needs on this computer. */
export type ToolCheck = { found: boolean; path?: string; version?: string };

/** One line of `adb devices -l`. */
export type AdbDevice = {
  serial: string;
  /** "device" when ready; else adb's word for the problem: "unauthorized", "offline", "no permissions", ... */
  state: string;
  model?: string;
  emulator: boolean;
  /** The virtual device an emulator is running. */
  avd?: string;
  /** Set on Xiaomi, Redmi and POCO phones, which need one more step before Run works. */
  xiaomi?: { driverOpensApps: boolean };
};

/** What the device setup guide checks on this computer. */
export type SetupInfo = {
  os: 'linux' | 'mac' | 'windows' | 'other';
  adb: ToolCheck;
  emulator: ToolCheck;
  maestro: ToolCheck;
  /** Maestro needs Java 17 or newer; `major` is the installed major version. */
  java: ToolCheck & { major?: number };
  /** Virtual devices created in Android Studio's Device Manager. */
  avds: string[];
  devices: AdbDevice[];
};

export type ToolId = 'adb' | 'java' | 'maestro';

/** One tool of "Set up this computer". */
export type ToolProgress = {
  id: ToolId;
  name: string;
  state: 'waiting' | 'downloading' | 'unpacking' | 'checking' | 'done' | 'failed';
  received: number;
  total: number;
  /** Why it failed, written for the tester. */
  error?: string;
};

export type ToolInstallStatus = {
  /** False where Ariadne cannot fetch the tools itself; the guide then shows the manual steps. */
  available: boolean;
  running: boolean;
  /** What this computer can fetch, to say how much it is before the button. */
  offered: Array<{ id: ToolId; name: string; bytes: number }>;
  /** The current or last round. */
  tools: ToolProgress[];
};

/** Recording from a finger on the phone. `revision` changes whenever steps or the screen have. */
export type PhoneStatus = {
  active: boolean;
  /** The tester left the app, so touches are not being recorded until it is back. */
  paused: boolean;
  revision: number;
  /** Something the tester did that could not be recorded. */
  notice?: { id: number; text: string };
  /** Why recording from the phone stopped by itself. */
  error?: string;
};

export type PhonePrepareResponse = { ready: boolean };

/** Runs a setup block now, in the middle of the case being recorded. */
export type CaseBlockRequest = BlockUse;

/** A test user saved from the studio: `values` maps a block variable (USERNAME) to its value. */
export type TestUserRequest = { name: string; values: Record<string, string> };

/** The longest a Wait step can be. */
export const MAX_WAIT_SECONDS = 120;
/** What the Wait button offers. On a POCO F5 Pro, a tap on gov.gr failed 8 s after the page opened and worked at 16 s. */
export const DEFAULT_WAIT_SECONDS = 20;
