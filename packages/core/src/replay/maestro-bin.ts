import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

/** Plain ASCII, which every Windows code page can spell. Java needs that of what reaches it as text. */
export function isPlainAscii(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text);
}

/**
 * Where "Set up this computer" keeps Java and Maestro, Windows only for now: see
 * the studio's tool-install.ts. A standard user can write to both folders, so it
 * needs no admin rights. Java's launcher reads its own path in the system code
 * page and stops with "could not find java.dll" when that cannot spell it, as
 * with a Greek user name on English Windows, so a folder outside ASCII is skipped.
 */
export function toolsDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32') return undefined;
  const base = [env.LOCALAPPDATA, env.ProgramData].find((dir) => dir && isPlainAscii(dir));
  return base ? win32.join(base, 'Ariadne', 'tools') : undefined;
}

/** The Java runtime "Set up this computer" put in toolsDir, when it did. */
export function toolsJavaHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const dir = toolsDir(env, platform);
  if (!dir) return undefined;
  const home = win32.join(dir, 'java');
  return existsSync(win32.join(home, 'bin', 'java.exe')) ? home : undefined;
}

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
 * (C:\maestro) and the one "Set up this computer" uses, then PATH.
 */
export function maestroCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  const path = platform === 'win32' ? win32 : posix;
  const dirs = [path.join(home, '.maestro', 'bin')];
  if (platform === 'win32') dirs.push(path.join(`${env.SystemDrive || 'C:'}\\`, 'maestro', 'bin'));
  const tools = toolsDir(env, platform);
  if (tools) dirs.push(path.join(tools, 'maestro', 'bin'));
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

/** Where the Android SDK may be on this OS, Android Studio's own folder first. */
function sdkGuesses(): string[] {
  const guesses = [join(homedir(), 'Android', 'Sdk')];
  if (process.platform === 'darwin') guesses.unshift(join(homedir(), 'Library', 'Android', 'sdk'));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) guesses.unshift(join(process.env.LOCALAPPDATA, 'Android', 'Sdk'));
  return guesses;
}

/** The folder Android Studio installs the SDK to on this OS, whether or not it exists yet. */
export function defaultSdkDir(): string {
  return sdkGuesses()[0]!;
}

/**
 * ANDROID_HOME (or the older ANDROID_SDK_ROOT), else the folder Android Studio
 * installs the SDK to on this OS, when it exists. Maestro needs it to find adb.
 */
export function androidHome(): string | undefined {
  const fromEnv = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (fromEnv) return fromEnv;
  return sdkGuesses().find((guess) => existsSync(guess));
}
