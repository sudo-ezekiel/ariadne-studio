// Setup blocks: the library a BA drags from, and the stack of what runs before
// recording that they drop into. Both are rows on the thread, like the steps: a
// block wears a violet square with the puzzle glyph, never a card. Drag and
// drop has a click path beside it (Add, move up, move down, remove) for
// keyboards and trackpads.
import { useState, type DragEvent } from 'react';
import { describeValues } from '@ariadne/core/block-values';
import type { BlockUse } from '@ariadne/core/types';
import type { BlockSummary, CaseListItem } from '../../shared/api-types.ts';
import { placeBlock, type DragData } from './block-order.ts';
import { BlockSettings } from './BlockSettings.tsx';
import { GripIcon, PuzzleIcon } from './Icons.tsx';
import { MarkCell } from './Mark.tsx';
import { count } from './format.ts';

const DRAG_TYPE = 'application/x-ariadne-block';

function startDrag(event: DragEvent, data: DragData) {
  event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(data));
  event.dataTransfer.effectAllowed = data.from === null ? 'copy' : 'move';
}

function readDrag(event: DragEvent): DragData | undefined {
  try {
    const data = JSON.parse(event.dataTransfer.getData(DRAG_TYPE)) as DragData;
    return typeof data.file === 'string' ? data : undefined;
  } catch {
    return undefined;
  }
}

export const carriesBlock = (event: DragEvent) => event.dataTransfer.types.includes(DRAG_TYPE);

/** "Uses USERNAME, PASSWORD", with the ones nobody has set called out. */
function Variables({ block }: { block: BlockSummary }) {
  if (!block.variables?.length) return null;
  const missing = block.missingVariables ?? [];
  return (
    <span className="block-vars">
      Uses {block.variables.join(', ')} from .env
      {missing.length > 0 && (
        <span className="block-missing">
          {' '}
          ({missing.join(', ')} {missing.length === 1 ? 'is' : 'are'} not set yet; save a value in the Blocks tab)
        </span>
      )}
    </span>
  );
}

/**
 * What the block does, step by step, folded away until asked for. Under a
 * numbered row the steps are numbered under it (4.1, 4.2), which is what says
 * they run inside that step.
 */
export function BlockSteps({ block, number }: { block: BlockSummary | undefined; number?: number }) {
  if (!block?.steps?.length) return null;
  return (
    <details className="block-steps">
      <summary>What it does</summary>
      <ol>
        {block.steps.map((step, index) => (
          <li key={index}>
            <span className="block-step-number">{number === undefined ? index + 1 : `${number}.${index + 1}`}</span>
            {step}
          </li>
        ))}
      </ol>
    </details>
  );
}

type PaletteProps = {
  blocks: BlockSummary[];
  /** Set when blocks cannot be added now, with the reason. */
  lockedReason: string | undefined;
  /** In the middle of a recording, a block that clears the app's data undoes the steps so far; say so. */
  warnClears?: boolean;
  /** Label of the Add button: "Add" before recording, "Run now" while recording. */
  addLabel?: string;
  /** While recording, each block carries its own settings (which test user), used by Run now and by a drop. */
  settings?: {
    envKeys: string[];
    values: Record<string, Record<string, string> | undefined>;
    onChange: (file: string, values: Record<string, string> | undefined) => void;
    onAddTestUser: (name: string, values: Record<string, string>) => Promise<boolean>;
  };
  onAdd: (file: string) => void;
  onDragging: (dragging: boolean) => void;
};

/** Every block in the project's block folders, ready to drag into the stack. */
export function BlockPalette({ blocks, lockedReason, warnClears, addLabel = 'Add', settings, onAdd, onDragging }: PaletteProps) {
  if (blocks.length === 0) {
    return <p className="empty palette-empty">No blocks in this project yet. Write one in the Blocks tab, for example a log in that every case can start with.</p>;
  }
  return (
    <ul className="palette">
      {blocks.map((block) => {
        const usable = !block.error && !lockedReason;
        return (
          <li
            key={block.file}
            className={`palette-row ${usable ? 'palette-row-usable' : ''} ${block.error ? 'palette-row-broken' : ''}`}
            draggable={usable}
            onDragStart={(event) => {
              startDrag(event, { file: block.file, from: null });
              onDragging(true);
            }}
            onDragEnd={() => onDragging(false)}
            title={usable ? 'Drag into "Before recording", or press Add' : (block.error ?? lockedReason)}
          >
            <span className="grip">{usable && <GripIcon size={14} />}</span>
            <span className="mark mark-block">
              <PuzzleIcon size={10} />
            </span>
            <span className="palette-name">{block.name}</span>
            <span className="palette-meta">{block.stepCount !== undefined && count(block.stepCount, 'step')}</span>
            <button type="button" className="palette-add" onClick={() => onAdd(block.file)} disabled={!usable}>
              {addLabel}
            </button>
            <div className="palette-body">
              <span className="block-file">{block.file}</span>
              {block.error ? <span className="block-error">Cannot be used: {block.error}</span> : <Variables block={block} />}
              {block.runsWith === 'maestro' && (
                <span className="block-vars" title={`Uses ${(block.maestroOnly ?? []).join(', ')}, which only Maestro runs`}>
                  Runs with Maestro, so it starts more slowly
                </span>
              )}
              {warnClears && block.clearsAppData && <span className="block-missing">It clears the app's data first, so the app starts over as if just installed.</span>}
              <BlockSteps block={block} />
              {settings && usable && (
                <BlockSettings
                  block={block}
                  values={settings.values[block.file]}
                  envKeys={settings.envKeys}
                  disabled={Boolean(lockedReason)}
                  onChange={(values) => settings.onChange(block.file, values)}
                  onAddTestUser={settings.onAddTestUser}
                />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

type StackProps = {
  blocks: BlockSummary[];
  cases: Array<{ item: CaseListItem; depth: number }>;
  appId: string;
  /** Names of the project's saved values, for the block settings. */
  envKeys: string[];
  lane: BlockUse[];
  startFrom: string;
  /** A block is being dragged from the palette, so the stack should invite it. */
  dragging: boolean;
  disabled: boolean;
  onLaneChange: (lane: BlockUse[]) => void;
  onStartFromChange: (caseId: string) => void;
  onAddTestUser: (name: string, values: Record<string, string>) => Promise<boolean>;
};

/**
 * What runs before recording, top to bottom: the start (a fresh start of the
 * app, or the end of a saved case), then the setup blocks in order. A case that
 * starts from another case runs that case's blocks, so it has none of its own.
 */
export function SetupStack({ blocks, cases, appId, envKeys, lane, startFrom, dragging, disabled, onLaneChange, onStartFromChange, onAddTestUser }: StackProps) {
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [moving, setMoving] = useState(false);
  const byFile = new Map(blocks.map((block) => [block.file, block]));
  const accepts = !startFrom && !disabled;
  const inviting = accepts && (dragging || moving);

  const over = (event: DragEvent<HTMLElement>, index: number, split: boolean) => {
    if (!accepts || !carriesBlock(event)) return;
    event.preventDefault();
    let at = index;
    if (split) {
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientY > box.top + box.height / 2) at = index + 1;
    }
    setDropAt(at);
  };

  const drop = (event: DragEvent<HTMLElement>) => {
    if (!accepts) return;
    event.preventDefault();
    const data = readDrag(event);
    if (data && dropAt !== null) onLaneChange(placeBlock(lane, data, dropAt, (file): BlockUse => ({ file })));
    setDropAt(null);
    setMoving(false);
  };

  const move = (from: number, to: number) => onLaneChange(placeBlock(lane, { file: lane[from]!.file, from }, to));
  const setValues = (index: number, values: Record<string, string> | undefined) =>
    onLaneChange(lane.map((use, position) => (position !== index ? use : values ? { file: use.file, values } : { file: use.file })));
  const tailText = inviting ? 'Run it before recording' : lane.length === 0 ? 'Drag a setup block here to run it first, such as a log in, or press Add on one below.' : 'Drag another block here, or press Add.';

  return (
    <ol
      className="steps stack"
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(null);
      }}
      onDrop={drop}
    >
      <li className="step step-start" onDragOver={(event) => over(event, 0, false)}>
        <MarkCell mark="start" />
        <label className="stack-start">
          <span>Start from</span>
          <select value={startFrom} onChange={(event) => onStartFromChange(event.target.value)} disabled={disabled}>
            <option value="">a fresh start of {appId || 'the app'}</option>
            {cases.map(({ item, depth }) => (
              <option key={item.id} value={item.id}>
                {`${'  '.repeat(depth)}the end of "${item.name}"`}
              </option>
            ))}
          </select>
        </label>
      </li>
      {!startFrom &&
        lane.map((use, index) => {
          const { file } = use;
          const block = byFile.get(file);
          const name = block?.name ?? file;
          return (
            <li
              key={`${file}-${index}`}
              className={`step step-block ${dropAt === index ? 'drop-before' : ''} ${block ? '' : 'step-broken'} ${disabled ? '' : 'step-movable'}`}
              draggable={!disabled}
              onDragStart={(event) => {
                startDrag(event, { file, from: index });
                setMoving(true);
              }}
              onDragEnd={() => {
                setDropAt(null);
                setMoving(false);
              }}
              onDragOver={(event) => over(event, index, true)}
            >
              <MarkCell mark="block" />
              <span className="stack-body">
                <span className="stack-name">
                  {name}
                  {block?.stepCount !== undefined && <span className="stack-meta">{count(block.stepCount, 'step')}</span>}
                </span>
                {!block && <span className="block-error">This block file is no longer there.</span>}
                {block && (
                  <BlockSettings
                    block={block}
                    values={use.values}
                    envKeys={envKeys}
                    disabled={disabled}
                    onChange={(values) => setValues(index, values)}
                    onAddTestUser={onAddTestUser}
                  />
                )}
              </span>
              <span className="row-tools">
                <button type="button" onClick={() => move(index, index - 1)} disabled={disabled || index === 0} aria-label={`Move ${name} up`} title="Move up">
                  ↑
                </button>
                <button type="button" onClick={() => move(index, index + 2)} disabled={disabled || index === lane.length - 1} aria-label={`Move ${name} down`} title="Move down">
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => onLaneChange(lane.filter((_, position) => position !== index))}
                  disabled={disabled}
                  aria-label={`Remove ${name}`}
                  title="Remove"
                >
                  ×
                </button>
              </span>
            </li>
          );
        })}
      {startFrom ? (
        <li className="step step-tail">
          <MarkCell mark="wait" />
          <span className="stack-tail">That case runs its own setup blocks first, so this case cannot add any.</span>
        </li>
      ) : (
        <li
          className={`step step-tail ${inviting ? 'step-tail-inviting' : ''} ${dropAt === lane.length ? 'drop-before' : ''}`}
          onDragOver={(event) => over(event, lane.length, false)}
        >
          <MarkCell mark="wait" />
          <span className="stack-tail">{tailText}</span>
        </li>
      )}
    </ol>
  );
}

/**
 * The same stack, read only, as the first rows of the steps while recording:
 * the start, then each setup block. They sit in the steps' own list, so the
 * thread runs on unbroken from the start to the last step.
 */
export function SetupRows({ blocks, lane, startFromName, appId }: { blocks: BlockSummary[]; lane: BlockUse[]; startFromName: string | undefined; appId: string }) {
  const byFile = new Map(blocks.map((block) => [block.file, block]));
  return (
    <>
      <li className="step step-start">
        <MarkCell mark="start" />
        <span className="step-kind">start</span>
        <span className="step-detail">{startFromName ? `Starts from the end of "${startFromName}"` : `Starts with a fresh start of ${appId}`}</span>
      </li>
      {lane.map((use, index) => {
        const block = byFile.get(use.file);
        return (
          <li key={`${use.file}-${index}`} className="step step-block">
            <MarkCell mark="block" />
            <span className="step-kind">
              <PuzzleIcon size={11} />
              block
            </span>
            <span className="step-detail">
              {block?.name ?? use.file}
              {use.values && <span className="block-values"> {describeValues(use.values)}</span>}
              <BlockSteps block={block} />
            </span>
          </li>
        );
      })}
    </>
  );
}

/** Shown after the last step only while a block is dragged: drop it here to run it now. */
export function BlockDropSlot({ disabled, onDrop }: { disabled: boolean; onDrop: (file: string) => void }) {
  const [over, setOver] = useState(false);
  return (
    <li
      className={`step step-tail step-tail-inviting ${over ? 'drop-before' : ''}`}
      onDragOver={(event) => {
        if (disabled || !carriesBlock(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        const data = readDrag(event);
        if (data && !disabled) onDrop(data.file);
      }}
    >
      <MarkCell mark="wait" />
      <span className="stack-tail">Run it now, as the next step</span>
    </li>
  );
}
