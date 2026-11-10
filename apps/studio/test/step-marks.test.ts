// The mark each row of a step list wears on the thread, and whether removing a
// step leaves the phone somewhere else. Pure helpers, no JSX.
import { describe, expect, it } from 'vitest';
import type { MaestroStep } from '@ariadne/core/model';
import type { CaseStep } from '@ariadne/core/types';
import { actsOnPhone, markOfMaestroStep, markOfStep, type Mark } from '../src/ui/components/step-marks.ts';

const text = { kind: 'text', value: 'Hi' } as const;

// A Record over every kind: adding a CaseStep kind without a row here fails the typecheck.
const STEP_MARKS: Record<CaseStep['kind'], Mark> = {
  tap: 'action',
  longPress: 'action',
  doubleTap: 'action',
  swipe: 'action',
  pressKey: 'action',
  orientation: 'action',
  type: 'action',
  erase: 'action',
  back: 'action',
  scroll: 'action',
  relaunch: 'action',
  openLink: 'action',
  hideKeyboard: 'action',
  expect: 'check',
  wait: 'wait',
  waitFor: 'wait',
  block: 'block',
};

describe('markOfStep', () => {
  it.each(Object.entries(STEP_MARKS) as [CaseStep['kind'], Mark][])('marks a %s step as %s', (kind, mark) => {
    expect(markOfStep(kind)).toBe(mark);
  });
});

describe('markOfMaestroStep', () => {
  it.each<[MaestroStep, Mark]>([
    [{ kind: 'assertVisible', selector: text }, 'check'],
    [{ kind: 'assertNotVisible', selector: text }, 'check'],
    [{ kind: 'wait', seconds: 5 }, 'wait'],
    [{ kind: 'waitUntilVisible', selector: text, seconds: 5 }, 'wait'],
    [{ kind: 'runFlow', file: 'login.yaml' }, 'block'],
    [{ kind: 'tapOn', selector: text }, 'action'],
    [{ kind: 'inputText', text: 'a' }, 'action'],
    [{ kind: 'scrollUntilVisible', selector: text, direction: 'DOWN' }, 'action'],
    [{ kind: 'launchApp' }, 'action'],
    [{ kind: 'back' }, 'action'],
  ])('marks a %o step as %s', (step, mark) => {
    expect(markOfMaestroStep(step)).toBe(mark);
  });
});

describe('actsOnPhone', () => {
  it.each(['wait', 'waitFor', 'expect'] as const)('is false for %s, which leaves the phone as it was', (kind) => {
    expect(actsOnPhone(kind)).toBe(false);
  });

  it.each((Object.keys(STEP_MARKS) as CaseStep['kind'][]).filter((kind) => !['wait', 'waitFor', 'expect'].includes(kind)))(
    'is true for %s',
    (kind) => {
      expect(actsOnPhone(kind)).toBe(true);
    },
  );
});
