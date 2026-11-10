// The "Wait until" step of the Blocks tab form, and the step list text for a
// recorded wait for.
import { describe, expect, it } from 'vitest';
import type { MaestroStep } from '@ariadne/core/model';
import { DEFAULT_WAIT_SECONDS, type StepView } from '../src/shared/api-types.ts';
import { blockProblem } from '../src/shared/block-check.ts';
import { buildStep, draftStep, STEP_CHOICES, stepLabel, typedStep } from '../src/ui/components/block-steps.ts';
import { stepSelector } from '../src/ui/components/format.ts';

const waitUntil = (value: string, seconds: number = DEFAULT_WAIT_SECONDS): MaestroStep => ({
  kind: 'waitUntilVisible',
  selector: { kind: 'text', value },
  seconds,
});
const newStep = STEP_CHOICES.find((choice) => choice.label === 'Wait until')!.step;

describe('the Wait until choice', () => {
  it('starts with an empty text selector and the default seconds', () => {
    expect(newStep).toEqual(waitUntil(''));
  });

  it('is labelled Wait until', () => {
    expect(stepLabel(newStep)).toBe('Wait until');
  });

  it('gets a target field to type in', () => {
    expect(draftStep(newStep).field).toEqual({ mode: 'text', value: '' });
  });

  it('escapes typed text as it does for Check, and keeps the seconds', () => {
    const typed = typedStep(draftStep(newStep), { mode: 'text', value: 'Done (1)' });
    expect(buildStep(typed)).toEqual(waitUntil('Done \\(1\\)'));
    const check = typedStep(draftStep({ kind: 'assertVisible', selector: { kind: 'text', value: '' } }), { mode: 'text', value: 'Done (1)' });
    expect(buildStep(check)).toEqual({ kind: 'assertVisible', selector: { kind: 'text', value: 'Done \\(1\\)' } });
  });

  it('writes a setting as ${NAME}', () => {
    const typed = typedStep(draftStep(newStep), { mode: 'setting', value: 'ORDER_STATUS' });
    expect(buildStep(typed)).toEqual(waitUntil('${ORDER_STATUS}'));
  });
});

describe('blockProblem for a Wait until step', () => {
  it('accepts a filled one', () => {
    expect(blockProblem('Pay', [waitUntil('Paid', 30)])).toBeUndefined();
  });

  it.each([1, 120])('accepts %i seconds', (seconds) => {
    expect(blockProblem('Pay', [waitUntil('Paid', seconds)])).toBeUndefined();
  });

  it('refuses an empty selector, naming the step', () => {
    expect(blockProblem('Pay', [{ kind: 'launchApp' }, waitUntil('')])).toBe('Step 2 needs something to wait for.');
  });

  it('refuses a point on the screen, which cannot be waited for', () => {
    const point: MaestroStep = { kind: 'waitUntilVisible', selector: { kind: 'point', xPercent: 1, yPercent: 2 }, seconds: 5 };
    expect(blockProblem('Pay', [point])).toMatch(/cannot be looked for/);
  });

  it.each([0, -1, 121, 1.5, Number.NaN])('refuses %s seconds', (seconds) => {
    expect(blockProblem('Pay', [waitUntil('Paid', seconds)])).toBe('Step 1 must wait 1 to 120 seconds.');
  });

  it('reports the empty selector before the seconds when both are wrong', () => {
    expect(blockProblem('Pay', [waitUntil('', 0)])).toMatch(/something to wait for/);
  });
});

describe('stepSelector', () => {
  const base = { index: 1, at: '2026-01-01T00:00:00Z', point: { x: 1, y: 2 } };

  it('shows the selector of a waitFor step like an expect step', () => {
    const selector = { kind: 'text', value: 'Paid' } as const;
    const waitFor = { ...base, kind: 'waitFor', selector, seconds: 20 } as unknown as StepView;
    const expectStep = { ...base, kind: 'expect', selector } as unknown as StepView;
    expect(stepSelector(waitFor)).toBe('text: Paid');
    expect(stepSelector(waitFor)).toBe(stepSelector(expectStep));
  });

  it('shows nothing for a plain wait', () => {
    expect(stepSelector({ ...base, kind: 'wait', seconds: 5 } as unknown as StepView)).toBeUndefined();
  });
});
