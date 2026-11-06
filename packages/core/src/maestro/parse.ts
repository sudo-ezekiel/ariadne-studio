import { parseAllDocuments } from 'yaml';
import {
  MAESTRO_KEYS,
  MAESTRO_ORIENTATIONS,
  NEVER_ON_SCREEN,
  type MaestroFlow,
  type MaestroSelector,
  type MaestroStep,
  type PercentPoint,
  type SwipeDirection,
} from './model.ts';

// A deliberately small reader for the Maestro subset we emit. It exists so the
// studio can show flows and developer-written blocks; anything outside the
// subset throws rather than being silently dropped, so a block that uses other
// commands is reported as "not previewable" instead of shown incompletely.

export class MaestroParseError extends Error {
  override name = 'MaestroParseError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new MaestroParseError(`${where} must be a string`);
  return value;
}

function expectKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new MaestroParseError(`Unsupported key "${key}" in ${where}`);
  }
}

function parseEnv(value: unknown, where: string): Record<string, string> {
  if (!isRecord(value)) throw new MaestroParseError(`${where} must be a mapping`);
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, String(v)]));
}

function parsePoint(value: string): MaestroSelector {
  const match = /^\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%\s*$/.exec(value);
  if (!match) throw new MaestroParseError(`Only percentage points are supported, got "${value}"`);
  return { kind: 'point', xPercent: Number(match[1]), yPercent: Number(match[2]) };
}

function parseSelector(value: unknown, command: string): MaestroSelector {
  if (typeof value === 'string') return { kind: 'text', value };
  if (!isRecord(value)) throw new MaestroParseError(`${command} needs a selector`);
  expectKeys(value, ['id', 'text', 'index', 'point'], command);
  const present = ['id', 'text', 'point'].filter((key) => value[key] !== undefined);
  if (present.length !== 1) {
    throw new MaestroParseError(`${command} must use exactly one of id, text or point`);
  }
  if (value.point !== undefined) {
    if (value.index !== undefined) throw new MaestroParseError(`${command}: index cannot be used with point`);
    return parsePoint(expectString(value.point, `${command}.point`));
  }
  let index: number | undefined;
  if (value.index !== undefined) {
    index = typeof value.index === 'number' ? value.index : Number(value.index);
    if (!Number.isInteger(index)) throw new MaestroParseError(`${command}.index must be an integer`);
  }
  const kind = value.id !== undefined ? 'id' : 'text';
  const text = expectString(value[kind], `${command}.${kind}`);
  return index === undefined ? { kind, value: text } : { kind, value: text, index };
}

const SWIPE_DIRECTIONS: readonly SwipeDirection[] = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

/** "50%, 70%" in whole or decimal percentages; pixel coordinates are outside the subset. */
function parsePercentPoint(value: unknown, where: string): PercentPoint {
  const point = parsePoint(expectString(value, where));
  if (point.kind !== 'point') throw new MaestroParseError(`${where} must be a point`);
  return { xPercent: point.xPercent, yPercent: point.yPercent };
}

/** The `direction` form, or `start` and `end` as percentages with an optional `duration`; selectors are outside the subset. */
function parseSwipe(arg: unknown, where: string): MaestroStep {
  if (!isRecord(arg)) throw new MaestroParseError(`swipe needs a direction or a start and end at ${where}`);
  if (arg.start !== undefined || arg.end !== undefined) {
    expectKeys(arg, ['start', 'end', 'duration'], `swipe at ${where}`);
    if (arg.start === undefined || arg.end === undefined) throw new MaestroParseError(`swipe needs both start and end at ${where}`);
    const start = parsePercentPoint(arg.start, `swipe.start at ${where}`);
    const end = parsePercentPoint(arg.end, `swipe.end at ${where}`);
    const durationMs = optionalNumber(arg.duration, `swipe.duration at ${where}`);
    return durationMs === undefined ? { kind: 'swipe', start, end } : { kind: 'swipe', start, end, durationMs };
  }
  expectKeys(arg, ['direction'], `swipe at ${where}`);
  const direction = typeof arg.direction === 'string' ? arg.direction.toUpperCase() : undefined;
  const match = SWIPE_DIRECTIONS.find((candidate) => candidate === direction);
  if (!match) throw new MaestroParseError(`swipe.direction must be UP, DOWN, LEFT or RIGHT at ${where}`);
  return { kind: 'swipe', direction: match };
}

/** Maestro matches key names without regard to case ("volume up" is "Volume Up"). */
function parsePressKey(arg: unknown, where: string): MaestroStep {
  const name = expectString(arg, `pressKey at ${where}`).trim().toLowerCase();
  const key = MAESTRO_KEYS.find((candidate) => candidate.toLowerCase() === name);
  if (!key) throw new MaestroParseError(`Unsupported key "${String(arg)}" in pressKey at ${where}`);
  return { kind: 'pressKey', key };
}

function parseSetOrientation(arg: unknown, where: string): MaestroStep {
  const name = expectString(arg, `setOrientation at ${where}`).trim().toUpperCase();
  const orientation = MAESTRO_ORIENTATIONS.find((candidate) => candidate === name);
  if (!orientation) {
    throw new MaestroParseError(`setOrientation must be PORTRAIT, LANDSCAPE_LEFT, LANDSCAPE_RIGHT or UPSIDE_DOWN at ${where}`);
  }
  return { kind: 'setOrientation', orientation };
}

function optionalNumber(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new MaestroParseError(`${where} must be a number`);
  return value;
}

/** `element` (an id or text selector, or a text shorthand) is required; direction defaults to DOWN. */
function parseScrollUntilVisible(arg: unknown, where: string): MaestroStep {
  const command = `scrollUntilVisible at ${where}`;
  if (!isRecord(arg)) throw new MaestroParseError(`${command} needs an element`);
  expectKeys(arg, ['element', 'direction', 'timeout', 'speed', 'visibilityPercentage', 'centerElement'], command);
  if (arg.element === undefined || arg.element === null) throw new MaestroParseError(`${command} needs an element`);
  const selector = parseSelector(arg.element, `${command}.element`);
  if (selector.kind === 'point') throw new MaestroParseError(`${command}.element must be an id or text, not a point`);
  let direction: SwipeDirection = 'DOWN';
  if (arg.direction !== undefined) {
    const wanted = typeof arg.direction === 'string' ? arg.direction.toUpperCase() : undefined;
    const match = SWIPE_DIRECTIONS.find((candidate) => candidate === wanted);
    if (!match) throw new MaestroParseError(`${command}: direction must be UP, DOWN, LEFT or RIGHT`);
    direction = match;
  }
  const step: Extract<MaestroStep, { kind: 'scrollUntilVisible' }> = { kind: 'scrollUntilVisible', selector, direction };
  const timeoutMs = optionalNumber(arg.timeout, `${command}.timeout`);
  const speed = optionalNumber(arg.speed, `${command}.speed`);
  const visibilityPercentage = optionalNumber(arg.visibilityPercentage, `${command}.visibilityPercentage`);
  if (timeoutMs !== undefined) step.timeoutMs = timeoutMs;
  if (speed !== undefined) step.speed = speed;
  if (visibilityPercentage !== undefined) step.visibilityPercentage = visibilityPercentage;
  if (arg.centerElement !== undefined) {
    if (typeof arg.centerElement !== 'boolean') throw new MaestroParseError(`${command}.centerElement must be true or false`);
    step.centerElement = arg.centerElement;
  }
  return step;
}

/** One command of a flow; `position` is 0-based. Throws MaestroParseError outside the subset. */
export function parseStep(raw: unknown, position: number): MaestroStep {
  const where = `step ${position + 1}`;
  if (typeof raw === 'string') {
    switch (raw) {
      case 'launchApp':
      case 'back':
      case 'hideKeyboard':
      case 'scroll':
        return { kind: raw };
      case 'eraseText':
        return { kind: 'eraseText' };
      default:
        throw new MaestroParseError(`Unsupported command "${raw}" at ${where}`);
    }
  }
  if (!isRecord(raw) || Object.keys(raw).length !== 1) {
    throw new MaestroParseError(`${where} must be a single command`);
  }
  const [command, arg] = Object.entries(raw)[0]!;
  switch (command) {
    case 'launchApp': {
      if (arg === null) return { kind: 'launchApp' };
      if (!isRecord(arg)) throw new MaestroParseError(`launchApp options must be a mapping at ${where}`);
      expectKeys(arg, ['clearState'], `launchApp at ${where}`);
      if (arg.clearState === undefined) return { kind: 'launchApp' };
      if (typeof arg.clearState !== 'boolean') throw new MaestroParseError(`launchApp.clearState must be a boolean`);
      return { kind: 'launchApp', clearState: arg.clearState };
    }
    case 'runFlow': {
      if (typeof arg === 'string') return { kind: 'runFlow', file: arg };
      if (!isRecord(arg)) throw new MaestroParseError(`runFlow needs a file at ${where}`);
      expectKeys(arg, ['file', 'env'], `runFlow at ${where}`);
      const file = expectString(arg.file, `runFlow.file at ${where}`);
      return arg.env === undefined ? { kind: 'runFlow', file } : { kind: 'runFlow', file, env: parseEnv(arg.env, 'runFlow.env') };
    }
    case 'tapOn':
      return { kind: 'tapOn', selector: parseSelector(arg, `tapOn at ${where}`) };
    case 'longPressOn':
      return { kind: 'longPressOn', selector: parseSelector(arg, `longPressOn at ${where}`) };
    case 'doubleTapOn':
      return { kind: 'doubleTapOn', selector: parseSelector(arg, `doubleTapOn at ${where}`) };
    case 'pressKey':
      return parsePressKey(arg, where);
    case 'setOrientation':
      return parseSetOrientation(arg, where);
    case 'assertVisible':
      return { kind: 'assertVisible', selector: parseSelector(arg, `assertVisible at ${where}`) };
    case 'assertNotVisible':
      return { kind: 'assertNotVisible', selector: parseSelector(arg, `assertNotVisible at ${where}`) };
    case 'inputText':
      if (typeof arg === 'number') return { kind: 'inputText', text: String(arg) };
      return { kind: 'inputText', text: expectString(arg, `inputText at ${where}`) };
    case 'eraseText': {
      if (arg === null) return { kind: 'eraseText' };
      if (typeof arg === 'number') return { kind: 'eraseText', chars: arg };
      if (isRecord(arg)) {
        expectKeys(arg, ['charactersToErase'], `eraseText at ${where}`);
        if (typeof arg.charactersToErase === 'number') return { kind: 'eraseText', chars: arg.charactersToErase };
      }
      throw new MaestroParseError(`eraseText takes a number of characters at ${where}`);
    }
    case 'back':
    case 'hideKeyboard':
    case 'scroll':
      if (arg !== null) throw new MaestroParseError(`${command} takes no arguments at ${where}`);
      return { kind: command };
    case 'swipe':
      return parseSwipe(arg, where);
    case 'scrollUntilVisible':
      return parseScrollUntilVisible(arg, where);
    case 'openLink': {
      if (typeof arg === 'string') return { kind: 'openLink', link: arg };
      if (!isRecord(arg)) throw new MaestroParseError(`openLink needs a link at ${where}`);
      expectKeys(arg, ['link'], `openLink at ${where}`);
      return { kind: 'openLink', link: expectString(arg.link, `openLink.link at ${where}`) };
    }
    case 'extendedWaitUntil':
      // Only the form a Wait step writes. Any other wait stays Maestro's to run.
      if (isRecord(arg) && arg.visible === NEVER_ON_SCREEN && arg.optional === true && typeof arg.timeout === 'number') return { kind: 'wait', seconds: arg.timeout / 1000 };
      throw new MaestroParseError(`Unsupported command "extendedWaitUntil" at ${where}`);
    case 'takeScreenshot': {
      if (typeof arg === 'string') return { kind: 'takeScreenshot', path: arg };
      if (!isRecord(arg)) throw new MaestroParseError(`takeScreenshot needs a path at ${where}`);
      expectKeys(arg, ['path', 'optional'], `takeScreenshot at ${where}`);
      const path = expectString(arg.path, `takeScreenshot.path at ${where}`);
      if (arg.optional === undefined) return { kind: 'takeScreenshot', path };
      if (typeof arg.optional !== 'boolean') throw new MaestroParseError(`takeScreenshot.optional must be true or false`);
      return { kind: 'takeScreenshot', path, optional: arg.optional };
    }
    default:
      throw new MaestroParseError(`Unsupported command "${command}" at ${where}`);
  }
}

/** Reads a Maestro flow (header, `---`, command list) back into a MaestroFlow. */
export function parseMaestroFlow(yamlText: string): MaestroFlow {
  const docs = parseAllDocuments(yamlText);
  if (!Array.isArray(docs)) throw new MaestroParseError('Not a YAML document stream');
  for (const doc of docs) {
    if (doc.errors.length > 0) throw new MaestroParseError(doc.errors[0]!.message);
  }
  if (docs.length !== 2) {
    throw new MaestroParseError('A flow needs a header, a "---" line, then a list of commands');
  }
  const header: unknown = docs[0]!.toJS();
  const commands: unknown = docs[1]!.toJS();
  if (!isRecord(header)) throw new MaestroParseError('The flow header must be a mapping');
  expectKeys(header, ['appId', 'name', 'env'], 'the flow header');
  const appId = expectString(header.appId, 'appId');
  if (commands !== null && !Array.isArray(commands)) {
    throw new MaestroParseError('The flow body must be a list of commands');
  }
  const flow: MaestroFlow = { appId, steps: (commands ?? []).map(parseStep) };
  if (header.name !== undefined) flow.name = expectString(header.name, 'name');
  if (header.env !== undefined) flow.env = parseEnv(header.env, 'env');
  return flow;
}
