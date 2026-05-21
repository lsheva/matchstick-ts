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
 * The reason this lives in `packages/wasm-runner/assembly` (not in
 * `packages/example/`) is that the long-term plan compiles ONE test
 * bundle per indexer-under-test, owned by the runner, not by the
 * indexer. Every indexer gets the same builder surface by linking the
 * same wasm-runner AS code with its own handlers.
 *
 * Store strategy in Step 3b: we leave graph-ts's `store.get`/`store.set`
 * as host imports (the default). The JS host shim captures every
 * `store.set` call into a JS-side map and reads bytes out of wasm
 * memory for the snapshot. This is the plan's "Variant A" — pragmatic
 * for the spike. Variant B (in-wasm store) is a later step.
 */

// Cross-package import: proves `baseDir` + relative path resolution
// works at compile time. Step 3b actually invokes one of these.
import {
  handleSignedValueSet,
  handleValueSet,
} from "../../example/src/mapping";

import {
  Address,
  BigInt,
  Bytes,
  Wrapped,
  ethereum,
} from "@graphprotocol/graph-ts";
import { SignedValueSet } from "../../example/generated/Counter/Counter";

// ---------------------------------------------------------------------------
// Mock-event defaults
//
// Copied (with small edits) from matchstick-as 0.6.0
// `assembly/defaults.ts`. Inlining avoids a runtime dep on the
// deprecated `matchstick-as` package and gives us a single place to
// evolve the defaults as graph-ts's `ethereum.Block` / `Transaction`
// field shapes change.
//
// All defaults are intentionally minimal — they exist so `new
// ethereum.Event(...)` has non-null reference fields. Handlers that
// don't read these fields don't care about the values.
// ---------------------------------------------------------------------------

const DEFAULT_ADDRESS: Address = Address.fromString(
  "0xA16081F360e3847006dB660bae1c6d1b2e17eC2A",
);
const DEFAULT_ADDRESS_BYTES: Bytes = changetype<Bytes>(DEFAULT_ADDRESS);
const DEFAULT_BIG_INT: BigInt = BigInt.fromI32(1);
const DEFAULT_INT_BYTES: Bytes = Bytes.fromI32(1);
const DEFAULT_LOG_TYPE: string = "default_log_type";

function defaultBlock(): ethereum.Block {
  return new ethereum.Block(
    DEFAULT_ADDRESS_BYTES,
    DEFAULT_ADDRESS_BYTES,
    DEFAULT_ADDRESS_BYTES,
    DEFAULT_ADDRESS,
    DEFAULT_ADDRESS_BYTES,
    DEFAULT_ADDRESS_BYTES,
    DEFAULT_ADDRESS_BYTES,
    DEFAULT_BIG_INT,
    DEFAULT_BIG_INT,
    DEFAULT_BIG_INT,
    DEFAULT_BIG_INT,
    DEFAULT_BIG_INT,
    DEFAULT_BIG_INT,
    DEFAULT_BIG_INT,
    DEFAULT_BIG_INT,
  );
}

function defaultTransaction(): ethereum.Transaction {
  return new ethereum.Transaction(
    DEFAULT_ADDRESS_BYTES,
    DEFAULT_BIG_INT,
    DEFAULT_ADDRESS,
    DEFAULT_ADDRESS,
    DEFAULT_BIG_INT,
    DEFAULT_BIG_INT,
    DEFAULT_BIG_INT,
    DEFAULT_ADDRESS_BYTES,
    DEFAULT_BIG_INT,
  );
}

function defaultLog(): ethereum.Log {
  return new ethereum.Log(
    DEFAULT_ADDRESS,
    [DEFAULT_ADDRESS_BYTES],
    DEFAULT_ADDRESS_BYTES,
    DEFAULT_ADDRESS_BYTES,
    DEFAULT_INT_BYTES,
    DEFAULT_ADDRESS_BYTES,
    DEFAULT_BIG_INT,
    DEFAULT_BIG_INT,
    DEFAULT_BIG_INT,
    DEFAULT_LOG_TYPE,
    new Wrapped<boolean>(false),
  );
}

function defaultReceipt(): ethereum.TransactionReceipt {
  return new ethereum.TransactionReceipt(
    DEFAULT_ADDRESS_BYTES,
    DEFAULT_BIG_INT,
    DEFAULT_ADDRESS_BYTES,
    DEFAULT_BIG_INT,
    DEFAULT_BIG_INT,
    DEFAULT_BIG_INT,
    DEFAULT_ADDRESS,
    [defaultLog()],
    DEFAULT_BIG_INT,
    DEFAULT_ADDRESS_BYTES,
    DEFAULT_ADDRESS_BYTES,
  );
}

/**
 * Build a fully-populated `ethereum.Event` with the given `parameters`.
 * Caller may `changetype<SubclassEvent>(...)` the result — graph-ts
 * subclasses of `ethereum.Event` are byte-identical to the base class.
 */
function newMockEventWithParams(
  params: Array<ethereum.EventParam>,
): ethereum.Event {
  return new ethereum.Event(
    DEFAULT_ADDRESS,
    DEFAULT_BIG_INT,
    DEFAULT_BIG_INT,
    DEFAULT_LOG_TYPE,
    defaultBlock(),
    defaultTransaction(),
    params,
    defaultReceipt(),
  );
}

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
 * Kept as a sanity check that asc tree-shaking didn't strip the
 * cross-package imports after Step 3a.
 */
export function handlerSymbolsLinked(): i32 {
  const aLinked = changetype<usize>(handleSignedValueSet) != 0;
  const bLinked = changetype<usize>(handleValueSet) != 0;
  return aLinked && bLinked ? 1 : 0;
}

/**
 * Step 3b dispatch entry point.
 *
 * JS allocates a `Uint8Array` containing the signed LE bytes of the
 * intended `newValue` (which is how graph-ts's `BigInt` is laid out),
 * pins it, and hands the pointer in. We unwrap to a `BigInt`, wrap in
 * the matchstick-as mock event with our single param, and dispatch to
 * the user's handler.
 *
 * The cast `changetype<BigInt>(uint8array)` is the standard graph-ts
 * idiom — `BigInt` is just `class BigInt extends Uint8Array`, so any
 * `Uint8Array` pointer is byte-identical to a `BigInt` pointer. We pass
 * by pointer (not value) because JS already allocated the bytes; doing
 * the allocation AS-side would require shipping the raw bytes via
 * another channel and is no simpler.
 */
export function fireSignedValueSet(newValueBytesPtr: usize): void {
  const bytes = changetype<Uint8Array>(newValueBytesPtr);
  const newValue = changetype<BigInt>(bytes);

  const params = new Array<ethereum.EventParam>(1);
  params[0] = new ethereum.EventParam(
    "newValue",
    ethereum.Value.fromSignedBigInt(newValue),
  );

  const event = changetype<SignedValueSet>(newMockEventWithParams(params));
  handleSignedValueSet(event);
}
