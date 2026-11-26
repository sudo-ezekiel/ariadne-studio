import { describe, expect, it } from 'vitest';
import { toMaestroYaml } from '../src/maestro/emit.ts';
import { escapeMaestroRegex, unescapeMaestroRegex } from '../src/maestro/escape.ts';
import type { MaestroKey, MaestroOrientation, MaestroSelector, MaestroStep, SwipeDirection } from '../src/maestro/model.ts';
import { describeSelector } from '../src/maestro/model.ts';
import type { CaseStep } from '../src/recorder/case-types.ts';
import { describeMaestroStep, describeStep } from '../src/recorder/describe.ts';
// The landing page demo re-implements the YAML writer and the step wording so the
// page needs no build step. These tests fail the day the page and the product drift apart.
// @ts-expect-error flow.js is plain JavaScript with no type declarations
import * as site from '../../../site/assets/flow.js';

type SiteSelector = { kind: 'id' | 'text'; value: string } | { kind: 'point'; xPercent: number; yPercent: number };
type SiteStep =
  | { kind: 'tap' | 'check'; selector: SiteSelector; name?: string }
  | { kind: 'type'; text: string }
  | { kind: 'back' }
  | { kind: 'key'; key: string }
  | { kind: 'swipe'; direction: SwipeDirection }
  | { kind: 'rotate'; orientation: MaestroOrientation };

const flow = site as {
  APP_ID: string;
  toMaestroYaml(input: { appId?: string; name?: string; steps: SiteStep[] }): string;
  escapeMaestroRegex(value: string): string;
  selectorFor(element: { id?: string; text?: string }, appId?: string): SiteSelector;
  describeSelector(selector: SiteSelector): string;
  stepWords(step: SiteStep): { kind: string; text: string; selector?: string };
};

const appId = 'com.example.agenda';

/** The product's own step for a demo step. */
function coreStep(step: SiteStep): MaestroStep {
  switch (step.kind) {
    case 'tap':
      return { kind: 'tapOn', selector: step.selector as MaestroSelector };
    case 'check':
      return { kind: 'assertVisible', selector: step.selector as MaestroSelector };
    case 'type':
      return { kind: 'inputText', text: step.text };
    case 'back':
      return { kind: 'back' };
    case 'key':
      return { kind: 'pressKey', key: step.key as MaestroKey };
    case 'swipe':
      return { kind: 'swipe', direction: step.direction };
    case 'rotate':
      return { kind: 'setOrientation', orientation: step.orientation };
  }
}

function coreYaml(name: string | undefined, steps: SiteStep[]): string {
  return toMaestroYaml({ appId, ...(name === undefined ? {} : { name }), steps: [{ kind: 'launchApp' }, ...steps.map(coreStep)] });
}

function expectSameYaml(steps: SiteStep[], name: string | undefined = 'Create an event'): void {
  expect(flow.toMaestroYaml({ appId, ...(name === undefined ? {} : { name }), steps })).toBe(coreYaml(name, steps));
}

const idOf = (value: string): SiteSelector => ({ kind: 'id', value });
const textOf = (value: string): SiteSelector => ({ kind: 'text', value });

describe('site demo YAML against core toMaestroYaml', () => {
  it('writes the scripted demo case byte for byte like core', () => {
    const steps: SiteStep[] = [
      { kind: 'tap', selector: flow.selectorFor({ id: 'fab_new_event' }), name: 'New event' },
      { kind: 'type', text: 'Dentist' },
      { kind: 'tap', selector: flow.selectorFor({ id: 'event_location' }), name: 'Location' },
      { kind: 'type', text: 'Athens' },
      { kind: 'tap', selector: flow.selectorFor({ id: 'save' }), name: 'Save' },
      { kind: 'check', selector: flow.selectorFor({ id: 'event_item_title' }), name: 'Dentist' },
    ];
    expect(flow.toMaestroYaml({ appId, name: 'Create an event', steps })).toBe(coreYaml('Create an event', steps));
    expect(flow.toMaestroYaml({ name: 'Create an event', steps })).toBe(coreYaml('Create an event', steps));
  });

  it('picks the id selector with the app id prefix, as the product does', () => {
    expect(flow.selectorFor({ id: 'fab_new_event', text: 'New' })).toEqual({ kind: 'id', value: 'com\\.example\\.agenda:id/fab_new_event' });
    expect(flow.selectorFor({ text: 'Save (all)' })).toEqual({ kind: 'text', value: 'Save \\(all\\)' });
  });

  it('writes tap and check by id, by text and by point like core', () => {
    expectSameYaml([
      { kind: 'tap', selector: idOf('com\\.example\\.agenda:id/save'), name: 'Save' },
      { kind: 'tap', selector: textOf('Save'), name: 'Save' },
      { kind: 'tap', selector: { kind: 'point', xPercent: 50, yPercent: 70 } },
      { kind: 'check', selector: idOf('com\\.example\\.agenda:id/title'), name: 'Title' },
      { kind: 'check', selector: textOf('Dentist'), name: 'Dentist' },
      { kind: 'check', selector: { kind: 'point', xPercent: 5, yPercent: 95 } },
    ]);
  });

  it('writes type, back, swipe and rotate like core', () => {
    expectSameYaml([
      { kind: 'type', text: 'Dentist' },
      { kind: 'back' },
      { kind: 'swipe', direction: 'LEFT' },
      { kind: 'swipe', direction: 'RIGHT' },
      { kind: 'swipe', direction: 'UP' },
      { kind: 'swipe', direction: 'DOWN' },
      { kind: 'rotate', orientation: 'LANDSCAPE_LEFT' },
      { kind: 'rotate', orientation: 'PORTRAIT' },
      { kind: 'rotate', orientation: 'LANDSCAPE_RIGHT' },
      { kind: 'rotate', orientation: 'UPSIDE_DOWN' },
    ]);
  });

  it('writes every key name the demo uses like core', () => {
    for (const key of ['Home', 'Enter', 'Volume Up', 'Volume Down', 'Power']) {
      expectSameYaml([{ kind: 'key', key }]);
    }
  });

  it('writes the case name like core, with and without special characters', () => {
    const steps: SiteStep[] = [{ kind: 'back' }];
    for (const name of ['Create an event', 'Login', 'yes', 'true', 'Check: the total', 'Edit event 2']) {
      expectSameYaml(steps, name);
    }
    expect(flow.toMaestroYaml({ appId, steps })).toBe(coreYaml(undefined, steps));
  });

  it('writes a non-ASCII case name like core', () => {
    expectSameYaml([{ kind: 'back' }], 'Ραντεβού');
  });

  it('writes awkward typed text and text selectors like core', () => {
    const awkward = [
      'say "hi"',
      'C:\\temp\\file',
      '${PASSWORD}',
      'a.b (c) + d? e*',
      '[x] ^y$ {z} | w',
      'Ραντεβού',
      'yes',
      'no',
      'true',
      'null',
      '123',
      '1.5',
      ': colon # hash',
      '',
      ' padded ',
    ];
    for (const text of awkward) {
      expectSameYaml([
        { kind: 'type', text },
        { kind: 'tap', selector: textOf(escapeMaestroRegex(text)), name: text },
        { kind: 'check', selector: textOf(escapeMaestroRegex(text)), name: text },
        { kind: 'tap', selector: idOf(escapeMaestroRegex(text)), name: text },
      ]);
    }
  });

  it('writes control characters in typed text like core', () => {
    for (const text of ['line one\nline two', 'tab\there']) {
      expectSameYaml([{ kind: 'type', text }]);
    }
  });

  it('writes the rarer control characters in typed text like core', () => {
    for (const code of [0x00, 0x07, 0x08, 0x0b, 0x0c, 0x0d, 0x1b, 0x7f]) {
      expectSameYaml([{ kind: 'type', text: `a${String.fromCharCode(code)}b` }]);
    }
  });

  it('writes an app id the way core does', () => {
    for (const id of ['com.example.agenda', 'org.example.app_2', 'com.android.settings']) {
      expect(flow.toMaestroYaml({ appId: id, name: 'x', steps: [] })).toBe(toMaestroYaml({ appId: id, name: 'x', steps: [{ kind: 'launchApp' }] }));
    }
  });
});

describe('site demo regex escaping against core', () => {
  it('escapes every input the way core does', () => {
    const inputs = [
      '',
      'plain',
      'Network & internet',
      'com.example.agenda:id/save',
      '. * + ? ^ $ { } ( ) | [ ] \\',
      '${PASSWORD}',
      'Storage (64 GB)',
      'say "hi"',
      'Price: $9.99+tax',
      'a|b',
      'Ραντεβού',
      'yes',
      '123',
    ];
    for (const value of inputs) {
      expect(flow.escapeMaestroRegex(value)).toBe(escapeMaestroRegex(value));
    }
  });
});

describe('site demo wording against core', () => {
  const named = (selector: SiteSelector, name: string) => ({ kind: 'tap' as const, selector, name });

  function coreTap(selector: SiteSelector, name?: string): string {
    const step = {
      index: 1,
      kind: 'tap',
      selector,
      point: { x: 1, y: 2 },
      at: '2026-10-31T10:00:00.000Z',
      ...(name === undefined ? {} : { node: { text: name } }),
    } as unknown as CaseStep;
    return describeStep(step);
  }

  it('words a tap on an element by id like core when the element has a name', () => {
    const selector = idOf('com\\.example\\.agenda:id/fab_new_event');
    expect(flow.stepWords(named(selector, 'New event')).text).toBe(coreTap(selector, 'New event'));
  });

  it('words a tap on text like core', () => {
    for (const value of ['Save', 'Storage (64 GB)', 'say "hi"', 'Ραντεβού']) {
      const selector = textOf(escapeMaestroRegex(value));
      expect(flow.stepWords(named(selector, value)).text).toBe(coreTap(selector));
    }
  });

  it('words a tap by position like core, with and without a name', () => {
    const point: SiteSelector = { kind: 'point', xPercent: 50, yPercent: 70 };
    expect(flow.stepWords(named(point, 'Save')).text).toBe(coreTap(point, 'Save'));
    expect(flow.stepWords({ kind: 'tap', selector: point }).text).toBe(coreTap(point));
  });

  it('words a check like core', () => {
    const id = idOf('com\\.example\\.agenda:id/event_item_title');
    const text = textOf('Dentist');
    const point: SiteSelector = { kind: 'point', xPercent: 10, yPercent: 20 };
    const coreCheck = (selector: SiteSelector, name?: string) =>
      describeStep({
        index: 1,
        kind: 'expect',
        selector,
        at: '2026-10-31T10:00:00.000Z',
        ...(name === undefined ? {} : { node: { text: name } }),
      } as unknown as CaseStep);
    expect(flow.stepWords({ kind: 'check', selector: id, name: 'Dentist' }).text).toBe(coreCheck(id, 'Dentist'));
    expect(flow.stepWords({ kind: 'check', selector: text, name: 'Dentist' }).text).toBe(coreCheck(text));
    expect(flow.stepWords({ kind: 'check', selector: point, name: 'Dentist' }).text).toBe(coreCheck(point, 'Dentist'));
    expect(flow.stepWords({ kind: 'check', selector: point }).text).toBe(coreCheck(point));
  });

  it('words a tap and a check on a text selector like core describeMaestroStep', () => {
    const selector = textOf('Wi\\-Fi'.replace('\\-', '-'));
    expect(flow.stepWords({ kind: 'tap', selector, name: 'Wi-Fi' }).text).toBe(describeMaestroStep({ kind: 'tapOn', selector: selector as MaestroSelector }));
    expect(flow.stepWords({ kind: 'check', selector, name: 'Wi-Fi' }).text).toBe(describeMaestroStep({ kind: 'assertVisible', selector: selector as MaestroSelector }));
  });

  it('words type, back and swipe like core', () => {
    const base = { index: 1, at: '2026-10-31T10:00:00.000Z' };
    expect(flow.stepWords({ kind: 'type', text: 'Dentist' }).text).toBe(describeStep({ ...base, kind: 'type', text: 'Dentist' } as unknown as CaseStep));
    expect(flow.stepWords({ kind: 'type', text: 'say "hi"' }).text).toBe(describeMaestroStep({ kind: 'inputText', text: 'say "hi"' }));
    expect(flow.stepWords({ kind: 'back' }).text).toBe(describeMaestroStep({ kind: 'back' }));
    for (const direction of ['LEFT', 'RIGHT', 'UP', 'DOWN'] as const) {
      expect(flow.stepWords({ kind: 'swipe', direction }).text).toBe(describeMaestroStep({ kind: 'swipe', direction }));
    }
  });

  it('words each phone key like core', () => {
    const keys: [string, 'home' | 'enter' | 'volumeUp' | 'volumeDown' | 'power'][] = [
      ['Home', 'home'],
      ['Enter', 'enter'],
      ['Volume Up', 'volumeUp'],
      ['Volume Down', 'volumeDown'],
      ['Power', 'power'],
    ];
    for (const [maestroKey, phoneKey] of keys) {
      const core = describeStep({ index: 1, kind: 'pressKey', key: phoneKey, at: '2026-10-31T10:00:00.000Z' } as unknown as CaseStep);
      expect(flow.stepWords({ kind: 'key', key: maestroKey }).text).toBe(core);
    }
  });

  it('words each rotation like core', () => {
    for (const orientation of ['PORTRAIT', 'LANDSCAPE_LEFT', 'LANDSCAPE_RIGHT', 'UPSIDE_DOWN'] as const) {
      expect(flow.stepWords({ kind: 'rotate', orientation }).text).toBe(describeMaestroStep({ kind: 'setOrientation', orientation }));
    }
    expect(flow.stepWords({ kind: 'rotate', orientation: 'LANDSCAPE_LEFT' }).text).toBe(
      describeStep({ index: 1, kind: 'orientation', value: 'landscape', at: '2026-10-31T10:00:00.000Z' } as unknown as CaseStep),
    );
    expect(flow.stepWords({ kind: 'rotate', orientation: 'PORTRAIT' }).text).toBe(
      describeStep({ index: 1, kind: 'orientation', value: 'portrait', at: '2026-10-31T10:00:00.000Z' } as unknown as CaseStep),
    );
  });

  it('describes id and point selectors like core describeSelector', () => {
    const id = idOf('com\\.example\\.agenda:id/save');
    const point: SiteSelector = { kind: 'point', xPercent: 50, yPercent: 70 };
    // The page quotes the point the way the YAML does, core prints it bare. Compare without the quotes.
    expect(flow.describeSelector(point).replaceAll('"', '')).toBe(describeSelector(point as MaestroSelector));
    // The page shows an id unescaped, core prints the stored value. Compare on the unescaped value.
    expect(flow.describeSelector(id)).toBe(describeSelector({ kind: 'id', value: unescapeMaestroRegex(id.kind === 'id' ? id.value : '') }));
  });

  it('describes a text selector as the page does, from the value core would unescape', () => {
    // Core's describeSelector has no quoting, so the page's quoted form is compared to a built string.
    for (const value of ['Save', 'Storage (64 GB)', 'Price: $9.99+tax']) {
      expect(flow.describeSelector(textOf(escapeMaestroRegex(value)))).toBe(`text: "${value}"`);
    }
  });
});
