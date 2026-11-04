import { useState } from 'react';
import type { ExpectationCandidate } from '@ariadne/core/types';
import { selectorText } from './format.ts';

const MAX_PICKS = 3;

type Props = {
  candidates: ExpectationCandidate[];
  /** Ticked at first: the end expectations the case had before it was re-recorded. */
  preselected?: number[];
  busy: boolean;
  onSave: (picks: number[]) => void;
  onCancel: () => void;
};

/** Inline picker shown by Finish case: tick up to three things that must be visible at the end. */
export function ExpectationPicker({ candidates, preselected, busy, onSave, onCancel }: Props) {
  const [picked, setPicked] = useState<number[]>(() => (preselected ?? []).slice(0, MAX_PICKS));

  const toggle = (id: number) =>
    setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  return (
    <div className="picker">
      <h3>What should be visible at the end?</h3>
      <p className="hint">
        Tick up to {MAX_PICKS}. Ariadne checks them at the end of every run. Saving with none ticked is fine.
      </p>
      {candidates.length === 0 ? (
        <p className="empty">No stable text on this screen to check.</p>
      ) : (
        <ul className="picker-list">
          {candidates.map((candidate) => {
            const checked = picked.includes(candidate.id);
            return (
              <li key={candidate.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy || (!checked && picked.length >= MAX_PICKS)}
                    onChange={() => toggle(candidate.id)}
                  />{' '}
                  {candidate.label} <code>{selectorText(candidate.selector)}</code>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="case-actions">
        <button type="button" className="primary" onClick={() => onSave([...picked].sort((a, b) => a - b))} disabled={busy}>
          Save case
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
