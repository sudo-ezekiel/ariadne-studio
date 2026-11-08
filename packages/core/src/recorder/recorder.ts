import { posix } from 'node:path';
import type { Point, Viewport } from '../device/hit-test.ts';
import type { MaestroFlow, MaestroKey, MaestroOrientation, MaestroSelector, MaestroStep, PercentPoint } from '../maestro/model.ts';
import { chooseSelector, type SelectorNode } from '../maestro/selector.ts';
import type {
  BlockUse,
  CaseStep,
  Expectation,
  PhoneKey,
  RecordedNode,
  ScreenOrientation,
  ScrollDirection,
  StepReview,
  TestCase,
} from './case-types.ts';
import { caseFlowItems } from './flow-layout.ts';
import { recordedNode } from './recorded-node.ts';

export type {
  BlockUse,
  CaseStep,
  Expectation,
  PhoneKey,
  RecordedNode,
  ScreenOrientation,
  ScrollDirection,
  StepReview,
  TestCase,
} from './case-types.ts';

export type CaseMeta = {
  id: string;
  name: string;
  appId: string;
  deviceId: string;
  preconditionBlocks?: BlockUse[];
  /** A saved case whose flow runs first; exclusive with preconditionBlocks. */
  startFrom?: string;
  /** Project env keys handed to each precondition block as ${KEY}. */
  envKeys?: string[];
  createdAt?: string;
  /** Steps already in the case when recording resumes in the middle of it. */
  steps?: CaseStep[];
  /** End expectations already in the case (kept when steps are inserted). */
  expectations?: Expectation[];
  /**
   * Evidence numbers up to this one are taken (by steps being replaced, or files
   * on disk), so new screenshots start above it and never overwrite them.
   */
  evidenceFloor?: number;
  editedAt?: string;
  muted?: boolean;
  reference?: string;
};

export type StepKind = CaseStep['kind'];

/** The Maestro pressKey name of each phone key a case can record. */
export const MAESTRO_KEY_OF: Readonly<Record<PhoneKey, MaestroKey>> = {
  home: 'Home',
  volumeUp: 'Volume Up',
  volumeDown: 'Volume Down',
  power: 'Power',
  enter: 'Enter',
};

/** Landscape is the phone turned to the left, which agent-device calls landscape-left too (both set user_rotation 1). */
export const MAESTRO_ORIENTATION_OF: Readonly<Record<ScreenOrientation, MaestroOrientation>> = {
  portrait: 'PORTRAIT',
  landscape: 'LANDSCAPE_LEFT',
};

/** Where flows live inside the project; runFlow paths are relative to it. */
const FLOWS_DIR = 'flows';

/** How a case flow refers to a block; ProjectStore implements it for the project's own folders. */
export type FlowPaths = {
  /** The runFlow file of a block (project-relative), relative to the folder case flows are written to. */
  runFlowFile(blockFile: string): string;
};

/** blocks/ and flows/ inside the project. */
const DEFAULT_FLOW_PATHS: FlowPaths = {
  runFlowFile: (blockFile) => posix.relative(FLOWS_DIR, blockFile.split('\\').join('/')),
};

const ENV_PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

const EVIDENCE_NUMBER = /step-(\d+)\.png$/;

/** The number in evidence/<caseId>/step-NNN.png, or undefined for any other path. */
export function evidenceNumber(path: string | undefined): number | undefined {
  const match = path ? EVIDENCE_NUMBER.exec(path) : null;
  return match ? Number(match[1]) : undefined;
}

/** True for typed text that is exactly one `${KEY}` placeholder. */
export function isEnvPlaceholder(text: string): boolean {
  return ENV_PLACEHOLDER.test(text);
}

/** True when the focused field is a password field; typing there is recorded only as a placeholder. */
export function focusedPasswordField(nodes: ReadonlyArray<{ focused?: boolean; password?: boolean }>): boolean {
  return nodes.some((node) => node.focused === true && node.password === true);
}

/** In-memory state of the one case being recorded. */
export class Recorder {
  private meta: CaseMeta | undefined;
  private steps: CaseStep[] = [];
  private expectations: Expectation[] = [];
  private createdAt = '';
  /** Highest evidence number in use; the next new step gets the one above. */
  private evidenceCounter = 0;
  /** Steps the case resumed with; they are kept as they are, so nothing merges into them. */
  private keptSteps = 0;
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  get active(): boolean {
    return this.meta !== undefined;
  }

  get caseId(): string | undefined {
    return this.meta?.id;
  }

  start(meta: CaseMeta): void {
    this.meta = {
      ...meta,
      preconditionBlocks: meta.startFrom ? [] : structuredClone(meta.preconditionBlocks ?? []),
    };
    this.steps = (meta.steps ?? []).map((step, position) => ({ ...structuredClone(step), index: position + 1 }));
    this.expectations = (meta.expectations ?? []).map((expectation) => structuredClone(expectation));
    this.createdAt = meta.createdAt ?? this.now().toISOString();
    this.keptSteps = this.steps.length;
    this.evidenceCounter = Math.max(
      meta.evidenceFloor ?? 0,
      this.steps.length,
      ...this.steps.map((step) => evidenceNumber(step.screenshot) ?? 0),
    );
  }

  /** Steps recorded so far, including any the case resumed with. */
  get stepCount(): number {
    return this.steps.length;
  }

  /**
   * The evidence number for the screenshot of the next step of `kind`. Typing
   * right after typing merges into the previous step, so it reuses that step's
   * number (the new capture overwrites its screenshot). Pass the text for
   * `type`: a `${KEY}` placeholder never merges. For a new case the numbers
   * equal the step indexes; after edits they keep counting up, so a number is
   * never reused for a different step.
   */
  evidenceNumberForNext(kind: StepKind, text?: string): number {
    const last = this.steps.at(-1);
    if (kind === 'type' && this.mergesIntoLast(text)) return evidenceNumber(last!.screenshot) ?? this.evidenceCounter + 1;
    return this.evidenceCounter + 1;
  }

  /**
   * Records a tap. `node` is the hit-tested node or undefined for a bare point;
   * `allNodes` is the snapshot it came from, needed for uniqueness and index.
   */
  recordTap(
    node: SelectorNode | undefined,
    point: Point,
    viewport: Viewport,
    screenshotPath: string | undefined,
    allNodes: readonly SelectorNode[],
  ): CaseStep {
    this.requireActive();
    const step: CaseStep = {
      index: this.steps.length + 1,
      kind: 'tap',
      selector: chooseSelector(node, allNodes, point, viewport),
      point: { x: Math.round(point.x), y: Math.round(point.y) },
      ...(node ? { node: recordedNode(node) } : {}),
      ...(screenshotPath ? { screenshot: screenshotPath } : {}),
      at: this.now().toISOString(),
    };
    return this.push(step);
  }

  /** Records a press and hold, with the same element and selector a tap at `point` would get. */
  recordLongPress(
    node: SelectorNode | undefined,
    point: Point,
    viewport: Viewport,
    screenshotPath: string | undefined,
    allNodes: readonly SelectorNode[],
  ): CaseStep {
    return this.recordOnElement('longPress', node, point, viewport, screenshotPath, allNodes);
  }

  /** Records a double tap, with the same element and selector a tap at `point` would get. */
  recordDoubleTap(
    node: SelectorNode | undefined,
    point: Point,
    viewport: Viewport,
    screenshotPath: string | undefined,
    allNodes: readonly SelectorNode[],
  ): CaseStep {
    return this.recordOnElement('doubleTap', node, point, viewport, screenshotPath, allNodes);
  }

  private recordOnElement(
    kind: 'longPress' | 'doubleTap',
    node: SelectorNode | undefined,
    point: Point,
    viewport: Viewport,
    screenshotPath: string | undefined,
    allNodes: readonly SelectorNode[],
  ): CaseStep {
    this.requireActive();
    const step: CaseStep = {
      index: this.steps.length + 1,
      kind,
      selector: chooseSelector(node, allNodes, point, viewport),
      point: { x: Math.round(point.x), y: Math.round(point.y) },
      ...(node ? { node: recordedNode(node) } : {}),
      ...(screenshotPath ? { screenshot: screenshotPath } : {}),
      at: this.now().toISOString(),
    };
    return this.push(step);
  }

  /** Marks a step as needing a person's eye, after it was recorded. */
  flagForReview(step: CaseStep, review: StepReview): void {
    step.review = review;
  }

  /** Records a drag from `from` to `to`, both in whole percentages of the screen. */
  recordSwipe(from: PercentPoint, to: PercentPoint, durationMs: number, screenshotPath?: string): CaseStep {
    return this.recordSimple({ kind: 'swipe', from: { ...from }, to: { ...to }, durationMs: Math.round(durationMs) }, screenshotPath);
  }

  recordPressKey(key: PhoneKey, screenshotPath?: string): CaseStep {
    return this.recordSimple({ kind: 'pressKey', key }, screenshotPath);
  }

  recordOrientation(value: ScreenOrientation, screenshotPath?: string): CaseStep {
    return this.recordSimple({ kind: 'orientation', value }, screenshotPath);
  }

  /**
   * Records typed text. Consecutive plain text merges into one inputText step
   * until a tap or back. A `${KEY}` placeholder is always a step of its own and
   * nothing merges into it, so the placeholder stays the whole inputText value.
   */
  recordInput(text: string, screenshotPath?: string): CaseStep {
    this.requireActive();
    const last = this.steps.at(-1);
    if (last?.kind === 'type' && this.mergesIntoLast(text)) {
      last.text += text;
      last.at = this.now().toISOString();
      if (screenshotPath) last.screenshot = screenshotPath;
      this.noteEvidence(screenshotPath);
      return last;
    }
    const step: CaseStep = {
      index: this.steps.length + 1,
      kind: 'type',
      text,
      ...(screenshotPath ? { screenshot: screenshotPath } : {}),
      at: this.now().toISOString(),
    };
    return this.push(step);
  }

  /** Records characters removed from the end of the focused field. */
  recordErase(chars: number, screenshotPath?: string): CaseStep {
    return this.recordSimple({ kind: 'erase', chars }, screenshotPath);
  }

  recordBack(screenshotPath?: string): CaseStep {
    this.requireActive();
    const step: CaseStep = {
      index: this.steps.length + 1,
      kind: 'back',
      ...(screenshotPath ? { screenshot: screenshotPath } : {}),
      at: this.now().toISOString(),
    };
    return this.push(step);
  }

  recordScroll(direction: ScrollDirection, screenshotPath?: string): CaseStep {
    this.requireActive();
    const step: CaseStep = {
      index: this.steps.length + 1,
      kind: 'scroll',
      direction,
      ...(screenshotPath ? { screenshot: screenshotPath } : {}),
      at: this.now().toISOString(),
    };
    return this.push(step);
  }

  recordRelaunch(screenshotPath?: string): CaseStep {
    return this.recordSimple({ kind: 'relaunch' }, screenshotPath);
  }

  recordOpenLink(url: string, screenshotPath?: string): CaseStep {
    return this.recordSimple({ kind: 'openLink', url }, screenshotPath);
  }

  recordWait(seconds: number, screenshotPath?: string): CaseStep {
    return this.recordSimple({ kind: 'wait', seconds }, screenshotPath);
  }

  recordHideKeyboard(screenshotPath?: string): CaseStep {
    return this.recordSimple({ kind: 'hideKeyboard' }, screenshotPath);
  }

  /** A setup block the BA ran in the middle of the case; the device is wherever the block left it. */
  recordBlock(file: string, screenshotPath?: string, values?: Record<string, string>): CaseStep {
    return this.recordSimple(values ? { kind: 'block', file, values: { ...values } } : { kind: 'block', file }, screenshotPath);
  }

  private recordSimple(
    fields:
      | { kind: 'relaunch' }
      | { kind: 'openLink'; url: string }
      | { kind: 'wait'; seconds: number }
      | { kind: 'hideKeyboard' }
      | { kind: 'erase'; chars: number }
      | { kind: 'block'; file: string; values?: Record<string, string> }
      | { kind: 'swipe'; from: PercentPoint; to: PercentPoint; durationMs: number }
      | { kind: 'pressKey'; key: PhoneKey }
      | { kind: 'orientation'; value: ScreenOrientation },
    screenshotPath: string | undefined,
  ): CaseStep {
    this.requireActive();
    const step = {
      index: this.steps.length + 1,
      ...fields,
      ...(screenshotPath ? { screenshot: screenshotPath } : {}),
      at: this.now().toISOString(),
    } as CaseStep;
    return this.push(step);
  }

  /**
   * Records an inline assertVisible (Expect mode) for the node the BA clicked,
   * with the same selector rules as a tap. Callers check first that the
   * selector is not a point: asserting a position says nothing.
   */
  recordExpect(
    node: SelectorNode,
    point: Point,
    viewport: Viewport,
    screenshotPath: string | undefined,
    allNodes: readonly SelectorNode[],
  ): CaseStep {
    this.requireActive();
    const step: CaseStep = {
      index: this.steps.length + 1,
      kind: 'expect',
      selector: chooseSelector(node, allNodes, point, viewport),
      point: { x: Math.round(point.x), y: Math.round(point.y) },
      node: recordedNode(node),
      ...(screenshotPath ? { screenshot: screenshotPath } : {}),
      at: this.now().toISOString(),
    };
    return this.push(step);
  }

  /** Adds an end-of-case expectation (from the picker); emitted after every step. */
  addExpectation(expectation: { selector: MaestroSelector; node?: RecordedNode }): Expectation {
    this.requireActive();
    const added: Expectation = {
      selector: expectation.selector,
      ...(expectation.node ? { node: structuredClone(expectation.node) } : {}),
      at: this.now().toISOString(),
    };
    this.expectations.push(added);
    return added;
  }

  /** Removes every end expectation, before the picker adds the new ones. */
  clearExpectations(): void {
    this.requireActive();
    this.expectations = [];
  }

  toCase(): TestCase {
    const meta = this.requireActive();
    return {
      id: meta.id,
      name: meta.name,
      appId: meta.appId,
      createdAt: this.createdAt,
      deviceId: meta.deviceId,
      preconditionBlocks: structuredClone(meta.preconditionBlocks ?? []),
      ...(meta.startFrom ? { startFrom: meta.startFrom } : {}),
      steps: this.steps.map((step) => structuredClone(step)),
      expectations: this.expectations.map((expectation) => structuredClone(expectation)),
      ...(meta.editedAt ? { editedAt: meta.editedAt } : {}),
      ...(meta.muted ? { muted: true } : {}),
      ...(meta.reference ? { reference: meta.reference } : {}),
      ...(this.evidenceCounter > 0 ? { lastEvidenceNumber: this.evidenceCounter } : {}),
    };
  }

  toFlow(): MaestroFlow {
    return caseToFlow(this.toCase(), this.meta?.envKeys ?? []);
  }

  /** Adds a new step; it uses up the next evidence number whether or not it has a screenshot. */
  private push(step: CaseStep): CaseStep {
    this.steps.push(step);
    this.evidenceCounter = Math.max(this.evidenceCounter + 1, evidenceNumber(step.screenshot) ?? 0);
    return step;
  }

  private noteEvidence(screenshot: string | undefined): void {
    const number = evidenceNumber(screenshot);
    if (number !== undefined && number > this.evidenceCounter) this.evidenceCounter = number;
  }

  private mergesIntoLast(text: string | undefined): boolean {
    const last = this.steps.at(-1);
    if (last?.kind !== 'type' || isEnvPlaceholder(last.text)) return false;
    // A step kept from the saved case stays exactly as it was saved.
    if (this.steps.length <= this.keptSteps) return false;
    return text === undefined || !isEnvPlaceholder(text);
  }

  private requireActive(): CaseMeta {
    if (!this.meta) throw new Error('No case is being recorded');
    return this.meta;
  }
}

function stepToMaestro(
  step: CaseStep,
  scrollUntilVisible: MaestroSelector | undefined,
  blockFlow: (file: string, values: Record<string, string> | undefined) => MaestroStep,
): MaestroStep {
  switch (step.kind) {
    case 'block':
      return blockFlow(step.file, step.values);
    case 'tap':
      return { kind: 'tapOn', selector: step.selector };
    case 'longPress':
      return { kind: 'longPressOn', selector: step.selector };
    case 'doubleTap':
      return { kind: 'doubleTapOn', selector: step.selector };
    case 'swipe':
      return { kind: 'swipe', start: { ...step.from }, end: { ...step.to }, durationMs: step.durationMs };
    case 'pressKey':
      return { kind: 'pressKey', key: MAESTRO_KEY_OF[step.key] };
    case 'orientation':
      return { kind: 'setOrientation', orientation: MAESTRO_ORIENTATION_OF[step.value] };
    case 'type':
      return { kind: 'inputText', text: step.text };
    case 'erase':
      return { kind: 'eraseText', chars: step.chars };
    case 'back':
      return { kind: 'back' };
    case 'expect':
      return { kind: 'assertVisible', selector: step.selector };
    case 'relaunch':
      return { kind: 'launchApp' };
    case 'openLink':
      return { kind: 'openLink', link: step.url };
    case 'wait':
      return { kind: 'wait', seconds: step.seconds };
    case 'hideKeyboard':
      return { kind: 'hideKeyboard' };
    case 'scroll':
      if (scrollUntilVisible) {
        return { kind: 'scrollUntilVisible', selector: scrollUntilVisible, direction: step.direction === 'down' ? 'DOWN' : 'UP' };
      }
      // Maestro's `scroll` only scrolls down; a swipe that moves the content
      // down is how a flow scrolls back up.
      return step.direction === 'down' ? { kind: 'scroll' } : { kind: 'swipe', direction: 'DOWN' };
  }
}

/**
 * Builds the Maestro flow for a case in the order caseFlowItems defines:
 * a plain launchApp and one runFlow per precondition block with the project
 * env keys passed through (or one runFlow of the saved case it starts from,
 * whose flow does both), the recorded steps, then the end expectations.
 *
 * launchApp never clears state. Whether a block starts from a clean app is the
 * block author's decision (a login block begins with
 * `launchApp: { clearState: true }`), so recording through agent-device and
 * replay through Maestro both run the block and see the same state.
 *
 * A recorded scroll is emitted as scrollUntilVisible on the element the BA
 * scrolled to reach: the next tap or expect with an id or text selector, or
 * the first end expectation (see scrollTargets). Maestro's plain `scroll` moves
 * a fixed distance and does not wait for the screen, so straight after
 * launchApp it can run before the list is drawn and scroll nothing;
 * scrollUntilVisible waits, and does not depend on agent-device and Maestro
 * scrolling the same distance. Each step still becomes exactly one Maestro
 * command, which keeps run results lined up with steps: in a run of scrolls in
 * one direction each becomes its own scrollUntilVisible with the same target.
 * The first does the scrolling; the later ones find the element already
 * visible and complete at once. A scroll with no such target (followed by
 * typing, back, a scroll the other way, a point tap, or nothing) stays a plain
 * `scroll` or `swipe: { direction: DOWN }`.
 */
export function caseToFlow(testCase: TestCase, envKeys: readonly string[] = [], paths: FlowPaths = DEFAULT_FLOW_PATHS): MaestroFlow {
  const env = Object.fromEntries(envKeys.map((key) => [key, `\${${key}}`]));
  // A block runs the same way at the start of the case and in the middle of
  // it. The values the BA set on it replace the pass-through of the same name.
  const blockFlow = (projectPath: string, values: Record<string, string> | undefined): MaestroStep => {
    const file = paths.runFlowFile(projectPath);
    const blockEnv = { ...env, ...values };
    return Object.keys(blockEnv).length > 0 ? { kind: 'runFlow', file, env: blockEnv } : { kind: 'runFlow', file };
  };
  const steps = caseFlowItems(testCase).map((item): MaestroStep => {
    switch (item.kind) {
      case 'launch':
        return { kind: 'launchApp' };
      case 'startFrom': {
        // The parent's flow sits next to this one in flows/.
        const file = `${item.caseId}.yaml`;
        return envKeys.length > 0 ? { kind: 'runFlow', file, env } : { kind: 'runFlow', file };
      }
      case 'block':
        return blockFlow(item.file, item.values);
      case 'step':
        return stepToMaestro(item.step, item.scrollUntilVisible, blockFlow);
      case 'expectation':
        return { kind: 'assertVisible', selector: item.expectation.selector };
    }
  });
  return { appId: testCase.appId, name: testCase.name, steps };
}
