import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const MARK = '__ARIADNE_PATH__';

/**
 * PATH as the user's login shell sets it. An app started from the Dock, Finder
 * or a desktop launcher gets a bare PATH (/usr/bin:/bin on macOS), so adb,
 * java and maestro installed through a shell profile would not be found.
 */
export function loginShellPath(): string | undefined {
  if (process.platform === 'win32') return undefined;
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  try {
    const output = execFileSync(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new RegExp(`${MARK}(.*)${MARK}`, 's').exec(output)?.[1];
  } catch {
    return undefined;
  }
}

/** Where the Android SDK tools and the Maestro installer put their programs by default. */
export function wellKnownToolDirs(platform: NodeJS.Platform, home = homedir(), localAppData = process.env.LOCALAPPDATA): string[] {
  const dirs = [join(home, '.maestro', 'bin')];
  if (platform === 'darwin') dirs.push(join(home, 'Library', 'Android', 'sdk', 'platform-tools'));
  if (platform === 'win32' && localAppData) dirs.push(join(localAppData, 'Android', 'Sdk', 'platform-tools'));
  dirs.push(join(home, 'Android', 'Sdk', 'platform-tools'));
  return dirs;
}

/** Joins PATH lists in order, dropping empty entries and repeats. */
export function mergePathLists(lists: Array<string | undefined>, separator = delimiter): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    for (const dir of (list ?? '').split(separator)) {
      if (dir && !seen.has(dir)) {
        seen.add(dir);
        merged.push(dir);
      }
    }
  }
  return merged.join(separator);
}

/** PATH for the studio server: what this process has, then the login shell's, then the usual tool folders. */
export function studioPath(): string {
  return mergePathLists([process.env.PATH, loginShellPath(), wellKnownToolDirs(process.platform).join(delimiter)]);
}
