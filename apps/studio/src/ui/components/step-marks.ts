// Which mark a row wears on the thread of a step list. Kept out of the
// components so it has no JSX and tests can import it. The shape says the
// kind: a ring is a point on the thread, a square is a box of other steps, and
// a wait has no ring because the thread only pauses there.
import type { MaestroStep } from '@ariadne/core/model';
import type { CaseStep } from '@ariadne/core/types';

export type Mark = 'start' | 'action' | 'check' | 'end' | 'block' | 'wait';

/** The mark of a recorded step. */
export function markOfStep(kind: CaseStep['kind']): Mark {
  switch (kind) {
    case 'block':
      return 'block';
    case 'expect':
      return 'check';
    case 'wait':
    case 'waitFor':
      return 'wait';
    default:
      return 'action';
  }
}

/** The mark of a step in the block form, which writes Maestro steps. */
export function markOfMaestroStep(step: MaestroStep): Mark {
  switch (step.kind) {
    case 'assertVisible':
    case 'assertNotVisible':
      return 'check';
    case 'wait':
    case 'waitUntilVisible':
      return 'wait';
    case 'runFlow':
      return 'block';
    default:
      return 'action';
  }
}

/** True for a step that did something on the phone, so removing it leaves the phone where the step took it. */
export function actsOnPhone(kind: CaseStep['kind']): boolean {
  return kind !== 'wait' && kind !== 'waitFor' && kind !== 'expect';
}
