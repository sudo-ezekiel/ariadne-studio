// Reading a touchscreen from `adb shell getevent`: which input device it is,
// and how its raw events become finished gestures. Pure, so all of it is
// tested without a phone. adb itself is in phone-input.ts.
//
// This is effectively a keylogger, because a touch on the on-screen keyboard
// is a key press. Positions here are never logged, and phone-capture drops
// keyboard touches as soon as it has seen where they fell.
import type { Point, Viewport } from './hit-test.ts';

export type TouchScreen = {
  /** The input device, such as /dev/input/event7. */
  path: string;
  /** The largest raw coordinates it reports, often not the screen's pixels. */
  maxX: number;
  maxY: number;
};

/** Display rotation in quarter turns, as Android counts them. */
export type Rotation = 0 | 1 | 2 | 3;

export type TouchGesture = {
  /** When the first finger came down and the last one lifted, on this computer's clock. */
  downAt: number;
  upAt: number;
  durationMs: number;
  /** Where the first finger started and ended, in viewport pixels. */
  start: Point;
  end: Point;
  /** Farthest the first finger got from `start`, in viewport pixels. */
  travelPx: number;
  /** Most fingers down at once. */
  fingers: number;
};

/**
 * The touchscreen in `getevent -pl`: the device that reports multi-touch
 * positions, preferring one marked as a direct touchscreen. An emulator's has
 * no such mark, and some phones add a second, virtual one that does not touch.
 */
export function findTouchScreen(output: string): TouchScreen | undefined {
  let unmarked: TouchScreen | undefined;
  for (const block of output.split(/^(?=add device )/m)) {
    const path = /^add device \d+:\s*(\S+)/.exec(block)?.[1];
    const maxX = /ABS_MT_POSITION_X\s*:.*?\bmax (\d+)/.exec(block)?.[1];
    const maxY = /ABS_MT_POSITION_Y\s*:.*?\bmax (\d+)/.exec(block)?.[1];
    if (!path || !maxX || !maxY) continue;
    const screen = { path, maxX: Number(maxX), maxY: Number(maxY) };
    if (block.includes('INPUT_PROP_DIRECT')) return screen;
    unmarked ??= screen;
  }
  return unmarked;
}

/** `wm density` prints the physical density, and an override line when one is set. */
export function parseDensity(output: string): number | undefined {
  const values = [...output.matchAll(/density:\s*(\d+)/gi)].map((match) => Number(match[1]));
  return values.at(-1);
}

/** `cmd package resolve-activity --brief` ends with the activity as package/class. */
export function parseHomeApp(output: string): string | undefined {
  const last = output.trim().split(/\r?\n/).at(-1)?.trim();
  return last?.includes('/') ? last.split('/')[0] : undefined;
}

/** The rotation in `dumpsys input`: `Viewport INTERNAL: ... orientation=1, ...`. */
export function parseRotation(output: string): Rotation {
  const value = Number(/Viewport INTERNAL:.*?orientation=(\d)/.exec(output)?.[1] ?? /SurfaceOrientation:\s*(\d)/.exec(output)?.[1] ?? 0);
  return value === 1 || value === 2 || value === 3 ? value : 0;
}

/**
 * Raw touchscreen coordinates to viewport pixels. The panel never turns, so
 * its axes stay those of the phone held upright whatever the display shows.
 */
export function touchToViewport(raw: Point, screen: TouchScreen, viewport: Viewport, rotation: Rotation): Point {
  const x = raw.x / (screen.maxX + 1);
  const y = raw.y / (screen.maxY + 1);
  const { width, height } = viewport;
  const pixel = (share: number, size: number) => Math.min(size - 1, Math.round(share * size));
  switch (rotation) {
    case 0:
      return { x: pixel(x, width), y: pixel(y, height) };
    case 1:
      return { x: pixel(y, width), y: pixel(1 - x, height) };
    case 2:
      return { x: pixel(1 - x, width), y: pixel(1 - y, height) };
    case 3:
      return { x: pixel(1 - y, width), y: pixel(x, height) };
  }
}

const EVENT_LINE = /^\[\s*([\d.]+)\]\s+(\S+)\s+(\S+)\s+(\S+)/;

/** The kernel's clock stops while the phone sleeps, so a gap this much bigger means it did. */
const CLOCK_JUMP_MS = 2000;

type Press = Omit<TouchGesture, 'durationMs'> & { downKernel: number };

/**
 * Turns `getevent -lt` lines into gestures, one per time all fingers lifted.
 * Handles multi-touch protocol B, where a slot keeps its position between
 * touches: a tap on the same spot as the last one reports no position at all.
 */
export class TouchReader {
  private slot = 0;
  private readonly positions = new Map<number, Point>();
  private readonly down = new Set<number>();
  private press: Press | undefined;
  /** This computer's clock minus the kernel's, from the event that arrived fastest since the phone last slept. */
  private clockOffset = Number.POSITIVE_INFINITY;

  constructor(private readonly toPoint: (raw: Point) => Point) {}

  get touching(): boolean {
    return this.press !== undefined;
  }

  /** Reads one line, received at `receivedAt`; returns a gesture when the last finger lifted. */
  read(line: string, receivedAt: number): TouchGesture | undefined {
    const match = EVENT_LINE.exec(line);
    if (!match) return undefined;
    const kernelMs = Number(match[1]) * 1000;
    const offset = receivedAt - kernelMs;
    if (offset < this.clockOffset || offset - this.clockOffset > CLOCK_JUMP_MS) this.clockOffset = offset;
    const [, , type, code, value] = match;
    if (type === 'EV_ABS') this.applyAxis(code!, value!);
    return type === 'EV_SYN' && code === 'SYN_REPORT' ? this.applyReport(kernelMs) : undefined;
  }

  private applyAxis(code: string, value: string): void {
    const number = value === 'ffffffff' ? -1 : Number.parseInt(value, 16);
    const position = this.positions.get(this.slot) ?? { x: 0, y: 0 };
    switch (code) {
      case 'ABS_MT_SLOT':
        this.slot = number;
        break;
      case 'ABS_MT_TRACKING_ID':
        if (number === -1) this.down.delete(this.slot);
        else this.down.add(this.slot);
        break;
      case 'ABS_MT_POSITION_X':
        this.positions.set(this.slot, { ...position, x: number });
        break;
      case 'ABS_MT_POSITION_Y':
        this.positions.set(this.slot, { ...position, y: number });
        break;
    }
  }

  private firstFinger(): Point {
    const slot = Math.min(...this.down);
    return this.toPoint(this.positions.get(slot) ?? { x: 0, y: 0 });
  }

  private applyReport(kernelMs: number): TouchGesture | undefined {
    if (this.down.size > 0) {
      const point = this.firstFinger();
      if (!this.press) {
        const at = kernelMs + this.clockOffset;
        this.press = { downAt: at, upAt: at, downKernel: kernelMs, start: point, end: point, travelPx: 0, fingers: this.down.size };
        return undefined;
      }
      this.press.fingers = Math.max(this.press.fingers, this.down.size);
      this.press.end = point;
      this.press.travelPx = Math.max(this.press.travelPx, Math.hypot(point.x - this.press.start.x, point.y - this.press.start.y));
      return undefined;
    }
    if (!this.press) return undefined;
    const { downKernel, ...press } = this.press;
    this.press = undefined;
    return { ...press, upAt: kernelMs + this.clockOffset, durationMs: Math.round(kernelMs - downKernel) };
  }
}
