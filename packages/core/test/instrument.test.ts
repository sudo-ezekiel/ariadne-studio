import { describe, expect, it } from 'vitest';
import { toMaestroYaml } from '../src/maestro/emit.ts';
import type { MaestroFlow } from '../src/maestro/model.ts';
import { parseMaestroFlow } from '../src/maestro/parse.ts';
import { instrumentForRun, relocateFlow, RUN_SCREENSHOT_PREFIX, RUN_VIDEO_NAME, runScreenshotName } from '../src/replay/instrument.ts';

const flow: MaestroFlow = {
  appId: 'com.android.settings',
  name: 'Open network',
  env: { REGION: 'eu' },
  steps: [
    { kind: 'launchApp' },
    { kind: 'runFlow', file: '../blocks/x.yaml', env: { PASSWORD: '${PASSWORD}' } },
    { kind: 'tapOn', selector: { kind: 'text', value: 'Network & internet' } },
    { kind: 'runFlow', file: 'parent.yaml' },
    { kind: 'back' },
    { kind: 'launchApp', clearState: true },
    { kind: 'assertVisible', selector: { kind: 'text', value: 'Internet' } },
  ],
};

const shot = (path: string) => ({ kind: 'takeScreenshot', path, optional: true }) as const;

describe('runScreenshotName', () => {
  it('numbers from 1 with three digits, by flow index', () => {
    expect(runScreenshotName(0)).toBe('after-001');
    expect(runScreenshotName(41)).toBe('after-042');
    expect(runScreenshotName(999)).toBe('after-1000');
    expect(runScreenshotName(5).startsWith(RUN_SCREENSHOT_PREFIX)).toBe(true);
  });
});

describe('instrumentForRun', () => {
  it('adds an optional screenshot after every command but launchApp and rewrites runFlow paths', () => {
    expect(instrumentForRun(flow, '../../flows')).toEqual({
      appId: 'com.android.settings',
      name: 'Open network',
      env: { REGION: 'eu' },
      steps: [
        { kind: 'launchApp' },
        { kind: 'runFlow', file: '../../blocks/x.yaml', env: { PASSWORD: '${PASSWORD}' } },
        shot('after-002'),
        { kind: 'tapOn', selector: { kind: 'text', value: 'Network & internet' } },
        shot('after-003'),
        { kind: 'runFlow', file: '../../flows/parent.yaml' },
        shot('after-004'),
        { kind: 'back' },
        shot('after-005'),
        { kind: 'launchApp', clearState: true },
        { kind: 'assertVisible', selector: { kind: 'text', value: 'Internet' } },
        shot('after-007'),
      ],
    });
  });

  it('leaves the input flow unchanged', () => {
    const before = structuredClone(flow);
    instrumentForRun(flow, '../../flows');
    expect(flow).toEqual(before);
  });

  it('resolves paths for other run directory depths', () => {
    const steps = (dir: string) =>
      instrumentForRun({ appId: 'a', steps: [{ kind: 'runFlow', file: '../blocks/x.yaml' }, { kind: 'runFlow', file: 'p.yaml' }] }, dir)
        .steps.filter((step) => step.kind === 'runFlow')
        .map((step) => (step.kind === 'runFlow' ? step.file : ''));
    expect(steps('../flows')).toEqual(['../blocks/x.yaml', '../flows/p.yaml']);
    expect(steps('../../../flows')).toEqual(['../../../blocks/x.yaml', '../../../flows/p.yaml']);
    expect(steps('.')).toEqual(['../blocks/x.yaml', 'p.yaml']);
  });

  it('writes YAML that parses back to the same commands', () => {
    const instrumented = instrumentForRun(flow, '../../flows');
    const yaml = toMaestroYaml(instrumented);
    expect(yaml).toContain('- takeScreenshot:\n    path: after-002\n    optional: true\n');
    expect(yaml).toContain('    file: ../../blocks/x.yaml\n');
    expect(parseMaestroFlow(yaml)).toEqual(instrumented);
  });

  it('handles a flow with no commands and one with only launchApp', () => {
    expect(instrumentForRun({ appId: 'a', steps: [] }, '../../flows').steps).toEqual([]);
    expect(instrumentForRun({ appId: 'a', steps: [{ kind: 'launchApp' }] }, '../../flows').steps).toEqual([{ kind: 'launchApp' }]);
  });
});

describe('instrumentForRun with a run video', () => {
  it('puts an optional startRecording first and stopRecording last, with the screenshots unchanged between them', () => {
    const plain = instrumentForRun(flow, '../../flows');
    const withVideo = instrumentForRun(flow, '../../flows', { video: true });
    expect(withVideo.steps[0]).toEqual({ kind: 'startRecording', path: RUN_VIDEO_NAME, optional: true });
    expect(withVideo.steps.at(-1)).toEqual({ kind: 'stopRecording' });
    expect(withVideo.steps.slice(1, -1)).toEqual(plain.steps);
    expect({ ...withVideo, steps: [] }).toEqual({ ...plain, steps: [] });
  });

  it('is the same as before without the option, or with video false', () => {
    const plain = instrumentForRun(flow, '../../flows');
    expect(instrumentForRun(flow, '../../flows', {})).toEqual(plain);
    expect(instrumentForRun(flow, '../../flows', { video: false })).toEqual(plain);
    expect(plain.steps.some((step) => step.kind === 'startRecording' || step.kind === 'stopRecording')).toBe(false);
  });

  it('leaves the input flow unchanged', () => {
    const before = structuredClone(flow);
    instrumentForRun(flow, '../../flows', { video: true });
    expect(flow).toEqual(before);
  });

  it('still brackets an empty flow', () => {
    expect(instrumentForRun({ appId: 'a', steps: [] }, '../../flows', { video: true }).steps).toEqual([
      { kind: 'startRecording', path: RUN_VIDEO_NAME, optional: true },
      { kind: 'stopRecording' },
    ]);
  });

  it('writes YAML with the recording commands in Maestro form', () => {
    const yaml = toMaestroYaml(instrumentForRun({ appId: 'a', steps: [{ kind: 'launchApp' }] }, '../../flows', { video: true }));
    expect(yaml).toBe(['appId: a', '---', '- startRecording:', '    path: run-video', '    optional: true', '- launchApp', '- stopRecording', ''].join('\n'));
  });
});

describe('relocateFlow', () => {
  it('rewrites only runFlow files, for a flows folder outside the project', () => {
    // A case flow in repo/.maestro/recorded/, copied to repo/.ariadne/runs/_partial/.
    const relocated = relocateFlow(
      { appId: 'com.example', steps: [{ kind: 'launchApp' }, { kind: 'runFlow', file: '../subflows/login.yaml', env: { A: '${A}' } }, { kind: 'runFlow', file: 'parent.yaml' }, { kind: 'back' }] },
      '../../../.maestro/recorded',
    );
    expect(relocated.steps).toEqual([
      { kind: 'launchApp' },
      { kind: 'runFlow', file: '../../../.maestro/subflows/login.yaml', env: { A: '${A}' } },
      { kind: 'runFlow', file: '../../../.maestro/recorded/parent.yaml' },
      { kind: 'back' },
    ]);
  });
});
