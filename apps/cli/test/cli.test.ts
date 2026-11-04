import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Runs the real entry through tsx as a child process, as the desktop app does.
// Starting the server never opens a device session, and no test calls a route
// that would.
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const cliDir = fileURLToPath(new URL('..', import.meta.url));

type Message = { type: string; url?: string; projectDir?: string; message?: string };
type Started = { child: ChildProcess; output: () => string; messages: Message[]; exit: Promise<number | null>; ready: () => Promise<Message> };

let dir: string;
const children: ChildProcess[] = [];
const servers: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ariadne-cli-test-'));
});
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  rmSync(dir, { recursive: true, force: true });
});

function start(args: string[], env: NodeJS.ProcessEnv = {}): Started {
  const child = fork(cliPath, args, {
    cwd: cliDir,
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  let text = '';
  child.stdout?.on('data', (chunk: Buffer) => (text += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (text += chunk.toString()));
  const messages: Message[] = [];
  const waiters: Array<() => void> = [];
  child.on('message', (message: Message) => {
    messages.push(message);
    waiters.splice(0).forEach((wake) => wake());
  });
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const ready = async () => {
    for (;;) {
      const found = messages.find((m) => m.type === 'ariadne:ready');
      if (found) return found;
      if (child.exitCode !== null) throw new Error(`CLI exited ${child.exitCode} before ready:\n${text}`);
      await new Promise<void>((wake) => {
        waiters.push(wake);
        child.once('exit', () => wake());
      });
    }
  };
  return { child, output: () => text, messages, exit, ready };
}

function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

const name = () => `cli-test-${process.pid}`;

describe('ariadne-studio CLI process', () => {
  it('sends ariadne:ready, serves /api/project for the folder and exits 0 on ariadne:stop', async () => {
    const cli = start([dir, '--port', '0', '--no-open', '--session', name()]);
    const ready = await cli.ready();
    expect(ready.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(ready.url).not.toMatch(/:0$/);
    expect(ready.projectDir).toBe(dir);

    const response = await fetch(`${ready.url}/api/project`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dir, platform: 'android' });

    cli.child.send({ type: 'ariadne:stop' });
    expect(await cli.exit).toBe(0);
    expect(cli.output()).toContain('Stopping (stop requested)');
  }, 30_000);

  it('stops with exit 0 when the parent disconnects', async () => {
    const cli = start([dir, '--port', '0', '--no-open', '--session', name()]);
    await cli.ready();
    cli.child.disconnect();
    expect(await cli.exit).toBe(0);
  }, 30_000);

  it('prints usage and exits 0 for --help', async () => {
    const cli = start(['--help']);
    expect(await cli.exit).toBe(0);
    expect(cli.output()).toContain('Usage: ariadne-studio');
    expect(cli.messages).toEqual([]);
  }, 30_000);

  it('exits 2 with a hint for a bad --port', async () => {
    const cli = start([dir, '--port', 'abc', '--no-open']);
    expect(await cli.exit).toBe(2);
    expect(cli.output()).toContain('--port must be a port number');
    expect(cli.output()).toContain('--help');
    expect(cli.messages).toEqual([]);
  }, 30_000);

  it('exits 1 and tells the parent when the port is held by another program', async () => {
    const port = await listen((_req, res) => res.writeHead(404).end('nope'));
    const cli = start([dir, '--port', String(port), '--no-open', '--session', name()]);
    expect(await cli.exit).toBe(1);
    expect(cli.output()).toContain(`Port ${port} is in use by another program`);
    expect(cli.output()).toContain(`--port ${port + 1}`);
    expect(cli.messages).toEqual([{ type: 'ariadne:error', message: `Port ${port} is in use.` }]);
  }, 30_000);

  it('exits 1 and names the other project when a studio for a different folder holds the port', async () => {
    const port = await listen((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ dir: '/somewhere/else', platform: 'android' })));
    const cli = start([dir, '--port', String(port), '--no-open', '--session', name()]);
    expect(await cli.exit).toBe(1);
    expect(cli.output()).toContain('for another project: /somewhere/else');
  }, 30_000);

  it('exits 1 when the port answers /api/project with a non-android body', async () => {
    const port = await listen((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ dir, platform: 'ios' })));
    const cli = start([dir, '--port', String(port), '--no-open', '--session', name()]);
    expect(await cli.exit).toBe(1);
    expect(cli.output()).toContain('in use by another program');
  }, 30_000);

  it('exits 0 saying already running when a studio for the same folder holds the port', async () => {
    const port = await listen((req, res) => {
      if (req.url === '/api/project') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ dir, platform: 'android' }));
      else res.writeHead(404).end();
    });
    const cli = start([dir, '--port', String(port), '--no-open', '--session', name()]);
    expect(await cli.exit).toBe(0);
    expect(cli.output()).toContain(`already running for this project at http://127.0.0.1:${port}`);
  }, 30_000);
});
