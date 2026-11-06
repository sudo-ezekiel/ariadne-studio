// Telling a phone that shows nothing from a screen that is only dark.
import { describe, expect, it } from 'vitest';
import { SYSTEM_UI, blackPicture, hasAppElements, isBlackImage, looksLikeHomeApp, parseKeyguardShowing, screenView } from '../src/device/hidden-screen.ts';
import { decodePng, encodePng, type RawImage } from '../src/image/png.ts';

function image(paint?: (x: number, y: number) => number): RawImage {
  const [width, height] = [72, 160];
  const data = new Uint8Array(width * height);
  if (paint) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = paint(x, y);
  return { width, height, channels: 1, data };
}

const black = image();
/** A dark app: black everywhere but thin white text in the status bar. */
const darkApp = image((x, y) => (y >= 2 && y < 5 && x >= 5 && x < 13 ? 255 : 0));

describe('hasAppElements', () => {
  it('finds nothing on an empty snapshot', () => {
    expect(hasAppElements([])).toBe(false);
  });

  it("does not count Android's own bars or lock screen", () => {
    expect(hasAppElements([{ systemBar: 'status', bundleId: 'com.miui.calculator' }])).toBe(false);
    expect(hasAppElements([{ bundleId: SYSTEM_UI }, { systemBar: 'navigation' }])).toBe(false);
  });

  it('counts an element of any app, and one that names no app', () => {
    expect(hasAppElements([{ bundleId: SYSTEM_UI }, { bundleId: 'com.example.bank' }])).toBe(true);
    expect(hasAppElements([{}])).toBe(true);
  });
});

describe('isBlackImage', () => {
  it('is true for a black picture', () => {
    expect(isBlackImage(black)).toBe(true);
  });

  it('is false when only the status bar is lit', () => {
    expect(isBlackImage(darkApp)).toBe(false);
  });
});

describe('screenView', () => {
  const png = encodePng(black);

  it('is hidden for a black picture with no elements, as from a phone that is asleep', () => {
    expect(screenView([], png)).toBe('hidden');
  });

  it("is hidden for a black picture of Android's lock screen", () => {
    expect(screenView([{ bundleId: SYSTEM_UI }], png)).toBe('hidden');
  });

  it('is secure for a black picture whose elements come through', () => {
    expect(screenView([{ bundleId: 'com.example.bank' }], png)).toBe('secure');
  });

  it('is visible for a picture with something on it and no elements, such as a game', () => {
    expect(screenView([], encodePng(darkApp))).toBe('visible');
  });

  it('is visible for an ordinary screen', () => {
    expect(screenView([{ bundleId: 'com.example.app' }], encodePng(darkApp))).toBe('visible');
  });

  it('counts a picture it cannot read as seen', () => {
    expect(screenView([], new Uint8Array([1, 2, 3]))).toBe('visible');
  });
});

describe('looksLikeHomeApp', () => {
  it.each(['com.mi.android.globallauncher', 'com.miui.home', 'com.sec.android.app.launcher', 'com.google.android.apps.nexuslauncher', 'com.android.launcher3'])('knows %s', (app) => {
    expect(looksLikeHomeApp(app)).toBe(true);
  });

  it.each(['com.android.chrome', 'gr.gov.wallet', 'com.example.homebanking'])('does not take %s for one', (app) => {
    expect(looksLikeHomeApp(app)).toBe(false);
  });
});

describe('parseKeyguardShowing', () => {
  it('is true when the lock screen is showing', () => {
    expect(parseKeyguardShowing('    isKeyguardShowing=true\n')).toBe(true);
  });

  it('is false when it is not', () => {
    expect(parseKeyguardShowing('  mShowingDream=false isKeyguardShowing=false\n')).toBe(false);
  });

  it('is undefined when the line is missing or says something else', () => {
    expect(parseKeyguardShowing('')).toBeUndefined();
    expect(parseKeyguardShowing('mCurrentFocus=Window{u0 com.example}')).toBeUndefined();
    expect(parseKeyguardShowing('isKeyguardShowing=maybe')).toBeUndefined();
  });
});

describe('blackPicture', () => {
  it('decodes, and reads as a black picture', () => {
    const decoded = decodePng(blackPicture({ width: 1080, height: 2400 }));
    expect(isBlackImage(decoded)).toBe(true);
  });

  it('keeps the shape of the viewport', () => {
    const decoded = decodePng(blackPicture({ width: 1080, height: 2400 }));
    expect([decoded.width, decoded.height]).toEqual([108, 240]);
  });

  it('is never empty for a tiny viewport', () => {
    const decoded = decodePng(blackPicture({ width: 3, height: 4 }));
    expect(decoded.width).toBeGreaterThanOrEqual(1);
    expect(decoded.height).toBeGreaterThanOrEqual(1);
    const none = decodePng(blackPicture({ width: 0, height: 0 }));
    expect(none.width).toBeGreaterThanOrEqual(1);
  });
});
