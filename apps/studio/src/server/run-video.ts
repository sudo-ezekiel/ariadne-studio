// Turns the phone video Maestro saves into the run video: the case's steps on
// the left, marked as they ran, and the phone on the right. Everything happens
// on this machine with the ffmpeg it already has; without one the run keeps the
// phone video.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import {
  RUN_VIDEO_HOLD_MS,
  runVideoClock,
  runVideoCornersSvg,
  runVideoFrameSvg,
  runVideoPhoneBox,
  runVideoStates,
  type RunCommand,
  type RunVideoRow,
  type Size,
} from '@ariadne/core';

const defaultAssets = fileURLToPath(new URL('../../assets/run-video/', import.meta.url));
const COMPOSE_TIMEOUT_MS = 5 * 60 * 1000;

/** Where ffmpeg can be: a desktop app on macOS starts without Homebrew's folders on PATH. */
export function ffmpegCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const name = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  return [...(env.ARIADNE_FFMPEG ? [env.ARIADNE_FFMPEG] : []), ...dirs.map((dir) => join(dir, name))];
}

export function findFfmpeg(): string | undefined {
  return ffmpegCandidates(process.platform, process.env).find((candidate) => existsSync(candidate));
}

/** Size and length of a video, from what `ffmpeg -i` prints. */
export function parseVideoInfo(output: string): (Size & { durationMs: number }) | undefined {
  const size = /Video:.*?\b(\d{2,5})x(\d{2,5})\b/.exec(output);
  const time = /Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(output);
  if (!size || !time) return undefined;
  return {
    width: Number(size[1]),
    height: Number(size[2]),
    durationMs: Math.round((Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])) * 1000),
  };
}

async function videoInfo(ffmpeg: string, file: string) {
  // With no output file ffmpeg prints the input's details and exits with an error.
  const output = await promisify(execFile)(ffmpeg, ['-hide_banner', '-i', file]).then(
    (result) => result.stderr,
    (error: { stderr?: string }) => error.stderr ?? '',
  );
  return parseVideoInfo(output);
}

/** One rasteriser per process: resvg's WebAssembly can only be started once. */
let started: Promise<void> | undefined;

function startRasteriser(assetsDir: string): Promise<void> {
  if (!started) {
    const bundled = join(assetsDir, 'index_bg.wasm');
    const wasm = existsSync(bundled) ? bundled : createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm');
    started = readFile(wasm).then((bytes) => initWasm(bytes));
  }
  return started;
}

function pngOf(svg: string, fonts: Uint8Array[]): Uint8Array {
  const resvg = new Resvg(svg, { font: { fontBuffers: fonts, defaultFontFamily: 'Noto Sans Mono' } });
  const image = resvg.render();
  const png = image.asPng();
  image.free();
  resvg.free();
  return png;
}

function runFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => {
      errors = `${errors}${chunk.toString()}`.slice(-2000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), COMPOSE_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(errors.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

export type FrameRunVideoInput = {
  /** The phone video; replaced by the run video on success. */
  video: string;
  caseName: string;
  appId: string;
  device: string;
  passed: boolean;
  rows: readonly RunVideoRow[];
  /** Every top-level command Maestro ran, the studio's startRecording among them. */
  commands: readonly RunCommand[];
  ffmpeg: string;
  assetsDir?: string;
};

export async function frameRunVideo(input: FrameRunVideoInput): Promise<void> {
  const { ffmpeg, video, rows } = input;
  const assetsDir = input.assetsDir ?? defaultAssets;
  const info = await videoInfo(ffmpeg, video);
  if (!info) throw new Error('ffmpeg could not read the phone video');
  const clock = runVideoClock(input.commands, info.durationMs);
  if (!clock) throw new Error('Maestro reported no start for the phone video');

  await startRasteriser(assetsDir);
  const fonts = await Promise.all(['NotoSansMono-Regular.ttf', 'NotoSansMono-Bold.ttf'].map((name) => readFile(join(assetsDir, name))));

  const phone = runVideoPhoneBox(info);
  const states = runVideoStates(rows, clock, info.durationMs);
  const work = await mkdtemp(join(tmpdir(), 'ariadne-run-video-'));
  try {
    const lines = ['ffconcat version 1.0'];
    const totalMs = info.durationMs + RUN_VIDEO_HOLD_MS;
    for (const [index, state] of states.entries()) {
      const name = `state-${String(index).padStart(4, '0')}.png`;
      const svg = runVideoFrameSvg({ caseName: input.caseName, device: input.device, appId: input.appId, passed: input.passed, rows, state, phone });
      await writeFile(join(work, name), pngOf(svg, fonts));
      const untilMs = states[index + 1]?.fromMs ?? totalMs;
      lines.push(`file '${name}'`, `duration ${((untilMs - state.fromMs) / 1000).toFixed(3)}`);
      // ffconcat ignores the duration of the last entry unless the file comes again.
      if (index === states.length - 1) lines.push(`file '${name}'`);
    }
    await writeFile(join(work, 'states.ffconcat'), `${lines.join('\n')}\n`);
    await writeFile(join(work, 'corners.png'), pngOf(runVideoCornersSvg(phone), fonts));

    const output = join(dirname(video), 'video.framed.mp4');
    const graph = [
      `[1:v]fps=30,tpad=stop_mode=clone:stop_duration=${RUN_VIDEO_HOLD_MS / 1000},scale=${phone.width}:${phone.height}:flags=lanczos[phone]`,
      `[0:v]fps=30,format=yuv420p[frame]`,
      `[frame][phone]overlay=${phone.x}:${phone.y}:shortest=1[with-phone]`,
      `[with-phone][2:v]overlay=0:0,format=yuv420p[out]`,
    ].join(';');
    await runFfmpeg(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', join(work, 'states.ffconcat'),
      '-i', video,
      '-i', join(work, 'corners.png'),
      '-filter_complex', graph,
      '-map', '[out]', '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-movflags', '+faststart',
      output,
    ]);
    await rename(output, video);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
