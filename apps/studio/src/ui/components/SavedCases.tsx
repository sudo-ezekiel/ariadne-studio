import { useState } from 'react';
import { suiteOrder } from '@ariadne/core/suite';
import type { CaseListItem, SuiteView } from '../../shared/api-types.ts';
import { api } from '../api.ts';
import { count, formatDate } from './format.ts';

type Props = {
  cases: CaseListItem[];
  suite: SuiteView | null;
  busy: boolean;
  onOpen: (caseId: string) => void;
  onReplay: (caseId: string) => void;
  onRunAll: (retryFailed: boolean) => void;
  onStopSuite: () => void;
  onNewCase: () => void;
};

/** Cases in start-from order with their depth: a case is listed under the case it starts from. */
export function caseTree(cases: readonly CaseListItem[]): Array<{ item: CaseListItem; depth: number }> {
  const byId = new Map(cases.map((item) => [item.id, item]));
  const depthOf = (item: CaseListItem): number => {
    let depth = 0;
    const seen = new Set<string>([item.id]);
    let parent = item.startFrom ? byId.get(item.startFrom) : undefined;
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      depth++;
      parent = parent.startFrom ? byId.get(parent.startFrom) : undefined;
    }
    return depth;
  };
  return suiteOrder(cases).map((item) => ({ item, depth: depthOf(item) }));
}

function History({ item }: { item: CaseListItem }) {
  const { health } = item;
  if (health.recent.length === 0) {
    return <span className="history-note">{health.stale ? 'not run since the last edit' : 'never run'}</span>;
  }
  // Oldest on the left, like a timeline.
  const dots = [...health.recent].reverse();
  return (
    <span className="history" title={`${health.failedRecently} of the last ${count(health.recent.length, 'run')} failed`}>
      {dots.map((dot) => (
        <span key={dot.runId} className={`dot ${dot.passed ? 'dot-passed' : 'dot-failed'}`} title={`${dot.passed ? 'passed' : 'failed'} ${formatDate(dot.startedAt)}`} />
      ))}
    </span>
  );
}

function SuiteBar({ suite, busy, cases, onRunAll, onStopSuite }: Pick<Props, 'suite' | 'busy' | 'cases' | 'onRunAll' | 'onStopSuite'>) {
  const [retry, setRetry] = useState(true);
  const running = suite?.status === 'running';
  const current = running ? suite.cases.find((item) => item.outcome === 'running') : undefined;
  const done = suite ? suite.cases.filter((item) => !['pending', 'running'].includes(item.outcome)).length : 0;
  const counts = suite?.counts;
  const summary = counts
    ? (['passed', 'flaky', 'failed', 'error', 'muted'] as const)
        .filter((key) => counts[key] > 0)
        .map((key) => `${counts[key]} ${key}`)
        .join(', ')
    : '';
  return (
    <div className={`suite-bar ${suite && !running ? (suite.passed ? 'run-passed' : 'run-failed') : ''}`}>
      <div className="suite-actions">
        {running ? (
          <button type="button" className="danger" onClick={onStopSuite}>
            Stop after this case
          </button>
        ) : (
          <button type="button" className="primary" onClick={() => onRunAll(retry)} disabled={busy || cases.length === 0} title="Run every case that is not muted, one after another">
            Run all
          </button>
        )}
        <label className="hint">
          <input type="checkbox" checked={retry} disabled={running} onChange={(event) => setRetry(event.target.checked)} /> retry failures once
        </label>
      </div>
      {running && (
        <div>
          Running {Math.min(done + 1, suite.cases.length)} of {suite.cases.length}
          {current ? `: ${current.name}` : ''}. Device actions wait until it ends.
        </div>
      )}
      {suite && !running && (
        <div>
          Last Run all {suite.status === 'stopped' ? 'stopped' : suite.passed ? 'passed' : 'failed'}: {summary || 'nothing ran'}.{' '}
          <a href={suite.reportUrl} target="_blank" rel="noreferrer">
            Report
          </a>{' '}
          <span className="path">{formatDate(suite.startedAt)}</span>
        </div>
      )}
    </div>
  );
}

export function SavedCases(props: Props) {
  const { cases, busy } = props;
  const tree = caseTree(cases);
  const suiteRunning = props.suite?.status === 'running';
  return (
    <>
      <div className="section-head">
        <h3>Saved cases</h3>
        {cases.length > 0 && (
          <span className="export-links">
            Export all cases:{' '}
            <a href={api.projectExportUrl('xlsx')} download>
              Excel
            </a>{' '}
            <a href={api.projectExportUrl('html')} target="_blank" rel="noreferrer">
              HTML
            </a>{' '}
            <a href={api.projectExportUrl('md')} download>
              Markdown
            </a>
          </span>
        )}
      </div>
      <SuiteBar suite={props.suite} busy={busy} cases={cases} onRunAll={props.onRunAll} onStopSuite={props.onStopSuite} />
      {cases.length === 0 ? (
        <div className="empty-state">
          <p className="empty">No cases yet. Record one: name it, choose what runs first, and use the app on the screen.</p>
          <button type="button" className="primary" onClick={props.onNewCase}>
            Record a new case
          </button>
        </div>
      ) : (
        <ul className="saved-cases">
          {tree.map(({ item, depth }) => (
            <li key={item.id} style={{ paddingLeft: 8 + depth * 18 }} className={item.muted ? 'saved-muted' : ''}>
              <span className="saved-name">
                {depth > 0 && <span className="tree-mark" aria-hidden="true">{'└ '}</span>}
                {item.name}
                {item.muted && <span className="tag">muted</span>}
                {item.health.flaky && <span className="tag tag-flaky">flaky</span>}
                {item.health.status === 'failed' && <span className="tag tag-failed">failing</span>}
              </span>
              <span className="path">
                {count(item.stepCount, 'step')}{item.dependents > 0 ? ` · ${item.dependents === 1 ? '1 case starts here' : `${item.dependents} cases start here`}` : ''} · <History item={item} />
              </span>
              <span className="saved-actions">
                <button type="button" onClick={() => props.onOpen(item.id)} disabled={busy && !suiteRunning}>
                  Open
                </button>
                <button type="button" onClick={() => props.onReplay(item.id)} disabled={busy || suiteRunning}>
                  Run
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
