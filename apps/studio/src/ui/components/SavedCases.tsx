import { useState } from 'react';
import { suiteOrder } from '@ariadne/core/suite';
import { appVersionText } from '@ariadne/core/tested-on';
import type { CaseListItem, SuiteView } from '../../shared/api-types.ts';
import { api, type EvidenceDetails } from '../api.ts';
import { count, formatDate } from './format.ts';

type Props = {
  cases: CaseListItem[];
  suite: SuiteView | null;
  busy: boolean;
  /** Offer an evidence pack under the last Run all; a setting, off unless turned on. */
  evidencePack: boolean;
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

// What stays the same from one pack to the next is remembered: who tests, and how the second signature reads.
const REMEMBERED = { testedBy: 'ariadne-tested-by', signoffRole: 'ariadne-signoff-role', screens: 'ariadne-evidence-screens' } as const;

function remembered(key: keyof typeof REMEMBERED): string {
  try {
    return localStorage.getItem(REMEMBERED[key]) ?? '';
  } catch {
    return '';
  }
}

function remember(key: keyof typeof REMEMBERED, value: string): void {
  try {
    if (value.trim()) localStorage.setItem(REMEMBERED[key], value.trim());
    else localStorage.removeItem(REMEMBERED[key]);
  } catch {
    // Storage can be off (private windows); the value is then asked for again.
  }
}

/** The texts of the evidence pack of a finished Run all. The release starts as the app version Run all read. */
function EvidenceForm({ suite }: { suite: SuiteView }) {
  const firstApp = suite.testedOn?.apps[0];
  const [details, setDetails] = useState<EvidenceDetails>(() => ({
    release: firstApp ? (appVersionText(firstApp) ?? '') : '',
    testedBy: remembered('testedBy'),
    signoffRole: remembered('signoffRole') || 'Accepted by',
    knownIssues: '',
    conclusion: '',
    screens: remembered('screens') === 'checks' ? 'checks' : 'all',
  }));
  const set = (key: keyof EvidenceDetails) => (event: { target: { value: string } }) => setDetails({ ...details, [key]: event.target.value });
  const make = () => {
    remember('testedBy', details.testedBy);
    remember('signoffRole', details.signoffRole === 'Accepted by' ? '' : details.signoffRole);
    remember('screens', details.screens === 'checks' ? 'checks' : '');
    window.open(api.evidenceUrl(suite.suiteId, details), '_blank', 'noopener');
  };
  return (
    <form
      className="evidence-form"
      onSubmit={(event) => {
        event.preventDefault();
        make();
      }}
    >
      <label className="field">
        <span className="field-title">Release</span>
        <input value={details.release} maxLength={200} placeholder="2.4.1" onChange={set('release')} />
      </label>
      <label className="field">
        <span className="field-title">Tested by</span>
        <input value={details.testedBy} maxLength={200} placeholder="Your name" onChange={set('testedBy')} />
      </label>
      <label className="field">
        <span className="field-title">Second signature</span>
        <input value={details.signoffRole} maxLength={40} placeholder="Accepted by" onChange={set('signoffRole')} title="Reviewed by, if the client accepts in a document of its own" />
      </label>
      <label className="field">
        <span className="field-title">Screens</span>
        <select value={details.screens} onChange={set('screens')}>
          <option value="all">After every step</option>
          <option value="checks">Only checks and failures</option>
        </select>
      </label>
      <label className="field wide">
        <span className="field-title">Known issues</span>
        <textarea value={details.knownIssues} maxLength={1000} rows={2} placeholder="What you know is still wrong in this release" onChange={set('knownIssues')} />
      </label>
      <label className="field wide">
        <span className="field-title">Conclusion</span>
        <input value={details.conclusion} maxLength={200} placeholder="Ready for release" onChange={set('conclusion')} />
      </label>
      <div className="evidence-actions">
        <button type="submit" className="primary">
          Make the pack
        </button>
        <span className="hint">A first page to sign, then every case with its steps and screens. Print it or save it as PDF. A copy goes in exports/.</span>
      </div>
    </form>
  );
}

function SuiteBar({ suite, busy, cases, evidencePack, onRunAll, onStopSuite }: Pick<Props, 'suite' | 'busy' | 'cases' | 'evidencePack' | 'onRunAll' | 'onStopSuite'>) {
  const [retry, setRetry] = useState(true);
  const [evidenceFor, setEvidenceFor] = useState<string | undefined>();
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
          {evidencePack && (
            <>
              <button
                type="button"
                className="link"
                aria-expanded={evidenceFor === suite.suiteId}
                onClick={() => setEvidenceFor(evidenceFor === suite.suiteId ? undefined : suite.suiteId)}
                title="A document of this Run all for whoever accepts the release"
              >
                Evidence pack
              </button>{' '}
            </>
          )}
          <span className="path">{formatDate(suite.startedAt)}</span>
        </div>
      )}
      {evidencePack && suite && !running && evidenceFor === suite.suiteId && <EvidenceForm key={suite.suiteId} suite={suite} />}
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
      <SuiteBar suite={props.suite} busy={busy} cases={cases} evidencePack={props.evidencePack} onRunAll={props.onRunAll} onStopSuite={props.onStopSuite} />
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
