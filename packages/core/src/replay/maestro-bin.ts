import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

/**
 * Names the Maestro CLI has on this OS. Maestro's download has a shell script
 * `maestro` and a `maestro.bat` side by side; on Windows only the .bat runs.
 */
function maestroNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['maestro.bat', 'maestro.cmd', 'maestro.exe'] : ['maestro'];
}

/**
 * Where to look for the Maestro CLI, in order: MAESTRO_BIN, then the
 * installer's default ~/.maestro/bin (not on PATH unless the user added it),
 * on Windows the folder Maestro's guide extracts its download to
 * (C:\maestro), then PATH.
 */
export function maestroCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  const path = platform === 'win32' ? win32 : posix;
  const dirs = [path.join(home, '.maestro', 'bin')];
  if (platform === 'win32') dirs.push(path.join(`${env.SystemDrive || 'C:'}\\`, 'maestro', 'bin'));
  dirs.push(...(env.PATH ?? '').split(path.delimiter).filter(Boolean));
  const candidates = env.MAESTRO_BIN ? [env.MAESTRO_BIN] : [];
  for (const dir of dirs) for (const name of maestroNames(platform)) candidates.push(path.join(dir, name));
  return candidates;
}

/** The Maestro CLI; see maestroCandidates. */
export function findMaestro(): string {
  const found = maestroCandidates(process.platform, process.env, homedir()).find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error(
    process.platform === 'win32'
      ? 'Maestro CLI not found. Add the bin folder of the Maestro download to PATH, or set MAESTRO_BIN to its maestro.bat.'
      : 'Maestro CLI not found. Set MAESTRO_BIN or install it to ~/.maestro/bin/maestro.',
  );
}

/**
 * ANDROID_HOME (or the older ANDROID_SDK_ROOT), else the folder Android Studio
 * installs the SDK to on this OS, when it exists. Maestro needs it to find adb.
 */
export function androidHome(): string | undefined {
  const fromEnv = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (fromEnv) return fromEnv;
  const guesses = [join(homedir(), 'Android', 'Sdk')];
  if (process.platform === 'darwin') guesses.unshift(join(homedir(), 'Library', 'Android', 'sdk'));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) guesses.unshift(join(process.env.LOCALAPPDATA, 'Android', 'Sdk'));
  return guesses.find((guess) => existsSync(guess));
}
