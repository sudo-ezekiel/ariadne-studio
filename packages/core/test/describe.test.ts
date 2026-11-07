import { describe, expect, it } from 'vitest';
import type { MaestroSelector, MaestroStep } from '../src/maestro/model.ts';
import { parseMaestroFlow } from '../src/maestro/parse.ts';
import type { CaseStep, Expectation } from '../src/recorder/case-types.ts';
import {
  describeExpectation,
  describeFlowItem,
  describeMaestroStep,
  describeStep,
  elementName,
  formatDuration,
  targetName,
  stepExpected,
  stepTitle,
  typedText,
} from '../src/recorder/describe.ts';
import { caseFlowItems, leadingItemCount } from '../src/recorder/flow-layout.ts';

const at = '2026-10-31T10:00:00.000Z';
const system: MaestroSelector = { kind: 'text', value: 'System' };

function tap(selector: MaestroSelector, extra: Partial<CaseStep> = {}): CaseStep {
  return { index: 1, kind: 'tap', selector, point: { x: 1, y: 2 }, at, ...extra } as CaseStep;
}

describe('elementName', () => {
  it('says which setting names an element when the selector is a reference', () => {
    expect(elementName({ kind: 'text', value: '${SECTION}' })).toBe('the element the SECTION setting names');
    expect(elementName({ kind: 'id', value: '${SECTION}' })).toBe('the element the SECTION setting names');
  });

  it('keeps naming text that only contains a reference as text', () => {
    expect(elementName({ kind: 'text', value: 'Hello ${NAME}' })).toBe('"Hello ${NAME}"');
  });

  it('quotes text, without the regex escaping Maestro needs', () => {
    expect(elementName(system)).toBe('"System"');
    expect(elementName({ kind: 'text', value: 'Storage \\(64 GB\\)' })).toBe('"Storage (64 GB)"');
  });

  it('says which match it is when the text has an index', () => {
    expect(elementName({ kind: 'text', value: 'OK', index: 0 })).toBe('"OK" (number 1 on screen)');
    expect(elementName({ kind: 'text', value: 'OK', index: 2 })).toBe('"OK" (number 3 on screen)');
  });

  it('turns an id into its readable tail', () => {
    expect(elementName({ kind: 'id', value: 'com\\.insurer\\.app:id/btn_submit_claim' })).toBe('the btn submit claim element');
    expect(elementName({ kind: 'id', value: 'com.app:id/submitClaimButton' })).toBe('the submit claim button element');
    expect(elementName({ kind: 'id', value: 'android:id/title', index: 1 })).toBe('the title element (number 2 on screen)');
    expect(elementName({ kind: 'id', value: 'login-form.user_name' })).toBe('the login form user name element');
  });

  it('describes a point as a position on the screen', () => {
    expect(elementName({ kind: 'point', xPercent: 50, yPercent: 30 })).toBe('the point at 50% across, 30% down');
  });
});

describe('typedText', () => {
  it('quotes plain text and names a placeholder without its value', () => {
    expect(typedText('hello')).toBe('"hello"');
    expect(typedText('${PASSWORD}')).toBe('the PASSWORD value from .env');
    expect(typedText('pass ${PASSWORD}')).toBe('"pass ${PASSWORD}"');
  });
});

describe('describeStep', () => {
  it('describes every kind of step', () => {
    const steps: Array<[CaseStep, string]> = [
      [tap(system), 'Tap "System"'],
      [{ index: 2, kind: 'type', text: 'hello world', at }, 'Type "hello world"'],
      [{ index: 3, kind: 'type', text: '${PASSWORD}', at }, 'Type the PASSWORD value from .env'],
      [{ index: 4, kind: 'back', at }, 'Press Back'],
      [{ index: 5, kind: 'expect', selector: { kind: 'text', value: 'Internet' }, point: { x: 0, y: 0 }, at }, 'Check that "Internet" is visible'],
      [{ index: 6, kind: 'scroll', direction: 'down', at }, 'Scroll down'],
      [{ index: 7, kind: 'scroll', direction: 'up', at }, 'Scroll up'],
      [{ index: 8, kind: 'relaunch', at }, 'Restart the app'],
      [{ index: 9, kind: 'openLink', url: 'https://example.com/claims?id=7', at }, 'Open the link https://example.com/claims?id=7'],
      [{ index: 10, kind: 'hideKeyboard', at }, 'Hide the keyboard'],
      [{ index: 11, kind: 'wait', seconds: 20, at }, 'Wait 20 seconds'],
      [{ index: 12, kind: 'wait', seconds: 1, at }, 'Wait 1 second'],
    ];
    for (const [step, text] of steps) expect(describeStep(step)).toBe(text);
  });

  it('names the element a scroll scrolls to', () => {
    expect(describeStep({ index: 1, kind: 'scroll', direction: 'down', at }, system)).toBe('Scroll down until "System" is visible');
    expect(describeStep({ index: 1, kind: 'scroll', direction: 'up', at }, { kind: 'id', value: 'com.app:id/footer' })).toBe(
      'Scroll up until the footer element is visible',
    );
  });
});

describe('stepTitle and stepExpected', () => {
  it('uses the title when it is not blank', () => {
    expect(stepTitle(tap(system, { title: '  Open system settings ' }))).toBe('Open system settings');
    expect(stepTitle(tap(system, { title: '   ' }))).toBe('Tap "System"');
    expect(stepTitle(tap(system))).toBe('Tap "System"');
    expect(stepTitle({ index: 1, kind: 'scroll', direction: 'down', at }, system)).toBe('Scroll down until "System" is visible');
    expect(stepTitle({ index: 1, kind: 'scroll', direction: 'down', at, title: 'Find System' }, system)).toBe('Find System');
  });

  it('uses the note, else what an expect step checks, else nothing', () => {
    expect(stepExpected(tap(system, { note: ' The System page opens\n' }))).toBe('The System page opens');
    expect(stepExpected(tap(system, { note: '  ' }))).toBe('');
    expect(stepExpected(tap(system))).toBe('');
    const expectStep: CaseStep = { index: 1, kind: 'expect', selector: { kind: 'text', value: 'Wi-Fi' }, point: { x: 0, y: 0 }, at };
    expect(stepExpected(expectStep)).toBe('"Wi-Fi" is visible');
    expect(stepExpected({ ...expectStep, note: 'Wi-Fi is listed' })).toBe('Wi-Fi is listed');
  });

  it('describes an end expectation', () => {
    expect(describeExpectation({ selector: { kind: 'id', value: 'com.app:id/done_banner' }, at })).toBe('the done banner element is visible');
  });
});

describe('describeFlowItem', () => {
  const names = {
    caseName: (id: string) => (id === 'log-in-20261030-1712' ? 'Log in' : undefined),
    blockName: (file: string) => (file === 'blocks/login.yaml' ? 'Log in as BA' : undefined),
  };

  it('describes the launch, a start case and a block', () => {
    expect(describeFlowItem({ kind: 'launch' }, 'com.android.settings')).toBe('Start com.android.settings');
    expect(describeFlowItem({ kind: 'startFrom', caseId: 'log-in-20261030-1712' }, 'a', names)).toBe('Do everything in the case "Log in"');
    expect(describeFlowItem({ kind: 'startFrom', caseId: 'gone-20261030-1712' }, 'a', names)).toBe('Do everything in the case gone-20261030-1712');
    expect(describeFlowItem({ kind: 'startFrom', caseId: 'log-in-20261030-1712' }, 'a')).toBe('Do everything in the case log-in-20261030-1712');
    expect(describeFlowItem({ kind: 'block', file: 'blocks/login.yaml' }, 'a', names)).toBe('Run the block "Log in as BA" (blocks/login.yaml)');
    expect(describeFlowItem({ kind: 'block', file: 'blocks/other.yaml' }, 'a', names)).toBe('Run the block blocks/other.yaml');
    expect(describeFlowItem({ kind: 'block', file: 'blocks/login.yaml' }, 'a')).toBe('Run the block blocks/login.yaml');
  });

  it('describes a step by its title and an end expectation as a check', () => {
    expect(describeFlowItem({ kind: 'step', step: tap(system, { title: 'Open System' }) }, 'a')).toBe('Open System');
    expect(describeFlowItem({ kind: 'step', step: { index: 1, kind: 'scroll', direction: 'down', at }, scrollUntilVisible: system }, 'a')).toBe(
      'Scroll down until "System" is visible',
    );
    expect(describeFlowItem({ kind: 'expectation', expectation: { selector: { kind: 'text', value: 'Wi-Fi' }, at } }, 'a')).toBe(
      'Check that "Wi-Fi" is visible',
    );
  });
});

describe('caseFlowItems and leadingItemCount', () => {
  const steps: CaseStep[] = [
    { index: 1, kind: 'scroll', direction: 'down', at },
    tap(system, { index: 2 }),
  ];
  const expectations: Expectation[] = [{ selector: { kind: 'text', value: 'About' }, at }];

  it('starts with launchApp and the blocks when there is no start case', () => {
    const items = caseFlowItems({ preconditionBlocks: [{ file: 'blocks/a.yaml' }, { file: 'blocks/b.yaml' }], steps, expectations });
    expect(items.map((item) => item.kind)).toEqual(['launch', 'block', 'block', 'step', 'step', 'expectation']);
    expect(leadingItemCount({ preconditionBlocks: [{ file: 'blocks/a.yaml' }, { file: 'blocks/b.yaml' }] })).toBe(3);
    expect(leadingItemCount({ preconditionBlocks: [] })).toBe(1);
  });

  it('starts with the start case alone: no launch, blocks ignored', () => {
    const items = caseFlowItems({ preconditionBlocks: [{ file: 'blocks/a.yaml' }], startFrom: 'parent-20261030-1712', steps, expectations });
    expect(items).toEqual([
      { kind: 'startFrom', caseId: 'parent-20261030-1712' },
      { kind: 'step', step: steps[0], scrollUntilVisible: system },
      { kind: 'step', step: steps[1] },
      { kind: 'expectation', expectation: expectations[0] },
    ]);
    expect(leadingItemCount({ preconditionBlocks: [{ file: 'blocks/a.yaml' }], startFrom: 'parent-20261030-1712' })).toBe(1);
    expect(leadingItemCount({ preconditionBlocks: [], startFrom: 'parent-20261030-1712' })).toBe(1);
  });

  it('puts the first recorded step at leadingItemCount', () => {
    for (const testCase of [
      { preconditionBlocks: [{ file: 'blocks/a.yaml' }, { file: 'blocks/b.yaml' }], steps, expectations },
      { preconditionBlocks: [], startFrom: 'p', steps, expectations },
      { preconditionBlocks: [], steps, expectations },
    ]) {
      const items = caseFlowItems(testCase);
      const first = leadingItemCount(testCase);
      expect(items[first]).toMatchObject({ kind: 'step', step: steps[0] });
      expect(items.slice(0, first).every((item) => item.kind !== 'step')).toBe(true);
    }
  });

  it('treats an empty startFrom as no start case', () => {
    expect(caseFlowItems({ preconditionBlocks: [], startFrom: '', steps: [], expectations: [] })).toEqual([{ kind: 'launch' }]);
    expect(leadingItemCount({ preconditionBlocks: [], startFrom: '' })).toBe(1);
  });
});

describe('targetName', () => {
  const id = { kind: 'id', value: 'com\\.android\\.settings:id/search_bar_title' } as const;
  it('names an id or point target by the recorded element visible text', () => {
    expect(targetName(id, { label: 'Search Settings' })).toBe('"Search Settings"');
    expect(targetName({ kind: 'point', xPercent: 10, yPercent: 20 }, { text: 'Map' })).toBe('"Map" (by its position on screen)');
    expect(describeStep({ index: 1, kind: 'tap', selector: id, point: { x: 1, y: 1 }, node: { label: 'Search Settings' }, at: 'x' })).toBe('Tap "Search Settings"');
  });
  it('falls back to the selector without a short visible name, and keeps text selectors as they are', () => {
    expect(targetName(id)).toBe('the search bar title element');
    expect(targetName(id, { label: 'x'.repeat(61) })).toBe('the search bar title element');
    expect(targetName({ kind: 'text', value: 'System' }, { label: 'Other' })).toBe('"System"');
  });
});

describe('describeMaestroStep', () => {
  // One example per kind of MaestroStep; the Record type makes the compiler
  // ask for a new entry whenever the union gains a kind.
  const everyKind: Record<MaestroStep['kind'], MaestroStep> = {
    launchApp: { kind: 'launchApp' },
    runFlow: { kind: 'runFlow', file: 'blocks/login.yaml' },
    tapOn: { kind: 'tapOn', selector: system },
    longPressOn: { kind: 'longPressOn', selector: system },
    doubleTapOn: { kind: 'doubleTapOn', selector: system },
    pressKey: { kind: 'pressKey', key: 'Volume Up' },
    setOrientation: { kind: 'setOrientation', orientation: 'LANDSCAPE_LEFT' },
    inputText: { kind: 'inputText', text: 'hello' },
    eraseText: { kind: 'eraseText' },
    back: { kind: 'back' },
    hideKeyboard: { kind: 'hideKeyboard' },
    assertVisible: { kind: 'assertVisible', selector: system },
    assertNotVisible: { kind: 'assertNotVisible', selector: system },
    openLink: { kind: 'openLink', link: 'myapp://claims/7' },
    wait: { kind: 'wait', seconds: 20 },
    takeScreenshot: { kind: 'takeScreenshot', path: 'step-1' },
    startRecording: { kind: 'startRecording', path: 'run-video', optional: true },
    stopRecording: { kind: 'stopRecording' },
    scroll: { kind: 'scroll' },
    swipe: { kind: 'swipe', direction: 'UP' },
    scrollUntilVisible: { kind: 'scrollUntilVisible', selector: system, direction: 'DOWN' },
  };

  it('gives every kind of step a non-empty sentence without leftovers', () => {
    for (const [kind, step] of Object.entries(everyKind)) {
      const text = describeMaestroStep(step);
      expect(text, kind).not.toBe('');
      expect(text, kind).not.toMatch(/undefined|\[object|NaN/);
      expect(text, kind).toMatch(/^[A-Z]/);
    }
  });

  it('describes a launch with and without clearing the app data', () => {
    expect(describeMaestroStep({ kind: 'launchApp' })).toBe('Start the app');
    expect(describeMaestroStep({ kind: 'launchApp', clearState: false })).toBe('Start the app');
    expect(describeMaestroStep({ kind: 'launchApp', clearState: true })).toBe('Start the app with its data cleared');
  });

  it('names the file of a runFlow, whether or not it passes env', () => {
    expect(describeMaestroStep({ kind: 'runFlow', file: 'blocks/login.yaml' })).toBe('Run blocks/login.yaml');
    expect(describeMaestroStep({ kind: 'runFlow', file: '../blocks/login.yaml', env: { USERNAME: '${USERNAME}' } })).toBe(
      'Run ../blocks/login.yaml',
    );
  });

  it('describes taps and checks by text, id, index and point', () => {
    expect(describeMaestroStep({ kind: 'tapOn', selector: { kind: 'text', value: 'Log in' } })).toBe('Tap "Log in"');
    expect(describeMaestroStep({ kind: 'tapOn', selector: { kind: 'text', value: 'OK', index: 1 } })).toBe('Tap "OK" (number 2 on screen)');
    expect(describeMaestroStep({ kind: 'tapOn', selector: { kind: 'id', value: 'com\\.insurer\\.app:id/btn_login' } })).toBe(
      'Tap the btn login element',
    );
    expect(describeMaestroStep({ kind: 'tapOn', selector: { kind: 'id', value: 'com.app:id/submitButton', index: 0 } })).toBe(
      'Tap the submit button element (number 1 on screen)',
    );
    expect(describeMaestroStep({ kind: 'tapOn', selector: { kind: 'point', xPercent: 50, yPercent: 30 } })).toBe(
      'Tap the point at 50% across, 30% down',
    );
    expect(describeMaestroStep({ kind: 'assertVisible', selector: { kind: 'text', value: 'Welcome' } })).toBe('Check that "Welcome" is visible');
    expect(describeMaestroStep({ kind: 'assertVisible', selector: { kind: 'id', value: 'com.app:id/home_banner' } })).toBe(
      'Check that the home banner element is visible',
    );
    expect(describeMaestroStep({ kind: 'assertNotVisible', selector: { kind: 'text', value: 'Error' } })).toBe('Check that "Error" is not visible');
    expect(describeMaestroStep({ kind: 'assertNotVisible', selector: { kind: 'id', value: 'android:id/progress' } })).toBe(
      'Check that the progress element is not visible',
    );
  });

  it('removes the regex escaping Maestro needs from text selectors', () => {
    expect(describeMaestroStep({ kind: 'assertVisible', selector: { kind: 'text', value: 'Storage \\(64 GB\\)' } })).toBe(
      'Check that "Storage (64 GB)" is visible',
    );
  });

  it('types plain text in quotes and shows a ${KEY} placeholder as a value from .env', () => {
    expect(describeMaestroStep({ kind: 'inputText', text: 'ba@example.com' })).toBe('Type "ba@example.com"');
    expect(describeMaestroStep({ kind: 'inputText', text: '${PASSWORD}' })).toBe('Type the PASSWORD value from .env');
    expect(describeMaestroStep({ kind: 'inputText', text: '${USERNAME}' })).toBe('Type the USERNAME value from .env');
    // Only a whole placeholder is a secret reference; text around it stays literal.
    expect(describeMaestroStep({ kind: 'inputText', text: 'pw-${PASSWORD}' })).toBe('Type "pw-${PASSWORD}"');
  });

  it('erases the text, or a number of characters', () => {
    expect(describeMaestroStep({ kind: 'eraseText' })).toBe('Erase the text');
    expect(describeMaestroStep({ kind: 'eraseText', chars: 12 })).toBe('Erase 12 characters');
    expect(describeMaestroStep({ kind: 'eraseText', chars: 0 })).toBe('Erase 0 characters');
  });

  it('describes the commands that take no target', () => {
    expect(describeMaestroStep({ kind: 'back' })).toBe('Press Back');
    expect(describeMaestroStep({ kind: 'hideKeyboard' })).toBe('Hide the keyboard');
    expect(describeMaestroStep({ kind: 'scroll' })).toBe('Scroll down');
    expect(describeMaestroStep({ kind: 'takeScreenshot', path: 'after-login' })).toBe('Take a screenshot');
    expect(describeMaestroStep({ kind: 'takeScreenshot', path: 'after-login', optional: true })).toBe('Take a screenshot');
    expect(describeMaestroStep({ kind: 'openLink', link: 'https://example.com/claims?id=7' })).toBe(
      'Open the link https://example.com/claims?id=7',
    );
  });

  it('describes a Wait in seconds, and one second in the singular', () => {
    expect(describeMaestroStep({ kind: 'wait', seconds: 20 })).toBe('Wait 20 seconds');
    expect(describeMaestroStep({ kind: 'wait', seconds: 1 })).toBe('Wait 1 second');
  });

  it('writes swipe and scroll directions in lower case', () => {
    for (const direction of ['UP', 'DOWN', 'LEFT', 'RIGHT'] as const) {
      expect(describeMaestroStep({ kind: 'swipe', direction })).toBe(`Swipe ${direction.toLowerCase()}`);
    }
    expect(describeMaestroStep({ kind: 'scrollUntilVisible', direction: 'DOWN', selector: { kind: 'text', value: 'Terms' } })).toBe(
      'Scroll down until "Terms" is visible',
    );
    expect(
      describeMaestroStep({
        kind: 'scrollUntilVisible',
        direction: 'UP',
        selector: { kind: 'id', value: 'com.app:id/page_header' },
        timeoutMs: 5000,
        speed: 40,
        visibilityPercentage: 100,
        centerElement: true,
      }),
    ).toBe('Scroll up until the page header element is visible');
  });

  it('describes the steps of a parsed developer-written block in order', () => {
    const flow = parseMaestroFlow(
      [
        'appId: com.android.settings',
        '---',
        '- launchApp:',
        '    clearState: true',
        '- tapOn: Log in',
        '- tapOn:',
        '    id: com.app:id/user_name',
        '- inputText: ${USERNAME}',
        '- eraseText: 4',
        '- inputText: ${PASSWORD}',
        '- hideKeyboard',
        '- scrollUntilVisible:',
        '    element: Terms',
        '- assertVisible: Welcome',
        '',
      ].join('\n'),
    );
    expect(flow.steps.map(describeMaestroStep)).toEqual([
      'Start the app with its data cleared',
      'Tap "Log in"',
      'Tap the user name element',
      'Type the USERNAME value from .env',
      'Erase 4 characters',
      'Type the PASSWORD value from .env',
      'Hide the keyboard',
      'Scroll down until "Terms" is visible',
      'Check that "Welcome" is visible',
    ]);
  });
});

describe('run video steps', () => {
  it('describes starting and stopping the run video', () => {
    expect(describeMaestroStep({ kind: 'startRecording', path: 'run-video', optional: true })).toBe('Start the run video');
    expect(describeMaestroStep({ kind: 'startRecording', path: 'other' })).toBe('Start the run video');
    expect(describeMaestroStep({ kind: 'stopRecording' })).toBe('Stop the run video');
  });
});

describe('formatDuration', () => {
  it('formats milliseconds, seconds and minutes', () => {
    const cases: Array<[number, string]> = [
      [420, '420 ms'],
      [0, '0 ms'],
      [999, '999 ms'],
      [1000, '1.0 s'],
      [3100, '3.1 s'],
      [59_900, '59.9 s'],
      [60_000, '1 min 0 s'],
      [65_000, '1 min 5 s'],
    ];
    for (const [ms, text] of cases) expect(formatDuration(ms), String(ms)).toBe(text);
  });

  it('never shows 60 seconds or more in the seconds form', () => {
    for (const ms of [59_949, 59_950, 59_999]) expect(formatDuration(ms), String(ms)).not.toMatch(/^60/);
  });
});
