import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { isPlainAscii, toolsJavaHome } from './maestro-bin.ts';
import { parseMaestroRun, redactValues, type RunCommand } from './run-result.ts';
import { spawnCommand } from './windows-command.ts';

export type RunMaestroOptions = {
  maestroBin: string;
  /** adb serial. */
  deviceId: string;
  flowPath: string;
  /** Receives Maestro's --debug-output and output.txt. */
  debugDir: string;
  /** Passed as -e KEY=VALUE; values are secrets and never logged. */
  env: Readonly<Record<string, string>>;
  cwd: string;
  androidHome?: string;
  timeoutMs: number;
  /** Leave Maestro's driver on the device afterwards, for phones that ask before every install. */
  keepDriver?: boolean;
};

export type MaestroRunResult = {
  exitCode: number;
  durationMs: number;
  /** <debugDir>/output.txt: Maestro's stdout and stderr, env values redacted. */
  outputFile: string;
  timedOut: boolean;
};

export type MaestroRunner = (options: RunMaestroOptions) => Promise<MaestroRunResult>;

/** Grace period between SIGTERM and SIGKILL when a run times out. */
const KILL_GRACE_MS = 5_000;

/**
 * Stops a run that timed out. On Windows Maestro is cmd.exe running
 * maestro.bat running java, and killing cmd.exe would leave java driving the
 * device, so taskkill ends the whole tree (forcefully: console programs
 * ignore a polite taskkill).
 */
function stopRun(child: ChildProcess): ReturnType<typeof setTimeout> | undefined {
  if (process.platform === 'win32') {
    if (child.pid !== undefined) {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
    }
    return undefined;
  }
  child.kill('SIGTERM');
  return setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
}

/**
 * Maestro's environment. On Windows, Java writes to a pipe in the system code
 * page (cp1253 on Greek Windows), which would garble the output and keep a
 * non-ASCII .env value from being redacted, so it is told to write UTF-8. Java
 * 19 and newer take stdout.encoding for that; Java 17, the one "Set up this
 * computer" fetches, ignores it and only goes by file.encoding, and without it
 * Greek text comes out as question marks. maestro.bat passes MAESTRO_OPTS to
 * java. The Java runtime from "Set up this
 * computer" wins over a JAVA_HOME the user has: it is only there because this
 * computer had no Java new enough, and maestro.bat prefers JAVA_HOME to PATH.
 */
export function maestroEnv(androidHome: string | undefined, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const javaHome = toolsJavaHome(env, platform);
  const result: NodeJS.ProcessEnv = { ...env, ...(androidHome ? { ANDROID_HOME: androidHome } : {}), ...(javaHome ? { JAVA_HOME: javaHome } : {}) };
  if (platform === 'win32') {
    result.MAESTRO_OPTS = [env.MAESTRO_OPTS, '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8'].filter(Boolean).join(' ');
  }
  return result;
}

/**
 * A path as Maestro's command line should carry it. On Windows, Java reads its
 * arguments in the system code page, so a folder that cannot spell, such as a
 * Greek user name on English Windows, arrives as question marks and Maestro
 * stops at once. Its working directory reaches it intact, so a path inside that
 * folder goes relative. Everything else stays as it was.
 */
export function pathForMaestro(path: string, cwd: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || isPlainAscii(path)) return path;
  const inside = win32.relative(cwd, path);
  return isPlainAscii(inside) && !inside.startsWith('..') && !win32.isAbsolute(inside) ? inside : path;
}

/**
 * Runs `maestro --device <id> test --no-ansi --debug-output <debugDir>
 * --flatten-debug-output -e KEY=VALUE... <flow>` and waits for it. The argv
 * carries the env values, so it is never logged or returned. Output goes to
 * <debugDir>/output.txt with the env values replaced by ${KEY}.
 */
export async function runMaestro(options: RunMaestroOptions): Promise<MaestroRunResult> {
  await mkdir(options.debugDir, { recursive: true });
  const args = ['--device', options.deviceId, 'test', '--no-ansi', '--debug-output', pathForMaestro(options.debugDir, options.cwd), '--flatten-debug-output'];
  if (options.keepDriver) args.push('--no-reinstall-driver');
  for (const [key, value] of Object.entries(options.env)) args.push('-e', `${key}=${value}`);
  args.push(pathForMaestro(options.flowPath, options.cwd));

  const outputFile = join(options.debugDir, 'output.txt');
  const chunks: Buffer[] = [];
  const started = Date.now();
  let timedOut = false;
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    const command = spawnCommand(options.maestroBin, args);
    const child = spawn(command.command, command.args, {
      cwd: options.cwd,
      env: maestroEnv(options.androidHome),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments ?? false,
    });
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killTimer = stopRun(child);
    }, options.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolveExit(timedOut ? (code || 1) : (code ?? 1));
    });
  });

  let output = redactValues(Buffer.concat(chunks).toString('utf8'), options.env);
  if (timedOut) output += `\n[ariadne] Maestro did not finish within ${Math.round(options.timeoutMs / 1000)} s and was stopped.\n`;
  await writeFile(outputFile, output, 'utf8');
  return { exitCode, durationMs: Date.now() - started, outputFile, timedOut };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the flow's directory inside a --flatten-debug-output directory (it is
 * named after the flow's `name:` header) and parses its commands.json.
 * Undefined when Maestro wrote none, for example when it could not start.
 */
export async function readMaestroCommands(debugDir: string): Promise<{ flowDirName: string; commands: RunCommand[] } | undefined> {
  const entries = await readdir(debugDir, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const name of dirs) {
    const file = join(debugDir, name, 'commands.json');
    if (!(await exists(file))) continue;
    return { flowDirName: name, commands: parseMaestroRun(JSON.parse(await readFile(file, 'utf8'))) };
  }
  return undefined;
}

const TEXT_FILE = /\.(log|txt|json|ya?ml)$/i;

function redactStrings(value: unknown, env: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') return redactValues(value, env);
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(item, env)]));
  }
  return value;
}

/**
 * Replaces .env values with their ${KEY} in every text file of a run's
 * debug output. Maestro's maestro.log records the env and each typed text in
 * clear, and so may its JSON files. In JSON only string values change, so a
 * short value such as a PIN cannot corrupt a number. Screenshots are left
 * alone. Call it after the run's files have been read.
 */
export async function redactRunFiles(dir: string, env: Readonly<Record<string, string>>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !TEXT_FILE.test(entry.name)) continue;
    const file = join(entry.parentPath, entry.name);
    const text = await readFile(file, 'utf8');
    let redacted: string;
    if (/\.json$/i.test(entry.name)) {
      try {
        redacted = JSON.stringify(redactStrings(JSON.parse(text), env), null, 2);
        if (redacted === JSON.stringify(JSON.parse(text), null, 2)) continue;
      } catch {
        redacted = redactValues(text, env);
      }
    } else {
      redacted = redactValues(text, env);
    }
    if (redacted !== text) await writeFile(file, redacted, 'utf8');
  }
}
