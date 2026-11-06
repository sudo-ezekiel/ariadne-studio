// "Set up this computer": fetches the Android tools, a Java runtime and Maestro,
// so a tester never has to install Android Studio or edit PATH. Everything goes
// in folders a standard user can write to, so it needs no admin rights: adb in
// the Android SDK folder, and the rest in the folder toolsTarget picks.
//
// Google's SDK terms (clause 3.4) do not let Ariadne ship adb in its installer,
// so it comes from Google when the tester agrees to those terms, and the other
// two come from their publishers the same way. Each download is pinned here to
// a version and a SHA-256: a file that does not match is never unpacked or run.
// To update one, change its url, bytes and sha256 together, and take the hash
// from the publisher, not from a file you downloaded.
//
// Windows x64 only so far. Other systems keep the manual steps: Java comes as a
// .tar.gz there, and this has only been tried on real Windows.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { setTimeout as sleep } from 'node:timers/promises';
import { claimFolder, defaultSdkDir, maestroEnv, sharedToolsRoot, spawnCommand, toolsTarget } from '@ariadne/core';
import type { ToolId, ToolInstallStatus, ToolProgress } from '../shared/api-types.ts';

export type ToolDownload = {
  id: ToolId;
  /** The name a tester sees. */
  name: string;
  url: string;
  bytes: number;
  sha256: string;
  /** What to ask an IT team to allow when the download is blocked. */
  host: string;
  /** Run after unpacking, relative to the tool's folder, to see that Windows lets it start. */
  check: { file: string; args: string[] };
};

/** Android SDK Platform-Tools from the stable channel, Temurin 17, and the Maestro the docs were measured with. */
const WINDOWS_X64: ToolDownload[] = [
  {
    id: 'adb',
    name: 'Android tools',
    url: 'https://dl.google.com/android/repository/platform-tools_r37.0.1-win.zip',
    bytes: 8_044_989,
    sha256: '45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99',
    host: 'dl.google.com',
    check: { file: 'adb.exe', args: ['version'] },
  },
  {
    id: 'java',
    name: 'Java',
    url: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.21%2B9/OpenJDK17U-jre_x64_windows_hotspot_17.0.21_9.zip',
    bytes: 43_860_024,
    sha256: 'fe4656bd78fb09812dc38c49da777f79cc33e7ee435a254be82f9e7f40d9d117',
    host: 'github.com',
    check: { file: join('bin', 'java.exe'), args: ['-version'] },
  },
  {
    id: 'maestro',
    name: 'Maestro',
    url: 'https://github.com/mobile-dev-inc/maestro/releases/download/cli-2.12.1/maestro.zip',
    bytes: 349_832_427,
    sha256: '54dbb0716425626604973cbb374c585ca30272375d9ce15177a1152765ddd9d7',
    host: 'github.com',
    check: { file: join('bin', 'maestro.bat'), args: ['--version'] },
  },
];

/** No bytes for this long means the download is stuck, not slow. */
const STALL_MS = 60_000;
/** Starting Java is slow the first time, with an antivirus reading every file. */
const CHECK_TIMEOUT_MS = 120_000;
const UNZIP_TIMEOUT_MS = 300_000;
/** An antivirus holds freshly unpacked programs for a moment, which fails a move with EPERM. */
const MOVE_ATTEMPTS = 6;
const MOVE_RETRY_MS = 500;

/** The parts of the outside world installing touches; tests substitute fakes. */
export type InstallIo = {
  /** What this computer can fetch; empty where "Set up this computer" is not offered. */
  downloads: ToolDownload[];
  /** A folder of the user's for what is on its way, on the same disk as the tools. */
  workDir: string;
  /** The folder a tool ends up in. It is replaced, so it holds only that tool. */
  destination: (id: ToolId) => string;
  fetch: typeof fetch;
  unzip: (zipFile: string, into: string) => Promise<void>;
  /** Starts a program to see that it runs; rejects when it does not. */
  start: (file: string, args: string[]) => Promise<void>;
  /** Readies the folder the tools go in, before anything is put there. */
  prepare?: () => Promise<void>;
};

/**
 * Windows' own tar.exe unpacks zip files, so this needs no dependency. It is
 * named in full because Git's GNU tar, often first on PATH, cannot. Its folders
 * are relative because it reads its arguments in the system code page, which
 * cannot spell every user name.
 */
function unzipWithTar(zipFile: string, into: string): Promise<void> {
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const folder = dirname(zipFile);
  return new Promise((resolvePromise, reject) => {
    const args = ['-xf', zipFile.slice(folder.length + 1), '-C', into.slice(folder.length + 1)];
    execFile(tar, args, { cwd: folder, timeout: UNZIP_TIMEOUT_MS, windowsHide: true }, (error) => (error ? reject(error) : resolvePromise()));
  });
}

function startProgram(file: string, args: string[], androidHome: () => string | undefined): Promise<void> {
  const command = spawnCommand(file, args);
  return new Promise((resolvePromise, reject) => {
    execFile(
      command.command,
      command.args,
      { env: maestroEnv(androidHome()), timeout: CHECK_TIMEOUT_MS, windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments ?? false },
      (error) => (error ? reject(error) : resolvePromise()),
    );
  });
}

export function defaultInstallIo(androidHome: () => string | undefined, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, arch: string = process.arch): InstallIo {
  const tools = toolsTarget(env, platform);
  const shared = sharedToolsRoot(env, platform);
  return {
    downloads: tools && arch === 'x64' ? WINDOWS_X64 : [],
    workDir: join(tools ?? '', '.incoming'),
    destination: (id) => (id === 'adb' ? join(androidHome() ?? defaultSdkDir(), 'platform-tools') : join(tools ?? '', id)),
    fetch: (...args) => fetch(...args),
    unzip: unzipWithTar,
    start: (file, args) => startProgram(file, args, androidHome),
    prepare: async () => {
      if (!shared) return;
      await claimFolder(shared).catch((error: unknown) => {
        console.error(`[studio] Set up this computer: claiming ${shared}: ${error instanceof Error ? error.message : String(error)}`);
        throw new PlainError(`Ariadne will not run tools from ${shared}, because another account on this computer may be able to change them. Ask your IT team to delete that folder, then press Try again.`);
      });
    },
  };
}

/** A failure already said the way a tester should read it. */
class PlainError extends Error {}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function explain(download: ToolDownload, error: unknown): string {
  if (error instanceof PlainError) return error.message;
  const code = codeOf(error);
  if (code === 'ENOSPC') return `There is not enough free disk space for ${download.name}. Free some space and press Try again.`;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
    return `Ariadne could not save ${download.name} on this computer. Press Try again. If it keeps failing, an antivirus or a company rule may be blocking it.`;
  }
  return `Could not download ${download.name}. Check the internet connection and press Try again. On a company computer, ask your IT team to allow ${download.host}.`;
}

async function moveFolder(from: string, to: string): Promise<void> {
  for (let attempt = 1; attempt < MOVE_ATTEMPTS; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (codeOf(error) === 'EXDEV') break;
      await sleep(MOVE_RETRY_MS);
    }
  }
  await cp(from, to, { recursive: true });
}

export class ToolInstaller {
  private running = false;
  private round: Promise<void> = Promise.resolve();
  private tools: ToolProgress[] = [];

  constructor(private readonly io: InstallIo) {}

  status(): ToolInstallStatus {
    return {
      available: this.io.downloads.length > 0,
      running: this.running,
      offered: this.io.downloads.map(({ id, name, bytes }) => ({ id, name, bytes })),
      tools: this.tools.map((tool) => ({ ...tool })),
    };
  }

  /** Starts fetching these tools in the background; the guide follows with status(). */
  start(ids: ToolId[]): void {
    if (this.running) return;
    const chosen = this.io.downloads.filter((download) => ids.includes(download.id));
    if (chosen.length === 0) return;
    this.tools = chosen.map(({ id, name, bytes }) => ({ id, name, state: 'waiting', received: 0, total: bytes }));
    this.running = true;
    this.round = this.installAll(chosen).finally(() => {
      this.running = false;
    });
  }

  /** Settles when every tool has had its turn. One that fails does not stop the next. */
  finished(): Promise<void> {
    return this.round;
  }

  private async installAll(chosen: ToolDownload[]): Promise<void> {
    for (const download of chosen) {
      const progress = this.tools.find((tool) => tool.id === download.id)!;
      try {
        await this.install(download, progress);
        progress.state = 'done';
      } catch (error) {
        progress.state = 'failed';
        progress.error = explain(download, error);
        console.error(`[studio] Set up this computer: ${download.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await rm(this.io.workDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }

  private async install(download: ToolDownload, progress: ToolProgress): Promise<void> {
    await this.io.prepare?.();
    const work = join(this.io.workDir, download.id);
    await rm(work, { recursive: true, force: true, maxRetries: 3 });
    const unpacked = join(work, 'unpacked');
    await mkdir(unpacked, { recursive: true });
    const zipFile = join(work, 'download.zip');

    progress.state = 'downloading';
    await this.download(download, zipFile, progress);

    progress.state = 'unpacking';
    await this.io.unzip(zipFile, unpacked).catch((error: unknown) => {
      console.error(`[studio] Set up this computer: unpacking ${download.name}: ${error instanceof Error ? error.message : String(error)}`);
      throw new PlainError(`Ariadne could not unpack ${download.name}. Check that the disk has free space and press Try again.`);
    });
    // Each of these zips holds one folder with everything in it.
    const [folder, ...others] = await readdir(unpacked);
    if (!folder || others.length > 0) throw new PlainError(`The download of ${download.name} was not what Ariadne expected, so it was not used.`);
    const destination = this.io.destination(download.id);
    await mkdir(dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true, maxRetries: 3 });
    await moveFolder(join(unpacked, folder), destination);

    progress.state = 'checking';
    // Maestro cannot start without Java, and that failure was already reported.
    if (download.id === 'maestro' && this.tools.find((tool) => tool.id === 'java')?.state === 'failed') return;
    await this.io.start(join(destination, download.check.file), download.check.args).catch((error: unknown) => {
      console.error(`[studio] Set up this computer: starting ${download.name}: ${error instanceof Error ? error.message : String(error)}`);
      // A policy block has no code of its own in Node, so it arrives as UNKNOWN.
      if (['EACCES', 'EPERM', 'UNKNOWN'].includes(String(codeOf(error)))) {
        throw new PlainError(
          `Ariadne downloaded ${download.name}, but Windows would not start it. A company computer may block programs in your user folder: ask your IT team to allow ${destination}.`,
        );
      }
      throw new PlainError(`Ariadne downloaded ${download.name}, but it did not start correctly. Press Try again. If it keeps failing, Help > Show logs has the reason.`);
    });
  }

  private async download(download: ToolDownload, file: string, progress: ToolProgress): Promise<void> {
    const aborter = new AbortController();
    let stall = setTimeout(() => aborter.abort(), STALL_MS);
    try {
      const response = await this.io.fetch(download.url, { signal: aborter.signal });
      if (!response.ok || !response.body) throw new Error(`${download.url} answered ${response.status}`);
      const hash = createHash('sha256');
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          clearTimeout(stall);
          stall = setTimeout(() => aborter.abort(), STALL_MS);
          hash.update(chunk);
          progress.received += chunk.length;
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), meter, createWriteStream(file));
      if (hash.digest('hex') !== download.sha256) {
        throw new PlainError(`The download of ${download.name} did not match what Ariadne expected, so it was not used. Press Try again.`);
      }
    } finally {
      clearTimeout(stall);
    }
  }
}
