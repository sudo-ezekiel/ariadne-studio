// Types for the subset of Maestro we emit and parse. Kept free of runtime
// imports so the UI can import them without pulling in Node-only code.

export type MaestroSelector =
  | { kind: 'id'; value: string; index?: number }
  | { kind: 'text'; value: string; index?: number }
  | { kind: 'point'; xPercent: number; yPercent: number };

export type SwipeDirection = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

/** A position as whole percentages of the screen, the form Maestro's swipe start and end take. */
export type PercentPoint = { xPercent: number; yPercent: number };

/**
 * The pressKey names Maestro 2.12 accepts that make sense on an Android
 * phone (its KeyCode enum also has TV remote and media keys). Maestro has no
 * key for Recent apps. On Android `Power` toggles the screen like the phone's
 * button; `Lock` did nothing on the emulator (checked 2026-11-03).
 */
export const MAESTRO_KEYS = ['Home', 'Back', 'Enter', 'Backspace', 'Tab', 'Escape', 'Volume Up', 'Volume Down', 'Power', 'Lock'] as const;

export type MaestroKey = (typeof MAESTRO_KEYS)[number];

export const MAESTRO_ORIENTATIONS = ['PORTRAIT', 'LANDSCAPE_LEFT', 'LANDSCAPE_RIGHT', 'UPSIDE_DOWN'] as const;

export type MaestroOrientation = (typeof MAESTRO_ORIENTATIONS)[number];

export type MaestroStep =
  | { kind: 'launchApp'; clearState?: boolean }
  | { kind: 'runFlow'; file: string; env?: Record<string, string> }
  | { kind: 'tapOn'; selector: MaestroSelector }
  | { kind: 'longPressOn'; selector: MaestroSelector }
  | { kind: 'doubleTapOn'; selector: MaestroSelector }
  | { kind: 'inputText'; text: string }
  | { kind: 'eraseText'; chars?: number }
  | { kind: 'back' }
  | { kind: 'hideKeyboard' }
  | { kind: 'assertVisible'; selector: MaestroSelector }
  | { kind: 'assertNotVisible'; selector: MaestroSelector }
  /** Opens a URL or deep link with whatever handles it on the device. */
  | { kind: 'openLink'; link: string }
  /**
   * Saves a screenshot as <path>.png in the flow's debug output. The studio
   * adds these to the copy of a flow it replays, never to flows on disk.
   */
  | { kind: 'takeScreenshot'; path: string; optional?: boolean }
  /**
   * Maestro's screen video. Only the copy of a flow that a run uses has these,
   * when "Keep a video of each run" is on. A failed run keeps what was captured.
   */
  | { kind: 'startRecording'; path: string; optional?: boolean }
  | { kind: 'stopRecording' }
  /** Scrolls the main scrollable down (a swipe-up gesture). */
  | { kind: 'scroll' }
  /** `direction: DOWN` moves the content down, which scrolls a list back up. */
  | { kind: 'swipe'; direction: SwipeDirection }
  /** A drag from `start` to `end`, taking Maestro's default duration when `durationMs` is unset. */
  | { kind: 'swipe'; start: PercentPoint; end: PercentPoint; durationMs?: number }
  | { kind: 'pressKey'; key: MaestroKey }
  | { kind: 'setOrientation'; orientation: MaestroOrientation }
  /**
   * Scrolls in `direction` (DOWN brings later content into view) until the
   * element is visible, waiting for the screen first. `selector` is an id or
   * text selector, never a point. Unset options use Maestro's defaults.
   */
  | {
      kind: 'scrollUntilVisible';
      selector: MaestroSelector;
      direction: SwipeDirection;
      timeoutMs?: number;
      speed?: number;
      visibilityPercentage?: number;
      centerElement?: boolean;
    };

export type MaestroFlow = {
  appId: string;
  name?: string;
  env?: Record<string, string>;
  steps: MaestroStep[];
};

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * The ${KEY} variables a flow's steps use, sorted and without repeats. Only
 * plain names count; Maestro's JavaScript expressions such as ${output.id}
 * are not variables a person can set.
 */
export function flowVariables(flow: Pick<MaestroFlow, 'steps'>): string[] {
  const names = new Set<string>();
  for (const match of JSON.stringify(flow.steps).matchAll(VARIABLE)) names.add(match[1]!);
  return [...names].sort();
}

/** Short human label for a selector, used in the step list and logs. */
export function describeSelector(selector: MaestroSelector): string {
  switch (selector.kind) {
    case 'id':
      return `id: ${selector.value}${selector.index !== undefined ? ` [${selector.index}]` : ''}`;
    case 'text':
      return `text: ${selector.value}${selector.index !== undefined ? ` [${selector.index}]` : ''}`;
    case 'point':
      return `point: ${selector.xPercent}%,${selector.yPercent}%`;
  }
}
