# Contributing to usdz-to-glb

Thank you for your interest in contributing! This document covers everything you need to get up and running.

---

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)

---

## Development Setup

**Requirements:** Node.js ≥ 18, npm ≥ 9

```bash
git clone https://github.com/energyi/usdz-to-glb.git
cd usdz-to-glb
npm install
npm run build
```

To rebuild automatically while editing:

```bash
npm run dev
```

---

## Project Structure

```
src/
  index.ts             — Public API surface (convertUsdzToGlb)
  parsers/
    usdz.ts            — ZIP archive unpacker
    usda.ts            — USDA (ASCII text) parser + tokenizer
    usdc.ts            — USDC (binary crate) parser
    usd-types.ts       — Shared TypeScript types
    inflate.ts         — DEFLATE wrapper (Node.js zlib)
  utils/
    lz4.ts             — Pure-JS LZ4 block decompressor
  builders/
    glb.ts             — glTF 2.0 / GLB binary builder
bin/
  usdz-to-glb.js       — CLI (requires dist/ to be built)
test/                  — Node.js built-in test runner (*.test.js)
```

---

## Making Changes

1. **Fork** the repository and create a branch from `main`:
   ```bash
   git checkout -b fix/my-bug-fix
   ```
2. **Edit** TypeScript sources in `src/`.
3. **Build** to check for compile errors:
   ```bash
   npm run build
   ```
4. **Test** your changes (see [Testing](#testing)).
5. Commit with a clear, concise message:
   ```
   fix(usdc): handle varint overflow for large token tables
   feat(glb): preserve mesh names in GLTF output
   ```

### Code style

- TypeScript strict mode is enabled — all types must be explicit.
- No external runtime dependencies. Everything must work with Node.js built-ins only.
- Keep functions small and single-purpose. Prefer pure functions where possible.
- Comment non-obvious binary parsing logic with references to the relevant spec section.

---

## Testing

Tests live in `test/` and use Node.js's built-in test runner (no extra dependencies).

```bash
npm test
```

When adding a bug fix or new feature, please include a corresponding test. If you need sample `.usdz` files to test against, small minimal-reproduction files are preferred over large real-world models.

---

## Submitting a Pull Request

1. Ensure `npm run build` and `npm test` both pass.
2. Open a PR against the `main` branch.
3. Fill in the pull request template — describe what changed and why.
4. One of the maintainers will review and merge.

---

## Reporting Bugs

Please open a [GitHub Issue](https://github.com/energyi/usdz-to-glb/issues/new?template=bug_report.md) and include:

- The usdz-to-glb version (`npm list usdz-to-glb`)
- Node.js version (`node --version`)
- A minimal repro: the smallest `.usdz` file (or description of its structure) that triggers the issue
- The full error output

---

## Requesting Features

Open a [GitHub Issue](https://github.com/energyi/usdz-to-glb/issues/new?template=feature_request.md) describing the USD feature or workflow you need and why. PRs implementing new features are welcome — please open an issue first so we can discuss the design before you invest time writing code.
