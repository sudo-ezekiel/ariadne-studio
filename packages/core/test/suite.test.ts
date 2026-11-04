import { describe, expect, it } from 'vitest';
import type { RunSummary } from '../src/replay/run-result.ts';
import { attemptsOutcome, caseHealth, suiteCounts, suiteOrder, suitePassed, type SuiteCaseOutcome, type SuiteRun } from '../src/replay/suite.ts';

function suite(outcomes: SuiteCaseOutcome[]): SuiteRun {
  return {
    suiteId: 'suite-20261031-101542',
    startedAt: '2026-10-31T10:15:42.000Z',
    status: 'finished',
    retryFailed: true,
    deviceId: 'emulator-5556',
    cases: outcomes.map((outcome, i) => ({ caseId: `case-${i}`, name: `Case ${i}`, outcome, runIds: [] })),
  };
}

function run(minute: number, passed: boolean, suiteId?: string): RunSummary {
  const startedAt = `2026-10-31T10:${String(minute).padStart(2, '0')}:00.000Z`;
  return {
    runId: `c-20261031-10${String(minute).padStart(2, '0')}00`,
    caseId: 'c',
    flowFile: 'flows/c.yaml',
    startedAt,
    finishedAt: startedAt,
    exitCode: passed ? 0 : 1,
    passed,
    steps: [],
    outputFile: 'runs/x/output.txt',
    ...(suiteId ? { suiteId } : {}),
  };
}

/** Runs newest first, as ProjectStore.listRuns returns them. */
function history(...results: boolean[]): RunSummary[] {
  return results.map((passed, i) => run(50 - i, passed));
}

describe('attemptsOutcome', () => {
  it('reads the attempts of one case in order', () => {
    expect(attemptsOutcome([])).toBe('pending');
    expect(attemptsOutcome([true])).toBe('passed');
    expect(attemptsOutcome([false])).toBe('failed');
    expect(attemptsOutcome([false, true])).toBe('flaky');
    expect(attemptsOutcome([false, false])).toBe('failed');
  });
});

describe('suiteCounts and suitePassed', () => {
  it('counts every outcome, zero included', () => {
    expect(suiteCounts(suite(['passed', 'flaky', 'passed', 'muted', 'failed']))).toEqual({
      pending: 0,
      running: 0,
      passed: 2,
      failed: 1,
      flaky: 1,
      muted: 1,
      error: 0,
    });
    expect(Object.values(suiteCounts(suite([]))).every((count) => count === 0)).toBe(true);
  });

  it('passes with passed, flaky and muted cases only', () => {
    expect(suitePassed(suite(['passed', 'flaky', 'muted']))).toBe(true);
    expect(suitePassed(suite([]))).toBe(true);
    expect(suitePassed(suite(['passed', 'failed']))).toBe(false);
    expect(suitePassed(suite(['passed', 'error']))).toBe(false);
    expect(suitePassed(suite(['passed', 'pending']))).toBe(false);
    expect(suitePassed(suite(['running']))).toBe(false);
  });
});

describe('suiteOrder', () => {
  const item = (id: string, createdAt: string, startFrom?: string) => ({ id, createdAt, ...(startFrom ? { startFrom } : {}) });

  it('puts parents before their children, otherwise oldest first', () => {
    const cases = [
      item('d', '2026-10-31T04:00:00Z', 'b'),
      item('b', '2026-10-31T03:00:00Z', 'a'),
      item('c', '2026-10-31T02:00:00Z'),
      item('a', '2026-10-31T01:00:00Z'),
      item('e', '2026-10-31T00:30:00Z', 'a'),
    ];
    // e is older than a but starts from it, so it follows a; b (newer than e) comes after e.
    expect(suiteOrder(cases).map((x) => x.id)).toEqual(['a', 'e', 'b', 'd', 'c']);
  });

  it('breaks ties on creation time by id', () => {
    const cases = [item('z', '2026-10-31T01:00:00Z'), item('m', '2026-10-31T01:00:00Z'), item('a', '2026-10-31T01:00:00Z')];
    expect(suiteOrder(cases).map((x) => x.id)).toEqual(['a', 'm', 'z']);
  });

  it('treats a case whose parent is missing, or itself, as a root', () => {
    const cases = [item('orphan', '2026-10-31T02:00:00Z', 'deleted'), item('self', '2026-10-31T03:00:00Z', 'self'), item('root', '2026-10-31T01:00:00Z')];
    expect(suiteOrder(cases).map((x) => x.id)).toEqual(['root', 'orphan', 'self']);
  });

  it('still returns every case once when cases start from each other in a loop', () => {
    const cases = [item('y', '2026-10-31T02:00:00Z', 'x'), item('x', '2026-10-31T01:00:00Z', 'y'), item('root', '2026-10-31T03:00:00Z')];
    const ordered = suiteOrder(cases).map((c) => c.id);
    expect(ordered).toHaveLength(3);
    expect(new Set(ordered)).toEqual(new Set(['x', 'y', 'root']));
    expect(ordered[0]).toBe('root');
  });

  it('returns the same objects and does not reorder the input', () => {
    const cases = [item('b', '2026-10-31T02:00:00Z'), item('a', '2026-10-31T01:00:00Z')];
    const ordered = suiteOrder(cases);
    expect(ordered[0]).toBe(cases[1]);
    expect(cases.map((c) => c.id)).toEqual(['b', 'a']);
  });
});

describe('caseHealth', () => {
  it('has nothing to say about a case that never ran', () => {
    expect(caseHealth([])).toEqual({ recent: [], status: 'never', flaky: false, failedRecently: 0, stale: false });
  });

  it('takes the status from the newest run and calls mixed results flaky', () => {
    const health = caseHealth(history(true, false, true));
    expect(health.status).toBe('passed');
    expect(health.flaky).toBe(true);
    expect(health.failedRecently).toBe(1);
    expect(health.recent.map((dot) => dot.passed)).toEqual([true, false, true]);
    expect(health.recent[0]).toEqual({ runId: 'c-20261031-105000', passed: true, startedAt: '2026-10-31T10:50:00.000Z' });
    expect(caseHealth(history(false, true)).status).toBe('failed');
  });

  it('is not flaky when every recent run agrees', () => {
    expect(caseHealth(history(true, true, true))).toMatchObject({ flaky: false, failedRecently: 0, status: 'passed' });
    expect(caseHealth(history(false, false))).toMatchObject({ flaky: false, failedRecently: 2, status: 'failed' });
  });

  it('counts only runs of the current version after an edit', () => {
    // Runs at 10:50 (pass), 10:49 (pass), 10:48 (fail), 10:47 (fail); edited at 10:49 exactly.
    const runs = history(true, true, false, false);
    const health = caseHealth(runs, '2026-10-31T10:49:00.000Z');
    expect(health.recent.map((dot) => dot.startedAt)).toEqual(['2026-10-31T10:50:00.000Z', '2026-10-31T10:49:00.000Z']);
    expect(health).toMatchObject({ status: 'passed', flaky: false, failedRecently: 0, stale: false });
    expect(caseHealth(runs).flaky).toBe(true);
  });

  it('is stale when every run is older than the last edit', () => {
    expect(caseHealth(history(true, false), '2026-10-31T11:00:00.000Z')).toEqual({
      recent: [],
      status: 'never',
      flaky: false,
      failedRecently: 0,
      stale: true,
    });
  });

  it('keeps only the newest `limit` runs, and judges flakiness on those', () => {
    const runs = history(true, true, false, true, true, true, true, true, true, true, true, true);
    expect(caseHealth(runs).recent).toHaveLength(10);
    const two = caseHealth(runs, undefined, 2);
    expect(two.recent.map((dot) => dot.runId)).toEqual(['c-20261031-105000', 'c-20261031-104900']);
    expect(two.flaky).toBe(false);
    expect(caseHealth(runs, undefined, 3).flaky).toBe(true);
  });

  it('marks dots from Run all with the suite id', () => {
    const health = caseHealth([run(51, false, 'suite-20261031-105100'), run(50, true)]);
    expect(health.recent).toEqual([
      { runId: 'c-20261031-105100', passed: false, startedAt: '2026-10-31T10:51:00.000Z', suiteId: 'suite-20261031-105100' },
      { runId: 'c-20261031-105000', passed: true, startedAt: '2026-10-31T10:50:00.000Z' },
    ]);
  });
});

describe('caseHealth and device problems', () => {
  it('leaves runs lost to the device out of the history', () => {
    const run = (runId: string, startedAt: string, passed: boolean, deviceProblem?: string) =>
      ({ runId, startedAt, passed, ...(deviceProblem ? { deviceProblem } : {}) }) as unknown as RunSummary;
    const health = caseHealth([
      run('c', '2026-10-31T10:03:00.000Z', true),
      run('b', '2026-10-31T10:02:00.000Z', false, 'The connection to the device dropped during the run.'),
      run('a', '2026-10-31T10:01:00.000Z', true),
    ]);
    expect(health).toMatchObject({ status: 'passed', flaky: false, failedRecently: 0, stale: false });
    expect(health.recent.map((dot) => dot.runId)).toEqual(['c', 'a']);
  });
});
