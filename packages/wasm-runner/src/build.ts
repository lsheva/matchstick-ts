/**
 * `buildBundle` — compile a per-indexer wasm bundle suitable for the
 * runner.
 *
 * The output is the concatenation (via multi-entry asc compilation) of:
 *   - `packages/wasm-runner/assembly/scaffold.ts` — indexer-agnostic
 *     defaults + `newMockEvent(paramsPtr)` builder
 *   - the consumer indexer's mapping entry file — typically the file
 *     `subgraph.yaml` references at `dataSources[].mapping.file`, which
 *     re-exports every `handleX` function. asc merges both entries'
 *     exports into the resulting wasm.
 *
 * Why a custom builder rather than `graph build`:
 *   `graph build` produces one wasm per data source, expects a
 *   subgraph.yaml, runs codegen, etc. We want a single wasm with our
 *   scaffold linked in, and we want it triggerable from a test. asc
 *   itself is small (a few hundred ms warm) and exposes the same flags
 *   graph-cli uses internally — we can call it directly.
 *
 * Flag rationale (matches graph-cli's defaults, plus our scaffold needs):
 *   --explicitStart   exported `_start` JS calls after instantiate;
 *                     required so graph-ts's top-level initializers
 *                     run (see `runner.ts` for why this matters).
 *   --exportRuntime   exposes `__new`/`__pin`/`__unpin`/`__collect`,
 *                     consumed by `@assemblyscript/loader`.
 *   --runtime stub    bump allocator, no GC — same as graph-cli, keeps
 *                     pointers stable for the lifetime of the instance.
 *   --optimize        binaryen optimization, matches `graph build`.
 *   --debug           keeps `env.abort` arguments wired so JS errors
 *                     report AS file/line.
 */
import * as asc from "assemblyscript/cli/asc";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

/**
 * Input for `buildBundle`. `handlerEntry` must be an absolute path (or
 * relative-to-cwd) to a `.ts` file that re-exports all `handleX`
 * functions you want callable on the produced wasm. `outPath` is where
 * the compiled `.wasm` is written; the parent directory is created as
 * needed.
 */
export interface BuildBundleOptions {
  handlerEntry: string;
  outPath: string;
  /**
   * When true (default), pass `--debug` to asc so `env.abort` carries
   * source file/line info. Set false for a smaller / faster bundle if
   * you're sure no handler will abort.
   */
  debug?: boolean;
  /**
   * Optional override for the asc `--baseDir`. Defaults to the
   * common ancestor of `handlerEntry` and the scaffold file. asc
   * resolves relative imports inside each entry file from that file's
   * own directory, so `baseDir` only matters for the positional CLI
   * arguments we pass.
   */
  baseDir?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
/** Absolute path to `packages/wasm-runner/`. */
const PKG_ROOT = resolve(here, "..");
/** Absolute path to the shared scaffold AS file. */
const SCAFFOLD_PATH = join(PKG_ROOT, "assembly", "scaffold.ts");

/**
 * Walk up from `start` collecting every `node_modules` directory we
 * find. asc's `--lib` accepts a comma-list of these; the more we pass,
 * the more chance it has to resolve `@graphprotocol/graph-ts` no
 * matter which package manager / hoisting strategy is in play.
 */
function collectNodeModulesAncestors(start: string): string[] {
  const out: string[] = [];
  let dir = start;
  while (dir !== dirname(dir)) {
    const candidate = join(dir, "node_modules");
    if (existsSync(candidate)) out.push(candidate);
    dir = dirname(dir);
  }
  return out;
}

/**
 * Locate `@graphprotocol/graph-ts/global/global.ts` under one of the
 * `--lib` dirs. asc takes it as a positional input (separately from
 * the resolver), because it sets up the AS-level globals (`i32`,
 * `usize`, `idof<T>()`, the `TypeId` enum, etc.) that the rest of
 * graph-ts relies on.
 */
function findGraphTsGlobals(libDirs: readonly string[]): string {
  const relPath = join(
    "@graphprotocol",
    "graph-ts",
    "global",
    "global.ts",
  );
  for (const libDir of libDirs) {
    const candidate = join(libDir, relPath);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `buildBundle: could not locate @graphprotocol/graph-ts/global/global.ts under any of: ${libDirs.join(", ")}`,
  );
}

export async function buildBundle(opts: BuildBundleOptions): Promise<void> {
  const handlerEntry = resolve(opts.handlerEntry);
  const outPath = resolve(opts.outPath);
  if (!existsSync(handlerEntry)) {
    throw new Error(
      `buildBundle: handlerEntry not found: ${handlerEntry}`,
    );
  }
  if (!existsSync(SCAFFOLD_PATH)) {
    throw new Error(
      `buildBundle: scaffold missing at ${SCAFFOLD_PATH} — wasm-runner package is corrupt`,
    );
  }

  // Search starting from the indexer entry first, then from our own
  // package, so consumer-local deps win over our own pinned versions.
  // (Both directories typically end up pointing at the same hoisted
  // copy under pnpm, but being explicit avoids surprises in projects
  // with overrides.)
  const libDirs = [
    ...collectNodeModulesAncestors(dirname(handlerEntry)),
    ...collectNodeModulesAncestors(PKG_ROOT),
  ];
  // De-duplicate while preserving order: same directory appears in
  // both walks for sibling packages.
  const dedup: string[] = [];
  const seen = new Set<string>();
  for (const d of libDirs) {
    if (!seen.has(d)) {
      seen.add(d);
      dedup.push(d);
    }
  }
  if (dedup.length === 0) {
    throw new Error(
      `buildBundle: no node_modules found in ancestors of ${handlerEntry} or ${PKG_ROOT}`,
    );
  }

  const globalsAbs = findGraphTsGlobals(dedup);
  const baseDir = opts.baseDir ?? PKG_ROOT;

  mkdirSync(dirname(outPath), { recursive: true });

  // asc accepts mixed absolute / relative paths but the CLI is fragile
  // with absolute Windows-style paths; we keep them relative to
  // `baseDir` for compatibility with graph-cli's convention.
  const rel = (p: string) => relative(baseDir, p);
  const args = [
    "--explicitStart",
    "--exportRuntime",
    "--runtime",
    "stub",
    rel(SCAFFOLD_PATH),
    rel(handlerEntry),
    rel(globalsAbs),
    "--baseDir",
    baseDir,
    "--lib",
    dedup.join(","),
    "--outFile",
    rel(outPath),
    "--optimize",
  ];
  if (opts.debug !== false) args.push("--debug");

  // `asc.ready` lazily compiles the binaryen WebAssembly module that
  // backs the optimizer. Awaited once per process by the first call.
  await asc.ready;

  await new Promise<void>((resolveBuild, rejectBuild) => {
    asc.main(
      args,
      { stdout: process.stdout, stderr: process.stderr },
      (err: Error | null): number => {
        if (err) rejectBuild(err);
        else resolveBuild();
        return err ? 1 : 0;
      },
    );
  });
}
