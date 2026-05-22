#!/usr/bin/env node
/**
 * CLI wrapper for `buildBundle` (programmatic API in `src/build.ts`).
 *
 * Usage:
 *   node scripts/build-bundle.mjs \
 *     --handler-entry ../example/src/mapping.ts \
 *     --out          build/example-bundle.wasm \
 *     [--no-debug]
 *
 * Paths are resolved relative to the current working directory.
 *
 * `pnpm pretest` invokes this with the example indexer's mapping
 * entry, producing the bundle the test suite drives. Consumer
 * indexers (futures-marketplace etc.) call `buildBundle` directly
 * from their own setup code — there's no need to shell out.
 */
import { buildBundle } from "../src/build.ts";
import { resolve } from "node:path";

function parseArgs(argv) {
  const out = { handlerEntry: null, outPath: null, debug: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--handler-entry") {
      out.handlerEntry = argv[++i];
    } else if (arg === "--out") {
      out.outPath = argv[++i];
    } else if (arg === "--no-debug") {
      out.debug = false;
    } else {
      throw new Error(`build-bundle: unknown arg \`${arg}\``);
    }
  }
  if (!out.handlerEntry) {
    throw new Error("build-bundle: --handler-entry <path> required");
  }
  if (!out.outPath) {
    throw new Error("build-bundle: --out <path> required");
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const handlerEntry = resolve(process.cwd(), opts.handlerEntry);
const outPath = resolve(process.cwd(), opts.outPath);
console.log(`build-bundle: ${handlerEntry} -> ${outPath}`);

try {
  await buildBundle({
    handlerEntry,
    outPath,
    debug: opts.debug,
  });
  console.log(`build-bundle: wrote ${outPath}`);
} catch (err) {
  console.error("build-bundle: failed");
  console.error(err);
  process.exit(1);
}
