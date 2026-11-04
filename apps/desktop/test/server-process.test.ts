import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerStartError, startServer, type StudioServer } from '../src/server-process.ts';

// The fixture stands in for dist/cli.mjs: it speaks the same IPC messages, picks
// its behavior from FIXTURE_MODE, and never touches a device.
const FIXTURE = `
const mode = process.env.FIXTURE_MODE;
console.log('fixture args: ' + process.argv.slice(2).join(' '));
if (mode === 'ready' || mode === 'ready-then-crash') {
  process.send({ type: 'ariadne:ready', url: 'http://127.0.0.1:1234', projectDir: process.argv[2] });
  process.on('message', (m) => { if (m && m.type === 'ariadne:stop') process.exit(0); });
  if (mode === 'ready-then-crash') setTimeout(() => process.exit(3), 100);
  else setInterval(() => {}, 1000);
} else if (mode === 'error') {
  console.error('boom detail');
  process.send({ type: 'ariadne:error', message: 'Port 1 is in use.' });
  setInterval(() => {}, 1000);
} else if (mode === 'exit-early') {
  console.error('about to die');
  process.exit(7);
} else if (mode === 'silent') {
  setInterval(() => {}, 1000);
}
`;

let dir: string;
let entry: string;
const started: StudioServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ariadne-desktop-server-'));
  entry = join(dir, 'fixture.mjs');
  writeFileSync(entry, FIXTURE);
});
afterEach(async () => {
  await Promise.all(started.splice(0).map((server) => server.stop()));
  rmSync(dir, { recursive: true, force: true });
});

async function start(mode: string, extra: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<StudioServer> {
  const server = await startServer({
    entry,
    projectDir: join(dir, 'project'),
    execPath: process.execPath,
    env: { ...process.env, FIXTURE_MODE: mode, ...extra.env },
    logFile: join(dir, 'logs', 'server.log'),
    timeoutMs: extra.timeoutMs ?? 10_000,
  });
  started.push(server);
  return server;
}

async function startFailing(mode: string, timeoutMs?: number): Promise<ServerStartError> {
  const error = await start(mode, timeoutMs ? { timeoutMs } : {}).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ServerStartError);
  return error as ServerStartError;
}

describe('startServer', () => {
  it('resolves with the url and project dir from the ready message', async () => {
    const server = await start('ready');
    expect(server.url).toBe('http://127.0.0.1:1234');
    expect(server.projectDir).toBe(join(dir, 'project'));
  });

  it('passes the project folder, port 0, host and --no-open to the entry', async () => {
    await start('ready');
    // The write to the log lands a moment after the ready message.
    await vi.waitFor(() => expect(readFileSync(join(dir, 'logs', 'server.log'), 'utf8')).toContain(`fixture args: ${join(dir, 'project')} --port 0 --host 127.0.0.1 --no-open`));
  });

  it('creates the missing log folder and writes server output to the log file', async () => {
    const error = await startFailing('exit-early');
    expect(error.output).toContain('about to die');
    await vi.waitFor(() => expect(readFileSync(join(dir, 'logs', 'server.log'), 'utf8')).toContain('about to die'));
  });

  it('rejects with a ServerStartError carrying the server message and output tail on ariadne:error', async () => {
    const error = await startFailing('error');
    expect(error.message).toBe('Port 1 is in use.');
    expect(error.output).toContain('boom detail');
  });

  it('rejects with the exit code and output when the server exits before it is ready', async () => {
    const error = await startFailing('exit-early');
    expect(error.message).toBe('The studio server stopped (exit code 7).');
    expect(error.output).toContain('fixture args:');
  });

  it('rejects after the timeout when the server never answers, and stops the child', async () => {
    const started = Date.now();
    const error = await startFailing('silent', 1000);
    expect(error.message).toBe('The studio server did not start within 1 seconds.');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('rejects when the entry script cannot be run at all', async () => {
    const error = await startServer({
      entry,
      projectDir: dir,
      execPath: join(dir, 'no-such-program'),
      env: process.env,
      logFile: join(dir, 'log.txt'),
      timeoutMs: 5000,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ServerStartError);
  });

  it('keeps only the last 30 lines of output in the error', async () => {
    writeFileSync(entry, `for (let i = 1; i <= 100; i++) console.log('line ' + i); process.exit(1);`);
    const error = await startFailing('whatever');
    const lines = error.output.split('\n');
    expect(lines).toHaveLength(30);
    expect(lines.at(-1)).toBe('line 100');
    expect(lines[0]).toBe('line 71');
  });
});

describe('StudioServer', () => {
  it('stop() sends ariadne:stop and resolves once the child has exited', async () => {
    const server = await start('ready');
    let exitCode: number | null | undefined;
    server.onUnexpectedExit((code) => (exitCode = code));
    await server.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(exitCode).toBeUndefined();
  });

  it('stop() can be called twice', async () => {
    const server = await start('ready');
    await server.stop();
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('calls onUnexpectedExit with the exit code when the server dies by itself', async () => {
    const server = await start('ready-then-crash');
    const code = await new Promise<number | null>((resolve) => server.onUnexpectedExit(resolve));
    expect(code).toBe(3);
  });

  it('does not call onUnexpectedExit for an exit caused by stop()', async () => {
    const server = await start('ready');
    const calls: Array<number | null> = [];
    server.onUnexpectedExit((code) => calls.push(code));
    await server.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toEqual([]);
  });
});
