import { useEffect, useRef, useState } from 'react';
import { REVIEW_TEXT, describeFlowItem } from '@ariadne/core/describe';
import { scrollTargets } from '@ariadne/core/flow-layout';
import type { BlockUse, ExpectationCandidate } from '@ariadne/core/types';
import type { CaseDetailResponse, CaseFinishResponse, CurrentCaseView, EditRequest, FileContent, ProjectInfo, SuiteView } from '../../shared/api-types.ts';
import { BlockDropSlot, BlockPalette, SetupStack, SetupSummary } from './Blocks.tsx';
import { CaseDetail, kindLabel, type CaseActions } from './CaseDetail.tsx';
import { ExpectationPicker } from './ExpectationPicker.tsx';
import { FileView } from './FilesPanel.tsx';
import { CheckIcon, CrossIcon, PuzzleIcon } from './Icons.tsx';
import { caseTree, SavedCases } from './SavedCases.tsx';
import { count, isFragile, stepSelector, stepText } from './format.ts';

export type PanelTab = 'record' | 'cases' | 'file';

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
};

function Recording({
  currentCase,
  picking,
  busy,
  usingPhone,
  project,
  ...props
}: Pick<Props, 'picking' | 'busy' | 'usingPhone' | 'project' | 'onFinish' | 'onSavePicks' | 'onCancelPick' | 'onDiscard' | 'onRunBlock' | 'onAddTestUser'> & {
  currentCase: CurrentCaseView;
}) {
  const [dragging, setDragging] = useState(false);
  // The settings on each block in "Run a setup block now", by block file.
  const [blockValues, setBlockValues] = useState<Record<string, Record<string, string> | undefined>>({});
  const runBlock = (file: string) => props.onRunBlock(file, blockValues[file]);
  const blocks = project?.blocks ?? [];
  const blockName = (file: string) => blocks.find((block) => block.file === file)?.name;
  // A scroll learns its replay target when the next tap or expect is recorded.
  const targets = scrollTargets(currentCase.steps, currentCase.expectations);
  const editing = currentCase.editing;
  const startFromName = currentCase.startFrom ? (project?.cases.find((item) => item.id === currentCase.startFrom)?.name ?? currentCase.startFrom) : undefined;
  return (
    <>
      <h2>
        {currentCase.name}
        <span className="rec">
          <span className="rec-dot" aria-hidden="true" />
          Recording
        </span>
      </h2>
      <div className="case-meta">
        {currentCase.id} / {currentCase.appId} on {currentCase.deviceId}
      </div>
      {!editing && (
        <SetupSummary blocks={project?.blocks ?? []} lane={currentCase.preconditionBlocks} startFromName={startFromName} appId={currentCase.appId} />
      )}
      {editing && (
        <p className="editing-note">
          {editing.mode === 'rerecord'
            ? `Re-recording from step ${editing.keptSteps + 1}. Steps 1 to ${editing.keptSteps} are kept; the old steps after them and the old end checks are replaced when you finish.`
            : `Adding steps after step ${editing.keptSteps}. The ${count(editing.tailSteps, 'saved step')} after it and the end checks are kept and follow the new steps.`}{' '}
          Discard leaves the saved case as it was.
        </p>
      )}
      <ol className="steps">
        {currentCase.steps.length === 0 && <li className="empty">{usingPhone ? 'Use the phone. The first step appears here.' : 'Click the screen to record the first step.'}</li>}
        {currentCase.steps.map((step, position) => {
          const selector = stepSelector(step);
          const kept = editing && position < editing.keptSteps;
          return (
            <li key={step.index} className={`step ${kept ? 'step-kept' : ''} ${step.kind === 'block' ? 'step-block' : ''}`}>
              <span className="step-index">{step.index}</span>
              {step.kind === 'block' ? (
                <span className="step-kind step-kind-block">
                  <PuzzleIcon size={12} />
                  block
                </span>
              ) : (
                <span className="step-kind">{kindLabel(step.kind)}</span>
              )}
              <span className={`step-detail ${isFragile(step) ? 'warn' : ''}`}>
                {step.kind === 'block' ? describeFlowItem({ kind: 'step', step }, currentCase.appId, { blockName }) : stepText(step, targets[position])}
                {selector && <span className="selector">{selector}</span>}
                {step.review && <span className="review">{REVIEW_TEXT[step.review]}</span>}
              </span>
              {step.screenshotUrl && (
                <a href={step.screenshotUrl} target="_blank" rel="noreferrer">
                  <img className="thumb" src={step.screenshotUrl} alt={`Screen after step ${step.index}`} />
                </a>
              )}
            </li>
          );
        })}
        {!picking && blocks.length > 0 && <BlockDropSlot dragging={dragging} disabled={busy} onDrop={runBlock} />}
        {editing?.mode === 'insert' && editing.tailSteps > 0 && (
          <li className="empty">Then the {count(editing.tailSteps, 'saved step')} that came after step {editing.keptSteps}.</li>
        )}
      </ol>
      {picking ? (
        <ExpectationPicker
          candidates={picking.candidates}
          {...(picking.preselected ? { preselected: picking.preselected } : {})}
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
            onDragging={setDragging}
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
      <p className="hint section-hint">Steps a developer prepared, such as logging in. Drag one into "Before recording", or press Add.</p>
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
