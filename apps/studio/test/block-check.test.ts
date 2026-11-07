// The rules a block written in the Blocks tab must meet, shared by the form
// (to say what is missing) and the server (to refuse what breaks them).
import { describe, expect, it } from 'vitest';
import type { MaestroSelector, MaestroStep } from '@ariadne/core/model';
import { blockProblem, hideSavedValues, isOpenableLink } from '../src/shared/block-check.ts';

const text = (value: string): MaestroSelector => ({ kind: 'text', value });
const point: MaestroSelector = { kind: 'point', xPercent: 50, yPercent: 50 };
const ok: MaestroStep[] = [{ kind: 'launchApp' }];

describe('blockProblem name and steps', () => {
  it('accepts a named block with a step', () => {
    expect(blockProblem('Log in', ok)).toBeUndefined();
  });

  it.each(['', '   '])('refuses the empty name %j', (name) => {
    expect(blockProblem(name, ok)).toMatch(/name/);
  });

  it('accepts a name of 80 characters and refuses one of 81', () => {
    expect(blockProblem('a'.repeat(80), ok)).toBeUndefined();
    expect(blockProblem('a'.repeat(81), ok)).toMatch(/at most 80/);
  });

  it('refuses a name with a line break', () => {
    expect(blockProblem('Log\nin', ok)).toMatch(/one line/);
  });

  it('refuses a block with no steps', () => {
    expect(blockProblem('Log in', [])).toBe('Add at least one step.');
  });
});

describe('blockProblem per step', () => {
  it.each<[string, MaestroStep]>([
    ['an empty tap target', { kind: 'tapOn', selector: text('') }],
    ['a blank long press target', { kind: 'longPressOn', selector: text('  ') }],
    ['an empty double tap target', { kind: 'doubleTapOn', selector: text('') }],
    ['an empty check', { kind: 'assertVisible', selector: text('') }],
    ['an empty not-visible check', { kind: 'assertNotVisible', selector: text('') }],
    ['an empty scroll to target', { kind: 'scrollUntilVisible', selector: text(''), direction: 'DOWN' }],
    ['empty typed text', { kind: 'inputText', text: '' }],
    ['typed text with a line break', { kind: 'inputText', text: 'a\nb' }],
    ['a setting with no name in typed text', { kind: 'inputText', text: '${}' }],
    ['a setting with no name in a selector', { kind: 'tapOn', selector: text('${}') }],
    ['an empty link', { kind: 'openLink', link: '' }],
  ])('refuses %s and names step 2', (_what, step) => {
    const problem = blockProblem('Log in', [{ kind: 'launchApp' }, step]);
    expect(problem).toMatch(/^Step 2 /);
  });

  it('says a setting with no name needs a name', () => {
    expect(blockProblem('Log in', [{ kind: 'inputText', text: '${}' }])).toBe('Step 1 needs a name for its setting.');
  });

  it('allows a point on a tap, a long press and a double tap', () => {
    for (const kind of ['tapOn', 'longPressOn', 'doubleTapOn'] as const) {
      expect(blockProblem('Log in', [{ kind, selector: point }])).toBeUndefined();
    }
  });

  it.each(['assertVisible', 'assertNotVisible', 'scrollUntilVisible'] as const)('refuses a point on %s', (kind) => {
    const step = kind === 'scrollUntilVisible' ? { kind, selector: point, direction: 'DOWN' as const } : { kind, selector: point };
    expect(blockProblem('Log in', [...ok, step])).toMatch(/^Step 2 .*point on the screen/);
  });

  it.each([0, 121, 1.5, -1, Number.NaN])('refuses a wait of %s seconds', (seconds) => {
    expect(blockProblem('Log in', [...ok, { kind: 'wait', seconds }])).toBe('Step 2 must wait 1 to 120 seconds.');
  });

  it.each([1, 60, 120])('accepts a wait of %s seconds', (seconds) => {
    expect(blockProblem('Log in', [{ kind: 'wait', seconds }])).toBeUndefined();
  });

  it.each([0, -3, 1.5])('refuses to erase %s characters', (chars) => {
    expect(blockProblem('Log in', [...ok, { kind: 'eraseText', chars }])).toBe('Step 2 must erase at least 1 character.');
  });

  it('accepts erasing a number of characters, and erasing all text', () => {
    expect(blockProblem('Log in', [{ kind: 'eraseText', chars: 1 }])).toBeUndefined();
    expect(blockProblem('Log in', [{ kind: 'eraseText' }])).toBeUndefined();
  });

  it('reports the first broken step, not a later one', () => {
    const steps: MaestroStep[] = [{ kind: 'inputText', text: 'ok' }, { kind: 'wait', seconds: 0 }, { kind: 'inputText', text: '' }];
    expect(blockProblem('Log in', steps)).toMatch(/^Step 2 /);
  });
});

describe('blockProblem openLink', () => {
  const problemOf = (link: string) => blockProblem('Log in', [{ kind: 'openLink', link }]);

  it.each(['https://example.com/claims', 'http://example.com', 'myapp://claims/123', '${URL}'])('accepts %s', (link) => {
    expect(problemOf(link)).toBeUndefined();
  });

  it.each(['file:///etc/passwd', 'content://contacts/people', 'javascript:alert(1)', 'example.com/claims', 'https://has space.com', '${URL} extra'])(
    'refuses %s',
    (link) => {
      expect(problemOf(link)).toMatch(/^Step 1 needs a link/);
    },
  );
});

describe('isOpenableLink', () => {
  it.each(['https://example.com/claims', 'myapp://claims/123', 'com.app+x://a'])('passes %s', (url) => {
    expect(isOpenableLink(url)).toBe(true);
  });

  it.each(['file:///etc/passwd', 'FILE://x/y', 'content://a/b', 'javascript://x', 'example.com', 'https://', '${URL}'])('refuses %s', (url) => {
    expect(isOpenableLink(url)).toBe(false);
  });

  it('refuses a link longer than 2000 characters', () => {
    expect(isOpenableLink(`https://example.com/${'a'.repeat(1980)}`)).toBe(true);
    expect(isOpenableLink(`https://example.com/${'a'.repeat(1981)}`)).toBe(false);
  });
});

describe('hideSavedValues', () => {
  const env = { PASSWORD: 'hunter22', PIN: '123', API: 'abcd' };

  it('turns typed text equal to a saved value into its reference', () => {
    expect(hideSavedValues([{ kind: 'inputText', text: 'hunter22' }], env)).toEqual([{ kind: 'inputText', text: '${PASSWORD}' }]);
  });

  it('hides a value of exactly 4 characters', () => {
    expect(hideSavedValues([{ kind: 'inputText', text: 'abcd' }], env)).toEqual([{ kind: 'inputText', text: '${API}' }]);
  });

  it('leaves a value shorter than 4 characters', () => {
    expect(hideSavedValues([{ kind: 'inputText', text: '123' }], env)).toEqual([{ kind: 'inputText', text: '123' }]);
  });

  it('leaves other text, and text that only contains a saved value', () => {
    const steps: MaestroStep[] = [{ kind: 'inputText', text: 'hello' }, { kind: 'inputText', text: 'my hunter22' }];
    expect(hideSavedValues(steps, env)).toEqual(steps);
  });

  it('leaves other kinds of step, even when they hold a saved value', () => {
    const steps: MaestroStep[] = [{ kind: 'tapOn', selector: text('hunter22') }, { kind: 'openLink', link: 'https://example.com/hunter22' }];
    expect(hideSavedValues(steps, env)).toEqual(steps);
  });

  it('does not change the steps it is given', () => {
    const steps: MaestroStep[] = [{ kind: 'inputText', text: 'hunter22' }];
    const before = JSON.stringify(steps);
    hideSavedValues(steps, env);
    expect(JSON.stringify(steps)).toBe(before);
  });
});
