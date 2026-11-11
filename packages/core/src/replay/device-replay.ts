// Replaying part of a case on the device, before re-recording from a step or
// recording from the end of another case, goes through agent-device's Maestro
// backend. That backend (0.21.35) runs most of what the recorder writes but
// not all of it: it refuses setOrientation, accepts pressKey only for Back,
// Enter and Home, takes longPressOn and doubleTapOn points only in pixels, and
// a wait is Maestro's command only in a flow, so the studio simply waits, or
// for a wait until, looks at the screen until the element is there.
// This splits a flow into runs agent-device replays and single steps the
// studio performs itself through DeviceSession. Pure.
import type { MaestroSelector, MaestroStep, PercentPoint } from '../maestro/model.ts';
import type { PhoneKey, ScreenOrientation } from '../recorder/case-types.ts';
import { MAESTRO_KEY_OF, MAESTRO_ORIENTATION_OF } from '../recorder/recorder.ts';

/** pressKey names agent-device's replay accepts (checked in its replay-maestro-backend). */
const AGENT_DEVICE_KEYS = new Set<string>(['Home', 'Back', 'Enter']);

/** True when agent-device's Maestro replay runs `step` as Maestro would. */
export function agentDeviceReplays(step: MaestroStep): boolean {
  switch (step.kind) {
    case 'pressKey':
      return AGENT_DEVICE_KEYS.has(step.key);
    case 'setOrientation':
    case 'wait':
    case 'waitUntilVisible':
      return false;
    case 'longPressOn':
    case 'doubleTapOn':
      return step.selector.kind !== 'point';
    default:
      return true;
  }
}

/** What the studio does on the device for a step agent-device cannot replay. */
export type DirectAction =
  | { kind: 'pressKey'; key: PhoneKey }
  | { kind: 'orientation'; value: ScreenOrientation }
  | { kind: 'longPress' | 'doubleTap'; point: PercentPoint }
  | { kind: 'wait'; seconds: number }
  /** Looks at the screen until an element matches `selector` or `seconds` run out, then carries on either way. */
  | { kind: 'waitFor'; selector: MaestroSelector; seconds: number };

export type ReplaySegment = { kind: 'flow'; steps: MaestroStep[] } | { kind: 'direct'; action: DirectAction; step: MaestroStep };

function invert<K extends string, V extends string>(map: Readonly<Record<K, V>>): Map<V, K> {
  return new Map(Object.entries(map).map(([key, value]) => [value as V, key as K]));
}

const PHONE_KEY_OF = invert(MAESTRO_KEY_OF);
const ORIENTATION_OF = invert(MAESTRO_ORIENTATION_OF);

/**
 * The device action for a step agent-device does not replay. Throws for a
 * command the recorder never writes (a pressKey Tab, setOrientation
 * UPSIDE_DOWN), since the studio has no way to perform it either.
 */
export function directAction(step: MaestroStep): DirectAction {
  if (step.kind === 'pressKey') {
    const key = PHONE_KEY_OF.get(step.key);
    if (key) return { kind: 'pressKey', key };
  } else if (step.kind === 'setOrientation') {
    const value = ORIENTATION_OF.get(step.orientation);
    if (value) return { kind: 'orientation', value };
  } else if ((step.kind === 'longPressOn' || step.kind === 'doubleTapOn') && step.selector.kind === 'point') {
    const point = { xPercent: step.selector.xPercent, yPercent: step.selector.yPercent };
    return { kind: step.kind === 'longPressOn' ? 'longPress' : 'doubleTap', point };
  } else if (step.kind === 'wait') {
    return { kind: 'wait', seconds: step.seconds };
  } else if (step.kind === 'waitUntilVisible') {
    return { kind: 'waitFor', selector: step.selector, seconds: step.seconds };
  }
  throw new Error(`The studio cannot replay ${JSON.stringify(step)} on the device`);
}

/**
 * Splits `steps` into runs of commands agent-device replays and, between
 * them, one direct action per command it does not. A flow agent-device
 * replays in full is a single run.
 */
export function replaySegments(steps: readonly MaestroStep[]): ReplaySegment[] {
  const segments: ReplaySegment[] = [];
  for (const step of steps) {
    if (!agentDeviceReplays(step)) {
      segments.push({ kind: 'direct', action: directAction(step), step });
      continue;
    }
    const last = segments.at(-1);
    if (last?.kind === 'flow') last.steps.push(step);
    else segments.push({ kind: 'flow', steps: [step] });
  }
  return segments;
}
