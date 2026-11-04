import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toMaestroYaml } from '../src/maestro/emit.ts';
import type { MaestroFlow, MaestroStep } from '../src/maestro/model.ts';
import { MaestroParseError, parseMaestroFlow } from '../src/maestro/parse.ts';
import { percentOfScreen, pointOnScreen } from '../src/maestro/selector.ts';
import type { CaseStep, TestCase } from '../src/recorder/case-types.ts';
import { describeMaestroStep, describeStep, swipeDirectionWord } from '../src/recorder/describe.ts';
import { scrollTargets } from '../src/recorder/flow-layout.ts';
import { caseToFlow, Recorder } from '../src/recorder/recorder.ts';
import { agentDeviceReplays, directAction, replaySegments } from '../src/replay/device-replay.ts';
import { correlateRun, parseMaestroRun } from '../src/replay/run-result.ts';
import { settingsHome } from './fixtures.ts';

const network = { kind: 'text', value: 'Network & internet' } as const;

/**
 * The flow Maestro 2.12 ran on emulator-5562 on 2026-11-03, with every new
 * command passing (fixtures/maestro-commands-gestures.json is its commands.json).
 * Only takeScreenshot is written here in the long form the emitter uses; the
 * run had `takeScreenshot: land`.
 */
const RAN_ON_DEVICE = [
  'appId: com.android.settings',
  'name: probe1',
  '---',
  '- launchApp',
  '- longPressOn:',
  '    text: "Network & internet"',
  '- back',
  '- doubleTapOn:',
  '    text: "Network & internet"',
  '- back',
  '- swipe:',
  '    start: "50%, 70%"',
  '    end: "50%, 30%"',
  '    duration: 400',
  '- swipe:',
  '    start: "50%, 30%"',
  '    end: "50%, 70%"',
  '    duration: 400',
  '- pressKey: Home',
  '- launchApp',
  '- pressKey: Volume Up',
  '- pressKey: Volume Down',
  '- pressKey: Enter',
  '- setOrientation: LANDSCAPE_LEFT',
  '- takeScreenshot:',
  '    path: land',
  '- setOrientation: PORTRAIT',
  '- takeScreenshot:',
  '    path: port',
  '',
].join('\n');

describe('gesture and key commands in Maestro YAML', () => {
  it('emits exactly the YAML that ran on the device, and parses it back', () => {
    const flow = parseMaestroFlow(RAN_ON_DEVICE);
    expect(flow.steps.slice(1, 6)).toEqual([
      { kind: 'longPressOn', selector: network },
      { kind: 'back' },
      { kind: 'doubleTapOn', selector: network },
      { kind: 'back' },
      { kind: 'swipe', start: { xPercent: 50, yPercent: 70 }, end: { xPercent: 50, yPercent: 30 }, durationMs: 400 },
    ]);
    expect(flow.steps.filter((step) => step.kind === 'pressKey')).toEqual([
      { kind: 'pressKey', key: 'Home' },
      { kind: 'pressKey', key: 'Volume Up' },
      { kind: 'pressKey', key: 'Volume Down' },
      { kind: 'pressKey', key: 'Enter' },
    ]);
    expect(toMaestroYaml(flow)).toBe(RAN_ON_DEVICE);
  });

  it('round-trips every new command, including point selectors and a swipe without a duration', () => {
    const flow: MaestroFlow = {
      appId: 'a.b',
      steps: [
        { kind: 'longPressOn', selector: { kind: 'id', value: 'android:id/title', index: 2 } },
        { kind: 'doubleTapOn', selector: { kind: 'point', xPercent: 10, yPercent: 90 } },
        { kind: 'swipe', start: { xPercent: 0, yPercent: 1 }, end: { xPercent: 100, yPercent: 99 } },
        { kind: 'pressKey', key: 'Power' },
        { kind: 'setOrientation', orientation: 'UPSIDE_DOWN' },
        { kind: 'swipe', direction: 'LEFT' },
      ],
    };
    const yaml = toMaestroYaml(flow);
    expect(yaml).toContain('- doubleTapOn:\n    point: "10%,90%"\n');
    expect(yaml).toContain('- swipe:\n    start: "0%, 1%"\n    end: "100%, 99%"\n- pressKey: Power\n- setOrientation: UPSIDE_DOWN\n');
    expect(parseMaestroFlow(yaml)).toEqual(flow);
  });

  it('reads key and orientation names the way Maestro does, whatever their case', () => {
    const flow = parseMaestroFlow('appId: a\n---\n- pressKey: volume down\n- pressKey: HOME\n- setOrientation: landscape_right\n');
    expect(flow.steps).toEqual([
      { kind: 'pressKey', key: 'Volume Down' },
      { kind: 'pressKey', key: 'Home' },
      { kind: 'setOrientation', orientation: 'LANDSCAPE_RIGHT' },
    ]);
  });

  it('refuses keys, orientations and swipes outside the subset', () => {
    expect(() => parseMaestroFlow('appId: a\n---\n- pressKey: Remote Dpad Up\n')).toThrow(/Unsupported key/);
    expect(() => parseMaestroFlow('appId: a\n---\n- pressKey:\n    key: Home\n')).toThrow(MaestroParseError);
    expect(() => parseMaestroFlow('appId: a\n---\n- setOrientation: SIDEWAYS\n')).toThrow(/PORTRAIT/);
    expect(() => parseMaestroFlow('appId: a\n---\n- swipe:\n    start: 10%, 10%\n    end: 20%, 20%\n    duration: slow\n')).toThrow(/duration/);
    expect(() => parseMaestroFlow('appId: a\n---\n- longPressOn:\n    text: A\n    below: B\n')).toThrow(/below/);
  });
});

describe('recording gestures and phone buttons', () => {
  const nodes = settingsHome();
  const viewport = { width: 1080, height: 2400 };
  const title = nodes.find((node) => node.label === 'Network & internet')!;

  function recorder(): Recorder {
    const active = new Recorder({ now: () => new Date('2026-11-03T12:00:00Z') });
    active.start({ id: 'gestures', name: 'Gestures', appId: 'com.android.settings', deviceId: 'emulator-5562' });
    return active;
  }

  it('gives a long press and a double tap the selector a tap would get, and writes each as one command', () => {
    const active = recorder();
    const point = { x: 400, y: 680 };
    const tap = active.recordTap(title, point, viewport, undefined, nodes);
    const held = active.recordLongPress(title, point, viewport, undefined, nodes);
    const twice = active.recordDoubleTap(undefined, { x: 540, y: 1200 }, viewport, undefined, nodes);
    expect(held).toMatchObject({ kind: 'longPress', selector: (tap as { selector: unknown }).selector, node: { label: 'Network & internet' } });
    expect(twice).toMatchObject({ kind: 'doubleTap', selector: { kind: 'point', xPercent: 50, yPercent: 50 } });
    expect(active.toFlow().steps.slice(2)).toEqual([
      { kind: 'longPressOn', selector: network },
      { kind: 'doubleTapOn', selector: { kind: 'point', xPercent: 50, yPercent: 50 } },
    ]);
  });

  it('writes a swipe, the phone keys and a rotation as Maestro commands', () => {
    const active = recorder();
    active.recordSwipe({ xPercent: 80, yPercent: 50 }, { xPercent: 20, yPercent: 50 }, 312.6);
    for (const key of ['home', 'volumeUp', 'volumeDown', 'power', 'enter'] as const) active.recordPressKey(key);
    active.recordOrientation('landscape');
    active.recordOrientation('portrait');
    expect(active.toCase().steps[0]).toMatchObject({ kind: 'swipe', durationMs: 313 });
    const yaml = toMaestroYaml(active.toFlow());
    expect(yaml).toContain(
      [
        '- swipe:',
        '    start: "80%, 50%"',
        '    end: "20%, 50%"',
        '    duration: 313',
        '- pressKey: Home',
        '- pressKey: Volume Up',
        '- pressKey: Volume Down',
        '- pressKey: Power',
        '- pressKey: Enter',
        '- setOrientation: LANDSCAPE_LEFT',
        '- setOrientation: PORTRAIT',
      ].join('\n'),
    );
  });

  it('scrolls to the element of a long press or double tap that follows a scroll', () => {
    const steps: CaseStep[] = [
      { index: 1, kind: 'scroll', direction: 'down', at: 'x' },
      { index: 2, kind: 'longPress', selector: network, point: { x: 1, y: 1 }, at: 'x' },
      { index: 3, kind: 'scroll', direction: 'down', at: 'x' },
      { index: 4, kind: 'doubleTap', selector: { kind: 'point', xPercent: 5, yPercent: 5 }, point: { x: 1, y: 1 }, at: 'x' },
    ];
    expect(scrollTargets(steps, [])).toEqual([network, undefined, undefined, undefined]);
  });

  it('converts between screen pixels and whole percentages', () => {
    expect(percentOfScreen({ x: 540, y: 2399 }, viewport)).toEqual({ xPercent: 50, yPercent: 100 });
    expect(percentOfScreen({ x: -20, y: 2600 }, viewport)).toEqual({ xPercent: 0, yPercent: 100 });
    expect(pointOnScreen({ xPercent: 100, yPercent: 50 }, viewport)).toEqual({ x: 1079, y: 1200 });
  });
});

describe('swipe and key wording', () => {
  const swipe = (from: [number, number], to: [number, number]): CaseStep => ({
    index: 1,
    kind: 'swipe',
    from: { xPercent: from[0], yPercent: from[1] },
    to: { xPercent: to[0], yPercent: to[1] },
    durationMs: 300,
    at: 'x',
  });

  it('names the direction the finger moves when the drag is mostly along one axis', () => {
    expect(swipeDirectionWord({ xPercent: 80, yPercent: 50 }, { xPercent: 20, yPercent: 55 })).toBe('left');
    expect(swipeDirectionWord({ xPercent: 20, yPercent: 50 }, { xPercent: 80, yPercent: 40 })).toBe('right');
    expect(swipeDirectionWord({ xPercent: 50, yPercent: 70 }, { xPercent: 55, yPercent: 30 })).toBe('up');
    expect(swipeDirectionWord({ xPercent: 50, yPercent: 30 }, { xPercent: 50, yPercent: 70 })).toBe('down');
    // Exactly twice as far along one axis still counts; a little less does not.
    expect(swipeDirectionWord({ xPercent: 0, yPercent: 0 }, { xPercent: 40, yPercent: 20 })).toBe('right');
    expect(swipeDirectionWord({ xPercent: 0, yPercent: 0 }, { xPercent: 40, yPercent: 21 })).toBeUndefined();
  });

  it('describes swipes in words, with the position for a diagonal one', () => {
    expect(describeStep(swipe([80, 50], [20, 50]))).toBe('Swipe left');
    expect(describeStep(swipe([50, 70], [50, 30]))).toBe('Swipe up');
    expect(describeStep(swipe([50, 1], [50, 60]))).toBe('Swipe down from the top edge');
    expect(describeStep(swipe([50, 30], [50, 70]))).toBe('Swipe down');
    expect(describeStep(swipe([10, 10], [60, 60]))).toBe('Swipe from 10%, 10% to 60%, 60%');
  });

  it('describes long presses, double taps, keys and rotation the way a BA would say them', () => {
    const at = { point: { x: 1, y: 1 }, at: 'x', index: 1 };
    expect(describeStep({ ...at, kind: 'longPress', selector: { kind: 'text', value: 'Wi-Fi' } })).toBe('Long press "Wi-Fi"');
    expect(describeStep({ ...at, kind: 'doubleTap', selector: { kind: 'id', value: 'a:id/map' }, node: { label: 'Map' } })).toBe('Double tap "Map"');
    expect(describeStep({ index: 1, kind: 'pressKey', key: 'home', at: 'x' })).toBe('Press Home');
    expect(describeStep({ index: 1, kind: 'pressKey', key: 'volumeUp', at: 'x' })).toBe('Press Volume up');
    expect(describeStep({ index: 1, kind: 'orientation', value: 'landscape', at: 'x' })).toBe('Rotate to landscape');
    expect(describeMaestroStep({ kind: 'swipe', start: { xPercent: 90, yPercent: 50 }, end: { xPercent: 10, yPercent: 50 } })).toBe('Swipe left');
    expect(describeMaestroStep({ kind: 'setOrientation', orientation: 'PORTRAIT' })).toBe('Rotate to portrait');
    expect(describeMaestroStep({ kind: 'pressKey', key: 'Volume Down' })).toBe('Press Volume Down');
  });
});

describe('replaying part of a case through agent-device', () => {
  const steps: MaestroStep[] = [
    { kind: 'launchApp' },
    { kind: 'longPressOn', selector: network },
    { kind: 'pressKey', key: 'Home' },
    { kind: 'pressKey', key: 'Volume Up' },
    { kind: 'setOrientation', orientation: 'LANDSCAPE_LEFT' },
    { kind: 'swipe', start: { xPercent: 50, yPercent: 70 }, end: { xPercent: 50, yPercent: 30 }, durationMs: 400 },
    { kind: 'doubleTapOn', selector: { kind: 'point', xPercent: 10, yPercent: 20 } },
  ];

  it('knows which commands agent-device 0.21.35 replays', () => {
    expect(steps.map(agentDeviceReplays)).toEqual([true, true, true, false, false, true, false]);
  });

  it('splits a flow into agent-device runs and the actions the studio does itself', () => {
    expect(replaySegments(steps)).toEqual([
      { kind: 'flow', steps: steps.slice(0, 3) },
      { kind: 'direct', step: steps[3], action: { kind: 'pressKey', key: 'volumeUp' } },
      { kind: 'direct', step: steps[4], action: { kind: 'orientation', value: 'landscape' } },
      { kind: 'flow', steps: [steps[5]] },
      { kind: 'direct', step: steps[6], action: { kind: 'doubleTap', point: { xPercent: 10, yPercent: 20 } } },
    ]);
    expect(replaySegments(steps.slice(0, 3))).toEqual([{ kind: 'flow', steps: steps.slice(0, 3) }]);
  });

  it('refuses a command the recorder never writes', () => {
    expect(() => directAction({ kind: 'pressKey', key: 'Tab' })).toThrow(/cannot replay/);
    expect(() => directAction({ kind: 'setOrientation', orientation: 'UPSIDE_DOWN' })).toThrow(/cannot replay/);
  });
});

describe('run results of gesture and key commands', () => {
  it('lines up one Maestro command with each step, as Maestro 2.12 reported them', () => {
    const commands = parseMaestroRun(JSON.parse(readFileSync(new URL('./fixtures/maestro-commands-gestures.json', import.meta.url), 'utf8')));
    expect(commands.map((command) => command.name)).toEqual([
      'launchAppCommand',
      'tapOnElement',
      'backPressCommand',
      'tapOnElement',
      'backPressCommand',
      'swipeCommand',
      'swipeCommand',
      'pressKeyCommand',
      'launchAppCommand',
      'pressKeyCommand',
      'pressKeyCommand',
      'pressKeyCommand',
      'setOrientationCommand',
      'takeScreenshotCommand',
      'setOrientationCommand',
      'takeScreenshotCommand',
    ]);
    const results = correlateRun(parseMaestroFlow(RAN_ON_DEVICE), commands);
    expect(results.every((result) => result.status === 'passed' && !result.warning)).toBe(true);
    expect(results[12]!.step).toEqual({ kind: 'setOrientation', orientation: 'LANDSCAPE_LEFT' });
  });

  it('builds a case flow whose steps are each one command', () => {
    const testCase: TestCase = {
      id: 'g',
      name: 'G',
      appId: 'com.android.settings',
      createdAt: 'x',
      deviceId: 'emulator-5562',
      preconditionBlocks: [],
      steps: [
        { index: 1, kind: 'longPress', selector: network, point: { x: 1, y: 1 }, at: 'x' },
        { index: 2, kind: 'pressKey', key: 'enter', at: 'x' },
        { index: 3, kind: 'orientation', value: 'portrait', at: 'x' },
      ],
      expectations: [],
    };
    expect(caseToFlow(testCase).steps).toEqual([
      { kind: 'launchApp' },
      { kind: 'longPressOn', selector: network },
      { kind: 'pressKey', key: 'Enter' },
      { kind: 'setOrientation', orientation: 'PORTRAIT' },
    ]);
  });
});
