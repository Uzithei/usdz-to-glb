/**
 * USDZ archive unpacker.
 *
 * USDZ is a ZIP archive with a specific layout:
 *  - The first file in the archive is always the root USD layer (.usda or .usdc).
 *  - Subsequent entries are textures, additional USD layers, etc.
 *  - All offsets inside the archive must be 64-byte aligned (required by Apple).
 *
 * This parser supports both STORED (method 0) and DEFLATED (method 8) entries.
 * It does NOT use the central directory — it walks local file headers sequentially,
 * which is more robust for our use case (we only need to unpack, not parse metadata).
 */

import { inflateRaw } from "./inflate";

export interface ZipEntry {
  filename: string;
  data: Uint8Array;
}

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const DATA_DESCRIPTOR_SIG   = 0x08074b50;

export function unpackUSDZ(buffer: Uint8Array): ZipEntry[] {
  const view  = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const entries: ZipEntry[] = [];
  let pos = 0;

  while (pos + 4 <= buffer.length) {
    const sig = view.getUint32(pos, true);

    if (sig !== LOCAL_FILE_HEADER_SIG) {
      break;
    }

    // Local file header layout:
    //  4  signature
    //  2  version needed
    //  2  general purpose bit flag
    //  2  compression method (0=store, 8=deflate)
    //  2  last mod time
    //  2  last mod date
    //  4  crc-32
    //  4  compressed size
    //  4  uncompressed size
    //  2  file name length
    //  2  extra field length
    //  N  file name
    //  M  extra field
    //  [data]

    const method         = view.getUint16(pos + 8,  true);
    const cmpSize        = view.getUint32(pos + 18, true);
    const uncmpSize      = view.getUint32(pos + 22, true);
    const fileNameLen    = view.getUint16(pos + 26, true);
    const extraFieldLen  = view.getUint16(pos + 28, true);

    const headerSize = 30 + fileNameLen + extraFieldLen;
    const dataStart  = pos + headerSize;

    const filename = new TextDecoder().decode(
      buffer.subarray(pos + 30, pos + 30 + fileNameLen)
    );

    if (!filename.endsWith("/")) {
      const compressed = buffer.subarray(dataStart, dataStart + cmpSize);
      let data: Uint8Array;

      if (method === 0) {
        data = compressed.slice();
      } else if (method === 8) {
        data = inflateRaw(compressed, uncmpSize);
      } else {
        throw new Error(`USDZ: unsupported compression method ${method} for "${filename}"`);
      }

      entries.push({ filename, data });
    }

    pos = dataStart + cmpSize;

    const flags = view.getUint16(pos - cmpSize - headerSize + 6, true);
    if (flags & 0x08) {
      const maybeSig = view.getUint32(pos, true);
      pos += (maybeSig === DATA_DESCRIPTOR_SIG) ? 16 : 12;
    }
  }

  return entries;
}

/**
 * Returns the root USD entry (first entry ending in .usda or .usdc),
 * plus all texture/asset entries keyed by their archive filename.
 */
export function parseUSDZArchive(buffer: Uint8Array): {
  rootEntry: ZipEntry;
  assets: Map<string, Uint8Array>;
} {
  const entries = unpackUSDZ(buffer);
  if (entries.length === 0) throw new Error("USDZ: archive is empty");

  const rootEntry = entries[0];
  const ext = rootEntry.filename.split(".").pop()?.toLowerCase();
  if (ext !== "usda" && ext !== "usdc") {
    throw new Error(`USDZ: unexpected root entry type ".${ext}" — expected .usda or .usdc`);
  }

  const assets = new Map<string, Uint8Array>();
  for (let i = 1; i < entries.length; i++) {
    assets.set(entries[i].filename, entries[i].data);
    const base = entries[i].filename.split("/").pop()!;
    assets.set(base, entries[i].data);
  }

  return { rootEntry, assets };
}
