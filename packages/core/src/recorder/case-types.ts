// Case file shapes (cases/<caseId>.json). Type-only so the studio UI can
// import them without bundling Node code.
import type { Point, Rect } from '../device/hit-test.ts';
import type { MaestroSelector, PercentPoint } from '../maestro/model.ts';

/** The parts of a snapshot node worth keeping in the case file for later review. */
export type RecordedNode = {
  text?: string;
  label?: string;
  contentDescription?: string;
  identifier?: string;
  rect?: Rect;
};

/**
 * Why a step recorded from touches on the phone needs a person's eye. Touches
 * show where a finger went, not what the tester meant, so these steps may be
 * right and still need checking. Words for each are in describe.ts.
 */
export type StepReview = 'screen-moving' | 'no-element' | 'password' | 'edited-text' | 'left-app';

type StepBase = {
  /** 1-based position in the case. */
  index: number;
  /** Project-relative path of the screenshot taken after this step. */
  screenshot?: string;
  at: string;
  /** The BA's own name for the step; replaces the generated description in documents. */
  title?: string;
  /** Free text, usually the expected result in the BA's words. */
  note?: string;
  /** Set when recording could not be sure of this step; cleared once someone has looked. */
  review?: StepReview;
};

export type ScrollDirection = 'down' | 'up';

/**
 * Phone keys a case can press, each replayed by Maestro's pressKey. Recent
 * apps is not one of them: Maestro has no key for it, so the studio offers it
 * only while not recording.
 */
export type PhoneKey = 'home' | 'volumeUp' | 'volumeDown' | 'power' | 'enter';

export type ScreenOrientation = 'portrait' | 'landscape';

/** A setup block as one case uses it: the file, and the values the BA set on it. */
export type BlockUse = {
  /** Project-relative, e.g. "blocks/login.yaml". */
  file: string;
  /**
   * Variable to value: `${KEY}` for a saved value, or plain text (never for a
   * secret). Variables left out take the project's value of the same name.
   * See block-values.ts.
   */
  values?: Record<string, string>;
};

export type CaseStep =
  | (StepBase & { kind: 'tap'; selector: MaestroSelector; point: Point; node?: RecordedNode })
  /** Press and hold on an element (Maestro longPressOn); resolved like a tap. */
  | (StepBase & { kind: 'longPress'; selector: MaestroSelector; point: Point; node?: RecordedNode })
  | (StepBase & { kind: 'doubleTap'; selector: MaestroSelector; point: Point; node?: RecordedNode })
  /** A drag across the screen, in whole percentages of its size (Maestro swipe with start and end). */
  | (StepBase & { kind: 'swipe'; from: PercentPoint; to: PercentPoint; durationMs: number })
  | (StepBase & { kind: 'pressKey'; key: PhoneKey })
  /** Maestro setOrientation; landscape is the phone turned left (LANDSCAPE_LEFT). */
  | (StepBase & { kind: 'orientation'; value: ScreenOrientation })
  /** Typed text, or a `${KEY}` placeholder when the text matched a project env value. */
  | (StepBase & { kind: 'type'; text: string })
  /** Characters removed from the end of the focused field (Maestro eraseText). */
  | (StepBase & { kind: 'erase'; chars: number })
  | (StepBase & { kind: 'back' })
  /** An assertVisible recorded mid-flow (Expect mode); the device was not touched. */
  | (StepBase & { kind: 'expect'; selector: MaestroSelector; point: Point; node?: RecordedNode })
  | (StepBase & { kind: 'scroll'; direction: ScrollDirection })
  /** Restarts the app mid-case (Maestro launchApp). */
  | (StepBase & { kind: 'relaunch' })
  /** Opens a URL or deep link (Maestro openLink). */
  | (StepBase & { kind: 'openLink'; url: string })
  | (StepBase & { kind: 'hideKeyboard' })
  /**
   * A setup block run in the middle of the case (Maestro runFlow), e.g. log
   * out and log in as another user. `file` is project-relative, like
   * preconditionBlocks.
   */
  | (StepBase & { kind: 'block'; file: string; values?: Record<string, string> });

/** Picked when the case is finished; emitted as assertVisible after every step. */
export type Expectation = {
  selector: MaestroSelector;
  node?: RecordedNode;
  at: string;
};

export type TestCase = {
  id: string;
  name: string;
  appId: string;
  createdAt: string;
  deviceId: string;
  /**
   * Setup blocks that run before the first step, in order. Empty when
   * startFrom is set. Case files written before blocks had values store bare
   * paths; ProjectStore.readCase turns those into { file }.
   */
  preconditionBlocks: BlockUse[];
  /**
   * Id of a saved case whose flow runs first (Waldo's test dependency). Its flow
   * launches the app and runs its own blocks, so this case has no blocks of its own.
   */
  startFrom?: string;
  steps: CaseStep[];
  expectations: Expectation[];
  /** Set by every edit after recording; runs that started earlier are stale. */
  editedAt?: string;
  /** Skipped by Run all. */
  muted?: boolean;
  /**
   * Highest screenshot number ever used by this case, including steps since
   * deleted or replaced, so an edit never reuses one (absent in older cases).
   */
  lastEvidenceNumber?: number;
};
