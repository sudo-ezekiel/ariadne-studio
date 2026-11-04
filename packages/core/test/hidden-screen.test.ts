// Telling a phone that shows nothing from a screen that is only dark.
import { describe, expect, it } from 'vitest';
import { SYSTEM_UI, hasAppElements, isBlackImage, looksLikeHomeApp, screenView } from '../src/device/hidden-screen.ts';
import { encodePng, type RawImage } from '../src/image/png.ts';

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
