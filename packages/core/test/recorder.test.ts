import { describe, expect, it } from 'vitest';
import { toMaestroYaml } from '../src/maestro/emit.ts';
import type { CaseStep, TestCase } from '../src/recorder/case-types.ts';
import { caseToFlow, evidenceNumber, focusedPasswordField, isEnvPlaceholder, Recorder } from '../src/recorder/recorder.ts';
import { byLabel, settingsHome, viewport } from './fixtures.ts';

const fixedNow = () => new Date('2026-10-30T17:12:05.000Z');

function started(extra: Partial<Parameters<Recorder['start']>[0]> = {}): Recorder {
  const recorder = new Recorder({ now: fixedNow });
  recorder.start({
    id: 'open-network-20261030-1712',
    name: 'Open network',
    appId: 'com.android.settings',
    deviceId: 'emulator-5556',
    ...extra,
  });
  return recorder;
}

describe('Recorder', () => {
  it('records taps with selectors, node details and screenshots', () => {
    const recorder = started();
    const nodes = settingsHome();
    const title = byLabel(nodes, 'Network & internet');
    const step = recorder.recordTap(title, { x: 428, y: 698 }, viewport, 'evidence/x/step-001.png', nodes);
    expect(step).toEqual({
      index: 1,
      kind: 'tap',
      selector: { kind: 'text', value: 'Network & internet' },
      point: { x: 428, y: 698 },
      node: { label: 'Network & internet', identifier: 'android:id/title', rect: title.rect },
      screenshot: 'evidence/x/step-001.png',
      at: '2026-10-30T17:12:05.000Z',
    });
  });

  it('merges consecutive typing into one step until a tap or back', () => {
    const recorder = started();
    expect(recorder.evidenceNumberForNext('type')).toBe(1);
    recorder.recordInput('hel', 'evidence/x/step-001.png');
    expect(recorder.evidenceNumberForNext('type')).toBe(1);
    recorder.recordInput('lo', 'evidence/x/step-001.png');
    recorder.recordTap(undefined, { x: 540, y: 1200 }, viewport, undefined, []);
    recorder.recordInput('again');
    recorder.recordBack();
    recorder.recordInput('more');
    const steps = recorder.toCase().steps;
    expect(steps.map((step) => step.kind)).toEqual(['type', 'tap', 'type', 'back', 'type']);
    expect(steps[0]).toMatchObject({ index: 1, text: 'hello' });
    expect(steps.map((step) => step.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it('produces a flow that starts with a plain launchApp when there are no blocks', () => {
    const recorder = started();
    const nodes = settingsHome();
    recorder.recordTap(byLabel(nodes, 'Network & internet'), { x: 428, y: 698 }, viewport, undefined, nodes);
    recorder.recordBack();
    recorder.recordInput('wifi');
    expect(toMaestroYaml(recorder.toFlow())).toBe(
      [
        'appId: com.android.settings',
        'name: Open network',
        '---',
        '- launchApp',
        '- tapOn:',
        '    text: "Network & internet"',
        '- back',
        '- inputText: "wifi"',
        '',
      ].join('\n'),
    );
  });

  it('starts with a plain launchApp even with blocks, and passes env keys to each runFlow', () => {
    const recorder = started({ preconditionBlocks: [{ file: 'blocks/login.yaml' }, { file: 'blocks/onboarding.yaml' }], envKeys: ['PASSWORD', 'USERNAME'] });
    const nodes = settingsHome();
    const connected = byLabel(nodes, 'Connected devices');
    recorder.addExpectation({ selector: { kind: 'text', value: 'Connected devices' }, node: { label: connected.label! } });
    const env = { PASSWORD: '${PASSWORD}', USERNAME: '${USERNAME}' };
    expect(recorder.toFlow().steps).toEqual([
      { kind: 'launchApp' },
      { kind: 'runFlow', file: '../blocks/login.yaml', env },
      { kind: 'runFlow', file: '../blocks/onboarding.yaml', env },
      { kind: 'assertVisible', selector: { kind: 'text', value: 'Connected devices' } },
    ]);
    expect(toMaestroYaml(recorder.toFlow())).not.toContain('clearState');
    expect(recorder.toCase().expectations).toEqual([
      { selector: { kind: 'text', value: 'Connected devices' }, node: { label: 'Connected devices' }, at: '2026-10-30T17:12:05.000Z' },
    ]);
  });

  it('records an inline expect step that becomes assertVisible at its position', () => {
    const recorder = started();
    const nodes = settingsHome();
    const title = byLabel(nodes, 'Network & internet');
    recorder.recordTap(byLabel(nodes, 'Connected devices'), { x: 428, y: 900 }, viewport, undefined, nodes);
    const step = recorder.recordExpect(title, { x: 300, y: 690 }, viewport, 'evidence/x/step-002.png', nodes);
    expect(step).toEqual({
      index: 2,
      kind: 'expect',
      selector: { kind: 'text', value: 'Network & internet' },
      point: { x: 300, y: 690 },
      node: { label: 'Network & internet', identifier: 'android:id/title', rect: title.rect },
      screenshot: 'evidence/x/step-002.png',
      at: '2026-10-30T17:12:05.000Z',
    });
    recorder.recordBack();
    recorder.addExpectation({ selector: { kind: 'text', value: 'Search Settings' } });
    expect(recorder.toFlow().steps.map((flowStep) => flowStep.kind)).toEqual(['launchApp', 'tapOn', 'assertVisible', 'back', 'assertVisible']);
    expect(recorder.toFlow().steps[2]).toEqual({ kind: 'assertVisible', selector: { kind: 'text', value: 'Network & internet' } });
  });

  it('keeps a ${KEY} placeholder as a step of its own', () => {
    expect(isEnvPlaceholder('${PASSWORD}')).toBe(true);
    expect(isEnvPlaceholder('pass ${PASSWORD}')).toBe(false);
    expect(isEnvPlaceholder('${1X}')).toBe(false);
    const recorder = started();
    recorder.recordInput('user@');
    recorder.recordInput('example.com');
    expect(recorder.evidenceNumberForNext('type', '${PASSWORD}')).toBe(2);
    recorder.recordInput('${PASSWORD}');
    expect(recorder.evidenceNumberForNext('type', 'x')).toBe(3);
    expect(recorder.evidenceNumberForNext('type')).toBe(3);
    recorder.recordInput('more');
    recorder.recordInput('${USERNAME}');
    const steps = recorder.toCase().steps;
    expect(steps.map((step) => (step.kind === 'type' ? step.text : step.kind))).toEqual([
      'user@example.com',
      '${PASSWORD}',
      'more',
      '${USERNAME}',
    ]);
    expect(toMaestroYaml(recorder.toFlow())).toContain('- inputText: "${PASSWORD}"\n');
  });

  it('records scrolls as Maestro scroll (down) and swipe DOWN (up)', () => {
    const recorder = started();
    const down = recorder.recordScroll('down', 'evidence/x/step-001.png');
    expect(down).toEqual({ index: 1, kind: 'scroll', direction: 'down', screenshot: 'evidence/x/step-001.png', at: '2026-10-30T17:12:05.000Z' });
    recorder.recordScroll('up');
    expect(toMaestroYaml(recorder.toFlow())).toBe(
      [
        'appId: com.android.settings',
        'name: Open network',
        '---',
        '- launchApp',
        '- scroll',
        '- swipe:',
        '    direction: DOWN',
        '',
      ].join('\n'),
    );
  });

  describe('scrolls towards a target become scrollUntilVisible', () => {
    const nodes = settingsHome();
    const storage = byLabel(nodes, 'Storage (64 GB)');
    const storageSelector = { kind: 'text', value: 'Storage \\(64 GB\\)' } as const;

    it('scroll then tap gives scrollUntilVisible DOWN with the tap selector', () => {
      const recorder = started();
      recorder.recordScroll('down');
      recorder.recordTap(storage, { x: 400, y: 1100 }, viewport, undefined, nodes);
      expect(recorder.toFlow().steps).toEqual([
        { kind: 'launchApp' },
        { kind: 'scrollUntilVisible', selector: storageSelector, direction: 'DOWN' },
        { kind: 'tapOn', selector: storageSelector },
      ]);
    });

    it('scroll up then expect gives UP', () => {
      const recorder = started();
      recorder.recordScroll('up');
      recorder.recordExpect(storage, { x: 400, y: 1100 }, viewport, undefined, nodes);
      expect(recorder.toFlow().steps.slice(1)).toEqual([
        { kind: 'scrollUntilVisible', selector: storageSelector, direction: 'UP' },
        { kind: 'assertVisible', selector: storageSelector },
      ]);
    });

    it('two scrolls then an end expectation give two scrollUntilVisible with its selector', () => {
      const recorder = started();
      recorder.recordScroll('down');
      recorder.recordScroll('down');
      recorder.addExpectation({ selector: { kind: 'id', value: 'com\\.app:id/footer' } });
      const footer = { kind: 'id', value: 'com\\.app:id/footer' } as const;
      expect(recorder.toFlow().steps.slice(1)).toEqual([
        { kind: 'scrollUntilVisible', selector: footer, direction: 'DOWN' },
        { kind: 'scrollUntilVisible', selector: footer, direction: 'DOWN' },
        { kind: 'assertVisible', selector: footer },
      ]);
    });

    it('scroll then back stays a plain scroll', () => {
      const recorder = started();
      recorder.recordScroll('down');
      recorder.recordBack();
      recorder.recordTap(storage, { x: 400, y: 1100 }, viewport, undefined, nodes);
      expect(recorder.toFlow().steps.slice(1, 3)).toEqual([{ kind: 'scroll' }, { kind: 'back' }]);
    });

    it('scroll then a point tap stays a plain scroll, and so do scrolls the other way or typing', () => {
      const recorder = started();
      recorder.recordScroll('down');
      recorder.recordTap(undefined, { x: 540, y: 1200 }, viewport, undefined, []);
      recorder.recordScroll('down');
      recorder.recordScroll('up');
      recorder.recordTap(storage, { x: 400, y: 1100 }, viewport, undefined, nodes);
      recorder.recordScroll('up');
      recorder.recordInput('wifi');
      expect(recorder.toFlow().steps.slice(1).map((step) => step.kind)).toEqual([
        'scroll',
        'tapOn',
        'scroll',
        'scrollUntilVisible',
        'tapOn',
        'swipe',
        'inputText',
      ]);
      expect(recorder.toFlow().steps[4]).toEqual({ kind: 'scrollUntilVisible', selector: storageSelector, direction: 'UP' });
    });
  });

  it('builds the same flow from a saved case as from the recorder', () => {
    const recorder = started({ preconditionBlocks: [{ file: 'blocks/open-settings.yaml' }] });
    recorder.recordScroll('down');
    recorder.recordBack();
    expect(caseToFlow(recorder.toCase())).toEqual(recorder.toFlow());
    expect(caseToFlow(recorder.toCase()).steps[1]).toEqual({ kind: 'runFlow', file: '../blocks/open-settings.yaml' });
  });

  it('refuses to record without an active case', () => {
    const recorder = new Recorder();
    expect(() => recorder.recordBack()).toThrow(/No case/);
  });

  it('detects a focused password field', () => {
    expect(focusedPasswordField([{ focused: true, password: true }])).toBe(true);
    expect(focusedPasswordField([{ focused: true, password: false }, { password: true }])).toBe(false);
  });
});

const at = '2026-10-30T17:00:00.000Z';

function shot(n: number): string {
  return `evidence/open-network-20261030-1712/step-${String(n).padStart(3, '0')}.png`;
}

describe('evidenceNumber', () => {
  it('reads the number of a step screenshot and nothing else', () => {
    expect(evidenceNumber('evidence/x/step-007.png')).toBe(7);
    expect(evidenceNumber('evidence/x/step-1234.png')).toBe(1234);
    expect(evidenceNumber(undefined)).toBeUndefined();
    expect(evidenceNumber('')).toBeUndefined();
    expect(evidenceNumber('evidence/x/capture.png')).toBeUndefined();
    expect(evidenceNumber('evidence/x/step-007.png.tmp')).toBeUndefined();
  });
});

describe('Recorder resuming a case', () => {
  const resumed = (): CaseStep[] => [
    { index: 4, kind: 'back', screenshot: shot(1), at },
    { index: 9, kind: 'tap', selector: { kind: 'text', value: 'System' }, point: { x: 5, y: 6 }, screenshot: shot(7), at },
  ];

  it('renumbers resumed steps from 1 and keeps their screenshots, without sharing objects', () => {
    const steps = resumed();
    const recorder = started({ steps });
    expect(recorder.stepCount).toBe(2);
    const kept = recorder.toCase().steps;
    expect(kept.map((step) => [step.index, step.screenshot])).toEqual([
      [1, shot(1)],
      [2, shot(7)],
    ]);
    steps[0]!.screenshot = 'changed';
    expect(recorder.toCase().steps[0]!.screenshot).toBe(shot(1));
    expect(steps[1]!.index).toBe(9);
    recorder.recordBack();
    expect(recorder.toCase().steps.map((step) => step.index)).toEqual([1, 2, 3]);
  });

  it('continues evidence numbers above the highest kept number', () => {
    const recorder = started({ steps: resumed() });
    expect(recorder.evidenceNumberForNext('tap')).toBe(8);
    recorder.recordBack(shot(8));
    expect(recorder.evidenceNumberForNext('back')).toBe(9);
  });

  it('continues above evidenceFloor when steps being replaced used higher numbers', () => {
    const recorder = started({ steps: resumed(), evidenceFloor: 12 });
    expect(recorder.evidenceNumberForNext('scroll')).toBe(13);
    expect(started({ evidenceFloor: 4 }).evidenceNumberForNext('tap')).toBe(5);
    // A floor below what the kept steps use changes nothing.
    expect(started({ steps: resumed(), evidenceFloor: 3 }).evidenceNumberForNext('tap')).toBe(8);
  });

  it('counts kept steps without screenshots', () => {
    const recorder = started({
      steps: [
        { index: 1, kind: 'back', at },
        { index: 2, kind: 'back', at },
        { index: 3, kind: 'back', at },
      ],
    });
    expect(recorder.evidenceNumberForNext('tap')).toBe(4);
  });

  it('merges typing after a resume into the new step and reuses its number', () => {
    const recorder = started({ steps: resumed(), evidenceFloor: 10 });
    expect(recorder.evidenceNumberForNext('type', 'user@')).toBe(11);
    recorder.recordInput('user@', shot(11));
    expect(recorder.evidenceNumberForNext('type', 'example.com')).toBe(11);
    expect(recorder.evidenceNumberForNext('type', '${PASSWORD}')).toBe(12);
    expect(recorder.evidenceNumberForNext('tap')).toBe(12);
    recorder.recordInput('example.com', shot(11));
    expect(recorder.stepCount).toBe(3);
    expect(recorder.toCase().steps[2]).toMatchObject({ index: 3, kind: 'type', text: 'user@example.com', screenshot: shot(11) });
    expect(recorder.evidenceNumberForNext('back')).toBe(12);
  });

  // Typing right after a resume is a new step: the kept step stays as saved, and
  // its screenshot (at or below evidenceFloor) is never captured over, so
  // Discard can restore the case.
  it('never merges new typing into a kept step or reuses a number at or below evidenceFloor', () => {
    const recorder = started({ steps: [{ index: 1, kind: 'type', text: 'user@', screenshot: shot(1), at }], evidenceFloor: 1 });
    expect(recorder.evidenceNumberForNext('type', 'example.com')).toBe(2);
    recorder.recordInput('example.com', shot(2));
    recorder.recordInput('.gr', shot(2));
    const steps = recorder.toCase().steps;
    expect(steps.map((step) => (step.kind === 'type' ? step.text : step.kind))).toEqual(['user@', 'example.com.gr']);
    expect(steps[0]).toMatchObject({ screenshot: shot(1) });
  });

  it('never merges into a resumed placeholder', () => {
    const recorder = started({ steps: [{ index: 1, kind: 'type', text: '${PASSWORD}', screenshot: shot(1), at }] });
    expect(recorder.evidenceNumberForNext('type', 'more')).toBe(2);
    recorder.recordInput('more', shot(2));
    expect(recorder.toCase().steps.map((step) => (step.kind === 'type' ? step.text : step.kind))).toEqual(['${PASSWORD}', 'more']);
  });

  it('never reuses a number, even for steps recorded without a screenshot', () => {
    const recorder = started();
    const used: number[] = [];
    const take = (kind: Parameters<Recorder['evidenceNumberForNext']>[0]) => {
      const n = recorder.evidenceNumberForNext(kind);
      used.push(n);
      return n;
    };
    recorder.recordBack(shot(take('back')));
    take('scroll');
    recorder.recordScroll('down'); // capture failed: no screenshot, number still used up
    recorder.recordInput('abc', shot(take('type')));
    // Merged typing overwrites its own step's screenshot, so the number repeats for the same step only.
    expect(recorder.evidenceNumberForNext('type', 'def')).toBe(3);
    recorder.recordInput('def', shot(3));
    recorder.recordHideKeyboard(shot(take('hideKeyboard')));
    recorder.recordRelaunch(shot(take('relaunch')));
    expect(used).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(recorder.toCase().steps.map((step) => step.screenshot).filter(Boolean)).size).toBe(4);
  });

  it('keeps counting above a screenshot number higher than expected', () => {
    const recorder = started();
    recorder.recordBack(shot(20));
    expect(recorder.evidenceNumberForNext('back')).toBe(21);
  });
});

describe('Recorder interactions and case fields', () => {
  it('records relaunch, open link and hide keyboard as steps of their own', () => {
    const recorder = started();
    expect(recorder.recordRelaunch(shot(1))).toEqual({ index: 1, kind: 'relaunch', screenshot: shot(1), at: '2026-10-30T17:12:05.000Z' });
    expect(recorder.recordOpenLink('myapp://claims/7')).toEqual({ index: 2, kind: 'openLink', url: 'myapp://claims/7', at: '2026-10-30T17:12:05.000Z' });
    expect(recorder.recordHideKeyboard(shot(3))).toEqual({ index: 3, kind: 'hideKeyboard', screenshot: shot(3), at: '2026-10-30T17:12:05.000Z' });
    expect(recorder.toFlow().steps).toEqual([
      { kind: 'launchApp' },
      { kind: 'launchApp' },
      { kind: 'openLink', link: 'myapp://claims/7' },
      { kind: 'hideKeyboard' },
    ]);
    expect(toMaestroYaml(recorder.toFlow())).toContain('- launchApp\n- launchApp\n- openLink: "myapp://claims/7"\n- hideKeyboard\n');
  });

  it('refuses the new interactions without an active case', () => {
    const recorder = new Recorder();
    expect(() => recorder.recordRelaunch()).toThrow(/No case/);
    expect(() => recorder.recordOpenLink('https://example.com')).toThrow(/No case/);
    expect(() => recorder.recordHideKeyboard()).toThrow(/No case/);
    expect(() => recorder.clearExpectations()).toThrow(/No case/);
  });

  it('clears end expectations and keeps the ones it resumed with otherwise', () => {
    const expectations = [{ selector: { kind: 'text', value: 'Wi-Fi' } as const, at }];
    const recorder = started({ expectations });
    expect(recorder.toCase().expectations).toEqual(expectations);
    recorder.addExpectation({ selector: { kind: 'text', value: 'Internet' } });
    expect(recorder.toCase().expectations).toHaveLength(2);
    recorder.clearExpectations();
    expect(recorder.toCase().expectations).toEqual([]);
    expect(recorder.toFlow().steps).toEqual([{ kind: 'launchApp' }]);
    recorder.addExpectation({ selector: { kind: 'text', value: 'About' } });
    expect(recorder.toCase().expectations.map((item) => item.selector)).toEqual([{ kind: 'text', value: 'About' }]);
  });

  it('carries startFrom, editedAt and muted, and drops blocks when starting from a case', () => {
    const recorder = started({
      startFrom: 'log-in-20261030-1700',
      preconditionBlocks: [{ file: 'blocks/login.yaml' }],
      editedAt: '2026-10-31T09:00:00.000Z',
      muted: true,
      createdAt: '2026-10-30T17:12:00.000Z',
    });
    expect(recorder.toCase()).toEqual({
      id: 'open-network-20261030-1712',
      name: 'Open network',
      appId: 'com.android.settings',
      createdAt: '2026-10-30T17:12:00.000Z',
      deviceId: 'emulator-5556',
      preconditionBlocks: [],
      startFrom: 'log-in-20261030-1700',
      steps: [],
      expectations: [],
      editedAt: '2026-10-31T09:00:00.000Z',
      muted: true,
    });
    const plain = started({ muted: false }).toCase();
    expect(plain).not.toHaveProperty('muted');
    expect(plain).not.toHaveProperty('startFrom');
    expect(plain).not.toHaveProperty('editedAt');
  });
});

describe('caseToFlow with a start case and the new step kinds', () => {
  const child: TestCase = {
    id: 'child-20261031-1000',
    name: 'Child',
    appId: 'com.android.settings',
    createdAt: at,
    deviceId: 'emulator-5556',
    preconditionBlocks: [],
    startFrom: 'parent-20261030-1712',
    steps: [
      { index: 1, kind: 'relaunch', at },
      { index: 2, kind: 'openLink', url: 'https://example.com/a?b=1&c=2', at },
      { index: 3, kind: 'hideKeyboard', at },
    ],
    expectations: [{ selector: { kind: 'text', value: 'Done' }, at }],
  };

  it('runs the parent flow from flows/ instead of launchApp and blocks', () => {
    expect(caseToFlow(child).steps).toEqual([
      { kind: 'runFlow', file: 'parent-20261030-1712.yaml' },
      { kind: 'launchApp' },
      { kind: 'openLink', link: 'https://example.com/a?b=1&c=2' },
      { kind: 'hideKeyboard' },
      { kind: 'assertVisible', selector: { kind: 'text', value: 'Done' } },
    ]);
  });

  it('passes env keys to the parent flow', () => {
    expect(caseToFlow(child, ['PASSWORD', 'USERNAME']).steps[0]).toEqual({
      kind: 'runFlow',
      file: 'parent-20261030-1712.yaml',
      env: { PASSWORD: '${PASSWORD}', USERNAME: '${USERNAME}' },
    });
  });

  it('ignores blocks left in a case that starts from another', () => {
    const steps = caseToFlow({ ...child, preconditionBlocks: [{ file: 'blocks/login.yaml' }] }).steps;
    expect(steps[0]).toEqual({ kind: 'runFlow', file: 'parent-20261030-1712.yaml' });
    expect(steps.filter((step) => step.kind === 'runFlow')).toHaveLength(1);
  });

  it('emits YAML Maestro reads', () => {
    expect(toMaestroYaml(caseToFlow(child, ['PASSWORD']))).toBe(
      [
        'appId: com.android.settings',
        'name: Child',
        '---',
        '- runFlow:',
        '    file: parent-20261030-1712.yaml',
        '    env:',
        '      PASSWORD: "${PASSWORD}"',
        '- launchApp',
        '- openLink: "https://example.com/a?b=1&c=2"',
        '- hideKeyboard',
        '- assertVisible:',
        '    text: "Done"',
        '',
      ].join('\n'),
    );
  });
});

describe('lastEvidenceNumber', () => {
  it('saves the highest screenshot number used, which never goes down on resume', () => {
    const fresh = started();
    fresh.recordBack(shot(1));
    fresh.recordBack(shot(2));
    expect(fresh.toCase().lastEvidenceNumber).toBe(2);

    const resumed = started({ steps: [{ index: 1, kind: 'back', screenshot: shot(1), at }], evidenceFloor: 7 });
    expect(resumed.toCase().lastEvidenceNumber).toBe(7);
    resumed.recordBack(shot(resumed.evidenceNumberForNext('back')));
    expect(resumed.toCase().lastEvidenceNumber).toBe(8);
  });

  it('is absent while nothing has been recorded', () => {
    expect(started().toCase().lastEvidenceNumber).toBeUndefined();
  });
});
