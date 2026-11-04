// ProjectStore.addEnvValues (saved values and test users written to .env) and
// ProjectStore.readCase turning case files from before blocks had values into
// the BlockUse shape.
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectStore } from '../src/project/store.ts';
import type { TestCase } from '../src/recorder/case-types.ts';

let dir: string;
let store: ProjectStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ariadne-env-values-'));
  store = await ProjectStore.open(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const envFile = () => join(dir, '.env');
const readEnvText = () => readFile(envFile(), 'utf8');

describe('ProjectStore.addEnvValues', () => {
  it('creates .env when there is none', async () => {
    await store.addEnvValues({ SUPERVISOR_USERNAME: 'sup@example.com', SUPERVISOR_PASSWORD: 'hunter22' });
    expect(await readEnvText()).toBe('SUPERVISOR_USERNAME=sup@example.com\nSUPERVISOR_PASSWORD=hunter22\n');
    expect(await store.readEnv()).toEqual({ SUPERVISOR_USERNAME: 'sup@example.com', SUPERVISOR_PASSWORD: 'hunter22' });
  });

  it('appends after what is there and keeps it byte for byte', async () => {
    const before = '# test accounts\nexport USERNAME=ba@example.com\n\nPASSWORD="with spaces "\n';
    await writeFile(envFile(), before);
    await store.addEnvValues({ AGENT_USERNAME: 'maria@example.com' });
    expect(await readEnvText()).toBe(`${before}AGENT_USERNAME=maria@example.com\n`);
    expect(await store.readEnv()).toEqual({ USERNAME: 'ba@example.com', PASSWORD: 'with spaces ', AGENT_USERNAME: 'maria@example.com' });
  });

  it('starts on a new line when the file did not end with one', async () => {
    await writeFile(envFile(), 'USERNAME=ba@example.com');
    await store.addEnvValues({ AGENT_USERNAME: 'maria@example.com' });
    expect(await readEnvText()).toBe('USERNAME=ba@example.com\nAGENT_USERNAME=maria@example.com\n');
    expect(await store.readEnv()).toEqual({ USERNAME: 'ba@example.com', AGENT_USERNAME: 'maria@example.com' });
  });

  it('adds no blank line to an empty file or to one ending in a newline', async () => {
    await writeFile(envFile(), '');
    await store.addEnvValues({ A_ONE: '1' });
    expect(await readEnvText()).toBe('A_ONE=1\n');
    await store.addEnvValues({ A_TWO: '2' });
    expect(await readEnvText()).toBe('A_ONE=1\nA_TWO=2\n');
  });

  it('appends after a file written with Windows line endings', async () => {
    await writeFile(envFile(), 'USERNAME=ba@example.com\r\n');
    await store.addEnvValues({ AGENT_USERNAME: 'maria@example.com' });
    expect(await store.readEnv()).toEqual({ USERNAME: 'ba@example.com', AGENT_USERNAME: 'maria@example.com' });
  });

  it('gives back the original values through readEnv, whatever they look like', async () => {
    const values: Record<string, string> = {
      PLAIN: 'hunter22',
      EMPTY: '',
      LEADING_SPACE: ' hunter22',
      TRAILING_SPACE: 'hunter22 ',
      ONLY_SPACES: '   ',
      TAB_AROUND: '\thunter22\t',
      DOUBLE_QUOTED: '"hunter22"',
      SINGLE_QUOTED: "'hunter22'",
      LEADING_DOUBLE_QUOTE: '"hunter22',
      LEADING_SINGLE_QUOTE: "'hunter22",
      TRAILING_DOUBLE_QUOTE: 'hunter22"',
      TRAILING_SINGLE_QUOTE: "hunter22'",
      LONE_DOUBLE_QUOTE: '"',
      LONE_SINGLE_QUOTE: "'",
      QUOTE_THEN_SPACE: '" x ',
      EQUALS_INSIDE: 'a=b=c',
      HASH_FIRST: '#not-a-comment',
      HASH_INSIDE: 'pass #1',
      DOLLAR: '$5 and ${NOT_EXPANDED}',
      BACKSLASH: 'C:\\path\\',
      GREEK: 'Μαρία Παπαδοπούλου',
      EXPORT_WORD: 'export x',
    };
    await store.addEnvValues(values);
    expect(await store.readEnv()).toEqual(values);
  });

  it('quotes only the values that would otherwise change', async () => {
    await store.addEnvValues({ A_PLAIN: 'x y', A_SPACED: ' x', A_QUOTED: '"x"', A_END_QUOTE: 'x"' });
    expect(await readEnvText()).toBe('A_PLAIN=x y\nA_SPACED=" x"\nA_QUOTED=""x""\nA_END_QUOTE=x"\n');
  });

  it('adds several values in the order given, across calls too', async () => {
    await store.addEnvValues({ B_ONE: '1', A_TWO: '2' });
    await store.addEnvValues({ C_THREE: '3' });
    expect(await readEnvText()).toBe('B_ONE=1\nA_TWO=2\nC_THREE=3\n');
  });

  it('writes nothing, not even an empty .env, when there is nothing to add', async () => {
    await store.addEnvValues({});
    expect(await readdir(dir)).not.toContain('.env');
    await writeFile(envFile(), 'A=1');
    await store.addEnvValues({});
    expect(await readEnvText()).toBe('A=1');
  });

  it('treats a key that only differs in case as a different key', async () => {
    await writeFile(envFile(), 'USERNAME=a\n');
    await store.addEnvValues({ username: 'b' });
    expect(await store.readEnv()).toEqual({ USERNAME: 'a', username: 'b' });
  });

  it('makes the new keys visible to envKeys, sorted, and never exposes values there', async () => {
    await writeFile(envFile(), 'ZED=1\n');
    await store.addEnvValues({ SUPERVISOR_USERNAME: 'sup@example.com', SUPERVISOR_PASSWORD: 'hunter22' });
    expect(await store.envKeys()).toEqual(['SUPERVISOR_PASSWORD', 'SUPERVISOR_USERNAME', 'ZED']);
  });

  it('leaves no temporary file behind', async () => {
    await store.addEnvValues({ A_ONE: '1' });
    await store.addEnvValues({ A_TWO: '2' });
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  describe('refuses', () => {
    it('a key that .env already sets, and leaves .env as it was', async () => {
      await writeFile(envFile(), 'SUPERVISOR_USERNAME=old@example.com\n');
      await expect(store.addEnvValues({ SUPERVISOR_USERNAME: 'new@example.com' })).rejects.toThrow(/SUPERVISOR_USERNAME already exists/);
      expect(await readEnvText()).toBe('SUPERVISOR_USERNAME=old@example.com\n');
    });

    it('a key that project.json env sets', async () => {
      await store.updateSettings({ env: { SUPERVISOR_USERNAME: 'old@example.com' } });
      await expect(store.addEnvValues({ SUPERVISOR_USERNAME: 'new@example.com' })).rejects.toThrow(/SUPERVISOR_USERNAME already exists/);
      expect(await readdir(dir)).not.toContain('.env');
    });

    it('a key that is set to an empty value', async () => {
      await writeFile(envFile(), 'EMPTY=\n');
      await expect(store.addEnvValues({ EMPTY: 'now set' })).rejects.toThrow(/EMPTY already exists/);
    });

    it('a name that is not a valid key', async () => {
      for (const key of ['', '1ST', 'A-B', 'A B', 'A=B', 'A.B', 'ÄB', '=', 'A\nB']) {
        await expect(store.addEnvValues({ [key]: 'x' }), JSON.stringify(key)).rejects.toThrow(/not a valid name/);
      }
      expect(await readdir(dir)).not.toContain('.env');
    });

    it('a value with a line break', async () => {
      for (const value of ['a\nb', 'a\r\nb', 'a\rb', '\n']) {
        await expect(store.addEnvValues({ A_ONE: value }), JSON.stringify(value)).rejects.toThrow(/one line/);
      }
      expect(await readdir(dir)).not.toContain('.env');
    });

    it('everything in the call when one value is refused', async () => {
      await writeFile(envFile(), 'SUPERVISOR_PASSWORD=old\n');
      await expect(store.addEnvValues({ SUPERVISOR_USERNAME: 'new@example.com', SUPERVISOR_PASSWORD: 'new' })).rejects.toThrow(/SUPERVISOR_PASSWORD already exists/);
      await expect(store.addEnvValues({ SUPERVISOR_USERNAME: 'new@example.com', BAD_VALUE: 'a\nb' })).rejects.toThrow(/one line/);
      await expect(store.addEnvValues({ SUPERVISOR_USERNAME: 'new@example.com', 'bad key': 'x' })).rejects.toThrow(/not a valid name/);
      expect(await readEnvText()).toBe('SUPERVISOR_PASSWORD=old\n');
    });

    it('a second save of the same key', async () => {
      await store.addEnvValues({ AGENT_USERNAME: 'maria@example.com' });
      await expect(store.addEnvValues({ AGENT_USERNAME: 'other@example.com' })).rejects.toThrow(/already exists/);
      expect(await store.readEnv()).toEqual({ AGENT_USERNAME: 'maria@example.com' });
    });

    it('without echoing the value in the message', async () => {
      await store.addEnvValues({ AGENT_PASSWORD: 'first-secret' });
      const error = (await store.addEnvValues({ AGENT_PASSWORD: 'second-secret' }).catch((caught: unknown) => caught)) as Error;
      expect(error.message).not.toContain('first-secret');
      expect(error.message).not.toContain('second-secret');
    });
  });
});

describe('ProjectStore.readCase and block uses', () => {
  const base: Omit<TestCase, 'preconditionBlocks'> = {
    id: 'old-case-20261001-0900',
    name: 'Old case',
    appId: 'com.android.settings',
    createdAt: '2026-10-01T09:00:00.000Z',
    deviceId: 'emulator-5556',
    steps: [],
    expectations: [],
  };

  async function writeRaw(extra: Record<string, unknown>): Promise<void> {
    await writeFile(store.casePath(base.id), `${JSON.stringify({ ...base, ...extra }, null, 2)}\n`);
  }

  it('turns bare block paths from older case files into { file }', async () => {
    await writeRaw({ preconditionBlocks: ['blocks/login.yaml', 'blocks/onboarding.yaml'] });
    expect((await store.readCase(base.id)).preconditionBlocks).toEqual([{ file: 'blocks/login.yaml' }, { file: 'blocks/onboarding.yaml' }]);
  });

  it('keeps blocks that already have the new shape, with their values', async () => {
    const values = { USERNAME: '${SUPERVISOR_USERNAME}', PASSWORD: '${SUPERVISOR_PASSWORD}' };
    await writeRaw({ preconditionBlocks: [{ file: 'blocks/login.yaml', values }, { file: 'blocks/onboarding.yaml' }] });
    expect((await store.readCase(base.id)).preconditionBlocks).toEqual([{ file: 'blocks/login.yaml', values }, { file: 'blocks/onboarding.yaml' }]);
  });

  it('reads a file that mixes both shapes, in order', async () => {
    await writeRaw({ preconditionBlocks: ['blocks/a.yaml', { file: 'blocks/b.yaml', values: { COUNTRY: 'GR' } }, 'blocks/c.yaml'] });
    expect((await store.readCase(base.id)).preconditionBlocks).toEqual([
      { file: 'blocks/a.yaml' },
      { file: 'blocks/b.yaml', values: { COUNTRY: 'GR' } },
      { file: 'blocks/c.yaml' },
    ]);
  });

  it('reads a case with no block list at all as having none', async () => {
    await writeRaw({});
    expect((await store.readCase(base.id)).preconditionBlocks).toEqual([]);
  });

  it('does not add a values key to a converted path', async () => {
    await writeRaw({ preconditionBlocks: ['blocks/login.yaml'] });
    const [use] = (await store.readCase(base.id)).preconditionBlocks;
    expect(Object.keys(use!)).toEqual(['file']);
  });

  it('gives the same blocks to startChain', async () => {
    await writeRaw({ preconditionBlocks: ['blocks/login.yaml'] });
    const [testCase] = await store.startChain(base.id);
    expect(testCase!.preconditionBlocks).toEqual([{ file: 'blocks/login.yaml' }]);
  });

  it('converts when a case is saved again: the file then holds the new shape', async () => {
    await writeRaw({ preconditionBlocks: ['blocks/login.yaml'] });
    await store.writeCase(await store.readCase(base.id));
    const onDisk = JSON.parse(await readFile(store.casePath(base.id), 'utf8')) as { preconditionBlocks: unknown };
    expect(onDisk.preconditionBlocks).toEqual([{ file: 'blocks/login.yaml' }]);
  });

  it('lists a case whose file still has bare paths', async () => {
    await writeRaw({ preconditionBlocks: ['blocks/login.yaml'] });
    expect((await store.listCases()).map((item) => item.id)).toEqual([base.id]);
  });

  it('round-trips block values and block steps through writeCase and readCase', async () => {
    const testCase: TestCase = {
      ...base,
      preconditionBlocks: [{ file: 'blocks/login.yaml', values: { USERNAME: '${SUPERVISOR_USERNAME}' } }],
      steps: [{ index: 1, kind: 'block', file: 'blocks/login.yaml', values: { USERNAME: '${AGENT_USERNAME}', COUNTRY: 'GR' }, screenshot: `evidence/${base.id}/step-001.png`, at: base.createdAt }],
    };
    await store.writeCase(testCase);
    expect(await store.readCase(base.id)).toEqual(testCase);
  });

  it('keeps block values and block steps when a case is duplicated', async () => {
    const testCase: TestCase = {
      ...base,
      preconditionBlocks: [{ file: 'blocks/login.yaml', values: { USERNAME: '${SUPERVISOR_USERNAME}' } }],
      steps: [{ index: 1, kind: 'block', file: 'blocks/switch.yaml', values: { USERNAME: '${AGENT_USERNAME}' }, screenshot: `evidence/${base.id}/step-001.png`, at: base.createdAt }],
    };
    await store.writeCase(testCase);
    const copy = await store.duplicateCase(base.id, 'Copy', new Date(2026, 9, 31, 10, 0));
    expect(copy.preconditionBlocks).toEqual(testCase.preconditionBlocks);
    expect(copy.steps[0]).toMatchObject({
      kind: 'block',
      file: 'blocks/switch.yaml',
      values: { USERNAME: '${AGENT_USERNAME}' },
      screenshot: `evidence/${copy.id}/step-001.png`,
    });
    expect(await store.readCase(copy.id)).toEqual(copy);
  });
});
