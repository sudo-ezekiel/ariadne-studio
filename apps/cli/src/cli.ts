import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidHome } from '@ariadne/core';
import { startStudio, studioUrl, type RunningStudio } from '@ariadne/studio/server';
import { parseCliArgs, USAGE, UsageError, type RunOptions } from './args.ts';
import { InitError, initProject, initReport } from './init.ts';
import { openBrowser } from './open-browser.ts';

/**
 * Messages exchanged with a parent process over IPC. The desktop app starts
 * this CLI as a child with `--port 0 --no-open` and waits for `ready`.
 */
export type ParentMessage =
  | { type: 'ariadne:ready'; url: string; projectDir: string }
  | { type: 'ariadne:error'; message: string };
export type ChildMessage = { type: 'ariadne:stop' };

// dist/cli.mjs is published next to dist/ui/. From src/ (development) that
// folder does not exist and the server falls back to the studio's own build.
const bundledUi = fileURLToPath(new URL('./ui/', import.meta.url));
const bundledVideoAssets = fileURLToPath(new URL('./run-video/', import.meta.url));

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * agent-device finds adb on PATH. A fresh terminal, or an app started from the
 * desktop, often has the SDK installed but not on PATH, so add its platform-tools.
 */
function addSdkToPath(): void {
  const home = androidHome();
  if (!home) return;
  const platformTools = join(home, 'platform-tools');
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  if (existsSync(platformTools) && !dirs.includes(platformTools)) {
    process.env.PATH = [...dirs, platformTools].join(delimiter);
  }
}

function notifyParent(message: ParentMessage): void {
  process.send?.(message);
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EADDRINUSE';
}

/** The project folder of an Ariadne Studio answering at url, if that is what is there. */
async function runningStudioAt(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${url}/api/project`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { dir?: unknown; platform?: unknown };
    return typeof body.dir === 'string' && body.platform === 'android' ? body.dir : undefined;
  } catch {
    return undefined;
  }
}

function shellQuote(path: string): string {
  return /^[\w./:\\-]+$/.test(path) ? path : `"${path}"`;
}

/** Port taken: open the studio already serving this project, or say how to start a second one. */
async function explainPortInUse(options: RunOptions): Promise<number> {
  const url = studioUrl(options.host, options.port);
  const otherProject = await runningStudioAt(url);
  if (otherProject && resolve(otherProject) === options.projectDir) {
    console.log(`Ariadne Studio is already running for this project at ${url}`);
    if (options.open) openBrowser(url);
    return 0;
  }
  console.error(
    otherProject
      ? `Ariadne Studio is already running at ${url} for another project: ${otherProject}`
      : `Port ${options.port} is in use by another program.`,
  );
  console.error('To run a second studio, give it another port and its own device session, for example:');
  console.error(`  ariadne-studio ${shellQuote(options.projectDir)} --port ${options.port + 1} --session studio-2`);
  return 1;
}

async function run(options: RunOptions): Promise<number | undefined> {
  addSdkToPath();
  let studio: RunningStudio;
  try {
    studio = await startStudio({
      appVersion: version(),
      projectDir: options.projectDir,
      port: options.port,
      host: options.host,
      sessionName: options.sessionName,
      ...(existsSync(bundledUi) ? { uiDir: bundledUi } : {}),
      ...(existsSync(bundledVideoAssets) ? { videoAssetsDir: bundledVideoAssets } : {}),
    });
  } catch (error) {
    if (isAddressInUse(error)) {
      notifyParent({ type: 'ariadne:error', message: `Port ${options.port} is in use.` });
      return explainPortInUse(options);
    }
    throw error;
  }

  let closing = false;
  const shutdown = (reason: string) => {
    // A second Ctrl+C while the device session closes means "now".
    if (closing) process.exit(1);
    closing = true;
    console.log(`\nStopping (${reason}): closing the device session.`);
    studio
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('Ctrl+C'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  if (process.send) {
    // Windows has no SIGTERM, so the parent asks over IPC; a vanished parent means stop too.
    process.on('message', (message: ChildMessage) => {
      if (message?.type === 'ariadne:stop') shutdown('stop requested');
    });
    process.on('disconnect', () => shutdown('parent exited'));
  }

  console.log('');
  console.log(`  Ariadne Studio is running at ${studio.url}`);
  console.log(`  Project: ${studio.projectDir}`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
  if (!studio.servesUi) {
    console.warn('  The UI is not built, so only the API is served. Run `pnpm build` at the repository root.');
  }
  notifyParent({ type: 'ariadne:ready', url: studio.url, projectDir: studio.projectDir });
  if (options.open) openBrowser(studio.url);
  return undefined;
}

export async function main(argv: string[]): Promise<number | undefined> {
  let command;
  try {
    command = parseCliArgs(argv, process.env, process.cwd());
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    console.error('Run `ariadne-studio --help` for usage.');
    return 2;
  }
  if (command.kind === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (command.kind === 'version') {
    console.log(version());
    return 0;
  }
  if (command.kind === 'init') {
    try {
      const result = initProject(command.folder);
      for (const line of initReport(result, command.folder, process.cwd())) console.log(line);
      return 0;
    } catch (error) {
      if (!(error instanceof InitError)) throw error;
      console.error(error.message);
      return 1;
    }
  }
  return run(command.options);
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) {
      process.exitCode = code;
      // An IPC channel keeps the process alive; let go of it so the exit happens.
      process.disconnect?.();
    }
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    notifyParent({ type: 'ariadne:error', message });
    console.error('Ariadne Studio failed to start:', error);
    process.exitCode = 1;
    process.disconnect?.();
  },
);
