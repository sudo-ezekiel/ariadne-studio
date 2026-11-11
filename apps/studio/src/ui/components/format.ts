import { stepTitle } from '@ariadne/core/describe';
import { unescapeMaestroRegex } from '@ariadne/core/escape';
import type { MaestroSelector } from '@ariadne/core/types';
import type { StepView } from '../../shared/api-types.ts';

export function selectorText(selector: MaestroSelector): string {
  switch (selector.kind) {
    case 'id':
    case 'text': {
      const index = selector.index === undefined ? '' : ` (index ${selector.index})`;
      return `${selector.kind}: ${unescapeMaestroRegex(selector.value)}${index}`;
    }
    case 'point':
      return `point ${selector.xPercent}%,${selector.yPercent}%`;
  }
}

/**
 * What a step does, in words: the BA's title when there is one, else the
 * generated description. `scrollUntilVisible` is the element a scroll step
 * scrolls to on replay (scrollTargets in @ariadne/core/flow-layout).
 */
export function stepText(step: StepView, scrollUntilVisible?: MaestroSelector): string {
  return stepTitle(step, scrollUntilVisible);
}

/** The selector behind a tap, long press, double tap, check or wait until (or the line of a swipe), shown small under its description. */
export function stepSelector(step: StepView): string | undefined {
  switch (step.kind) {
    case 'tap':
    case 'expect':
    case 'waitFor':
    case 'longPress':
    case 'doubleTap':
      return selectorText(step.selector);
    case 'swipe':
      return `from ${step.from.xPercent}%,${step.from.yPercent}% to ${step.to.xPercent}%,${step.to.yPercent}% in ${step.durationMs} ms`;
    default:
      return undefined;
  }
}

/** Point selectors are the ones most likely to break on replay. */
export function isFragile(step: StepView): boolean {
  return (step.kind === 'tap' || step.kind === 'longPress' || step.kind === 'doubleTap') && step.selector.kind === 'point';
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** A count with its noun: "1 step", "3 steps". */
export function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}
