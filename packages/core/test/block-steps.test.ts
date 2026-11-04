// Setup blocks that carry values, and blocks run in the middle of a case: how
// the recorder stores them, how they become runFlow commands, and how they
// read in step lists and documents.
import { describe, expect, it } from 'vitest';
import { caseDocument } from '../src/export/document.ts';
import { toMaestroYaml } from '../src/maestro/emit.ts';
import type { MaestroStep } from '../src/maestro/model.ts';
import { parseMaestroFlow } from '../src/maestro/parse.ts';
import type { CaseStep, TestCase } from '../src/recorder/case-types.ts';
import { describeFlowItem, describeStep, stepTitle } from '../src/recorder/describe.ts';
import { caseFlowItems, leadingItemCount, scrollTargets } from '../src/recorder/flow-layout.ts';
import { caseToFlow, Recorder } from '../src/recorder/recorder.ts';
import { instrumentForRun, runScreenshotName } from '../src/replay/instrument.ts';
import { correlateRun, parseMaestroRun, type RunSummary, type StepResult } from '../src/replay/run-result.ts';

const at = '2026-11-02T09:00:00.000Z';
const fixedNow = () => new Date(at);
const caseId = 'two-users-20261102-0900';

const SUPERVISOR = { USERNAME: '${SUPERVISOR_USERNAME}', PASSWORD: '${SUPERVISOR_PASSWORD}' };
const AGENT = { USERNAME: '${AGENT_MARIA_USERNAME}', PASSWORD: '${AGENT_MARIA_PASSWORD}' };
const KEYS = ['AGENT_MARIA_PASSWORD', 'AGENT_MARIA_USERNAME', 'SUPERVISOR_PASSWORD', 'SUPERVISOR_USERNAME'];
const PASS_THROUGH = Object.fromEntries(KEYS.map((key) => [key, `\${${key}}`]));

function tap(index: number, text: string): CaseStep {
  return { index, kind: 'tap', selector: { kind: 'text', value: text }, point: { x: 1, y: 2 }, at };
}

function block(index: number, file: string, values?: Record<string, string>, extra: Partial<CaseStep> = {}): CaseStep {
  return { index, kind: 'block', file, ...(values ? { values } : {}), at, ...extra } as CaseStep;
}

function testCase(extra: Partial<TestCase> = {}): TestCase {
  return {
    id: caseId,
    name: 'Two users',
    appId: 'com.example.claims',
    createdAt: at,
    deviceId: 'emulator-5556',
    preconditionBlocks: [],
    steps: [],
    expectations: [],
    ...extra,
  };
}

const runFlowsOf = (steps: readonly MaestroStep[]) => steps.filter((step): step is Extract<MaestroStep, { kind: 'runFlow' }> => step.kind === 'runFlow');

describe('caseToFlow with block values', () => {
  it('overlays the values on the pass-through of every project env key', () => {
    const flow = caseToFlow(testCase({ preconditionBlocks: [{ file: 'blocks/login.yaml', values: SUPERVISOR }] }), ['PASSWORD', 'USERNAME', 'COUNTRY']);
    expect(flow.steps).toEqual([
      { kind: 'launchApp' },
      {
        kind: 'runFlow',
        file: '../blocks/login.yaml',
        env: { PASSWORD: '${SUPERVISOR_PASSWORD}', USERNAME: '${SUPERVISOR_USERNAME}', COUNTRY: '${COUNTRY}' },
      },
    ]);
  });

  it('keeps the other env keys passing through by name', () => {
    const [login] = runFlowsOf(caseToFlow(testCase({ preconditionBlocks: [{ file: 'blocks/login.yaml', values: SUPERVISOR }] }), ['USERNAME', 'PASSWORD', ...KEYS]).steps);
    expect(login!.env).toEqual({ ...PASS_THROUGH, ...SUPERVISOR });
  });

  it('adds a value for a variable that is not an env key', () => {
    const [login] = runFlowsOf(caseToFlow(testCase({ preconditionBlocks: [{ file: 'blocks/search.yaml', values: { POLICY_NUMBER: '12345' } }] }), ['USERNAME']).steps);
    expect(login!.env).toEqual({ USERNAME: '${USERNAME}', POLICY_NUMBER: '12345' });
  });

  it('passes only the values when the project has no env keys', () => {
    const [search] = runFlowsOf(caseToFlow(testCase({ preconditionBlocks: [{ file: 'blocks/search.yaml', values: { POLICY_NUMBER: '12345' } }] })).steps);
    expect(search).toEqual({ kind: 'runFlow', file: '../blocks/search.yaml', env: { POLICY_NUMBER: '12345' } });
  });

  it('has no env at all with no env keys and no values', () => {
    for (const preconditionBlocks of [[{ file: 'blocks/login.yaml' }], [{ file: 'blocks/login.yaml', values: {} }]]) {
      const [login] = runFlowsOf(caseToFlow(testCase({ preconditionBlocks })).steps);
      expect(login).toStrictEqual({ kind: 'runFlow', file: '../blocks/login.yaml' });
    }
  });

  it('passes env keys through when the block has no values', () => {
    const [login] = runFlowsOf(caseToFlow(testCase({ preconditionBlocks: [{ file: 'blocks/login.yaml' }] }), ['USERNAME']).steps);
    expect(login!.env).toEqual({ USERNAME: '${USERNAME}' });
  });

  it('gives each block its own values', () => {
    const flow = caseToFlow(
      testCase({
        preconditionBlocks: [
          { file: 'blocks/login.yaml', values: SUPERVISOR },
          { file: 'blocks/login.yaml', values: AGENT },
          { file: 'blocks/other.yaml' },
        ],
      }),
      KEYS,
    );
    const [first, second, third] = runFlowsOf(flow.steps);
    expect(first!.env).toMatchObject(SUPERVISOR);
    expect(second!.env).toMatchObject(AGENT);
    expect(third!.env).toEqual(PASS_THROUGH);
  });

  it('writes the values as quoted YAML that parses back to the same env, whatever the text', () => {
    const values = {
      COUNTRY: 'GR',
      CITY: 'Thessaloniki, "north"',
      NOTE: 'yes',
      CODE: '007',
      EMPTYISH: 'null',
      PERCENT: '100% sure: really',
      GREEK: 'Μαρία',
      DOLLAR: '$5',
      HASH: '#1',
    };
    const flow = caseToFlow(testCase({ preconditionBlocks: [{ file: 'blocks/search.yaml', values }] }), ['USERNAME']);
    const parsed = parseMaestroFlow(toMaestroYaml(flow));
    expect(runFlowsOf(parsed.steps)[0]!.env).toEqual({ USERNAME: '${USERNAME}', ...values });
  });

  it('does not change the case it is given', () => {
    const input = testCase({
      preconditionBlocks: [{ file: 'blocks/login.yaml', values: SUPERVISOR }],
      steps: [tap(1, 'Claims'), block(2, 'blocks/login.yaml', AGENT)],
    });
    const copy = structuredClone(input);
    caseToFlow(input, KEYS);
    expect(input).toEqual(copy);
  });
});

describe('caseToFlow with a block in the middle', () => {
  const mid = testCase({
    preconditionBlocks: [{ file: 'blocks/login.yaml', values: SUPERVISOR }],
    steps: [tap(1, 'Claims'), block(2, 'blocks/login.yaml', AGENT), tap(3, 'Inbox')],
    expectations: [{ selector: { kind: 'text', value: 'Welcome Maria' }, at }],
  });

  it('emits one runFlow at the position of the step', () => {
    expect(caseToFlow(mid, KEYS).steps).toEqual([
      { kind: 'launchApp' },
      { kind: 'runFlow', file: '../blocks/login.yaml', env: { ...PASS_THROUGH, ...SUPERVISOR } },
      { kind: 'tapOn', selector: { kind: 'text', value: 'Claims' } },
      { kind: 'runFlow', file: '../blocks/login.yaml', env: { ...PASS_THROUGH, ...AGENT } },
      { kind: 'tapOn', selector: { kind: 'text', value: 'Inbox' } },
      { kind: 'assertVisible', selector: { kind: 'text', value: 'Welcome Maria' } },
    ]);
  });

  it('builds the block step the same way as a block before the case starts', () => {
    const before = caseToFlow(testCase({ preconditionBlocks: [{ file: 'blocks/login.yaml', values: AGENT }] }), KEYS).steps[1];
    const middle = caseToFlow(testCase({ steps: [block(1, 'blocks/login.yaml', AGENT)] }), KEYS).steps[1];
    expect(middle).toEqual(before);
  });

  it('applies the env rules to a block step: pass-through, values, or nothing', () => {
    const only = (step: CaseStep, keys: string[]) => caseToFlow(testCase({ steps: [step] }), keys).steps[1];
    expect(only(block(1, 'blocks/x.yaml'), [])).toStrictEqual({ kind: 'runFlow', file: '../blocks/x.yaml' });
    expect(only(block(1, 'blocks/x.yaml'), ['USERNAME'])).toEqual({ kind: 'runFlow', file: '../blocks/x.yaml', env: { USERNAME: '${USERNAME}' } });
    expect(only(block(1, 'blocks/x.yaml', { COUNTRY: 'GR' }), [])).toEqual({ kind: 'runFlow', file: '../blocks/x.yaml', env: { COUNTRY: 'GR' } });
    expect(only(block(1, 'blocks/x.yaml', {}), [])).toStrictEqual({ kind: 'runFlow', file: '../blocks/x.yaml' });
  });

  it('points at blocks in subfolders and normalises Windows separators', () => {
    const flow = caseToFlow(testCase({ steps: [block(1, 'blocks/shared/login.yaml'), block(2, 'blocks\\shared\\other.yaml')] }));
    expect(runFlowsOf(flow.steps).map((step) => step.file)).toEqual(['../blocks/shared/login.yaml', '../blocks/shared/other.yaml']);
  });

  it('puts a block step after the start case of a case that starts from another', () => {
    const child = testCase({ startFrom: 'parent-20261101-1000', steps: [block(1, 'blocks/login.yaml', AGENT), tap(2, 'Inbox')] });
    expect(caseToFlow(child, KEYS).steps).toEqual([
      { kind: 'runFlow', file: 'parent-20261101-1000.yaml', env: PASS_THROUGH },
      { kind: 'runFlow', file: '../blocks/login.yaml', env: { ...PASS_THROUGH, ...AGENT } },
      { kind: 'tapOn', selector: { kind: 'text', value: 'Inbox' } },
    ]);
  });

  it('emits YAML that a flow reader accepts, with the runFlow in place', () => {
    const yaml = toMaestroYaml(caseToFlow(testCase({ steps: [tap(1, 'Claims'), block(2, 'blocks/login.yaml', AGENT), tap(3, 'Inbox')] }), ['USERNAME']));
    expect(yaml).toBe(
      [
        'appId: com.example.claims',
        'name: Two users',
        '---',
        '- launchApp',
        '- tapOn:',
        '    text: "Claims"',
        '- runFlow:',
        '    file: ../blocks/login.yaml',
        '    env:',
        '      USERNAME: "${AGENT_MARIA_USERNAME}"',
        '      PASSWORD: "${AGENT_MARIA_PASSWORD}"',
        '- tapOn:',
        '    text: "Inbox"',
        '',
      ].join('\n'),
    );
    expect(parseMaestroFlow(yaml).steps.map((step) => step.kind)).toEqual(['launchApp', 'tapOn', 'runFlow', 'tapOn']);
  });

  it('emits one command per flow item, so a result at a flow index belongs to the same item', () => {
    const cases: TestCase[] = [
      mid,
      testCase({ startFrom: 'parent-20261101-1000', steps: [block(1, 'blocks/a.yaml'), block(2, 'blocks/a.yaml'), tap(3, 'Inbox')] }),
      testCase({ steps: [{ index: 1, kind: 'scroll', direction: 'down', at }, block(2, 'blocks/a.yaml'), { index: 3, kind: 'scroll', direction: 'up', at }, tap(4, 'Inbox')] }),
      testCase({ steps: [] }),
    ];
    for (const item of cases) {
      const items = caseFlowItems(item);
      const steps = caseToFlow(item, KEYS).steps;
      expect(steps).toHaveLength(items.length);
      items.forEach((flowItem, flowIndex) => {
        if (flowItem.kind === 'step' && flowItem.step.kind === 'block') expect(steps[flowIndex]!.kind).toBe('runFlow');
      });
    }
  });

  it('finds a block step at leadingItemCount plus its place in the case', () => {
    const items = caseFlowItems(mid);
    const lead = leadingItemCount(mid);
    expect(lead).toBe(2);
    expect(items.slice(lead, lead + 3).map((item) => (item.kind === 'step' ? item.step.kind : item.kind))).toEqual(['tap', 'block', 'tap']);
    const flow = caseToFlow(mid, KEYS);
    expect(flow.steps[lead + 1]).toMatchObject({ kind: 'runFlow', file: '../blocks/login.yaml' });
    // A start case leads with one item instead.
    const child = { ...mid, preconditionBlocks: [], startFrom: 'parent-20261101-1000' };
    expect(leadingItemCount(child)).toBe(1);
    expect(caseToFlow(child, KEYS).steps[1 + 1]).toMatchObject({ kind: 'runFlow', file: '../blocks/login.yaml' });
  });

  it('does not scroll towards a block: the scroll stays a plain scroll', () => {
    const steps: CaseStep[] = [
      { index: 1, kind: 'scroll', direction: 'down', at },
      block(2, 'blocks/login.yaml'),
      tap(3, 'Inbox'),
    ];
    expect(scrollTargets(steps, [])).toEqual([undefined, undefined, undefined]);
    expect(caseToFlow(testCase({ steps })).steps.map((step) => step.kind)).toEqual(['launchApp', 'scroll', 'runFlow', 'tapOn']);
  });

  it('gives a scroll before a block no target, and a scroll after one the first end expectation', () => {
    const steps: CaseStep[] = [{ index: 1, kind: 'scroll', direction: 'down', at }, block(2, 'blocks/login.yaml')];
    const expectations = [{ selector: { kind: 'text', value: 'Done' } as const, at }];
    expect(scrollTargets(steps, expectations)).toEqual([undefined, undefined]);
    // Scrolls at the end of the case still look to the first end expectation.
    expect(scrollTargets([block(1, 'blocks/login.yaml'), { index: 2, kind: 'scroll', direction: 'down', at }], expectations)).toEqual([undefined, expectations[0]!.selector]);
  });

  it('is followed by a screenshot named for its flow index in a run copy', () => {
    const flow = caseToFlow(mid, KEYS);
    expect(flow.steps.flatMap((step, index) => (step.kind === 'runFlow' ? [index] : []))).toEqual([1, 3]);
    const copy = instrumentForRun(flow, '../../flows');
    const runFlows = runFlowsOf(copy.steps);
    expect(runFlows.map((step) => step.file)).toEqual(['../../blocks/login.yaml', '../../blocks/login.yaml']);
    expect(runFlows[1]!.env).toMatchObject(AGENT);
    const middle = copy.steps.indexOf(runFlows[1]!);
    expect(copy.steps[middle + 1]).toEqual({ kind: 'takeScreenshot', path: runScreenshotName(3), optional: true });
  });
});

describe('Recorder.recordBlock', () => {
  function started(extra: Partial<Parameters<Recorder['start']>[0]> = {}): Recorder {
    const recorder = new Recorder({ now: fixedNow });
    recorder.start({ id: caseId, name: 'Two users', appId: 'com.example.claims', deviceId: 'emulator-5556', ...extra });
    return recorder;
  }

  it('records the block with its screenshot and the time', () => {
    const recorder = started();
    expect(recorder.recordBlock('blocks/login.yaml', `evidence/${caseId}/step-001.png`)).toStrictEqual({
      index: 1,
      kind: 'block',
      file: 'blocks/login.yaml',
      screenshot: `evidence/${caseId}/step-001.png`,
      at,
    });
  });

  it('records the values it was given', () => {
    const recorder = started();
    expect(recorder.recordBlock('blocks/login.yaml', undefined, AGENT)).toStrictEqual({ index: 1, kind: 'block', file: 'blocks/login.yaml', values: AGENT, at });
  });

  it('leaves out values and screenshot when it has none', () => {
    const step = started().recordBlock('blocks/login.yaml');
    expect(Object.keys(step).sort()).toEqual(['at', 'file', 'index', 'kind']);
  });

  it('keeps its own copy of the values', () => {
    const recorder = started();
    const values = { ...AGENT };
    recorder.recordBlock('blocks/login.yaml', undefined, values);
    values.USERNAME = 'changed';
    expect((recorder.toCase().steps[0] as { values?: Record<string, string> }).values).toEqual(AGENT);
  });

  it('numbers steps in order among the other kinds', () => {
    const recorder = started();
    recorder.recordBack();
    recorder.recordBlock('blocks/login.yaml');
    recorder.recordScroll('down');
    expect(recorder.toCase().steps.map((step) => [step.index, step.kind])).toEqual([
      [1, 'back'],
      [2, 'block'],
      [3, 'scroll'],
    ]);
  });

  it('uses up an evidence number, with or without a screenshot', () => {
    const recorder = started();
    recorder.recordBlock('blocks/login.yaml', `evidence/${caseId}/step-001.png`);
    expect(recorder.evidenceNumberForNext('tap')).toBe(2);
    recorder.recordBlock('blocks/login.yaml');
    expect(recorder.evidenceNumberForNext('tap')).toBe(3);
    expect(recorder.toCase().lastEvidenceNumber).toBe(2);
  });

  it('never merges typing across a block', () => {
    const recorder = started();
    recorder.recordInput('ab', `evidence/${caseId}/step-001.png`);
    recorder.recordBlock('blocks/login.yaml', `evidence/${caseId}/step-002.png`);
    expect(recorder.evidenceNumberForNext('type', 'cd')).toBe(3);
    recorder.recordInput('cd', `evidence/${caseId}/step-003.png`);
    const steps = recorder.toCase().steps;
    expect(steps.map((step) => step.kind)).toEqual(['type', 'block', 'type']);
    expect(steps[0]).toMatchObject({ text: 'ab' });
    expect(steps[2]).toMatchObject({ text: 'cd' });
  });

  it('refuses to record without an active case', () => {
    expect(() => new Recorder({ now: fixedNow }).recordBlock('blocks/login.yaml')).toThrow(/No case is being recorded/);
  });

  it('builds a flow with the runFlow in place and the project env keys passed through', () => {
    const recorder = started({ envKeys: KEYS });
    recorder.recordTap(undefined, { x: 100, y: 200 }, { width: 1000, height: 2000 }, undefined, []);
    recorder.recordBlock('blocks/login.yaml', undefined, AGENT);
    expect(recorder.toFlow().steps).toEqual([
      { kind: 'launchApp' },
      { kind: 'tapOn', selector: { kind: 'point', xPercent: 10, yPercent: 10 } },
      { kind: 'runFlow', file: '../blocks/login.yaml', env: { ...PASS_THROUGH, ...AGENT } },
    ]);
  });

  it('builds the same flow as the saved case would', () => {
    const recorder = started({ envKeys: KEYS, preconditionBlocks: [{ file: 'blocks/login.yaml', values: SUPERVISOR }] });
    recorder.recordBlock('blocks/login.yaml', undefined, AGENT);
    expect(recorder.toFlow()).toEqual(caseToFlow(recorder.toCase(), KEYS));
  });

  it('keeps block uses and values it starts with, as its own copies', () => {
    const preconditionBlocks = [{ file: 'blocks/login.yaml', values: { ...SUPERVISOR } }];
    const recorder = started({ preconditionBlocks });
    preconditionBlocks[0]!.values.USERNAME = 'changed';
    const saved = recorder.toCase();
    expect(saved.preconditionBlocks).toEqual([{ file: 'blocks/login.yaml', values: SUPERVISOR }]);
    saved.preconditionBlocks[0]!.values!.USERNAME = 'changed again';
    expect(recorder.toCase().preconditionBlocks).toEqual([{ file: 'blocks/login.yaml', values: SUPERVISOR }]);
  });

  it('resumes with block steps already in the case, renumbered and unshared', () => {
    const kept: CaseStep[] = [tap(5, 'Claims'), block(6, 'blocks/login.yaml', AGENT, { screenshot: `evidence/${caseId}/step-006.png` })];
    const recorder = started({ steps: kept, evidenceFloor: 6 });
    recorder.recordBlock('blocks/login.yaml', undefined, SUPERVISOR);
    const steps = recorder.toCase().steps;
    expect(steps.map((step) => step.index)).toEqual([1, 2, 3]);
    expect(steps[1]).toMatchObject({ kind: 'block', values: AGENT, screenshot: `evidence/${caseId}/step-006.png` });
    (steps[1] as { values: Record<string, string> }).values.USERNAME = 'changed';
    expect((kept[1] as { values: Record<string, string> }).values.USERNAME).toBe(AGENT.USERNAME);
    expect(recorder.evidenceNumberForNext('tap')).toBe(8);
  });

  it('drops the blocks of a case that starts from another but keeps block steps', () => {
    const recorder = started({ startFrom: 'parent-20261101-1000', preconditionBlocks: [{ file: 'blocks/login.yaml', values: AGENT }] });
    recorder.recordBlock('blocks/login.yaml', undefined, AGENT);
    const saved = recorder.toCase();
    expect(saved.preconditionBlocks).toEqual([]);
    expect(saved.steps).toHaveLength(1);
  });
});

describe('describing a block with values', () => {
  it('describeStep names the file and, when there are values, who or what they are', () => {
    expect(describeStep(block(1, 'blocks/login.yaml'))).toBe('Run the block blocks/login.yaml');
    expect(describeStep(block(1, 'blocks/login.yaml', {}))).toBe('Run the block blocks/login.yaml');
    expect(describeStep(block(1, 'blocks/login.yaml', SUPERVISOR))).toBe('Run the block blocks/login.yaml as Supervisor');
    expect(describeStep(block(1, 'blocks/login.yaml', AGENT))).toBe('Run the block blocks/login.yaml as Agent Maria');
    expect(describeStep(block(1, 'blocks/search.yaml', { USERNAME: '${AGENT_USERNAME}', COUNTRY: 'GR' }))).toBe(
      'Run the block blocks/search.yaml with USERNAME from AGENT_USERNAME, COUNTRY "GR"',
    );
  });

  it('stepTitle prefers the BA title and ignores a blank one', () => {
    expect(stepTitle(block(1, 'blocks/login.yaml', AGENT, { title: 'Switch to Maria' }))).toBe('Switch to Maria');
    expect(stepTitle(block(1, 'blocks/login.yaml', AGENT, { title: '   ' }))).toBe('Run the block blocks/login.yaml as Agent Maria');
  });

  it('describeFlowItem adds the values to a block before the case', () => {
    const names = { blockName: (file: string) => (file === 'blocks/login.yaml' ? 'Log in' : undefined) };
    expect(describeFlowItem({ kind: 'block', file: 'blocks/login.yaml', values: SUPERVISOR }, 'a', names)).toBe('Run the block "Log in" (blocks/login.yaml) as Supervisor');
    expect(describeFlowItem({ kind: 'block', file: 'blocks/login.yaml', values: SUPERVISOR }, 'a')).toBe('Run the block blocks/login.yaml as Supervisor');
    expect(describeFlowItem({ kind: 'block', file: 'blocks/other.yaml', values: { COUNTRY: 'GR' } }, 'a', names)).toBe('Run the block blocks/other.yaml with COUNTRY "GR"');
    expect(describeFlowItem({ kind: 'block', file: 'blocks/login.yaml', values: {} }, 'a', names)).toBe('Run the block "Log in" (blocks/login.yaml)');
  });

  it('describeFlowItem reads a block step without a title like a block before the case', () => {
    const names = { blockName: (file: string) => (file === 'blocks/login.yaml' ? 'Log in' : undefined) };
    const step = block(2, 'blocks/login.yaml', AGENT);
    expect(describeFlowItem({ kind: 'step', step }, 'a', names)).toBe('Run the block "Log in" (blocks/login.yaml) as Agent Maria');
    expect(describeFlowItem({ kind: 'step', step }, 'a')).toBe('Run the block blocks/login.yaml as Agent Maria');
    expect(describeFlowItem({ kind: 'step', step: block(2, 'blocks/login.yaml') }, 'a', names)).toBe('Run the block "Log in" (blocks/login.yaml)');
  });

  it('describeFlowItem uses the title of a block step when the BA gave one', () => {
    const names = { blockName: () => 'Log in' };
    expect(describeFlowItem({ kind: 'step', step: block(2, 'blocks/login.yaml', AGENT, { title: 'Switch to Maria' }) }, 'a', names)).toBe('Switch to Maria');
    expect(describeFlowItem({ kind: 'step', step: block(2, 'blocks/login.yaml', AGENT, { title: '  ' }) }, 'a', names)).toBe(
      'Run the block "Log in" (blocks/login.yaml) as Agent Maria',
    );
  });
});

describe('caseFlowItems with block values', () => {
  it('carries the values of a block before the case, and no values key without them', () => {
    const items = caseFlowItems(testCase({ preconditionBlocks: [{ file: 'blocks/a.yaml', values: SUPERVISOR }, { file: 'blocks/b.yaml' }] }));
    expect(items[1]).toStrictEqual({ kind: 'block', file: 'blocks/a.yaml', values: SUPERVISOR });
    expect(items[2]).toStrictEqual({ kind: 'block', file: 'blocks/b.yaml' });
  });

  it('lists a block step as a step item, in place', () => {
    const items = caseFlowItems(testCase({ steps: [tap(1, 'Claims'), block(2, 'blocks/a.yaml', AGENT)], expectations: [{ selector: { kind: 'text', value: 'Done' }, at }] }));
    expect(items.map((item) => (item.kind === 'step' ? `step:${item.step.kind}` : item.kind))).toEqual(['launch', 'step:tap', 'step:block', 'expectation']);
  });
});

describe('a case document with a block in the middle', () => {
  const doc = testCase({
    preconditionBlocks: [{ file: 'blocks/login.yaml', values: SUPERVISOR }],
    steps: [tap(1, 'Claims'), block(2, 'blocks/login.yaml', AGENT, { screenshot: `evidence/${caseId}/step-002.png` }), tap(3, 'Inbox')],
  });
  const names = { blockName: (file: string) => (file === 'blocks/login.yaml' ? 'Log in' : undefined) };

  function failingAt(flowIndex: number): RunSummary {
    const steps: StepResult[] = [];
    for (let i = 0; i < flowIndex; i++) steps.push({ flowIndex: i, status: 'passed' });
    steps.push({ flowIndex, status: 'failed', error: 'Element not found' });
    return {
      runId: `${caseId}-20261102-100000`,
      caseId,
      flowFile: `flows/${caseId}.yaml`,
      startedAt: '2026-11-02T10:00:00.000Z',
      finishedAt: '2026-11-02T10:01:00.000Z',
      exitCode: 1,
      passed: false,
      outputFile: 'runs/x/output.txt',
      steps,
    };
  }

  it('lists only the blocks before the case as preconditions, with their values', () => {
    expect(caseDocument(doc, names).preconditions).toEqual(['Start com.example.claims', 'Run the block "Log in" (blocks/login.yaml) as Supervisor']);
  });

  it('numbers the block step among the steps, with its screenshot and values', () => {
    const steps = caseDocument(doc, names).steps;
    expect(steps).toHaveLength(3);
    expect(steps[1]).toMatchObject({ number: 2, screenshot: `evidence/${caseId}/step-002.png` });
    expect(steps[1]!.action).toContain('blocks/login.yaml');
    expect(steps[1]!.action).toContain('as Agent Maria');
  });

  it('blames the block step by its flow index when the last run failed there', () => {
    // Flow: 0 launch, 1 block before the case, 2 tap, 3 the block step, 4 tap.
    expect(caseDocument(doc, names, failingAt(3)).lastRun?.failedAt).toBe('Run the block "Log in" (blocks/login.yaml) as Agent Maria');
    expect(caseDocument(doc, names, failingAt(1)).lastRun?.failedAt).toBe('Run the block "Log in" (blocks/login.yaml) as Supervisor');
    expect(caseDocument(doc, names, failingAt(4)).lastRun?.failedAt).toBe('Tap "Inbox"');
  });
});

// Maestro lists a runFlow, then the commands inside it one level deeper. Only
// the runFlow is a command of the case flow, so a block in the middle must not
// move the results of the steps after it.
describe('run results for a block in the middle', () => {
  const flowCase = testCase({
    preconditionBlocks: [{ file: 'blocks/login.yaml', values: SUPERVISOR }],
    steps: [tap(1, 'Claims'), block(2, 'blocks/login.yaml', AGENT), tap(3, 'Inbox')],
  });
  const flow = caseToFlow(flowCase, KEYS);

  let sequence = 0;
  function entry(name: string, depth: number, status: string, error?: string) {
    return {
      command: { [name]: {} },
      metadata: { status, sequenceNumber: sequence++, depth, duration: 10, ...(error ? { error: { message: error } } : {}) },
    };
  }

  /** What Maestro writes for a block: the runFlow, then its own setup and commands one level down. */
  function blockEntries(failure?: string) {
    return [
      entry('runFlowCommand', 0, failure ? 'FAILED' : 'COMPLETED'),
      entry('applyConfigurationCommand', 1, 'COMPLETED'),
      entry('launchAppCommand', 1, 'COMPLETED'),
      entry('inputTextCommand', 1, failure ? 'FAILED' : 'COMPLETED', failure),
    ];
  }

  function commandsJson(failureInMiddleBlock?: string) {
    sequence = 0;
    const head = [entry('defineVariablesCommand', 0, 'COMPLETED'), entry('applyConfigurationCommand', 0, 'COMPLETED'), entry('launchAppCommand', 0, 'COMPLETED')];
    const first = blockEntries();
    const claims = [entry('tapOnElement', 0, 'COMPLETED')];
    const middle = blockEntries(failureInMiddleBlock);
    const inbox = failureInMiddleBlock ? [] : [entry('tapOnElement', 0, 'COMPLETED')];
    return [...head, ...first, ...claims, ...middle, ...inbox];
  }

  it('lines the commands up with the flow when the block passes', () => {
    expect(flow.steps.map((step) => step.kind)).toEqual(['launchApp', 'runFlow', 'tapOn', 'runFlow', 'tapOn']);
    const results = correlateRun(flow, parseMaestroRun(commandsJson()));
    expect(results.map((result) => [result.flowIndex, result.status])).toEqual([
      [0, 'passed'],
      [1, 'passed'],
      [2, 'passed'],
      [3, 'passed'],
      [4, 'passed'],
    ]);
    expect(results.every((result) => result.warning === undefined)).toBe(true);
  });

  it('blames the block step, with the error from inside it, and leaves the later steps not run', () => {
    const results = correlateRun(flow, parseMaestroRun(commandsJson('Element not found: Text matching regex: Password')));
    expect(results.map((result) => result.status)).toEqual(['passed', 'passed', 'passed', 'failed', 'not-run']);
    expect(results[3]).toMatchObject({ flowIndex: 3, error: 'Element not found: Text matching regex: Password' });
    // Flow index 3 is the block step, so a report names it.
    const item = caseFlowItems(flowCase)[3]!;
    expect(describeFlowItem(item, flowCase.appId, { blockName: () => 'Log in' })).toBe('Run the block "Log in" (blocks/login.yaml) as Agent Maria');
  });
});
