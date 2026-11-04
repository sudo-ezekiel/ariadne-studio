// Rows of a run report: every flow item of the case with its result and the
// recorded and replayed screenshots. Pure; the server fills in image data.
import { LOOKS_DIFFERENT_BELOW } from '../image/similarity.ts';
import { caseFlowItems } from '../recorder/flow-layout.ts';
import type { TestCase } from '../recorder/case-types.ts';
import { describeFlowItem, type DescribeNames } from '../recorder/describe.ts';
import type { RunSummary, StepStatus } from '../replay/run-result.ts';

export type ReportRow = {
  /** 1-based position in the flow. */
  number: number;
  kind: string;
  label: string;
  status?: StepStatus;
  error?: string;
  /** How long Maestro took on this step. */
  durationMs?: number;
  /** When Maestro started this step, epoch ms. */
  startedAt?: number;
  /** Project-relative paths. */
  recorded?: string;
  replayed?: string;
  similarity?: number;
  looksDifferent: boolean;
};

export function looksDifferent(similarity: number | undefined): boolean {
  return similarity !== undefined && similarity < LOOKS_DIFFERENT_BELOW;
}

export function runReportRows(testCase: TestCase, run: RunSummary, names: DescribeNames = {}): ReportRow[] {
  const results = new Map(run.steps.map((step) => [step.flowIndex, step]));
  return caseFlowItems(testCase).map((item, flowIndex) => {
    const result = results.get(flowIndex);
    const recorded = item.kind === 'step' ? item.step.screenshot : undefined;
    return {
      number: flowIndex + 1,
      kind: item.kind === 'step' ? item.step.kind : item.kind === 'expectation' ? 'end' : item.kind,
      label: describeFlowItem(item, testCase.appId, names),
      ...(result ? { status: result.status } : {}),
      ...(result?.error ? { error: result.error } : {}),
      ...(result?.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      ...(result?.startedAt !== undefined ? { startedAt: result.startedAt } : {}),
      ...(recorded ? { recorded } : {}),
      ...(result?.replayScreenshot ? { replayed: result.replayScreenshot } : {}),
      ...(result?.similarity !== undefined ? { similarity: result.similarity } : {}),
      looksDifferent: looksDifferent(result?.similarity),
    };
  });
}
