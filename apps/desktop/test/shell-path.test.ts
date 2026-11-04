import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loginShellPath, mergePathLists, studioPath, wellKnownToolDirs } from '../src/shell-path.ts';

describe('mergePathLists', () => {
  it('joins lists in order', () => {
    expect(mergePathLists(['/a:/b', '/c'], ':')).toBe('/a:/b:/c');
  });

  it('drops repeats, keeping the first position', () => {
    expect(mergePathLists(['/a:/b', '/b:/c:/a'], ':')).toBe('/a:/b:/c');
  });

  it('drops empty entries and undefined lists', () => {
    expect(mergePathLists([undefined, '/a::/b:', '', undefined], ':')).toBe('/a:/b');
  });

  it('returns an empty string when there is nothing', () => {
    expect(mergePathLists([], ':')).toBe('');
    expect(mergePathLists([undefined, ''], ':')).toBe('');
  });

  it('uses the platform delimiter by default', () => {
    expect(mergePathLists([`/a${delimiter}/b`, '/c'])).toBe(['/a', '/b', '/c'].join(delimiter));
  });

  it('splits on the given separator only', () => {
    expect(mergePathLists(['C:\\a;C:\\b', 'C:\\a'], ';')).toBe('C:\\a;C:\\b');
  });
});

describe('wellKnownToolDirs', () => {
  const home = join('/home', 'someone');

  it('lists the Maestro and Linux SDK folders on linux', () => {
    expect(wellKnownToolDirs('linux', home, undefined)).toEqual([join(home, '.maestro', 'bin'), join(home, 'Android', 'Sdk', 'platform-tools')]);
  });

  it('adds the macOS SDK folder on darwin, before the generic one', () => {
    expect(wellKnownToolDirs('darwin', home, undefined)).toEqual([
      join(home, '.maestro', 'bin'),
      join(home, 'Library', 'Android', 'sdk', 'platform-tools'),
      join(home, 'Android', 'Sdk', 'platform-tools'),
    ]);
  });

  it('adds the LOCALAPPDATA SDK folder on win32 when it is set', () => {
    const local = join('/users', 'someone', 'AppData', 'Local');
    expect(wellKnownToolDirs('win32', home, local)).toContain(join(local, 'Android', 'Sdk', 'platform-tools'));
  });

  it('skips the LOCALAPPDATA folder on win32 when it is not set', () => {
    const dirs = wellKnownToolDirs('win32', home, undefined);
    expect(dirs).toEqual([join(home, '.maestro', 'bin'), join(home, 'Android', 'Sdk', 'platform-tools')]);
  });

  it('ignores LOCALAPPDATA off Windows', () => {
    expect(wellKnownToolDirs('linux', home, '/x')).not.toContain(join('/x', 'Android', 'Sdk', 'platform-tools'));
  });

  it('defaults to the real home directory', () => {
    expect(wellKnownToolDirs('linux')[0]).toBe(join(homedir(), '.maestro', 'bin'));
  });
});

describe('loginShellPath and studioPath', () => {
  it('returns a string or undefined', () => {
    const result = loginShellPath();
    expect(result === undefined || typeof result === 'string').toBe(true);
  });

  it('studioPath starts with this process PATH and has no repeats', () => {
    const parts = studioPath().split(delimiter);
    expect(new Set(parts).size).toBe(parts.length);
    const own = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    expect(parts.slice(0, new Set(own).size)).toEqual([...new Set(own)]);
  });
});
