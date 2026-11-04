// Run all and run history, Waldo-style: retry a failure once and call
// "failed then passed" flaky; show each case's recent runs; skip muted cases.
// Pure, so the UI shares the types and the rules are unit tested.
import type { RunSummary } from './run-result.ts';

export type SuiteCaseOutcome = 'pending' | 'running' | 'passed' | 'failed' | 'flaky' | 'muted' | 'error';

export type SuiteCaseResult = {
  caseId: string;
  name: string;
  outcome: SuiteCaseOutcome;
  /** One run id per attempt, oldest first. */
  runIds: string[];
  /** Why the case could not run at all (missing parent, Maestro not found). */
  error?: string;
  /** Description of the first failing step of the last attempt. */
  failedStep?: string;
  /** Why the case was retried when it was not the app's fault, e.g. the device connection dropped. */
  note?: string;
};

export type SuiteRun = {
  suiteId: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'finished' | 'stopped';
  retryFailed: boolean;
  deviceId: string;
  cases: SuiteCaseResult[];
};

export type SuiteCounts = Record<SuiteCaseOutcome, number>;

export function suiteCounts(suite: SuiteRun): SuiteCounts {
  const counts: SuiteCounts = { pending: 0, running: 0, passed: 0, failed: 0, flaky: 0, muted: 0, error: 0 };
  for (const item of suite.cases) counts[item.outcome]++;
  return counts;
}

/** A suite passes when nothing failed or errored; flaky cases pass but are reported. */
export function suitePassed(suite: SuiteRun): boolean {
  const counts = suiteCounts(suite);
  return counts.failed === 0 && counts.error === 0 && counts.pending === 0 && counts.running === 0;
}

/** Outcome of a case from its attempts in order: failed then passed is flaky. */
export function attemptsOutcome(passed: readonly boolean[]): SuiteCaseOutcome {
  if (passed.length === 0) return 'pending';
  if (passed.at(-1)) return passed.length > 1 ? 'flaky' : 'passed';
  return 'failed';
}

/**
 * Cases in the order Run all takes them: parents before the cases that start
 * from them, otherwise oldest first, so a broken starting point shows up once
 * at the top rather than as a failure deep in every child.
 */
export function suiteOrder<T extends { id: string; createdAt: string; startFrom?: string | undefined }>(cases: readonly T[]): T[] {
  const byId = new Map(cases.map((item) => [item.id, item]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const item of [...cases].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    if (item.startFrom && byId.has(item.startFrom) && item.startFrom !== item.id) {
      const list = children.get(item.startFrom) ?? [];
      list.push(item);
      children.set(item.startFrom, list);
    } else {
      roots.push(item);
    }
  }
  const ordered: T[] = [];
  const seen = new Set<string>();
  const visit = (item: T) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    ordered.push(item);
    for (const child of children.get(item.id) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  // A loop of cases starting from each other has no root; still run them.
  for (const item of cases) visit(item);
  return ordered;
}

export type RunDot = { runId: string; passed: boolean; startedAt: string; suiteId?: string };

export type CaseHealth = {
  /** Up to `limit` runs of the current version of the case, newest first. */
  recent: RunDot[];
  /** Result of the newest run of the current version. */
  status: 'passed' | 'failed' | 'never';
  /** Recent runs of the current version both passed and failed. */
  flaky: boolean;
  failedRecently: number;
  /** There are runs, but all from before the last edit. */
  stale: boolean;
};

/**
 * `runs` newest first, as ProjectStore.listRuns returns them. Runs lost to a
 * device problem say nothing about the case and are left out.
 */
export function caseHealth(runs: readonly RunSummary[], editedAt?: string, limit = 10): CaseHealth {
  const current = runs.filter((run) => !run.deviceProblem && (!editedAt || run.startedAt >= editedAt));
  const recent = current.slice(0, limit).map((run) => ({
    runId: run.runId,
    passed: run.passed,
    startedAt: run.startedAt,
    ...(run.suiteId ? { suiteId: run.suiteId } : {}),
  }));
  const failedRecently = recent.filter((run) => !run.passed).length;
  const newest = recent[0];
  return {
    recent,
    status: newest ? (newest.passed ? 'passed' : 'failed') : 'never',
    flaky: failedRecently > 0 && failedRecently < recent.length,
    failedRecently,
    stale: current.length === 0 && runs.length > 0,
  };
}
