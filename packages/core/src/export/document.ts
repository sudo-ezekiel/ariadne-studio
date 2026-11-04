// The test case document a BA hands over: preconditions, numbered steps with
// expected results, the checks at the end, and the last replay. Built from the
// case JSON, so it is always in step with the flow. Pure.
import { caseFlowItems } from '../recorder/flow-layout.ts';
import type { TestCase } from '../recorder/case-types.ts';
import { describeExpectation, describeFlowItem, stepExpected, stepTitle, type DescribeNames } from '../recorder/describe.ts';
import { scrollTargets } from '../recorder/flow-layout.ts';
import type { RunSummary } from '../replay/run-result.ts';
import type { Sheet } from './xlsx.ts';

export type DocStep = {
  number: number;
  action: string;
  expected: string;
  /** Project-relative screenshot recorded after the step. */
  screenshot?: string;
};

export type CaseDocument = {
  id: string;
  name: string;
  appId: string;
  createdAt: string;
  editedAt?: string;
  muted?: boolean;
  preconditions: string[];
  steps: DocStep[];
  endChecks: string[];
  lastRun?: { runId: string; passed: boolean; startedAt: string; failedAt?: string; error?: string; stale: boolean };
};

export function caseDocument(testCase: TestCase, names: DescribeNames = {}, lastRun?: RunSummary): CaseDocument {
  const items = caseFlowItems(testCase);
  const preconditions = items
    .filter((item) => item.kind === 'launch' || item.kind === 'startFrom' || item.kind === 'block')
    .map((item) => describeFlowItem(item, testCase.appId, names));
  const targets = scrollTargets(testCase.steps, testCase.expectations);
  const steps = testCase.steps.map((step, position) => ({
    number: position + 1,
    action: stepTitle(step, targets[position]),
    expected: stepExpected(step),
    ...(step.screenshot ? { screenshot: step.screenshot } : {}),
  }));
  const doc: CaseDocument = {
    id: testCase.id,
    name: testCase.name,
    appId: testCase.appId,
    createdAt: testCase.createdAt,
    ...(testCase.editedAt ? { editedAt: testCase.editedAt } : {}),
    ...(testCase.muted ? { muted: true } : {}),
    preconditions,
    steps,
    endChecks: testCase.expectations.map(describeExpectation),
  };
  if (lastRun) {
    const failed = lastRun.steps.find((step) => step.status === 'failed');
    const failedItem = failed ? items[failed.flowIndex] : undefined;
    doc.lastRun = {
      runId: lastRun.runId,
      passed: lastRun.passed,
      startedAt: lastRun.startedAt,
      ...(failedItem ? { failedAt: describeFlowItem(failedItem, testCase.appId, names) } : {}),
      ...(failed?.error ? { error: failed.error } : lastRun.error ? { error: lastRun.error } : {}),
      stale: Boolean(testCase.editedAt && lastRun.startedAt < testCase.editedAt),
    };
  }
  return doc;
}

export function lastRunText(doc: CaseDocument): string {
  const run = doc.lastRun;
  if (!run) return 'Not run yet';
  const when = run.startedAt.slice(0, 16).replace('T', ' ');
  const result = run.passed ? `Passed ${when}` : `Failed ${when}${run.failedAt ? ` at "${run.failedAt}"` : ''}`;
  return run.stale ? `${result} (before the last edit)` : result;
}

function mdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/**
 * Markdown for one case. `imagePath` turns a project-relative screenshot path
 * into the link to write (relative to where the file is saved), or undefined
 * to leave screenshots out.
 */
export function caseMarkdown(doc: CaseDocument, imagePath?: (projectRelative: string) => string | undefined): string {
  const lines: string[] = [];
  lines.push(`# ${doc.name}`, '');
  lines.push('| | |', '|---|---|');
  lines.push(`| Case id | \`${doc.id}\` |`);
  lines.push(`| App | \`${doc.appId}\` |`);
  lines.push(`| Recorded | ${doc.createdAt.slice(0, 10)} |`);
  if (doc.editedAt) lines.push(`| Last edited | ${doc.editedAt.slice(0, 10)} |`);
  lines.push(`| Last run | ${mdCell(lastRunText(doc))} |`);
  if (doc.muted) lines.push('| Muted | yes, skipped by Run all |');
  lines.push('', '## Preconditions', '');
  doc.preconditions.forEach((line, i) => lines.push(`${i + 1}. ${line}`));
  lines.push('', '## Steps', '');
  if (doc.steps.length === 0) {
    lines.push('No recorded steps.');
  } else {
    const withImages = Boolean(imagePath);
    lines.push(withImages ? '| # | Action | Expected result | Screen after |' : '| # | Action | Expected result |');
    lines.push(withImages ? '|---|---|---|---|' : '|---|---|---|');
    for (const step of doc.steps) {
      const cells = [String(step.number), mdCell(step.action), mdCell(step.expected)];
      if (withImages) {
        const link = step.screenshot ? imagePath!(step.screenshot) : undefined;
        cells.push(link ? `![Screen after step ${step.number}](${link.replace(/ /g, '%20')})` : '');
      }
      lines.push(`| ${cells.join(' | ')} |`);
    }
  }
  lines.push('', '## Expected at the end', '');
  if (doc.endChecks.length === 0) lines.push('No end checks.');
  for (const check of doc.endChecks) lines.push(`- ${check}`);
  lines.push('');
  return lines.join('\n');
}

/** Workbook sheets for a set of cases: an overview and every step. */
export function casesSheets(docs: readonly CaseDocument[]): Sheet[] {
  const overview: string[][] = [['Case', 'Case id', 'App', 'Preconditions', 'Steps', 'Expected at the end', 'Last run', 'Muted']];
  const steps: string[][] = [['Case', 'Step', 'Action', 'Expected result', 'Screenshot']];
  for (const doc of docs) {
    overview.push([
      doc.name,
      doc.id,
      doc.appId,
      doc.preconditions.join('\n'),
      String(doc.steps.length),
      doc.endChecks.join('\n'),
      lastRunText(doc),
      doc.muted ? 'yes' : '',
    ]);
    doc.preconditions.forEach((line, i) => steps.push([doc.name, `P${i + 1}`, line, '', '']));
    for (const step of doc.steps) steps.push([doc.name, String(step.number), step.action, step.expected, step.screenshot ?? '']);
    if (doc.endChecks.length > 0) steps.push([doc.name, 'End', 'Check the final screen', doc.endChecks.join('\n'), '']);
  }
  return [
    { name: 'Cases', rows: overview, widths: [36, 34, 26, 44, 8, 40, 40, 8] },
    { name: 'Steps', rows: steps, widths: [36, 6, 54, 44, 44] },
  ];
}
