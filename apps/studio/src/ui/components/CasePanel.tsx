import { useEffect, useRef, useState, type DragEvent } from 'react';
import { REVIEW_TEXT, describeFlowItem, targetName } from '@ariadne/core/describe';
import { scrollTargets } from '@ariadne/core/flow-layout';
import type { MaestroSelector } from '@ariadne/core/model';
import type { BlockUse, ExpectationCandidate } from '@ariadne/core/types';
import type {
  BlockSummary,
  CaseDetailResponse,
  CaseFinishResponse,
  CurrentCaseView,
  EditRequest,
  FileContent,
  ProjectInfo,
  StepView,
  SuiteView,
} from '../../shared/api-types.ts';
import { BlockDropSlot, BlockPalette, BlockSteps, SetupRows, SetupStack } from './Blocks.tsx';
import type { BlockEdit } from './block-steps.ts';
import { BlocksTab, type BlockTabActions } from './BlocksTab.tsx';
import { CaseDetail, kindLabel, type CaseActions } from './CaseDetail.tsx';
import { ExpectationPicker } from './ExpectationPicker.tsx';
import { FileView } from './FilesPanel.tsx';
import { CheckIcon, CrossIcon, PuzzleIcon } from './Icons.tsx';
import { MarkCell } from './Mark.tsx';
import { RowMenu } from './RowMenu.tsx';
import { caseTree, SavedCases } from './SavedCases.tsx';
import { markOfStep } from './step-marks.ts';
import { SecondsField, WaitTray, carriesWait } from './Timing.tsx';
import { count, isFragile, stepSelector, stepText } from './format.ts';

export type PanelTab = 'record' | 'cases' | 'blocks' | 'file';

/** The new case being put together in the Record tab: its name and what runs before recording. */
export type Draft = { name: string; startFrom: string; blocks: BlockUse[] };

type Props = {
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  /** The file opened from the Files sidebar, shown in its own tab. */
  openedFile: FileContent | null;
  onCloseFile: () => void;
  draft: Draft;
  onDraftChange: (draft: Draft) => void;
  /** Goes up each time Start recording is pressed without a name, to focus the name field. */
  nameFocus: number;
  appId: string;
  project: ProjectInfo | null;
  currentCase: CurrentCaseView | null;
  finished: CaseFinishResponse | null;
  /** Candidates while the expectation picker is open, else null. */
  picking: { candidates: ExpectationCandidate[]; preselected?: number[] } | null;
  openedCase: CaseDetailResponse | null;
  suite: SuiteView | null;
  busy: boolean;
  sessionOpen: boolean;
  /** Recording from a finger on the phone. */
  usingPhone: boolean;
  /** Starts recording the draft, or asks for its name first. */
  onRecord: () => void;
  /** Runs a setup block now, as the next step of the case being recorded, with the values set on it. */
  onRunBlock: (file: string, values: Record<string, string> | undefined) => void;
  /** Saves a test user to .env; resolves true when it was saved. */
  onAddTestUser: (name: string, values: Record<string, string>) => Promise<boolean>;
  liveActions: LiveStepActions;
  onFinish: () => void;
  onSavePicks: (picks: number[]) => void;
  onCancelPick: () => void;
  onDiscard: () => void;
  onDismissFinished: () => void;
  onOpenCase: (caseId: string) => void;
  onCloseCase: () => void;
  onReplayCase: (caseId: string) => void;
  onRunAll: (retryFailed: boolean) => void;
  onStopSuite: () => void;
  caseActions: Omit<CaseActions, 'onClose' | 'onReplay' | 'onEdit'> & { onEdit: (caseId: string, edit: EditRequest) => void };
  /** The block being written in the Blocks tab. */
  blockEdit: BlockEdit | null;
  /** The step of that block whose target is being picked on the screen. */
  pickingKey: number | null;
  blockActions: BlockTabActions;
};

/** What the live list can do to the case being recorded. None of it touches the phone. */
export type LiveStepActions = {
  /** The wait whose seconds field is open, by step number; a new wait opens its own. */
  changing: number | null;
  onChanging: (index: number | null) => void;
  /** Takes a step out of the recording; the toast after it offers Undo. */
  onRemoveStep: (step: StepView) => void;
  /** Puts a wait after this many steps, with its seconds field open. */
  onInsertWait: (after: number) => Promise<number | undefined>;
  onSetSeconds: (index: number, seconds: number) => void;
};

type LiveRowProps = {
  step: StepView;
  scrollTarget: MaestroSelector | undefined;
  appId: string;
  kept: boolean;
  busy: boolean;
  blockName: (file: string) => string | undefined;
  block: BlockSummary | undefined;
  /** This wait's seconds field is open. */
  changing: boolean;
  dropClass: string;
  actions: LiveStepActions;
  onChange: (open: boolean) => void;
  onWaitAfter: () => void;
  onDragOver: (event: DragEvent<HTMLLIElement>) => void;
};

/** One step of the recording, on the thread, with its menu. A focused row goes with Delete. */
function LiveRow({ step, scrollTarget, appId, kept, busy, blockName, block, changing, dropClass, actions, onChange, onWaitAfter, onDragOver }: LiveRowProps) {
  const mark = markOfStep(step.kind);
  const selector = stepSelector(step);
  const timing = step.kind === 'wait' || step.kind === 'waitFor';
  return (
    <li
      className={`step step-${mark} ${kept ? 'step-kept' : ''} ${dropClass}`}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || kept || busy) return;
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          actions.onRemoveStep(step);
        }
      }}
      onDragOver={onDragOver}
    >
      <MarkCell mark={mark} number={step.index} />
      <span className="step-kind">
        {mark === 'block' && <PuzzleIcon size={11} />}
        {kindLabel(step.kind)}
      </span>
      <span className={`step-detail ${isFragile(step) ? 'warn' : ''}`}>
        {timing && changing ? (
          <SecondsField
            seconds={step.seconds}
            {...(step.kind === 'waitFor' ? { target: targetName(step.selector, step.node) } : {})}
            disabled={busy}
            onSave={(seconds) => {
              actions.onSetSeconds(step.index, seconds);
              onChange(false);
            }}
            onCancel={() => onChange(false)}
          />
        ) : (
          <>
            {step.kind === 'block' ? describeFlowItem({ kind: 'step', step }, appId, { blockName }) : stepText(step, scrollTarget)}
            {timing && !kept && (
              <>
                {' '}
                <button type="button" className="link" onClick={() => onChange(true)} disabled={busy}>
                  Change
                </button>
              </>
            )}
          </>
        )}
        {selector && <span className="selector">{selector}</span>}
        {step.review && <span className="review">{REVIEW_TEXT[step.review]}</span>}
        {step.kind === 'block' && <BlockSteps block={block} number={step.index} />}
      </span>
      <span className="step-shot">
        {step.screenshotUrl && !timing && (
          <a href={step.screenshotUrl} target="_blank" rel="noreferrer">
            <img className="thumb" src={step.screenshotUrl} alt={`Screen after step ${step.index}`} />
          </a>
        )}
      </span>
      <RowMenu>
        {kept ? (
          <span className="hint">A saved step. Finish or discard this recording, then delete it from the case.</span>
        ) : (
          <>
            {timing && (
              <button type="button" onClick={() => onChange(true)} disabled={busy}>
                Change the seconds
              </button>
            )}
            <button type="button" onClick={onWaitAfter} disabled={busy}>
              Add a wait after this step
            </button>
            <button type="button" className="danger" onClick={() => actions.onRemoveStep(step)} disabled={busy}>
              Remove step
            </button>
          </>
        )}
      </RowMenu>
    </li>
  );
}

function Recording({
  currentCase,
  picking,
  busy,
  usingPhone,
  project,
  liveActions,
  ...props
}: Pick<Props, 'picking' | 'busy' | 'usingPhone' | 'project' | 'onFinish' | 'onSavePicks' | 'onCancelPick' | 'onDiscard' | 'onRunBlock' | 'onAddTestUser' | 'liveActions'> & {
  currentCase: CurrentCaseView;
}) {
  const [dragging, setDragging] = useState<'block' | 'wait' | null>(null);
  /** Where a dragged Wait would land: after this many steps. */
  const [dropAt, setDropAt] = useState<number | null>(null);
  // The settings on each block in "Run a setup block now", by block file.
  const [blockValues, setBlockValues] = useState<Record<string, Record<string, string> | undefined>>({});
  const runBlock = (file: string) => props.onRunBlock(file, blockValues[file]);
  const blocks = project?.blocks ?? [];
  const byFile = new Map(blocks.map((block) => [block.file, block]));
  const blockName = (file: string) => byFile.get(file)?.name;
  const steps = currentCase.steps;
  // A scroll learns its replay target when the next tap or expect is recorded.
  const targets = scrollTargets(steps, currentCase.expectations);
  const editing = currentCase.editing;
  // Steps kept from the saved case stay as they are; new ones go after them.
  const floor = editing?.keptSteps ?? 0;
  const startFromName = currentCase.startFrom ? (project?.cases.find((item) => item.id === currentCase.startFrom)?.name ?? currentCase.startFrom) : undefined;
  const removedOnPhone = currentCase.removedDeviceSteps ?? 0;

  const insertWait = (after: number) => {
    setDropAt(null);
    void liveActions.onInsertWait(after);
  };
  /** A Wait dragged over a row lands above or below it, by which half the pointer is in. */
  const overStep = (event: DragEvent<HTMLElement>, position: number) => {
    if (busy || !carriesWait(event)) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2 ? position + 1 : position;
    setDropAt(Math.max(floor, after));
  };
  const overFixed = (event: DragEvent<HTMLElement>, after: number) => {
    if (busy || !carriesWait(event)) return;
    event.preventDefault();
    setDropAt(Math.max(floor, after));
  };
  const dropClass = (position: number) =>
    dropAt === null ? '' : dropAt === position ? 'drop-before' : dropAt === steps.length && position === steps.length - 1 ? 'drop-after' : '';

  return (
    <>
      <h2>{currentCase.name}</h2>
      <div className="case-meta">
        {currentCase.forBlock ? 'Block' : currentCase.id} / {currentCase.appId} on {currentCase.deviceId}
      </div>
      {currentCase.forBlock && <p className="editing-note">Finish recording adds these steps to the block, and you can turn details into settings there. Discard leaves the block as it was.</p>}
      {editing && (
        <p className="editing-note">
          {editing.mode === 'rerecord'
            ? `Re-recording from step ${editing.keptSteps + 1}. Steps 1 to ${editing.keptSteps} are kept; the old steps after them and the old end checks are replaced when you finish.`
            : `Adding steps after step ${editing.keptSteps}. The ${count(editing.tailSteps, 'saved step')} after it and the end checks are kept and follow the new steps.`}{' '}
          Discard leaves the saved case as it was.
        </p>
      )}
      <ol
        className={`steps steps-live ${dragging === 'wait' ? 'steps-dropping' : ''}`}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(null);
        }}
        onDrop={(event) => {
          if (!carriesWait(event)) return;
          event.preventDefault();
          if (dropAt !== null) insertWait(dropAt);
          setDragging(null);
        }}
      >
        {!editing && !currentCase.forBlock && (
          <SetupRows blocks={blocks} lane={currentCase.preconditionBlocks} startFromName={startFromName} appId={currentCase.appId} />
        )}
        {steps.length === 0 && (
          <li className={`step step-empty ${dropAt === 0 ? 'drop-before' : ''}`} onDragOver={(event) => overFixed(event, 0)}>
            <MarkCell mark="wait" />
            <span className="step-detail">{usingPhone ? 'Use the phone. The first step appears here.' : 'Click the screen to record the first step.'}</span>
          </li>
        )}
        {steps.map((step, position) => (
          <LiveRow
            key={step.index}
            step={step}
            scrollTarget={targets[position]}
            appId={currentCase.appId}
            kept={position < floor}
            busy={busy}
            blockName={blockName}
            block={step.kind === 'block' ? byFile.get(step.file) : undefined}
            changing={liveActions.changing === step.index}
            dropClass={dropClass(position)}
            actions={liveActions}
            onChange={(open) => liveActions.onChanging(open ? step.index : null)}
            onWaitAfter={() => insertWait(step.index)}
            onDragOver={(event) => overStep(event, position)}
          />
        ))}
        {editing?.mode === 'insert' && editing.tailSteps > 0 && (
          <li className="step step-tail">
            <MarkCell mark="wait" />
            <span className="stack-tail">Then the {count(editing.tailSteps, 'saved step')} that came after step {editing.keptSteps}.</span>
          </li>
        )}
        {!picking && dragging === 'block' && <BlockDropSlot disabled={busy} onDrop={runBlock} />}
        {!picking && (
          <li className="step step-tail step-tray" onDragOver={(event) => overFixed(event, steps.length)}>
            <MarkCell mark="wait" />
            <WaitTray disabled={busy} onAdd={() => insertWait(steps.length)} onDragging={(on) => setDragging(on ? 'wait' : null)} />
          </li>
        )}
      </ol>
      {removedOnPhone > 0 && !picking && (
        <p className="editing-note">
          {removedOnPhone === 1 ? '1 step that acted on the phone was removed.' : `${removedOnPhone} steps that acted on the phone were removed.`} The phone did not go
          back, so run the case after saving to check that the later steps still work.
        </p>
      )}
      {picking ? (
        <ExpectationPicker
          candidates={picking.candidates}
          {...(picking.preselected ? { preselected: picking.preselected } : {})}
          {...(currentCase.forBlock ? { saveLabel: 'Add to block' } : {})}
          busy={busy}
          onSave={props.onSavePicks}
          onCancel={props.onCancelPick}
        />
      ) : (
        <div className="case-actions">
          <button type="button" className="primary" onClick={props.onFinish} disabled={busy}>
            {editing?.mode === 'insert' ? 'Save changes' : 'Finish recording'}
          </button>
          <button type="button" className="danger" onClick={props.onDiscard} disabled={busy}>
            Discard
          </button>
        </div>
      )}
      {!picking && blocks.length > 0 && (
        <details className="run-blocks">
          <summary>Run a setup block now</summary>
          <p className="hint section-hint">
            Runs on the device as the next step, for example to dismiss a popup or to log in as another test user. Drag a block onto the end of the
            steps, or press Run now.
          </p>
          <BlockPalette
            blocks={blocks}
            lockedReason={busy ? 'Wait for the studio to finish' : undefined}
            warnClears
            addLabel="Run now"
            settings={{
              envKeys: project?.envKeys ?? [],
              values: blockValues,
              onChange: (file, values) => setBlockValues((current) => ({ ...current, [file]: values })),
              onAddTestUser: props.onAddTestUser,
            }}
            onAdd={runBlock}
            onDragging={(on) => setDragging(on ? 'block' : null)}
          />
        </details>
      )}
    </>
  );
}

function Composer({
  project,
  draft,
  onDraftChange,
  nameFocus,
  appId,
  busy,
  sessionOpen,
  onRecord,
  onAddTestUser,
}: Pick<Props, 'project' | 'draft' | 'onDraftChange' | 'nameFocus' | 'appId' | 'busy' | 'sessionOpen' | 'onRecord' | 'onAddTestUser'>) {
  const nameInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (nameFocus > 0) nameInput.current?.focus();
  }, [nameFocus]);
  const blocks = project?.blocks ?? [];
  const tree = caseTree(project?.cases ?? []);
  const startFrom = draft.startFrom && tree.some(({ item }) => item.id === draft.startFrom) ? draft.startFrom : '';
  const update = (patch: Partial<Draft>) => onDraftChange({ ...draft, ...patch });
  const needsName = nameFocus > 0 && !draft.name.trim();

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (sessionOpen && !busy) onRecord();
      }}
    >
      <h2>New case</h2>
      <label className="field">
        <span className="field-title">Case name</span>
        <input
          ref={nameInput}
          className={needsName ? 'needs-value' : ''}
          value={draft.name}
          onChange={(event) => update({ name: event.target.value })}
          placeholder="For example: Submit a claim"
          aria-describedby={needsName ? 'name-needed' : undefined}
        />
        {needsName && (
          <span id="name-needed" className="field-help">
            Give the case a name, then press Start recording.
          </span>
        )}
      </label>

      <h3>Before recording</h3>
      <SetupStack
        blocks={blocks}
        cases={tree}
        appId={appId}
        envKeys={project?.envKeys ?? []}
        lane={draft.blocks}
        startFrom={startFrom}
        dragging={dragging}
        disabled={busy}
        onLaneChange={(lane) => update({ blocks: lane })}
        onStartFromChange={(caseId) => update({ startFrom: caseId })}
        onAddTestUser={onAddTestUser}
      />
      <div className="record-row">
        <button type="submit" className="primary record-button" disabled={busy || !sessionOpen} title={sessionOpen ? undefined : 'Connect a device first'}>
          <span className="record-dot" aria-hidden="true" />
          Start recording
        </button>
        <span className="hint">
          {sessionOpen
            ? 'Then use the app on the screen. Every tap, typed text, scroll and Back becomes a step; Check records that something is visible.'
            : 'Connect a device first, in Device above. Device setup explains how.'}
        </span>
      </div>

      <h3>Setup blocks</h3>
      <p className="hint section-hint">Steps to reuse, such as logging in. Drag one into "Before recording", or press Add. Write your own in the Blocks tab.</p>
      <BlockPalette
        blocks={blocks}
        lockedReason={startFrom ? 'This case starts from another case, which runs its own setup blocks' : busy ? 'Wait for the studio to finish' : undefined}
        onAdd={(file) => update({ blocks: [...draft.blocks, { file }] })}
        onDragging={setDragging}
      />
    </form>
  );
}

function Finished({ finished, project, onOpen, onDismiss }: { finished: CaseFinishResponse; project: ProjectInfo | null; onOpen: () => void; onDismiss: () => void }) {
  const name = project?.cases.find((item) => item.id === finished.caseId)?.name ?? finished.caseId;
  return (
    <div className="finished">
      <div className="finished-head">
        <span className="finished-title">
          <CheckIcon />
          Saved "{name}"
        </span>
        <span className="case-actions">
          <button type="button" onClick={onOpen}>
            Open case
          </button>
          <button type="button" onClick={onDismiss}>
            Dismiss
          </button>
        </span>
      </div>
      <details className="yaml-box">
        <summary>Maestro flow ({finished.flowFile})</summary>
        <pre className="yaml">{finished.yaml}</pre>
      </details>
    </div>
  );
}

export function CasePanel(props: Props) {
  const { tab, openedFile, project, currentCase, finished, openedCase, busy, sessionOpen } = props;
  const recording = currentCase !== null;
  const caseCount = project?.cases.length ?? 0;

  let body;
  if (tab === 'file' && openedFile) {
    body = <FileView file={openedFile} />;
  } else if (tab === 'blocks') {
    body = (
      <BlocksTab
        blocks={project?.blocks ?? []}
        edit={props.blockEdit}
        envKeys={project?.envKeys ?? []}
        busy={busy}
        sessionOpen={sessionOpen}
        pickingKey={props.pickingKey}
        actions={props.blockActions}
      />
    );
  } else if (tab === 'record') {
    body = currentCase ? (
      <Recording
        currentCase={currentCase}
        project={project}
        picking={props.picking}
        usingPhone={props.usingPhone}
        busy={busy}
        onFinish={props.onFinish}
        onSavePicks={props.onSavePicks}
        onCancelPick={props.onCancelPick}
        onDiscard={props.onDiscard}
        onRunBlock={props.onRunBlock}
        onAddTestUser={props.onAddTestUser}
        liveActions={props.liveActions}
      />
    ) : (
      <>
        {finished && (
          <Finished finished={finished} project={project} onOpen={() => props.onOpenCase(finished.caseId)} onDismiss={props.onDismissFinished} />
        )}
        <Composer
          project={project}
          draft={props.draft}
          onDraftChange={props.onDraftChange}
          nameFocus={props.nameFocus}
          appId={props.appId}
          busy={busy}
          sessionOpen={sessionOpen}
          onRecord={props.onRecord}
          onAddTestUser={props.onAddTestUser}
        />
      </>
    );
  } else if (openedCase) {
    const caseId = openedCase.case.id;
    body = (
      <CaseDetail
        detail={openedCase}
        blocks={project?.blocks ?? []}
        busy={busy}
        sessionOpen={sessionOpen}
        suiteRunning={props.suite?.status === 'running'}
        actions={{
          ...props.caseActions,
          onClose: props.onCloseCase,
          onReplay: () => props.onReplayCase(caseId),
          onEdit: (edit) => props.caseActions.onEdit(caseId, edit),
        }}
      />
    );
  } else {
    body = (
      <SavedCases
        cases={project?.cases ?? []}
        suite={props.suite}
        busy={busy}
        evidencePack={project?.evidencePack ?? false}
        onOpen={props.onOpenCase}
        onReplay={props.onReplayCase}
        onRunAll={props.onRunAll}
        onStopSuite={props.onStopSuite}
        onNewCase={() => props.onTabChange('record')}
      />
    );
  }

  return (
    <aside className="case-panel">
      <div className="panel-tabs" role="tablist" aria-label="Case panel">
        <button type="button" role="tab" aria-selected={tab === 'record'} className={tab === 'record' ? 'tab-on' : ''} onClick={() => props.onTabChange('record')}>
          <span className={`tab-dot ${recording ? 'tab-dot-live' : ''}`} aria-hidden="true" />
          {recording ? 'Recording' : 'Record'}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'cases'}
          className={tab === 'cases' ? 'tab-on' : ''}
          onClick={() => props.onTabChange('cases')}
          disabled={recording}
          title={recording ? 'Finish or discard the recording first' : undefined}
        >
          Cases <span className="tab-count">{caseCount}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'blocks'}
          className={tab === 'blocks' ? 'tab-on' : ''}
          onClick={() => props.onTabChange('blocks')}
          disabled={recording}
          title={recording ? 'Finish or discard the recording first' : undefined}
        >
          Blocks <span className="tab-count">{project?.blocks.length ?? 0}</span>
        </button>
        {openedFile && (
          <span className="tab-file">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'file'}
              className={tab === 'file' ? 'tab-on' : ''}
              title={openedFile.path}
              onClick={() => props.onTabChange('file')}
            >
              <span className="tab-file-name">{openedFile.name}</span>
            </button>
            <button type="button" className="tab-file-close" aria-label={`Close ${openedFile.name}`} title="Close" onClick={props.onCloseFile}>
              <CrossIcon size={12} />
            </button>
          </span>
        )}
      </div>
      <div className="panel-body" role="tabpanel">
        {body}
      </div>
    </aside>
  );
}
