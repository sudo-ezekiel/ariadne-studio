// The copy of a case flow that Replay actually runs: the same commands, each
// followed by an optional takeScreenshot, with runFlow paths rewritten so the
// copy can live in the run's own directory. Pure.
import { posix } from 'node:path';
import type { MaestroFlow, MaestroStep } from '../maestro/model.ts';

/** takeScreenshot paths the studio adds start with this; the run parser takes them out again. */
export const RUN_SCREENSHOT_PREFIX = 'after-';

/** startRecording path; Maestro saves <flow's debug directory>/startRecording/run-video.mp4. */
export const RUN_VIDEO_NAME = 'run-video';

/** after-001 for the command at flow index 0. */
export function runScreenshotName(flowIndex: number): string {
  return `${RUN_SCREENSHOT_PREFIX}${String(flowIndex + 1).padStart(3, '0')}`;
}

/**
 * `flowsDirFromRunDir` is the case flows directory as seen from the directory
 * the copy is written to, e.g. "../../flows" for runs/<runId>/flow.yaml.
 *
 * No screenshot follows launchApp: Maestro's launchApp returns before the app
 * has drawn, so it would show the launcher. Every other command either waits
 * for its element (tapOn, assertVisible, scrollUntilVisible) or acts on a
 * screen that is already up.
 *
 * With `video`, startRecording comes first and stopRecording last. The start
 * is optional so a video that cannot start never fails the test.
 */
export function instrumentForRun(flow: MaestroFlow, flowsDirFromRunDir: string, options: { video?: boolean } = {}): MaestroFlow {
  const steps: MaestroStep[] = options.video ? [{ kind: 'startRecording', path: RUN_VIDEO_NAME, optional: true }] : [];
  relocateFlow(flow, flowsDirFromRunDir).steps.forEach((step, flowIndex) => {
    steps.push(step);
    if (step.kind !== 'launchApp') steps.push({ kind: 'takeScreenshot', path: runScreenshotName(flowIndex), optional: true });
  });
  if (options.video) steps.push({ kind: 'stopRecording' });
  return { ...flow, steps };
}

/**
 * A case flow rewritten to be saved in another directory: each runFlow file
 * (relative to the flows folder) made relative to the new place, given the
 * flows folder as seen from there.
 */
export function relocateFlow(flow: MaestroFlow, flowsDirFromTarget: string): MaestroFlow {
  return {
    ...flow,
    steps: flow.steps.map((step) =>
      step.kind === 'runFlow' ? { ...step, file: posix.normalize(posix.join(flowsDirFromTarget, step.file)) } : step,
    ),
  };
}
