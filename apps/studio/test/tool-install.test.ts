// "Set up this computer". The network, the unpacker and the programs it starts
// are fakes, so these tests download nothing; the moves on disk are real.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolsDir } from '@ariadne/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultInstallIo, ToolInstaller, type InstallIo, type ToolDownload } from '../src/server/tool-install.ts';
import type { ToolId } from '../src/shared/api-types.ts';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function toolDownload(id: ToolId, name: string, body: string): ToolDownload {
  return { id, name, url: `https://example.test/${id}.zip`, bytes: body.length, sha256: sha256(body), host: 'example.test', check: { file: 'run.exe', args: ['--version'] } };
}

const DOWNLOADS = [toolDownload('adb', 'Android tools', 'adb body'), toolDownload('java', 'Java', 'java body'), toolDownload('maestro', 'Maestro', 'maestro body')];

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ariadne-tools-test-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

type Fakes = {
  /** URL to what the server sends, or the failure of the request. */
  responses?: Record<string, string | Error>;
  start?: InstallIo['start'];
  unzip?: InstallIo['unzip'];
};

function fakeIo(fakes: Fakes = {}): InstallIo & { fetch: ReturnType<typeof vi.fn>; unzip: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> } {
  const responses = fakes.responses ?? {};
  return {
    downloads: DOWNLOADS,
    workDir: join(base, '.incoming'),
    destination: (id) => join(base, 'installed', id),
    fetch: vi.fn(async (url: string) => {
      const answer = responses[url] ?? `${/\/(\w+)\.zip$/.exec(url)?.[1]} body`;
      if (answer instanceof Error) throw answer;
      return new Response(answer);
    }) as never,
    // Each of the real zips holds one folder with everything in it.
    unzip: vi.fn(
      fakes.unzip ??
        (async (zipFile: string, into: string) => {
          await mkdir(join(into, 'top'), { recursive: true });
          await writeFile(join(into, 'top', 'unpacked.txt'), await readFile(zipFile, 'utf8'));
        }),
    ),
    start: vi.fn(fakes.start ?? (async () => undefined)),
  };
}

async function installed(id: ToolId): Promise<string> {
  return readFile(join(base, 'installed', id, 'unpacked.txt'), 'utf8');
}

async function run(io: InstallIo, ids: ToolId[]): Promise<ToolInstaller> {
  const installer = new ToolInstaller(io);
  installer.start(ids);
  await installer.finished();
  return installer;
}

describe('ToolInstaller', () => {
  it('fetches what it is asked for, in order, and puts each in its folder', async () => {
    const io = fakeIo();
    const installer = await run(io, ['maestro', 'adb']);
    expect(io.fetch.mock.calls.map(([url]) => url)).toEqual(['https://example.test/adb.zip', 'https://example.test/maestro.zip']);
    expect(await installed('adb')).toBe('adb body');
    expect(await installed('maestro')).toBe('maestro body');
    expect(existsSync(join(base, 'installed', 'java'))).toBe(false);
    expect(installer.status().tools.map((tool) => [tool.id, tool.state])).toEqual([
      ['adb', 'done'],
      ['maestro', 'done'],
    ]);
    expect(installer.status().running).toBe(false);
  });

  it('counts the bytes that arrive and starts each tool once it is in place', async () => {
    const io = fakeIo();
    const installer = await run(io, ['adb']);
    expect(installer.status().tools[0]).toMatchObject({ received: 'adb body'.length, total: 'adb body'.length });
    expect(io.start).toHaveBeenCalledWith(join(base, 'installed', 'adb', 'run.exe'), ['--version']);
  });

  it('never unpacks or starts a file that does not match its hash', async () => {
    const io = fakeIo({ responses: { 'https://example.test/adb.zip': 'tampered body' } });
    const installer = await run(io, ['adb']);
    expect(io.unzip).not.toHaveBeenCalled();
    expect(io.start).not.toHaveBeenCalled();
    expect(existsSync(join(base, 'installed', 'adb'))).toBe(false);
    expect(installer.status().tools[0]).toMatchObject({ state: 'failed' });
    expect(installer.status().tools[0]?.error).toContain('did not match');
  });

  it('carries on with the next tool after a failed download, and says who can unblock it', async () => {
    const io = fakeIo({ responses: { 'https://example.test/adb.zip': new TypeError('fetch failed') } });
    const installer = await run(io, ['adb', 'java']);
    const [adb, java] = installer.status().tools;
    expect(adb).toMatchObject({ state: 'failed' });
    expect(adb?.error).toContain('IT team');
    expect(adb?.error).toContain('example.test');
    expect(java).toMatchObject({ state: 'done' });
    expect(await installed('java')).toBe('java body');
  });

  it('says when the computer has no room', async () => {
    const io = fakeIo({ responses: { 'https://example.test/adb.zip': Object.assign(new Error('no space'), { code: 'ENOSPC' }) } });
    const installer = await run(io, ['adb']);
    expect(installer.status().tools[0]?.error).toContain('free disk space');
  });

  it('says when a download cannot be unpacked', async () => {
    const io = fakeIo({
      unzip: async () => {
        throw new Error('tar failed');
      },
    });
    const installer = await run(io, ['adb']);
    expect(installer.status().tools[0]?.error).toContain('could not unpack');
    expect(io.start).not.toHaveBeenCalled();
  });

  it('refuses a download that does not hold the one folder it should', async () => {
    const io = fakeIo({
      unzip: async (_zipFile, into) => {
        await mkdir(join(into, 'one'));
        await mkdir(join(into, 'two'));
      },
    });
    const installer = await run(io, ['adb']);
    expect(installer.status().tools[0]?.error).toContain('was not what Ariadne expected');
    expect(existsSync(join(base, 'installed', 'adb'))).toBe(false);
  });

  it('names the folder to allow when Windows will not start a tool', async () => {
    const io = fakeIo({
      start: async () => {
        throw Object.assign(new Error('This program is blocked by group policy.'), { code: 'EPERM' });
      },
    });
    const installer = await run(io, ['adb']);
    const { error, state } = installer.status().tools[0]!;
    expect(state).toBe('failed');
    expect(error).toContain('would not start');
    expect(error).toContain(join(base, 'installed', 'adb'));
  });

  it.each(['EACCES', 'EPERM', 'UNKNOWN'])('blames Windows for a tool that fails to start with %s', async (code) => {
    const io = fakeIo({
      start: async () => {
        throw Object.assign(new Error('blocked'), { code });
      },
    });
    const installer = await run(io, ['adb']);
    expect(installer.status().tools[0]?.error).toContain('would not start');
  });

  it.each([
    ['a non-zero exit', Object.assign(new Error('exit 1'), { code: 1 })],
    ['a timeout', Object.assign(new Error('timed out'), { killed: true })],
    ['a missing file', Object.assign(new Error('not found'), { code: 'ENOENT' })],
  ])('does not blame Windows or the IT team for %s when starting a tool', async (_name, failure) => {
    const io = fakeIo({
      start: async () => {
        throw failure;
      },
    });
    const installer = await run(io, ['adb']);
    const { error, state } = installer.status().tools[0]!;
    expect(state).toBe('failed');
    expect(error).toContain('did not start correctly');
    expect(error).not.toContain('would not start');
    expect(error).not.toContain('IT team');
  });

  it('readies the tools folder before anything is fetched', async () => {
    const order: string[] = [];
    const io = fakeIo();
    io.prepare = async () => {
      order.push('prepare');
    };
    io.fetch.mockImplementation((async () => {
      order.push('fetch');
      return new Response('adb body');
    }) as never);
    await run(io, ['adb']);
    expect(order[0]).toBe('prepare');
    expect(order).toContain('fetch');
  });

  it('fetches and unpacks nothing when the tools folder cannot be readied, and says so for every tool', async () => {
    const io = fakeIo();
    io.prepare = async () => {
      throw new Error('icacls failed');
    };
    const installer = await run(io, ['adb', 'java']);
    expect(io.fetch).not.toHaveBeenCalled();
    expect(io.unzip).not.toHaveBeenCalled();
    expect(io.start).not.toHaveBeenCalled();
    const tools = installer.status().tools;
    expect(tools.map((tool) => tool.state)).toEqual(['failed', 'failed']);
    // A plain Error from a fake prepare is not a PlainError, so explain words it as a failed download.
    for (const tool of tools) expect(tool.error).toContain('Could not download');
  });

  it('does not start Maestro when Java failed, which would only report the same thing again', async () => {
    const io = fakeIo({ responses: { 'https://example.test/java.zip': new TypeError('fetch failed') } });
    const installer = await run(io, ['java', 'maestro']);
    expect(io.start).not.toHaveBeenCalled();
    expect(installer.status().tools.find((tool) => tool.id === 'maestro')).toMatchObject({ state: 'done' });
  });

  it('replaces what a failed try left in the folder', async () => {
    await mkdir(join(base, 'installed', 'adb'), { recursive: true });
    await writeFile(join(base, 'installed', 'adb', 'old.txt'), 'old');
    await run(fakeIo(), ['adb']);
    expect(await readdir(join(base, 'installed', 'adb'))).toEqual(['unpacked.txt']);
  });

  it('leaves nothing behind in its work folder', async () => {
    await run(fakeIo(), ['adb', 'java']);
    expect(existsSync(join(base, '.incoming'))).toBe(false);
  });

  it('can try again after a failure', async () => {
    const responses: Record<string, string | Error> = { 'https://example.test/adb.zip': new TypeError('fetch failed') };
    const installer = new ToolInstaller(fakeIo({ responses }));
    installer.start(['adb']);
    await installer.finished();
    expect(installer.status().tools[0]).toMatchObject({ state: 'failed' });
    delete responses['https://example.test/adb.zip'];
    installer.start(['adb']);
    await installer.finished();
    expect(installer.status().tools[0]).toMatchObject({ state: 'done' });
    expect(installer.status().tools[0]?.error).toBeUndefined();
  });

  it('ignores a second start while one is running', async () => {
    const io = fakeIo();
    const installer = new ToolInstaller(io);
    installer.start(['adb']);
    installer.start(['java']);
    expect(installer.status().running).toBe(true);
    await installer.finished();
    expect(io.fetch).toHaveBeenCalledTimes(1);
    expect(installer.status().tools.map((tool) => tool.id)).toEqual(['adb']);
  });

  it('does nothing when there is nothing to fetch', () => {
    const installer = new ToolInstaller(fakeIo());
    installer.start([]);
    expect(installer.status()).toMatchObject({ running: false, tools: [] });
  });

  it('says what it has on offer, with sizes', () => {
    const { available, offered } = new ToolInstaller(fakeIo()).status();
    expect(available).toBe(true);
    expect(offered.map((tool) => tool.id)).toEqual(['adb', 'java', 'maestro']);
    expect(offered[0]).toEqual({ id: 'adb', name: 'Android tools', bytes: 'adb body'.length });
  });
});

describe('defaultInstallIo', () => {
  const WINDOWS = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };

  it('offers all three tools on Windows x64, pinned to https and a SHA-256', () => {
    const { downloads } = defaultInstallIo(() => undefined, WINDOWS, 'win32', 'x64');
    expect(downloads.map((download) => download.id)).toEqual(['adb', 'java', 'maestro']);
    for (const download of downloads) {
      expect(download.url).toMatch(/^https:\/\//);
      expect(download.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(download.bytes).toBeGreaterThan(0);
    }
  });

  it.each([
    ['linux', 'x64'],
    ['darwin', 'arm64'],
    ['win32', 'arm64'],
  ] as const)('offers nothing on %s %s, which keeps the manual steps', (platform, arch) => {
    expect(defaultInstallIo(() => undefined, WINDOWS, platform, arch).downloads).toEqual([]);
    expect(new ToolInstaller(defaultInstallIo(() => undefined, WINDOWS, platform, arch)).status().available).toBe(false);
  });

  it('puts adb in the Android SDK the checks look in, and Java and Maestro in its own folder', () => {
    const io = defaultInstallIo(() => 'D:/sdk', WINDOWS, 'win32', 'x64');
    expect(io.destination('adb')).toBe(join('D:/sdk', 'platform-tools'));
    expect(io.destination('java')).toBe(join(toolsDir(WINDOWS, 'win32')!, 'java'));
    expect(io.destination('maestro')).toBe(join(toolsDir(WINDOWS, 'win32')!, 'maestro'));
  });

  it('still offers the downloads and puts Java under ProgramData for a Greek LOCALAPPDATA, without claiming the folder yet', () => {
    const greek = { LOCALAPPDATA: 'C:\\Users\\Δημήτρης\\AppData\\Local', ProgramData: 'C:\\ProgramData' };
    const io = defaultInstallIo(() => 'D:/sdk', greek, 'win32', 'x64');
    expect(io.downloads.map((download) => download.id)).toEqual(['adb', 'java', 'maestro']);
    expect(io.destination('java')).toBe(join('C:\\ProgramData\\Ariadne\\tools', 'java'));
    expect(io.prepare).toBeTypeOf('function');
  });

  it('has nothing to claim when the tools go in the user\'s own folder', async () => {
    const io = defaultInstallIo(() => undefined, WINDOWS, 'win32', 'x64');
    await expect(io.prepare!()).resolves.toBeUndefined();
  });
});
