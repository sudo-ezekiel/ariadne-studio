// The Files sidebar: the project's folders as they are on disk, read only.
// .env files never leave the server: they are not listed and cannot be opened.
import { createReadStream } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, posix, relative, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { FileContent, FileEntry, FileListResponse, FileRootsResponse } from '../shared/api-types.ts';
import { HttpError, exists } from './common.ts';
import type { ServerState } from './state.ts';

const MAX_TEXT_BYTES = 512 * 1024;
const HIDDEN_NAMES = new Set(['.git', 'node_modules']);
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function isHidden(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('.env') || HIDDEN_NAMES.has(lower);
}

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep);
}

/** The project folder, then any block or flows folder kept outside it. */
async function rootFolders(state: ServerState): Promise<string[]> {
  const { dir } = state.project;
  const { blockDirs, flowsDir } = state.project.resolvedPaths();
  const outside = [...new Set([...blockDirs, flowsDir])].filter((folder) => !isInside(folder, dir));
  const found = await Promise.all(outside.map(async (folder) => ((await exists(folder)) ? [folder] : [])));
  return [dir, ...found.flat()];
}

function readPath(query: unknown): string {
  const { path } = query as { path?: unknown };
  if (typeof path !== 'string' || path === '') throw new HttpError(400, 'BAD_REQUEST', 'Say which file or folder.');
  return path;
}

/**
 * The real path of an entry named by the UI. Checked after symlinks resolve, so
 * a link cannot lead out of the project or to a hidden file. Refused entries
 * look missing, which says nothing about what is on the disk.
 */
async function resolveEntry(state: ServerState, path: string): Promise<string> {
  const real = await realpath(resolve(state.project.dir, path)).catch(() => undefined);
  const roots = await Promise.all((await rootFolders(state)).map((folder) => realpath(folder)));
  const root = real === undefined ? undefined : roots.find((folder) => isInside(real, folder));
  if (real === undefined || root === undefined || relative(root, real).split(sep).some(isHidden)) {
    throw new HttpError(404, 'NOT_FOUND', 'That is not a file in this project.');
  }
  return real;
}

function byKindThenName(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

async function readHead(file: string, bytes: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function registerFileRoutes(app: FastifyInstance, state: ServerState): void {
  app.get('/api/files', async (): Promise<FileRootsResponse> => {
    const { project } = state;
    const folders = await rootFolders(state);
    return {
      roots: folders.map((folder): FileEntry =>
        folder === project.dir
          ? { path: '.', name: basename(folder), kind: 'folder' }
          : { path: project.relative(folder), name: project.relative(folder), kind: 'folder' },
      ),
    };
  });

  app.get('/api/files/list', async (request): Promise<FileListResponse> => {
    const path = readPath(request.query);
    const folder = await resolveEntry(state, path);
    if (!(await stat(folder)).isDirectory()) throw new HttpError(400, 'BAD_REQUEST', 'That is a file, not a folder.');
    const items = await readdir(folder, { withFileTypes: true });
    const entries = items
      .filter((item) => (item.isDirectory() || item.isFile()) && !isHidden(item.name))
      .map((item): FileEntry => ({ path: posix.join(path, item.name), name: item.name, kind: item.isDirectory() ? 'folder' : 'file' }))
      .sort(byKindThenName);
    return { entries };
  });

  app.get('/api/files/content', async (request): Promise<FileContent> => {
    const path = readPath(request.query);
    const file = await resolveEntry(state, path);
    const info = await stat(file);
    if (!info.isFile()) throw new HttpError(400, 'BAD_REQUEST', 'That is a folder, not a file.');
    const entry = { path, name: posix.basename(path) };
    if (IMAGE_TYPES[extname(file).toLowerCase()]) {
      return { ...entry, kind: 'image', url: `/api/files/image?path=${encodeURIComponent(path)}` };
    }
    const head = await readHead(file, MAX_TEXT_BYTES);
    if (head.includes(0)) return { ...entry, kind: 'other', size: info.size };
    return { ...entry, kind: 'text', text: head.toString('utf8'), truncated: info.size > MAX_TEXT_BYTES };
  });

  app.get('/api/files/image', async (request, reply) => {
    const file = await resolveEntry(state, readPath(request.query));
    const type = IMAGE_TYPES[extname(file).toLowerCase()];
    if (!type || !(await stat(file)).isFile()) throw new HttpError(400, 'BAD_REQUEST', 'That is not an image.');
    return reply.header('cache-control', 'no-store').type(type).send(createReadStream(file));
  });
}
