import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server/index.ts';
import type { DeviceLike } from '../src/server/state.ts';

// Smallest valid PNG (1x1), so the image route has something to stream.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

// The Files routes never touch the device. Only the close hook reads isOpen.
const noDevice = new Proxy({ isOpen: false }, {
  get: (target, property) => {
    if (property in target) return target[property as 'isOpen'];
    throw new Error(`The device was not expected to be used by the Files routes (${String(property)})`);
  },
}) as unknown as DeviceLike;

// base/proj is the project; base/outside and base/proj-other sit beside it.
let base: string;
let dir: string;
let app: FastifyInstance | undefined;

async function start() {
  app = await buildServer({
    projectDir: dir,
    session: noDevice,
    maestro: { run: async () => { throw new Error('Maestro was not expected to run'); }, findBin: () => '/opt/maestro/bin/maestro', androidHome: () => undefined },
  });
}

function query(path?: string): string {
  return path === undefined ? '' : `?${new URLSearchParams({ path }).toString()}`;
}

async function get(route: 'list' | 'content' | 'image' | '', path?: string) {
  const url = `/api/files${route ? `/${route}` : ''}${query(path)}`;
  const response = await app!.inject({ method: 'GET', url });
  return { status: response.statusCode, body: response.headers['content-type']?.includes('json') ? response.json() : response.body, response };
}

async function put(relativePath: string, content: string | Buffer = 'x') {
  const file = join(base, relativePath);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content);
}

async function names(path: string): Promise<string[]> {
  const listed = await get('list', path);
  expect(listed.status).toBe(200);
  return listed.body.entries.map((entry: { name: string }) => entry.name);
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ariadne-files-test-'));
  dir = join(base, 'proj');
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(base, { recursive: true, force: true });
});

describe('files routes: secrets', () => {
  const SECRET_NAMES = ['.env', '.env.local', '.ENV', '.envrc'];

  it('leaves .env style files out of the project listing', async () => {
    for (const name of SECRET_NAMES) await put(`proj/${name}`, 'TOKEN=1');
    await put('proj/visible.txt');
    await start();
    const listed = await names('.');
    expect(listed).toContain('visible.txt');
    for (const name of SECRET_NAMES) expect(listed).not.toContain(name);
  });

  it('leaves .env style files out of a subfolder listing', async () => {
    for (const name of SECRET_NAMES) await put(`proj/blocks/${name}`, 'TOKEN=1');
    await put('proj/blocks/a.yaml');
    await start();
    expect(await names('blocks')).toEqual(['a.yaml']);
  });

  it.each(['.env', '.env.local', '.ENV', '.envrc', 'blocks/.env', 'blocks/.ENV', 'blocks/.envrc'])(
    'content returns 404 for %s',
    async (path) => {
      await put(`proj/${path}`, 'TOKEN=1');
      await start();
      const result = await get('content', path);
      expect(result.status).toBe(404);
      expect(JSON.stringify(result.body)).not.toContain('TOKEN');
    },
  );

  it('list returns 404 for a folder whose name starts with .env', async () => {
    await put('proj/.env.d/a.txt');
    await start();
    expect((await get('list', '.env.d')).status).toBe(404);
  });

  it('leaves .git and node_modules out of listings', async () => {
    await put('proj/.git/config', '[core]');
    await put('proj/node_modules/pkg/index.js');
    await put('proj/blocks/node_modules/x.js');
    await put('proj/readme.md');
    await start();
    expect(await names('.')).toEqual(expect.arrayContaining(['blocks', 'readme.md']));
    expect(await names('.')).not.toContain('node_modules');
    expect(await names('.')).not.toContain('.git');
    expect(await names('blocks')).toEqual([]);
  });

  it.each(['.git', '.git/config', 'node_modules', 'node_modules/pkg/index.js', 'blocks/node_modules/x.js'])(
    'content returns 404 for %s',
    async (path) => {
      await put('proj/.git/config', '[core]');
      await put('proj/node_modules/pkg/index.js');
      await put('proj/blocks/node_modules/x.js');
      await start();
      expect((await get('content', path)).status).toBe(404);
    },
  );

  it.each(['.git', '.git/objects', 'node_modules', 'node_modules/pkg'])('list returns 404 for %s', async (path) => {
    await put('proj/.git/objects/a');
    await put('proj/node_modules/pkg/index.js');
    await start();
    expect((await get('list', path)).status).toBe(404);
  });

  it('image returns 404 for a hidden name that looks like a png', async () => {
    await put('proj/.env.png', PNG);
    await put('proj/.git/shot.png', PNG);
    await start();
    expect((await get('image', '.env.png')).status).toBe(404);
    expect((await get('image', '.git/shot.png')).status).toBe(404);
    expect((await get('content', '.env.png')).status).toBe(404);
  });
});

describe('files routes: escaping the project', () => {
  beforeEach(async () => {
    await put('secret.txt', 'outside secret');
    await put('proj/inside.txt', 'inside');
  });

  it('content returns 404 for ../secret.txt', async () => {
    await start();
    const result = await get('content', '../secret.txt');
    expect(result.status).toBe(404);
    expect(JSON.stringify(result.body)).not.toContain('outside secret');
  });

  it('list returns 404 for the parent folder', async () => {
    await start();
    expect((await get('list', '..')).status).toBe(404);
    expect((await get('list', '../')).status).toBe(404);
  });

  it('returns 404 for a path that goes down and back out again', async () => {
    await put('proj/blocks/a.yaml');
    await start();
    expect((await get('content', 'blocks/../../secret.txt')).status).toBe(404);
    expect((await get('list', 'blocks/../..')).status).toBe(404);
  });

  it('returns 404 for an absolute path', async () => {
    await start();
    expect((await get('content', '/etc/passwd')).status).toBe(404);
    expect((await get('list', '/etc')).status).toBe(404);
    expect((await get('content', join(base, 'secret.txt'))).status).toBe(404);
  });

  it('returns 404 for encoded traversal in the query string', async () => {
    await start();
    for (const raw of ['%2e%2e%2fsecret.txt', '..%2Fsecret.txt', encodeURIComponent('../secret.txt')]) {
      for (const route of ['content', 'list', 'image']) {
        const response = await app!.inject({ method: 'GET', url: `/api/files/${route}?path=${raw}` });
        expect(response.statusCode, `${route} ${raw}`).toBe(404);
        expect(response.body).not.toContain('outside secret');
      }
    }
  });

  it('treats a double encoded traversal as a missing name', async () => {
    await start();
    const response = await app!.inject({ method: 'GET', url: '/api/files/content?path=%252e%252e%252fsecret.txt' });
    expect(response.statusCode).toBe(404);
  });

  it('returns 404 for a sibling folder that shares the project name as a prefix', async () => {
    await put('proj-other/a.txt', 'sibling');
    await start();
    const result = await get('content', '../proj-other/a.txt');
    expect(result.status).toBe(404);
    expect(JSON.stringify(result.body)).not.toContain('sibling');
    expect((await get('list', '../proj-other')).status).toBe(404);
  });
});

describe('files routes: symlinks', () => {
  it('does not list a symlinked file that points outside, and content returns 404', async () => {
    await put('secret.txt', 'outside secret');
    await put('proj/real.txt');
    await start();
    await symlink(join(base, 'secret.txt'), join(dir, 'link.txt'));
    expect(await names('.')).toContain('real.txt');
    expect(await names('.')).not.toContain('link.txt');
    const result = await get('content', 'link.txt');
    expect(result.status).toBe(404);
    expect(JSON.stringify(result.body)).not.toContain('outside secret');
  });

  it('serves a symlinked file that points inside the project', async () => {
    await put('proj/real.txt', 'hello');
    await symlink(join(dir, 'real.txt'), join(dir, 'alias.txt'));
    await start();
    expect((await get('content', 'alias.txt')).body).toMatchObject({ kind: 'text', text: 'hello' });
  });

  it('returns 404 for content through a symlink to the project .env', async () => {
    await put('proj/.env', 'TOKEN=1');
    await symlink(join(dir, '.env'), join(dir, 'notes.txt'));
    await start();
    const result = await get('content', 'notes.txt');
    expect(result.status).toBe(404);
    expect(JSON.stringify(result.body)).not.toContain('TOKEN');
  });

  it('returns 404 for a symlink to a hidden file inside a subfolder', async () => {
    await put('proj/.git/config', '[core]');
    await symlink(join(dir, '.git', 'config'), join(dir, 'gitconfig.txt'));
    await start();
    expect((await get('content', 'gitconfig.txt')).status).toBe(404);
  });

  it('returns 404 for a symlink to .env through the image route', async () => {
    await put('proj/.env', PNG);
    await symlink(join(dir, '.env'), join(dir, 'pic.png'));
    await start();
    expect((await get('image', 'pic.png')).status).toBe(404);
  });

  it('skips symlinked folders in listings', async () => {
    await put('outside/a.txt', 'outside');
    await put('proj/real/b.txt');
    await symlink(join(base, 'outside'), join(dir, 'linked'));
    await symlink(join(dir, 'real'), join(dir, 'inner-link'));
    await start();
    const listed = await names('.');
    expect(listed).toContain('real');
    expect(listed).not.toContain('linked');
    expect(listed).not.toContain('inner-link');
  });

  it('returns 404 for list and content through a symlinked folder that leaves the project', async () => {
    await put('outside/a.txt', 'outside');
    await symlink(join(base, 'outside'), join(dir, 'linked'));
    await start();
    expect((await get('list', 'linked')).status).toBe(404);
    expect((await get('content', 'linked/a.txt')).status).toBe(404);
  });
});

describe('files routes: roots', () => {
  it('returns the project folder as the only root by default', async () => {
    await start();
    const result = await get('');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ roots: [{ path: '.', name: 'proj', kind: 'folder' }] });
  });

  async function externalProject(options: { blocks: boolean; flows: boolean }) {
    await put('outside/other.txt', 'beside');
    if (options.blocks) await put('outside/subflows/login.yaml', 'appId: a\n---\n- back\n');
    if (options.flows) await put('outside/recorded/a.yaml', 'appId: a\n---\n- back\n');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'project.json'), JSON.stringify({ paths: { blocks: ['../outside/subflows'], flows: '../outside/recorded' } }));
    await start();
  }

  it('adds block and flows folders kept outside the project as roots', async () => {
    await externalProject({ blocks: true, flows: true });
    const { body } = await get('');
    expect(body.roots).toEqual([
      { path: '.', name: 'proj', kind: 'folder' },
      { path: '../outside/subflows', name: '../outside/subflows', kind: 'folder' },
      { path: '../outside/recorded', name: '../outside/recorded', kind: 'folder' },
    ]);
  });

  it('leaves out an outside folder that does not exist', async () => {
    await externalProject({ blocks: false, flows: true });
    const { body } = await get('');
    expect(body.roots.map((root: { path: string }) => root.path)).toEqual(['.', '../outside/recorded']);
  });

  it('lists and reads files inside an outside root by its relative path', async () => {
    await externalProject({ blocks: true, flows: true });
    const listed = await get('list', '../outside/recorded');
    expect(listed.status).toBe(200);
    expect(listed.body.entries).toEqual([{ path: '../outside/recorded/a.yaml', name: 'a.yaml', kind: 'file' }]);
    const content = await get('content', '../outside/recorded/a.yaml');
    expect(content.body).toMatchObject({ kind: 'text', text: 'appId: a\n---\n- back\n' });
    expect((await get('content', '../outside/subflows/login.yaml')).status).toBe(200);
  });

  it('returns 404 for a file beside an outside root', async () => {
    await externalProject({ blocks: true, flows: true });
    expect((await get('content', '../outside/other.txt')).status).toBe(404);
    expect((await get('list', '../outside')).status).toBe(404);
  });

  it('still hides .env files inside an outside root', async () => {
    await put('outside/recorded/.env', 'TOKEN=1');
    await externalProject({ blocks: false, flows: true });
    expect(await names('../outside/recorded')).toEqual(['a.yaml']);
    expect((await get('content', '../outside/recorded/.env')).status).toBe(404);
  });
});

describe('files routes: listing', () => {
  it('puts folders before files and sorts numbers in order', async () => {
    await put('proj/step-10.yaml');
    await put('proj/step-2.yaml');
    await put('proj/zeta/a.txt');
    await put('proj/alpha/a.txt');
    await put('proj/a-file.txt');
    await start();
    const listed = await names('.');
    const mine = ['alpha', 'zeta', 'a-file.txt', 'step-2.yaml', 'step-10.yaml'];
    expect(listed.filter((name) => mine.includes(name))).toEqual(mine);
    // Folders (scaffolded ones too) all precede the first file.
    const firstFile = listed.indexOf('a-file.txt');
    expect(listed.slice(0, firstFile)).toEqual(expect.arrayContaining(['alpha', 'zeta', 'blocks', 'flows']));
  });

  it('uses relative forward slash paths for entries', async () => {
    await put('proj/flows/a.yaml');
    await put('proj/flows/deep/b.yaml');
    await start();
    expect((await get('list', 'flows')).body.entries).toEqual([
      { path: 'flows/deep', name: 'deep', kind: 'folder' },
      { path: 'flows/a.yaml', name: 'a.yaml', kind: 'file' },
    ]);
    const top = (await get('list', '.')).body.entries;
    expect(top).toContainEqual({ path: 'flows', name: 'flows', kind: 'folder' });
    expect(top.some((entry: { path: string }) => entry.path.startsWith('./'))).toBe(false);
  });

  it('returns an empty list for an empty folder', async () => {
    await mkdir(join(dir, 'empty'));
    await start();
    expect((await get('list', 'empty')).body).toEqual({ entries: [] });
  });

  it('returns 400 when list is asked for a file', async () => {
    await put('proj/a.yaml');
    await start();
    expect((await get('list', 'a.yaml')).status).toBe(400);
  });

  it('returns 404 when list is asked for a missing folder', async () => {
    await start();
    expect((await get('list', 'nope')).status).toBe(404);
  });

  it.each(['list', 'content', 'image'] as const)('returns 400 when %s has no path', async (route) => {
    await start();
    expect((await get(route)).status).toBe(400);
    expect((await get(route, '')).status).toBe(400);
  });
});

describe('files routes: content', () => {
  it('returns a yaml file as text, not truncated', async () => {
    const yaml = 'appId: com.example\n---\n- launchApp\n';
    await put('proj/flows/a.yaml', yaml);
    await start();
    expect((await get('content', 'flows/a.yaml')).body).toEqual({ path: 'flows/a.yaml', name: 'a.yaml', kind: 'text', text: yaml, truncated: false });
  });

  it('returns a file of exactly 512 KiB whole', async () => {
    await put('proj/exact.txt', 'a'.repeat(524288));
    await start();
    const { body } = await get('content', 'exact.txt');
    expect(body.truncated).toBe(false);
    expect(Buffer.byteLength(body.text)).toBe(524288);
  });

  it('cuts a text file over 512 KiB to exactly 524288 bytes and marks it truncated', async () => {
    await put('proj/big.txt', 'a'.repeat(524288 + 1000));
    await start();
    const { body } = await get('content', 'big.txt');
    expect(body.kind).toBe('text');
    expect(body.truncated).toBe(true);
    expect(Buffer.byteLength(body.text)).toBe(524288);
  });

  it('returns kind other with the size for a file containing a NUL byte', async () => {
    const data = Buffer.from([0x61, 0x00, 0x62, 0x63]);
    await put('proj/data.bin', data);
    await start();
    expect((await get('content', 'data.bin')).body).toEqual({ path: 'data.bin', name: 'data.bin', kind: 'other', size: 4 });
  });

  it('returns an empty text file as empty text', async () => {
    await put('proj/empty.txt', '');
    await start();
    expect((await get('content', 'empty.txt')).body).toMatchObject({ kind: 'text', text: '', truncated: false });
  });

  it('returns 400 for content on a folder', async () => {
    await mkdir(join(dir, 'blocks'));
    await start();
    expect((await get('content', 'blocks')).status).toBe(400);
  });

  it('returns 404 for content on a missing file', async () => {
    await start();
    expect((await get('content', 'nope.txt')).status).toBe(404);
  });
});

describe('files routes: images', () => {
  it('returns kind image with a url-encoded path, and the url serves the image', async () => {
    await put('proj/screens/my shot&1.png', PNG);
    await start();
    const { body } = await get('content', 'screens/my shot&1.png');
    expect(body).toEqual({
      path: 'screens/my shot&1.png',
      name: 'my shot&1.png',
      kind: 'image',
      url: `/api/files/image?path=${encodeURIComponent('screens/my shot&1.png')}`,
    });
    expect(body.url).toContain('screens%2Fmy%20shot%261.png');
    const image = await app!.inject({ method: 'GET', url: body.url });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['cache-control']).toBe('no-store');
    expect(image.rawPayload.equals(PNG)).toBe(true);
  });

  it('recognises image extensions regardless of case', async () => {
    await put('proj/SHOT.PNG', PNG);
    await start();
    expect((await get('content', 'SHOT.PNG')).body.kind).toBe('image');
    const image = await get('image', 'SHOT.PNG');
    expect(image.status).toBe(200);
    expect(image.response.headers['content-type']).toBe('image/png');
  });

  it('returns 400 for image on a yaml file', async () => {
    await put('proj/a.yaml');
    await start();
    expect((await get('image', 'a.yaml')).status).toBe(400);
  });

  it('returns 400 for image on a folder named like an image', async () => {
    await mkdir(join(dir, 'pics.png'));
    await start();
    expect((await get('image', 'pics.png')).status).toBe(400);
  });

  it('returns 404 for image on a missing file', async () => {
    await start();
    expect((await get('image', 'nope.png')).status).toBe(404);
  });
});
