// The form that writes a setup block: a name, its steps and the settings a case
// can choose. A step's target can be picked on the screen, so nobody needs to
// know an element's id, and nobody sees the file behind it.
import { useState } from 'react';
import { isSecretName } from '@ariadne/core/block-values';
import { describeMaestroStep } from '@ariadne/core/describe';
import { MAESTRO_KEYS, type MaestroKey, type SwipeDirection } from '@ariadne/core/model';
import { MAX_WAIT_SECONDS, type BlockSummary } from '../../shared/api-types.ts';
import { blockProblem } from '../../shared/block-check.ts';
import {
  QUICK_STEPS,
  STEP_CHOICES,
  blockSettings,
  buildSteps,
  draftStep,
  isDirty,
  passwordInText,
  settingInput,
  stepLabel,
  switchedField,
  typedStep,
  type BlockEdit,
  type DraftStep,
  type Field,
} from './block-steps.ts';
import { BlockSettings } from './BlockSettings.tsx';
import { MarkCell } from './Mark.tsx';
import { markOfMaestroStep } from './step-marks.ts';

const SETTINGS_LIST = 'block-setting-names';
const SWIPE_DIRECTIONS: readonly SwipeDirection[] = ['LEFT', 'RIGHT', 'UP', 'DOWN'];

/** The field that names a setting; existing names are offered so a block reuses them. */
function SettingName({ value, label, disabled, onChange }: { value: string; label: string; disabled: boolean; onChange: (name: string) => void }) {
  return (
    <input
      className="draft-setting"
      aria-label={label}
      list={SETTINGS_LIST}
      value={value}
      placeholder="For example: EMAIL"
      disabled={disabled}
      onChange={(event) => onChange(settingInput(event.target.value))}
    />
  );
}

type TargetProps = {
  field: Field;
  disabled: boolean;
  picking: boolean;
  /** Why Pick on the screen is off, if it is. */
  pickOff: string | undefined;
  onChange: (field: Field) => void;
  onPick: () => void;
};

/** What a step acts on: text on the screen, an element's id, or a setting a case chooses. */
function TargetField({ field, disabled, picking, pickOff, onChange, onPick }: TargetProps) {
  return (
    <>
      <div className="draft-field">
        <select
          aria-label="How to find it"
          value={field.mode}
          disabled={disabled}
          onChange={(event) => onChange(switchedField(field, event.target.value as Field['mode']))}
        >
          <option value="text">Text on screen</option>
          <option value="id">Element id</option>
          <option value="setting">A setting</option>
          {field.mode === 'point' && <option value="point">A place on the screen</option>}
        </select>
        {field.mode === 'setting' ? (
          <SettingName value={field.value} label="Setting name" disabled={disabled} onChange={(value) => onChange({ mode: 'setting', value, typing: true })} />
        ) : field.mode === 'point' ? (
          <span className="hint draft-point">Pick a named element if there is one: a place can miss on another phone.</span>
        ) : (
          <input
            aria-label={field.mode === 'id' ? 'Element id' : 'Text on the screen'}
            value={field.value}
            placeholder={field.mode === 'id' ? 'Or pick it on the screen' : 'For example: Sign in'}
            disabled={disabled}
            onChange={(event) => onChange({ mode: field.mode, value: event.target.value })}
          />
        )}
      </div>
      {field.pattern && <p className="hint">A pattern from the file, which can match more than one text. Text typed here is looked for exactly.</p>}
      <button type="button" className={`draft-pick ${picking ? 'toggle-on' : ''}`} aria-pressed={picking} disabled={disabled || pickOff !== undefined} title={pickOff} onClick={onPick}>
        {picking ? 'Click it on the screen, or press here to stop' : 'Pick on the screen'}
      </button>
    </>
  );
}

/** Typed text or a link: as written, or a setting a case chooses. */
function TextField({ field, label, placeholder, disabled, onChange }: { field: Field; label: string; placeholder: string; disabled: boolean; onChange: (field: Field) => void }) {
  return (
    <div className="draft-field">
      <select aria-label={`Where ${label} comes from`} value={field.mode} disabled={disabled} onChange={(event) => onChange(switchedField(field, event.target.value as Field['mode']))}>
        <option value="text">As written</option>
        <option value="setting">A setting</option>
      </select>
      {field.mode === 'setting' ? (
        <SettingName value={field.value} label="Setting name" disabled={disabled} onChange={(value) => onChange({ mode: 'setting', value, typing: true })} />
      ) : (
        <input aria-label={label} value={field.value} placeholder={placeholder} disabled={disabled} onChange={(event) => onChange({ mode: 'text', value: event.target.value })} />
      )}
    </div>
  );
}

type RowProps = {
  draft: DraftStep;
  position: number;
  last: boolean;
  disabled: boolean;
  picking: boolean;
  pickOff: string | undefined;
  password: 'sure' | 'maybe' | undefined;
  onChange: (draft: DraftStep) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
  onPick: () => void;
};

function StepFields({ draft, disabled, picking, pickOff, password, onChange, onPick }: Omit<RowProps, 'position' | 'last' | 'onMove' | 'onRemove'>) {
  const { step, field } = draft;
  const setField = (next: Field) => onChange(typedStep(draft, next));
  switch (step.kind) {
    case 'launchApp':
      return (
        <label className="draft-check">
          <input
            type="checkbox"
            checked={step.clearState === true}
            disabled={disabled}
            onChange={(event) => {
              const { clearState: _old, ...rest } = step;
              onChange({ ...draft, step: event.target.checked ? { ...rest, clearState: true } : rest });
            }}
          />
          Clear the app's data first, as if it was just installed
        </label>
      );
    case 'inputText':
      return (
        <>
          <TextField field={field!} label="Text to type" placeholder="For example: 12345" disabled={disabled} onChange={setField} />
          {password && (
            <p className="block-missing draft-note">
              {password === 'sure' ? 'This goes into a password field.' : 'This looks like a password field.'} Use a setting, so the password stays in .env on this computer and out of the block.
            </p>
          )}
        </>
      );
    case 'openLink':
      return <TextField field={field!} label="Link" placeholder="https://... or myapp://..." disabled={disabled} onChange={setField} />;
    case 'waitUntilVisible':
      return (
        <>
          <TargetField field={field!} disabled={disabled} picking={picking} pickOff={pickOff} onChange={setField} onPick={onPick} />
          <label className="draft-inline">
            up to
            <input
              type="number"
              aria-label="Seconds to wait at most"
              min={1}
              max={MAX_WAIT_SECONDS}
              value={Number.isNaN(step.seconds) ? '' : step.seconds}
              disabled={disabled}
              onChange={(event) => onChange({ ...draft, step: { ...step, seconds: event.target.valueAsNumber } })}
            />
            seconds
          </label>
        </>
      );
    case 'wait':
      return (
        <label className="draft-inline">
          <input
            type="number"
            aria-label="Seconds to wait"
            min={1}
            max={MAX_WAIT_SECONDS}
            value={Number.isNaN(step.seconds) ? '' : step.seconds}
            disabled={disabled}
            onChange={(event) => onChange({ ...draft, step: { ...step, seconds: event.target.valueAsNumber } })}
          />
          seconds
        </label>
      );
    case 'eraseText':
      return (
        <label className="draft-inline">
          <input
            type="number"
            aria-label="Characters to erase"
            min={1}
            value={step.chars ?? ''}
            placeholder="All"
            disabled={disabled}
            onChange={(event) => {
              const { chars: _old, ...rest } = step;
              onChange({ ...draft, step: event.target.value === '' ? rest : { ...rest, chars: event.target.valueAsNumber } });
            }}
          />
          characters
        </label>
      );
    case 'swipe':
      if (!('direction' in step)) return null;
      return (
        <select aria-label="Direction" value={step.direction} disabled={disabled} onChange={(event) => onChange({ ...draft, step: { kind: 'swipe', direction: event.target.value as SwipeDirection } })}>
          {SWIPE_DIRECTIONS.map((direction) => (
            <option key={direction} value={direction}>
              {direction[0]}
              {direction.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
      );
    case 'pressKey':
      return (
        <select aria-label="Key" value={step.key} disabled={disabled} onChange={(event) => onChange({ ...draft, step: { kind: 'pressKey', key: event.target.value as MaestroKey } })}>
          {MAESTRO_KEYS.map((key) => (
            <option key={key}>{key}</option>
          ))}
        </select>
      );
    default:
      if (!field) return null;
      return (
        <>
          <TargetField field={field} disabled={disabled} picking={picking} pickOff={pickOff} onChange={setField} onPick={onPick} />
          {step.kind === 'scrollUntilVisible' && (
            <select
              aria-label="Which way to scroll"
              className="draft-direction"
              value={step.direction}
              disabled={disabled}
              onChange={(event) => onChange({ ...draft, step: { ...step, direction: event.target.value as SwipeDirection } })}
            >
              <option value="DOWN">Scrolling down</option>
              <option value="UP">Scrolling up</option>
            </select>
          )}
        </>
      );
  }
}

function StepRow(props: RowProps) {
  const { draft, position, last, disabled, onMove, onRemove } = props;
  const label = stepLabel(draft.step);
  const mark = markOfMaestroStep(draft.step);
  return (
    <li className={`step step-draft step-${mark}`}>
      <MarkCell mark={mark} number={position + 1} />
      <div className="draft-body">
        <span className="draft-step-name">{label ?? describeMaestroStep(draft.step)}</span>
        {label ? <StepFields {...props} /> : <p className="hint">Kept as it is in the file.</p>}
      </div>
      <span className="row-tools">
        <button type="button" onClick={() => onMove(position - 1)} disabled={disabled || position === 0} aria-label={`Move step ${position + 1} up`} title="Move up">
          ↑
        </button>
        <button type="button" onClick={() => onMove(position + 1)} disabled={disabled || last} aria-label={`Move step ${position + 1} down`} title="Move down">
          ↓
        </button>
        <button type="button" onClick={onRemove} disabled={disabled} aria-label={`Remove step ${position + 1}`} title="Remove">
          ×
        </button>
      </span>
    </li>
  );
}

type SettingProps = {
  name: string;
  fixed: boolean;
  saved: boolean;
  disabled: boolean;
  onSave: (name: string, value: string) => Promise<boolean>;
};

/** One thing a case can choose, and whether it has a value to fall back on. */
function SettingRow({ name, fixed, saved, disabled, onSave }: SettingProps) {
  const [value, setValue] = useState('');
  const secret = isSecretName(name);
  return (
    <li className="draft-setting-row">
      <code>{name}</code>
      {fixed ? (
        <span className="hint">The block's file sets this, so a case cannot change it.</span>
      ) : saved ? (
        <span className="hint">Has a saved value on this computer. A case can pick another.</span>
      ) : (
        // A div, not a form: this sits beside the Enter key of the fields above.
        <div className="draft-field">
          <input
            aria-label={`Saved value for ${name}`}
            type={secret ? 'password' : 'text'}
            autoComplete="off"
            value={value}
            placeholder={secret ? 'The value, kept out of the block' : 'A value to use by default'}
            disabled={disabled}
            onChange={(event) => setValue(event.target.value)}
          />
          <button type="button" disabled={disabled || !value} onClick={() => void onSave(name, value).then((ok) => ok && setValue(''))}>
            Save value
          </button>
        </div>
      )}
    </li>
  );
}

export type BlockEditorProps = {
  edit: BlockEdit;
  /** The block in the project, once saved, for the settings to try it with. */
  summary: BlockSummary | undefined;
  envKeys: string[];
  busy: boolean;
  sessionOpen: boolean;
  /** The step whose target is being picked on the screen. */
  pickingKey: number | null;
  onChange: (edit: BlockEdit) => void;
  onPick: (key: number | null) => void;
  onSave: () => void;
  onTry: () => void;
  onRecord: () => void;
  onDelete: () => void;
  onClose: () => void;
  onSaveValue: (name: string, value: string) => Promise<boolean>;
  onAddTestUser: (name: string, values: Record<string, string>) => Promise<boolean>;
};

export function BlockEditor({ edit, summary, envKeys, busy, sessionOpen, pickingKey, onChange, onPick, onSave, onTry, onRecord, onDelete, onClose, onSaveValue, onAddTestUser }: BlockEditorProps) {
  const dirty = isDirty(edit);
  const built = buildSteps(edit.steps);
  const passwords = edit.steps.map((_, position) => passwordInText(edit.steps, position));
  const sureAt = passwords.indexOf('sure');
  const problem = sureAt >= 0 ? `Step ${sureAt + 1} goes into a password field, so make its text a setting.` : blockProblem(edit.name, built);
  const settings = blockSettings(edit.steps);
  const lastStep = built[built.length - 1];
  const endsOnCheck =
    lastStep?.kind === 'assertVisible' || lastStep?.kind === 'assertNotVisible' || lastStep?.kind === 'wait' || lastStep?.kind === 'waitUntilVisible';

  const setSteps = (steps: DraftStep[]) => onChange({ ...edit, steps });
  const addStep = (choice: number) => setSteps([...edit.steps, draftStep(STEP_CHOICES[choice]!.step)]);
  const moveStep = (from: number, to: number) => {
    const next = [...edit.steps];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    setSteps(next);
  };
  const close = () => {
    if (dirty && !window.confirm('Leave this block without saving your changes?')) return;
    onClose();
  };

  return (
    <div className="block-editor">
      <div className="section-head">
        <h2>{edit.file ? 'Edit block' : 'New block'}</h2>
        <button type="button" className="link" onClick={close}>
          All blocks
        </button>
      </div>
      {edit.file && <p className="path">{edit.file}</p>}
      <label className="field">
        <span className="field-title">Block name</span>
        <input value={edit.name} onChange={(event) => onChange({ ...edit, name: event.target.value })} placeholder="For example: Log in" />
      </label>
      {edit.usedBy.length > 0 && <p className="hint block-note">Used by {edit.usedBy.join(', ')}. A change here reaches them on their next run.</p>}
      {edit.hasComments && <p className="hint block-note">The file has comments, which saving here removes.</p>}

      <h3>Steps</h3>
      {edit.steps.length === 0 ? (
        <p className="hint section-hint">
          Press Record steps and use the app on the screen, or add steps one by one. Recording starts from the screen shown now, so press Relaunch app first for a block that starts the app.
        </p>
      ) : (
        <ol className="steps draft-steps">
          {edit.steps.map((draft, position) => (
            <StepRow
              key={draft.key}
              draft={draft}
              position={position}
              last={position === edit.steps.length - 1}
              disabled={busy}
              picking={pickingKey === draft.key}
              pickOff={sessionOpen ? undefined : 'Connect a device first'}
              password={passwords[position]}
              onChange={(next) => setSteps(edit.steps.map((item) => (item.key === next.key ? next : item)))}
              onMove={(to) => moveStep(position, to)}
              onRemove={() => {
                if (pickingKey === draft.key) onPick(null);
                setSteps(edit.steps.filter((item) => item.key !== draft.key));
              }}
              onPick={() => onPick(pickingKey === draft.key ? null : draft.key)}
            />
          ))}
        </ol>
      )}
      <datalist id={SETTINGS_LIST}>
        {[...new Set([...settings, ...envKeys])].map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <div className="draft-add">
        <button
          type="button"
          className="draft-record"
          disabled={busy || !sessionOpen}
          title={sessionOpen ? 'Use the app on the screen, from where it is now. The steps are added after the last step here.' : 'Connect a device first'}
          onClick={onRecord}
        >
          <span className="record-dot" aria-hidden="true" />
          Record steps
        </button>
        {STEP_CHOICES.slice(0, QUICK_STEPS).map((choice, position) => (
          <button key={choice.label} type="button" disabled={busy} onClick={() => addStep(position)}>
            {choice.label}
          </button>
        ))}
        <select
          aria-label="Add another kind of step"
          value=""
          disabled={busy}
          onChange={(event) => {
            if (event.target.value) addStep(Number(event.target.value));
          }}
        >
          <option value="">More steps</option>
          {STEP_CHOICES.slice(QUICK_STEPS).map((choice, position) => (
            <option key={choice.label} value={position + QUICK_STEPS}>
              {choice.label}
            </option>
          ))}
        </select>
      </div>
      {edit.steps.length > 0 && !endsOnCheck && <p className="hint block-note">End with a Check on the screen this block should reach, so a block that goes wrong stops there and says so.</p>}

      {settings.length > 0 && (
        <>
          <h3>Settings</h3>
          <p className="hint section-hint">Each case that uses this block can choose these, such as which test user logs in.</p>
          <ul className="draft-settings">
            {settings.map((name) => (
              <SettingRow key={name} name={name} fixed={edit.fixed.includes(name)} saved={envKeys.includes(name)} disabled={busy} onSave={onSaveValue} />
            ))}
          </ul>
        </>
      )}

      {problem && (dirty || edit.file) && <p className="hint block-note">{problem}</p>}
      {summary && !dirty && (
        <BlockSettings
          block={summary}
          values={edit.values}
          envKeys={envKeys}
          disabled={busy}
          onChange={(values) => {
            const { values: _old, ...rest } = edit;
            onChange(values ? { ...rest, values } : rest);
          }}
          onAddTestUser={onAddTestUser}
        />
      )}
      <div className="case-actions wrap">
        <button type="button" className="primary" disabled={busy || !dirty || problem !== undefined} onClick={onSave}>
          Save block
        </button>
        <button type="button" disabled={busy || problem !== undefined || !sessionOpen} title={sessionOpen ? 'Runs the block from the screen shown now. Nothing is recorded.' : 'Connect a device first'} onClick={onTry}>
          {dirty ? 'Save and try' : 'Try on the device'}
        </button>
        {edit.file && (
          <button type="button" className="danger" disabled={busy} onClick={onDelete}>
            Delete block
          </button>
        )}
      </div>
    </div>
  );
}
