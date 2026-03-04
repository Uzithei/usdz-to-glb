/**
 * USDC (USD Crate / PXR-USDC) binary parser.
 *
 * Reads the binary crate format produced by Pixar's USD library and extracts
 * geometry + material data into a UsdScene.
 *
 * Crate file layout:
 *  [0..7]   magic  "PXR-USDC"
 *  [8..15]  version (major, minor, patch, ...)
 *  followed by the section table at a known offset in the TOC
 *
 * Each section is identified by a name token and has a start+size.
 * Sections of interest: TOKENS, STRINGS, FIELDS, FIELDSETS, PATHS, SPECS.
 * Each section may be LZ4-compressed.
 */

import { UsdScene, UsdMesh, UsdMaterial, UsdScene as US, Vec4, identityMat4, Mat4 } from "./usd-types";
import { decompressLZ4 } from "../utils/lz4";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAGIC = "PXR-USDC";

const enum VT {
  Invalid       = 0,
  bool          = 1,
  uchar         = 2,
  int           = 3,
  uint          = 4,
  int64         = 5,
  uint64        = 6,
  half          = 7,
  float         = 8,
  double        = 9,
  string        = 10,
  token         = 11,
  asset         = 12,
  matrix2d      = 13,
  matrix3d      = 14,
  matrix4d      = 15,
  quatd         = 16,
  quatf         = 17,
  quath         = 18,
  vec2d         = 19,
  vec2f         = 20,
  vec2h         = 21,
  vec2i         = 22,
  vec3d         = 23,
  vec3f         = 24,
  vec3h         = 25,
  vec3i         = 26,
  vec4d         = 27,
  vec4f         = 28,
  vec4h         = 29,
  vec4i         = 30,
  dictionary    = 31,
  tokenListOp   = 32,
  stringListOp  = 33,
  pathListOp    = 34,
  referenceListOp = 35,
  intListOp     = 36,
  int64ListOp   = 37,
  uintListOp    = 38,
  uint64ListOp  = 39,
  variantSelectionMap = 40,
  timeSamples   = 41,
  payload       = 42,
  doubleVector  = 43,
  layerOffsetVector = 44,
  stringVector  = 45,
  valueBlock     = 46,
  value         = 47,
  unregisteredValue = 48,
  unregisteredValueListOp = 49,
  payloadListOp = 50,
  timeCode      = 51,
}

const enum SpecType {
  Attribute  = 1,
  Connection = 2,
  Expression = 3,
  Mapper     = 4,
  MapperArg  = 5,
  Prim       = 6,
  PseudoRoot = 7,
  Relationship = 8,
  RelationshipTarget = 9,
  Variant    = 10,
  VariantSet = 11,
}

// ─── Reader helper ─────────────────────────────────────────────────────────────

class Reader {
  private dv: DataView;
  pos: number;

  constructor(private buf: Uint8Array) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = 0;
  }

  get length() { return this.buf.length; }

  seek(pos: number) { this.pos = pos; }

  u8()  { return this.dv.getUint8(this.pos++); }
  i32() { const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  u32() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }

  u64(): number {
    const lo = this.dv.getUint32(this.pos, true);
    const hi = this.dv.getUint32(this.pos + 4, true);
    this.pos += 8;
    return hi * 0x100000000 + lo;
  }

  varint(): number {
    let result = 0;
    let shift  = 0;
    while (true) {
      const b = this.u8();
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return result >>> 0; 
  }

  bytes(n: number): Uint8Array {
    const slice = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  string(n: number): string {
    return new TextDecoder().decode(this.bytes(n));
  }

  align(n: number) {
    const r = this.pos % n;
    if (r) this.pos += n - r;
  }
}

// ─── Section table ─────────────────────────────────────────────────────────────

interface Section {
  name: string;
  start: number;
  size:  number;
}

function readSections(r: Reader): Section[] {
  r.seek(r.length - 8);
  const tocOffset = r.u64();

  r.seek(tocOffset);
  const count = r.u64();

  const sections: Section[] = [];
  for (let i = 0; i < count; i++) {
    const rawName = r.bytes(16);
    const name    = new TextDecoder().decode(rawName).replace(/\0.*$/, "");
    const start   = r.u64();
    const size    = r.u64();
    sections.push({ name, start, size });
  }
  return sections;
}

function getSection(sections: Section[], name: string): Section | undefined {
  return sections.find(s => s.name === name);
}

// ─── Compressed section reader ─────────────────────────────────────────────────

/**
 * Crate sections use a simple framing:
 *   uint64  uncompressed size
 *   uint64  compressed size
 *   [compressed data — LZ4 block]
 * If compressedSize == uncompressedSize the data is stored uncompressed.
 */
function readCompressedSection(r: Reader, sec: Section): Uint8Array {
  r.seek(sec.start);
  const uncompSize = r.u64();
  const cmpSize    = r.u64();
  const raw        = r.bytes(cmpSize);
  if (cmpSize === uncompSize) return raw.slice();
  return decompressLZ4(raw, uncompSize);
}

// ─── TOKENS section ────────────────────────────────────────────────────────────

function readTokens(r: Reader, sec: Section): string[] {
  const data  = readCompressedSection(r, sec);
  const dr    = new Reader(data);
  const count = dr.u64();
  const tokens: string[] = [];
  for (let i = 0; i < count; i++) {
    let s = "";
    let b: number;
    while ((b = dr.u8()) !== 0) s += String.fromCharCode(b);
    tokens.push(s);
  }
  return tokens;
}

// ─── STRINGS section ────────────────────────────────────────────────────────────

function readStrings(r: Reader, sec: Section, tokens: string[]): string[] {
  const data  = readCompressedSection(r, sec);
  const dr    = new Reader(data);
  const count = dr.u64();
  const strings: string[] = [];
  for (let i = 0; i < count; i++) {
    strings.push(tokens[dr.u32()] ?? "");
  }
  return strings;
}

// ─── FIELDS section ────────────────────────────────────────────────────────────

interface Field {
  tokenIndex: number;  
  valueRep:   number;  
}

function readFields(r: Reader, sec: Section): Field[] {
  const data  = readCompressedSection(r, sec);
  const dr    = new Reader(data);
  const count = dr.u64();
  const fields: Field[] = [];
  for (let i = 0; i < count; i++) {
    const tokenIndex = dr.u32();
    dr.align(8);
    const lo    = dr.u32();
    const hi    = dr.u32();
    const rep   = hi * 0x100000000 + lo;
    fields.push({ tokenIndex, valueRep: rep });
  }
  return fields;
}

// ─── FIELDSETS section ─────────────────────────────────────────────────────────

function readFieldSets(r: Reader, sec: Section): number[][] {
  const data   = readCompressedSection(r, sec);
  const dr     = new Reader(data);
  const count  = dr.u64();
  const sets: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < count; i++) {
    const idx = dr.u32();
    if (idx === 0xffffffff) {
      sets.push(cur);
      cur = [];
    } else {
      cur.push(idx);
    }
  }
  return sets;
}

// ─── PATHS section ─────────────────────────────────────────────────────────────

interface PathNode {
  path:        string;
  tokenIndex:  number;
  fieldSetIdx: number;
  specType:    SpecType;
  jump:        number;
  hasChildren: boolean;
  hasSiblings: boolean;
}

function readPaths(r: Reader, sec: Section, tokens: string[]): PathNode[] {
  const data  = readCompressedSection(r, sec);
  const dr    = new Reader(data);
  const count = dr.u64();
  const nodes: PathNode[] = [];

  for (let i = 0; i < count; i++) {
    const tokenIndex  = dr.u32();
    const fieldSetIdx = dr.u32(); 
    const specType    = dr.u32() as SpecType;
    const flags       = dr.u32();
    const jump        = dr.i32();

    nodes.push({
      path: tokens[tokenIndex] ?? "",
      tokenIndex,
      fieldSetIdx,
      specType,
      jump,
      hasChildren: !!(flags & 1),
      hasSiblings: !!(flags & 2),
    });
  }
  return nodes;
}

// ─── SPECS section ─────────────────────────────────────────────────────────────

interface Spec {
  pathIndex:    number;
  fieldSetIndex: number;
  specType:     SpecType;
}

function readSpecs(r: Reader, sec: Section): Spec[] {
  const data  = readCompressedSection(r, sec);
  const dr    = new Reader(data);
  const count = dr.u64();
  const specs: Spec[] = [];
  for (let i = 0; i < count; i++) {
    const pathIndex    = dr.u32();
    const fieldSetIndex = dr.u32();
    const specType     = dr.u32() as SpecType;
    specs.push({ pathIndex, fieldSetIndex, specType });
  }
  return specs;
}

// ─── Value decoding ────────────────────────────────────────────────────────────

/**
 * Decode a USD value representation.
 *
 * The 64-bit valueRep packs:
 *   bits[5:0]   type tag (VT enum)
 *   bit[6]      array flag
 *   bit[7]      inlined flag (small values stored directly)
 *   bits[63:8]  payload (inline value OR byte offset into the file)
 */
function decodeValueRep(
  rep: number,
  r: Reader,
  tokens: string[],
  strings: string[],
): unknown {
  const typeTag = rep & 0x3f;
  const isArray  = !!(rep & 0x40);
  const inlined  = !!(rep & 0x80);
  const payload  = Math.floor(rep / 256); // bits 63:8

  if (inlined) {
    return decodeInline(typeTag, payload, tokens, strings);
  }

  const savedPos = r.pos;
  r.seek(payload);

  let value: unknown;
  if (isArray) {
    value = decodeArray(typeTag, r, tokens, strings);
  } else {
    value = decodeScalar(typeTag, r, tokens, strings);
  }

  r.seek(savedPos);
  return value;
}

function decodeInline(typeTag: number, payload: number, tokens: string[], strings: string[]): unknown {
  switch (typeTag) {
    case VT.bool:   return payload !== 0;
    case VT.uchar:  return payload & 0xff;
    case VT.int:    return payload | 0; 
    case VT.uint:   return payload >>> 0;
    case VT.float:  {
      const buf = new ArrayBuffer(4);
      new DataView(buf).setUint32(0, payload, true);
      return new DataView(buf).getFloat32(0, true);
    }
    case VT.double: return payload; 
    case VT.token:  return tokens[payload] ?? "";
    case VT.string: return strings[payload] ?? "";
    case VT.asset:  return strings[payload] ?? "";
    default: return payload;
  }
}

function decodeScalar(typeTag: number, r: Reader, tokens: string[], strings: string[]): unknown {
  switch (typeTag) {
    case VT.bool:   return r.u8() !== 0;
    case VT.int:    return r.i32();
    case VT.uint:   return r.u32();
    case VT.float:  return r.f32();
    case VT.double: return r.f64();
    case VT.token:  return tokens[r.u32()] ?? "";
    case VT.string: return strings[r.u32()] ?? "";
    case VT.asset:  return strings[r.u32()] ?? "";
    case VT.vec2f:  return [r.f32(), r.f32()] as [number, number];
    case VT.vec3f:  return [r.f32(), r.f32(), r.f32()] as [number, number, number];
    case VT.vec4f:  return [r.f32(), r.f32(), r.f32(), r.f32()] as [number, number, number, number];
    case VT.vec2d:  return [r.f64(), r.f64()] as [number, number];
    case VT.vec3d:  return [r.f64(), r.f64(), r.f64()] as [number, number, number];
    case VT.matrix4d: {
      const m: number[] = [];
      for (let i = 0; i < 16; i++) m.push(r.f64());
      return [
        m[0], m[4], m[8],  m[12],
        m[1], m[5], m[9],  m[13],
        m[2], m[6], m[10], m[14],
        m[3], m[7], m[11], m[15],
      ] as Mat4;
    }
    default: return undefined;
  }
}

function decodeArray(typeTag: number, r: Reader, tokens: string[], strings: string[]): unknown {
  const count = r.u64();
  const items: unknown[] = [];
  for (let i = 0; i < count; i++) {
    items.push(decodeScalar(typeTag, r, tokens, strings));
  }
  return items;
}

// ─── Prim tree construction ────────────────────────────────────────────────────

interface CratePrim {
  path:     string;
  specType: SpecType;
  attrs:    Map<string, unknown>;
  children: CratePrim[];
}

function buildPrimTree(
  specs: Spec[],
  pathStrings: string[],
  fieldSets: number[][],
  fields: Field[],
  tokens: string[],
  strings: string[],
  fileReader: Reader,
): CratePrim[] {
  const roots: CratePrim[] = [];
  const stack: CratePrim[] = [];

  for (const spec of specs) {
    const path = pathStrings[spec.pathIndex] ?? "";
    const attrs = new Map<string, unknown>();

    const fieldSet = fieldSets[spec.fieldSetIndex] ?? [];
    for (const fi of fieldSet) {
      const field = fields[fi];
      if (!field) continue;
      const attrName = tokens[field.tokenIndex] ?? "";
      const value    = decodeValueRep(field.valueRep, fileReader, tokens, strings);
      attrs.set(attrName, value);
    }

    const prim: CratePrim = { path, specType: spec.specType, attrs, children: [] };

    const depth = path.split("/").filter(Boolean).length;
    while (stack.length >= depth) stack.pop();

    if (stack.length > 0) {
      stack[stack.length - 1].children.push(prim);
    } else {
      roots.push(prim);
    }
    stack.push(prim);
  }

  return roots;
}

// ─── Scene extraction ──────────────────────────────────────────────────────────

function extractScene(prims: CratePrim[], assets: Map<string, Uint8Array>): UsdScene {
  const meshes: UsdMesh[] = [];
  const materials = new Map<string, UsdMaterial>();

  function walkMaterials(p: CratePrim): void {
    const typeName = p.attrs.get("typeName") as string ?? "";
    if (typeName === "Material" || p.path.toLowerCase().includes("material")) {
      const mat = extractMaterial(p);
      if (mat) materials.set(p.path, mat);
    }
    for (const c of p.children) walkMaterials(c);
  }

  function walkMeshes(p: CratePrim, parentTransform: Mat4): void {
    const typeName = p.attrs.get("typeName") as string ?? "";
    const localXform = extractTransform(p);
    const world = multiplyMat4(parentTransform, localXform);

    if (typeName === "Mesh") {
      const mesh = extractMesh(p, world);
      if (mesh) meshes.push(mesh);
    }

    for (const c of p.children) walkMeshes(c, world);
  }

  for (const p of prims) walkMaterials(p);
  for (const p of prims) walkMeshes(p, identityMat4());

  return { format: "usdc", upAxis: "Y", metersPerUnit: 1.0, meshes, materials, textures: assets };
}

function multiplyMat4(a: Mat4, b: Mat4): Mat4 {
  const out = identityMat4();
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = s;
    }
  }
  return out;
}

function extractTransform(p: CratePrim): Mat4 {
  const m = p.attrs.get("xformOp:transform") as Mat4 | undefined;
  if (m) return m;

  const t = identityMat4();
  const tr = p.attrs.get("xformOp:translate") as [number,number,number] | undefined;
  if (tr) { t[12] = tr[0]; t[13] = tr[1]; t[14] = tr[2]; }
  return t;
}

function extractMesh(p: CratePrim, transform: Mat4): UsdMesh | null {
  const rawPoints  = p.attrs.get("points")            as [number,number,number][] | undefined;
  const rawCounts  = p.attrs.get("faceVertexCounts")  as number[] | undefined;
  const rawIndices = p.attrs.get("faceVertexIndices") as number[] | undefined;

  if (!rawPoints || !rawCounts || !rawIndices) return null;

  const points           = new Float32Array(rawPoints.flatMap(v => v));
  const faceVertexCounts = new Int32Array(rawCounts);
  const faceVertexIndices = new Int32Array(rawIndices);

  let normals: Float32Array | undefined;
  const rawN = (p.attrs.get("normals") ?? p.attrs.get("primvars:normals")) as [number,number,number][] | undefined;
  if (rawN) normals = new Float32Array(rawN.flatMap(v => v));

  let uvs: Float32Array | undefined;
  let uvIndices: Int32Array | undefined;
  const rawUV = (p.attrs.get("primvars:st") ?? p.attrs.get("primvars:uv")) as [number,number][] | undefined;
  if (rawUV) {
    uvs = new Float32Array(rawUV.flatMap(v => v));
    const rawUVIdx = p.attrs.get("primvars:st:indices") as number[] | undefined;
    if (rawUVIdx) uvIndices = new Int32Array(rawUVIdx);
  }

  const binding = p.attrs.get("material:binding") as string | undefined;
  const materialPath = binding?.replace(/^<|>$/g, "");
  const name = p.path.split("/").pop() ?? "mesh";

  return { name, transform, points, faceVertexCounts, faceVertexIndices, normals, uvs, uvIndices, materialPath };
}

function extractMaterial(p: CratePrim): UsdMaterial | null {
  let baseColor: Vec4 = { x: 0.8, y: 0.8, z: 0.8, w: 1.0 };
  let metallic  = 0.0;
  let roughness = 0.5;
  let diffuseTexturePath: string | undefined;

  function walkShaders(s: CratePrim): void {
    const id = s.attrs.get("info:id") as string | undefined;
    if (id === "UsdPreviewSurface") {
      const dc = s.attrs.get("inputs:diffuseColor") as [number,number,number] | undefined;
      if (dc) baseColor = { x: dc[0], y: dc[1], z: dc[2], w: 1.0 };
      const m = s.attrs.get("inputs:metallic") as number | undefined;
      if (m !== undefined) metallic = m;
      const rr = s.attrs.get("inputs:roughness") as number | undefined;
      if (rr !== undefined) roughness = rr;
    }
    if (id === "UsdUVTexture") {
      const file = s.attrs.get("inputs:file") as string | undefined;
      if (file) diffuseTexturePath = file.replace(/^@|@$/g, "");
    }
    for (const c of s.children) walkShaders(c);
  }
  walkShaders(p);

  const name = p.path.split("/").pop() ?? "material";
  return { name, primPath: p.path, baseColor, metallic, roughness, diffuseTexturePath };
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function parseUSDC(buffer: Uint8Array, assets: Map<string, Uint8Array>): UsdScene {
  if (buffer.length < 8) throw new Error("USDC: file too small");

  const magic = new TextDecoder().decode(buffer.subarray(0, 8));
  if (magic !== MAGIC) throw new Error(`USDC: bad magic "${magic}" — expected "${MAGIC}"`);

  const r = new Reader(buffer);

  const sections = readSections(r);

  const tokenSec    = getSection(sections, "TOKENS");
  const stringSec   = getSection(sections, "STRINGS");
  const fieldSec    = getSection(sections, "FIELDS");
  const fieldSetSec = getSection(sections, "FIELDSETS");
  const specSec     = getSection(sections, "SPECS");
  const pathSec     = getSection(sections, "PATHS");

  if (!tokenSec || !fieldSec || !fieldSetSec || !specSec || !pathSec) {
    throw new Error("USDC: missing required section(s) — file may be corrupt or unsupported version");
  }

  const tokens    = readTokens(r, tokenSec);
  const strings   = stringSec ? readStrings(r, stringSec, tokens) : [];
  const fields    = readFields(r, fieldSec);
  const fieldSets = readFieldSets(r, fieldSetSec);
  const specs     = readSpecs(r, specSec);
  const paths     = readPaths(r, pathSec, tokens);
  const pathStrings = paths.map(p => p.path);

  const prims = buildPrimTree(specs, pathStrings, fieldSets, fields, tokens, strings, r);

  return extractScene(prims, assets);
}
