import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initialProjectDir, projectDirIn, readSettings, writeSettings } from '../src/settings.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ariadne-desktop-settings-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readSettings', () => {
  it('returns empty settings when the file does not exist', () => {
    expect(readSettings(join(dir, 'settings.json'))).toEqual({});
  });

  it('returns empty settings for invalid JSON', () => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{ not json');
    expect(readSettings(file)).toEqual({});
  });

  it('returns empty settings for a file with null', () => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'null');
    expect(readSettings(file)).toEqual({});
  });

  it('returns empty settings when projectDir is not a string', () => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ projectDir: 42 }));
    expect(readSettings(file)).toEqual({});
  });

  it('keeps only projectDir and drops unknown keys', () => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ projectDir: '/p', other: true }));
    expect(readSettings(file)).toStrictEqual({ projectDir: '/p' });
  });
});

describe('writeSettings', () => {
  it('round-trips through readSettings', () => {
    const file = join(dir, 'settings.json');
    writeSettings(file, { projectDir: '/some/project' });
    expect(readSettings(file)).toEqual({ projectDir: '/some/project' });
  });

  it('creates missing parent folders', () => {
    const file = join(dir, 'a', 'b', 'settings.json');
    writeSettings(file, { projectDir: '/p' });
    expect(readSettings(file)).toEqual({ projectDir: '/p' });
  });

  it('overwrites a previous value', () => {
    const file = join(dir, 'settings.json');
    writeSettings(file, { projectDir: '/old' });
    writeSettings(file, { projectDir: '/new' });
    expect(readSettings(file)).toEqual({ projectDir: '/new' });
  });

  it('writes indented JSON ending in a newline', () => {
    const file = join(dir, 'settings.json');
    writeSettings(file, { projectDir: '/p' });
    expect(readFileSync(file, 'utf8')).toBe('{\n  "projectDir": "/p"\n}\n');
  });
});

describe('initialProjectDir', () => {
  it('reopens the saved project when its folder exists', () => {
    const project = join(dir, 'mine');
    mkdirSync(project);
    expect(initialProjectDir({ projectDir: project }, join(dir, 'Documents'))).toBe(project);
  });

  it('falls back to Documents/Ariadne when the saved folder is gone', () => {
    expect(initialProjectDir({ projectDir: join(dir, 'gone') }, join(dir, 'Documents'))).toBe(join(dir, 'Documents', 'Ariadne'));
  });

  it('falls back to Documents/Ariadne when the saved path is a file', () => {
    const file = join(dir, 'file.txt');
    writeFileSync(file, 'x');
    expect(initialProjectDir({ projectDir: file }, join(dir, 'Documents'))).toBe(join(dir, 'Documents', 'Ariadne'));
  });

  it('falls back to Documents/Ariadne with no saved project', () => {
    expect(initialProjectDir({}, join(dir, 'Documents'))).toBe(join(dir, 'Documents', 'Ariadne'));
  });
});

describe('projectDirIn', () => {
  it('opens the .ariadne project of a picked app repository, else the folder itself', () => {
    expect(projectDirIn(dir)).toBe(dir);
    mkdirSync(join(dir, '.ariadne'));
    expect(projectDirIn(dir)).toBe(dir);
    writeFileSync(join(dir, '.ariadne', 'project.json'), '{}');
    expect(projectDirIn(dir)).toBe(join(dir, '.ariadne'));
    writeFileSync(join(dir, 'project.json'), '{}');
    expect(projectDirIn(dir)).toBe(dir);
  });
});
