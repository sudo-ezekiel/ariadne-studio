// A rename cannot cross drives, so when it fails the picture is copied instead.
// This file mocks `rename` to fail the way a cross-drive move does.
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blackPicture } from '@ariadne/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), copyFile: vi.fn(actual.copyFile), writeFile: vi.fn(actual.writeFile) };
});

import * as fsPromises from 'node:fs/promises';
import { captureInto } from '../src/server/common.ts';
import { capturingScreenshot, type ServerState } from '../src/server/state.ts';

const VIEWPORT = { width: 1080, height: 2400 };
const LIT = Buffer.from('a lit picture');
const realWriteFile = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile;

describe('captureInto when the picture cannot be renamed into place', () => {
  let dir: string;
  let state: ServerState;
  let answer: boolean | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ariadne-move-test-'));
    answer = false;
    const session = {
      deviceId: 'phone',
      async capture(path: string) {
        await writeFile(path, LIT);
        return { nodes: [], viewport: VIEWPORT, takenAt: new Date().toISOString(), screenshotPath: path };
      },
    };
    state = { session, scratchDir: dir, phoneTools: { locked: async () => answer } } as unknown as ServerState;
    vi.mocked(fsPromises.rename).mockRejectedValue(Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }));
    vi.mocked(fsPromises.writeFile).mockImplementation(((...args: Parameters<typeof fsPromises.writeFile>) => realWriteFile(...args)) as typeof fsPromises.writeFile);
  });

  afterEach(async () => {
    vi.mocked(fsPromises.rename).mockReset();
    vi.mocked(fsPromises.copyFile).mockReset();
    vi.mocked(fsPromises.writeFile).mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  const gone = (path: string) => access(path).then(() => false, () => true);

  it('copies the picture to the destination, in a folder that did not exist, and removes the private file', async () => {
    const path = join(dir, 'evidence', 'case-1', '001.png');
    const latest = await captureInto(state, path);
    expect(fsPromises.rename).toHaveBeenCalled();
    expect((await readFile(path)).equals(LIT)).toBe(true);
    expect(latest.screenshotPath).toBe(path);
    expect(await gone(capturingScreenshot(state))).toBe(true);
  });

  it('copies a black picture, not the lit one, when the phone is locked', async () => {
    answer = true;
    const path = join(dir, 'screen.png');
    const latest = await captureInto(state, path);
    expect((await readFile(path)).equals(blackPicture(VIEWPORT))).toBe(true);
    expect(latest.hidden).toBe(true);
    expect(await gone(capturingScreenshot(state))).toBe(true);
  });

  it('rejects with the copy error, and still removes the private file, when the copy also fails', async () => {
    const failure = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    vi.mocked(fsPromises.copyFile).mockRejectedValue(failure);
    const path = join(dir, 'screen.png');
    await expect(captureInto(state, path)).rejects.toBe(failure);
    expect(await gone(capturingScreenshot(state))).toBe(true);
    expect(await gone(path)).toBe(true);
  });

  it('rejects with the write error, and removes the private file, when the black-out write fails for a locked phone', async () => {
    answer = true;
    const failure = Object.assign(new Error('disk is read-only'), { code: 'EROFS' });
    const black = blackPicture(VIEWPORT);
    vi.mocked(fsPromises.writeFile).mockImplementation(((path, data, ...rest) =>
      Buffer.isBuffer(data) && data.equals(black) ? Promise.reject(failure) : realWriteFile(path, data, ...rest)) as typeof fsPromises.writeFile);
    const path = join(dir, 'screen.png');
    await expect(captureInto(state, path)).rejects.toBe(failure);
    expect(await gone(capturingScreenshot(state))).toBe(true);
    expect(await gone(path)).toBe(true);
  });

  it('rejects, and removes the private file, when the destination folder cannot be created', async () => {
    const blocker = join(dir, 'not-a-folder');
    await writeFile(blocker, 'a plain file');
    const path = join(blocker, 'inside', '001.png');
    await expect(captureInto(state, path)).rejects.toThrow();
    expect(await gone(capturingScreenshot(state))).toBe(true);
    expect(await gone(path)).toBe(true);
  });
});
