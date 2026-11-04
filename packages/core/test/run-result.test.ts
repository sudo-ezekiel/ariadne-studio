import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MaestroFlow } from '../src/maestro/model.ts';
import { parseMaestroFlow } from '../src/maestro/parse.ts';
import { instrumentForRun, RUN_SCREENSHOT_PREFIX, runScreenshotName } from '../src/replay/instrument.ts';
import { correlateRun, deviceProblemIn, parseMaestroRun, redactValues, separateRunScreenshots, summarizeRun, type RunCommand } from '../src/replay/run-result.ts';

// Real commands.json files written by Maestro 2.12 with --flatten-debug-output.
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

const passingFlow = parseMaestroFlow(
  [
    'appId: com.android.settings',
    'name: Smoke settings navigation',
    '---',
    '- launchApp',
    '- tapOn:',
    '    text: "Network & internet"',
    '- tapOn:',
    '    text: "Internet"',
    '- back',
    '- tapOn:',
    '    id: "com\\\\.android\\\\.settings:id/collapsing_toolbar"',
  ].join('\n'),
);

const failingFlow: MaestroFlow = {
  appId: 'com.android.settings',
  name: 'Fail check',
  steps: [
    { kind: 'launchApp' },
    { kind: 'tapOn', selector: { kind: 'text', value: 'Network & internet' } },
    { kind: 'assertVisible', selector: { kind: 'text', value: 'This text does not exist anywhere' } },
    { kind: 'back' },
  ],
};

describe('parseMaestroRun', () => {
  it('keeps the top-level commands of a passing run, without the two setup entries', () => {
    const commands = parseMaestroRun(fixture('maestro-commands-pass.json'));
    expect(commands.map(({ sequence, name, status }) => ({ sequence, name, status }))).toEqual([
      { sequence: 2, name: 'launchAppCommand', status: 'passed' },
      { sequence: 3, name: 'tapOnElement', status: 'passed' },
      { sequence: 4, name: 'tapOnElement', status: 'passed' },
      { sequence: 5, name: 'backPressCommand', status: 'passed' },
      { sequence: 6, name: 'tapOnElement', status: 'passed' },
    ]);
    expect(commands.every((command) => command.durationMs > 0 && !command.error && !command.screenshot)).toBe(true);
  });

  it('reads the error and artifacts of a failed command; later commands are absent', () => {
    const commands = parseMaestroRun(fixture('maestro-commands-fail.json'));
    expect(commands).toHaveLength(3);
    expect(commands[2]).toEqual({
      sequence: 4,
      name: 'assertConditionCommand',
      status: 'failed',
      durationMs: 17233,
      startedAt: 1793432191413,
      error: 'Assertion is false: "This text does not exist anywhere" is visible',
      screenshot: 'screenshots/step-005-assertCondition-This_text_does_not_exist.png',
      hierarchy: 'screen-hierarchy/step-005-assertCondition-This_text_does_not_exist.json',
    });
  });

  it('fills a failed runFlow from the failed command nested inside it', () => {
    const commands = parseMaestroRun(fixture('maestro-commands-nested-fail.json'));
    expect(commands.map((command) => command.name)).toEqual(['launchAppCommand', 'runFlowCommand']);
    expect(commands[1]).toMatchObject({
      status: 'failed',
      error: 'Assertion is false: "Nope not here" is visible',
      // Its own screenshot is kept; the hierarchy only exists on the nested command.
      screenshot: 'screenshots/step-004-runFlow.png',
      hierarchy: 'screen-hierarchy/step-007-assertCondition-Nope_not_here.json',
    });
  });

  it('treats commands left running as failed and rejects anything but a list', () => {
    const commands = parseMaestroRun([
      { command: { tapOnElement: {} }, metadata: { status: 'RUNNING', sequenceNumber: 2, depth: 0 } },
      { not: 'a command' },
    ]);
    expect(commands).toEqual([{ sequence: 2, name: 'tapOnElement', status: 'failed', durationMs: 0 }]);
    expect(() => parseMaestroRun({})).toThrow(/list/);
  });
});

describe('correlateRun', () => {
  it('marks every step of a passing run as passed', () => {
    const results = correlateRun(passingFlow, parseMaestroRun(fixture('maestro-commands-pass.json')));
    expect(results.map((result) => [result.flowIndex, result.step?.kind, result.status])).toEqual([
      [0, 'launchApp', 'passed'],
      [1, 'tapOn', 'passed'],
      [2, 'tapOn', 'passed'],
      [3, 'back', 'passed'],
      [4, 'tapOn', 'passed'],
    ]);
  });

  it('marks the failed step and the ones after it as not run', () => {
    const results = correlateRun(failingFlow, parseMaestroRun(fixture('maestro-commands-fail.json')));
    expect(results.map((result) => result.status)).toEqual(['passed', 'passed', 'failed', 'not-run']);
    expect(results[2]).toMatchObject({
      step: failingFlow.steps[2],
      error: 'Assertion is false: "This text does not exist anywhere" is visible',
      screenshot: 'screenshots/step-005-assertCondition-This_text_does_not_exist.png',
    });
    expect(results[3]).toEqual({ flowIndex: 3, step: { kind: 'back' }, status: 'not-run' });
  });

  it('keeps commands beyond the flow with a warning', () => {
    const shorter: MaestroFlow = { ...passingFlow, steps: passingFlow.steps.slice(0, 3) };
    const results = correlateRun(shorter, parseMaestroRun(fixture('maestro-commands-pass.json')));
    expect(results).toHaveLength(5);
    expect(results[3]).toMatchObject({ flowIndex: 3, status: 'passed', warning: expect.stringContaining('backPressCommand') });
    expect(results[3]!.step).toBeUndefined();
  });
});

describe('summarizeRun', () => {
  const base = {
    runId: 'fail-check-20261031-0936-20261031-093630',
    caseId: 'fail-check-20261031-0936',
    flowFile: 'flows/fail-check-20261031-0936.yaml',
    startedAt: '2026-10-31T09:36:20.000Z',
    finishedAt: '2026-10-31T09:36:50.000Z',
    flow: failingFlow,
    outputFile: 'runs/fail-check-20261031-0936-20261031-093630/output.txt',
  };

  it('points at the failure screenshot inside the run directory', () => {
    const summary = summarizeRun({
      ...base,
      exitCode: 1,
      commands: parseMaestroRun(fixture('maestro-commands-fail.json')),
      flowDir: 'runs/fail-check-20261031-0936-20261031-093630/Fail check',
    });
    expect(summary.passed).toBe(false);
    expect(summary.error).toBeUndefined();
    expect(summary.failureScreenshot).toBe(
      'runs/fail-check-20261031-0936-20261031-093630/Fail check/screenshots/step-005-assertCondition-This_text_does_not_exist.png',
    );
  });

  it('explains a failed run with no command results and redacts env values from errors', () => {
    const empty = summarizeRun({ ...base, exitCode: 1, commands: undefined });
    expect(empty).toMatchObject({ passed: false, error: expect.stringContaining('no command results') });
    expect(empty.steps.every((step) => step.status === 'not-run')).toBe(true);
    const timedOut = summarizeRun({ ...base, exitCode: 1, timedOut: true, commands: [] });
    expect(timedOut.error).toMatch(/did not finish/);
    const leaky = summarizeRun({
      ...base,
      exitCode: 1,
      commands: [{ sequence: 2, name: 'launchAppCommand', status: 'failed', durationMs: 5, error: 'Could not type hunter22 into field' }],
      env: { PASSWORD: 'hunter22' },
    });
    expect(leaky.steps[0]!.error).toBe('Could not type ${PASSWORD} into field');
  });
});

describe('redactValues', () => {
  it('replaces values of four characters or more, longest first', () => {
    expect(redactValues('user ba@example.com pass s3cret! eu', { USER: 'ba@example.com', PASS: 's3cret!', REGION: 'eu' })).toBe(
      'user ${USER} pass ${PASS} eu',
    );
    expect(redactValues('abcdef', { SHORT: 'abcd', LONG: 'abcdef' })).toBe('${LONG}');
  });
});

// A real Maestro 2.12 run of: launchApp, takeScreenshot step-001, tapOn "Network & internet",
// takeScreenshot step-002, back.
const shotFlow: MaestroFlow = {
  appId: 'com.android.settings',
  name: 'Shot check',
  steps: [{ kind: 'launchApp' }, { kind: 'tapOn', selector: { kind: 'text', value: 'Network & internet' } }, { kind: 'back' }],
};

function command(sequence: number, name: string, extra: Partial<RunCommand> = {}): RunCommand {
  return { sequence, name, status: 'passed', durationMs: 10, ...extra };
}

function screenshotCommand(sequence: number, screenshotName: string, extra: Partial<RunCommand> = {}): RunCommand {
  return command(sequence, 'takeScreenshotCommand', { screenshotName, ...extra });
}

describe('screenshots in a run', () => {
  it('keeps the path of each takeScreenshot command as screenshotName', () => {
    const commands = parseMaestroRun(fixture('maestro-commands-screenshots.json'));
    expect(commands.map(({ name, screenshotName }) => [name, screenshotName])).toEqual([
      ['launchAppCommand', undefined],
      ['takeScreenshotCommand', 'step-001'],
      ['tapOnElement', undefined],
      ['takeScreenshotCommand', 'step-002'],
      ['backPressCommand', undefined],
    ]);
    // Its file is a TAKE_SCREENSHOT artifact, not a failure screenshot.
    expect(commands.every((item) => item.screenshot === undefined && item.status === 'passed')).toBe(true);
  });

  it('separates the screenshot commands and remembers which command each follows', () => {
    const { commands, shotAfter } = separateRunScreenshots(parseMaestroRun(fixture('maestro-commands-screenshots.json')), 'step-');
    expect(commands.map((item) => item.name)).toEqual(['launchAppCommand', 'tapOnElement', 'backPressCommand']);
    expect([...shotAfter]).toEqual([
      [0, 'step-001'],
      [1, 'step-002'],
    ]);
  });

  it('keeps screenshot commands with another prefix as ordinary commands', () => {
    const { commands, shotAfter } = separateRunScreenshots(parseMaestroRun(fixture('maestro-commands-screenshots.json')), RUN_SCREENSHOT_PREFIX);
    expect(commands).toHaveLength(5);
    expect(shotAfter.size).toBe(0);
  });

  it('drops a screenshot before any command, keeps nameless ones as commands, and never keeps a failed studio screenshot', () => {
    const { commands, shotAfter } = separateRunScreenshots(
      [
        screenshotCommand(2, 'after-000'),
        command(3, 'launchAppCommand'),
        command(4, 'takeScreenshotCommand'),
        command(5, 'tapOnElement'),
        screenshotCommand(6, 'after-003', { status: 'failed', error: 'could not capture' }),
      ],
      'after-',
    );
    expect(commands.map((item) => item.sequence)).toEqual([3, 4, 5]);
    expect([...shotAfter]).toEqual([[2, 'after-003']]);
  });

  it('attaches replay screenshots in summarizeRun and keeps results lined up with the clean flow', () => {
    const summary = summarizeRun({
      runId: 'shot-check-20261031-0936-20261031-093630',
      caseId: 'shot-check-20261031-0936',
      flowFile: 'flows/shot-check-20261031-0936.yaml',
      startedAt: '2026-10-31T09:36:20.000Z',
      finishedAt: '2026-10-31T09:36:50.000Z',
      exitCode: 0,
      flow: shotFlow,
      commands: parseMaestroRun(fixture('maestro-commands-screenshots.json')),
      flowDir: 'runs/shot-check-20261031-0936-20261031-093630/Shot check',
      outputFile: 'runs/shot-check-20261031-0936-20261031-093630/output.txt',
      screenshotPrefix: 'step-',
      ranFlowFile: 'runs/shot-check-20261031-0936-20261031-093630/flow.yaml',
      suiteId: 'suite-20261031-093600',
      attempt: 2,
    });
    expect(summary.passed).toBe(true);
    expect(summary.steps.map(({ flowIndex, step, status, replayScreenshot, warning }) => ({ flowIndex, kind: step?.kind, status, replayScreenshot, warning }))).toEqual([
      { flowIndex: 0, kind: 'launchApp', status: 'passed', replayScreenshot: 'runs/shot-check-20261031-0936-20261031-093630/Shot check/takeScreenshot/step-001.png', warning: undefined },
      { flowIndex: 1, kind: 'tapOn', status: 'passed', replayScreenshot: 'runs/shot-check-20261031-0936-20261031-093630/Shot check/takeScreenshot/step-002.png', warning: undefined },
      { flowIndex: 2, kind: 'back', status: 'passed', replayScreenshot: undefined, warning: undefined },
    ]);
    expect(summary).toMatchObject({
      ranFlowFile: 'runs/shot-check-20261031-0936-20261031-093630/flow.yaml',
      suiteId: 'suite-20261031-093600',
      attempt: 2,
    });
  });

  it('without the prefix the screenshot commands push results out of line', () => {
    const summary = summarizeRun({
      runId: 'r',
      caseId: 'c',
      flowFile: 'flows/c.yaml',
      startedAt: '2026-10-31T09:36:20.000Z',
      finishedAt: '2026-10-31T09:36:50.000Z',
      exitCode: 0,
      flow: shotFlow,
      commands: parseMaestroRun(fixture('maestro-commands-screenshots.json')),
      flowDir: 'runs/r/Shot check',
      outputFile: 'runs/r/output.txt',
    });
    expect(summary.steps).toHaveLength(5);
    expect(summary.steps.filter((step) => step.warning)).toHaveLength(2);
    expect(summary.steps.some((step) => step.replayScreenshot)).toBe(false);
    expect(summary).not.toHaveProperty('ranFlowFile');
    expect(summary).not.toHaveProperty('suiteId');
    expect(summary).not.toHaveProperty('attempt');
  });

  it('needs the flow directory to build a replay screenshot path', () => {
    const summary = summarizeRun({
      runId: 'r',
      caseId: 'c',
      flowFile: 'flows/c.yaml',
      startedAt: '2026-10-31T09:36:20.000Z',
      finishedAt: '2026-10-31T09:36:50.000Z',
      exitCode: 0,
      flow: shotFlow,
      commands: parseMaestroRun(fixture('maestro-commands-screenshots.json')),
      outputFile: 'runs/r/output.txt',
      screenshotPrefix: 'step-',
    });
    expect(summary.steps.map((step) => step.status)).toEqual(['passed', 'passed', 'passed']);
    expect(summary.steps.some((step) => step.replayScreenshot)).toBe(false);
  });

  it('lines up an instrumented run that failed part way, with names matching flow indexes', () => {
    const caseFlow: MaestroFlow = {
      appId: 'com.android.settings',
      name: 'Chain',
      steps: [
        { kind: 'launchApp' },
        { kind: 'runFlow', file: '../blocks/login.yaml' },
        { kind: 'tapOn', selector: { kind: 'text', value: 'Network & internet' } },
        { kind: 'launchApp' },
        { kind: 'tapOn', selector: { kind: 'text', value: 'Missing' } },
        { kind: 'back' },
      ],
    };
    const ran = instrumentForRun(caseFlow, '../../flows');
    // What Maestro reports for the instrumented flow: every command up to the failing tap.
    const shots = ran.steps.filter((step) => step.kind === 'takeScreenshot').map((step) => (step.kind === 'takeScreenshot' ? step.path : ''));
    expect(shots).toEqual(['after-002', 'after-003', 'after-005', 'after-006']);
    const commands: RunCommand[] = [
      command(2, 'launchAppCommand'),
      command(3, 'runFlowCommand'),
      screenshotCommand(9, 'after-002'),
      command(10, 'tapOnElement'),
      screenshotCommand(11, 'after-003'),
      command(12, 'launchAppCommand'),
      command(13, 'tapOnElement', { status: 'failed', error: 'Element not found: Text matching regex: Missing', screenshot: 'screenshots/step-014.png' }),
    ];
    const summary = summarizeRun({
      runId: 'r',
      caseId: 'chain',
      flowFile: 'flows/chain.yaml',
      startedAt: '2026-10-31T09:36:20.000Z',
      finishedAt: '2026-10-31T09:36:50.000Z',
      exitCode: 1,
      flow: caseFlow,
      commands,
      flowDir: 'runs/r/Chain',
      outputFile: 'runs/r/output.txt',
      screenshotPrefix: RUN_SCREENSHOT_PREFIX,
    });
    expect(summary.passed).toBe(false);
    expect(summary.steps.map((step) => step.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'failed', 'not-run']);
    expect(summary.steps.map((step) => step.step)).toEqual(caseFlow.steps);
    for (const step of summary.steps) {
      if (step.replayScreenshot) expect(step.replayScreenshot).toBe(`runs/r/Chain/takeScreenshot/${runScreenshotName(step.flowIndex)}.png`);
    }
    expect(summary.steps.map((step) => step.replayScreenshot !== undefined)).toEqual([false, true, true, false, false, false]);
    expect(summary.failureScreenshot).toBe('runs/r/Chain/screenshots/step-014.png');
    expect(summary.steps[4]!.error).toMatch(/Missing/);
  });
});

describe('run video in a run', () => {
  const caseFlow: MaestroFlow = {
    appId: 'com.android.settings',
    name: 'Chain',
    steps: [
      { kind: 'launchApp' },
      { kind: 'tapOn', selector: { kind: 'text', value: 'Network & internet' } },
      { kind: 'back' },
    ],
  };
  const base = {
    runId: 'r',
    caseId: 'chain',
    flowFile: 'flows/chain.yaml',
    startedAt: '2026-10-31T09:36:20.000Z',
    finishedAt: '2026-10-31T09:36:50.000Z',
    flow: caseFlow,
    flowDir: 'runs/r/Chain',
    outputFile: 'runs/r/output.txt',
    screenshotPrefix: RUN_SCREENSHOT_PREFIX,
  };
  const withVideo = [
    command(1, 'startRecordingCommand'),
    command(2, 'launchAppCommand'),
    command(3, 'tapOnElement'),
    screenshotCommand(4, 'after-002'),
    command(5, 'backPressCommand'),
    screenshotCommand(6, 'after-003'),
    command(7, 'stopRecordingCommand'),
  ];
  const without = withVideo.filter((item) => item.name !== 'startRecordingCommand' && item.name !== 'stopRecordingCommand');

  it('drops the top-level recording commands and keeps the screenshot positions', () => {
    const { commands, shotAfter } = separateRunScreenshots(withVideo, RUN_SCREENSHOT_PREFIX);
    expect(commands.map((item) => item.name)).toEqual(['launchAppCommand', 'tapOnElement', 'backPressCommand']);
    expect([...shotAfter]).toEqual([
      [1, 'after-002'],
      [2, 'after-003'],
    ]);
    expect(separateRunScreenshots(without, RUN_SCREENSHOT_PREFIX)).toEqual({ commands, shotAfter });
  });

  it('drops them even when no screenshots were added', () => {
    const { commands, shotAfter } = separateRunScreenshots(withVideo, 'step-');
    expect(commands.map((item) => item.name)).toEqual(['launchAppCommand', 'tapOnElement', 'takeScreenshotCommand', 'backPressCommand', 'takeScreenshotCommand']);
    expect(shotAfter.size).toBe(0);
  });

  it('lines a run with video up with the same steps as one without', () => {
    const summaryOf = (commands: RunCommand[]) => summarizeRun({ ...base, exitCode: 0, commands });
    const a = summaryOf(withVideo);
    const b = summaryOf(without);
    expect(a.passed).toBe(true);
    expect(a.steps).toEqual(b.steps);
    expect(a.steps.map((step) => step.step)).toEqual(caseFlow.steps);
    expect(a.steps.map((step) => step.replayScreenshot)).toEqual([
      undefined,
      'runs/r/Chain/takeScreenshot/after-002.png',
      'runs/r/Chain/takeScreenshot/after-003.png',
    ]);
    expect(a.steps.some((step) => step.warning)).toBe(false);
  });

  it('blames the right step when the flow failed and stopRecording never ran', () => {
    const summary = summarizeRun({
      ...base,
      exitCode: 1,
      commands: [
        command(1, 'startRecordingCommand'),
        command(2, 'launchAppCommand'),
        command(3, 'tapOnElement', { status: 'failed', error: 'Element not found', screenshot: 'screenshots/fail.png' }),
      ],
    });
    expect(summary.passed).toBe(false);
    expect(summary.steps.map((step) => step.status)).toEqual(['passed', 'failed', 'not-run']);
    expect(summary.steps[1]!.error).toBe('Element not found');
    expect(summary.failureScreenshot).toBe('runs/r/Chain/screenshots/fail.png');
    expect(summary.steps.some((step) => step.warning)).toBe(false);
  });

  it('copies video to the summary only when given', () => {
    const input = { ...base, exitCode: 0, commands: withVideo };
    expect(summarizeRun({ ...input, video: 'runs/r/video.mp4' }).video).toBe('runs/r/video.mp4');
    expect(summarizeRun(input)).not.toHaveProperty('video');
    expect(summarizeRun({ ...input, video: '' })).not.toHaveProperty('video');
  });
});

describe('device problems', () => {
  it('names a dropped connection, a dead or missing driver, and a full device', () => {
    expect(deviceProblemIn('Command failed (host:transport:emulator-5560): device offline')).toMatch(/connection to the device dropped/);
    expect(deviceProblemIn("maestro.android.DeviceServerDiedException: Device server died during 'viewHierarchy'")).toMatch(/driver on the device stopped/);
    expect(deviceProblemIn('Maestro Android driver did not start up in time on emulator')).toMatch(/did not start/);
    expect(deviceProblemIn('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]')).toMatch(/no room/);
    expect(deviceProblemIn('Assertion is false: "Nope" is visible')).toBeUndefined();
    const blocked = 'MIUILOG- Permission Denied Activity : Intent { act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] pkg=com.other.app }';
    expect(deviceProblemIn(blocked, 'com.other.app')).toMatch(/stopped Maestro from opening/);
    // Some other app being blocked says nothing about this run.
    expect(deviceProblemIn(blocked, 'com.example.tested')).toBeUndefined();
  });

  it('keeps the original four messages ending with run it again', () => {
    for (const text of [
      'Command failed (host:transport:emulator-5560): device offline',
      'Device server died during viewHierarchy',
      'Maestro Android driver did not start up in time',
      'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]',
    ]) {
      expect(deviceProblemIn(text)).toMatch(/ This is not a test failure; run it again\.$/);
    }
  });

  it('names a refused driver install, with the phone-setting advice and not run it again', () => {
    for (const text of ['Failure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]', 'adb: failed: INSTALL_CANCELED_BY_USER']) {
      const problem = deviceProblemIn(text);
      expect(problem).toMatch(/did not allow Maestro's driver to install/);
      expect(problem).toMatch(/running it again will not help/);
      expect(problem).not.toMatch(/run it again\.$/);
    }
  });

  it('names blocked simulated touches, with the phone-setting advice', () => {
    for (const text of ['java.lang.SecurityException: Injecting to another application requires INJECT_EVENTS permission', 'requires INJECT_EVENTS']) {
      const problem = deviceProblemIn(text);
      expect(problem).toMatch(/blocks simulated touches/);
      expect(problem).toMatch(/running it again will not help/);
    }
  });

  it('names a launch the phone blocked, from the MIUI line or from Maestro as the caller', () => {
    const miui =
      'D/ActivityStarterImpl( 2644): MIUILOG- Permission Denied Activity : Intent { act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] flg=0x10000000 pkg=com.android.settings cmp=com.android.settings/.MainSettings }';
    const aosp = 'W/ActivityTaskManager: Background activity launch blocked! [callingPackage: dev.mobile.maestro; callingUid: 10690]';
    for (const text of [miui, aosp, `noise before\n${miui}\nnoise after`]) {
      const problem = deviceProblemIn(text);
      expect(problem).toMatch(/phone stopped Maestro from opening the app/);
      expect(problem).toMatch(/running it again will not help/);
    }
  });

  it('does not turn a test failure into a device problem because another app was blocked', () => {
    expect(deviceProblemIn('W/ActivityTaskManager: Background activity launch blocked! [callingPackage: com.facebook.katana; callingUid: 10123]')).toBeUndefined();
    expect(
      deviceProblemIn('D/ActivityStarterImpl( 2644): MIUILOG- Permission Denied Activity : Intent { act=android.intent.action.VIEW dat=https://example.com/ flg=0x10000000 cmp=com.example/.Link }'),
    ).toBeUndefined();
    expect(deviceProblemIn('I/ActivityTaskManager: Abort background activity starts from 10690')).toBeUndefined();
  });

  it('does not let a blocked launch of Maestro on one line match the caller on the next', () => {
    expect(deviceProblemIn('Background activity launch blocked! [callingPackage: com.facebook.katana; callingUid: 10123]\nstarted dev.mobile.maestro')).toBeUndefined();
  });

  it('marks a failed run whose output points at the device, and never a passed one', () => {
    const flow: MaestroFlow = { appId: 'com.example', steps: [{ kind: 'launchApp' }, { kind: 'back' }] };
    const base = {
      runId: 'r',
      caseId: 'c',
      flowFile: 'flows/c.yaml',
      startedAt: '2026-10-31T10:00:00.000Z',
      finishedAt: '2026-10-31T10:00:10.000Z',
      flow,
      outputFile: 'runs/r/output.txt',
    };
    const failed = summarizeRun({
      ...base,
      exitCode: 1,
      commands: [
        { sequence: 2, name: 'launchAppCommand', status: 'passed', durationMs: 1 },
        { sequence: 3, name: 'backPressCommand', status: 'failed', durationMs: 1 },
      ],
      diagnostics: 'DeviceServerDiedException: Device server died',
    });
    expect(failed.deviceProblem).toMatch(/not a test failure/);
    expect(failed.error).toMatch(/step 2 without saying why/);
    const passed = summarizeRun({
      ...base,
      exitCode: 0,
      commands: [
        { sequence: 2, name: 'launchAppCommand', status: 'passed', durationMs: 1 },
        { sequence: 3, name: 'backPressCommand', status: 'passed', durationMs: 1 },
      ],
      diagnostics: 'device offline',
    });
    expect(passed.deviceProblem).toBeUndefined();
  });
});
