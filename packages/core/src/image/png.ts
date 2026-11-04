// A small PNG reader and writer for screenshots: 8-bit, non-interlaced,
// grayscale, RGB, or either with alpha. That covers what agent-device and
// Maestro write on Android. Anything else throws, and callers treat a
// screenshot they cannot read as "no comparison", never as a failure.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

export type RawImage = {
  width: number;
  height: number;
  /** 1 gray, 2 gray+alpha, 3 RGB, 4 RGBA. */
  channels: 1 | 2 | 3 | 4;
  /** Row-major, `channels` bytes per pixel, no padding. */
  data: Uint8Array;
};

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS: Record<number, RawImage['channels']> = { 0: 1, 2: 3, 4: 2, 6: 4 };
const COLOR_TYPE: Record<RawImage['channels'], number> = { 1: 0, 2: 4, 3: 2, 4: 6 };

export class PngError extends Error {
  override name = 'PngError';
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

export function decodePng(file: Uint8Array): RawImage {
  if (file.length < 8 || SIGNATURE.some((byte, i) => file[i] !== byte)) throw new PngError('Not a PNG file');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels: RawImage['channels'] | undefined;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= file.length) {
    const length = readUint32(file, offset);
    const type = String.fromCharCode(file[offset + 4]!, file[offset + 5]!, file[offset + 6]!, file[offset + 7]!);
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) throw new PngError('Truncated PNG chunk');
    if (type === 'IHDR') {
      width = readUint32(body, 0);
      height = readUint32(body, 4);
      const bitDepth = body[8];
      const colorType = body[9]!;
      const interlace = body[12];
      if (bitDepth !== 8) throw new PngError(`Unsupported PNG bit depth ${bitDepth}`);
      if (interlace !== 0) throw new PngError('Interlaced PNGs are not supported');
      channels = CHANNELS[colorType];
      if (!channels) throw new PngError(`Unsupported PNG color type ${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!channels || width === 0 || height === 0) throw new PngError('PNG has no image header');
  const packed = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (packed.length < height * (stride + 1)) throw new PngError('PNG image data is too short');
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = packed[y * (stride + 1)]!;
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    const previous = row - stride;
    for (let x = 0; x < stride; x++) {
      const raw = packed[source + x]!;
      const left = x >= channels ? data[row + x - channels]! : 0;
      const up = y > 0 ? data[previous + x]! : 0;
      const upLeft = y > 0 && x >= channels ? data[previous + x - channels]! : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4:
          value = raw + paeth(left, up, upLeft);
          break;
        default:
          throw new PngError(`Unknown PNG filter ${filter}`);
      }
      data[row + x] = value & 0xff;
    }
  }
  return { width, height, channels, data };
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/** Encodes with the Up filter on every row, which suits screenshots well enough. */
export function encodePng(image: RawImage): Buffer {
  const { width, height, channels, data } = image;
  const stride = width * channels;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 2;
    for (let x = 0; x < stride; x++) {
      const up = y > 0 ? data[(y - 1) * stride + x]! : 0;
      filtered[y * (stride + 1) + 1 + x] = (data[y * stride + x]! - up) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = COLOR_TYPE[channels];
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(filtered)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Box-filter downscale to `width` x `height`, keeping the channel layout. */
export function resizeImage(image: RawImage, width: number, height: number): RawImage {
  const { channels } = image;
  const data = new Uint8Array(width * height * channels);
  const sums = new Float64Array(channels);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * image.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * image.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / width));
      sums.fill(0);
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const at = (sy * image.width + sx) * channels;
          for (let c = 0; c < channels; c++) sums[c]! += image.data[at + c]!;
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const out = (y * width + x) * channels;
      for (let c = 0; c < channels; c++) data[out + c] = Math.round(sums[c]! / count);
    }
  }
  return { width, height, channels, data };
}
