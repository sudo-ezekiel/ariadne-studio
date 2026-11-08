import { useState } from 'react';
import { REVIEW_TEXT, describeFlowItem, formatDuration } from '@ariadne/core/describe';
import { caseFlowItems, type FlowItem } from '@ariadne/core/flow-layout';
import { LOOKS_DIFFERENT_BELOW } from '@ariadne/core/similarity';
import type { BlockSummary, CaseDetailResponse, EditRequest, StepPatch, StepResultView, StepView } from '../../shared/api-types.ts';
import { api } from '../api.ts';
import { BlockSteps } from './Blocks.tsx';
import { PuzzleIcon } from './Icons.tsx';
import { count, formatDate, isFragile, stepSelector } from './format.ts';

export type CaseActions = {
  onClose: () => void;
  onReplay: () => void;
  onEdit: (edit: EditRequest) => void;
  onOpenCase: (caseId: string) => void;
  onRename: (caseId: string, name: string) => void;
  onMute: (caseId: string, muted: boolean) => void;
  /** An empty reference removes it. */
  onReference: (caseId: string, reference: string) => void;
  onDuplicate: (caseId: string) => void;
  onSaveAsBlock: (caseId: string) => void;
  onDelete: (caseId: string) => void;
  onPatchStep: (caseId: string, index: number, patch: StepPatch) => void;
  onDeleteStep: (caseId: string, index: number) => void;
  onDeleteExpectation: (caseId: string, position: number) => void;
  onSplit: (caseId: string, atStep: number) => void;
};

type Props = {
  detail: CaseDetailResponse;
  /** The project's blocks, for the names and steps of block rows. */
  blocks: BlockSummary[];
  busy: boolean;
  sessionOpen: boolean;
  suiteRunning: boolean;
  actions: CaseActions;
};

const KIND_LABELS: Partial<Record<StepView['kind'], string>> = {
  hideKeyboard: 'keyboard',
  openLink: 'link',
  expect: 'check',
  longPress: 'long press',
  doubleTap: 'double tap',
  pressKey: 'key',
  orientation: 'rotate',
};

/** Short names for the kind column. */
export function kindLabel(kind: StepView['kind']): string {
  return KIND_LABELS[kind] ?? kind;
}

function Badge({ result }: { result: StepResultView | undefined }) {
  if (!result) return <span className="badge" />;
  return <span className={`badge badge-${result.status}`}>{result.status}</span>;
}

function Similarity({ result }: { result: StepResultView | undefined }) {
  if (result?.similarity === undefined) return null;
  const different = result.similarity < LOOKS_DIFFERENT_BELOW;
  return (
    <span
      className={`similar ${different ? 'similar-warn' : ''}`}
      title="How much the replayed screen looks like the recorded one. It never fails a run; it points at screens worth a look."
    >
      {different ? `looks different (${result.similarity}%)` : `${result.similarity}% alike`}
    </span>
  );
}

function StepEditor({ step, placeholder, onSave, onCancel }: { step: StepView; placeholder: string; onSave: (patch: StepPatch) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(step.title ?? '');
  const [note, setNote] = useState(step.note ?? '');
  return (
    <form
      className="step-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ title, note });
      }}
    >
      <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={placeholder} aria-label="Step title" />
      <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Expected result or note, in your words" rows={2} aria-label="Step note" />
      <div className="case-actions">
        <button type="submit">Save</button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * A saved case: one row per flow command (start, blocks or the case it starts
 * from, recorded steps, end checks) with a run's result, the recorded and
 * replayed screens, and the edits Waldo's test builder offered.
 */
export function CaseDetail({ detail, blocks, busy, sessionOpen, suiteRunning, actions }: Props) {
  const { case: testCase, yaml, runs, health, parent, dependents } = detail;
  const [runIndex, setRunIndex] = useState(0);
  const [editingStep, setEditingStep] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [referencing, setReferencing] = useState<string | null>(null);
  const run = runs[Math.min(runIndex, runs.length - 1)];
  const results = new Map(run?.steps.map((result) => [result.flowIndex, result]));
  const items = caseFlowItems(testCase) as FlowItem<StepView>[];
  const extras = run?.steps.filter((result) => result.flowIndex >= items.length) ?? [];
  const locked = busy || suiteRunning;
  const canRecord = sessionOpen && !locked;
  const recordTitle = sessionOpen ? undefined : 'Connect to this app on a device first';
  const blockByFile = new Map(blocks.map((block) => [block.file, block]));
  const label = (item: FlowItem<StepView>) =>
    describeFlowItem(item, testCase.appId, {
      caseName: (id) => (parent?.id === id ? parent.name : undefined),
      blockName: (file) => blockByFile.get(file)?.name,
    });
  const confirmThen = (message: string, act: () => void) => {
    if (window.confirm(message)) act();
  };

  return (
    <div className="case-detail">
      <div className="detail-head">
        {renaming === null ? (
          <h2>
            {testCase.name}
            {testCase.muted && <span className="tag">muted</span>}
            {health.flaky && <span className="tag tag-flaky">flaky</span>}
          </h2>
        ) : (
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (renaming.trim()) actions.onRename(testCase.id, renaming.trim());
              setRenaming(null);
            }}
          >
            <input autoFocus value={renaming} onChange={(event) => setRenaming(event.target.value)} aria-label="Case name" />
            <button type="submit">Save</button>
            <button type="button" onClick={() => setRenaming(null)}>
              Cancel
            </button>
          </form>
        )}
        <button type="button" onClick={actions.onClose} disabled={busy}>
          All cases
        </button>
      </div>
      <div className="case-meta">
        {testCase.id} / {testCase.appId} / recorded {formatDate(testCase.createdAt)} on {testCase.deviceId}
        {testCase.editedAt && <> / edited {formatDate(testCase.editedAt)}</>}
      </div>
      <div className="case-meta">
        {referencing === null ? (
          <>
            {testCase.reference && <>Reference: {testCase.reference} </>}
            <button
              type="button"
              className="link"
              onClick={() => setReferencing(testCase.reference ?? '')}
              disabled={locked}
              title="A requirement, user story or scenario code, shown in test case documents and evidence packs"
            >
              {testCase.reference ? 'Change' : 'Add a reference'}
            </button>
          </>
        ) : (
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (referencing.trim() !== (testCase.reference ?? '')) actions.onReference(testCase.id, referencing.trim());
              setReferencing(null);
            }}
          >
            <input
              autoFocus
              maxLength={100}
              value={referencing}
              placeholder="A requirement, user story or scenario code"
              onChange={(event) => setReferencing(event.target.value)}
              aria-label="Reference"
            />
            <button type="submit">Save</button>
            <button type="button" onClick={() => setReferencing(null)}>
              Cancel
            </button>
          </form>
        )}
      </div>
      {parent && (
        <div className="case-meta">
          Starts from{' '}
          <button type="button" className="link" onClick={() => actions.onOpenCase(parent.id)}>
            {parent.name}
          </button>
        </div>
      )}
      {dependents.length > 0 && (
        <div className="case-meta">
          Cases that start from this one:{' '}
          {dependents.map((item, i) => (
            <span key={item.id}>
              {i > 0 && ', '}
              <button type="button" className="link" onClick={() => actions.onOpenCase(item.id)}>
                {item.name}
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="case-actions wrap">
        <button type="button" className="primary" onClick={actions.onReplay} disabled={locked} title="Run this case with Maestro on the device">
          Run
        </button>
        <button type="button" onClick={() => setRenaming(testCase.name)} disabled={locked}>
          Rename
        </button>
        <button type="button" onClick={() => actions.onDuplicate(testCase.id)} disabled={locked}>
          Duplicate
        </button>
        <button type="button" onClick={() => actions.onSaveAsBlock(testCase.id)} disabled={locked} title="Opens these steps in the Blocks tab, to reuse them in other cases">
          Save as block
        </button>
        <button type="button" onClick={() => actions.onMute(testCase.id, !testCase.muted)} disabled={locked} title="A muted case is skipped by Run all">
          {testCase.muted ? 'Unmute' : 'Mute'}
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => actions.onDelete(testCase.id)}
          disabled={locked || dependents.length > 0}
          title={dependents.length > 0 ? 'Other cases start from this one' : undefined}
        >
          Delete
        </button>
      </div>
      <div className="export-links">
        Test case document:{' '}
        <a href={api.caseExportUrl(testCase.id, 'xlsx')} download>
          Excel
        </a>{' '}
        <a href={api.caseExportUrl(testCase.id, 'html')} target="_blank" rel="noreferrer">
          HTML
        </a>{' '}
        <a href={api.caseExportUrl(testCase.id, 'md')} download>
          Markdown
        </a>
      </div>

      <div className={`run-summary ${run ? (run.passed ? 'run-passed' : 'run-failed') : ''}`}>
        {run ? (
          <>
            {runIndex === 0 ? 'Last run' : 'Run'} {run.passed ? 'passed' : 'failed'} on {formatDate(run.startedAt)}
            {run.suiteId && <> in Run all</>} (exit code {run.exitCode}).{' '}
            <a href={run.reportUrl} target="_blank" rel="noreferrer">
              Shareable report
            </a>
            {run.videoUrl && (
              <>
                {' · '}
                <a href={run.videoUrl} target="_blank" rel="noreferrer">
                  Video
                </a>
              </>
            )}
            {runs.length > 1 && (
              <select className="run-select" value={runIndex} onChange={(event) => setRunIndex(Number(event.target.value))} aria-label="Run to show">
                {runs.map((item, i) => (
                  <option key={item.runId} value={i}>
                    {formatDate(item.startedAt)} {item.passed ? 'passed' : 'failed'}
                    {item.stale ? ' (before edit)' : ''}
                  </option>
                ))}
              </select>
            )}
            {health.recent.length > 1 && (
              <div className="path">
                {health.failedRecently} of the last {count(health.recent.length, 'run')} since the last edit failed
                {health.flaky ? ', so the case is flaky: look at the failed runs before trusting a pass.' : '.'}
              </div>
            )}
          </>
        ) : (
          'Not run yet.'
        )}
      </div>
      {run?.stale && <p className="run-error">This run started before the case was last edited, so its rows may not line up with the steps.</p>}
      {run?.deviceProblem && <p className="run-error">{run.deviceProblem}</p>}
      {run?.error && !run.deviceProblem && <p className="run-error">{run.error}</p>}
      {run?.screenshotUrl && (
        <a className="failure-shot" href={run.screenshotUrl} target="_blank" rel="noreferrer" title="Maestro's screenshot at the failure">
          <img className="thumb" src={run.screenshotUrl} alt="Screen when the run failed" />
          <span className="hint">Maestro's screenshot at the failure</span>
        </a>
      )}

      <ol className="steps">
        {items.map((item, flowIndex) => {
          const result = results.get(flowIndex);
          const step = item.kind === 'step' ? item.step : undefined;
          const selector = step ? stepSelector(step) : undefined;
          const kind = step ? kindLabel(step.kind) : item.kind === 'expectation' ? 'end' : item.kind === 'startFrom' ? 'start' : item.kind;
          const expectationPosition = item.kind === 'expectation' ? testCase.expectations.indexOf(item.expectation) + 1 : 0;
          // Blocks before step 1 and blocks run in the middle of the case look the same.
          const blockFile = item.kind === 'block' ? item.file : step?.kind === 'block' ? step.file : undefined;
          return (
            <li key={flowIndex} className={`step step-detail-row ${blockFile ? 'step-block' : ''}`}>
              <span className="step-index">{flowIndex + 1}</span>
              {blockFile ? (
                <span className="step-kind step-kind-block">
                  <PuzzleIcon size={12} />
                  block
                </span>
              ) : (
                <span className="step-kind">{kind}</span>
              )}
              <span className={`step-detail ${step && isFragile(step) ? 'warn' : ''}`}>
                {label(item)}
                {item.kind === 'startFrom' && (
                  <button type="button" className="link" onClick={() => actions.onOpenCase(item.caseId)}>
                    open
                  </button>
                )}
                {selector && <span className="selector">{selector}</span>}
                {blockFile && <BlockSteps block={blockByFile.get(blockFile)} />}
                {step?.note && <span className="note">{step.note}</span>}
                {step?.review && (
                  <span className="review">
                    {REVIEW_TEXT[step.review]}{' '}
                    <button type="button" className="link" onClick={() => actions.onPatchStep(testCase.id, step.index, { review: null })} disabled={locked}>
                      Looks right
                    </button>
                  </span>
                )}
                {result?.error && <span className="step-error">{result.error}</span>}
                {step && editingStep === step.index && (
                  <StepEditor
                    step={step}
                    placeholder={describeFlowItem({ ...item, step: { ...step, title: '' } } as FlowItem, testCase.appId)}
                    onSave={(patch) => {
                      actions.onPatchStep(testCase.id, step.index, patch);
                      setEditingStep(null);
                    }}
                    onCancel={() => setEditingStep(null)}
                  />
                )}
              </span>
              <span className="result-cell">
                <Badge result={result} />
                {result?.durationMs !== undefined && <span className="step-time">{formatDuration(result.durationMs)}</span>}
                <Similarity result={result} />
              </span>
              <span className="shots">
                {step?.screenshotUrl && (
                  <a href={step.screenshotUrl} target="_blank" rel="noreferrer" title="Recorded">
                    <img className="thumb" src={step.screenshotUrl} alt={`Recorded screen after step ${step.index}`} />
                  </a>
                )}
                {result?.replayScreenshotUrl && (
                  <a href={result.replayScreenshotUrl} target="_blank" rel="noreferrer" title="Replayed">
                    <img className="thumb thumb-replay" src={result.replayScreenshotUrl} alt={`Replayed screen after row ${flowIndex + 1}`} />
                  </a>
                )}
              </span>
              <details className="row-menu">
                <summary aria-label="Step actions">⋯</summary>
                <div className="row-menu-items">
                  {step && (
                    <>
                      <button type="button" onClick={() => setEditingStep(step.index)} disabled={locked}>
                        Title and note
                      </button>
                      <button type="button" onClick={() => actions.onEdit({ mode: 'rerecord', step: step.index })} disabled={!canRecord} title={recordTitle}>
                        Re-record from here
                      </button>
                      <button type="button" onClick={() => actions.onEdit({ mode: 'insert', after: step.index })} disabled={!canRecord} title={recordTitle}>
                        Add steps after this one
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          confirmThen(
                            `Split after step ${step.index}? Steps 1 to ${step.index} become a new case, and this case will start from it.`,
                            () => actions.onSplit(testCase.id, step.index),
                          )
                        }
                        disabled={locked}
                      >
                        Split after this step
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() =>
                          confirmThen(`Delete step ${step.index}? Later steps may no longer run; run the case to check.`, () =>
                            actions.onDeleteStep(testCase.id, step.index),
                          )
                        }
                        disabled={locked}
                      >
                        Delete step
                      </button>
                    </>
                  )}
                  {(item.kind === 'launch' || item.kind === 'startFrom') && (
                    <button type="button" onClick={() => actions.onEdit({ mode: 'insert', after: 0 })} disabled={!canRecord} title={recordTitle}>
                      Add steps before step 1
                    </button>
                  )}
                  {item.kind === 'block' && <span className="hint">Change this block in the Blocks tab.</span>}
                  {item.kind === 'expectation' && (
                    <button type="button" className="danger" onClick={() => actions.onDeleteExpectation(testCase.id, expectationPosition)} disabled={locked}>
                      Delete this check
                    </button>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ol>
      {extras.length > 0 && (
        <p className="run-error">
          {extras.length} command(s) in this run have no step in this case; the flow file may have been edited by hand.
        </p>
      )}
      <details className="yaml-box">
        <summary>Maestro flow ({`flows/${testCase.id}.yaml`})</summary>
        <pre className="yaml">{yaml || 'The flow file is missing; Run writes it again from the case.'}</pre>
      </details>
    </div>
  );
}
