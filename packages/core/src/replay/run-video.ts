// The frames of a run video: the case's steps on the left, each marked as it
// ran, and room for the phone on the right. The layout follows `maestro record`,
// in Ariadne's colours. Labels come from the case, never from Maestro's output,
// so .env values cannot reach the frame. Pure: the studio rasterises the SVG and
// lays the phone over it.
import { formatDuration } from '../recorder/describe.ts';
import type { RunCommand, StepStatus } from './run-result.ts';

export const RUN_VIDEO_WIDTH = 1920;
export const RUN_VIDEO_HEIGHT = 1080;
/** How long the finished frame stays up after the phone's last frame. */
export const RUN_VIDEO_HOLD_MS = 2500;

// Used when a failed run has no stopRecording to measure the delay from.
const TYPICAL_VIDEO_LAG_MS = 400;
const MAX_VIDEO_LAG_MS = 2000;

const MARGIN = 24;
const GAP = 24;
const PHONE_RADIUS = 28;
const PANEL_RADIUS = 18;
const HEADER = 92;
const FOOTER = 60;
const FONT_SIZE = 26;
const ROW = 50;
const LIST_TOP = HEADER + 28;
// Noto Sans Mono: every glyph is 0.6 em wide.
const CHAR_WIDTH = 0.6;
const FONT = 'Noto Sans Mono';

const STAGE = '#0f1627';
const PANEL = '#1a202b';
const PANEL_2 = '#232a37';
const TEXT = '#e8ebf1';
const TEXT_2 = '#a4adbd';
const TEXT_3 = '#7a8496';
const LINE = '#333b4a';
const THREAD = '#e8b43a';
const PASS = '#5cc27a';
const FAIL = '#f2766b';

// The mark from site/img/icon.svg, without its tile.
const MEANDER = `<path d="M14 20V50H50V14H26V38H38V26" fill="none" stroke="${THREAD}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="14" cy="14" r="4.5" fill="none" stroke="${THREAD}" stroke-width="3.5"/><circle cx="38" cy="26" r="5" fill="${THREAD}"/>`;

/** One step of the case, as a row of the frame. */
export type RunVideoRow = {
  number: number;
  label: string;
  status?: StepStatus;
  error?: string;
  durationMs?: number;
  /** When Maestro started the step, epoch ms. Undefined for a step that did not run. */
  startedAt?: number;
};

export type RowMark = 'waiting' | 'running' | 'passed' | 'failed' | 'not-run';

/** What the frame shows from `fromMs` of the video until the next state. */
export type RunVideoState = {
  fromMs: number;
  marks: RowMark[];
  /** Index of the row to keep on screen. */
  focus: number;
  /** Set on the last state. */
  finished?: boolean;
};

export type RunVideoClock = {
  /** When Maestro started the screen recording, epoch ms. */
  startedAt: number;
  /** How long after that the video's first frame was taken. */
  lagMs: number;
};

export type Size = { width: number; height: number };
export type Box = Size & { x: number; y: number };

/**
 * When the video started, from the studio's startRecording and stopRecording
 * commands. Android's screen recorder takes a moment to start, and that delay
 * is what the video lacks of the time between the two commands.
 */
export function runVideoClock(commands: readonly RunCommand[], videoMs: number): RunVideoClock | undefined {
  const start = commands.find((command) => command.name === 'startRecordingCommand');
  if (start?.startedAt === undefined || start.status !== 'passed') return undefined;
  const stop = commands.find((command) => command.name === 'stopRecordingCommand');
  const measured = stop?.startedAt !== undefined ? stop.startedAt - start.startedAt - videoMs : TYPICAL_VIDEO_LAG_MS;
  return { startedAt: start.startedAt, lagMs: Math.min(Math.max(measured, 0), MAX_VIDEO_LAG_MS) };
}

function finalMark(status: StepStatus | undefined): RowMark {
  if (status === 'passed' || status === 'failed') return status;
  return 'not-run';
}

/**
 * One state per step that ran, from the moment it started, and a last one
 * with the outcome. Two steps that start in the same video frame share one.
 */
export function runVideoStates(rows: readonly RunVideoRow[], clock: RunVideoClock, videoMs: number): RunVideoState[] {
  // A failed run's delay is only a typical one, so a late step can land past the video's end.
  const inVideo = (at: number) => Math.min(Math.max(at - clock.startedAt - clock.lagMs, 0), videoMs);
  const states: RunVideoState[] = [];
  const add = (state: RunVideoState) => {
    if (states.at(-1)?.fromMs === state.fromMs) states.pop();
    states.push(state);
  };

  let focus = 0;
  let endedAt: number | undefined;
  for (const [index, row] of rows.entries()) {
    if (row.startedAt === undefined) continue;
    const marks = rows.map((other, otherIndex): RowMark => {
      if (otherIndex === index) return 'running';
      return otherIndex < index ? finalMark(other.status) : 'waiting';
    });
    add({ fromMs: inVideo(row.startedAt), marks, focus: index });
    focus = index;
    endedAt = row.startedAt + (row.durationMs ?? 0);
  }
  add({ fromMs: endedAt === undefined ? 0 : inVideo(endedAt), marks: rows.map((row) => finalMark(row.status)), focus, finished: true });
  states[0] = { ...states[0]!, fromMs: 0 };
  return states;
}

/** The phone at full height on the right; a landscape screen keeps to the right half, centred. */
export function runVideoPhoneBox(phone: Size): Box {
  const maxWidth = RUN_VIDEO_WIDTH / 2 - MARGIN - GAP / 2;
  const maxHeight = RUN_VIDEO_HEIGHT - 2 * MARGIN;
  const scale = Math.min(maxHeight / phone.height, maxWidth / phone.width);
  // Even sizes: H.264 with 4:2:0 colour needs them.
  const width = Math.floor((phone.width * scale) / 2) * 2;
  const height = Math.floor((phone.height * scale) / 2) * 2;
  return { x: RUN_VIDEO_WIDTH - MARGIN - width, y: Math.round((RUN_VIDEO_HEIGHT - height) / 2), width, height };
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Cut to `max` characters. Control characters (a typed newline) would break the line. */
function fit(text: string, max: number): string {
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  const chars = [...line];
  return chars.length <= max ? line : `${chars.slice(0, Math.max(max - 1, 0)).join('')}…`;
}

/** Word-wrapped to at most `lines` lines of `width` characters. */
function wrap(text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let current = '';
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  let used = 0;
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if ([...next].length <= width) {
      current = next;
      used += 1;
      continue;
    }
    if (out.length === lines - 1) break;
    if (current) out.push(current);
    current = word;
    used += 1;
  }
  if (used === words.length) return current ? [...out, fit(current, width)] : out;
  return [...out, fit(`${current} ${words.slice(used).join(' ')}`, width)];
}

function textAt(x: number, y: number, text: string, options: { size?: number; fill?: string; weight?: number; anchor?: string } = {}): string {
  const { size = FONT_SIZE, fill = TEXT, weight = 400, anchor = 'start' } = options;
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" xml:space="preserve">${escapeXml(text)}</text>`;
}

/** The status mark of a row, centred on (x, y). */
function markSvg(mark: RowMark, x: number, y: number): string {
  const r = 14;
  switch (mark) {
    case 'passed':
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="${PASS}"/><path d="M${x - 6.5} ${y + 0.5}l4.5 4.5l9-10" fill="none" stroke="${STAGE}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'failed':
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="${FAIL}"/><path d="M${x - 5.5} ${y - 5.5}l11 11M${x + 5.5} ${y - 5.5}l-11 11" fill="none" stroke="${STAGE}" stroke-width="3.2" stroke-linecap="round"/>`;
    case 'running':
      return `<circle cx="${x}" cy="${y}" r="${r - 1.5}" fill="none" stroke="${THREAD}" stroke-width="3"/><circle cx="${x}" cy="${y}" r="5.5" fill="${THREAD}"/>`;
    default:
      return `<rect x="${x - 11}" y="${y - 11}" width="22" height="22" rx="5" fill="none" stroke="${TEXT_3}" stroke-width="2"/>`;
  }
}

function headline(state: RunVideoState, rows: readonly RunVideoRow[], passed: boolean): { text: string; fill: string } {
  if (!state.finished) return { text: `Step ${state.focus + 1} of ${rows.length}`, fill: THREAD };
  if (passed) return { text: 'Passed', fill: PASS };
  const failed = rows.find((row) => row.status === 'failed');
  return { text: failed ? `Failed at step ${failed.number}` : 'Failed', fill: FAIL };
}

export type RunVideoFrame = {
  caseName: string;
  /** The device it ran on, shown under the case name. */
  device: string;
  appId: string;
  passed: boolean;
  rows: readonly RunVideoRow[];
  state: RunVideoState;
  phone: Box;
};

/** First row to draw so `focus` stays on screen with some of what comes next below it. */
function firstRow(focus: number, total: number, visible: number): number {
  const wanted = focus - Math.floor((visible * 2) / 3);
  return Math.min(Math.max(wanted, 0), Math.max(total - visible, 0));
}

/** The whole frame apart from the phone's own pixels. */
export function runVideoFrameSvg(frame: RunVideoFrame): string {
  const { rows, state, phone } = frame;
  const panelRight = phone.x - GAP;
  const panelWidth = panelRight - MARGIN;
  const panelHeight = RUN_VIDEO_HEIGHT - 2 * MARGIN;
  const textLeft = MARGIN + 96;
  const durationRight = panelRight - 32;
  const charWidth = FONT_SIZE * CHAR_WIDTH;
  // Room for a duration column at the right of each row.
  const labelChars = Math.floor((durationRight - textLeft - 120) / charWidth);
  const errorSize = 22;
  const errorChars = Math.floor((durationRight - textLeft) / (errorSize * CHAR_WIDTH));

  const failedIndex = state.marks.indexOf('failed');
  const failedRow = failedIndex === -1 ? undefined : rows[failedIndex];
  const errorLines = failedRow?.error ? wrap(failedRow.error, errorChars, 3) : [];
  const errorHeight = errorLines.length * 30 + (errorLines.length > 0 ? 8 : 0);

  const listHeight = panelHeight - LIST_TOP - FOOTER - errorHeight - 12;
  const visible = Math.floor(listHeight / ROW);
  const first = firstRow(state.focus, rows.length, visible);

  const parts: string[] = [
    `<rect width="${RUN_VIDEO_WIDTH}" height="${RUN_VIDEO_HEIGHT}" fill="${STAGE}"/>`,
    `<rect x="${MARGIN}" y="${MARGIN}" width="${panelWidth}" height="${panelHeight}" rx="${PANEL_RADIUS}" fill="${PANEL}" stroke="${LINE}"/>`,
    `<rect x="${phone.x}" y="${phone.y}" width="${phone.width}" height="${phone.height}" rx="${PHONE_RADIUS}" fill="#000"/>`,
  ];

  const heading = headline(state, rows, frame.passed);
  const statusChars = heading.text.length + 2;
  parts.push(
    textAt(MARGIN + 32, MARGIN + 44, fit(frame.caseName, Math.floor((panelWidth - 64) / (30 * CHAR_WIDTH)) - statusChars), { size: 30, weight: 700 }),
    textAt(MARGIN + 32, MARGIN + 76, fit(`${frame.appId} on ${frame.device}`, Math.floor((panelWidth - 64) / (20 * CHAR_WIDTH))), { size: 20, fill: TEXT_2 }),
    textAt(panelRight - 32, MARGIN + 44, heading.text, { size: 26, weight: 700, fill: heading.fill, anchor: 'end' }),
    `<path d="M${MARGIN} ${MARGIN + HEADER + 8}H${panelRight}" stroke="${LINE}"/>`,
  );

  let y = MARGIN + LIST_TOP;
  for (let index = first; index < Math.min(first + visible, rows.length); index++) {
    const row = rows[index]!;
    const mark = state.marks[index]!;
    const middle = y + ROW / 2;
    if (mark === 'running') parts.push(`<rect x="${MARGIN + 12}" y="${y + 3}" width="${panelWidth - 24}" height="${ROW - 6}" rx="8" fill="${PANEL_2}"/>`);
    parts.push(markSvg(mark, MARGIN + 44, middle));
    const dim = mark === 'waiting' || mark === 'not-run';
    parts.push(textAt(textLeft, middle + 9, fit(row.label, labelChars), { fill: dim ? TEXT_3 : TEXT, weight: mark === 'running' ? 700 : 400 }));
    const done = mark === 'passed' || mark === 'failed';
    if (done && row.durationMs !== undefined) parts.push(textAt(durationRight, middle + 8, formatDuration(row.durationMs), { size: 22, fill: TEXT_3, anchor: 'end' }));
    if (mark === 'not-run') parts.push(textAt(durationRight, middle + 8, 'not run', { size: 22, fill: TEXT_3, anchor: 'end' }));
    y += ROW;
    if (index === failedIndex && errorLines.length > 0) {
      for (const [line, text] of errorLines.entries()) parts.push(textAt(textLeft, y + 22 + line * 30, text, { size: errorSize, fill: FAIL }));
      y += errorHeight;
    }
  }

  const line = 'Ariadne, a recorder for Maestro';
  const lineWidth = line.length * 20 * CHAR_WIDTH;
  const lineLeft = MARGIN + (panelWidth - lineWidth + 34) / 2;
  parts.push(
    `<g transform="translate(${lineLeft - 34} ${RUN_VIDEO_HEIGHT - MARGIN - 40}) scale(0.34)">${MEANDER}</g>`,
    textAt(lineLeft, RUN_VIDEO_HEIGHT - MARGIN - 22, line, { size: 20, fill: TEXT_3 }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RUN_VIDEO_WIDTH}" height="${RUN_VIDEO_HEIGHT}" viewBox="0 0 ${RUN_VIDEO_WIDTH} ${RUN_VIDEO_HEIGHT}">${parts.join('')}</svg>`;
}

/** Drawn over the phone: stage colour outside its rounded corners, clear everywhere else. */
export function runVideoCornersSvg(phone: Box): string {
  const { x, y, width: w, height: h } = phone;
  const r = PHONE_RADIUS;
  const outer = `M${x} ${y}h${w}v${h}h${-w}z`;
  const inner = `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RUN_VIDEO_WIDTH}" height="${RUN_VIDEO_HEIGHT}" viewBox="0 0 ${RUN_VIDEO_WIDTH} ${RUN_VIDEO_HEIGHT}"><path d="${outer}${inner}" fill="${STAGE}" fill-rule="evenodd"/></svg>`;
}
