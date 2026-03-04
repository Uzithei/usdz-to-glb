/**
 * usdz-to-glb — public API
 *
 * Usage:
 *   import { convertUsdzToGlb } from "usdz-to-glb";
 *   const glb = convertUsdzToGlb(fs.readFileSync("model.usdz"));
 *   fs.writeFileSync("model.glb", glb);
 */

import { unpackUSDZ }        from "./parsers/usdz";
import { parseUSDA }         from "./parsers/usda";
import { parseUSDC }         from "./parsers/usdc";
import { buildGlb }          from "./builders/glb";
import { UsdScene, UsdMaterial } from "./parsers/usd-types";

export type { UsdScene }     from "./parsers/usd-types";
export type { UsdMesh }      from "./parsers/usd-types";
export type { UsdMaterial }  from "./parsers/usd-types";

/**
 * Convert a USDZ buffer to a GLB buffer.
 *
 * @param usdzBuffer - Raw bytes of the .usdz file (a ZIP archive).
 * @returns Raw bytes of the resulting .glb file.
 */
export function convertUsdzToGlb(usdzBuffer: Uint8Array | Buffer): Uint8Array {
  const buf = usdzBuffer instanceof Buffer
    ? new Uint8Array(usdzBuffer.buffer, usdzBuffer.byteOffset, usdzBuffer.byteLength)
    : usdzBuffer;

  const entries = unpackUSDZ(buf);
  if (entries.length === 0) throw new Error("usdz-to-glb: archive is empty");

  const assets = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const ext = entry.filename.split(".").pop()?.toLowerCase();
    if (ext !== "usda" && ext !== "usdc") {
      assets.set(entry.filename, entry.data);
      const base = entry.filename.split("/").pop()!;
      assets.set(base, entry.data);
    }
  }

  // Parses every USD layer in the archive and merge meshes + materials.
  // This handles RoomPlan-style USDZ files where geometry is split across
  // many referenced sub-layers rather than inlined in the root.
  const merged: UsdScene = {
    format: "usda",
    upAxis: "Y",
    metersPerUnit: 1.0,
    meshes: [],
    materials: new Map<string, UsdMaterial>(),
    textures: assets,
  };

  for (const entry of entries) {
    const ext = entry.filename.split(".").pop()?.toLowerCase();
    if (ext !== "usda" && ext !== "usdc") continue;

    let scene: UsdScene;
    try {
      if (ext === "usda") {
        const text = new TextDecoder().decode(entry.data);
        scene = parseUSDA(text, assets);
      } else {
        scene = parseUSDC(entry.data, assets);
      }
    } catch {
      continue;
    }

    for (const mesh of scene.meshes) merged.meshes.push(mesh);
    for (const [k, v] of scene.materials) merged.materials.set(k, v);
    if (scene.upAxis) merged.upAxis = scene.upAxis;
    if (scene.metersPerUnit) merged.metersPerUnit = scene.metersPerUnit;
  }

  return buildGlb(merged);
}
