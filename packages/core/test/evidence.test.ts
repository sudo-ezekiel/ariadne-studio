// The evidence pack of a Run all: the words for each outcome, the rows of one
// case with what each step was expected to do, the local time on the cover, and
// the page itself. Fixtures are built the way document.test.ts builds them.
import { afterEach, describe, expect, it } from 'vitest';
import { evidenceHtml, escapeHtml } from '../src/export/html.ts';
import { evidenceScreen, evidenceSteps, localTimeText, outcomeText, type EvidenceCase, type EvidenceStep } from '../src/export/evidence.ts';
import type { TestCase } from '../src/recorder/case-types.ts';
import type { RunSummary, StepResult } from '../src/replay/run-result.ts';
import type { SuiteCaseOutcome, SuiteRun } from '../src/replay/suite.ts';

const at = '2026-10-30T17:12:00.000Z';
const caseId = 'open-network-20261030-1712';

function fresh(extra: Partial<TestCase> = {}): TestCase {
  return {
    id: caseId,
    name: 'Open network',
    appId: 'com.android.settings',
    createdAt: at,
    deviceId: 'emulator-5556',
    preconditionBlocks: [{ file: 'blocks/login.yaml' }],
    steps: [
      {
        index: 1,
        kind: 'tap',
        selector: { kind: 'text', value: 'Network & internet' },
        point: { x: 1, y: 2 },
        screenshot: `evidence/${caseId}/step-001.png`,
        at,
        title: 'Open the network page',
        note: 'The network page opens',
      },
      { index: 2, kind: 'expect', selector: { kind: 'text', value: 'Internet' }, point: { x: 1, y: 2 }, at },
      { index: 3, kind: 'back', at },
    ],
    expectations: [{ selector: { kind: 'text', value: 'Wi-Fi' }, at }],
    ...extra,
  };
}

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

describe('outcomeText', () => {
  const words: Record<SuiteCaseOutcome, string> = {
    passed: 'Passed',
    flaky: 'Passed when run again',
    failed: 'Failed',
    error: 'Could not run',
    muted: 'Not run: muted',
    pending: 'Not run: Run all was stopped',
    running: 'Not run: Run all was stopped',
  };
  for (const [outcome, text] of Object.entries(words)) {
    it(`says "${text}" for ${outcome}`, () => {
      expect(outcomeText(outcome as SuiteCaseOutcome)).toBe(text);
    });
  }
});

describe('evidenceSteps', () => {
  // Flow: 0 launch, 1 block, 2 to 4 steps, 5 end check.
  const run = summary({
    passed: false,
    exitCode: 1,
    steps: [
      { flowIndex: 0, status: 'passed' },
      { flowIndex: 1, status: 'passed' },
      { flowIndex: 2, status: 'passed', replayScreenshot: 'runs/r/after-002.png', similarity: 95 },
      { flowIndex: 3, status: 'failed', error: 'Assertion is false' },
      { flowIndex: 4, status: 'not-run' },
      { flowIndex: 5, status: 'not-run' },
    ],
  });

  it('expects the note of a step, the check text of a check step, and the check text of an end check', () => {
    const rows = evidenceSteps(fresh(), run);
    expect(rows.map((row) => row.expected)).toEqual(['', '', 'The network page opens', '"Internet" is visible', '', '"Wi-Fi" is visible']);
  });

  it('expects nothing of the launch, the block and the start-from rows', () => {
    const rows = evidenceSteps(fresh(), run);
    expect(rows[0]).toMatchObject({ kind: 'launch', expected: '' });
    expect(rows[1]).toMatchObject({ kind: 'block', expected: '' });
    const child = evidenceSteps(fresh({ preconditionBlocks: [], startFrom: 'log-in-20261030-1700' }), run);
    expect(child[0]).toMatchObject({ kind: 'startFrom', expected: '' });
  });

  it('prefers a written note over the check text on a check step', () => {
    const testCase = fresh();
    testCase.steps[1] = { index: 2, kind: 'expect', selector: { kind: 'text', value: 'Internet' }, point: { x: 1, y: 2 }, at, note: 'Internet page is shown' };
    expect(evidenceSteps(testCase, run)[3]!.expected).toBe('Internet page is shown');
  });

  it('carries each status and the replayed screen of the run', () => {
    const rows = evidenceSteps(fresh(), run);
    expect(rows.map((row) => row.status)).toEqual(['passed', 'passed', 'passed', 'failed', 'not-run', 'not-run']);
    expect(rows[2]).toMatchObject({ replayed: 'runs/r/after-002.png', recorded: `evidence/${caseId}/step-001.png`, similarity: 95 });
    expect(rows[3]).toMatchObject({ error: 'Assertion is false' });
    expect(rows[3]).not.toHaveProperty('replayed');
  });

  it('has no status for a flow item the run has no result for', () => {
    const rows = evidenceSteps(fresh(), summary({ steps: [] }));
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.status === undefined)).toBe(true);
  });
});

describe('evidenceScreen', () => {
  const step = (extra: Partial<EvidenceStep>): EvidenceStep => ({ number: 1, kind: 'tap', label: 'x', looksDifferent: false, expected: '', ...extra }) as EvidenceStep;

  it('gives a tap row its replayed screen with all, and none with checks', () => {
    const tap = step({ kind: 'tap', status: 'passed', replayed: 'r/tap.png' });
    expect(evidenceScreen(tap, 'all')).toBe('r/tap.png');
    expect(evidenceScreen(tap, 'checks')).toBeUndefined();
  });

  it('keeps the screen of a check step row in both modes', () => {
    const check = step({ kind: 'expect', status: 'passed', replayed: 'r/check.png' });
    expect(evidenceScreen(check, 'all')).toBe('r/check.png');
    expect(evidenceScreen(check, 'checks')).toBe('r/check.png');
  });

  it('keeps the screen of an end check row in both modes', () => {
    const end = step({ kind: 'end', status: 'passed', replayed: 'r/end.png' });
    expect(evidenceScreen(end, 'all')).toBe('r/end.png');
    expect(evidenceScreen(end, 'checks')).toBe('r/end.png');
  });

  it('has no screen for a passed row that has none', () => {
    expect(evidenceScreen(step({ kind: 'expect', status: 'passed' }), 'all', 'r/fail.png')).toBeUndefined();
  });

  it('gives a failed row its own replayed screen over the failure screenshot, in both modes', () => {
    const failed = step({ status: 'failed', replayed: 'r/own.png' });
    expect(evidenceScreen(failed, 'all', 'r/fail.png')).toBe('r/own.png');
    expect(evidenceScreen(failed, 'checks', 'r/fail.png')).toBe('r/own.png');
  });

  it('gives a failed row without a screen the failure screenshot, in both modes, even for a tap', () => {
    const failed = step({ kind: 'tap', status: 'failed' });
    expect(evidenceScreen(failed, 'all', 'r/fail.png')).toBe('r/fail.png');
    expect(evidenceScreen(failed, 'checks', 'r/fail.png')).toBe('r/fail.png');
  });

  it('gives a failed row nothing when there is no failure screenshot either', () => {
    expect(evidenceScreen(step({ status: 'failed' }), 'checks')).toBeUndefined();
  });

  it('does not give the failure screenshot to a row that did not fail', () => {
    expect(evidenceScreen(step({ status: 'not-run' }), 'all', 'r/fail.png')).toBeUndefined();
  });
});

describe('localTimeText', () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it('writes a winter time in Athens at UTC+02:00', () => {
    process.env.TZ = 'Europe/Athens';
    expect(localTimeText('2026-01-15T10:05:00.000Z')).toBe('2026-01-15 12:05 (UTC+02:00)');
  });

  it('writes a summer time in Athens at UTC+03:00', () => {
    process.env.TZ = 'Europe/Athens';
    expect(localTimeText('2026-07-15T10:05:00.000Z')).toBe('2026-07-15 13:05 (UTC+03:00)');
  });

  it('writes UTC as UTC+00:00', () => {
    process.env.TZ = 'UTC';
    expect(localTimeText('2026-11-08T16:05:09.000Z')).toBe('2026-11-08 16:05 (UTC+00:00)');
  });

  it('takes the date from the local day when the offset crosses midnight', () => {
    process.env.TZ = 'Europe/Athens';
    expect(localTimeText('2026-12-31T23:30:00.000Z')).toBe('2027-01-01 01:30 (UTC+02:00)');
  });

  it('writes a half-hour offset in full', () => {
    process.env.TZ = 'Asia/Kolkata';
    expect(localTimeText('2026-11-08T10:00:00.000Z')).toBe('2026-11-08 15:30 (UTC+05:30)');
  });

  it('writes a negative offset with a minus', () => {
    process.env.TZ = 'America/New_York';
    expect(localTimeText('2026-01-15T10:05:00.000Z')).toBe('2026-01-15 05:05 (UTC-05:00)');
  });

  it('returns text that is not a date unchanged', () => {
    expect(localTimeText('last Tuesday')).toBe('last Tuesday');
    expect(localTimeText('')).toBe('');
  });
});

describe('evidenceHtml', () => {
  const time = (iso: string) => `T(${iso})`;
  const image = (path: string) => `data:image/png;base64,${Buffer.from(path).toString('base64')}`;
  const shot = (path: string) => `<img class="shot" src="${image(path)}"`;

  function suite(extra: Partial<SuiteRun> = {}): SuiteRun {
    return {
      suiteId: 'suite-20261031-101542',
      startedAt: '2026-10-31T10:15:42.000Z',
      finishedAt: '2026-10-31T10:20:00.000Z',
      status: 'finished',
      retryFailed: true,
      deviceId: 'emulator-5556',
      cases: [],
      ...extra,
    };
  }

  function item(id: string, outcome: SuiteCaseOutcome, extra: Partial<EvidenceCase> = {}): EvidenceCase {
    return { caseId: id, name: `Case ${id}`, outcome, attempts: 1, steps: [], ...extra };
  }

  const ranRun = { runId: 'a-20261031-101600', startedAt: '2026-10-31T10:16:00.000Z', passed: true };
  const row = (n: number, extra: Record<string, unknown> = {}) => ({
    number: n,
    kind: 'tap',
    label: `Step ${n}`,
    expected: '',
    looksDifferent: false,
    ...extra,
  });

  function page(cases: EvidenceCase[], extra: Partial<Parameters<typeof evidenceHtml>[0]> = {}): string {
    return evidenceHtml({ suite: suite(), cases, image, time, ...extra });
  }

  it('escapes the release, the tester, case names, step labels and errors', () => {
    const evil = `<script>alert("x")</script> & 'q'`;
    const html = page(
      [item('a', 'failed', { name: evil, failedStep: evil, error: evil, run: { ...ranRun, passed: false, error: evil }, steps: [row(1, { label: evil, error: evil, expected: evil, status: 'failed' })] })],
      { release: evil, testedBy: evil },
    );
    expect(html).not.toContain('<script>alert');
    expect(html).toContain(escapeHtml(evil));
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;');
  });

  it('says every case that ran passed only when the suite finished with passes and no failures', () => {
    const ok = page([item('a', 'passed'), item('b', 'flaky'), item('c', 'muted')]);
    expect(ok).toContain('Every case that ran passed.');
    expect(ok).toContain('<span class="passed">Every case that ran passed.</span>');
  });

  it('does not say every case passed when nothing passed, the suite was stopped or a case is pending', () => {
    expect(page([item('a', 'muted')])).not.toContain('Every case that ran passed.');
    expect(page([])).not.toContain('Every case that ran passed.');
    expect(page([item('a', 'passed')], { suite: suite({ status: 'stopped' }) })).not.toContain('Every case that ran passed.');
    expect(page([item('a', 'passed'), item('b', 'pending')])).not.toContain('Every case that ran passed.');
  });

  it('counts failed and errored cases in "did not pass"', () => {
    const html = page([item('a', 'passed'), item('b', 'failed'), item('c', 'error'), item('d', 'passed')]);
    expect(html).toContain('2 of 4 cases did not pass.');
    expect(html).not.toContain('Every case that ran passed.');
  });

  it('says not every case ran for a stopped suite without failures, and warns that it was stopped', () => {
    const html = page([item('a', 'passed'), item('b', 'pending')], { suite: suite({ status: 'stopped' }) });
    expect(html).toContain('Not every case ran.');
    expect(html).toContain('Run all was stopped before the end.');
  });

  it('warns when it was made while Run all was still running, and says it did not finish', () => {
    const html = page([item('a', 'running')], { suite: suite({ status: 'running' }) });
    expect(html).toContain('Run all was still running when this was made.');
    const open = evidenceHtml({ suite: { ...suite({ status: 'running' }), finishedAt: undefined as never }, cases: [], image, time });
    expect(open).toContain('not finished');
  });

  it('gives a section only to cases with a run or steps, and links the summary row to it', () => {
    const html = page([
      item('a', 'passed', { run: ranRun, steps: [row(1, { status: 'passed' })] }),
      item('b', 'muted'),
      item('c', 'failed', { run: { ...ranRun, passed: false } }),
      item('d', 'error', { error: 'Maestro not found' }),
    ]);
    expect(html).toContain('id="case-1"');
    expect(html).not.toContain('id="case-2"');
    expect(html).toContain('id="case-3"');
    expect(html).not.toContain('id="case-4"');
    expect(html).toContain('<a href="#case-1">Case a</a>');
    expect(html).toContain('<a href="#case-3">Case c</a>');
    expect(html).not.toContain('href="#case-2"');
    expect(html).not.toContain('href="#case-4"');
    expect(html).toContain('Maestro not found');
  });

  it('puts the failure screenshot in the failed step row when that row has no replayed screen', () => {
    const html = page([
      item('a', 'failed', {
        run: { ...ranRun, passed: false, failureScreenshot: 'runs/r/fail.png' },
        steps: [row(1, { status: 'passed', replayed: 'runs/r/one.png' }), row(2, { status: 'failed', error: 'Not found' })],
      }),
    ]);
    expect(html).toContain(shot('runs/r/fail.png'));
    expect(html).not.toContain('Screen when it failed');
    expect(html.split(shot('runs/r/fail.png')).length - 1).toBe(1);
  });

  it('keeps the replayed screen of a failed row over the failure screenshot', () => {
    const html = page([
      item('a', 'failed', {
        run: { ...ranRun, passed: false, failureScreenshot: 'runs/r/fail.png' },
        steps: [row(1, { status: 'failed', replayed: 'runs/r/own.png' })],
      }),
    ]);
    expect(html).toContain(shot('runs/r/own.png'));
    expect(html).not.toContain(shot('runs/r/fail.png'));
  });

  it('shows the failure screenshot under "Screen when it failed" when no row failed', () => {
    const html = page([
      item('a', 'failed', {
        run: { ...ranRun, passed: false, error: 'Maestro did not finish', failureScreenshot: 'runs/r/fail.png' },
        steps: [row(1, { status: 'passed' })],
      }),
    ]);
    expect(html).toContain('Screen when it failed');
    expect(html).toContain(shot('runs/r/fail.png'));
  });

  it('shows the failure screenshot of a case with no rows', () => {
    const html = page([item('a', 'failed', { run: { ...ranRun, passed: false, failureScreenshot: 'runs/r/fail.png' } })]);
    expect(html).toContain('Screen when it failed');
  });

  it('shows a row as not run, with the expected result and a looks-different warning', () => {
    const html = page([item('a', 'failed', { run: ranRun, steps: [row(1, { expected: 'The page opens', looksDifferent: true, status: 'passed' }), row(2)] })]);
    expect(html).toContain('The page opens');
    expect(html).toContain('looks different from the recording');
    expect(html).toContain('<td class="not-run">not run</td>');
  });

  it('notes a stale case and a deleted case in the summary and the section', () => {
    const html = page([
      item('a', 'passed', { run: ranRun, steps: [row(1, { status: 'passed' })], stale: true }),
      item('b', 'passed', { run: ranRun, missing: true }),
    ]);
    expect(html).toContain('The case was edited after this run.');
    expect(html).toContain('The case was edited after this run. The steps below');
    expect(html).toContain('The case was deleted after Run all.');
    expect(html).toContain('The case was deleted after Run all, so its steps are not shown.');
  });

  it('shows the note that explains a repeated run, and the number of runs', () => {
    const html = page([item('a', 'flaky', { attempts: 2, note: 'The phone went offline, so it ran again.', run: ranRun })]);
    expect(html).toContain('The phone went offline, so it ran again.');
    expect(html).toContain('2 runs');
  });

  it('shows the app versions Run all read', () => {
    const html = page([item('a', 'passed', { appId: 'com.example.bank' })], {
      suite: suite({ testedOn: { apps: [{ appId: 'com.example.bank', versionName: '2.4.1', versionCode: '241' }] } }),
    });
    expect(html).toContain('<code>com.example.bank</code> 2.4.1 (241)');
  });

  it('falls back to the app ids of the cases, with "version not read"', () => {
    const html = page([item('a', 'passed', { appId: 'com.example.one' }), item('b', 'passed', { appId: 'com.example.one' }), item('c', 'passed', { appId: 'com.example.two' })]);
    expect(html).toContain('<code>com.example.one</code> version not read');
    expect(html).toContain('<code>com.example.two</code> version not read');
    expect(html.split('<code>com.example.one</code> version not read').length - 1).toBe(1);
    expect(html).toContain('<th>Apps</th>');
  });

  it('says version not read for an app the phone gave no version for', () => {
    const html = page([item('a', 'passed')], { suite: suite({ testedOn: { apps: [{ appId: 'com.example.bank' }] } }) });
    expect(html).toContain('<code>com.example.bank</code> version not read');
  });

  it('names the device and its Android version, or says it was not read', () => {
    const read = page([], { suite: suite({ testedOn: { maker: 'Xiaomi', model: '23129RAA4G', android: '14', apps: [] } }) });
    expect(read).toContain('<th>Device</th><td>Xiaomi 23129RAA4G, Android 14</td>');
    expect(read).not.toContain('<th>Phone</th>');
    const none = page([]);
    expect(none).toContain('<th>Device</th><td>not read</td>');
    const empty = page([], { suite: suite({ testedOn: { apps: [] } }) });
    expect(empty).toContain('<th>Device</th><td>not read</td>');
  });

  it('starts the device with "Emulator: " when Run all saw an emulator', () => {
    const html = page([], { suite: suite({ testedOn: { maker: 'Google', model: 'sdk_gphone64', android: '16', emulator: true, apps: [] } }) });
    expect(html).toContain('<th>Device</th><td>Emulator: Google sdk_gphone64, Android 16</td>');
  });

  it('starts the device with "Real phone: " when Run all saw a real phone', () => {
    const html = page([], { suite: suite({ testedOn: { maker: 'Xiaomi', model: '23129RAA4G', android: '14', emulator: false, apps: [] } }) });
    expect(html).toContain('<th>Device</th><td>Real phone: Xiaomi 23129RAA4G, Android 14</td>');
  });

  it('adds no kind to the device when the emulator flag is absent', () => {
    const html = page([], { suite: suite({ testedOn: { model: 'Pixel 9', apps: [] } }) });
    expect(html).toContain('<th>Device</th><td>Pixel 9</td>');
  });

  it('puts the tester in the facts and in the sign-off table', () => {
    const html = page([], { testedBy: '  Maria P.  ', release: ' Release 5.1 ' });
    expect(html).toContain('<th>Tested by</th><td>Maria P.</td>');
    expect(html).toContain('<tr><th>Tested by</th><td>Maria P.</td><td></td><td></td></tr>');
    expect(html).toContain('<tr><th>Accepted by</th><td></td><td></td><td></td></tr>');
    expect(html).toContain('<th>Release</th><td>Release 5.1</td>');
    expect(html).toContain('<title>Test results report: Release 5.1</title>');
  });

  it('leaves the release and tester empty when not given, with a plain title', () => {
    const html = page([]);
    expect(html).toContain('<th>Release</th><td></td>');
    expect(html).toContain('<title>Test results report</title>');
    expect(html).toContain('<h1>Test results report</h1>');
    expect(html).not.toContain('Acceptance test evidence');
  });

  it('uses the written role for the second signature, escaped', () => {
    const html = page([], { signoffRole: ' Reviewed by ' });
    expect(html).toContain('<tr><th>Reviewed by</th><td></td><td></td><td></td></tr>');
    expect(html).not.toContain('Accepted by');
    const evil = page([], { signoffRole: '<script>x</script>' });
    expect(evil).toContain('<tr><th>&lt;script&gt;x&lt;/script&gt;</th>');
    expect(evil).not.toContain('<script>x');
  });

  it('falls back to "Accepted by" for a blank role', () => {
    expect(page([], { signoffRole: '   ' })).toContain('<tr><th>Accepted by</th>');
  });

  it('shows known issues with line breaks kept by pre-wrap, and escapes markup in them', () => {
    const html = page([], { knownIssues: '  First <script>alert(1)</script>\nSecond & third  ' });
    expect(html).toContain('<th>Known issues</th><td><div class="written">First &lt;script&gt;alert(1)&lt;/script&gt;\nSecond &amp; third</div></td>');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('.written { white-space: pre-wrap; }');
  });

  it('shows the conclusion, and keeps Known issues and Conclusion rows empty when not given', () => {
    expect(page([], { conclusion: 'Ready for release <b>' })).toContain('<th>Conclusion</th><td><div class="written">Ready for release &lt;b&gt;</div></td>');
    const bare = page([]);
    expect(bare).toContain('<th>Known issues</th><td><div class="written"></div></td>');
    expect(bare).toContain('<th>Conclusion</th><td><div class="written"></div></td>');
  });

  it('says which steps keep a screen in the Screens row', () => {
    expect(page([])).toContain('<th>Screens</th><td>After every step.</td>');
    expect(page([], { screens: 'all' })).toContain('<th>Screens</th><td>After every step.</td>');
    expect(page([], { screens: 'checks' })).toContain('<th>Screens</th><td>After checks and after a step that failed.</td>');
  });

  it('shows the record file and its SHA-256 only when given', () => {
    const sha = 'ab'.repeat(32);
    const html = page([], { record: { path: 'runs/_suites/suite-1.json', sha256: sha } });
    expect(html).toContain(`<th>Record</th><td><code>runs/_suites/suite-1.json</code><div class="hash">SHA-256 <code>${sha}</code></div></td>`);
    expect(page([])).not.toContain('<th>Record</th>');
  });

  it('adds a Reference column to the cases table only when some case has a reference, lined up with its cell', () => {
    const html = page([item('a', 'passed', { reference: 'REQ-1 <x>' }), item('b', 'passed')]);
    expect(html).toContain('<th>#</th><th>Reference</th><th>Case</th><th>Result</th><th>Details</th>');
    expect(html).toContain('<td class="num">1</td><td>REQ-1 &lt;x&gt;</td><td>Case a</td>');
    expect(html).toContain('<td class="num">2</td><td></td><td>Case b</td>');
    const plain = page([item('a', 'passed')]);
    expect(plain).not.toContain('<th>Reference</th>');
    expect(plain).toContain('<th>#</th><th>Case</th><th>Result</th>');
    expect(plain).toContain('<td class="num">1</td><td>Case a</td>');
  });

  it('shows the reference and the record line in the case section', () => {
    const sha = 'cd'.repeat(32);
    const html = page([
      item('a', 'passed', { reference: 'US-7', run: ranRun, record: { path: 'runs/a-20261031-101600/summary.json', sha256: sha } }),
      item('b', 'passed', { run: ranRun }),
    ]);
    const sectionA = html.slice(html.indexOf('id="case-1"'), html.indexOf('id="case-2"'));
    expect(sectionA).toContain('reference US-7');
    expect(sectionA).toContain(`Results from <code>runs/a-20261031-101600/summary.json</code><div class="hash">SHA-256 <code>${sha}</code></div>`);
    const sectionB = html.slice(html.indexOf('id="case-2"'));
    expect(sectionB).not.toContain('reference');
    expect(sectionB).not.toContain('Results from');
  });

  it('inlines every step screen with screens all, and only checks and the failed step with checks', () => {
    const steps = [
      row(1, { kind: 'tap', status: 'passed', replayed: 'runs/r/tap.png' }),
      row(2, { kind: 'expect', status: 'passed', replayed: 'runs/r/check.png' }),
      row(3, { kind: 'end', status: 'passed', replayed: 'runs/r/end.png' }),
      row(4, { kind: 'tap', status: 'failed', error: 'x' }),
    ];
    const cases = [item('a', 'failed', { run: { ...ranRun, passed: false, failureScreenshot: 'runs/r/fail.png' }, steps })];
    const all = page(cases);
    for (const name of ['tap', 'check', 'end', 'fail']) expect(all).toContain(shot(`runs/r/${name}.png`));
    const checks = page(cases, { screens: 'checks' });
    expect(checks).not.toContain(shot('runs/r/tap.png'));
    for (const name of ['check', 'end', 'fail']) expect(checks).toContain(shot(`runs/r/${name}.png`));
  });

  it('still shows the screen for a failed run with no failed row in checks mode', () => {
    const html = page([item('a', 'failed', { run: { ...ranRun, passed: false, failureScreenshot: 'runs/r/fail.png' }, steps: [row(1, { status: 'passed' })] })], {
      screens: 'checks',
    });
    expect(html).toContain('Screen when it failed');
    expect(html).toContain(shot('runs/r/fail.png'));
  });

  it('formats times with the given function', () => {
    const html = page([item('a', 'passed', { run: ranRun })]);
    expect(html).toContain('T(2026-10-31T10:15:42.000Z) to T(2026-10-31T10:20:00.000Z)');
    expect(html).toContain('at T(2026-10-31T10:16:00.000Z)');
  });

  it('says what happens to a failed case under Failures', () => {
    expect(page([])).toContain('A case that failed ran once more.');
    expect(page([], { suite: suite({ retryFailed: false }) })).toContain('Each case ran once.');
  });

  it('says there are no cases for an empty suite', () => {
    expect(page([])).toContain('<p>No cases.</p>');
  });
});
