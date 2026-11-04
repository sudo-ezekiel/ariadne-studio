import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactRunFiles } from '../src/replay/maestro-run.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'redact-run-files-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('redactRunFiles', () => {
  it('redacts a secret in every occurrence of a log file', async () => {
    const file = join(dir, 'maestro.log');
    await writeFile(file, 'env PASSWORD=hunter22\nInputTextCommand(text=hunter22)\n');
    await redactRunFiles(dir, { PASSWORD: 'hunter22' });
    const out = await readFile(file, 'utf8');
    expect(out).toBe('env PASSWORD=${PASSWORD}\nInputTextCommand(text=${PASSWORD})\n');
    expect(out).not.toContain('hunter22');
  });

  it('reaches files in nested folders whose names contain spaces', async () => {
    const sub = join(dir, 'Switch to supervisor');
    await mkdir(sub, { recursive: true });
    const file = join(sub, 'commands.json');
    await writeFile(file, JSON.stringify([{ text: 'hunter22' }]));
    await redactRunFiles(dir, { PASSWORD: 'hunter22' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([{ text: '${PASSWORD}' }]);
  });

  it('redacts a short PIN string in JSON but leaves a number containing the digits alone', async () => {
    const file = join(dir, 'commands.json');
    await writeFile(file, JSON.stringify({ text: '1234', timestamp: 1730581234567, note: 'a1234b' }));
    await redactRunFiles(dir, { PIN: '1234' });
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    expect(parsed.text).toBe('${PIN}');
    expect(parsed.timestamp).toBe(1730581234567);
    expect(parsed.note).toBe('a${PIN}b');
  });

  it('keeps the exact original bytes of a JSON file with nothing to redact', async () => {
    const file = join(dir, 'commands.json');
    const original = '{"a":1,   "b":["x",\n  "y"]}\r\n\t';
    await writeFile(file, original);
    await redactRunFiles(dir, { PASSWORD: 'hunter22' });
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('keeps the exact original bytes when the only match is in a number', async () => {
    const file = join(dir, 'ts.json');
    const original = '{"t":1730581234567}';
    await writeFile(file, original);
    await redactRunFiles(dir, { PIN: '1234' });
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('rewrites a changed JSON file with 2-space indentation', async () => {
    const file = join(dir, 'c.json');
    await writeFile(file, '{"a":"hunter22"}');
    await redactRunFiles(dir, { PASSWORD: 'hunter22' });
    expect(await readFile(file, 'utf8')).toBe('{\n  "a": "${PASSWORD}"\n}');
  });

  it('falls back to text redaction for invalid JSON', async () => {
    const file = join(dir, 'broken.json');
    await writeFile(file, '{"a": "hunter22", oops');
    await redactRunFiles(dir, { PASSWORD: 'hunter22' });
    expect(await readFile(file, 'utf8')).toBe('{"a": "${PASSWORD}", oops');
  });

  it('redacts txt, yaml and yml files', async () => {
    for (const name of ['output.txt', 'flow.yaml', 'flow.yml']) {
      await writeFile(join(dir, name), 'pw: hunter22');
    }
    await redactRunFiles(dir, { PASSWORD: 'hunter22' });
    for (const name of ['output.txt', 'flow.yaml', 'flow.yml']) {
      expect(await readFile(join(dir, name), 'utf8')).toBe('pw: ${PASSWORD}');
    }
  });

  it('leaves a png containing the secret bytes identical', async () => {
    const file = join(dir, 'screenshot.png');
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]), Buffer.from('hunter22')]);
    await writeFile(file, bytes);
    await redactRunFiles(dir, { PASSWORD: 'hunter22' });
    expect((await readFile(file)).equals(bytes)).toBe(true);
  });

  it('replaces the longer value first when values overlap', async () => {
    const file = join(dir, 'maestro.log');
    await writeFile(file, 'sup_pass1 and sup_x');
    await redactRunFiles(dir, { PREFIX: 'sup_', PASSWORD: 'sup_pass1' });
    expect(await readFile(file, 'utf8')).toBe('${PASSWORD} and ${PREFIX}x');
  });

  it('does nothing with an empty env', async () => {
    const file = join(dir, 'maestro.log');
    await writeFile(file, 'hunter22');
    await redactRunFiles(dir, {});
    expect(await readFile(file, 'utf8')).toBe('hunter22');
  });

  it('does not throw for a missing directory', async () => {
    await expect(redactRunFiles(join(dir, 'nope'), { PASSWORD: 'hunter22' })).resolves.toBeUndefined();
  });
});
