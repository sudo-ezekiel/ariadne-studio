// The order in which a case becomes a Maestro flow, in one place. caseToFlow
// emits exactly one Maestro command per item, so an item's position is its
// index in the flow and in Maestro's run results. The studio UI imports this
// to line run results up with recorded steps and to label scroll steps, so it
// stays free of Node imports.
import type { MaestroSelector } from '../maestro/model.ts';
import type { BlockUse, CaseStep, Expectation } from './case-types.ts';

export type FlowItem<S extends CaseStep = CaseStep> =
  | { kind: 'launch' }
  /** The flow of a saved case this one starts from; it launches the app itself. */
  | { kind: 'startFrom'; caseId: string }
  | { kind: 'block'; file: string; values?: Record<string, string> }
  /** `scrollUntilVisible` is set on a scroll step that scrolls towards a known element (see scrollTargets). */
  | { kind: 'step'; step: S; scrollUntilVisible?: MaestroSelector }
  | { kind: 'expectation'; expectation: Expectation };

function assertable(selector: MaestroSelector): boolean {
  return selector.kind === 'id' || selector.kind === 'text';
}

/**
 * For each step, the element a scroll step is scrolling towards: the
 * selector of the next tap, long press, double tap or expect step, or of the
 * first end expectation, skipping further scrolls in the same direction. Undefined for steps that
 * are not scrolls, and for scrolls followed by anything else (typing, back, a
 * scroll the other way, a point tap, or nothing).
 */
export function scrollTargets(steps: readonly CaseStep[], expectations: readonly Expectation[]): Array<MaestroSelector | undefined> {
  return steps.map((step, index) => {
    if (step.kind !== 'scroll') return undefined;
    let next = index + 1;
    while (next < steps.length) {
      const candidate = steps[next]!;
      if (candidate.kind !== 'scroll' || candidate.direction !== step.direction) break;
      next++;
    }
    if (next < steps.length) {
      const target = steps[next]!;
      const onElement = target.kind === 'tap' || target.kind === 'expect' || target.kind === 'longPress' || target.kind === 'doubleTap';
      return onElement && assertable(target.selector) ? target.selector : undefined;
    }
    const first = expectations[0];
    return first && assertable(first.selector) ? first.selector : undefined;
  });
}

/**
 * launchApp and one runFlow per precondition block, or a single runFlow of the
 * case this one starts from; then the recorded steps and the end expectations.
 */
export function caseFlowItems<S extends CaseStep>(testCase: {
  preconditionBlocks: readonly BlockUse[];
  startFrom?: string | undefined;
  steps: readonly S[];
  expectations: readonly Expectation[];
}): FlowItem<S>[] {
  const targets = scrollTargets(testCase.steps, testCase.expectations);
  const start: FlowItem<S>[] = testCase.startFrom
    ? [{ kind: 'startFrom', caseId: testCase.startFrom }]
    : [
        { kind: 'launch' },
        ...testCase.preconditionBlocks.map((use): FlowItem<S> => (use.values ? { kind: 'block', file: use.file, values: use.values } : { kind: 'block', file: use.file })),
      ];
  return [
    ...start,
    ...testCase.steps.map((step, index): FlowItem<S> => {
      const target = targets[index];
      return target ? { kind: 'step', step, scrollUntilVisible: target } : { kind: 'step', step };
    }),
    ...testCase.expectations.map((expectation): FlowItem<S> => ({ kind: 'expectation', expectation })),
  ];
}

/** Number of flow items before the first recorded step. */
export function leadingItemCount(testCase: { preconditionBlocks: readonly unknown[]; startFrom?: string | undefined }): number {
  return testCase.startFrom ? 1 : 1 + testCase.preconditionBlocks.length;
}
