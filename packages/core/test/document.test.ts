import { describe, expect, it } from 'vitest';
import { caseDocument, caseMarkdown, casesSheets, lastRunText, type CaseDocument } from '../src/export/document.ts';
import { casesHtml, escapeHtml, runReportHtml, suiteReportHtml } from '../src/export/html.ts';
import { looksDifferent, runReportRows } from '../src/export/report.ts';
import { LOOKS_DIFFERENT_BELOW } from '../src/image/similarity.ts';
import type { TestCase } from '../src/recorder/case-types.ts';
import type { RunSummary, StepResult } from '../src/replay/run-result.ts';
import type { SuiteRun } from '../src/replay/suite.ts';

const at = '2026-10-30T17:12:00.000Z';
const caseId = 'open-network-20261030-1712';

function fresh(extra: Partial<TestCase> = {}): TestCase {
  return {
    id: caseId,
    name: 'Open network',
    appId: 'com.android.settings',
    createdAt: at,
    deviceId: 'emulator-5556',
    preconditionBlocks: [{ file: 'blocks/login.yaml' }, { file: 'blocks/onboarding.yaml' }],
    steps: [
      { index: 1, kind: 'scroll', direction: 'down', screenshot: `evidence/${caseId}/step-001.png`, at },
      {
        index: 2,
        kind: 'tap',
        selector: { kind: 'text', value: 'Network & internet' },
        point: { x: 1, y: 2 },
        screenshot: `evidence/${caseId}/step-002.png`,
        at,
        title: 'Open the network page',
        note: 'The network page opens',
      },
      { index: 3, kind: 'expect', selector: { kind: 'text', value: 'Internet' }, point: { x: 1, y: 2 }, at },
      { index: 4, kind: 'type', text: '${PASSWORD}', screenshot: `evidence/${caseId}/step-004.png`, at },
    ],
    expectations: [
      { selector: { kind: 'text', value: 'Wi-Fi' }, at },
      { selector: { kind: 'id', value: 'com.android.settings:id/hotspot_row' }, at },
    ],
    ...extra,
  };
}

const names = {
  caseName: (id: string) => (id === 'log-in-20261030-1700' ? 'Log in' : undefined),
  blockName: (file: string) => (file === 'blocks/login.yaml' ? 'Log in as BA' : undefined),
};

function summary(extra: Partial<RunSummary> & { steps: StepResult[] }): RunSummary {
  return {
    runId: `${caseId}-20261031-101542`,
    caseId,
    flowFile: `flows/${caseId}.yaml`,
    startedAt: '2026-10-31T10:15:42.000Z',
    finishedAt: '2026-10-31T10:16:30.000Z',
    exitCode: 0,
    passed: true,
    outputFile: 'runs/x/output.txt',
    ...extra,
  };
}

function failingAt(flowIndex: number, error?: string): RunSummary {
  const steps: StepResult[] = [];
  for (let i = 0; i < flowIndex; i++) steps.push({ flowIndex: i, status: 'passed' });
  steps.push({ flowIndex, status: 'failed', ...(error ? { error } : {}) });
  steps.push({ flowIndex: flowIndex + 1, status: 'not-run' });
  return summary({ exitCode: 1, passed: false, steps });
}

describe('caseDocument', () => {
  it('lists the launch and the blocks as preconditions of a fresh case', () => {
    expect(caseDocument(fresh(), names).preconditions).toEqual([
      'Start com.android.settings',
      'Run the block "Log in as BA" (blocks/login.yaml)',
      'Run the block blocks/onboarding.yaml',
    ]);
  });

  it('lists only the start case for a case that starts from another', () => {
    const child = fresh({ preconditionBlocks: [], startFrom: 'log-in-20261030-1700' });
    expect(caseDocument(child, names).preconditions).toEqual(['Do everything in the case "Log in"']);
    expect(caseDocument(child).preconditions).toEqual(['Do everything in the case log-in-20261030-1700']);
    expect(caseDocument({ ...child, startFrom: 'gone-20261030-1700' }, names).preconditions).toEqual(['Do everything in the case gone-20261030-1700']);
  });

  it('numbers the steps with titles, expected results and screenshots', () => {
    const doc = caseDocument(fresh(), names);
    expect(doc.steps).toEqual([
      { number: 1, action: 'Scroll down until "Network & internet" is visible', expected: '', screenshot: `evidence/${caseId}/step-001.png` },
      { number: 2, action: 'Open the network page', expected: 'The network page opens', screenshot: `evidence/${caseId}/step-002.png` },
      { number: 3, action: 'Check that "Internet" is visible', expected: '"Internet" is visible' },
      { number: 4, action: 'Type the PASSWORD value from .env', expected: '', screenshot: `evidence/${caseId}/step-004.png` },
    ]);
    expect(doc.endChecks).toEqual(['"Wi-Fi" is visible', 'the hotspot row element is visible']);
    expect(doc).toMatchObject({ id: caseId, name: 'Open network', appId: 'com.android.settings', createdAt: at });
    expect(doc).not.toHaveProperty('lastRun');
    expect(doc).not.toHaveProperty('editedAt');
    expect(doc).not.toHaveProperty('muted');
  });

  it('describes where the last run failed from the failing flow index', () => {
    // Flow: 0 launch, 1 and 2 blocks, 3 to 6 steps, 7 and 8 end checks.
    expect(caseDocument(fresh(), names, failingAt(4, 'Element not found')).lastRun).toEqual({
      runId: `${caseId}-20261031-101542`,
      passed: false,
      startedAt: '2026-10-31T10:15:42.000Z',
      failedAt: 'Open the network page',
      error: 'Element not found',
      stale: false,
    });
    expect(caseDocument(fresh(), names, failingAt(1)).lastRun?.failedAt).toBe('Run the block "Log in as BA" (blocks/login.yaml)');
    expect(caseDocument(fresh(), names, failingAt(8)).lastRun?.failedAt).toBe('Check that the hotspot row element is visible');
    const child = fresh({ preconditionBlocks: [], startFrom: 'log-in-20261030-1700' });
    expect(caseDocument(child, names, failingAt(0)).lastRun?.failedAt).toBe('Do everything in the case "Log in"');
    expect(caseDocument(child, names, failingAt(1)).lastRun?.failedAt).toBe('Scroll down until "Network & internet" is visible');
  });

  it('falls back to the run error, and has no failedAt for a passed run', () => {
    const noStep = summary({ exitCode: 1, passed: false, steps: [], error: 'Maestro did not finish in time and was stopped.' });
    expect(caseDocument(fresh(), names, noStep).lastRun).toEqual({
      runId: `${caseId}-20261031-101542`,
      passed: false,
      startedAt: '2026-10-31T10:15:42.000Z',
      error: 'Maestro did not finish in time and was stopped.',
      stale: false,
    });
    const passed = caseDocument(fresh(), names, summary({ steps: [{ flowIndex: 0, status: 'passed' }] })).lastRun!;
    expect(passed).not.toHaveProperty('failedAt');
    expect(passed).not.toHaveProperty('error');
  });

  it('calls the last run stale when the case was edited after it started', () => {
    const run = summary({ steps: [] });
    expect(caseDocument(fresh({ editedAt: '2026-10-31T11:00:00.000Z' }), names, run).lastRun?.stale).toBe(true);
    expect(caseDocument(fresh({ editedAt: '2026-10-31T09:00:00.000Z' }), names, run).lastRun?.stale).toBe(false);
    expect(caseDocument(fresh(), names, run).lastRun?.stale).toBe(false);
    expect(caseDocument(fresh({ editedAt: '2026-10-31T11:00:00.000Z', muted: true }), names)).toMatchObject({
      editedAt: '2026-10-31T11:00:00.000Z',
      muted: true,
    });
  });
});

describe('lastRunText', () => {
  const doc = (lastRun?: CaseDocument['lastRun']): CaseDocument => ({ ...caseDocument(fresh()), ...(lastRun ? { lastRun } : {}) });

  it('reads as one line', () => {
    expect(lastRunText(doc())).toBe('Not run yet');
    expect(lastRunText(doc({ runId: 'r', passed: true, startedAt: '2026-10-31T10:15:42.000Z', stale: false }))).toBe('Passed 2026-10-31 10:15');
    expect(lastRunText(doc({ runId: 'r', passed: false, startedAt: '2026-10-31T10:15:42.000Z', failedAt: 'Tap "System"', stale: false }))).toBe(
      'Failed 2026-10-31 10:15 at "Tap "System""',
    );
    expect(lastRunText(doc({ runId: 'r', passed: false, startedAt: '2026-10-31T10:15:42.000Z', stale: true }))).toBe(
      'Failed 2026-10-31 10:15 (before the last edit)',
    );
  });
});

describe('caseMarkdown', () => {
  it('writes a table without images when no image path is given', () => {
    const md = caseMarkdown(caseDocument(fresh(), names));
    expect(md.startsWith('# Open network\n')).toBe(true);
    expect(md).toContain(`| Case id | \`${caseId}\` |`);
    expect(md).toContain('| Last run | Not run yet |');
    expect(md).toContain('## Preconditions\n\n1. Start com.android.settings\n2. Run the block "Log in as BA" (blocks/login.yaml)\n3. Run the block blocks/onboarding.yaml\n');
    expect(md).toContain('| # | Action | Expected result |\n|---|---|---|\n');
    expect(md).toContain('| 2 | Open the network page | The network page opens |\n');
    expect(md).not.toContain('Screen after');
    expect(md).not.toContain('![');
    expect(md).toContain('## Expected at the end\n\n- "Wi-Fi" is visible\n- the hotspot row element is visible\n');
    expect(md).not.toContain('Muted');
    expect(md).not.toContain('Last edited');
  });

  it('links screenshots, encoding spaces, and leaves cells empty without one', () => {
    const doc = caseDocument(fresh({ id: 'my case' }), names);
    doc.steps[0]!.screenshot = 'evidence/my case/step-001.png';
    const md = caseMarkdown(doc, (path) => (path.endsWith('step-004.png') ? undefined : `../${path}`));
    expect(md).toContain('| # | Action | Expected result | Screen after |\n|---|---|---|---|\n');
    expect(md).toContain('![Screen after step 1](../evidence/my%20case/step-001.png)');
    expect(md).toContain(`| 2 | Open the network page | The network page opens | ![Screen after step 2](../evidence/${caseId}/step-002.png) |`);
    // Step 3 has no screenshot; step 4 has one the callback leaves out.
    expect(md).toContain('| 3 | Check that "Internet" is visible | "Internet" is visible |  |');
    expect(md).toContain('| 4 | Type the PASSWORD value from .env |  |  |');
  });

  it('escapes pipes and keeps line breaks inside cells', () => {
    const doc = caseDocument(
      fresh({
        steps: [{ index: 1, kind: 'back', at, title: 'Go back | twice', note: 'Line one\nLine two\r\nLine three' }],
        expectations: [],
      }),
    );
    const md = caseMarkdown(doc);
    expect(md).toContain('| 1 | Go back \\| twice | Line one<br>Line two<br>Line three |');
    expect(md).toContain('No end checks.');
  });

  it('shows edits, mute, the last run, and an empty case', () => {
    const doc = caseDocument(
      fresh({ steps: [], expectations: [], editedAt: '2026-10-31T11:00:00.000Z', muted: true }),
      names,
      failingAt(1, 'boom'),
    );
    const md = caseMarkdown(doc);
    expect(md).toContain('| Last edited | 2026-10-31 |');
    expect(md).toContain('| Muted | yes, skipped by Run all |');
    expect(md).toContain('| Last run | Failed 2026-10-31 10:15 at "Run the block "Log in as BA" (blocks/login.yaml)" (before the last edit) |');
    expect(md).toContain('No recorded steps.');
    expect(md).toContain('No end checks.');
  });
});

describe('casesSheets', () => {
  it('lays out an overview row per case and a row per precondition, step and end check', () => {
    const first = caseDocument(fresh({ muted: true }), names, summary({ steps: [] }));
    const second = caseDocument(
      fresh({ id: 'b', name: 'Second', preconditionBlocks: [], steps: [{ index: 1, kind: 'back', at }], expectations: [] }),
    );
    const [cases, steps] = casesSheets([first, second]);
    expect(cases!.name).toBe('Cases');
    expect(cases!.rows[0]).toEqual(['Case', 'Case id', 'App', 'Preconditions', 'Steps', 'Expected at the end', 'Last run', 'Muted']);
    expect(cases!.rows[1]).toEqual([
      'Open network',
      caseId,
      'com.android.settings',
      'Start com.android.settings\nRun the block "Log in as BA" (blocks/login.yaml)\nRun the block blocks/onboarding.yaml',
      '4',
      '"Wi-Fi" is visible\nthe hotspot row element is visible',
      'Passed 2026-10-31 10:15',
      'yes',
    ]);
    expect(cases!.rows[2]).toEqual(['Second', 'b', 'com.android.settings', 'Start com.android.settings', '1', '', 'Not run yet', '']);
    expect(cases!.widths).toHaveLength(cases!.rows[0]!.length);

    expect(steps!.name).toBe('Steps');
    expect(steps!.rows).toEqual([
      ['Case', 'Step', 'Action', 'Expected result', 'Screenshot'],
      ['Open network', 'P1', 'Start com.android.settings', '', ''],
      ['Open network', 'P2', 'Run the block "Log in as BA" (blocks/login.yaml)', '', ''],
      ['Open network', 'P3', 'Run the block blocks/onboarding.yaml', '', ''],
      ['Open network', '1', 'Scroll down until "Network & internet" is visible', '', `evidence/${caseId}/step-001.png`],
      ['Open network', '2', 'Open the network page', 'The network page opens', `evidence/${caseId}/step-002.png`],
      ['Open network', '3', 'Check that "Internet" is visible', '"Internet" is visible', ''],
      ['Open network', '4', 'Type the PASSWORD value from .env', '', `evidence/${caseId}/step-004.png`],
      ['Open network', 'End', 'Check the final screen', '"Wi-Fi" is visible\nthe hotspot row element is visible', ''],
      ['Second', 'P1', 'Start com.android.settings', '', ''],
      ['Second', '1', 'Press Back', '', ''],
    ]);
    expect(steps!.widths).toHaveLength(steps!.rows[0]!.length);
  });
});

describe('runReportRows', () => {
  const run = summary({
    exitCode: 1,
    passed: false,
    steps: [
      { flowIndex: 0, status: 'passed' },
      { flowIndex: 1, status: 'passed' },
      { flowIndex: 2, status: 'passed', replayScreenshot: 'runs/r/Open network/takeScreenshot/after-003.png' },
      { flowIndex: 3, status: 'passed', replayScreenshot: 'runs/r/Open network/takeScreenshot/after-004.png', similarity: 97.5 },
      { flowIndex: 4, status: 'passed', replayScreenshot: 'runs/r/Open network/takeScreenshot/after-005.png', similarity: 40 },
      { flowIndex: 5, status: 'failed', error: 'Assertion is false: "Internet" is visible' },
      { flowIndex: 6, status: 'not-run' },
    ],
  });

  it('carries durationMs from the step result, and leaves it out when there is none', () => {
    const timed = summary({
      steps: [
        { flowIndex: 0, status: 'passed', durationMs: 420 },
        { flowIndex: 1, status: 'passed', durationMs: 0 },
        { flowIndex: 2, status: 'passed' },
      ],
    });
    const rows = runReportRows(fresh(), timed, names);
    expect(rows[0]!.durationMs).toBe(420);
    expect(rows[1]!.durationMs).toBe(0);
    expect(rows[2]).not.toHaveProperty('durationMs');
    expect(rows[3]).not.toHaveProperty('durationMs');
  });

  it('gives every flow item a row with its kind, label, result and screens', () => {
    const rows = runReportRows(fresh(), run, names);
    expect(rows.map((row) => [row.number, row.kind, row.status])).toEqual([
      [1, 'launch', 'passed'],
      [2, 'block', 'passed'],
      [3, 'block', 'passed'],
      [4, 'scroll', 'passed'],
      [5, 'tap', 'passed'],
      [6, 'expect', 'failed'],
      [7, 'type', 'not-run'],
      [8, 'end', undefined],
      [9, 'end', undefined],
    ]);
    expect(rows[1]!.label).toBe('Run the block "Log in as BA" (blocks/login.yaml)');
    expect(rows[3]).toEqual({
      number: 4,
      kind: 'scroll',
      label: 'Scroll down until "Network & internet" is visible',
      status: 'passed',
      recorded: `evidence/${caseId}/step-001.png`,
      replayed: 'runs/r/Open network/takeScreenshot/after-004.png',
      similarity: 97.5,
      looksDifferent: false,
    });
    expect(rows[4]).toMatchObject({ label: 'Open the network page', similarity: 40, looksDifferent: true });
    expect(rows[5]).toMatchObject({ error: 'Assertion is false: "Internet" is visible', looksDifferent: false });
    expect(rows[5]).not.toHaveProperty('recorded');
    expect(rows[2]).toMatchObject({ replayed: 'runs/r/Open network/takeScreenshot/after-003.png' });
    expect(rows[2]).not.toHaveProperty('similarity');
    expect(rows[8]).toEqual({ number: 9, kind: 'end', label: 'Check that the hotspot row element is visible', looksDifferent: false });
  });

  it('starts with the start case for a child case', () => {
    const rows = runReportRows(fresh({ preconditionBlocks: [], startFrom: 'log-in-20261030-1700' }), summary({ steps: [] }), names);
    expect(rows[0]).toEqual({ number: 1, kind: 'startFrom', label: 'Do everything in the case "Log in"', looksDifferent: false });
    expect(rows[1]!.kind).toBe('scroll');
  });

  it('flags only similarity below the threshold', () => {
    expect(looksDifferent(undefined)).toBe(false);
    expect(looksDifferent(LOOKS_DIFFERENT_BELOW)).toBe(false);
    expect(looksDifferent(LOOKS_DIFFERENT_BELOW - 0.1)).toBe(true);
    expect(looksDifferent(0)).toBe(true);
    expect(looksDifferent(100)).toBe(false);
  });
});

describe('HTML pages', () => {
  const evil = '<script>alert("x")</script> & \'co\'';
  const dataUrl = (path: string) => `data:image/png;base64,${Buffer.from(path).toString('base64')}`;

  it('escapes HTML', () => {
    expect(escapeHtml(`<a href="x" title='y'>&amp;</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;');
  });

  it('escapes names in a case document and inlines the images the callback returns', () => {
    const doc = caseDocument(
      fresh({
        name: evil,
        steps: [
          { index: 1, kind: 'back', screenshot: `evidence/${caseId}/step-001.png`, at, title: '<b>Back</b>', note: 'a < b' },
          { index: 2, kind: 'back', screenshot: `evidence/${caseId}/step-002.png`, at },
        ],
      }),
      names,
      failingAt(3, '<img src=x onerror=alert(1)>'),
    );
    const seen: string[] = [];
    const html = casesHtml([doc], (path) => {
      seen.push(path);
      return path.endsWith('step-001.png') ? dataUrl(path) : undefined;
    }, `Cases: ${evil}`);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Back</b>');
    expect(html).toContain(`<title>Cases: ${escapeHtml(evil)}</title>`);
    expect(html).toContain(`<h1>${escapeHtml(evil)}</h1>`);
    expect(html).toContain('&lt;b&gt;Back&lt;/b&gt;</td><td>a &lt; b</td>');
    expect(seen).toEqual([`evidence/${caseId}/step-001.png`, `evidence/${caseId}/step-002.png`]);
    expect(html).toContain(`<img class="shot" src="${dataUrl(`evidence/${caseId}/step-001.png`)}" alt="Screen after step 1">`);
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain('<span class="failed">');
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });

  it('puts several cases on one page, one section each', () => {
    const html = casesHtml([caseDocument(fresh()), caseDocument(fresh({ id: 'b', name: 'Second', steps: [], expectations: [] }))], () => undefined, 'All');
    expect(html.match(/<section class="case">/g)).toHaveLength(2);
    expect(html).toContain('<p>No recorded steps.</p>');
    expect(html).toContain('<p>No end checks.</p>');
    expect(html).toContain('<span class="not-run">Not run yet</span>');
  });

  it('escapes a run report and shows recorded and replayed screens side by side', () => {
    const testCase = fresh({ name: evil });
    const run = summary({
      exitCode: 1,
      passed: false,
      failureScreenshot: 'runs/r/Open network/screenshots/fail.png',
      error: 'Maestro said <nope>',
      steps: [
        { flowIndex: 3, status: 'passed', replayScreenshot: 'runs/r/after-004.png', similarity: 40 },
        { flowIndex: 4, status: 'failed', error: 'Element <Network & internet> not found' },
      ],
    });
    const html = runReportHtml({
      caseName: evil,
      caseId,
      appId: testCase.appId,
      run,
      rows: runReportRows(testCase, run, names),
      image: (path) => dataUrl(path),
      stale: true,
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain(`<title>${escapeHtml(evil)}: run failed</title>`);
    expect(html).toContain('<div class="error">Element &lt;Network &amp; internet&gt; not found</div>');
    expect(html).toContain('<p class="error">Maestro said &lt;nope&gt;</p>');
    expect(html).toContain(`src="${dataUrl(`evidence/${caseId}/step-001.png`)}" alt="Recorded screen, step 4"`);
    expect(html).toContain(`src="${dataUrl('runs/r/after-004.png')}" alt="Replayed screen, step 4"`);
    expect(html).toContain(`src="${dataUrl('runs/r/Open network/screenshots/fail.png')}" alt="Screen when the replay failed"`);
    expect(html).toContain('40% alike, looks different');
    expect(html).toContain('The case was edited after this run.');
    expect(html).toContain('<td class="not-run">not-run</td>');
  });

  it('leaves images out of a run report when the callback returns nothing', () => {
    const run = summary({ steps: [{ flowIndex: 3, status: 'passed', replayScreenshot: 'runs/r/after-004.png', similarity: 99 }] });
    const html = runReportHtml({ caseName: 'Open network', caseId, appId: 'a', run, rows: runReportRows(fresh(), run), image: () => undefined });
    expect(html).not.toContain('<img');
    expect(html).toContain('99% alike</div>');
    expect(html).not.toContain('looks different');
    expect(html).not.toContain('edited after this run');
    expect(html).toContain('<span class="passed">passed</span>');
  });

  it('shows the step duration in the result cell', () => {
    const run = summary({ steps: [{ flowIndex: 0, status: 'passed', durationMs: 3100 }, { flowIndex: 1, status: 'passed' }] });
    const html = runReportHtml({ caseName: 'Open network', caseId, appId: 'a', run, rows: runReportRows(fresh(), run), image: () => undefined });
    expect(html).toContain('<td class="passed">passed<div class="meta">3.1 s</div></td>');
    expect(html.match(/<div class="meta">\d/g)).toHaveLength(1);
  });

  it('links the video only when the run has one', () => {
    const show = (extra: Partial<RunSummary>) => {
      const run = summary({ steps: [], ...extra });
      return runReportHtml({ caseName: 'Open network', caseId, appId: 'a', run, rows: runReportRows(fresh(), run), image: () => undefined });
    };
    expect(show({ video: 'runs/r/video.mp4' })).toContain('<a href="video.mp4">Video</a>');
    expect(show({})).not.toContain('video.mp4');
    expect(show({})).not.toContain('>Video<');
  });

  it('escapes a suite report, counts outcomes and inlines failure screens', () => {
    const suite: SuiteRun = {
      suiteId: 'suite-20261031-101542',
      startedAt: '2026-10-31T10:15:42.000Z',
      status: 'running',
      retryFailed: true,
      deviceId: 'emulator-5556',
      cases: [],
    };
    const html = suiteReportHtml(
      suite,
      [
        { name: evil, caseId: 'a', outcome: 'failed', attempts: 2, failedStep: 'Tap <OK>', error: 'Boom & bust', failureScreenshot: 'runs/a/fail.png' },
        { name: 'Flaky one', caseId: 'b', outcome: 'flaky', attempts: 2 },
        { name: 'Fine', caseId: 'c', outcome: 'passed', attempts: 1 },
        { name: 'Quiet', caseId: 'd', outcome: 'muted', attempts: 0 },
      ],
      (path) => dataUrl(path),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain(`<td>${escapeHtml(evil)}<div class="meta">a</div></td>`);
    expect(html).toContain('<div class="error">Failed at: Tap &lt;OK&gt;\nBoom &amp; bust</div>');
    expect(html).toContain('<td class="failed">failed (2 attempts)</td>');
    expect(html).toContain('<td class="passed">passed</td>');
    expect(html).toContain(`src="${dataUrl('runs/a/fail.png')}" alt="Failure screen of ${escapeHtml(evil)}"`);
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain('1 failed, 1 flaky, 1 passed, 1 muted (still running)');
    expect(html).toContain('failures retried once');
  });

  it('says so when a suite has no cases or was stopped', () => {
    const suite: SuiteRun = { suiteId: 's', startedAt: '2026-10-31T10:15:42.000Z', status: 'stopped', retryFailed: false, deviceId: 'd', cases: [] };
    const html = suiteReportHtml(suite, [], () => undefined);
    expect(html).toContain('No cases. (stopped before the end)');
    expect(html).not.toContain('failures retried once');
  });
});
