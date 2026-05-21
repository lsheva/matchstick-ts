/**
 * AssemblyScript test-driver bundle.
 *
 * This file is compiled by `scripts/build-driver.mjs` into a wasm that
 * contains:
 *   - graph-ts (host bindings + AS impls)
 *   - the example subgraph's handlers (cross-package import below)
 *   - the exported `fire*` builders below, which JS calls to dispatch
 *     events into the handlers
 *
 * Step 3a scope: prove cross-package imports compile and the bundle
 * instantiates. Step 3b will add real `fireSignedValueSet(...)` that
 * constructs an `ethereum.Event` natively in AS and calls the handler.
 *
 * The reason this lives in `packages/wasm-runner/assembly` (not in
 * `packages/example/`) is that the long-term plan compiles ONE test
 * bundle per indexer-under-test, owned by the runner, not by the
 * indexer. Every indexer gets the same builder surface by linking the
 * same wasm-runner AS code with its own handlers.
 */

// Cross-package import: proves `baseDir` + relative path resolution
// works at compile time. We don't call the handlers in Step 3a — just
// reference them so asc has to type-check the import.
import {
  handleSignedValueSet,
  handleValueSet,
} from "../../example/src/mapping";

// Same-package import via the `libs` -> node_modules resolution path.
// Proves graph-ts is reachable from this entry point.
import { BigInt } from "@graphprotocol/graph-ts";

/**
 * Smoke export: round-trips a u32 through graph-ts's `BigInt.fromU32`.
 * Tests call this to confirm the compiled wasm wired graph-ts in
 * correctly. Returns a pointer to an AS-managed BigInt (= Uint8Array of
 * signed LE bytes) which JS reads via the loader's `__getUint8Array`.
 */
export function bigIntFromU32(value: u32): BigInt {
  return BigInt.fromU32(value);
}

/**
 * Returns 1 if both handler symbols resolved during AS compilation.
 * If the cross-package import had silently been a no-op (e.g. asc
 * couldn't find mapping.ts), the references below would have failed
 * to compile.
 *
 * Cast to `usize` is necessary because handler functions don't have
 * a meaningful boolean projection in AS; we just need expressions that
 * force the symbols to be live so they're not tree-shaken before we
 * use them in Step 3b.
 */
export function handlerSymbolsLinked(): i32 {
  const aLinked = changetype<usize>(handleSignedValueSet) != 0;
  const bLinked = changetype<usize>(handleValueSet) != 0;
  return aLinked && bLinked ? 1 : 0;
}
