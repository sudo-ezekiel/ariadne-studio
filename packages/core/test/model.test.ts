import { describe, expect, it } from 'vitest';
import { flowVariables, type MaestroStep } from '../src/maestro/model.ts';
import { parseMaestroFlow } from '../src/maestro/parse.ts';

describe('flowVariables', () => {
  it('returns nothing for a flow without variables or steps', () => {
    expect(flowVariables({ steps: [] })).toEqual([]);
    expect(flowVariables({ steps: [{ kind: 'launchApp' }, { kind: 'tapOn', selector: { kind: 'text', value: 'Log in' } }, { kind: 'back' }] })).toEqual([]);
  });

  it('returns the names sorted and without repeats', () => {
    const steps: MaestroStep[] = [
      { kind: 'inputText', text: '${USERNAME}' },
      { kind: 'inputText', text: '${PASSWORD}' },
      { kind: 'tapOn', selector: { kind: 'text', value: '${USERNAME}' } },
      { kind: 'inputText', text: '${ACCOUNT}' },
    ];
    expect(flowVariables({ steps })).toEqual(['ACCOUNT', 'PASSWORD', 'USERNAME']);
  });

  it('finds a variable anywhere in a step, not only in typed text', () => {
    const steps: MaestroStep[] = [
      { kind: 'tapOn', selector: { kind: 'text', value: 'Hello ${NAME}' } },
      { kind: 'assertVisible', selector: { kind: 'id', value: 'com.app:id/${ROW_ID}', index: 0 } },
      { kind: 'openLink', link: 'https://${HOST}/claims' },
      { kind: 'takeScreenshot', path: 'shot-${RUN}' },
      { kind: 'runFlow', file: 'blocks/other.yaml', env: { TOKEN: '${TOKEN}' } },
    ];
    expect(flowVariables({ steps })).toEqual(['HOST', 'NAME', 'ROW_ID', 'RUN', 'TOKEN']);
  });

  it('finds several variables in one string', () => {
    expect(flowVariables({ steps: [{ kind: 'inputText', text: '${FIRST}-${SECOND}${FIRST}' }] })).toEqual(['FIRST', 'SECOND']);
  });

  it('accepts letters, digits and underscores, starting with a letter or underscore', () => {
    const steps: MaestroStep[] = [{ kind: 'inputText', text: '${_hidden} ${user2} ${A_1}' }];
    expect(flowVariables({ steps })).toEqual(['A_1', '_hidden', 'user2']);
  });

  it('ignores JavaScript expressions such as ${output.id}', () => {
    const steps: MaestroStep[] = [
      { kind: 'inputText', text: '${output.id}' },
      { kind: 'inputText', text: '${output.user.name}' },
      { kind: 'inputText', text: '${1 + 1}' },
      { kind: 'inputText', text: "${maestro.copiedText || 'x'}" },
      { kind: 'inputText', text: '${ SPACED }' },
      { kind: 'inputText', text: '${}' },
      { kind: 'inputText', text: '${9LIVES}' },
    ];
    expect(flowVariables({ steps })).toEqual([]);
  });

  it('counts only the plain names when a step mixes both', () => {
    expect(flowVariables({ steps: [{ kind: 'inputText', text: '${output.id}-${PASSWORD}' }] })).toEqual(['PASSWORD']);
  });

  it('ignores text that only looks similar', () => {
    const steps: MaestroStep[] = [
      { kind: 'inputText', text: '$PASSWORD' },
      { kind: 'inputText', text: '{PASSWORD}' },
      { kind: 'inputText', text: '${PASSWORD' },
      { kind: 'inputText', text: 'PASSWORD}' },
    ];
    expect(flowVariables({ steps })).toEqual([]);
  });

  it('works on the steps of a parsed flow, ignoring its header', () => {
    const flow = parseMaestroFlow(
      ['appId: com.example.${NOT_A_STEP}', 'env:', '  HEADER_ONLY: x', '---', '- inputText: ${USERNAME}', '- inputText: ${PASSWORD}', ''].join('\n'),
    );
    expect(flowVariables(flow)).toEqual(['PASSWORD', 'USERNAME']);
  });

  it('does not change the flow', () => {
    const steps: MaestroStep[] = [{ kind: 'inputText', text: '${B} ${A}' }];
    const snapshot = JSON.stringify(steps);
    flowVariables({ steps });
    expect(JSON.stringify(steps)).toBe(snapshot);
  });
});
