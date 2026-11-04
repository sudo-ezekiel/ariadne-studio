import { fork, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** What the ariadne-studio CLI sends over IPC (apps/cli/src/cli.ts). */
type CliMessage = { type: 'ariadne:ready'; url: string; projectDir: string } | { type: 'ariadne:error'; message: string };

export type StartServerOptions = {
  /** The bundled CLI, dist/cli.mjs. */
  entry: string;
  projectDir: string;
  /** The program that runs the CLI: Electron's own binary with ELECTRON_RUN_AS_NODE=1 in env. */
  execPath: string;
  env: NodeJS.ProcessEnv;
  /** Server output goes here, replaced on every start. */
  logFile: string;
  /** Also copy server output to this process's stdout, for `pnpm start`. */
  echo?: boolean;
  timeoutMs?: number;
};

export type StudioServer = {
  url: string;
  projectDir: string;
  /** Asks the server to close the device session and exit; kills it if it has not after a while. */
  stop(): Promise<void>;
  /** Called once if the server exits without stop() being called. */
  onUnexpectedExit(listener: (code: number | null) => void): void;
};

export class ServerStartError extends Error {
  constructor(
    message: string,
    /** The last lines the server printed, for the error dialog. */
    readonly output: string,
  ) {
    super(message);
  }
}

const TAIL_LINES = 30;
const STOP_GRACE_MS = 8000;

export function startServer(options: StartServerOptions): Promise<StudioServer> {
  mkdirSync(dirname(options.logFile), { recursive: true });
  const log = createWriteStream(options.logFile, { flags: 'w' });
  const tail: string[] = [];
  const child: ChildProcess = fork(options.entry, [options.projectDir, '--port', '0', '--host', '127.0.0.1', '--no-open'], {
    execPath: options.execPath,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const record = (chunk: Buffer) => {
    log.write(chunk);
    if (options.echo) process.stdout.write(chunk);
    tail.push(...chunk.toString('utf8').split(/\r?\n/).filter(Boolean));
    tail.splice(0, Math.max(0, tail.length - TAIL_LINES));
  };
  child.stdout?.on('data', record);
  child.stderr?.on('data', record);
  child.once('exit', () => log.end());

  let stopping = false;
  const stop = () =>
    new Promise<void>((resolve) => {
      stopping = true;
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const killer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(killer);
        resolve();
      });
      // Windows has no SIGTERM, so ask over IPC when the channel is up.
      if (child.connected) child.send({ type: 'ariadne:stop' });
      else child.kill('SIGTERM');
    });

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void stop();
      reject(new ServerStartError(message, tail.join('\n')));
    };
    const timeoutMs = options.timeoutMs ?? 60_000;
    const timer = setTimeout(() => fail(`The studio server did not start within ${Math.round(timeoutMs / 1000)} seconds.`), timeoutMs);

    child.on('message', (message: CliMessage) => {
      if (message?.type === 'ariadne:error') fail(message.message);
      if (message?.type !== 'ariadne:ready' || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        url: message.url,
        projectDir: message.projectDir,
        stop,
        onUnexpectedExit(listener) {
          child.once('exit', (code) => {
            if (!stopping) listener(code);
          });
        },
      });
    });
    child.once('error', (error) => fail(error.message));
    child.once('exit', (code, signal) => fail(`The studio server stopped (${signal ?? `exit code ${code}`}).`));
  });
}
