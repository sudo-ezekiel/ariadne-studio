// The words and the Maestro YAML of the studio demo on the landing page.
// Pure functions with no DOM, so Node can import this file in a test.
// The YAML has the shape packages/core/src/maestro/emit.ts writes, and the
// wording follows packages/core/src/recorder/describe.ts.
//
// A demo step is one of:
//   { kind: 'tap', selector, name }      a tap on an element
//   { kind: 'check', selector, name }    Check that it is visible
//   { kind: 'type', text }               text typed into the focused field
//   { kind: 'back' }                     the phone's Back button
//   { kind: 'key', key }                 another phone button, by its Maestro key name
//   { kind: 'swipe', direction }         a swipe across the screen: LEFT, RIGHT, UP or DOWN
//   { kind: 'rotate', orientation }      Rotate, by Maestro's orientation name (PORTRAIT, LANDSCAPE_LEFT, ...)
// where selector is { kind: 'id' | 'text', value } with the value escaped as
// Maestro reads it (a regular expression), or { kind: 'point', xPercent, yPercent }
// for a tap with no named element, and name is what the element shows.

export const APP_ID = 'com.example.agenda';

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/** Maestro reads id and text selectors as regular expressions that must match the whole value. */
export function escapeMaestroRegex(value) {
  return value.replace(REGEX_META, '\\$&');
}

function unescapeMaestroRegex(value) {
  return value.replace(/\\([.*+?^${}()|[\]\\])/g, '$1');
}

/** The selector the studio picks: the resource id when the element has one, else its visible text. */
export function selectorFor({ id, text }, appId = APP_ID) {
  return id
    ? { kind: 'id', value: escapeMaestroRegex(`${appId}:id/${id}`) }
    : { kind: 'text', value: escapeMaestroRegex(text) };
}

/** A tap by position, in whole percentages of the screen: the last resort when nothing has a name. */
export function pointSelector(xPercent, yPercent) {
  return { kind: 'point', xPercent: Math.round(xPercent), yPercent: Math.round(yPercent) };
}

/** The selector as the step list shows it, under the step's words. */
export function describeSelector(selector) {
  if (selector.kind === 'point') return `point: "${selector.xPercent}%,${selector.yPercent}%"`;
  const value = unescapeMaestroRegex(selector.value);
  return selector.kind === 'id' ? `id: ${value}` : `text: "${value}"`;
}

// How a step names its element: the element's own name, or where it was tapped.
function target(step) {
  if (step.selector.kind !== 'point') return `"${step.name}"`;
  return step.name ? `"${step.name}" (by its position on screen)` : `the point at ${step.selector.xPercent}% across, ${step.selector.yPercent}% down`;
}

// The words a phone button takes in a step ("Press Volume up"), by Maestro key name.
const KEY_WORDS = {
  Home: 'Home',
  Enter: 'Enter',
  'Volume Up': 'Volume up',
  'Volume Down': 'Volume down',
  Power: 'Power',
};

// The words for Maestro's orientations, as describe.ts has them.
const ORIENTATION_WORDS = {
  PORTRAIT: 'Rotate to portrait',
  LANDSCAPE_LEFT: 'Rotate to landscape',
  LANDSCAPE_RIGHT: 'Rotate to landscape, turned right',
  UPSIDE_DOWN: 'Rotate upside down',
};

/** A step as its row reads: the kind word, what it did, and the selector when it has one. */
export function stepWords(step) {
  switch (step.kind) {
    case 'tap':
      return { kind: 'tap', text: `Tap ${target(step)}`, selector: describeSelector(step.selector) };
    case 'check':
      return { kind: 'check', text: `Check that ${target(step)} is visible`, selector: describeSelector(step.selector) };
    case 'type':
      return { kind: 'type', text: `Type "${step.text}"` };
    case 'back':
      return { kind: 'back', text: 'Press Back' };
    case 'key':
      return { kind: 'key', text: `Press ${KEY_WORDS[step.key] ?? step.key}` };
    case 'swipe':
      return { kind: 'swipe', text: `Swipe ${step.direction.toLowerCase()}` };
    case 'rotate':
      return { kind: 'rotate', text: ORIENTATION_WORDS[step.orientation] };
    default:
      throw new Error(`Unknown step kind: ${step.kind}`);
  }
}

/** The first row of every case. */
export function startWords(appId = APP_ID) {
  return `Starts with a fresh start of ${appId}`;
}

/** What Maestro prints when a step's element is not on the screen (id and text selectors). */
export function notFoundMessage(selector) {
  return `Element not found: ${selector.kind === 'id' ? 'Id' : 'Text'} matching regex: ${selector.value}`;
}

/** How long a step took: "420 ms", "3.1 s", "1 min 5 s". */
export function formatDuration(ms) {
  if (Math.round(ms) < 1000) return `${Math.round(ms)} ms`;
  const tenths = Math.round(ms / 100) / 10;
  if (tenths < 60) return `${tenths.toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** A double-quoted YAML scalar, escaped the way the yaml package writes one. */
export function yamlQuote(value) {
  // The yaml package starts from the JSON string and swaps each \u00NN for YAML's own escape.
  // Matching whole escapes keeps a typed backslash followed by "u0007" from being read as one.
  return JSON.stringify(value).replace(/\\(u[0-9a-f]{4}|.)/g, (escape, body) => {
    if (body.length === 1) return escape;
    const code = body.slice(1);
    if (YAML_ESCAPES[code]) return YAML_ESCAPES[code];
    return code.startsWith('00') ? `\\x${code.slice(2)}` : escape;
  });
}

const YAML_ESCAPES = { '0000': '\\0', '0007': '\\a', '000b': '\\v', '001b': '\\e' };

// Plain when YAML would read the value back as the same string, quoted otherwise.
// Stricter than the yaml package, which is fine for an app id, a case name and a key name.
const PLAIN_SAFE = /^\p{L}[\p{L}\p{N} ._/-]*[\p{L}\p{N}.]$|^\p{L}$/u;
const YAML_WORDS = /^(true|false|null)$/i;

function scalar(value) {
  return PLAIN_SAFE.test(value) && !YAML_WORDS.test(value) && !/ #|: /.test(value) ? value : yamlQuote(value);
}

function selectorLines(selector) {
  if (selector.kind === 'point') return [`    point: ${yamlQuote(`${selector.xPercent}%,${selector.yPercent}%`)}`];
  return [`    ${selector.kind}: ${yamlQuote(selector.value)}`];
}

/** The Maestro commands of one step, as YAML lines. */
export function stepYaml(step) {
  switch (step.kind) {
    case 'tap':
      return ['- tapOn:', ...selectorLines(step.selector)];
    case 'check':
      return ['- assertVisible:', ...selectorLines(step.selector)];
    case 'type':
      return [`- inputText: ${yamlQuote(step.text)}`];
    case 'back':
      return ['- back'];
    case 'key':
      return [`- pressKey: ${scalar(step.key)}`];
    case 'swipe':
      return ['- swipe:', `    direction: ${step.direction}`];
    case 'rotate':
      return [`- setOrientation: ${step.orientation}`];
    default:
      throw new Error(`Unknown step kind: ${step.kind}`);
  }
}

/** The flow file of a case: header, `---`, then launchApp and one command per step. */
export function toMaestroYaml({ appId = APP_ID, name, steps }) {
  const lines = [`appId: ${scalar(appId)}`];
  if (name !== undefined) lines.push(`name: ${scalar(name)}`);
  lines.push('---', '- launchApp', ...steps.flatMap(stepYaml));
  return `${lines.join('\n')}\n`;
}

/** A case name as a file name: "Create an event" becomes "create-an-event". */
export function slug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
