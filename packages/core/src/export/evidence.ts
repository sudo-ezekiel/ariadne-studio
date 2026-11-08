// The evidence pack of one Run all: what ran, on which phone and app version,
// and for each case every step of the run that counted, with what was expected
// and the screen it left. A BA hands it to whoever accepts the release. Pure;
// the server reads the runs and fills in image data.
import { caseFlowItems } from '../recorder/flow-layout.ts';
import type { TestCase } from '../recorder/case-types.ts';
import { describeExpectation, stepExpected, type DescribeNames } from '../recorder/describe.ts';
import type { RunSummary } from '../replay/run-result.ts';
import type { SuiteCaseOutcome } from '../replay/suite.ts';
import { runReportRows, type ReportRow } from './report.ts';

export type EvidenceStep = ReportRow & { expected: string };

/** A file the pack summarises and its SHA-256, so a reader holding the project can check the pack against it. */
export type RecordFile = { path: string; sha256: string };

/** Which steps keep their screen: every one, or only checks and the step that failed. */
export type ScreensMode = 'all' | 'checks';

export type EvidenceCase = {
  caseId: string;
  name: string;
  outcome: SuiteCaseOutcome;
  /** Runs Run all made of the case, retries included. */
  attempts: number;
  appId?: string;
  /** The case's requirement, user story or scenario code. */
  reference?: string;
  /** The last attempt, which the outcome rests on. */
  run?: Pick<RunSummary, 'runId' | 'startedAt' | 'passed' | 'error' | 'failureScreenshot'>;
  /** The run's summary.json, which every result shown for the case comes from. */
  record?: RecordFile;
  /** Empty when the case did not run or its file is gone. */
  steps: EvidenceStep[];
  failedStep?: string;
  error?: string;
  /** Why a run was repeated when the phone, not the app, failed. */
  note?: string;
  /** The case was edited after its run, so the steps shown may not be the ones that ran. */
  stale?: boolean;
  /** The case was deleted after Run all; only what Run all saved is known. */
  missing?: boolean;
};

const OUTCOME_TEXT: Record<SuiteCaseOutcome, string> = {
  passed: 'Passed',
  flaky: 'Passed when run again',
  failed: 'Failed',
  error: 'Could not run',
  muted: 'Not run: muted',
  pending: 'Not run: Run all was stopped',
  running: 'Not run: Run all was stopped',
};

/** A case's result in the words of the pack. */
export function outcomeText(outcome: SuiteCaseOutcome): string {
  return OUTCOME_TEXT[outcome];
}

/** Every flow item of the case with its result in `run` and what it was expected to do. */
export function evidenceSteps(testCase: TestCase, run: RunSummary, names: DescribeNames = {}): EvidenceStep[] {
  const items = caseFlowItems(testCase);
  return runReportRows(testCase, run, names).map((row, index) => {
    const item = items[index];
    const expected = item?.kind === 'step' ? stepExpected(item.step) : item?.kind === 'expectation' ? describeExpectation(item.expectation) : '';
    return { ...row, expected };
  });
}

/**
 * The screen a step shows in the pack. Maestro takes no picture after the step
 * that failed; its own failure screenshot is that screen. With `checks`, only
 * checks, end checks and the failed step keep one.
 */
export function evidenceScreen(step: EvidenceStep, mode: ScreensMode, failureScreenshot?: string): string | undefined {
  const failed = step.status === 'failed';
  if (mode === 'checks' && !failed && step.kind !== 'expect' && step.kind !== 'end') return undefined;
  return step.replayed ?? (failed ? failureScreenshot : undefined);
}

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * "2026-11-08 16:05 (UTC+02:00)" in this computer's time zone. A pack is read
 * and signed where it was made, so it does not use UTC as the run reports do,
 * but it says which offset it means.
 */
export function localTimeText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const zone = `UTC${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} (${zone})`;
}
