import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startStudio, studioUrl, type RunningStudio } from '../src/server/index.ts';
import type { DeviceLike } from '../src/server/state.ts';

// A session that is never opened; nothing here may reach a device.
const idleSession = {
  isOpen: false,
  deviceId: undefined,
  appId: undefined,
  async close() {},
} as unknown as DeviceLike;

const INDEX = '<!doctype html><title>Ariadne test UI</title>';

let dir: string;
let uiDir: string;
let studio: RunningStudio | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ariadne-start-studio-'));
  uiDir = await mkdtemp(join(tmpdir(), 'ariadne-start-studio-ui-'));
});
afterEach(async () => {
  await studio?.close();
  studio = undefined;
  await rm(dir, { recursive: true, force: true });
  await rm(uiDir, { recursive: true, force: true });
});

describe('studioUrl', () => {
  it('uses the host as it is for a loopback IPv4 address', () => {
    expect(studioUrl('127.0.0.1', 4711)).toBe('http://127.0.0.1:4711');
  });

  it('points a browser at 127.0.0.1 for 0.0.0.0', () => {
    expect(studioUrl('0.0.0.0', 80)).toBe('http://127.0.0.1:80');
  });

  it('points a browser at 127.0.0.1 for ::', () => {
    expect(studioUrl('::', 4711)).toBe('http://127.0.0.1:4711');
  });

  it('brackets an IPv6 address such as ::1', () => {
    expect(studioUrl('::1', 4711)).toBe('http://[::1]:4711');
  });

  it('leaves a host name alone', () => {
    expect(studioUrl('localhost', 3000)).toBe('http://localhost:3000');
  });
});

describe('startStudio', () => {
  it('listens on a free port when given 0 and returns a url that answers', async () => {
    studio = await startStudio({ projectDir: dir, session: idleSession, port: 0, uiDir: join(uiDir, 'missing') });
    expect(studio.port).toBeGreaterThan(0);
    expect(studio.url).toBe(`http://127.0.0.1:${studio.port}`);
    expect(studio.projectDir).toBe(dir);

    const response = await fetch(`${studio.url}/api/project`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dir, platform: 'android' });
  });

  it('serves index.html at / and falls back to it for unknown non-API paths', async () => {
    await writeFile(join(uiDir, 'index.html'), INDEX);
    studio = await startStudio({ projectDir: dir, session: idleSession, port: 0, uiDir });
    expect(studio.servesUi).toBe(true);

    const root = await fetch(`${studio.url}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toBe(INDEX);

    const deep = await fetch(`${studio.url}/cases/some-case`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toBe(INDEX);
  });

  it('serves other files from uiDir as themselves', async () => {
    await writeFile(join(uiDir, 'index.html'), INDEX);
    await writeFile(join(uiDir, 'app.js'), 'console.log(1);');
    studio = await startStudio({ projectDir: dir, session: idleSession, port: 0, uiDir });
    expect(await (await fetch(`${studio.url}/app.js`)).text()).toBe('console.log(1);');
  });

  it('answers an unknown /api/ path with a JSON 404 instead of the UI', async () => {
    await writeFile(join(uiDir, 'index.html'), INDEX);
    studio = await startStudio({ projectDir: dir, session: idleSession, port: 0, uiDir });
    const response = await fetch(`${studio.url}/api/does-not-exist`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('serves no UI and reports servesUi false when uiDir does not exist', async () => {
    studio = await startStudio({ projectDir: dir, session: idleSession, port: 0, uiDir: join(uiDir, 'missing') });
    expect(studio.servesUi).toBe(false);
    expect((await fetch(`${studio.url}/`)).status).toBe(404);
    expect((await fetch(`${studio.url}/api/project`)).status).toBe(200);
  });

  it('rejects with EADDRINUSE when the port is taken and leaves the first server working', async () => {
    studio = await startStudio({ projectDir: dir, session: idleSession, port: 0, uiDir: join(uiDir, 'missing') });
    const second = await mkdtemp(join(tmpdir(), 'ariadne-start-studio-'));
    try {
      await expect(startStudio({ projectDir: second, session: idleSession, port: studio.port, uiDir: join(uiDir, 'missing') })).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
      expect((await fetch(`${studio.url}/api/project`)).status).toBe(200);
    } finally {
      await rm(second, { recursive: true, force: true });
    }
  });

  it('stops answering after close()', async () => {
    const running = await startStudio({ projectDir: dir, session: idleSession, port: 0, uiDir: join(uiDir, 'missing') });
    await running.close();
    await expect(fetch(`${running.url}/api/project`)).rejects.toThrow();
  });
});
