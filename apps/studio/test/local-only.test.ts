// The API drives a phone and hands out screenshots, so it answers only to
// pages from this computer. The pure checks are tried with the headers a
// browser sends; the server tests send them through the real hook.
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceSnapshot, OpenOptions } from '@ariadne/core';
import { buildServer, startStudio, type RunningStudio } from '../src/server/index.ts';
import { fromThisComputer, isLoopback } from '../src/server/local-only.ts';
import type { DeviceLike } from '../src/server/state.ts';

describe('isLoopback', () => {
  it.each(['127.0.0.1', 'localhost', 'LOCALHOST', '[::1]', '::1'])('is true for %s', (host) => {
    expect(isLoopback(host)).toBe(true);
  });

  it.each(['0.0.0.0', '::', '192.168.1.20', 'localhost.evil.example', '127.0.0.1.evil.example', '', 'my-laptop'])('is false for %s', (host) => {
    expect(isLoopback(host)).toBe(false);
  });
});

describe('fromThisComputer on the default 127.0.0.1', () => {
  const allowed = (headers: Parameters<typeof fromThisComputer>[0]) => fromThisComputer(headers, '127.0.0.1');

  it.each([
    ['a rebound name', { host: 'evil.example' }],
    ['a rebound name with a port', { host: 'evil.example:4711' }],
    ['a lookalike Host', { host: 'localhost.evil.example' }],
    ['a lookalike Host with a port', { host: 'localhost.evil.example:4711' }],
    ['a lookalike of 127.0.0.1 as Host', { host: '127.0.0.1.evil.example:4711' }],
    ['a LAN address as Host', { host: '192.168.1.20:4711' }],
    ['a missing Host', {}],
    ['an empty Host', { host: '' }],
  ])('refuses %s', (_name, headers) => {
    expect(allowed(headers)).toBe(false);
  });

  it.each([
    ['another site as Origin', { origin: 'https://evil.example' }],
    ['another site on the loopback port as Origin', { origin: 'https://evil.example:4711' }],
    ['an unparseable Origin', { origin: 'not a url' }],
    ['Origin null', { origin: 'null' }],
    ['a lookalike Origin', { origin: 'http://127.0.0.1.evil.example' }],
    ['a lookalike localhost Origin', { origin: 'http://localhost.evil.example:5173' }],
    ['a loopback name used as a user name in Origin', { origin: 'http://localhost@evil.example' }],
    ['cross-site fetch metadata', { 'sec-fetch-site': 'cross-site' }],
    ['same-site fetch metadata is not enough on its own with a foreign Origin', { 'sec-fetch-site': 'same-site', origin: 'https://evil.example' }],
    ['cross-site even from a loopback Origin', { origin: 'http://localhost:5173', 'sec-fetch-site': 'cross-site' }],
  ])('refuses %s', (_name, extra) => {
    expect(allowed({ host: '127.0.0.1:4711', ...extra })).toBe(false);
  });

  it.each(['127.0.0.1:4711', 'localhost:4711', '[::1]:4711', '127.0.0.1', 'localhost', 'LOCALHOST:4711', '[::1]'])('allows Host %s with no Origin', (host) => {
    expect(allowed({ host })).toBe(true);
  });

  it.each([
    ['its own Origin', 'http://127.0.0.1:4711'],
    ['the Vite dev server', 'http://localhost:5173'],
    ['an IPv6 loopback Origin', 'http://[::1]:5173'],
  ])('allows %s', (_name, origin) => {
    expect(allowed({ host: '127.0.0.1:4711', origin })).toBe(true);
  });

  it.each(['same-origin', 'none'])('allows sec-fetch-site: %s', (site) => {
    expect(allowed({ host: '127.0.0.1:4711', 'sec-fetch-site': site })).toBe(true);
  });

  // KNOWN GAP (low): the Headers type admits string[] but the check compares
  // sec-fetch-site with === 'cross-site', so an array (or Node's joined
  // "same-origin, cross-site") passes. A browser sets this header itself, so a
  // page cannot exploit it, and the Origin check still applies. Left failing.
  it('refuses a cross-site header sent more than once', () => {
    expect(allowed({ host: '127.0.0.1:4711', 'sec-fetch-site': ['same-origin', 'cross-site'] })).toBe(false);
  });
});

describe('fromThisComputer when listening on 0.0.0.0 on purpose', () => {
  const allowed = (headers: Parameters<typeof fromThisComputer>[0]) => fromThisComputer(headers, '0.0.0.0');

  it('allows a LAN Host with no Origin', () => {
    expect(allowed({ host: '192.168.1.20:4711' })).toBe(true);
  });

  it('allows a LAN Host with its own Origin', () => {
    expect(allowed({ host: '192.168.1.20:4711', origin: 'http://192.168.1.20:4711' })).toBe(true);
  });

  it('still refuses another site\'s Origin', () => {
    expect(allowed({ host: '192.168.1.20:4711', origin: 'https://evil.example' })).toBe(false);
  });

  it('refuses an Origin on the same name but another port', () => {
    expect(allowed({ host: '192.168.1.20:4711', origin: 'http://192.168.1.20:9999' })).toBe(false);
  });

  it('still refuses cross-site fetch metadata', () => {
    expect(allowed({ host: '192.168.1.20:4711', 'sec-fetch-site': 'cross-site' })).toBe(false);
  });

  it('still allows the loopback Vite origin', () => {
    expect(allowed({ host: '192.168.1.20:4711', origin: 'http://localhost:5173' })).toBe(true);
  });
});

// ------------------------------------------------------------------ server

type Node = DeviceSnapshot['nodes'][number];

class CountingDevice implements DeviceLike {
  target: { deviceId: string; appId: string } | undefined;
  calls: string[] = [];
  get isOpen() { return this.target !== undefined; }
  get deviceId() { return this.target?.deviceId; }
  get appId() { return this.target?.appId; }
  async listDevices() {
    this.calls.push('listDevices');
    return [];
  }
  async open(options: OpenOptions) {
    this.calls.push('open');
    this.target = { deviceId: options.deviceId, appId: options.appId };
  }
  async snapshot(): Promise<DeviceSnapshot> {
    this.calls.push('snapshot');
    return { nodes: [] as Node[], viewport: { width: 1080, height: 2400 }, takenAt: new Date().toISOString() };
  }
  async capture(screenshotPath: string) {
    this.calls.push('capture');
    return { ...(await this.snapshot()), screenshotPath };
  }
  async back() { this.calls.push('back'); }
  async close() { this.target = undefined; }
  async tapAt() { this.calls.push('tapAt'); }
  async typeText() { this.calls.push('typeText'); }
  async scroll() { this.calls.push('scroll'); }
  async replayFlow() { this.calls.push('replayFlow'); return { replayed: 0 }; }
  async relaunchApp() { this.calls.push('relaunchApp'); }
  async openLink() { this.calls.push('openLink'); }
  async hideKeyboard() { this.calls.push('hideKeyboard'); }
  async longPressAt() { this.calls.push('longPressAt'); }
  async doubleTapAt() { this.calls.push('doubleTapAt'); }
  async swipe() { this.calls.push('swipe'); }
  async pinch() { this.calls.push('pinch'); }
  async pressKey() { this.calls.push('pressKey'); }
  async setOrientation() { this.calls.push('setOrientation'); }
}

let dir: string;
let apps: FastifyInstance[] = [];
let studio: RunningStudio | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ariadne-local-only-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps) await app.close();
  apps = [];
  await studio?.close();
  studio = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function server(listenHost?: string) {
  const device = new CountingDevice();
  const app = await buildServer({
    projectDir: dir,
    session: device,
    maestro: { findBin: () => '/opt/maestro/bin/maestro', androidHome: () => undefined },
    ...(listenHost ? { listenHost } : {}),
  });
  apps.push(app);
  return { app, device };
}

const REFUSED = { status: 403, body: { error: { code: 'NOT_THIS_COMPUTER' } } };

async function refused(response: Awaited<ReturnType<FastifyInstance['inject']>>) {
  return { status: response.statusCode, body: response.json() };
}

describe('the server', () => {
  it('refuses a POST /api/action/back from another site and does not touch the device', async () => {
    const { app, device } = await server();
    await app.inject({ method: 'POST', url: '/api/session/open', payload: { deviceId: 'R58M123', appId: 'com.example' } });
    device.calls.length = 0;
    const response = await app.inject({ method: 'POST', url: '/api/action/back', headers: { origin: 'https://evil.example' } });
    expect(await refused(response)).toMatchObject(REFUSED);
    expect(device.calls).toEqual([]);
  });

  it('does the same POST /api/action/back for this computer\'s own page, so the refusal is the Origin and nothing else', async () => {
    const { app, device } = await server();
    await app.inject({ method: 'POST', url: '/api/session/open', payload: { deviceId: 'R58M123', appId: 'com.example' } });
    const response = await app.inject({ method: 'POST', url: '/api/action/back', headers: { origin: 'http://localhost:5173' } });
    expect(response.statusCode).toBe(200);
    expect(device.calls).toContain('back');
  });

  it('refuses GET /api/diagnostics from another site, with no zip', async () => {
    const { app } = await server();
    const response = await app.inject({ method: 'GET', url: '/api/diagnostics', headers: { origin: 'https://evil.example' } });
    expect(await refused(response)).toMatchObject(REFUSED);
    expect(response.headers['content-type']).toMatch(/json/);
    expect(response.headers['content-disposition']).toBeUndefined();
  });

  it('refuses a request whose Host is a rebound name', async () => {
    const { app, device } = await server();
    const response = await app.inject({ method: 'GET', url: '/api/screen/refresh', headers: { host: 'evil.example:4711' } });
    expect(await refused(response)).toMatchObject(REFUSED);
    expect(device.calls).toEqual([]);
  });

  it('refuses a request marked cross-site by the browser', async () => {
    const { app } = await server();
    const response = await app.inject({ method: 'GET', url: '/api/session', headers: { 'sec-fetch-site': 'cross-site' } });
    expect(response.statusCode).toBe(403);
  });

  it('refuses every method on an API path, such as an OPTIONS preflight from another site', async () => {
    const { app } = await server();
    const response = await app.inject({ method: 'OPTIONS', url: '/api/action/back', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(response.statusCode).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses the evidence and screen image routes too, which hold screenshots', async () => {
    const { app } = await server();
    for (const url of ['/api/screen/image', '/api/evidence/a/step-001.png', '/api/runs/x/video.mp4']) {
      const response = await app.inject({ method: 'GET', url, headers: { host: 'evil.example' } });
      expect(response.statusCode, url).toBe(403);
    }
  });

  it('does not block a path outside /api/, whoever asks', async () => {
    const { app } = await server();
    const response = await app.inject({ method: 'GET', url: '/', headers: { origin: 'https://evil.example', host: 'evil.example' } });
    expect(response.statusCode).not.toBe(403);
  });

  it('answers a normal request with inject\'s default headers', async () => {
    const { app } = await server();
    expect((await app.inject({ method: 'GET', url: '/api/session' })).statusCode).toBe(200);
  });

  it('answers a request with a loopback Host and its own Origin', async () => {
    const { app } = await server();
    const response = await app.inject({ method: 'GET', url: '/api/session', headers: { host: '127.0.0.1:4711', origin: 'http://127.0.0.1:4711', 'sec-fetch-site': 'same-origin' } });
    expect(response.statusCode).toBe(200);
  });

  it('serves a LAN Host when told it listens on 0.0.0.0, and still refuses another site', async () => {
    const { app } = await server('0.0.0.0');
    expect((await app.inject({ method: 'GET', url: '/api/session', headers: { host: '192.168.1.20:4711' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/session', headers: { host: '192.168.1.20:4711', origin: 'https://evil.example' } })).statusCode).toBe(403);
  });

  it('refuses a LAN Host when listenHost is left at its default', async () => {
    const { app } = await server();
    expect((await app.inject({ method: 'GET', url: '/api/session', headers: { host: '192.168.1.20:4711' } })).statusCode).toBe(403);
  });
});

describe('startStudio passes its host through as listenHost', () => {
  const get = (port: number, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/setup', headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });

  const options = () => ({
    projectDir: dir,
    session: new CountingDevice(),
    maestro: { findBin: () => '/opt/maestro/bin/maestro', androidHome: () => undefined },
    uiDir: join(dir, 'no-ui'),
    port: 0,
  });

  it('refuses a rebound Host when listening on 127.0.0.1', async () => {
    studio = await startStudio({ ...options(), host: '127.0.0.1' });
    expect(await get(studio.port, { host: 'evil.example' })).toBe(403);
    expect(await get(studio.port, { host: `127.0.0.1:${studio.port}` })).toBe(200);
  });

  it('accepts another Host name when listening on 0.0.0.0', async () => {
    studio = await startStudio({ ...options(), host: '0.0.0.0' });
    expect(await get(studio.port, { host: `192.168.1.20:${studio.port}` })).toBe(200);
    expect(await get(studio.port, { host: `192.168.1.20:${studio.port}`, origin: 'https://evil.example' })).toBe(403);
  });

  it('treats no host option as 127.0.0.1', async () => {
    studio = await startStudio(options());
    expect(await get(studio.port, { host: 'evil.example' })).toBe(403);
  });
});
