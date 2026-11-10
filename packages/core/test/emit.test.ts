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

describe('wait', () => {
  const waitFlow = (seconds: number): MaestroFlow => ({ appId: 'a.b', steps: [{ kind: 'wait', seconds }] });
  const parseBody = (body: string) => () => parseMaestroFlow(`appId: a\n---\n${body}`);

  it('emits a Wait as an optional extendedWaitUntil for something that is never on screen', () => {
    expect(toMaestroYaml(waitFlow(20))).toBe(
      [
        'appId: a.b',
        '---',
        '- extendedWaitUntil:',
        '    visible: "ariadne-wait"',
        '    timeout: 20000',
        '    optional: true',
        '    label: "Wait 20 seconds"',
        '',
      ].join('\n'),
    );
  });

  it('writes one second in the singular', () => {
    const yaml = toMaestroYaml(waitFlow(1));
    expect(yaml).toContain('    timeout: 1000\n');
    expect(yaml).toContain('    label: "Wait 1 second"\n');
  });

  it('reads back what it wrote', () => {
    const flow: MaestroFlow = {
      appId: 'a.b',
      steps: [{ kind: 'launchApp' }, { kind: 'wait', seconds: 20 }, { kind: 'wait', seconds: 1 }, { kind: 'wait', seconds: 120 }],
    };
    expect(parseMaestroFlow(toMaestroYaml(flow))).toEqual(flow);
  });

  it('still refuses an extendedWaitUntil for something real on screen', () => {
    expect(parseBody('- extendedWaitUntil:\n    visible: "Loaded"\n    timeout: 5000\n')).toThrow(/Unsupported command "extendedWaitUntil"/);
    expect(parseBody('- extendedWaitUntil:\n    visible:\n      text: "Loaded"\n    timeout: 5000\n')).toThrow(MaestroParseError);
  });

  it('still refuses an extendedWaitUntil for the Wait label when it has no timeout', () => {
    expect(parseBody('- extendedWaitUntil:\n    visible: "ariadne-wait"\n')).toThrow(/Unsupported command "extendedWaitUntil"/);
    expect(parseBody('- extendedWaitUntil:\n    visible: "ariadne-wait"\n    timeout: "20000"\n')).toThrow(MaestroParseError);
  });

  it('refuses the Wait label with a timeout when optional is missing', () => {
    expect(parseBody('- extendedWaitUntil:\n    visible: "ariadne-wait"\n    timeout: 20000\n')).toThrow(/Unsupported command "extendedWaitUntil"/);
  });

  it('refuses the Wait label with a timeout when optional is false', () => {
    expect(parseBody('- extendedWaitUntil:\n    visible: "ariadne-wait"\n    timeout: 20000\n    optional: false\n')).toThrow(MaestroParseError);
  });

  it('reads the Wait form with optional true, with or without its label', () => {
    const read = (body: string) => parseMaestroFlow(`appId: a\n---\n${body}`);
    expect(read('- extendedWaitUntil:\n    visible: "ariadne-wait"\n    timeout: 20000\n    optional: true\n').steps).toEqual([{ kind: 'wait', seconds: 20 }]);
    expect(read('- extendedWaitUntil:\n    visible: "ariadne-wait"\n    timeout: 5000\n    optional: true\n    label: "Wait 5 seconds"\n').steps).toEqual([{ kind: 'wait', seconds: 5 }]);
  });

  const waitWithTimeout = (timeout: string) => parseBody(`- extendedWaitUntil:\n    visible: "ariadne-wait"\n    timeout: ${timeout}\n    optional: true\n`);

  it.each(['-5000', '0', '.inf', '.nan', '2147483648'])('refuses the Wait label with timeout %s', (timeout) => {
    expect(waitWithTimeout(timeout)).toThrow(/Unsupported command "extendedWaitUntil"/);
  });

  it('reads the longest timeout a timer can hold as a Wait', () => {
    expect(waitWithTimeout('2147483647')()).toEqual({ appId: 'a', steps: [{ kind: 'wait', seconds: 2147483.647 }] });
  });

  it('reads a timeout of 1000 as one second', () => {
    expect(waitWithTimeout('1000')().steps).toEqual([{ kind: 'wait', seconds: 1 }]);
  });

  const waitWithLabel = (timeout: number, label: string) =>
    parseBody(`- extendedWaitUntil:\n    visible: "ariadne-wait"\n    timeout: ${timeout}\n    optional: true\n    label: ${JSON.stringify(label)}\n`);

  it('refuses a Wait with a custom label', () => {
    expect(waitWithLabel(20000, 'Let the page settle')).toThrow(/Unsupported command "extendedWaitUntil"/);
  });

  it('refuses a Wait whose label uses a block variable, which a Wait would lose', () => {
    expect(waitWithLabel(20000, 'Wait for ${ACCOUNT}')).toThrow(/Unsupported command "extendedWaitUntil"/);
  });

  it('refuses a Wait with an empty label', () => {
    expect(waitWithLabel(20000, '')).toThrow(MaestroParseError);
  });

  it('reads the generated label for 20 seconds', () => {
    expect(waitWithLabel(20000, 'Wait 20 seconds')().steps).toEqual([{ kind: 'wait', seconds: 20 }]);
  });

  it('reads the singular generated label for 1 second', () => {
    expect(waitWithLabel(1000, 'Wait 1 second')().steps).toEqual([{ kind: 'wait', seconds: 1 }]);
  });

  it('refuses the plural label on a 1 second timeout', () => {
    expect(waitWithLabel(1000, 'Wait 1 seconds')).toThrow(/Unsupported command "extendedWaitUntil"/);
  });

  it('refuses a generated label for the wrong number of seconds', () => {
    expect(waitWithLabel(20000, 'Wait 5 seconds')).toThrow(/Unsupported command "extendedWaitUntil"/);
  });

  it('refuses a Wait with an extra key', () => {
    expect(
      parseBody('- extendedWaitUntil:\n    visible: "ariadne-wait"\n    notVisible: "x"\n    timeout: 20000\n    optional: true\n'),
    ).toThrow(/Unsupported command "extendedWaitUntil"/);
  });

  it('refuses a Wait with an extra key even when the label is the generated one', () => {
    expect(
      parseBody('- extendedWaitUntil:\n    visible: "ariadne-wait"\n    timeout: 20000\n    optional: true\n    label: "Wait 20 seconds"\n    notVisible: "x"\n'),
    ).toThrow(MaestroParseError);
  });

  it('reads back each Wait the emitter writes, across fractional and large seconds', () => {
    const flow: MaestroFlow = {
      appId: 'a.b',
      steps: [0.5, 1, 2, 59, 60, 3600].map((seconds) => ({ kind: 'wait', seconds })),
    };
    expect(parseMaestroFlow(toMaestroYaml(flow))).toEqual(flow);
  });

  it('refuses a bare extendedWaitUntil', () => {
    expect(parseBody('- extendedWaitUntil\n')).toThrow(/Unsupported command "extendedWaitUntil"/);
  });
});

describe('wait until', () => {
  const parseBody = (body: string) => () => parseMaestroFlow(`appId: a\n---\n${body}`);

  it('emits an optional extendedWaitUntil on the selector, the way assertVisible writes it', () => {
    const flow: MaestroFlow = { appId: 'a.b', steps: [{ kind: 'waitUntilVisible', selector: { kind: 'text', value: 'Welcome' }, seconds: 20 }] };
    expect(toMaestroYaml(flow)).toBe(
      ['appId: a.b', '---', '- extendedWaitUntil:', '    visible:', '      text: "Welcome"', '    timeout: 20000', '    optional: true', ''].join('\n'),
    );
  });

  it('reads back what it wrote, next to a Wait', () => {
    const flow: MaestroFlow = {
      appId: 'a.b',
      steps: [
        { kind: 'waitUntilVisible', selector: { kind: 'text', value: 'Welcome' }, seconds: 20 },
        { kind: 'wait', seconds: 5 },
        { kind: 'waitUntilVisible', selector: { kind: 'id', value: 'android:id/title', index: 2 }, seconds: 1 },
        { kind: 'waitUntilVisible', selector: { kind: 'text', value: 'Display \\(beta\\)', index: 0 }, seconds: 120 },
      ],
    };
    expect(parseMaestroFlow(toMaestroYaml(flow))).toEqual(flow);
  });

  it('still refuses a strict wait, a point, a text shorthand or a key of its own', () => {
    for (const body of [
      '- extendedWaitUntil:\n    visible:\n      text: "Loaded"\n    timeout: 5000\n',
      '- extendedWaitUntil:\n    visible:\n      text: "Loaded"\n    timeout: 5000\n    optional: false\n',
      '- extendedWaitUntil:\n    visible:\n      point: "50%,50%"\n    timeout: 5000\n    optional: true\n',
      '- extendedWaitUntil:\n    visible: "Loaded"\n    timeout: 5000\n    optional: true\n',
      '- extendedWaitUntil:\n    visible:\n      text: "Loaded"\n    timeout: 5000\n    optional: true\n    label: "Mine"\n',
      '- extendedWaitUntil:\n    notVisible:\n      text: "Loaded"\n    timeout: 5000\n    optional: true\n',
      '- extendedWaitUntil:\n    visible:\n      text: "Loaded"\n      enabled: true\n    timeout: 5000\n    optional: true\n',
    ]) {
      expect(parseBody(body), body).toThrow(/Unsupported command "extendedWaitUntil"/);
    }
  });
});
