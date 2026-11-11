import { Scalar, stringify } from 'yaml';
import { NEVER_ON_SCREEN, waitName, type MaestroFlow, type MaestroSelector, type MaestroStep, type PercentPoint } from './model.ts';

// Selector values and typed text are always double quoted: Maestro reads them
// as regexes or literal input, and quoting keeps YAML from turning "yes",
// "123" or "${PASSWORD}" into a boolean, a number or a flow mapping.
function quoted(value: string): Scalar<string> {
  const scalar = new Scalar(value);
  scalar.type = Scalar.QUOTE_DOUBLE;
  return scalar;
}

function selectorToYaml(selector: MaestroSelector): Record<string, unknown> {
  switch (selector.kind) {
    case 'id':
      return selector.index === undefined
        ? { id: quoted(selector.value) }
        : { id: quoted(selector.value), index: selector.index };
    case 'text':
      return selector.index === undefined
        ? { text: quoted(selector.value) }
        : { text: quoted(selector.value), index: selector.index };
    case 'point':
      return { point: quoted(`${selector.xPercent}%,${selector.yPercent}%`) };
  }
}

/** "50%, 70%": the form Maestro 2.12 printed back for swipe start and end. */
function percentPoint(point: PercentPoint): Scalar<string> {
  return quoted(`${point.xPercent}%, ${point.yPercent}%`);
}

function envToYaml(env: Record<string, string>): Record<string, Scalar<string>> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, quoted(value)]));
}

function stepToYaml(step: MaestroStep): unknown {
  switch (step.kind) {
    case 'launchApp':
      return step.clearState === undefined ? 'launchApp' : { launchApp: { clearState: step.clearState } };
    case 'runFlow':
      return step.env && Object.keys(step.env).length > 0
        ? { runFlow: { file: step.file, env: envToYaml(step.env) } }
        : { runFlow: { file: step.file } };
    case 'tapOn':
      return { tapOn: selectorToYaml(step.selector) };
    case 'longPressOn':
      return { longPressOn: selectorToYaml(step.selector) };
    case 'doubleTapOn':
      return { doubleTapOn: selectorToYaml(step.selector) };
    case 'inputText':
      return { inputText: quoted(step.text) };
    case 'eraseText':
      return step.chars === undefined ? 'eraseText' : { eraseText: step.chars };
    case 'back':
      return 'back';
    case 'hideKeyboard':
      return 'hideKeyboard';
    case 'assertVisible':
      return { assertVisible: selectorToYaml(step.selector) };
    case 'assertNotVisible':
      return { assertNotVisible: selectorToYaml(step.selector) };
    case 'openLink':
      return { openLink: quoted(step.link) };
    case 'wait':
      return {
        extendedWaitUntil: { visible: quoted(NEVER_ON_SCREEN), timeout: step.seconds * 1000, optional: true, label: quoted(waitName(step.seconds)) },
      };
    case 'waitUntilVisible':
      return { extendedWaitUntil: { visible: selectorToYaml(step.selector), timeout: step.seconds * 1000 } };
    case 'takeScreenshot':
      return step.optional === undefined
        ? { takeScreenshot: { path: step.path } }
        : { takeScreenshot: { path: step.path, optional: step.optional } };
    case 'startRecording':
      return step.optional === undefined
        ? { startRecording: { path: step.path } }
        : { startRecording: { path: step.path, optional: step.optional } };
    case 'stopRecording':
      return 'stopRecording';
    case 'scroll':
      return 'scroll';
    case 'swipe':
      if ('direction' in step) return { swipe: { direction: step.direction } };
      return step.durationMs === undefined
        ? { swipe: { start: percentPoint(step.start), end: percentPoint(step.end) } }
        : { swipe: { start: percentPoint(step.start), end: percentPoint(step.end), duration: step.durationMs } };
    case 'pressKey':
      return { pressKey: step.key };
    case 'setOrientation':
      return { setOrientation: step.orientation };
    case 'scrollUntilVisible': {
      const options: Record<string, unknown> = { element: selectorToYaml(step.selector), direction: step.direction };
      if (step.timeoutMs !== undefined) options.timeout = step.timeoutMs;
      if (step.speed !== undefined) options.speed = step.speed;
      if (step.visibilityPercentage !== undefined) options.visibilityPercentage = step.visibilityPercentage;
      if (step.centerElement !== undefined) options.centerElement = step.centerElement;
      return { scrollUntilVisible: options };
    }
  }
}

const STRINGIFY_OPTIONS = { lineWidth: 0 } as const;

/** Serialises a flow as a Maestro YAML file: header document, `---`, command list. */
export function toMaestroYaml(flow: MaestroFlow): string {
  const header: Record<string, unknown> = { appId: flow.appId };
  if (flow.name !== undefined) header.name = flow.name;
  if (flow.env && Object.keys(flow.env).length > 0) header.env = envToYaml(flow.env);
  const steps = flow.steps.map(stepToYaml);
  return `${stringify(header, STRINGIFY_OPTIONS)}---\n${stringify(steps, STRINGIFY_OPTIONS)}`;
}
