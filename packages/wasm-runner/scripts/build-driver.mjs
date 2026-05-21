#!/usr/bin/env node
/**
 * Invoke `asc` (the AssemblyScript compiler) on assembly/test-driver.ts
 * with the same flags `graph-cli`'s subgraph build uses, so the output
 * wasm matches the runtime conventions of a real subgraph build:
 *
 *   --explicitStart   // exported `_start` that JS calls (not auto)
 *   --exportRuntime   // expose __new / __pin / __unpin / __collect
 *   --runtime stub    // stub GC: bump allocator + manual __pin tracking
 *   --optimize        // run binaryen optimizer (matches `graph build`)
 *
 * The `--lib` paths give asc node_modules locations to resolve package
 * imports (`@graphprotocol/graph-ts`); `--baseDir` is where relative
 * imports resolve from (so `../../example/src/mapping` reaches the
 * example indexer's handlers).
 *
 * Reference: how graph-cli does it
 *   node_modules/.../graphprotocol/graph-cli/dist/compiler/asc.js
 *   node_modules/.../graphprotocol/graph-cli/dist/compiler/index.js  (libs/baseDir/global wiring)
 */
import * as asc from "assemblyscript/cli/asc";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");

// baseDir = packages/wasm-runner — relative imports from test-driver.ts
// resolve against this, so `../../example/src/mapping` ends up at
// packages/example/src/mapping.ts.
const baseDir = pkgRoot;

// graph-cli walks parent directories looking for any `node_modules` and
// passes them all to asc as `--lib`. We do the same so asc finds
// @graphprotocol/graph-ts no matter whether it lives in this package's
// node_modules or the workspace root's.
const libsDirs = [];
{
  let dir = pkgRoot;
  // Stop once we hit the filesystem root.
  while (dir !== dirname(dir)) {
    const candidate = join(dir, "node_modules");
    if (existsSync(candidate)) libsDirs.push(candidate);
    dir = dirname(dir);
  }
}
if (libsDirs.length === 0) {
  throw new Error(
    `build-driver: could not locate any node_modules in parents of ${pkgRoot}`,
  );
}

// `global.ts` is graph-ts's AS globals file (declares `i32`, `usize`,
// `idof<T>()`, etc.). asc takes it as a positional entry to seed the
// compilation. We resolve via libsDirs so we don't hardcode a specific
// pnpm node_modules layout.
const globalsRelPath = join(
  "@graphprotocol",
  "graph-ts",
  "global",
  "global.ts",
);
const globalsLib = libsDirs.find((d) => existsSync(join(d, globalsRelPath)));
if (!globalsLib) {
  throw new Error(
    `build-driver: could not locate @graphprotocol/graph-ts/global/global.ts under any of: ${libsDirs.join(", ")}`,
  );
}
const globalAbs = join(globalsLib, globalsRelPath);
const globalRel = relative(baseDir, globalAbs);

const inputFile = relative(baseDir, join(pkgRoot, "assembly", "test-driver.ts"));
const outDir = join(pkgRoot, "build");
mkdirSync(outDir, { recursive: true });
const outputFile = relative(baseDir, join(outDir, "test-driver.wasm"));

console.log(`build-driver: compiling ${inputFile} -> ${outputFile}`);
console.log(`  baseDir: ${baseDir}`);
console.log(`  globals: ${globalRel}`);
console.log(`  libs:    ${libsDirs.length} dir(s)`);

// `asc.ready` must be awaited once before calling asc.main — it loads
// the binaryen WebAssembly module that powers the compiler.
await asc.ready;

const args = [
  "--explicitStart",
  "--exportRuntime",
  "--runtime",
  "stub",
  inputFile,
  globalRel,
  "--baseDir",
  baseDir,
  "--lib",
  libsDirs.join(","),
  "--outFile",
  outputFile,
  "--optimize",
  "--debug",
];

asc.main(args, { stdout: process.stdout, stderr: process.stderr }, (err) => {
  if (err) {
    console.error("build-driver: asc failed");
    console.error(err);
    process.exit(1);
  }
  console.log(`build-driver: wrote ${join(baseDir, outputFile)}`);
});
