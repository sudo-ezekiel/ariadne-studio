import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng, PngError, resizeImage, type RawImage } from '../src/image/png.ts';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Deterministic noise, so filtered bytes wrap around 0 and 255 often. */
function noise(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

function ihdr(width: number, height: number, options: { bitDepth?: number; colorType?: number; interlace?: number } = {}): Buffer {
  const body = Buffer.alloc(13);
  body.writeUInt32BE(width, 0);
  body.writeUInt32BE(height, 4);
  body[8] = options.bitDepth ?? 8;
  body[9] = options.colorType ?? 0;
  body[12] = options.interlace ?? 0;
  return chunk('IHDR', body);
}

/** Straight from the PNG specification, written separately from the decoder under test. */
function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Filters raw scanlines with the given filter type per row (cycled), as an encoder would. */
function filterScanlines(image: RawImage, filters: readonly number[]): Buffer {
  const { width, height, channels, data } = image;
  const stride = width * channels;
  const out = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length]!;
    out[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const raw = data[y * stride + x]!;
      const a = x >= channels ? data[y * stride + x - channels]! : 0;
      const b = y > 0 ? data[(y - 1) * stride + x]! : 0;
      const c = y > 0 && x >= channels ? data[(y - 1) * stride + x - channels]! : 0;
      const predicted = [0, a, b, Math.floor((a + b) / 2), paethPredictor(a, b, c)][filter]!;
      out[y * (stride + 1) + 1 + x] = (raw - predicted) & 0xff;
    }
  }
  return out;
}

const COLOR_TYPE: Record<RawImage['channels'], number> = { 1: 0, 2: 4, 3: 2, 4: 6 };

/** A PNG assembled by hand: an ancillary chunk before the data, and the zlib stream split over two IDAT chunks. */
function handMadePng(image: RawImage, filtered: Uint8Array): Buffer {
  const compressed = deflateSync(filtered);
  const half = Math.floor(compressed.length / 2);
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    ihdr(image.width, image.height, { colorType: COLOR_TYPE[image.channels] }),
    chunk('tEXt', Buffer.from('Software\0test', 'latin1')),
    chunk('IDAT', compressed.subarray(0, half)),
    chunk('IDAT', compressed.subarray(half)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function rawImage(width: number, height: number, channels: RawImage['channels'], seed = 7): RawImage {
  return { width, height, channels, data: noise(width * height * channels, seed) };
}

describe('encodePng and decodePng', () => {
  it.each([
    ['gray', 1],
    ['gray with alpha', 2],
    ['RGB', 3],
    ['RGBA', 4],
  ] as const)('round-trips a %s image', (_label, channels) => {
    const image = rawImage(13, 9, channels, channels);
    const file = encodePng(image);
    expect([...file.subarray(0, 8)]).toEqual(SIGNATURE);
    // IHDR: bit depth 8, the colour type for the channel count, not interlaced.
    expect(file.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect([file[24], file[25], file[28]]).toEqual([8, COLOR_TYPE[channels], 0]);
    const decoded = decodePng(file);
    expect({ ...decoded, data: [...decoded.data] }).toEqual({ ...image, data: [...image.data] });
  });

  it('round-trips a single pixel', () => {
    const image: RawImage = { width: 1, height: 1, channels: 4, data: Uint8Array.from([1, 2, 3, 4]) };
    expect([...decodePng(encodePng(image)).data]).toEqual([1, 2, 3, 4]);
  });
});

describe('decodePng unfiltering', () => {
  it('undoes Sub and Average on a hand-computed gray image, with wraparound', () => {
    // Row 0, Sub: 10, 10+5. Row 1, Average: 4+(0+10)/2 = 9, 250+(9+15)/2 = 262 -> 6.
    const filtered = Uint8Array.from([1, 10, 5, 3, 4, 250]);
    const png = handMadePng({ width: 2, height: 2, channels: 1, data: new Uint8Array(4) }, filtered);
    expect([...decodePng(png).data]).toEqual([10, 15, 9, 6]);
  });

  it('undoes Paeth on a hand-computed gray image, picking up, upper-left and up', () => {
    // Row 0, Sub: 100, 200, 256 -> 0.
    // Row 1, Paeth: x0 predicts up (100); x1 a=20 b=200 c=100 predicts upper-left (100);
    // x2 a=7 b=0 c=200 predicts up (0).
    const filtered = Uint8Array.from([1, 100, 100, 56, 4, 176, 163, 5]);
    const png = handMadePng({ width: 3, height: 2, channels: 1, data: new Uint8Array(6) }, filtered);
    expect([...decodePng(png).data]).toEqual([100, 200, 0, 20, 7, 5]);
  });

  it.each([
    ['Sub', [1]],
    ['Average', [3]],
    ['Paeth', [4]],
    ['a mix of all five', [1, 3, 4, 0, 2, 4, 3, 1]],
  ] as const)('undoes %s filtering on RGB and RGBA noise', (_label, filters) => {
    for (const channels of [3, 4] as const) {
      const image = rawImage(11, 8, channels, 40 + channels);
      const decoded = decodePng(handMadePng(image, filterScanlines(image, filters)));
      expect(decoded).toMatchObject({ width: 11, height: 8, channels });
      expect([...decoded.data]).toEqual([...image.data]);
    }
  });

  it('undoes Paeth on gray with alpha, where the left neighbour is two bytes back', () => {
    const image = rawImage(6, 5, 2, 99);
    const decoded = decodePng(handMadePng(image, filterScanlines(image, [4, 1, 3])));
    expect([...decoded.data]).toEqual([...image.data]);
  });
});

describe('decodePng rejects what it cannot read', () => {
  function withHeader(header: Buffer): Buffer {
    return Buffer.concat([Buffer.from(SIGNATURE), header, chunk('IDAT', deflateSync(Buffer.alloc(8))), chunk('IEND', new Uint8Array(0))]);
  }

  it('rejects input that is not a PNG', () => {
    expect(() => decodePng(Buffer.from('GIF89a not a png at all'))).toThrow(PngError);
    expect(() => decodePng(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]))).toThrow(/Not a PNG/);
    expect(() => decodePng(new Uint8Array(0))).toThrow(PngError);
    expect(() => decodePng(Uint8Array.from(SIGNATURE.slice(0, 7)))).toThrow(PngError);
  });

  it('rejects interlaced images', () => {
    expect(() => decodePng(withHeader(ihdr(2, 2, { colorType: 2, interlace: 1 })))).toThrow(PngError);
    expect(() => decodePng(withHeader(ihdr(2, 2, { colorType: 2, interlace: 1 })))).toThrow(/Interlaced/);
  });

  it('rejects 16-bit and low bit depth images', () => {
    expect(() => decodePng(withHeader(ihdr(2, 2, { colorType: 6, bitDepth: 16 })))).toThrow(PngError);
    expect(() => decodePng(withHeader(ihdr(2, 2, { colorType: 6, bitDepth: 16 })))).toThrow(/bit depth 16/);
    expect(() => decodePng(withHeader(ihdr(2, 2, { colorType: 0, bitDepth: 1 })))).toThrow(PngError);
  });

  it('rejects palette images', () => {
    expect(() => decodePng(withHeader(ihdr(2, 2, { colorType: 3 })))).toThrow(/color type 3/);
  });

  it('rejects a file without a header, truncated chunks, short data and unknown filters', () => {
    const noHeader = Buffer.concat([Buffer.from(SIGNATURE), chunk('IEND', new Uint8Array(0))]);
    expect(() => decodePng(noHeader)).toThrow(PngError);
    const good = encodePng(rawImage(4, 4, 3));
    expect(() => decodePng(good.subarray(0, good.length - 20))).toThrow(PngError);
    const shortData = handMadePng({ width: 4, height: 4, channels: 1, data: new Uint8Array(16) }, new Uint8Array(10));
    expect(() => decodePng(shortData)).toThrow(/too short/);
    const badFilter = handMadePng({ width: 1, height: 1, channels: 1, data: new Uint8Array(1) }, Uint8Array.from([5, 0]));
    expect(() => decodePng(badFilter)).toThrow(/filter 5/);
  });

  it('names its error class', () => {
    try {
      decodePng(Buffer.from('nope'));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PngError);
      expect((error as Error).name).toBe('PngError');
    }
  });
});

describe('resizeImage', () => {
  it('averages 2x2 boxes when halving a 4x4 gray image', () => {
    const image: RawImage = {
      width: 4,
      height: 4,
      channels: 1,
      data: Uint8Array.from([
        0, 4, 100, 100,
        8, 4, 100, 102,
        255, 255, 1, 0,
        255, 251, 0, 0,
      ]),
    };
    const half = resizeImage(image, 2, 2);
    expect(half).toMatchObject({ width: 2, height: 2, channels: 1 });
    // (0+4+8+4)/4 = 4, (100+100+100+102)/4 = 100.5 -> 101, (255*3+251)/4 = 254, (1+0+0+0)/4 = 0.25 -> 0.
    expect([...half.data]).toEqual([4, 101, 254, 0]);
  });

  it('averages each channel on its own and keeps the layout', () => {
    const pixel = (r: number, g: number, b: number, a: number) => [r, g, b, a];
    const image: RawImage = {
      width: 2,
      height: 2,
      channels: 4,
      data: Uint8Array.from([...pixel(200, 0, 10, 255), ...pixel(100, 0, 30, 255), ...pixel(0, 40, 50, 0), ...pixel(100, 40, 70, 0)]),
    };
    const one = resizeImage(image, 1, 1);
    expect(one).toMatchObject({ width: 1, height: 1, channels: 4 });
    expect([...one.data]).toEqual([100, 20, 40, 128]);
  });

  it('is the identity at the same size and handles ratios that are not whole numbers', () => {
    const image = rawImage(5, 3, 3, 3);
    expect([...resizeImage(image, 5, 3).data]).toEqual([...image.data]);
    const row: RawImage = { width: 3, height: 1, channels: 1, data: Uint8Array.from([10, 20, 40]) };
    // Output pixel 0 covers source 0, output pixel 1 covers sources 1 and 2.
    expect([...resizeImage(row, 2, 1).data]).toEqual([10, 30]);
  });

  it('downscales a screenshot-sized image to the recording size', () => {
    const big: RawImage = { width: 1080, height: 2400, channels: 3, data: new Uint8Array(1080 * 2400 * 3).fill(200) };
    const small = resizeImage(big, 540, 1200);
    expect(small.data.length).toBe(540 * 1200 * 3);
    expect(small.data.every((value) => value === 200)).toBe(true);
  });
});
