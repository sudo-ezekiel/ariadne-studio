import { describe, expect, it } from 'vitest';
import { toMaestroYaml } from '../src/maestro/emit.ts';
import type { MaestroFlow } from '../src/maestro/model.ts';
import { MaestroParseError, parseMaestroFlow } from '../src/maestro/parse.ts';

describe('toMaestroYaml', () => {
  it('matches the spec example byte for byte', () => {
    const flow: MaestroFlow = {
      appId: 'com.android.settings',
      name: 'Open network settings',
      steps: [
        { kind: 'launchApp' },
        { kind: 'tapOn', selector: { kind: 'text', value: 'Network & internet' } },
        { kind: 'assertVisible', selector: { kind: 'text', value: 'Wi-Fi' } },
      ],
    };
    expect(toMaestroYaml(flow)).toBe(
      [
        'appId: com.android.settings',
        'name: Open network settings',
        '---',
        '- launchApp',
        '- tapOn:',
        '    text: "Network & internet"',
        '- assertVisible:',
        '    text: "Wi-Fi"',
        '',
      ].join('\n'),
    );
  });

  it('emits points, indexes, ids and the other commands', () => {
    const flow: MaestroFlow = {
      appId: 'com.example.app',
      steps: [
        { kind: 'launchApp', clearState: true },
        { kind: 'runFlow', file: '../blocks/login.yaml', env: { USERNAME: '${USERNAME}' } },
        { kind: 'tapOn', selector: { kind: 'point', xPercent: 50, yPercent: 30 } },
        { kind: 'tapOn', selector: { kind: 'id', value: 'com\\.example:id/row', index: 2 } },
        { kind: 'tapOn', selector: { kind: 'text', value: 'Storage \\(64 GB\\)' } },
        { kind: 'inputText', text: '123' },
        { kind: 'eraseText', chars: 3 },
        { kind: 'hideKeyboard' },
        { kind: 'back' },
        { kind: 'assertNotVisible', selector: { kind: 'text', value: 'Error' } },
      ],
    };
    expect(toMaestroYaml(flow)).toBe(
      [
        'appId: com.example.app',
        '---',
        '- launchApp:',
        '    clearState: true',
        '- runFlow:',
        '    file: ../blocks/login.yaml',
        '    env:',
        '      USERNAME: "${USERNAME}"',
        '- tapOn:',
        '    point: "50%,30%"',
        '- tapOn:',
        '    id: "com\\\\.example:id/row"',
        '    index: 2',
        '- tapOn:',
        '    text: "Storage \\\\(64 GB\\\\)"',
        '- inputText: "123"',
        '- eraseText: 3',
        '- hideKeyboard',
        '- back',
        '- assertNotVisible:',
        '    text: "Error"',
        '',
      ].join('\n'),
    );
  });

  it('emits scroll as a bare command and swipe with a direction', () => {
    const yaml = toMaestroYaml({
      appId: 'com.android.settings',
      steps: [{ kind: 'scroll' }, { kind: 'swipe', direction: 'DOWN' }],
    });
    expect(yaml).toBe(['appId: com.android.settings', '---', '- scroll', '- swipe:', '    direction: DOWN', ''].join('\n'));
  });

  it('emits scrollUntilVisible with an element and a direction, and options only when set', () => {
    const yaml = toMaestroYaml({
      appId: 'com.android.settings',
      steps: [
        { kind: 'scrollUntilVisible', selector: { kind: 'text', value: 'System' }, direction: 'DOWN' },
        {
          kind: 'scrollUntilVisible',
          selector: { kind: 'id', value: 'com\\.app:id/row', index: 1 },
          direction: 'UP',
          timeoutMs: 10000,
          speed: 60,
          visibilityPercentage: 50,
          centerElement: true,
        },
      ],
    });
    expect(yaml).toBe(
      [
        'appId: com.android.settings',
        '---',
        '- scrollUntilVisible:',
        '    element:',
        '      text: "System"',
        '    direction: DOWN',
        '- scrollUntilVisible:',
        '    element:',
        '      id: "com\\\\.app:id/row"',
        '      index: 1',
        '    direction: UP',
        '    timeout: 10000',
        '    speed: 60',
        '    visibilityPercentage: 50',
        '    centerElement: true',
        '',
      ].join('\n'),
    );
  });

  it('never folds long values onto several lines', () => {
    const text = 'word '.repeat(30).trim();
    const yaml = toMaestroYaml({ appId: 'a.b', steps: [{ kind: 'inputText', text }] });
    expect(yaml).toContain(`- inputText: "${text}"\n`);
  });
});

describe('parseMaestroFlow', () => {
  it('round-trips everything the emitter produces', () => {
    const flow: MaestroFlow = {
      appId: 'com.example.app',
      name: 'Submit claim: (expired) policy?',
      env: { REGION: 'eu' },
      steps: [
        { kind: 'launchApp', clearState: true },
        { kind: 'runFlow', file: '../blocks/login.yaml', env: { USERNAME: '${USERNAME}', PASSWORD: '${PASSWORD}' } },
        { kind: 'runFlow', file: '../blocks/onboarding.yaml' },
        { kind: 'tapOn', selector: { kind: 'id', value: 'com\\.example:id/claims' } },
        { kind: 'tapOn', selector: { kind: 'text', value: 'Claim \\(new\\)', index: 1 } },
        { kind: 'tapOn', selector: { kind: 'point', xPercent: 12, yPercent: 88 } },
        { kind: 'inputText', text: 'yes' },
        { kind: 'eraseText' },
        { kind: 'eraseText', chars: 4 },
        { kind: 'hideKeyboard' },
        { kind: 'back' },
        { kind: 'launchApp' },
        { kind: 'assertVisible', selector: { kind: 'text', value: 'Submitted' } },
        { kind: 'assertNotVisible', selector: { kind: 'id', value: 'com\\.example:id/error', index: 0 } },
        { kind: 'scroll' },
        { kind: 'swipe', direction: 'DOWN' },
        { kind: 'swipe', direction: 'LEFT' },
        { kind: 'scrollUntilVisible', selector: { kind: 'text', value: 'System' }, direction: 'DOWN' },
        {
          kind: 'scrollUntilVisible',
          selector: { kind: 'id', value: 'com\\.example:id/footer', index: 2 },
          direction: 'UP',
          timeoutMs: 30000,
          speed: 20,
          visibilityPercentage: 80,
          centerElement: false,
        },
      ],
    };
    expect(parseMaestroFlow(toMaestroYaml(flow))).toEqual(flow);
  });

  it('reads scrollUntilVisible written by hand: direction defaults to DOWN, text shorthand accepted', () => {
    const flow = parseMaestroFlow(
      ['appId: a', '---', '- scrollUntilVisible:', '    element:', '      text: Footer', '- scrollUntilVisible:', '    element: Storage', '    direction: up'].join('\n'),
    );
    expect(flow.steps).toEqual([
      { kind: 'scrollUntilVisible', selector: { kind: 'text', value: 'Footer' }, direction: 'DOWN' },
      { kind: 'scrollUntilVisible', selector: { kind: 'text', value: 'Storage' }, direction: 'UP' },
    ]);
  });

  it('rejects scrollUntilVisible forms outside the subset', () => {
    const parse = (body: string) => () => parseMaestroFlow(`appId: a\n---\n- scrollUntilVisible:\n${body}`);
    expect(parse('    direction: DOWN\n')).toThrow(/needs an element/);
    expect(parse('    element:\n      point: "50%,50%"\n')).toThrow(/not a point/);
    expect(parse('    element:\n      text: A\n      below: B\n')).toThrow(/below/);
    expect(parse('    element: A\n    direction: SIDEWAYS\n')).toThrow(/direction/);
    expect(parse('    element: A\n    timeout: soon\n')).toThrow(/timeout must be a number/);
    expect(parse('    element: A\n    centerElement: "yes"\n')).toThrow(/centerElement/);
    expect(parse('    element: A\n    optional: true\n')).toThrow(/optional/);
    expect(() => parseMaestroFlow('appId: a\n---\n- scrollUntilVisible\n')).toThrow(MaestroParseError);
  });

  it('reads scroll and swipe written by hand', () => {
    const flow = parseMaestroFlow(['appId: a', '---', '- scroll', '- scroll:', '- swipe:', '    direction: up'].join('\n'));
    expect(flow.steps).toEqual([{ kind: 'scroll' }, { kind: 'scroll' }, { kind: 'swipe', direction: 'UP' }]);
  });

  it('rejects swipe forms outside the subset', () => {
    expect(() => parseMaestroFlow('appId: a\n---\n- swipe:\n    start: 100, 500\n    end: 900, 500\n')).toThrow(/percentage/);
    expect(() => parseMaestroFlow('appId: a\n---\n- swipe:\n    start: 10%,50%\n')).toThrow(/start and end/);
    expect(() => parseMaestroFlow('appId: a\n---\n- swipe:\n    start: 10%,50%\n    end: 90%,50%\n    direction: LEFT\n')).toThrow(/direction/);
    expect(() => parseMaestroFlow('appId: a\n---\n- swipe:\n    direction: SIDEWAYS\n')).toThrow(/direction/);
    expect(() => parseMaestroFlow('appId: a\n---\n- swipe:\n    direction: DOWN\n    duration: 400\n')).toThrow(MaestroParseError);
    expect(() => parseMaestroFlow('appId: a\n---\n- scroll:\n    speed: 40\n')).toThrow(/scroll/);
  });

  it('reads the hand-written shorthand forms', () => {
    const flow = parseMaestroFlow(
      ['appId: com.example', '---', '- launchApp', '- tapOn: Login', '- runFlow: ../blocks/a.yaml', '- inputText: 42'].join('\n'),
    );
    expect(flow.steps).toEqual([
      { kind: 'launchApp' },
      { kind: 'tapOn', selector: { kind: 'text', value: 'Login' } },
      { kind: 'runFlow', file: '../blocks/a.yaml' },
      { kind: 'inputText', text: '42' },
    ]);
  });

  it('throws on commands outside the supported subset', () => {
    expect(() => parseMaestroFlow('appId: a\n---\n- waitForAnimationToEnd\n')).toThrow(MaestroParseError);
    expect(() => parseMaestroFlow('appId: a\n---\n- tapOn:\n    text: A\n    below: B\n')).toThrow(/below/);
    expect(() => parseMaestroFlow('appId: a\n---\n- swipe\n')).toThrow(/swipe/);
  });

  it('throws when the header or separator is missing', () => {
    expect(() => parseMaestroFlow('- launchApp\n')).toThrow(MaestroParseError);
    expect(() => parseMaestroFlow('name: x\n---\n- launchApp\n')).toThrow(/appId/);
  });
});

describe('openLink and takeScreenshot', () => {
  it('emits openLink with the link always quoted', () => {
    const yaml = toMaestroYaml({
      appId: 'a.b',
      steps: [
        { kind: 'openLink', link: 'https://example.com/claims?id=7&tab=docs#top' },
        { kind: 'openLink', link: 'yes' },
        { kind: 'openLink', link: 'myapp://claims/${CLAIM_ID}' },
      ],
    });
    expect(yaml).toBe(
      [
        'appId: a.b',
        '---',
        '- openLink: "https://example.com/claims?id=7&tab=docs#top"',
        '- openLink: "yes"',
        '- openLink: "myapp://claims/${CLAIM_ID}"',
        '',
      ].join('\n'),
    );
  });

  it('emits takeScreenshot as a mapping, with optional only when set', () => {
    const yaml = toMaestroYaml({
      appId: 'a.b',
      steps: [
        { kind: 'takeScreenshot', path: 'after-002', optional: true },
        { kind: 'takeScreenshot', path: 'shot' },
        { kind: 'takeScreenshot', path: 'plain', optional: false },
      ],
    });
    expect(yaml).toBe(
      [
        'appId: a.b',
        '---',
        '- takeScreenshot:',
        '    path: after-002',
        '    optional: true',
        '- takeScreenshot:',
        '    path: shot',
        '- takeScreenshot:',
        '    path: plain',
        '    optional: false',
        '',
      ].join('\n'),
    );
  });

  it('round-trips both, including values YAML would otherwise retype', () => {
    const flow: MaestroFlow = {
      appId: 'a.b',
      steps: [
        { kind: 'launchApp' },
        { kind: 'openLink', link: 'https://example.com/a?b=1#c' },
        { kind: 'openLink', link: 'true' },
        { kind: 'takeScreenshot', path: 'after-003', optional: true },
        { kind: 'takeScreenshot', path: '001' },
        { kind: 'takeScreenshot', path: 'shots/a b: c', optional: false },
      ],
    };
    expect(parseMaestroFlow(toMaestroYaml(flow))).toEqual(flow);
  });

  it('reads the string and mapping forms written by hand', () => {
    const flow = parseMaestroFlow(
      [
        'appId: a',
        '---',
        '- openLink: https://example.com',
        '- openLink:',
        '    link: myapp://home',
        '- takeScreenshot: home',
        '- takeScreenshot:',
        '    path: after-001',
        '    optional: true',
      ].join('\n'),
    );
    expect(flow.steps).toEqual([
      { kind: 'openLink', link: 'https://example.com' },
      { kind: 'openLink', link: 'myapp://home' },
      { kind: 'takeScreenshot', path: 'home' },
      { kind: 'takeScreenshot', path: 'after-001', optional: true },
    ]);
  });

  it('rejects forms outside the subset', () => {
    const parse = (body: string) => () => parseMaestroFlow(`appId: a\n---\n${body}`);
    expect(parse('- openLink:\n    link: https://x\n    autoVerify: true\n')).toThrow(/autoVerify/);
    expect(parse('- openLink:\n    browser: true\n')).toThrow(MaestroParseError);
    expect(parse('- openLink\n')).toThrow(/openLink/);
    expect(parse('- openLink: 42\n')).toThrow(/openLink needs a link/);
    expect(parse('- takeScreenshot:\n    path: a\n    cropOn: b\n')).toThrow(/cropOn/);
    expect(parse('- takeScreenshot:\n    path: a\n    optional: "yes"\n')).toThrow(/optional must be true or false/);
    expect(parse('- takeScreenshot:\n    optional: true\n')).toThrow(/takeScreenshot.path/);
    expect(parse('- takeScreenshot\n')).toThrow(MaestroParseError);
  });
});

describe('startRecording and stopRecording', () => {
  it('emits startRecording as a mapping, with optional only when set, and stopRecording as a plain string', () => {
    const yaml = toMaestroYaml({
      appId: 'a.b',
      steps: [
        { kind: 'startRecording', path: 'run-video', optional: true },
        { kind: 'startRecording', path: 'plain' },
        { kind: 'startRecording', path: 'strict', optional: false },
        { kind: 'stopRecording' },
      ],
    });
    expect(yaml).toBe(
      [
        'appId: a.b',
        '---',
        '- startRecording:',
        '    path: run-video',
        '    optional: true',
        '- startRecording:',
        '    path: plain',
        '- startRecording:',
        '    path: strict',
        '    optional: false',
        '- stopRecording',
        '',
      ].join('\n'),
    );
  });
});
