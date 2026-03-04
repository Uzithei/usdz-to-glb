/**
 * LZ4 block decompressor (pure JavaScript).
 *
 * Implements the LZ4 block format as used by the USD Crate file format
 * (PXR-USDC) to compress its internal sections (TOKENS, PATHS, FIELDS, etc.).
 *
 * Reference: https://lz4.github.io/lz4/lz4_Block_format.html
 */
export function decompressLZ4(src: Uint8Array, uncompressedSize: number): Uint8Array {
  const dst = new Uint8Array(uncompressedSize);
  let sPos = 0;
  let dPos = 0;

  while (sPos < src.length) {
    const token = src[sPos++];

    // ── Literals ────────────────────────────────────────────────────────────
    let litLen = (token >>> 4) & 0xf;
    if (litLen === 15) {
      let extra: number;
      do {
        extra = src[sPos++];
        litLen += extra;
      } while (extra === 255);
    }

    dst.set(src.subarray(sPos, sPos + litLen), dPos);
    sPos += litLen;
    dPos += litLen;

    if (sPos >= src.length) break;

    // ── Match ────────────────────────────────────────────────────────────────
    const offset = src[sPos] | (src[sPos + 1] << 8);
    sPos += 2;

    if (offset === 0) throw new Error("LZ4: invalid zero offset");

    let matchLen = (token & 0xf) + 4;
    if ((token & 0xf) === 15) {
      let extra: number;
      do {
        extra = src[sPos++];
        matchLen += extra;
      } while (extra === 255);
    }

    let matchPos = dPos - offset;
    for (let i = 0; i < matchLen; i++) {
      dst[dPos++] = dst[matchPos++];
    }
  }

  return dst;
}
