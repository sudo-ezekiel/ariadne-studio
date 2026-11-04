import { describe, expect, it } from 'vitest';
import type { RunCommand } from '../src/replay/run-result.ts';
import {
  RUN_VIDEO_HEIGHT,
  RUN_VIDEO_WIDTH,
  runVideoClock,
  runVideoCornersSvg,
  runVideoFrameSvg,
  runVideoPhoneBox,
  runVideoStates,
  type RowMark,
  type RunVideoRow,
  type RunVideoState,
} from '../src/replay/run-video.ts';

function command(name: string, startedAt: number | undefined, status: RunCommand['status'] = 'passed'): RunCommand {
  return { sequence: 0, name, status, durationMs: 10, ...(startedAt !== undefined ? { startedAt } : {}) };
}

describe('runVideoClock', () => {
  it('measures the lag as the time between the two commands minus the video length', () => {
    // A real run: Maestro started the recorder at ...705657 and stopped it at ...718347; the file is 12247 ms long.
    const commands = [command('startRecordingCommand', 1793780705657), command('stopRecordingCommand', 1793780718347)];
    expect(runVideoClock(commands, 12247)).toEqual({ startedAt: 1793780705657, lagMs: 443 });
  });

  it('clamps a negative lag to 0', () => {
    const commands = [command('startRecordingCommand', 1000), command('stopRecordingCommand', 5000)];
    expect(runVideoClock(commands, 6000)).toEqual({ startedAt: 1000, lagMs: 0 });
  });

  it('clamps a huge lag to 2000', () => {
    const commands = [command('startRecordingCommand', 1000), command('stopRecordingCommand', 60000)];
    expect(runVideoClock(commands, 1000)).toEqual({ startedAt: 1000, lagMs: 2000 });
  });

  it('assumes 400 ms of lag when there is no stopRecording, as after a failed run', () => {
    expect(runVideoClock([command('startRecordingCommand', 1000)], 9000)).toEqual({ startedAt: 1000, lagMs: 400 });
  });

  it('assumes 400 ms when stopRecording has no start time', () => {
    const commands = [command('startRecordingCommand', 1000), command('stopRecordingCommand', undefined)];
    expect(runVideoClock(commands, 9000)).toEqual({ startedAt: 1000, lagMs: 400 });
  });

  it('is undefined when there is no startRecording', () => {
    expect(runVideoClock([command('tapOnElement', 1000)], 5000)).toBeUndefined();
    expect(runVideoClock([], 5000)).toBeUndefined();
  });

  it('is undefined when startRecording failed', () => {
    expect(runVideoClock([command('startRecordingCommand', 1000, 'failed')], 5000)).toBeUndefined();
  });

  it('is undefined when startRecording has no start time', () => {
    expect(runVideoClock([command('startRecordingCommand', undefined)], 5000)).toBeUndefined();
  });
});

function ranRow(number: number, startedAt: number | undefined, durationMs: number, status: RunVideoRow['status'] = 'passed'): RunVideoRow {
  return { number, label: `Step ${number}`, status, durationMs, ...(startedAt !== undefined ? { startedAt } : {}) };
}

const clock = { startedAt: 10000, lagMs: 0 };

describe('runVideoStates', () => {
  const rows = [ranRow(1, 10000, 400), ranRow(2, 10500, 600), ranRow(3, 11200, 300)];

  it('gives one state per step that ran, plus the finished one', () => {
    const states = runVideoStates(rows, clock, 5000);
    expect(states.map((state) => state.fromMs)).toEqual([0, 500, 1200, 1500]);
    expect(states.map((state) => state.focus)).toEqual([0, 1, 2, 2]);
  });

  it('marks rows before the active one with their final status, the active one running and later ones waiting', () => {
    const states = runVideoStates(rows, clock, 5000);
    expect(states[0]!.marks).toEqual(['running', 'waiting', 'waiting']);
    expect(states[1]!.marks).toEqual(['passed', 'running', 'waiting']);
    expect(states[2]!.marks).toEqual(['passed', 'passed', 'running']);
  });

  it('ends with a finished state with the final marks, and only that state is finished', () => {
    const states = runVideoStates(rows, clock, 5000);
    expect(states.at(-1)).toEqual({ fromMs: 1500, marks: ['passed', 'passed', 'passed'], focus: 2, finished: true });
    expect(states.slice(0, -1).some((state) => state.finished)).toBe(false);
  });

  it('starts the first state at 0 even when the first step began after the video did', () => {
    const late = [ranRow(1, 10800, 200), ranRow(2, 11000, 200)];
    expect(runVideoStates(late, clock, 5000)[0]!.fromMs).toBe(0);
  });

  it('starts the first state at 0 when the lag puts the first step before the video', () => {
    const states = runVideoStates(rows, { startedAt: 10000, lagMs: 300 }, 5000);
    expect(states[0]!.fromMs).toBe(0);
    expect(states[1]!.fromMs).toBe(200);
  });

  it('shows a failed run as failed on that row and not-run after it', () => {
    const failed = [ranRow(1, 10000, 400), ranRow(2, 10500, 600, 'failed'), { number: 3, label: 'Step 3', status: 'not-run' as const }];
    const states = runVideoStates(failed, clock, 5000);
    expect(states.map((state) => state.focus)).toEqual([0, 1, 1]);
    expect(states.at(-1)).toEqual({ fromMs: 1100, marks: ['passed', 'failed', 'not-run'], focus: 1, finished: true });
  });

  it('treats a row with no status as not run', () => {
    const states = runVideoStates([ranRow(1, 10000, 400), { number: 2, label: 'Step 2' }], clock, 5000);
    expect(states.at(-1)!.marks).toEqual(['passed', 'not-run']);
  });

  it('lets two steps that start at the same millisecond share a state', () => {
    const same = [ranRow(1, 10000, 0), ranRow(2, 10000, 400), ranRow(3, 11000, 100)];
    const states = runVideoStates(same, clock, 5000);
    expect(states.map((state) => [state.fromMs, state.focus])).toEqual([[0, 1], [1000, 2], [1100, 2]]);
    expect(states[0]!.marks).toEqual(['passed', 'running', 'waiting']);
  });

  it('merges steps that both clamp to 0, and keeps fromMs non-decreasing without zero-length duplicates', () => {
    const early = [ranRow(1, 9000, 50), ranRow(2, 9500, 50), ranRow(3, 10000, 300), ranRow(4, 10300, 200)];
    const states = runVideoStates(early, clock, 5000);
    const times = states.map((state) => state.fromMs);
    expect(times).toEqual([0, 300, 500]);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
  });

  it('collapses a finished state that would start where the last step starts', () => {
    const states = runVideoStates([ranRow(1, 10000, 0)], clock, 5000);
    expect(states).toEqual([{ fromMs: 0, marks: ['passed'], focus: 0, finished: true }]);
  });

  it('gives one finished state, without throwing, when no row ran', () => {
    const none: RunVideoRow[] = [{ number: 1, label: 'Step 1' }, { number: 2, label: 'Step 2' }];
    expect(runVideoStates(none, clock, 5000)).toEqual([{ fromMs: 0, marks: ['not-run', 'not-run'], focus: 0, finished: true }]);
    expect(runVideoStates([], clock, 5000)).toEqual([{ fromMs: 0, marks: [], focus: 0, finished: true }]);
  });

  it('never lets the finished state land after the video ends', () => {
    const long = [ranRow(1, 10000, 100), ranRow(2, 14900, 60000)];
    const states = runVideoStates(long, clock, 5000);
    expect(states.at(-1)!.finished).toBe(true);
    expect(states.at(-1)!.fromMs).toBe(5000);
  });

  // A failed run's lag is assumed, so a late step can land past the end; a negative slide length would break ffmpeg.
  it('keeps fromMs non-decreasing when a step starts after the video has ended', () => {
    const past = [ranRow(1, 10000, 100), ranRow(2, 16000, 100)];
    const times = runVideoStates(past, clock, 5000).map((state) => state.fromMs);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
  });
});

describe('runVideoPhoneBox', () => {
  it('fits a portrait phone to the full height minus margins, on the right, with even sizes', () => {
    const box = runVideoPhoneBox({ width: 1080, height: 2400 });
    expect(box).toEqual({ x: 1432, y: 24, width: 464, height: 1032 });
    expect(box.width % 2).toBe(0);
    expect(box.height % 2).toBe(0);
    expect(box.x + box.width).toBe(RUN_VIDEO_WIDTH - 24);
    expect(box.y + box.height).toBeLessThanOrEqual(RUN_VIDEO_HEIGHT - 24);
  });

  it('makes even sizes for a size that scales to odd numbers', () => {
    const box = runVideoPhoneBox({ width: 721, height: 1599 });
    expect(box.width % 2).toBe(0);
    expect(box.height % 2).toBe(0);
    expect(box.x).toBeGreaterThan(RUN_VIDEO_WIDTH / 2);
  });

  it('fits a landscape phone in the right half and centres it vertically', () => {
    const box = runVideoPhoneBox({ width: 2400, height: 1080 });
    expect(box).toEqual({ x: 972, y: 333, width: 924, height: 414 });
    expect(box.x).toBeGreaterThanOrEqual(RUN_VIDEO_WIDTH / 2);
    expect(box.y * 2 + box.height).toBe(RUN_VIDEO_HEIGHT);
  });
});

function frame(rows: RunVideoRow[], state: RunVideoState, extra: { caseName?: string; passed?: boolean } = {}) {
  return runVideoFrameSvg({
    caseName: extra.caseName ?? 'My case',
    device: 'emulator-5554',
    appId: 'com.example.app',
    passed: extra.passed ?? true,
    rows,
    state,
    phone: runVideoPhoneBox({ width: 1080, height: 2400 }),
  });
}

function stateOf(marks: RowMark[], focus: number, finished = false): RunVideoState {
  return { fromMs: 0, marks, focus, ...(finished ? { finished: true } : {}) };
}

function simpleRows(count: number): RunVideoRow[] {
  return Array.from({ length: count }, (_, index) => ({ number: index + 1, label: `label-${String(index + 1).padStart(4, '0')}` }));
}

describe('runVideoFrameSvg', () => {
  it('escapes XML in labels and the case name', () => {
    const rows: RunVideoRow[] = [{ number: 1, label: `Tap "Tom & Jerry's" <b>` }];
    const svg = frame(rows, stateOf(['running'], 0), { caseName: `A & <script> "q" 'r'` });
    expect(svg).toContain('Tap &#34;Tom &#38; Jerry&#39;s&#34; &#60;b&#62;');
    expect(svg).toContain('A &#38; &#60;script&#62; &#34;q&#34; &#39;r&#39;');
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('<b>');
  });

  it('does not let a control character in a label break the line', () => {
    const svg = frame([{ number: 1, label: 'first\nsecond\u0007third' }], stateOf(['running'], 0));
    expect(svg).toContain('first second third');
    expect(svg).not.toContain('\n');
    expect(svg).not.toContain('\u0007');
  });

  it('cuts a very long label with an ellipsis', () => {
    const svg = frame([{ number: 1, label: 'a'.repeat(300) }], stateOf(['running'], 0));
    expect(svg).toContain(`>${'a'.repeat(71)}…<`);
    expect(svg).not.toContain('a'.repeat(73));
  });

  it('does not cut a short label', () => {
    const svg = frame([{ number: 1, label: 'Tap "OK"' }], stateOf(['running'], 0));
    expect(svg).toContain('Tap &#34;OK&#34;<');
    expect(svg).not.toContain('…');
  });

  it('shows the error of the failed row, wrapped to at most 3 lines', () => {
    const words = Array.from({ length: 120 }, (_, index) => `word${index}`).join(' ');
    const rows: RunVideoRow[] = [{ number: 1, label: 'Tap', status: 'failed', error: words }];
    const svg = frame(rows, stateOf(['failed'], 0, true), { passed: false });
    const errorLines = svg.match(/font-size="22" font-weight="400" fill="#f2766b"[^>]*>[^<]*</g) ?? [];
    expect(errorLines).toHaveLength(3);
    expect(errorLines[0]).toContain('word0 word1');
    expect(errorLines[2]).toContain('…');
  });

  it('shows a short error on one line', () => {
    const rows: RunVideoRow[] = [{ number: 1, label: 'Tap', status: 'failed', error: 'Element not found' }];
    const svg = frame(rows, stateOf(['failed'], 0, true), { passed: false });
    expect(svg.match(/font-size="22" font-weight="400" fill="#f2766b"/g)).toHaveLength(1);
    expect(svg).toContain('>Element not found<');
  });

  it('shows no error text for a failed row without one, or for rows that did not fail', () => {
    const rows: RunVideoRow[] = [{ number: 1, label: 'Tap', status: 'passed', error: 'ignored' }, { number: 2, label: 'Back', status: 'failed' }];
    const svg = frame(rows, stateOf(['passed', 'failed'], 1, true), { passed: false });
    expect(svg).not.toContain('ignored');
    expect(svg).not.toMatch(/font-size="22" font-weight="400" fill="#f2766b"/);
  });

  it('writes "not run" for not-run rows on the finished state only', () => {
    const rows = simpleRows(3);
    const finished = frame(rows, stateOf(['passed', 'failed', 'not-run'], 1, true), { passed: false });
    expect(finished.match(/>not run</g)).toHaveLength(1);
    const running = frame(rows, stateOf(['running', 'waiting', 'waiting'], 0));
    expect(running).not.toContain('not run');
  });

  it('shows the duration of rows that finished', () => {
    const rows: RunVideoRow[] = [{ number: 1, label: 'Tap', status: 'passed', durationMs: 1500 }];
    const svg = frame(rows, stateOf(['passed'], 0, true));
    expect(svg).toMatch(/text-anchor="end"[^>]*>1\.5 ?s</);
  });

  it('headlines the step being run while running', () => {
    expect(frame(simpleRows(5), stateOf(['passed', 'running', 'waiting', 'waiting', 'waiting'], 1))).toContain('>Step 2 of 5<');
  });

  it('headlines Passed when finished and passed', () => {
    const svg = frame(simpleRows(2), stateOf(['passed', 'passed'], 1, true), { passed: true });
    expect(svg).toContain('>Passed<');
    expect(svg).not.toContain('Failed');
  });

  it('headlines the failed step by its number when finished and failed', () => {
    const rows: RunVideoRow[] = [
      { number: 1, label: 'a', status: 'passed' },
      { number: 2, label: 'b', status: 'passed' },
      { number: 3, label: 'c', status: 'failed' },
    ];
    const svg = frame(rows, stateOf(['passed', 'passed', 'failed'], 2, true), { passed: false });
    expect(svg).toContain('>Failed at step 3<');
  });

  it('headlines plain Failed when the run failed without a failed step', () => {
    const svg = frame(simpleRows(2), stateOf(['not-run', 'not-run'], 0, true), { passed: false });
    expect(svg).toContain('>Failed<');
  });

  it('draws the focused row of a long case and leaves out rows far from it', () => {
    const rows = simpleRows(60);
    const marks: RowMark[] = rows.map((_, index) => (index < 30 ? 'passed' : index === 30 ? 'running' : 'waiting'));
    const svg = frame(rows, stateOf(marks, 30));
    expect(svg).toContain('label-0031');
    expect(svg).toContain('label-0032');
    expect(svg).not.toContain('label-0001<');
    expect(svg).not.toContain('label-0060');
  });

  it('draws the first rows when the focus is at the top and the last rows when it is at the bottom', () => {
    const rows = simpleRows(60);
    const top = frame(rows, stateOf(rows.map(() => 'waiting' as const), 0));
    expect(top).toContain('label-0001<');
    expect(top).not.toContain('label-0060');
    const bottom = frame(rows, stateOf(rows.map(() => 'passed' as const), 59, true));
    expect(bottom).toContain('label-0060');
    expect(bottom).not.toContain('label-0001<');
  });

  it('is a 1920x1080 svg', () => {
    expect(frame(simpleRows(1), stateOf(['running'], 0))).toMatch(/^<svg [^>]*width="1920" height="1080"/);
  });
});

describe('runVideoCornersSvg', () => {
  it('draws one evenodd path over the phone', () => {
    const svg = runVideoCornersSvg(runVideoPhoneBox({ width: 1080, height: 2400 }));
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg.match(/<path /g)).toHaveLength(1);
    expect(svg).toContain('M1432 24h464v1032h-464z');
  });
});
