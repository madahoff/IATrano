// Dimensions d'une image lues dans son en-tête (PNG, JPEG, GIF, WebP, BMP), sans la décoder.

export const MAX_IMAGE_PIXELS = 60_000_000;

export function imageDimensions(b: Buffer): { width: number; height: number } | null {
  if (b.length < 26) return null;
  if (b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.toString("latin1", 0, 4) === "GIF8") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b[0] === 0x42 && b[1] === 0x4d) return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const chunk = b.toString("latin1", 12, 16);
    if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === "VP8L") return { width: 1 + (b.readUInt16LE(21) & 0x3fff), height: 1 + ((b.readUInt32LE(21) >> 14) & 0x3fff) };
    if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}
