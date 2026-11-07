// The settings row under a setup block in the "Before recording" stack: which
// test user a log in block runs as, or a value for each of its settings.
// Secrets stay in .env: a setting that looks like a password can only point
// at a saved value, and a new test user is written to .env, never to a case.
import { useState } from 'react';
import { isSecretName, reference, referencedKey, testUserPrefix, testUsers } from '@ariadne/core/block-values';
import type { BlockSummary } from '../../shared/api-types.ts';

type Values = Record<string, string> | undefined;

type Props = {
  block: BlockSummary;
  values: Values;
  envKeys: string[];
  disabled: boolean;
  onChange: (values: Values) => void;
  /** Saves a test user to .env; resolves true when it was saved. */
  onAddTestUser: (name: string, values: Record<string, string>) => Promise<boolean>;
};

const CUSTOM = '__custom';
const NEW_USER = '__new';
const TYPED = '__typed';

/** Log in style blocks talk about test users; anything else about values. */
function aboutUsers(settable: readonly string[]): boolean {
  return settable.some((variable) => /USER|EMAIL|LOGIN|PASS/i.test(variable));
}

function sameValues(a: Values, b: Values): boolean {
  const entries = (values: Values) => JSON.stringify(Object.entries(values ?? {}).sort(([x], [y]) => x.localeCompare(y)));
  return entries(a) === entries(b);
}

function without(values: Values, variable: string): Values {
  const next = { ...values };
  delete next[variable];
  return Object.keys(next).length > 0 ? next : undefined;
}

/** One row per setting: the project's default, a saved value, or (for anything not secret) typed text. */
function EachValue({ settable, values, envKeys, disabled, onChange }: { settable: string[]; values: Values; envKeys: string[]; disabled: boolean; onChange: (values: Values) => void }) {
  const [typing, setTyping] = useState<string[]>(() => settable.filter((variable) => values?.[variable] !== undefined && !referencedKey(values[variable]!)));
  return (
    <div className="setting-values">
      {settable.map((variable) => {
        const value = values?.[variable];
        const key = value === undefined ? undefined : referencedKey(value);
        const secret = isSecretName(variable);
        const typed = typing.includes(variable);
        const choice = typed ? TYPED : key ? reference(key) : '';
        return (
          <div key={variable} className="setting-value">
            <code>{variable}</code>
            <select
              aria-label={`Value for ${variable}`}
              value={choice}
              disabled={disabled}
              onChange={(event) => {
                const next = event.target.value;
                if (next === TYPED) {
                  setTyping((current) => [...current, variable]);
                  onChange(without(values, variable));
                  return;
                }
                setTyping((current) => current.filter((item) => item !== variable));
                onChange(next ? { ...values, [variable]: next } : without(values, variable));
              }}
            >
              <option value="">the project's {variable}</option>
              {envKeys
                .filter((envKey) => envKey !== variable)
                .map((envKey) => (
                  <option key={envKey} value={reference(envKey)}>
                    saved value {envKey}
                  </option>
                ))}
              {!secret && <option value={TYPED}>type a value</option>}
            </select>
            {typed && (
              <input
                aria-label={`Text for ${variable}`}
                value={value ?? ''}
                disabled={disabled}
                placeholder="Value for this case"
                onChange={(event) => onChange(event.target.value ? { ...values, [variable]: event.target.value } : without(values, variable))}
              />
            )}
            {secret && !typed && <span className="hint">a secret, so only saved values</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Name a test user and give a value for each setting; saved to .env on this computer. */
function NewTestUser({ settable, disabled, onSave, onCancel }: { settable: string[]; disabled: boolean; onSave: (name: string, values: Record<string, string>) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const prefix = testUserPrefix(name);
  const ready = Boolean(prefix) && settable.every((variable) => values[variable]);
  const save = () => {
    if (ready) onSave(name.trim(), values);
  };
  return (
    // A div, not a form: this sits inside the New case form.
    <div
      className="new-user"
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
          event.preventDefault();
          save();
        }
      }}
    >
      <label className="setting-value">
        <span className="new-user-label">Name</span>
        <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="For example: Supervisor" disabled={disabled} />
      </label>
      {settable.map((variable) => (
        <label key={variable} className="setting-value">
          <code>{variable}</code>
          <input
            type={isSecretName(variable) ? 'password' : 'text'}
            autoComplete="off"
            value={values[variable] ?? ''}
            onChange={(event) => setValues((current) => ({ ...current, [variable]: event.target.value }))}
            disabled={disabled}
          />
        </label>
      ))}
      <p className="hint">
        Saved in this project's .env file on this computer, as{' '}
        {settable.map((variable) => `${prefix ?? 'NAME'}_${variable}`).join(' and ')}. Cases only store the name, never the values.
      </p>
      <div className="case-actions">
        <button type="button" onClick={save} disabled={disabled || !ready}>
          Save test user
        </button>
        <button type="button" onClick={onCancel} disabled={disabled}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function BlockSettings({ block, values, envKeys, disabled, onChange, onAddTestUser }: Props) {
  const settable = block.settable ?? [];
  const users = testUsers(settable, envKeys);
  // A test user only counts when every setting is that user's saved value.
  const current = values ? users.find((user) => sameValues(user.values, values)) : undefined;
  const [mode, setMode] = useState<'pick' | 'each' | 'new'>(values && !current ? 'each' : 'pick');
  if (settable.length === 0) return null;
  const forUsers = aboutUsers(settable);
  const missing = (block.missingVariables ?? []).filter((variable) => settable.includes(variable) && values?.[variable] === undefined);
  const selected = mode === 'each' ? CUSTOM : mode === 'new' ? NEW_USER : (current?.prefix ?? '');

  return (
    <div className="block-settings">
      <label className="setting-row">
        <span className="setting-title">{forUsers ? 'Test user' : 'Values'}</span>
        <select
          value={selected}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            if (next === CUSTOM) return setMode('each');
            if (next === NEW_USER) return setMode('new');
            setMode('pick');
            onChange(next ? users.find((user) => user.prefix === next)?.values : undefined);
          }}
        >
          <option value="">
            {forUsers ? 'Default user' : 'Defaults'} ({settable.join(', ')} as saved)
          </option>
          {users.map((user) => (
            <option key={user.prefix} value={user.prefix}>
              {user.label}
            </option>
          ))}
          <option value={CUSTOM}>Set each value...</option>
          {forUsers && <option value={NEW_USER}>Add a test user...</option>}
        </select>
      </label>
      {mode === 'pick' && missing.length > 0 && (
        <p className="piece-missing">
          {missing.join(', ')} {missing.length === 1 ? 'is' : 'are'} not saved yet, so the default {forUsers ? 'user' : 'values'} will not work. Pick or add a test
          user, or save a value in the Blocks tab.
        </p>
      )}
      {mode === 'each' && <EachValue settable={settable} values={values} envKeys={envKeys} disabled={disabled} onChange={onChange} />}
      {mode === 'new' && (
        <NewTestUser
          settable={settable}
          disabled={disabled}
          onCancel={() => setMode('pick')}
          onSave={(name, entered) =>
            void onAddTestUser(name, entered).then((saved) => {
              const prefix = testUserPrefix(name);
              if (!saved || !prefix) return;
              onChange(Object.fromEntries(settable.map((variable) => [variable, reference(`${prefix}_${variable}`)])));
              setMode('pick');
            })
          }
        />
      )}
    </div>
  );
}
