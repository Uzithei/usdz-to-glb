/**
 * GLB (binary GLTF 2.0) builder.
 *
 * Converts a UsdScene into a single self-contained .glb buffer.
 *
 * Pipeline:
 *  1. For every UsdMesh: triangulate faces, expand to flat vertex arrays.
 *  2. Embed textures as images in the binary chunk.
 *  3. Write GLTF JSON + binary chunk as a GLB envelope.
 */

import { UsdScene, UsdMesh, UsdMaterial, Mat4 } from "../parsers/usd-types";

// ─── GLTF constants ────────────────────────────────────────────────────────────
const FLOAT       = 5126;
const UNSIGNED_INT   = 5125;
const UNSIGNED_SHORT = 5123;
const ARRAY_BUFFER      = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

// ─── Internal types ────────────────────────────────────────────────────────────
interface BufView { buffer: number; byteOffset: number; byteLength: number; target?: number }
interface Accessor {
  bufferView: number;
  byteOffset: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}
interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
}
interface GltfMesh   { name: string; primitives: GltfPrimitive[] }
interface GltfNode   { name: string; mesh?: number; matrix?: number[] }
interface GltfMat    { name: string; pbrMetallicRoughness: Record<string, unknown>; doubleSided?: boolean }
interface GltfTex    { source: number; sampler: number }
interface GltfImage  { bufferView: number; mimeType: string }

// ─── Geometry helpers ──────────────────────────────────────────────────────────

/** Triangulates an arbitrary polygon fan (works for tris and quads). */
function triangulateFace(faceIndices: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < faceIndices.length - 1; i++) {
    out.push(faceIndices[0], faceIndices[i], faceIndices[i + 1]);
  }
  return out;
}

/**
 * Expands a USD mesh into flat, unindexed (or re-indexed) triangle vertex data.
 * Returns null if the mesh lacks required geometry.
 */
function expandMesh(mesh: UsdMesh): {
  positions: Float32Array;
  normals:   Float32Array | null;
  uvs:       Float32Array | null;
  indices:   Uint32Array;
} | null {
  const { points, faceVertexCounts, faceVertexIndices, normals, uvs, uvIndices } = mesh;
  if (!points.length || !faceVertexCounts.length || !faceVertexIndices.length) return null;

  const triIndices: number[] = [];
  let corner = 0;
  for (let f = 0; f < faceVertexCounts.length; f++) {
    const count = faceVertexCounts[f];
    const face: number[] = [];
    for (let v = 0; v < count; v++) face.push(faceVertexIndices[corner++]);
    triIndices.push(...triangulateFace(face));
  }

  const numTris = triIndices.length; // = numTriangles * 3

  const positions = new Float32Array(numTris * 3);
  for (let i = 0; i < numTris; i++) {
    const vi = triIndices[i] * 3;
    positions[i * 3]     = points[vi];
    positions[i * 3 + 1] = points[vi + 1];
    positions[i * 3 + 2] = points[vi + 2];
  }

  let outNormals: Float32Array | null = null;
  if (normals && normals.length > 0) {
    outNormals = new Float32Array(numTris * 3);
    for (let i = 0; i < numTris; i++) {
      const ni = normals.length === points.length ? triIndices[i] * 3 : i * 3;
      if (ni + 2 < normals.length) {
        outNormals[i * 3]     = normals[ni];
        outNormals[i * 3 + 1] = normals[ni + 1];
        outNormals[i * 3 + 2] = normals[ni + 2];
      }
    }
  }

  let outUvs: Float32Array | null = null;
  if (uvs && uvs.length > 0) {
    outUvs = new Float32Array(numTris * 2);
    for (let i = 0; i < numTris; i++) {
      const ui = uvIndices ? uvIndices[i] * 2 : triIndices[i] * 2;
      if (ui + 1 < uvs.length) {
        outUvs[i * 2]     = uvs[ui];
        outUvs[i * 2 + 1] = 1.0 - uvs[ui + 1]; 
      }
    }
  }

  const indices = new Uint32Array(numTris);
  for (let i = 0; i < numTris; i++) indices[i] = i;

  return { positions, normals: outNormals, uvs: outUvs, indices };
}

function minMax(arr: Float32Array, stride: number): { min: number[]; max: number[] } {
  const min = new Array(stride).fill(Infinity);
  const max = new Array(stride).fill(-Infinity);
  for (let i = 0; i < arr.length; i++) {
    const c = i % stride;
    if (arr[i] < min[c]) min[c] = arr[i];
    if (arr[i] > max[c]) max[c] = arr[i];
  }
  return { min, max };
}

function applyTransform(positions: Float32Array, m: Mat4): void {
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    positions[i]     = m[0]*x + m[4]*y + m[8]*z  + m[12];
    positions[i + 1] = m[1]*x + m[5]*y + m[9]*z  + m[13];
    positions[i + 2] = m[2]*x + m[6]*y + m[10]*z + m[14];
  }
}

function applyNormalTransform(normals: Float32Array, m: Mat4): void {
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i], y = normals[i + 1], z = normals[i + 2];
    const nx = m[0]*x + m[4]*y + m[8]*z;
    const ny = m[1]*x + m[5]*y + m[9]*z;
    const nz = m[2]*x + m[6]*y + m[10]*z;
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
    if (len > 1e-10) {
      normals[i]     = nx / len;
      normals[i + 1] = ny / len;
      normals[i + 2] = nz / len;
    }
  }
}

function isIdentity(m: Mat4): boolean {
  const id = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  return m.every((v, i) => Math.abs(v - id[i]) < 1e-6);
}

// ─── Mime-type detection ───────────────────────────────────────────────────────

function detectMime(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data[0] === 0x89 && data[1] === 0x50) return "image/png";
  if (data[0] === 0x47 && data[1] === 0x49) return "image/gif";
  return "image/png"; // safe default
}

// ─── Main builder ──────────────────────────────────────────────────────────────

export function buildGlb(scene: UsdScene): Uint8Array {
  const binParts: Uint8Array[] = [];
  let binOffset = 0;

  const bufferViews: BufView[] = [];
  const accessors: Accessor[] = [];
  const gltfMeshes: GltfMesh[] = [];
  const gltfNodes: GltfNode[] = [];
  const gltfMaterials: GltfMat[] = [];
  const gltfTextures: GltfTex[] = [];
  const gltfImages: GltfImage[] = [];
  const samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];

  const matIndexMap = new Map<string, number>();

  // ── Textures ───────────────────────────────────────────────────────────────
  const texIndexMap = new Map<string, number>(); 

  function addTexture(archivePath: string): number | undefined {
    if (texIndexMap.has(archivePath)) return texIndexMap.get(archivePath)!;

    const data = scene.textures.get(archivePath)
      ?? scene.textures.get(archivePath.split("/").pop()!);
    if (!data) return undefined;

    const mime = detectMime(data);
    const pad = (4 - (data.length % 4)) % 4;
    const padded = pad > 0 ? new Uint8Array(data.length + pad) : data;
    if (pad > 0) padded.set(data);

    const bv: BufView = { buffer: 0, byteOffset: binOffset, byteLength: data.length };
    bufferViews.push(bv);
    binParts.push(padded);
    binOffset += padded.length;

    const imgIdx = gltfImages.length;
    gltfImages.push({ bufferView: bufferViews.length - 1, mimeType: mime });

    const texIdx = gltfTextures.length;
    gltfTextures.push({ source: imgIdx, sampler: 0 });

    texIndexMap.set(archivePath, texIdx);
    return texIdx;
  }

  // ── Materials ─────────────────────────────────────────────────────────────

  const SEMANTIC_COLORS: [RegExp, [number, number, number]][] = [
    [/wall/i,       [0.85, 0.83, 0.80]],
    [/floor/i,      [0.75, 0.70, 0.62]],
    [/ceiling/i,    [0.92, 0.92, 0.92]],
    [/window/i,     [0.55, 0.75, 0.95]],
    [/door/i,       [0.60, 0.45, 0.30]],
    [/chair/i,      [0.55, 0.38, 0.25]],
    [/sofa|couch/i, [0.35, 0.50, 0.65]],
    [/table/i,      [0.60, 0.48, 0.32]],
    [/storage|shelf|cabinet/i, [0.62, 0.55, 0.47]],
    [/television|tv|screen/i,  [0.20, 0.20, 0.22]],
    [/bed/i,        [0.75, 0.65, 0.60]],
    [/bathtub|shower|toilet/i, [0.88, 0.88, 0.92]],
    [/stairs/i,     [0.72, 0.66, 0.58]],
  ];

  function resolveColor(mat: UsdMaterial): [number, number, number, number] {
    const { x, y, z, w } = mat.baseColor;
    // If the material is nearly white, apply a semantic color based on the name
    if (x > 0.95 && y > 0.95 && z > 0.95) {
      const label = mat.name + " " + mat.primPath;
      for (const [pattern, color] of SEMANTIC_COLORS) {
        if (pattern.test(label)) return [...color, w];
      }
    }
    return [x, y, z, w];
  }

  function addMaterial(mat: UsdMaterial): number {
    if (matIndexMap.has(mat.primPath)) return matIndexMap.get(mat.primPath)!;

    const color = resolveColor(mat);
    const pbr: Record<string, unknown> = {
      baseColorFactor: color,
      metallicFactor:  mat.metallic,
      roughnessFactor: mat.roughness,
    };

    if (mat.diffuseTexturePath) {
      const texIdx = addTexture(mat.diffuseTexturePath);
      if (texIdx !== undefined) {
        pbr.baseColorTexture = { index: texIdx };
      }
    }

    const idx = gltfMaterials.length;
    gltfMaterials.push({ name: mat.name, pbrMetallicRoughness: pbr, doubleSided: true });
    matIndexMap.set(mat.primPath, idx);
    return idx;
  }

  // ── Geometry ──────────────────────────────────────────────────────────────
  function addAccessor(
    data: Float32Array | Uint32Array | Uint16Array,
    componentType: number,
    type: string,
    target: number,
    withMinMax = false,
  ): number {
    const bytes = data instanceof Float32Array
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : data instanceof Uint32Array
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    const pad = (4 - (bytes.length % 4)) % 4;
    const padded = pad > 0 ? new Uint8Array(bytes.length + pad) : bytes;
    if (pad > 0) padded.set(bytes);

    bufferViews.push({ buffer: 0, byteOffset: binOffset, byteLength: bytes.length, target });
    binParts.push(padded);
    binOffset += padded.length;

    const stride = type === "VEC3" ? 3 : type === "VEC2" ? 2 : 1;
    const count  = data.length / stride;

    const acc: Accessor = {
      bufferView: bufferViews.length - 1,
      byteOffset: 0,
      componentType,
      count,
      type,
    };

    if (withMinMax && data instanceof Float32Array) {
      const { min, max } = minMax(data, stride);
      acc.min = min;
      acc.max = max;
    }

    accessors.push(acc);
    return accessors.length - 1;
  }

  for (const mesh of scene.meshes) {
    const geo = expandMesh(mesh);
    if (!geo) continue;

    if (!isIdentity(mesh.transform)) {
      applyTransform(geo.positions, mesh.transform);
      if (geo.normals) applyNormalTransform(geo.normals, mesh.transform);
    }

    const primitive: GltfPrimitive = { attributes: {} };

    primitive.attributes["POSITION"] = addAccessor(geo.positions, FLOAT, "VEC3", ARRAY_BUFFER, true);

    if (geo.normals) {
      primitive.attributes["NORMAL"] = addAccessor(geo.normals, FLOAT, "VEC3", ARRAY_BUFFER);
    }

    if (geo.uvs) {
      primitive.attributes["TEXCOORD_0"] = addAccessor(geo.uvs, FLOAT, "VEC2", ARRAY_BUFFER);
    }

    let indexData: Uint32Array | Uint16Array = geo.indices;
    let indexType = UNSIGNED_INT;
    if (geo.indices.length <= 65535) {
      indexData = new Uint16Array(geo.indices);
      indexType = UNSIGNED_SHORT;
    }
    primitive.indices = addAccessor(indexData, indexType, "SCALAR", ELEMENT_ARRAY_BUFFER);

    if (mesh.materialPath) {
      const mat = scene.materials.get(mesh.materialPath);
      if (mat) primitive.material = addMaterial(mat);
    }

    const meshIdx = gltfMeshes.length;
    gltfMeshes.push({ name: mesh.name, primitives: [primitive] });
    gltfNodes.push({ name: mesh.name, mesh: meshIdx });
  }

  // ── GLTF JSON ─────────────────────────────────────────────────────────────
  const totalBin = binOffset;

  const gltf: Record<string, unknown> = {
    asset: { version: "2.0", generator: "usdz-to-glb" },
    scene: 0,
    scenes: [{ nodes: gltfNodes.map((_, i) => i) }],
    nodes: gltfNodes,
    meshes: gltfMeshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: totalBin }],
  };

  if (gltfMaterials.length) gltf.materials = gltfMaterials;
  if (gltfTextures.length)  gltf.textures  = gltfTextures;
  if (gltfImages.length)    gltf.images    = gltfImages;
  if (samplers.length && gltfTextures.length) gltf.samplers = samplers;

  // ── GLB envelope ──────────────────────────────────────────────────────────
  const jsonStr    = JSON.stringify(gltf);
  const jsonBytes  = new TextEncoder().encode(jsonStr);
  const jsonPad    = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunkLen = jsonBytes.length + jsonPad;

  const binPad     = (4 - (totalBin % 4)) % 4;
  const binChunkLen = totalBin + binPad;

  // 12 (header) + 8 + jsonChunkLen + 8 + binChunkLen
  const totalLen = 12 + 8 + jsonChunkLen + (totalBin > 0 ? 8 + binChunkLen : 0);
  const out = new Uint8Array(totalLen);
  const dv  = new DataView(out.buffer);

  // Header
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);          // version
  dv.setUint32(8, totalLen, true);   // total length

  // JSON chunk
  dv.setUint32(12, jsonChunkLen, true);
  dv.setUint32(16, 0x4e4f534a, true); 
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonChunkLen); 

  if (totalBin > 0) {
    const binStart = 20 + jsonChunkLen;
    dv.setUint32(binStart, binChunkLen, true);
    dv.setUint32(binStart + 4, 0x004e4942, true); // 'BIN\0'

    let cursor = binStart + 8;
    for (const part of binParts) {
      out.set(part, cursor);
      cursor += part.length;
    }
    out.fill(0x00, cursor, cursor + binPad);
  }

  return out;
}
