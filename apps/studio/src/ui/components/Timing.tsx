// Waits in a step list: the field that sets a wait's seconds, and the tray a
// Wait is dragged from while recording. A wait does nothing on the phone, so it
// can go between any two steps; a block runs on the phone and only goes last.
import { useState, type DragEvent } from 'react';
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from '../../shared/api-types.ts';
import { GripIcon, WaitIcon } from './Icons.tsx';

export const WAIT_DRAG_TYPE = 'application/x-ariadne-wait';

export const carriesWait = (event: DragEvent) => event.dataTransfer.types.includes(WAIT_DRAG_TYPE);

const validSeconds = (text: string) => {
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 && value <= MAX_WAIT_SECONDS;
};

type SecondsProps = {
  seconds: number;
  /** For a wait until: what it waits for, as the row reads it. */
  target?: string;
  disabled: boolean;
  onSave: (seconds: number) => void;
  onCancel: () => void;
};

/** "Wait [ 20 ] seconds", opened on a wait row to change it. Escape keeps what was there. */
export function SecondsField({ seconds, target, disabled, onSave, onCancel }: SecondsProps) {
  const [text, setText] = useState(String(seconds));
  const valid = validSeconds(text);
  return (
    <form
      className="seconds-field"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        if (Number(text) === seconds) onCancel();
        else onSave(Number(text));
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <span>{target === undefined ? 'Wait' : 'Wait up to'}</span>
      <input
        autoFocus
        type="number"
        min={1}
        max={MAX_WAIT_SECONDS}
        value={text}
        aria-label="Seconds to wait"
        disabled={disabled}
        onFocus={(event) => event.target.select()}
        onChange={(event) => setText(event.target.value)}
      />
      <span>{target === undefined ? 'seconds' : `seconds for ${target} to appear`}</span>
      <span className="seconds-actions">
        <button type="submit" disabled={disabled || !valid}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </form>
  );
}

type TrayProps = {
  disabled: boolean;
  /** Adds a wait after the last step. */
  onAdd: () => void;
  onDragging: (dragging: boolean) => void;
};

/** The Wait tile at the end of the thread: drag it between two steps, or press Add. */
export function WaitTray({ disabled, onAdd, onDragging }: TrayProps) {
  return (
    <div className="tray">
      <span
        className="tray-tile"
        draggable={!disabled}
        aria-disabled={disabled}
        title="Drag a pause into the steps"
        onDragStart={(event) => {
          event.dataTransfer.setData(WAIT_DRAG_TYPE, String(DEFAULT_WAIT_SECONDS));
          event.dataTransfer.effectAllowed = 'copy';
          onDragging(true);
        }}
        onDragEnd={() => onDragging(false)}
      >
        <GripIcon size={14} />
        <WaitIcon size={14} />
        Wait
      </span>
      <span className="tray-hint">Drag it between two steps, or press Add to put it at the end. A run pauses there; nothing happens on the phone now.</span>
      <button type="button" onClick={onAdd} disabled={disabled}>
        Add
      </button>
    </div>
  );
}
