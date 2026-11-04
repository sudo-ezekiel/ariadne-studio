// The run video's studio side: where ffmpeg is looked for, reading what
// `ffmpeg -i` prints, and framing a real (tiny) video when ffmpeg is installed.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunCommand, RunVideoRow } from '@ariadne/core';
import { ffmpegCandidates, findFfmpeg, frameRunVideo, parseVideoInfo } from '../src/server/run-video.ts';

describe('ffmpegCandidates', () => {
  const path = ['/usr/local/sbin', '/usr/bin'].join(delimiter);

  it('lists the PATH folders in order, with ffmpeg in each', () => {
    expect(ffmpegCandidates('linux', { PATH: path })).toEqual([join('/usr/local/sbin', 'ffmpeg'), join('/usr/bin', 'ffmpeg')]);
  });

  it('puts ARIADNE_FFMPEG before every PATH folder', () => {
    expect(ffmpegCandidates('linux', { PATH: path, ARIADNE_FFMPEG: '/opt/ff/ffmpeg' })[0]).toBe('/opt/ff/ffmpeg');
    expect(ffmpegCandidates('linux', { PATH: path, ARIADNE_FFMPEG: '/opt/ff/ffmpeg' })).toHaveLength(3);
  });

  it('ignores an empty ARIADNE_FFMPEG', () => {
    expect(ffmpegCandidates('linux', { PATH: '/usr/bin', ARIADNE_FFMPEG: '' })).toEqual([join('/usr/bin', 'ffmpeg')]);
  });

  it('looks for ffmpeg.exe on Windows', () => {
    expect(ffmpegCandidates('win32', { PATH: '/tools' })).toEqual([join('/tools', 'ffmpeg.exe')]);
  });

  it('adds the Homebrew folders on macOS only, after PATH', () => {
    expect(ffmpegCandidates('darwin', { PATH: '/usr/bin' })).toEqual([
      join('/usr/bin', 'ffmpeg'),
      join('/opt/homebrew/bin', 'ffmpeg'),
      join('/usr/local/bin', 'ffmpeg'),
    ]);
    for (const platform of ['linux', 'win32'] as const) {
      const found = ffmpegCandidates(platform, { PATH: '/usr/bin' }).join('\n');
      expect(found, platform).not.toContain('homebrew');
    }
  });

  it('still lists the Homebrew folders on macOS when PATH is missing, and nothing elsewhere', () => {
    expect(ffmpegCandidates('darwin', {})).toHaveLength(2);
    expect(ffmpegCandidates('linux', {})).toEqual([]);
  });

  it('skips empty PATH entries', () => {
    expect(ffmpegCandidates('linux', { PATH: `${delimiter}/usr/bin${delimiter}${delimiter}` })).toEqual([join('/usr/bin', 'ffmpeg')]);
  });
});

describe('parseVideoInfo', () => {
  const stderr = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/tmp/video.mp4':",
    '  Metadata:',
    '    major_brand     : isom',
    '    encoder         : Lavf62.3.100',
    '  Duration: 00:00:12.25, start: 0.000000, bitrate: 1052 kb/s',
    '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1080x2400 [SAR 1:1 DAR 9:20], 1049 kb/s, 60 fps, 60 tbr, 90k tbn (default)',
    'At least one output file must be specified',
  ].join('\n');

  it('reads size and length from a Stream line with a codec size before the size and a SAR after it', () => {
    expect(parseVideoInfo(stderr)).toEqual({ width: 1080, height: 2400, durationMs: 12250 });
  });

  it('adds hours and minutes to the length', () => {
    expect(parseVideoInfo(stderr.replace('00:00:12.25', '01:02:03.5'))).toEqual({ width: 1080, height: 2400, durationMs: 3723500 });
  });

  it('reads a length with no fraction', () => {
    expect(parseVideoInfo(stderr.replace('00:00:12.25', '00:00:07'))?.durationMs).toBe(7000);
  });

  it('reads the size of the video stream, not of an audio stream listed before it', () => {
    const withAudio = stderr.replace('  Stream #0:0', '  Stream #0:1[0x2](eng): Audio: aac (LC), 44100 Hz, stereo, fltp, 128 kb/s\n  Stream #0:0');
    expect(parseVideoInfo(withAudio)).toMatchObject({ width: 1080, height: 2400 });
  });

  it('is undefined for garbage, empty text, and output missing the size or the length', () => {
    expect(parseVideoInfo('')).toBeUndefined();
    expect(parseVideoInfo('x.mp4: Invalid data found when processing input')).toBeUndefined();
    expect(parseVideoInfo(stderr.replace(/.*Duration.*\n/, ''))).toBeUndefined();
    expect(parseVideoInfo(stderr.replace(/.*Stream.*\n/, ''))).toBeUndefined();
    expect(parseVideoInfo('  Duration: N/A, bitrate: N/A\n  Stream #0:0: Video: h264, yuv420p, 1080x2400')).toBeUndefined();
  });
});

const ffmpeg = findFfmpeg();

async function probe(file: string): Promise<{ width: number; height: number; durationMs: number }> {
  const stderr = await promisify(execFile)(ffmpeg!, ['-hide_banner', '-i', file]).then(
    (result) => result.stderr,
    (error: { stderr: string }) => error.stderr,
  );
  const info = parseVideoInfo(stderr);
  if (!info) throw new Error(`could not read ${file}: ${stderr}`);
  return info;
}

describe.skipIf(!ffmpeg)('frameRunVideo with the ffmpeg on this machine', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ariadne-run-video-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function command(name: string, startedAt: number): RunCommand {
    return { sequence: 0, name, status: 'passed', durationMs: 5, startedAt };
  }

  const T = 1_800_000_000_000;
  const rows: RunVideoRow[] = [
    { number: 1, label: 'Launch the app', status: 'passed', durationMs: 900, startedAt: T + 100 },
    { number: 2, label: 'Tap "Network & internet"', status: 'passed', durationMs: 800, startedAt: T + 1200 },
    { number: 3, label: 'Check that Internet is shown', status: 'passed', durationMs: 500, startedAt: T + 2200 },
  ];
  const commands = [command('startRecordingCommand', T), command('stopRecordingCommand', T + 3300)];

  async function phoneVideo(): Promise<string> {
    const file = join(dir, 'video.mp4');
    await promisify(execFile)(ffmpeg!, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=270x600:rate=10:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file,
    ]);
    return file;
  }

  it('replaces the phone video with a 1920x1080 one that is held about 2.5 s longer, and leaves no temp file', async () => {
    const video = await phoneVideo();
    const before = await probe(video);
    expect(before).toMatchObject({ width: 270, height: 600 });

    await frameRunVideo({ video, caseName: 'Open network', appId: 'com.android.settings', device: 'emulator-5554', passed: true, rows, commands, ffmpeg: ffmpeg! });

    const after = await probe(video);
    expect(after.width).toBe(1920);
    expect(after.height).toBe(1080);
    expect(after.durationMs - before.durationMs).toBeGreaterThan(2100);
    expect(after.durationMs - before.durationMs).toBeLessThan(2900);
    expect(await readdir(dir)).toEqual(['video.mp4']);
  }, 60_000);

  it('rejects a video ffmpeg cannot read and leaves the file as it was', async () => {
    const video = join(dir, 'video.mp4');
    const garbage = Buffer.from('this is not a video '.repeat(50));
    await writeFile(video, garbage);

    await expect(
      frameRunVideo({ video, caseName: 'Open network', appId: 'com.android.settings', device: 'emulator-5554', passed: true, rows, commands, ffmpeg: ffmpeg! }),
    ).rejects.toThrow(/could not read/);

    expect(await readFile(video)).toEqual(garbage);
    expect(await readdir(dir)).toEqual(['video.mp4']);
  }, 60_000);

  it('rejects when Maestro reported no start for the recording, and leaves the video as it was', async () => {
    const video = await phoneVideo();
    const bytes = await readFile(video);

    await expect(
      frameRunVideo({ video, caseName: 'Open network', appId: 'com.android.settings', device: 'emulator-5554', passed: true, rows, commands: [], ffmpeg: ffmpeg! }),
    ).rejects.toThrow(/no start/);

    expect(await readFile(video)).toEqual(bytes);
  }, 60_000);
});
