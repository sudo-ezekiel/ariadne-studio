// The Blocks tab form model. A field holds text as a person reads it, Maestro
// holds an escaped regular expression or a ${NAME}, and nothing a person did
// not touch may change on the way through the form and back.
import { describe, expect, it } from 'vitest';
import type { MaestroSelector, MaestroStep } from '@ariadne/core/model';
import type { BlockDetail, CaseBlockDraft, ScreenPick } from '../src/shared/api-types.ts';
import {
  blockFromCase,
  blockSettings,
  buildStep,
  buildSteps,
  draftStep,
  editFromDetail,
  isDirty,
  newBlock,
  passwordInText,
  pickedStep,
  settingInput,
  STEP_CHOICES,
  stepLabel,
  switchedField,
  typedStep,
  withRecordedSteps,
  type DraftStep,
  type Field,
} from '../src/ui/components/block-steps.ts';

const text = (value: string, index?: number): MaestroSelector => ({ kind: 'text', value, ...(index !== undefined ? { index } : {}) });
const id = (value: string, index?: number): MaestroSelector => ({ kind: 'id', value, ...(index !== undefined ? { index } : {}) });
const tap = (selector: MaestroSelector): MaestroStep => ({ kind: 'tapOn', selector });
const type = (value: string): MaestroStep => ({ kind: 'inputText', text: value });
const roundTrip = (step: MaestroStep) => buildStep(draftStep(step));

describe('a step through the form and back', () => {
  it.each(STEP_CHOICES.map((choice) => [choice.label, choice.step] as const))('returns the new "%s" step unchanged', (_label, step) => {
    expect(roundTrip(step)).toEqual(step);
  });

  it.each<[string, MaestroStep]>([
    ['runFlow', { kind: 'runFlow', file: 'login.yaml', env: { USER: 'a' } }],
    ['takeScreenshot', { kind: 'takeScreenshot', path: 'shot', optional: true }],
    ['setOrientation', { kind: 'setOrientation', orientation: 'LANDSCAPE_LEFT' }],
    ['swipe between two points', { kind: 'swipe', start: { xPercent: 10, yPercent: 20 }, end: { xPercent: 80, yPercent: 20 }, durationMs: 300 }],
  ])('keeps a %s step the form has no field for', (_kind, step) => {
    const draft = draftStep(step);
    expect(draft.field).toBeUndefined();
    expect(stepLabel(step)).toBeUndefined();
    expect(buildStep(draft)).toEqual(step);
  });

  it('labels a swipe in a direction but not a swipe between points', () => {
    expect(stepLabel({ kind: 'swipe', direction: 'LEFT' })).toBe('Swipe');
  });

  it('keeps the number of a repeated element', () => {
    expect(roundTrip(tap(text('Item', 2)))).toEqual(tap(text('Item', 2)));
    expect(roundTrip(tap(id('com\\.x:id/row', 0)))).toEqual(tap(id('com\\.x:id/row', 0)));
  });

  it('keeps the options of a scroll to step', () => {
    const step: MaestroStep = { kind: 'scrollUntilVisible', selector: text('Terms'), direction: 'UP', timeoutMs: 5000, speed: 20, visibilityPercentage: 80, centerElement: true };
    expect(roundTrip(step)).toEqual(step);
  });

  it('keeps clearState on a start of the app', () => {
    expect(roundTrip({ kind: 'launchApp', clearState: true })).toEqual({ kind: 'launchApp', clearState: true });
  });

  it('keeps a point selector as it is', () => {
    const step = tap({ kind: 'point', xPercent: 40, yPercent: 60 });
    const draft = draftStep(step);
    expect(draft.field).toEqual({ mode: 'point', value: '' });
    expect(buildStep(draft)).toEqual(step);
  });

  it('gives each draft its own key', () => {
    expect(draftStep({ kind: 'back' }).key).not.toBe(draftStep({ kind: 'back' }).key);
  });
});

describe('selector text', () => {
  it('shows a file\'s escaped regex as readable text and writes it back the same', () => {
    const draft = draftStep(tap(id('com\\.x:id/a')));
    expect(draft.field).toEqual({ mode: 'id', value: 'com.x:id/a' });
    expect(buildStep(draft)).toEqual(tap(id('com\\.x:id/a')));
  });

  it('escapes what a person types as plain text', () => {
    const typed = typedStep(draftStep(tap(text(''))), { mode: 'text', value: 'Display (beta)' });
    expect(buildStep(typed)).toEqual(tap(text('Display \\(beta\\)')));
  });

  it('reads a hand-written regex as a pattern and writes it back untouched', () => {
    const draft = draftStep(tap(text('.*Welcome.*')));
    expect(draft.field).toEqual({ mode: 'text', value: '.*Welcome.*', pattern: true });
    expect(buildStep(draft)).toEqual(tap(text('.*Welcome.*')));
  });

  it('treats text typed over a pattern as literal', () => {
    const typed = typedStep(draftStep(tap(text('.*Welcome.*'))), { mode: 'text', value: 'a.b' });
    expect(typed.field?.pattern).toBeUndefined();
    expect(buildStep(typed)).toEqual(tap(text('a\\.b')));
  });

  it('reads text around a setting reference as a pattern, not a setting', () => {
    const draft = draftStep(tap(text('Hello ${NAME}')));
    expect(draft.field).toEqual({ mode: 'text', value: 'Hello ${NAME}', pattern: true });
    expect(buildStep(draft)).toEqual(tap(text('Hello ${NAME}')));
  });

  it('does not escape the text a Type step types', () => {
    const draft = draftStep(type('a.b (c) [1]'));
    expect(draft.field).toEqual({ mode: 'text', value: 'a.b (c) [1]' });
    expect(buildStep(draft)).toEqual(type('a.b (c) [1]'));
  });
});

describe('settings in a field', () => {
  it('reads a ${EMAIL} text selector as a setting and writes it back', () => {
    const draft = draftStep(tap(text('${EMAIL}')));
    expect(draft.field).toEqual({ mode: 'setting', value: 'EMAIL' });
    expect(buildStep(draft)).toEqual(tap(text('${EMAIL}')));
  });

  it('reads a ${EMAIL} in a Type step as a setting', () => {
    const draft = draftStep(type('${EMAIL}'));
    expect(draft.field).toEqual({ mode: 'setting', value: 'EMAIL' });
    expect(buildStep(draft)).toEqual(type('${EMAIL}'));
  });

  it('keeps an id selector holding a reference an id selector', () => {
    const draft = draftStep(tap(id('${BUTTON}')));
    expect(draft.field).toEqual({ mode: 'setting', value: 'BUTTON' });
    expect(buildStep(draft)).toEqual(tap(id('${BUTTON}')));
  });

  it('makes a setting chosen on a text selector a text selector', () => {
    const typed = typedStep(draftStep(tap(text('Log in'))), { mode: 'setting', value: 'BUTTON' });
    expect(buildStep(typed)).toEqual(tap(text('${BUTTON}')));
  });

  it('drops trailing underscores from a setting name when it is written', () => {
    const draft: DraftStep = { ...draftStep(type('')), field: { mode: 'setting', value: 'EMAIL__' } };
    expect(buildStep(draft)).toEqual(type('${EMAIL}'));
  });

  it('writes an empty setting name as ${}', () => {
    const draft: DraftStep = { ...draftStep(type('')), field: { mode: 'setting', value: '' } };
    expect(buildStep(draft)).toEqual(type('${}'));
  });

  it('writes a setting in an Open link step', () => {
    const draft: DraftStep = { ...draftStep({ kind: 'openLink', link: '' }), field: { mode: 'setting', value: 'URL' } };
    expect(buildStep(draft)).toEqual({ kind: 'openLink', link: '${URL}' });
  });
});

describe('settingInput', () => {
  it.each([
    ['email address', 'EMAIL_ADDRESS'],
    ['already_ok', 'ALREADY_OK'],
    ['  spaced  out ', 'SPACED_OUT_'],
    ['123abc', 'ABC'],
    ['_9_user', 'USER'],
    ['Σύνδεση', ''],
    ['e-mail', 'E_MAIL'],
  ])('turns %j into %j', (typed, name) => {
    expect(settingInput(typed)).toBe(name);
  });

  it('keeps Latin letters and drops Greek ones from a mixed name', () => {
    expect(settingInput('user Σ name')).toBe('USER_NAME');
  });
});

describe('switchedField', () => {
  it('empties the value when going to a setting', () => {
    expect(switchedField({ mode: 'text', value: 'hunter2' }, 'setting')).toEqual({ mode: 'setting', value: '' });
  });

  it('empties the value when coming from a setting', () => {
    expect(switchedField({ mode: 'setting', value: 'EMAIL' }, 'text')).toEqual({ mode: 'text', value: '' });
  });

  it('keeps the value from text to id', () => {
    expect(switchedField({ mode: 'text', value: 'btn' }, 'id')).toEqual({ mode: 'id', value: 'btn' });
  });
});

describe('typedStep', () => {
  it('drops the number of a repeated element', () => {
    const typed = typedStep(draftStep(tap(text('Item', 2))), { mode: 'text', value: 'Other' });
    expect(buildStep(typed)).toEqual(tap(text('Other')));
  });

  it('keeps the key and the typed field', () => {
    const draft = draftStep(tap(text('Item')));
    const field: Field = { mode: 'id', value: 'row' };
    expect(typedStep(draft, field)).toMatchObject({ key: draft.key, field });
  });

  it('only sets the field on a step with no selector', () => {
    const draft = draftStep(type(''));
    const typed = typedStep(draft, { mode: 'text', value: 'hi' });
    expect(typed.step).toBe(draft.step);
    expect(buildStep(typed)).toEqual(type('hi'));
  });
});

describe('isDirty', () => {
  const detail: BlockDetail = { file: 'blocks/a.yaml', name: 'Log in', appId: 'com.x', steps: [tap(text('Go')), type('hi')], fixed: [], usedBy: [], hasComments: false };

  it('is clean for a new block', () => {
    expect(isDirty(newBlock())).toBe(false);
  });

  it('is clean for a block just opened', () => {
    expect(isDirty(editFromDetail(detail))).toBe(false);
  });

  it('is dirty after the name changes', () => {
    expect(isDirty({ ...editFromDetail(detail), name: 'Sign in' })).toBe(true);
  });

  it('is dirty after a step changes', () => {
    const edit = editFromDetail(detail);
    const steps = [typedStep(edit.steps[0]!, { mode: 'text', value: 'Stop' }), edit.steps[1]!];
    expect(isDirty({ ...edit, steps })).toBe(true);
  });

  it('is dirty after a step is added', () => {
    const edit = editFromDetail(detail);
    expect(isDirty({ ...edit, steps: [...edit.steps, draftStep({ kind: 'back' })] })).toBe(true);
  });

  it('is clean when only trailing spaces are added to the name', () => {
    expect(isDirty({ ...editFromDetail(detail), name: 'Log in   ' })).toBe(false);
  });

  it('is dirty once a new block gets a name', () => {
    expect(isDirty({ ...newBlock(), name: 'Log in' })).toBe(true);
  });
});

describe('blockSettings', () => {
  it('lists each setting once, sorted by name', () => {
    const steps = [type('${B}'), tap(text('${C}')), type('${A}'), type('${B}')].map(draftStep);
    expect(blockSettings(steps)).toEqual(['A', 'B', 'C']);
  });

  it('is empty when no step uses a setting', () => {
    expect(blockSettings([draftStep(type('hello'))])).toEqual([]);
  });
});

describe('pickedStep', () => {
  const pick = (selector: MaestroSelector, password = false): ScreenPick => ({ selector, password });

  it('takes an id selector and reads its field', () => {
    const draft = draftStep(tap(text('')));
    const picked = pickedStep(draft, pick(id('com\\.x:id/login')));
    expect(picked?.key).toBe(draft.key);
    expect(picked?.field).toEqual({ mode: 'id', value: 'com.x:id/login' });
    expect(picked && buildStep(picked)).toEqual(tap(id('com\\.x:id/login')));
  });

  it('takes a text selector for a check', () => {
    const picked = pickedStep(draftStep({ kind: 'assertVisible', selector: text('') }), pick(text('Welcome')));
    expect(picked && buildStep(picked)).toEqual({ kind: 'assertVisible', selector: text('Welcome') });
  });

  it.each(['tapOn', 'longPressOn', 'doubleTapOn'] as const)('takes a point for %s', (kind) => {
    const point: MaestroSelector = { kind: 'point', xPercent: 10, yPercent: 20 };
    const picked = pickedStep(draftStep({ kind, selector: text('') }), pick(point));
    expect(picked?.field).toEqual({ mode: 'point', value: '' });
    expect(picked && buildStep(picked)).toEqual({ kind, selector: point });
  });

  it.each([
    ['assertVisible', { kind: 'assertVisible', selector: text('') }],
    ['scrollUntilVisible', { kind: 'scrollUntilVisible', selector: text(''), direction: 'DOWN' }],
  ] as const)('refuses a point for %s', (_kind, step) => {
    expect(pickedStep(draftStep(step), pick({ kind: 'point', xPercent: 10, yPercent: 20 }))).toBeUndefined();
  });

  it('marks a password field only when the pick says so', () => {
    const draft = draftStep(tap(text('')));
    expect(pickedStep(draft, pick(id('pw'), true))?.passwordField).toBe(true);
    expect(pickedStep(draft, pick(id('pw')))).not.toHaveProperty('passwordField');
  });

  it('keeps the other settings of the step, such as its direction', () => {
    const draft = draftStep({ kind: 'scrollUntilVisible', selector: text(''), direction: 'UP', timeoutMs: 4000 });
    const picked = pickedStep(draft, pick(text('Terms')));
    expect(picked && buildStep(picked)).toEqual({ kind: 'scrollUntilVisible', selector: text('Terms'), direction: 'UP', timeoutMs: 4000 });
  });
});

describe('passwordInText', () => {
  const typedAfter = (before: DraftStep, typed: MaestroStep = type('hunter2')) => [before, draftStep(typed)];

  it('is sure when the tapped field was picked as a password field', () => {
    const picked = pickedStep(draftStep(tap(text(''))), { selector: id('pw'), password: true })!;
    expect(passwordInText(typedAfter(picked), 1)).toBe('sure');
  });

  it('is maybe when the tapped field has a secret-looking name', () => {
    expect(passwordInText(typedAfter(draftStep(tap(text('Password')))), 1)).toBe('maybe');
  });

  it('is undefined when the tapped field has an ordinary name', () => {
    expect(passwordInText(typedAfter(draftStep(tap(text('Email')))), 1)).toBeUndefined();
  });

  it('is undefined when the Type step uses a setting', () => {
    const picked = pickedStep(draftStep(tap(text(''))), { selector: id('pw'), password: true })!;
    expect(passwordInText(typedAfter(picked, type('${PASSWORD}')), 1)).toBeUndefined();
  });

  it('is undefined when the step before is not a tap', () => {
    expect(passwordInText(typedAfter(draftStep({ kind: 'hideKeyboard' })), 1)).toBeUndefined();
  });

  it('is undefined for the first step and for a step that is not a Type step', () => {
    const steps = typedAfter(draftStep(tap(text('Password'))));
    expect(passwordInText(steps, 0)).toBeUndefined();
    expect(passwordInText(typedAfter(draftStep(tap(text('Password'))), { kind: 'back' }), 1)).toBeUndefined();
  });
});

describe('blockFromCase', () => {
  const draft: CaseBlockDraft = { name: 'Log in', appId: 'com.example', steps: [{ kind: 'launchApp' }, tap(text('Log in')), type('${EMAIL}')] };

  it('carries the name, the app id and the steps', () => {
    const edit = blockFromCase(draft);
    expect(edit).toMatchObject({ name: 'Log in', appId: 'com.example' });
    expect(buildSteps(edit.steps)).toEqual(draft.steps);
  });

  it('is not saved yet: it has no file and counts as changed', () => {
    const edit = blockFromCase(draft);
    expect(edit).not.toHaveProperty('file');
    expect(isDirty(edit)).toBe(true);
  });
});

describe('withRecordedSteps', () => {
  const edit = editFromDetail({ file: 'blocks/a.yaml', name: 'A', appId: 'com.example', steps: [{ kind: 'launchApp' }, tap(text('Go'))], fixed: ['REGION'], usedBy: ['Smoke'], hasComments: true });

  it('adds the recorded steps after the existing ones', () => {
    const next = withRecordedSteps(edit, [{ kind: 'back' }, type('hi')]);
    expect(buildSteps(next.steps)).toEqual([{ kind: 'launchApp' }, tap(text('Go')), { kind: 'back' }, type('hi')]);
  });

  it('keeps the keys of the existing steps and everything else on the edit', () => {
    const next = withRecordedSteps(edit, [{ kind: 'back' }]);
    expect(next.steps.slice(0, 2).map((step) => step.key)).toEqual(edit.steps.map((step) => step.key));
    expect({ ...next, steps: [] }).toEqual({ ...edit, steps: [] });
  });

  it('gives the new steps keys no other step has', () => {
    const next = withRecordedSteps(edit, [{ kind: 'back' }, { kind: 'back' }]);
    const keys = next.steps.map((step) => step.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('shows ${PASSWORD} text as a setting field', () => {
    const [added] = withRecordedSteps(edit, [type('${PASSWORD}')]).steps.slice(-1);
    expect(added!.field).toEqual({ mode: 'setting', value: 'PASSWORD' });
  });

  it('does not change the edit it is given', () => {
    const before = JSON.stringify(edit);
    withRecordedSteps(edit, [{ kind: 'back' }]);
    expect(JSON.stringify(edit)).toBe(before);
  });
});
