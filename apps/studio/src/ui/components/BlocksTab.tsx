// The Blocks tab: the project's setup blocks, and the form that writes one. A
// block written here is an ordinary file in the block folder, listed in the
// Record tab with the rest.
import type { BlockSummary } from '../../shared/api-types.ts';
import { BlockEditor, type BlockEditorProps } from './BlockEditor.tsx';
import { BlockSteps } from './Blocks.tsx';
import type { BlockEdit } from './block-steps.ts';
import { PuzzleIcon } from './Icons.tsx';
import { count } from './format.ts';

export type BlockTabActions = Pick<BlockEditorProps, 'onChange' | 'onPick' | 'onSave' | 'onTry' | 'onRecord' | 'onDelete' | 'onClose' | 'onSaveValue' | 'onAddTestUser'> & {
  onNew: () => void;
  onOpen: (file: string) => void;
  /** Shows a file that only a person with a text editor can change. */
  onOpenFile: (file: string) => void;
};

type Props = {
  blocks: BlockSummary[];
  edit: BlockEdit | null;
  envKeys: string[];
  busy: boolean;
  sessionOpen: boolean;
  pickingKey: number | null;
  actions: BlockTabActions;
};

export function BlocksTab({ blocks, edit, envKeys, busy, sessionOpen, pickingKey, actions }: Props) {
  if (edit) {
    return (
      <BlockEditor
        edit={edit}
        summary={blocks.find((block) => block.file === edit.file)}
        envKeys={envKeys}
        busy={busy}
        sessionOpen={sessionOpen}
        pickingKey={pickingKey}
        {...actions}
      />
    );
  }
  return (
    <>
      <div className="section-head">
        <h2>Blocks</h2>
        <button type="button" className="primary" onClick={actions.onNew}>
          New block
        </button>
      </div>
      <p className="hint section-hint block-intro">A block is a set of steps every case can reuse, such as logging in. Its settings let each case choose the details, such as which test user.</p>
      {blocks.length === 0 ? (
        <p className="empty">No blocks in this project yet. Press New block to write the first one.</p>
      ) : (
        <ul className="palette palette-static">
          {blocks.map((block) => (
            <li key={block.file} className={`palette-row ${block.error ? 'palette-row-broken' : ''}`}>
              <span className="mark mark-block">
                <PuzzleIcon size={10} />
              </span>
              <span className="palette-name">{block.name}</span>
              <span className="palette-meta">{block.stepCount !== undefined && count(block.stepCount, 'step')}</span>
              {block.editable ? (
                <button type="button" className="palette-add" disabled={busy} onClick={() => actions.onOpen(block.file)}>
                  Edit
                </button>
              ) : (
                <button type="button" className="palette-add" onClick={() => actions.onOpenFile(block.file)}>
                  Show file
                </button>
              )}
              <div className="palette-body">
                <span className="block-file">{block.file}</span>
                {block.settable && <span className="block-vars">Settings: {block.settable.join(', ')}</span>}
                {block.error && <span className="block-error">Cannot be used: {block.error}</span>}
                {!block.editable && !block.error && <span className="block-vars">Uses {(block.maestroOnly ?? []).join(', ')}, which only its file can change.</span>}
                <BlockSteps block={block} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
