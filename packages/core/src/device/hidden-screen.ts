// A phone that is asleep or locked still answers: a black picture and nothing of
// any app. Acting on that would press blind and record a step nobody saw, so the
// studio has to tell it from a screen that is only dark.
import { decodePng, type RawImage } from '../image/png.ts';
import { luminanceGrid } from '../image/similarity.ts';

/** Android's own package: the status bar, the notification shade and the lock screen. */
export const SYSTEM_UI = 'com.android.systemui';

/** Below this mean luminance (0 to 255) nothing is lit. Status bar text alone lifts a cell above it. */
const BLACK_BELOW = 2;

type ScreenNode = { systemBar?: unknown; bundleId?: string | undefined };

/** Whether a snapshot holds anything of an app, not just Android's own bars and lock screen. */
export function hasAppElements(nodes: readonly ScreenNode[]): boolean {
  return nodes.some((node) => node.systemBar === undefined && node.bundleId !== SYSTEM_UI);
}

/** Every part of the picture is black, the status bar included, which no lit screen manages. */
export function isBlackImage(image: RawImage): boolean {
  return luminanceGrid(image, { cropTop: 0, cropBottom: 0 }).every((cell) => cell < BLACK_BELOW);
}

export type ScreenView = 'visible' | 'hidden' | 'secure';

/**
 * What a capture shows. Hidden is a black picture with no element of any app.
 * Secure is a black picture whose elements still come through: Android blanks
 * the screenshot of a screen that asks it to, as banks, ID apps and identity
 * checks do, and it can be recorded all the same. A picture that cannot be read
 * counts as seen.
 */
export function screenView(nodes: readonly ScreenNode[], png: Uint8Array): ScreenView {
  let black = false;
  try {
    black = isBlackImage(decodePng(png));
  } catch {
    // Not a picture this can read, so nothing to say about it.
  }
  if (!black) return 'visible';
  return hasAppElements(nodes) ? 'secure' : 'hidden';
}

/** Whether a package is a phone's home screen. Each maker has its own, and they all say so in the name. */
export function looksLikeHomeApp(app: string): boolean {
  return /launcher|\.home(\.|$)/i.test(app);
}
