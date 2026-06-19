import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = makeCrcTable();

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

export function readPng(path) {
  const bytes = readFileSync(path);
  if (!bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new Error(`${path}: not a PNG file`);
  }

  let offset = pngSignature.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`${path}: only 8-bit RGB/RGBA PNG is supported by the lab null ladder`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const inflated = inflateSync(Buffer.concat(idat));
  const rowBytes = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  let inputOffset = 0;
  let previous = Buffer.alloc(rowBytes);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    const encoded = inflated.subarray(inputOffset, inputOffset + rowBytes);
    inputOffset += rowBytes;
    const decoded = unfilterRow(filter, encoded, previous, channels);

    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      pixels[dst] = decoded[src];
      pixels[dst + 1] = decoded[src + 1];
      pixels[dst + 2] = decoded[src + 2];
      pixels[dst + 3] = channels === 4 ? decoded[src + 3] : 255;
    }

    previous = decoded;
  }

  return { width, height, pixels, sha256: sha256Buffer(bytes) };
}

export function writePng(path, width, height, rgbaPixels) {
  if (rgbaPixels.length !== width * height * 4) {
    throw new Error(`RGBA payload length mismatch for ${width}x${height}`);
  }

  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    rgbaPixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const chunks = [
    chunk("IHDR", ihdr(width, height)),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ];
  writeFileSync(path, Buffer.concat([pngSignature, ...chunks]));
}

export function comparePng(nativePath, candidatePath) {
  const native = readPng(nativePath);
  const candidate = readPng(candidatePath);

  if (native.width !== candidate.width || native.height !== candidate.height) {
    return {
      width: native.width,
      height: native.height,
      candidateWidth: candidate.width,
      candidateHeight: candidate.height,
      dimensionMismatch: true,
      maxAbsChannelDelta: Infinity,
      meanAbsChannelDelta: Infinity,
      gradientMeanAbsDelta: Infinity
    };
  }

  let maxAbsChannelDelta = 0;
  let sumAbs = 0;
  let sampleCount = 0;
  const diffLuma = new Float64Array(native.width * native.height);

  for (let index = 0; index < native.pixels.length; index += 4) {
    const dr = Math.abs(native.pixels[index] - candidate.pixels[index]);
    const dg = Math.abs(native.pixels[index + 1] - candidate.pixels[index + 1]);
    const db = Math.abs(native.pixels[index + 2] - candidate.pixels[index + 2]);
    maxAbsChannelDelta = Math.max(maxAbsChannelDelta, dr, dg, db);
    sumAbs += dr + dg + db;
    sampleCount += 3;

    const pixel = index / 4;
    const nativeLuma = 0.2126 * native.pixels[index] + 0.7152 * native.pixels[index + 1] + 0.0722 * native.pixels[index + 2];
    const candidateLuma = 0.2126 * candidate.pixels[index] + 0.7152 * candidate.pixels[index + 1] + 0.0722 * candidate.pixels[index + 2];
    diffLuma[pixel] = Math.abs(nativeLuma - candidateLuma);
  }

  let gradientSum = 0;
  let gradientCount = 0;
  for (let y = 0; y < native.height; y += 1) {
    for (let x = 0; x < native.width; x += 1) {
      const i = y * native.width + x;
      if (x + 1 < native.width) {
        gradientSum += Math.abs(diffLuma[i] - diffLuma[i + 1]);
        gradientCount += 1;
      }
      if (y + 1 < native.height) {
        gradientSum += Math.abs(diffLuma[i] - diffLuma[i + native.width]);
        gradientCount += 1;
      }
    }
  }

  return {
    width: native.width,
    height: native.height,
    dimensionMismatch: false,
    nativeSha256: native.sha256,
    candidateSha256: candidate.sha256,
    maxAbsChannelDelta,
    meanAbsChannelDelta: sumAbs / sampleCount,
    gradientMeanAbsDelta: gradientCount === 0 ? 0 : gradientSum / gradientCount
  };
}

function unfilterRow(filter, row, previous, bytesPerPixel) {
  const output = Buffer.alloc(row.length);
  for (let index = 0; index < row.length; index += 1) {
    const left = index >= bytesPerPixel ? output[index - bytesPerPixel] : 0;
    const up = previous[index] ?? 0;
    const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] ?? 0 : 0;
    let predictor = 0;

    if (filter === 1) {
      predictor = left;
    } else if (filter === 2) {
      predictor = up;
    } else if (filter === 3) {
      predictor = Math.floor((left + up) / 2);
    } else if (filter === 4) {
      predictor = paeth(left, up, upperLeft);
    } else if (filter !== 0) {
      throw new Error(`Unsupported PNG filter ${filter}`);
    }

    output[index] = (row[index] + predictor) & 255;
  }
  return output;
}

function paeth(left, up, upperLeft) {
  const p = left + up - upperLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upperLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upperLeft;
}

function ihdr(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return data;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

