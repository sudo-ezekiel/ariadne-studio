// Setup blocks as jigsaw pieces: the library a BA drags from, and the stack of
// what runs before recording that they drop into. Drag and drop has a click
// path beside it (Add, move up, move down, remove) for keyboards and trackpads.
import { useState, type DragEvent } from 'react';
import { describeValues } from '@ariadne/core/block-values';
import type { BlockUse } from '@ariadne/core/types';
import type { BlockSummary, CaseListItem } from '../../shared/api-types.ts';
import { placeBlock, type DragData } from './block-order.ts';
import { BlockSettings } from './BlockSettings.tsx';
import { GripIcon, PuzzleIcon, StartIcon } from './Icons.tsx';
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

const carriesBlock = (event: DragEvent) => event.dataTransfer.types.includes(DRAG_TYPE);

/** "Uses USERNAME, PASSWORD", with the ones nobody has set called out. */
function Variables({ block }: { block: BlockSummary }) {
  if (!block.variables?.length) return null;
  const missing = block.missingVariables ?? [];
  return (
    <div className="piece-vars">
      Uses {block.variables.join(', ')} from .env
      {missing.length > 0 && (
        <span className="piece-missing">
          {' '}
          ({missing.join(', ')} {missing.length === 1 ? 'is' : 'are'} not set yet; ask a developer)
        </span>
      )}
    </div>
  );
}

/** What the block does, step by step, folded away until asked for. */
export function BlockSteps({ block }: { block: BlockSummary | undefined }) {
  if (!block?.steps?.length) return null;
  return (
    <details className="piece-steps">
      <summary>What it does</summary>
      <ol>
        {block.steps.map((step, index) => (
          <li key={index}>{step}</li>
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
  /** While recording, each piece carries its own settings (which test user), used by Run now and by a drop. */
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
    return (
      <p className="empty palette-empty">
        No blocks in this project yet. A developer adds them as Maestro files in <code>blocks/</code> (or the folders{' '}
        <code>paths.blocks</code> names in project.json), for example a log in that every case can start with.
      </p>
    );
  }
  return (
    <ul className="palette">
      {blocks.map((block) => {
        const usable = !block.error && !lockedReason;
        return (
          <li
            key={block.file}
            className={`piece piece-block ${block.error ? 'piece-broken' : ''}`}
            draggable={usable}
            onDragStart={(event) => {
              startDrag(event, { file: block.file, from: null });
              onDragging(true);
            }}
            onDragEnd={() => onDragging(false)}
            title={usable ? 'Drag into "Before recording", or press Add' : (block.error ?? lockedReason)}
          >
            <div className="piece-row">
              <span className="grip">
                <GripIcon />
              </span>
              <span className="piece-icon">
                <PuzzleIcon />
              </span>
              <span className="piece-name">{block.name}</span>
              {block.stepCount !== undefined && <span className="piece-meta">{count(block.stepCount, 'step')}</span>}
              {block.runsWith === 'maestro' && (
                <span className="tag" title={`Uses ${(block.maestroOnly ?? []).join(', ')}, which only Maestro runs`}>
                  Runs with Maestro, slower start
                </span>
              )}
              <button type="button" className="piece-add" onClick={() => onAdd(block.file)} disabled={!usable}>
                {addLabel}
              </button>
            </div>
            <div className="piece-body">
              <span className="piece-file">{block.file}</span>
              {block.error ? <div className="piece-error">Cannot be used: {block.error}</div> : <Variables block={block} />}
              {warnClears && block.clearsAppData && (
                <div className="piece-missing">It clears the app's data first, so the app starts over as if just installed.</div>
              )}
              <BlockSteps block={block} />
            </div>
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
  /** A block is being dragged from the palette, so the drop slot should invite it. */
  dragging: boolean;
  disabled: boolean;
  onLaneChange: (lane: BlockUse[]) => void;
  onStartFromChange: (caseId: string) => void;
  onAddTestUser: (name: string, values: Record<string, string>) => Promise<boolean>;
};

/**
 * What runs before recording, top to bottom: the start piece (a fresh start
 * of the app, or the end of a saved case), then the setup blocks in order.
 * A case that starts from another case runs that case's blocks, so it has
 * none of its own.
 */
export function SetupStack({ blocks, cases, appId, envKeys, lane, startFrom, dragging, disabled, onLaneChange, onStartFromChange, onAddTestUser }: StackProps) {
  const [dropAt, setDropAt] = useState<number | null>(null);
  const byFile = new Map(blocks.map((block) => [block.file, block]));
  const accepts = !startFrom && !disabled;

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
  };

  const move = (from: number, to: number) => onLaneChange(placeBlock(lane, { file: lane[from]!.file, from }, to));
  const setValues = (index: number, values: Record<string, string> | undefined) =>
    onLaneChange(lane.map((use, position) => (position !== index ? use : values ? { file: use.file, values } : { file: use.file })));

  return (
    <ol
      className="stack"
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(null);
      }}
      onDrop={drop}
    >
      <li className="piece piece-start" onDragOver={(event) => over(event, 0, false)}>
        <span className="piece-icon">
          <StartIcon />
        </span>
        <label className="piece-start-label">
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
          return (
            <li
              key={`${file}-${index}`}
              className={`piece piece-block piece-placed ${dropAt === index ? 'drop-before' : ''} ${block ? '' : 'piece-broken'}`}
              draggable={!disabled}
              onDragStart={(event) => startDrag(event, { file, from: index })}
              onDragEnd={() => setDropAt(null)}
              onDragOver={(event) => over(event, index, true)}
            >
              <div className="piece-row">
                <span className="grip">
                  <GripIcon />
                </span>
                <span className="piece-icon">
                  <PuzzleIcon />
                </span>
                <span className="piece-name">{block?.name ?? file}</span>
                {block?.stepCount !== undefined && <span className="piece-meta">{count(block.stepCount, 'step')}</span>}
                <span className="piece-tools">
                  <button type="button" onClick={() => move(index, index - 1)} disabled={disabled || index === 0} aria-label={`Move ${block?.name ?? file} up`} title="Move up">
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, index + 2)}
                    disabled={disabled || index === lane.length - 1}
                    aria-label={`Move ${block?.name ?? file} down`}
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => onLaneChange(lane.filter((_, position) => position !== index))}
                    disabled={disabled}
                    aria-label={`Remove ${block?.name ?? file}`}
                    title="Remove"
                  >
                    ×
                  </button>
                </span>
              </div>
              {!block && <div className="piece-error">This block file is no longer there.</div>}
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
            </li>
          );
        })}
      {startFrom ? (
        <li className="stack-note">That case runs its own setup blocks first, so this case cannot add any.</li>
      ) : (
        <li
          className={`drop-slot ${dragging ? 'drop-slot-active' : ''} ${dropAt === lane.length ? 'drop-before' : ''}`}
          onDragOver={(event) => over(event, lane.length, false)}
        >
          {lane.length === 0 ? 'Drag a setup block here to run it first, such as a log in' : 'Drag another block here'}
        </li>
      )}
    </ol>
  );
}

/** The same stack, read-only, at the top of a case being recorded. */
export function SetupSummary({ blocks, lane, startFromName, appId }: { blocks: BlockSummary[]; lane: BlockUse[]; startFromName: string | undefined; appId: string }) {
  const byFile = new Map(blocks.map((block) => [block.file, block]));
  return (
    <ol className="stack stack-compact">
      <li className="piece piece-start">
        <span className="piece-icon">
          <StartIcon />
        </span>
        <span>{startFromName ? `Starts from the end of "${startFromName}"` : `Starts with a fresh start of ${appId}`}</span>
      </li>
      {lane.map((use, index) => (
        <li key={`${use.file}-${index}`} className="piece piece-block">
          <div className="piece-row">
            <span className="piece-icon">
              <PuzzleIcon />
            </span>
            <span className="piece-name">
              {byFile.get(use.file)?.name ?? use.file}
              {use.values && <span className="piece-values"> {describeValues(use.values)}</span>}
            </span>
            <span className="piece-meta">block</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The end of the step list while recording: drop a block here to run it now. */
export function BlockDropSlot({ dragging, disabled, onDrop }: { dragging: boolean; disabled: boolean; onDrop: (file: string) => void }) {
  const [over, setOver] = useState(false);
  return (
    <li
      className={`drop-slot drop-slot-steps ${dragging && !disabled ? 'drop-slot-active' : ''} ${over ? 'drop-before' : ''}`}
      onDragOver={(event) => {
        if (disabled || !carriesBlock(event)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const data = readDrag(event);
        if (data && !disabled) onDrop(data.file);
      }}
    >
      Drop a setup block here to run it now, as the next step
    </li>
  );
}
