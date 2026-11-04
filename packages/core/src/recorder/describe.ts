// Plain-language descriptions of steps, for the step list, the exported test
// case documents and run reports. Pure and free of Node imports so the studio
// UI bundles it too.
import { unescapeMaestroRegex } from '../maestro/escape.ts';
import type { MaestroOrientation, MaestroSelector, MaestroStep, PercentPoint } from '../maestro/model.ts';
import type { CaseStep, Expectation, PhoneKey, RecordedNode, StepReview } from './case-types.ts';
import { describeValues } from './block-values.ts';
import type { FlowItem } from './flow-layout.ts';

const ENV_PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Why a step recorded from the phone needs a look, in the tester's words. */
export const REVIEW_TEXT: Readonly<Record<StepReview, string>> = {
  'screen-moving': 'The screen was still changing when you touched it. Check this is the element you meant.',
  'no-element': 'There is no named element here, so this step presses a position on the screen. It may miss on another phone.',
  password: 'You typed in a password field, and Ariadne did not read it. Save the password as a saved value with this name.',
  'edited-text': 'You changed text that was already in the field. Run the case to check it comes out right.',
  'left-app': 'You left the app before this step. A run will not do that, so check the case still works.',
};

/** The last segment of an Android resource id, made readable: "com.x:id/btn_submit_claim" -> "btn submit claim". */
function readableId(id: string): string {
  const last = id.split('/').pop() ?? id;
  return last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** How a person refers to the element: "System" in quotes, or the id's readable tail. */
export function elementName(selector: MaestroSelector): string {
  switch (selector.kind) {
    case 'text': {
      const nth = selector.index === undefined ? '' : ` (number ${selector.index + 1} on screen)`;
      return `"${unescapeMaestroRegex(selector.value)}"${nth}`;
    }
    case 'id': {
      const nth = selector.index === undefined ? '' : ` (number ${selector.index + 1} on screen)`;
      return `the ${readableId(unescapeMaestroRegex(selector.value))} element${nth}`;
    }
    case 'point':
      return `the point at ${selector.xPercent}% across, ${selector.yPercent}% down`;
  }
}

/** The visible name of the recorded element, when it has a short one. */
function nodeName(node: RecordedNode | undefined): string | undefined {
  const name = (node?.text ?? node?.label ?? node?.contentDescription)?.trim();
  return name && name.length <= 60 ? name : undefined;
}

/**
 * How a person refers to the element of a step or check: for an id or a
 * point, the visible name of the element that was recorded reads better than
 * the id ("Search Settings" rather than "the search bar title element"); the
 * selector itself is shown beside it where it matters.
 */
export function targetName(selector: MaestroSelector, node?: RecordedNode): string {
  const name = selector.kind === 'text' ? undefined : nodeName(node);
  if (!name) return elementName(selector);
  return selector.kind === 'point' ? `"${name}" (by its position on screen)` : `"${name}"`;
}

/** The text a type step enters, as a reader should see it: secrets stay placeholders. */
export function typedText(text: string): string {
  const match = ENV_PLACEHOLDER.exec(text);
  return match ? `the ${match[1]} value from .env` : `"${text}"`;
}

/**
 * Which way a drag goes, when it runs mostly along one axis: the finger
 * moves left for "left". Mostly means the other axis moves at most half as
 * far (about 27 degrees off). Measured in percentages of the screen, since
 * that is what a swipe step keeps; undefined for a diagonal drag.
 */
export function swipeDirectionWord(from: PercentPoint, to: PercentPoint): 'left' | 'right' | 'up' | 'down' | undefined {
  const dx = to.xPercent - from.xPercent;
  const dy = to.yPercent - from.yPercent;
  if (Math.abs(dx) >= 2 * Math.abs(dy) && dx !== 0) return dx < 0 ? 'left' : 'right';
  if (Math.abs(dy) >= 2 * Math.abs(dx) && dy !== 0) return dy < 0 ? 'up' : 'down';
  return undefined;
}

/** A drag that starts this close to the top opens the notification shade on a phone. */
const TOP_EDGE_PERCENT = 5;

function describeSwipe(from: PercentPoint, to: PercentPoint): string {
  const word = swipeDirectionWord(from, to);
  if (word === 'down' && from.yPercent <= TOP_EDGE_PERCENT) return 'Swipe down from the top edge';
  if (word) return `Swipe ${word}`;
  return `Swipe from ${from.xPercent}%, ${from.yPercent}% to ${to.xPercent}%, ${to.yPercent}%`;
}

const KEY_WORDS: Readonly<Record<PhoneKey, string>> = {
  home: 'Home',
  volumeUp: 'Volume up',
  volumeDown: 'Volume down',
  power: 'Power',
  enter: 'Enter',
};

const ORIENTATION_WORDS: Readonly<Record<MaestroOrientation, string>> = {
  PORTRAIT: 'Rotate to portrait',
  LANDSCAPE_LEFT: 'Rotate to landscape',
  LANDSCAPE_RIGHT: 'Rotate to landscape, turned right',
  UPSIDE_DOWN: 'Rotate upside down',
};

/**
 * The generated description of a step, used when the BA has not given it a
 * title. `scrollTarget` is the element a scroll step scrolls to on replay
 * (scrollTargets in flow-layout).
 */
export function describeStep(step: CaseStep, scrollTarget?: MaestroSelector): string {
  switch (step.kind) {
    case 'tap':
      return `Tap ${targetName(step.selector, step.node)}`;
    case 'longPress':
      return `Long press ${targetName(step.selector, step.node)}`;
    case 'doubleTap':
      return `Double tap ${targetName(step.selector, step.node)}`;
    case 'swipe':
      return describeSwipe(step.from, step.to);
    case 'pressKey':
      return `Press ${KEY_WORDS[step.key]}`;
    case 'orientation':
      return `Rotate to ${step.value}`;
    case 'type':
      return `Type ${typedText(step.text)}`;
    case 'back':
      return 'Press Back';
    case 'expect':
      return `Check that ${targetName(step.selector, step.node)} is visible`;
    case 'scroll':
      return scrollTarget
        ? `Scroll ${step.direction} until ${elementName(scrollTarget)} is visible`
        : `Scroll ${step.direction}`;
    case 'relaunch':
      return 'Restart the app';
    case 'openLink':
      return `Open the link ${step.url}`;
    case 'hideKeyboard':
      return 'Hide the keyboard';
    case 'erase':
      return `Erase ${step.chars} ${step.chars === 1 ? 'character' : 'characters'}`;
    case 'block': {
      const values = describeValues(step.values);
      return values ? `Run the block ${step.file} ${values}` : `Run the block ${step.file}`;
    }
  }
}

/** The title the BA gave the step, else the generated description. */
export function stepTitle(step: CaseStep, scrollTarget?: MaestroSelector): string {
  return step.title?.trim() ? step.title.trim() : describeStep(step, scrollTarget);
}

/** The expected result a document shows for a step: the BA's note, else what an expect step checks. */
export function stepExpected(step: CaseStep): string {
  if (step.note?.trim()) return step.note.trim();
  if (step.kind === 'expect') return `${targetName(step.selector, step.node)} is visible`;
  return '';
}

export function describeExpectation(expectation: Expectation): string {
  return `${targetName(expectation.selector, expectation.node)} is visible`;
}

/**
 * One Maestro command of a developer-written block, in words, so a BA can
 * see what a block does before using it.
 */
export function describeMaestroStep(step: MaestroStep): string {
  switch (step.kind) {
    case 'launchApp':
      return step.clearState ? 'Start the app with its data cleared' : 'Start the app';
    case 'runFlow':
      return `Run ${step.file}`;
    case 'tapOn':
      return `Tap ${elementName(step.selector)}`;
    case 'longPressOn':
      return `Long press ${elementName(step.selector)}`;
    case 'doubleTapOn':
      return `Double tap ${elementName(step.selector)}`;
    case 'pressKey':
      return `Press ${step.key}`;
    case 'setOrientation':
      return ORIENTATION_WORDS[step.orientation];
    case 'inputText':
      return `Type ${typedText(step.text)}`;
    case 'eraseText':
      return step.chars === undefined ? 'Erase the text' : `Erase ${step.chars} ${step.chars === 1 ? 'character' : 'characters'}`;
    case 'back':
      return 'Press Back';
    case 'hideKeyboard':
      return 'Hide the keyboard';
    case 'assertVisible':
      return `Check that ${elementName(step.selector)} is visible`;
    case 'assertNotVisible':
      return `Check that ${elementName(step.selector)} is not visible`;
    case 'openLink':
      return `Open the link ${step.link}`;
    case 'takeScreenshot':
      return 'Take a screenshot';
    case 'startRecording':
      return 'Start the run video';
    case 'stopRecording':
      return 'Stop the run video';
    case 'scroll':
      return 'Scroll down';
    case 'swipe':
      return 'direction' in step ? `Swipe ${step.direction.toLowerCase()}` : describeSwipe(step.start, step.end);
    case 'scrollUntilVisible':
      return `Scroll ${step.direction.toLowerCase()} until ${elementName(step.selector)} is visible`;
  }
}

/** How long a step took, for results and reports: "420 ms", "3.1 s", "1 min 5 s". */
export function formatDuration(ms: number): string {
  if (Math.round(ms) < 1000) return `${Math.round(ms)} ms`;
  const tenths = Math.round(ms / 100) / 10;
  if (tenths < 60) return `${tenths.toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** Names the documents and reports use for other cases and blocks; ids and paths when unknown. */
export type DescribeNames = {
  caseName?: (caseId: string) => string | undefined;
  blockName?: (file: string) => string | undefined;
};

function describeBlock(file: string, values: Record<string, string> | undefined, names: DescribeNames): string {
  const name = names.blockName?.(file);
  const base = name ? `Run the block "${name}" (${file})` : `Run the block ${file}`;
  const set = describeValues(values);
  return set ? `${base} ${set}` : base;
}

/** One line for any item of caseFlowItems, as the step list, documents and reports show it. */
export function describeFlowItem(item: FlowItem, appId: string, names: DescribeNames = {}): string {
  switch (item.kind) {
    case 'launch':
      return `Start ${appId}`;
    case 'startFrom': {
      const name = names.caseName?.(item.caseId);
      return name ? `Do everything in the case "${name}"` : `Do everything in the case ${item.caseId}`;
    }
    case 'block':
      return describeBlock(item.file, item.values, names);
    case 'step':
      // A block step without a title reads like a leading block, with its name.
      if (item.step.kind === 'block' && !item.step.title?.trim()) return describeBlock(item.step.file, item.step.values, names);
      return stepTitle(item.step, item.scrollUntilVisible);
    case 'expectation':
      return `Check that ${describeExpectation(item.expectation)}`;
  }
}
