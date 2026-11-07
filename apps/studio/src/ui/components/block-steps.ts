// The block being written in the Blocks tab, as the form sees it. Kept out of
// the editor so it has no JSX and tests can import it. A form field holds text
// as a person reads it; Maestro reads selectors as regular expressions and a
// setting as ${NAME}, and those two forms only meet here.
import { isSecretName, reference, referencedKey } from '@ariadne/core/block-values';
import { escapeMaestroRegex, unescapeMaestroRegex } from '@ariadne/core/escape';
import { flowVariables, type MaestroSelector, type MaestroStep } from '@ariadne/core/model';
import { DEFAULT_WAIT_SECONDS, type BlockDetail, type CaseBlockDraft, type ScreenPick } from '../../shared/api-types.ts';

export type Field = {
  mode: 'text' | 'id' | 'setting' | 'point';
  value: string;
  /** A regular expression someone wrote by hand. It stays as it is until someone types over it. */
  pattern?: boolean;
  /** A setting's name is being typed here, unlike one read from a file, which stays exactly as it is. */
  typing?: boolean;
};

export type DraftStep = {
  /** Stays with the step when it moves, for React and for the pick on the screen. */
  key: number;
  /** The step as it was. `field` replaces its target, text or link when it is written. */
  step: MaestroStep;
  field?: Field;
  /** The target was picked on the screen, and it is a password field. */
  passwordField?: boolean;
};

export type BlockEdit = {
  /** Unset until a new block is saved for the first time. */
  file?: string;
  /** The app a block made from a case is for. Otherwise a new block is for the connected app. */
  appId?: string;
  name: string;
  steps: DraftStep[];
  /** What is saved, to tell whether anything changed. */
  saved: string;
  fixed: string[];
  usedBy: string[];
  hasComments: boolean;
  /** The values to try the block with, as a case would set them. */
  values?: Record<string, string>;
};

/** A new step of each kind the form can write, most used first. */
export const STEP_CHOICES: ReadonlyArray<{ label: string; step: MaestroStep }> = [
  { label: 'Start the app', step: { kind: 'launchApp' } },
  { label: 'Tap', step: { kind: 'tapOn', selector: { kind: 'text', value: '' } } },
  { label: 'Type', step: { kind: 'inputText', text: '' } },
  { label: 'Check', step: { kind: 'assertVisible', selector: { kind: 'text', value: '' } } },
  { label: 'Wait', step: { kind: 'wait', seconds: DEFAULT_WAIT_SECONDS } },
  { label: 'Scroll to', step: { kind: 'scrollUntilVisible', selector: { kind: 'text', value: '' }, direction: 'DOWN' } },
  { label: 'Check it is not visible', step: { kind: 'assertNotVisible', selector: { kind: 'text', value: '' } } },
  { label: 'Long press', step: { kind: 'longPressOn', selector: { kind: 'text', value: '' } } },
  { label: 'Double tap', step: { kind: 'doubleTapOn', selector: { kind: 'text', value: '' } } },
  { label: 'Swipe', step: { kind: 'swipe', direction: 'LEFT' } },
  { label: 'Scroll down', step: { kind: 'scroll' } },
  { label: 'Press Back', step: { kind: 'back' } },
  { label: 'Press a key', step: { kind: 'pressKey', key: 'Enter' } },
  { label: 'Erase text', step: { kind: 'eraseText' } },
  { label: 'Hide the keyboard', step: { kind: 'hideKeyboard' } },
  { label: 'Open link', step: { kind: 'openLink', link: '' } },
];

/** How many of STEP_CHOICES get a button of their own; the rest wait in a list. */
export const QUICK_STEPS = 5;

/** The step's name above its fields, or undefined for a step the form only keeps. */
export function stepLabel(step: MaestroStep): string | undefined {
  // A swipe between two points has no field here, only a swipe in a direction.
  if (step.kind === 'swipe' && !('direction' in step)) return undefined;
  return STEP_CHOICES.find((choice) => choice.step.kind === step.kind)?.label;
}

function selectorOf(step: MaestroStep): MaestroSelector | undefined {
  return 'selector' in step ? step.selector : undefined;
}

function selectorField(selector: MaestroSelector): Field {
  if (selector.kind === 'point') return { mode: 'point', value: '' };
  const key = referencedKey(selector.value);
  if (key) return { mode: 'setting', value: key };
  const literal = unescapeMaestroRegex(selector.value);
  if (escapeMaestroRegex(literal) === selector.value) return { mode: selector.kind, value: literal };
  return { mode: selector.kind, value: selector.value, pattern: true };
}

function textField(text: string): Field {
  const key = referencedKey(text);
  return key ? { mode: 'setting', value: key } : { mode: 'text', value: text };
}

function fieldOf(step: MaestroStep): Field | undefined {
  if (step.kind === 'inputText') return textField(step.text);
  if (step.kind === 'openLink') return textField(step.link);
  const selector = selectorOf(step);
  return selector && stepLabel(step) ? selectorField(selector) : undefined;
}

let lastKey = 0;

export function draftStep(step: MaestroStep): DraftStep {
  const field = fieldOf(step);
  return { key: ++lastKey, step, ...(field ? { field } : {}) };
}

/** A trailing "_" in a name being typed is only the next word to come; in a file it is part of the name, and cases pass it. */
const settingReference = (field: Field) => reference(field.typing ? field.value.replace(/_+$/, '') : field.value);

const fieldText = (field: Field) => (field.mode === 'setting' ? settingReference(field) : field.value);

function buildSelector(base: MaestroSelector, field: Field): MaestroSelector {
  if (field.mode === 'point') return base;
  // A setting keeps the kind of target it replaced: an id in a file stays an id.
  const kind = field.mode === 'setting' ? (base.kind === 'id' ? 'id' : 'text') : field.mode;
  const value = field.mode === 'setting' ? settingReference(field) : field.pattern ? field.value : escapeMaestroRegex(field.value);
  return base.kind !== 'point' && base.index !== undefined ? { kind, value, index: base.index } : { kind, value };
}

/** The Maestro step a row of the form stands for. */
export function buildStep({ step, field }: DraftStep): MaestroStep {
  if (!field) return step;
  if (step.kind === 'inputText') return { ...step, text: fieldText(field) };
  if (step.kind === 'openLink') return { ...step, link: fieldText(field) };
  const selector = selectorOf(step);
  return selector ? ({ ...step, selector: buildSelector(selector, field) } as MaestroStep) : step;
}

export const buildSteps = (steps: readonly DraftStep[]): MaestroStep[] => steps.map(buildStep);

const savedForm = (name: string, steps: readonly DraftStep[]) => JSON.stringify({ name: name.trim(), steps: buildSteps(steps) });

export function isDirty(edit: BlockEdit): boolean {
  return savedForm(edit.name, edit.steps) !== edit.saved;
}

export function newBlock(): BlockEdit {
  return { name: '', steps: [], saved: savedForm('', []), fixed: [], usedBy: [], hasComments: false };
}

export function editFromDetail(detail: BlockDetail): BlockEdit {
  const steps = detail.steps.map(draftStep);
  return { file: detail.file, name: detail.name, steps, saved: savedForm(detail.name, steps), fixed: detail.fixed, usedBy: detail.usedBy, hasComments: detail.hasComments };
}

/** A saved case as a block that is not saved yet, so its details can become settings first. */
export function blockFromCase({ name, appId, steps }: CaseBlockDraft): BlockEdit {
  return { ...newBlock(), name, appId, steps: steps.map(draftStep) };
}

/** Recorded steps go after the ones already in the form. */
export function withRecordedSteps(edit: BlockEdit, steps: readonly MaestroStep[]): BlockEdit {
  return { ...edit, steps: [...edit.steps, ...steps.map(draftStep)] };
}

/** A person's name for a setting as it is written: "email address" -> "EMAIL_ADDRESS". */
export function settingInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^[_0-9]+/, '');
}

/**
 * The field after its kind changes. A setting starts with no name: text already
 * typed may be a password, and a name goes into the block file.
 */
export function switchedField(field: Field, mode: Field['mode']): Field {
  const keeps = mode !== 'setting' && field.mode !== 'setting' && field.mode !== 'point';
  return { mode, value: keeps ? field.value : '' };
}

/** A typed value replaces the step's target as a whole, so the number of a repeated element goes too. */
export function typedStep(draft: DraftStep, field: Field): DraftStep {
  // What was picked on the screen is no longer the target, so neither is its password field.
  const { passwordField: _picked, ...kept } = draft;
  const selector = selectorOf(draft.step);
  if (!selector || selector.kind === 'point') return { ...kept, field };
  const { kind, value } = selector;
  return { ...kept, step: { ...draft.step, selector: { kind, value } } as MaestroStep, field };
}

/** What the steps ask a case to set, in the order of the name. */
export function blockSettings(steps: readonly DraftStep[]): string[] {
  return flowVariables({ steps: buildSteps(steps) });
}

/** The step with the element picked on the screen as its target; undefined when it cannot look for a point. */
export function pickedStep(draft: DraftStep, pick: ScreenPick): DraftStep | undefined {
  const { kind } = draft.step;
  const presses = kind === 'tapOn' || kind === 'longPressOn' || kind === 'doubleTapOn';
  if (pick.selector.kind === 'point' && !presses) return undefined;
  const step = { ...draft.step, selector: pick.selector } as MaestroStep;
  return { key: draft.key, step, field: selectorField(pick.selector), ...(pick.password ? { passwordField: true } : {}) };
}

function tappedPasswordField(before: DraftStep | undefined): 'sure' | 'maybe' | undefined {
  if (before?.step.kind !== 'tapOn') return undefined;
  if (before.passwordField) return 'sure';
  return before.field && before.field.mode !== 'setting' && isSecretName(before.field.value) ? 'maybe' : undefined;
}

/**
 * Whether a Type step puts plain text into a password field, which would write
 * the password into the block file: 'sure' when the field was picked on the
 * screen, 'maybe' when only its name says so ("Shopping" has PIN in it too).
 */
export function passwordInText(steps: readonly DraftStep[], position: number): 'sure' | 'maybe' | undefined {
  const draft = steps[position];
  if (draft?.step.kind !== 'inputText' || draft.field?.mode !== 'text') return undefined;
  return tappedPasswordField(steps[position - 1]);
}
