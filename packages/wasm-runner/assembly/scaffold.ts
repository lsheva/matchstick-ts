/**
 * AssemblyScript scaffold module (formerly `test-driver.ts`).
 *
 * This file is compiled by `buildBundle()` (see `src/build.ts`) as ONE
 * of the asc entry inputs; the other is the consumer indexer's handler
 * entry file (the file referenced by `subgraph.yaml`'s `mapping.file`,
 * e.g. `src/futures.ts` for futures-marketplace or `src/mapping.ts` for
 * the example). asc merges the exports of the two entries into a
 * single wasm:
 *
 *   - From the indexer:  `handleX(eventPtr)` per event handler.
 *   - From this file:    `newMockEvent(paramsPtr)`, `bigIntFromU32()`,
 *                        and the AS runtime / RTTI / TypeId surface
 *                        pulled in transitively by graph-ts.
 *
 * The scaffold is intentionally indexer-agnostic — no `import` of any
 * user mapping file lives here. That's what makes the runner work
 * against arbitrary subgraphs without recompiling itself.
 *
 * `Block`/`Transaction`/`Receipt`/`Log` defaults are inlined here
 * (rather than pulled in from `matchstick-as/assembly/defaults`) so
 * the runner has zero dep on matchstick-as and the field shapes evolve
 * in lockstep with graph-ts's chain types in one place.
 *
 * Store strategy: graph-ts's `store.get`/`store.set` remain host
 * imports (the plan's "Variant A"). The JS host shim
 * (`src/host.ts`) captures every `store.set` call into a JS-side map
 * and reads entity bytes out of wasm memory for the snapshot.
 */

import {
  Address,
  BigInt,
  Bytes,
  Wrapped,
  ethereum,
} from "@graphprotocol/graph-ts";

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
 * codegen-emitted subclasses of `ethereum.Event` are byte-identical to
 * the base class.
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
 * Build an `ethereum.Block` whose core fields (number, timestamp,
 * hash) come from the caller; everything else falls back to
 * `defaultBlock()`. The three core fields are what handlers actually
 * read in practice (`event.block.number` / `.timestamp` / `.hash`),
 * so this gets us realistic per-event block context without forcing
 * JS to allocate every Block field by hand.
 *
 * Caller passes pre-allocated graph-ts `BigInt` / `Bytes` ptrs (the
 * JS host builds those via `EventBuilder.bigInt(...)` /
 * `bytesPayload(...)`).
 */
export function newCoreBlock(
  numberPtr: usize,
  timestampPtr: usize,
  hashPtr: usize,
): ethereum.Block {
  const blk = defaultBlock();
  blk.number = changetype<BigInt>(numberPtr);
  blk.timestamp = changetype<BigInt>(timestampPtr);
  blk.hash = changetype<Bytes>(hashPtr);
  return blk;
}

/**
 * Like `newMockEvent` but lets the caller swap in a pre-built block,
 * a transaction hash, and a logIndex. `blockPtr` may come from
 * `newCoreBlock` (above) or any caller-allocated `ethereum.Block`.
 *
 * `transactionHashPtr` and `logIndexPtr` accept 0 to keep the
 * defaults — useful when only the block context matters.
 */
export function newMockEventWithBlock(
  paramsPtr: usize,
  blockPtr: usize,
  transactionHashPtr: usize,
  logIndexPtr: usize,
  addressPtr: usize,
): ethereum.Event {
  const params = changetype<Array<ethereum.EventParam>>(paramsPtr);
  const evt = newMockEventWithParams(params);
  if (blockPtr != 0) {
    evt.block = changetype<ethereum.Block>(blockPtr);
  }
  if (transactionHashPtr != 0) {
    evt.transaction.hash = changetype<Bytes>(transactionHashPtr);
  }
  if (logIndexPtr != 0) {
    evt.logIndex = changetype<BigInt>(logIndexPtr);
  }
  if (addressPtr != 0) {
    evt.address = changetype<Address>(addressPtr);
  }
  return evt;
}

/**
 * Smoke export: round-trips a u32 through graph-ts's `BigInt.fromU32`.
 * Lives here so the build smoke-test (`tests/bundle-build.test.ts`)
 * has a graph-ts call it can prove went round-trip without depending
 * on any handler being exported by the bundle.
 */
export function bigIntFromU32(value: u32): BigInt {
  return BigInt.fromU32(value);
}

/**
 * Smoke export for the `ethereum.call` -> RpcClient async path.
 *
 * Builds a `SmartContractCall` against `addressPtr` for `signaturePtr`
 * (a graph-cli compact signature like `"balanceOf(address):(uint256)"`)
 * with one address arg `argAddrPtr`, invokes `ethereum.call`, and
 * returns the first BigInt of the result (or `BigInt(0)` on revert).
 *
 * The test asserts on:
 *   - the host's captured `ethCalls` (proves arg encoding worked),
 *   - the BigInt this export returns (proves the host correctly
 *     decoded the canned RPC response into an `ethereum.Value` and
 *     handed it back to wasm via the asyncify rewind path).
 */
export function smokeEthCallReadUint(
  addressPtr: usize,
  signaturePtr: usize,
  argAddrPtr: usize,
): BigInt {
  const addr = changetype<Address>(addressPtr);
  const sig = changetype<string>(signaturePtr);
  const argAddr = changetype<Address>(argAddrPtr);
  const params: Array<ethereum.Value> = [
    ethereum.Value.fromAddress(argAddr),
  ];
  const call = new ethereum.SmartContractCall(
    "Smoke",
    addr,
    "fn",
    sig,
    params,
  );
  const result = ethereum.call(call);
  if (result === null) {
    return BigInt.fromI32(0);
  }
  return result[0].toBigInt();
}

/**
 * The one indexer-agnostic builder export. JS allocates the
 * `Array<ethereum.EventParam>` (via `__newArray` over AS-allocated
 * `EventParam` ptrs, each wrapping an AS-allocated `ethereum.Value`)
 * and hands the pointer in. We wrap it in a default scaffold of
 * Block / Transaction / Receipt / Address / logIndex etc. and hand
 * back the `ethereum.Event` ptr.
 *
 * Subclasses of `ethereum.Event` (codegen's `OrderCreated`,
 * `SignedValueSet`, ...) are byte-identical to the base — JS / the
 * handler just `changetype<SubclassEvent>` the pointer it gets back.
 */
export function newMockEvent(paramsPtr: usize): ethereum.Event {
  const params = changetype<Array<ethereum.EventParam>>(paramsPtr);
  return newMockEventWithParams(params);
}
