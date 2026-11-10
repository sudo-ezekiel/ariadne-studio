// The rules for a block written in the Blocks tab. The UI uses them to say what
// is still missing, and the server refuses a block that breaks them.
import { normalizeValues } from '@ariadne/core/block-values';
import type { MaestroSelector, MaestroStep } from '@ariadne/core/model';
import { MAX_WAIT_SECONDS } from './api-types.ts';

const MAX_NAME = 80;
const MAX_LINK = 2000;
const ONLY_A_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const NO_NAME = '${}';

/** http(s) links and app deep links (scheme://...); nothing that could be a shell or file trick. */
export function isOpenableLink(url: string): boolean {
  return url.length <= MAX_LINK && /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+$/.test(url) && !/^(file|content|javascript):/i.test(url);
}

function textProblem(text: string, missing: string): string | undefined {
  if (!text.trim()) return `needs ${missing}`;
  if (text === NO_NAME) return 'needs a name for its setting';
  if (/[\r\n]/.test(text)) return 'must fit on one line';
  return undefined;
}

function selectorProblem(selector: MaestroSelector, missing: string, canBePoint: boolean): string | undefined {
  if (selector.kind !== 'point') return textProblem(selector.value, missing);
  return canBePoint ? undefined : `needs ${missing}, and a point on the screen cannot be looked for`;
}

function secondsProblem(seconds: number): string | undefined {
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_WAIT_SECONDS ? undefined : `must wait 1 to ${MAX_WAIT_SECONDS} seconds`;
}

function stepProblem(step: MaestroStep): string | undefined {
  switch (step.kind) {
    case 'tapOn':
    case 'longPressOn':
    case 'doubleTapOn':
      return selectorProblem(step.selector, 'something to press', true);
    case 'assertVisible':
    case 'assertNotVisible':
    case 'scrollUntilVisible':
      return selectorProblem(step.selector, 'something to look for', false);
    case 'inputText':
      return textProblem(step.text, 'the text to type');
    case 'openLink':
      if (textProblem(step.link, 'a link')) return textProblem(step.link, 'a link');
      return ONLY_A_REFERENCE.test(step.link) || isOpenableLink(step.link) ? undefined : 'needs a link such as https://example.com/claims or myapp://claims/123';
    case 'wait':
      return secondsProblem(step.seconds);
    case 'waitUntilVisible':
      return selectorProblem(step.selector, 'something to wait for', false) ?? secondsProblem(step.seconds);
    case 'eraseText':
      return step.chars === undefined || (Number.isInteger(step.chars) && step.chars >= 1) ? undefined : 'must erase at least 1 character';
    case 'runFlow':
      return textProblem(step.file, 'a flow file');
    default:
      return undefined;
  }
}

/** The first thing that keeps a block from being saved, in a sentence, or undefined when it can be. */
export function blockProblem(name: string, steps: readonly MaestroStep[]): string | undefined {
  if (!name.trim()) return 'Give the block a name.';
  if (name.length > MAX_NAME || /[\r\n]/.test(name)) return `A block's name fits on one line of at most ${MAX_NAME} characters.`;
  if (steps.length === 0) return 'Add at least one step.';
  for (const [position, step] of steps.entries()) {
    const problem = stepProblem(step);
    if (problem) return `Step ${position + 1} ${problem}.`;
  }
  return undefined;
}

/**
 * Turns typed text that is exactly a saved value into its `${KEY}`, the way
 * recording does, so a password pasted into a Type step stays out of the file.
 */
export function hideSavedValues(steps: readonly MaestroStep[], env: Readonly<Record<string, string>>): MaestroStep[] {
  return steps.map((step) => {
    if (step.kind !== 'inputText') return step;
    const text = normalizeValues({ text: step.text }, env)?.text;
    return text === undefined ? step : { ...step, text };
  });
}
