// Pure: reads Maestro's commands.json into per-command results and lines them
// up with the flow that ran. No Node imports, so the UI can share the types.
import type { MaestroFlow, MaestroStep } from '../maestro/model.ts';

/** One top-level command of a Maestro run. Paths are relative to the flow's debug directory. */
export type RunCommand = {
  sequence: number;
  /** Maestro's command name, e.g. tapOnElement, runFlowCommand, assertConditionCommand. */
  name: string;
  status: 'passed' | 'failed';
  durationMs: number;
  /** When Maestro started the command, epoch ms. */
  startedAt?: number;
  error?: string;
  screenshot?: string;
  hierarchy?: string;
  /** For takeScreenshot commands: the path argument, without .png. */
  screenshotName?: string;
};

export type StepStatus = 'passed' | 'failed' | 'not-run';

/** One flow step with what Maestro reported for it. */
export type StepResult = {
  /** Position in the flow's step list (0 is launchApp). */
  flowIndex: number;
  /** Undefined only for a command Maestro ran that has no step in the flow. */
  step?: MaestroStep;
  status: StepStatus;
  durationMs?: number;
  /** When Maestro started the step, epoch ms. */
  startedAt?: number;
  error?: string;
  /** Relative to the flow's debug directory, as Maestro wrote it. */
  screenshot?: string;
  warning?: string;
  /** Project-relative screenshot the studio had Maestro take right after this step. */
  replayScreenshot?: string;
  /** 0-100, how much the replayed screen looks like the recorded one (see screenSimilarity). */
  similarity?: number;
};

/** runs/<runId>/summary.json */
export type RunSummary = {
  runId: string;
  caseId: string;
  /** Project-relative, e.g. flows/<caseId>.yaml. */
  flowFile: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  passed: boolean;
  steps: StepResult[];
  /** Project-relative, e.g. runs/<runId>/<flow name>/screenshots/step-005-....png */
  failureScreenshot?: string;
  /** Project-relative path of Maestro's console output. */
  outputFile: string;
  /** Set when the run failed without a failing step to blame (timeout, no results). */
  error?: string;
  /** Project-relative copy of the flow Maestro ran: the case flow plus screenshot commands. */
  ranFlowFile?: string;
  /** Project-relative run video, e.g. runs/<runId>/video.mp4, when one was kept. */
  video?: string;
  /** Set when the run was part of Run all. */
  suiteId?: string;
  /** 1 for the first run of a case in a suite, 2 for its retry. */
  attempt?: number;
  /**
   * Set when the run failed because of the device or Maestro's driver on it
   * (connection dropped, driver died or never started), not because of the app.
   */
  deviceProblem?: string;
};

// Every run starts with these two at depth 0; they are Maestro's own setup.
const BOOKKEEPING = new Set(['defineVariablesCommand', 'applyConfigurationCommand']);

// The studio adds these at the top level of a run for the run video. A block's own stay inside its runFlow.
const RUN_VIDEO_COMMANDS = new Set(['startRecordingCommand', 'stopRecordingCommand']);

type RawEntry = {
  name: string;
  depth: number;
  sequence: number;
  status: string;
  durationMs: number;
  startedAt?: number;
  error?: string;
  screenshot?: string;
  hierarchy?: string;
  screenshotName?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEntry(raw: unknown): RawEntry | undefined {
  if (!isRecord(raw) || !isRecord(raw.command) || !isRecord(raw.metadata)) return undefined;
  const name = Object.keys(raw.command)[0];
  if (!name) return undefined;
  const meta = raw.metadata;
  const entry: RawEntry = {
    name,
    depth: typeof meta.depth === 'number' ? meta.depth : 0,
    sequence: typeof meta.sequenceNumber === 'number' ? meta.sequenceNumber : -1,
    status: typeof meta.status === 'string' ? meta.status : 'UNKNOWN',
    durationMs: typeof meta.duration === 'number' ? meta.duration : 0,
    ...(typeof meta.timestamp === 'number' ? { startedAt: meta.timestamp } : {}),
  };
  if (isRecord(meta.error) && typeof meta.error.message === 'string') entry.error = meta.error.message;
  const args = raw.command[name];
  if (name === 'takeScreenshotCommand' && isRecord(args) && typeof args.path === 'string') entry.screenshotName = args.path;
  if (Array.isArray(meta.artifacts)) {
    for (const artifact of meta.artifacts) {
      if (!isRecord(artifact) || typeof artifact.path !== 'string') continue;
      if (artifact.type === 'SCREENSHOT' && !entry.screenshot) entry.screenshot = artifact.path;
      if (artifact.type === 'SCREEN_HIERARCHY' && !entry.hierarchy) entry.hierarchy = artifact.path;
    }
  }
  return entry;
}

/**
 * Top-level commands of a run, in order. COMPLETED, WARNED (an optional
 * command that failed) and SKIPPED count as passed; FAILED and anything else
 * (a command still RUNNING when Maestro was stopped) as failed. A failed
 * runFlow takes whatever error, screenshot or hierarchy it lacks from the
 * first failed command nested inside it, which is where Maestro puts them.
 */
export function parseMaestroRun(commandsJson: unknown): RunCommand[] {
  if (!Array.isArray(commandsJson)) throw new Error('commands.json is not a list of commands');
  const entries = commandsJson.map(readEntry).filter((entry): entry is RawEntry => entry !== undefined);
  const commands: RunCommand[] = [];
  let parentFailed: RunCommand | undefined;
  for (const entry of entries) {
    if (entry.depth > 0) {
      if (parentFailed && entry.status === 'FAILED') {
        if (!parentFailed.error && entry.error) parentFailed.error = entry.error;
        if (!parentFailed.screenshot && entry.screenshot) parentFailed.screenshot = entry.screenshot;
        if (!parentFailed.hierarchy && entry.hierarchy) parentFailed.hierarchy = entry.hierarchy;
      }
      continue;
    }
    parentFailed = undefined;
    if (BOOKKEEPING.has(entry.name)) continue;
    const passed = entry.status === 'COMPLETED' || entry.status === 'WARNED' || entry.status === 'SKIPPED';
    const command: RunCommand = {
      sequence: entry.sequence,
      name: entry.name,
      status: passed ? 'passed' : 'failed',
      durationMs: entry.durationMs,
      ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.screenshot ? { screenshot: entry.screenshot } : {}),
      ...(entry.hierarchy ? { hierarchy: entry.hierarchy } : {}),
      ...(entry.screenshotName ? { screenshotName: entry.screenshotName } : {}),
    };
    commands.push(command);
    if (!passed) parentFailed = command;
  }
  return commands;
}

/**
 * Takes out the takeScreenshot commands the studio added (their path starts
 * with `prefix`) and its run video commands, and returns the remaining
 * commands with, for each, the name of the screenshot taken right after it. A
 * screenshot is never blamed for a failure: the studio adds them as optional.
 */
export function separateRunScreenshots(
  commands: readonly RunCommand[],
  prefix: string,
): { commands: RunCommand[]; shotAfter: Map<number, string> } {
  const kept: RunCommand[] = [];
  const shotAfter = new Map<number, string>();
  for (const command of commands) {
    if (RUN_VIDEO_COMMANDS.has(command.name)) continue;
    if (command.name === 'takeScreenshotCommand' && command.screenshotName?.startsWith(prefix)) {
      if (kept.length > 0) shotAfter.set(kept.length - 1, command.screenshotName);
      continue;
    }
    kept.push(command);
  }
  return { commands: kept, shotAfter };
}

/**
 * Pairs each flow step with the top-level command at the same position.
 * Maestro leaves commands after a failure out of commands.json, so steps
 * without a command are `not-run`. Commands beyond the flow's steps mean the
 * flow on disk differs from the one given; they are kept with a warning.
 */
export function correlateRun(flow: MaestroFlow, commands: readonly RunCommand[]): StepResult[] {
  const results: StepResult[] = flow.steps.map((step, flowIndex) => {
    const command = commands[flowIndex];
    if (!command) return { flowIndex, step, status: 'not-run' };
    return { flowIndex, step, ...resultOf(command) };
  });
  commands.slice(flow.steps.length).forEach((command, offset) => {
    results.push({
      flowIndex: flow.steps.length + offset,
      ...resultOf(command),
      warning: `Maestro ran ${command.name}, which has no matching step in the flow`,
    });
  });
  return results;
}

function resultOf(command: RunCommand): Omit<StepResult, 'flowIndex' | 'step'> {
  return {
    status: command.status,
    durationMs: command.durationMs,
    ...(command.startedAt !== undefined ? { startedAt: command.startedAt } : {}),
    ...(command.error ? { error: command.error } : {}),
    ...(command.screenshot ? { screenshot: command.screenshot } : {}),
  };
}

const RUN_AGAIN = 'This is not a test failure; run it again.';
/** A setting on the phone, so running again changes nothing. */
const PHONE_SETTING = 'This is not a test failure, and running it again will not help. See "Phone makers" in the setup guide.';

/**
 * Nothing shows a phone maker's restrictions ahead of time over adb, so they
 * are recognised by what they leave behind. Android drops a blocked launch
 * silently and Maestro reports the launchApp as completed, so that one is only
 * in the device log; it is matched on Maestro's own launch, because any app on
 * the phone can log the same line.
 */
const DEVICE_PROBLEMS: Array<[RegExp, string, string]> = [
  [/device offline|device '[^']*' not found|no devices\/emulators found/i, 'The connection to the device dropped during the run (adb reported it offline or gone).', RUN_AGAIN],
  [/DeviceServerDiedException|Device server died/i, "Maestro's driver on the device stopped during the run.", RUN_AGAIN],
  [/driver did not start up in time|AndroidDriverTimeoutException/i, "Maestro's driver did not start on the device; another tool may be holding it.", RUN_AGAIN],
  [/INSTALL_FAILED_INSUFFICIENT_STORAGE/i, "The device has no room to install Maestro's driver.", RUN_AGAIN],
  [/INSTALL_FAILED_USER_RESTRICTED|INSTALL_CANCELED_BY_USER/i, "The phone did not allow Maestro's driver to install: it may be asking on its screen.", PHONE_SETTING],
  [/requires INJECT_EVENTS|INJECT_EVENTS permission/i, 'The phone blocks simulated touches from this computer.', PHONE_SETTING],
];

const LAUNCH_BLOCKED = 'The phone stopped Maestro from opening the app, so the run never reached it.';

/** Android's line names who asked, Xiaomi's names the app being opened, so each is held to the one it can show. */
function launchBlocked(text: string, appId: string | undefined): boolean {
  return text.split('\n').some((line) => {
    if (line.includes('Background activity launch blocked')) return line.includes('dev.mobile.maestro');
    return line.includes('Permission Denied Activity') && line.includes('category.LAUNCHER') && (!appId || line.includes(`pkg=${appId}`));
  });
}

/**
 * A sentence saying the device, not the app, made the run fail, found in
 * Maestro's output, a step error or the device log; undefined when nothing
 * points there. `appId` is the app the run was opening.
 */
export function deviceProblemIn(text: string, appId?: string): string | undefined {
  for (const [pattern, message, advice] of DEVICE_PROBLEMS) {
    if (pattern.test(text)) return `${message} ${advice}`;
  }
  return launchBlocked(text, appId) ? `${LAUNCH_BLOCKED} ${PHONE_SETTING}` : undefined;
}

/**
 * Replaces env values (at least 4 characters, longest first) with ${KEY}.
 * Maestro prints evaluated commands, so its output and error messages can
 * contain secrets from .env; nothing the studio writes or shows should.
 */
export function redactValues(text: string, env: Readonly<Record<string, string>>): string {
  const entries = Object.entries(env)
    .filter(([, value]) => value.length >= 4)
    .sort((a, b) => b[1].length - a[1].length);
  let result = text;
  for (const [key, value] of entries) result = result.split(value).join(`\${${key}}`);
  return result;
}

export type RunSummaryInput = {
  runId: string;
  caseId: string;
  flowFile: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  timedOut?: boolean;
  /** The flow that ran, for correlation. */
  flow: MaestroFlow;
  /** Parsed commands.json, or undefined when Maestro wrote none. */
  commands: readonly RunCommand[] | undefined;
  /** Project-relative directory holding commands.json (runs/<runId>/<flow name>). */
  flowDir?: string;
  outputFile: string;
  /** Values to redact from error messages. */
  env?: Readonly<Record<string, string>>;
  /** Prefix of the takeScreenshot paths the studio added to the flow that ran. */
  screenshotPrefix?: string;
  /** Maestro's console output and log, searched for device problems when the run failed. */
  diagnostics?: string;
  ranFlowFile?: string;
  video?: string;
  suiteId?: string;
  attempt?: number;
};

/** Builds summary.json from a finished run. */
export function summarizeRun(input: RunSummaryInput): RunSummary {
  const env = input.env ?? {};
  const separated = input.screenshotPrefix
    ? separateRunScreenshots(input.commands ?? [], input.screenshotPrefix)
    : { commands: [...(input.commands ?? [])], shotAfter: new Map<number, string>() };
  const steps = correlateRun(input.flow, separated.commands).map((step) => {
    const shot = separated.shotAfter.get(step.flowIndex);
    const withShot = shot && input.flowDir ? { ...step, replayScreenshot: `${input.flowDir}/takeScreenshot/${shot}.png` } : step;
    return withShot.error ? { ...withShot, error: redactValues(withShot.error, env) } : withShot;
  });
  const failed = steps.find((step) => step.status === 'failed');
  const passed = input.exitCode === 0 && !input.timedOut && !failed;
  let error: string | undefined;
  if (input.timedOut) error = 'Maestro did not finish in time and was stopped.';
  else if (!input.commands) error = `Maestro wrote no command results; see ${input.outputFile}.`;
  else if (!passed && !failed) error = `Maestro exited with code ${input.exitCode} without a failing step; see ${input.outputFile}.`;
  else if (failed && !failed.error) {
    // A step still running when Maestro stopped has no message of its own,
    // typically because the device or Maestro's driver on it went away.
    error = `Maestro stopped during step ${failed.flowIndex + 1} without saying why, often because the device disconnected; see ${input.outputFile} and maestro.log beside it.`;
  }
  return {
    runId: input.runId,
    caseId: input.caseId,
    flowFile: input.flowFile,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    exitCode: input.exitCode,
    passed,
    steps,
    ...(failed?.screenshot && input.flowDir ? { failureScreenshot: `${input.flowDir}/${failed.screenshot}` } : {}),
    outputFile: input.outputFile,
    ...(error ? { error } : {}),
    ...(input.ranFlowFile ? { ranFlowFile: input.ranFlowFile } : {}),
    ...(input.video ? { video: input.video } : {}),
    ...(input.suiteId ? { suiteId: input.suiteId } : {}),
    ...(input.attempt ? { attempt: input.attempt } : {}),
    ...deviceProblemField(passed, input.diagnostics, steps, input.flow.appId),
  };
}

function deviceProblemField(passed: boolean, diagnostics: string | undefined, steps: readonly StepResult[], appId: string): { deviceProblem?: string } {
  if (passed) return {};
  const text = [diagnostics ?? '', ...steps.map((step) => step.error ?? '')].join('\n');
  const problem = deviceProblemIn(text, appId);
  return problem ? { deviceProblem: problem } : {};
}
