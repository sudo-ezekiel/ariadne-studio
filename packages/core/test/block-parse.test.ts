import { describe, expect, it } from 'vitest';
import { parseBlockFlow } from '../src/maestro/block-parse.ts';
import { MaestroParseError } from '../src/maestro/parse.ts';

describe('parseBlockFlow', () => {
  it('keeps the whole flow for a block inside the subset', () => {
    const outline = parseBlockFlow('appId: com.example\nname: Log in\n---\n- launchApp\n- inputText: "${USERNAME}"\n');
    expect(outline.flow?.steps).toEqual([{ kind: 'launchApp' }, { kind: 'inputText', text: '${USERNAME}' }]);
    expect(outline).toMatchObject({ appId: 'com.example', name: 'Log in', maestroOnly: [], variables: ['USERNAME'] });
    expect(outline.commands).toEqual([
      { kind: 'step', step: { kind: 'launchApp' } },
      { kind: 'step', step: { kind: 'inputText', text: '${USERNAME}' } },
    ]);
  });

  it('reads what it can of a block with other commands and names the rest, without a flow', () => {
    const yaml = [
      'appId: com.android.settings',
      'name: Open network',
      'env:',
      '  REGION: eu',
      '---',
      '- launchApp',
      '- waitForAnimationToEnd',
      '- runScript: setup.js',
      '- tapOn:',
      '    text: "Network & internet"',
      '    retryTapIfNoChange: false',
      '- runScript:',
      '    file: again.js',
      '    env:',
      '      USER: ${USERNAME}',
      '- assertVisible: "Internet"',
      '',
    ].join('\n');
    const outline = parseBlockFlow(yaml);
    expect(outline.flow).toBeUndefined();
    expect(outline).toMatchObject({ appId: 'com.android.settings', name: 'Open network', env: { REGION: 'eu' } });
    expect(outline.maestroOnly).toEqual(['waitForAnimationToEnd', 'runScript', 'tapOn']);
    expect(outline.commands).toEqual([
      { kind: 'step', step: { kind: 'launchApp' } },
      { kind: 'maestro', command: 'waitForAnimationToEnd' },
      { kind: 'maestro', command: 'runScript' },
      { kind: 'maestro', command: 'tapOn' },
      { kind: 'maestro', command: 'runScript' },
      { kind: 'step', step: { kind: 'assertVisible', selector: { kind: 'text', value: 'Internet' } } },
    ]);
    // Variables in commands Ariadne does not read still count.
    expect(outline.variables).toEqual(['USERNAME']);
  });

  it('names header keys outside appId, name and env, and the variables their commands use', () => {
    const outline = parseBlockFlow('appId: com.example\ntags:\n  - smoke\nonFlowStart:\n  - inputText: "${PIN}"\n---\n- launchApp\n');
    expect(outline.flow).toBeUndefined();
    expect(outline.maestroOnly).toEqual(['tags', 'onFlowStart']);
    expect(outline.commands).toEqual([{ kind: 'step', step: { kind: 'launchApp' } }]);
    expect(outline.variables).toEqual(['PIN']);
  });

  it('sends a Wait with a custom label to Maestro and keeps its block variable', () => {
    const yaml = [
      'appId: com.example',
      '---',
      '- launchApp',
      '- extendedWaitUntil:',
      '    visible: "ariadne-wait"',
      '    timeout: 20000',
      '    optional: true',
      '    label: "Wait for ${ACCOUNT}"',
      '',
    ].join('\n');
    const outline = parseBlockFlow(yaml);
    expect(outline.flow).toBeUndefined();
    expect(outline.maestroOnly).toEqual(['extendedWaitUntil']);
    expect(outline.commands).toEqual([{ kind: 'step', step: { kind: 'launchApp' } }, { kind: 'maestro', command: 'extendedWaitUntil' }]);
    expect(outline.variables).toEqual(['ACCOUNT']);
  });

  it.each([
    ['invalid YAML', 'appId: com.example\n---\n- tapOn: [\n'],
    ['no header', '- launchApp\n'],
    ['a config file', 'flows:\n  - "*"\nincludeTags:\n  - smoke\n'],
    ['no appId', 'name: x\n---\n- launchApp\n'],
    ['a body that is not a list', 'appId: com.example\n---\nlaunchApp: true\n'],
    ['a command that is not one command', 'appId: com.example\n---\n- tapOn: x\n  back: y\n'],
    ['env that is not a mapping', 'appId: com.example\nenv: 3\n---\n- pressKey: Enter\n'],
  ])('refuses %s', (_what, yaml) => {
    expect(() => parseBlockFlow(yaml)).toThrow(MaestroParseError);
  });
});
