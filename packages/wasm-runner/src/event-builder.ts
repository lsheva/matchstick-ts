/**
 * JS-side event-builder: allocate an `ethereum.Event` in wasm memory
 * from JS, hand its pointer to a user handler export, no per-handler AS
 * wrapper required.
 *
 * The split with the AS test-driver:
 *   - JS allocates: `ethereum.Value`, `ethereum.EventParam`,
 *     `Array<EventParam>`, and the inner BigInt payload bytes. These
 *     are the per-event pieces that vary case-to-case.
 *   - AS allocates: the Block / Transaction / Receipt / Log / Address
 *     scaffold (`newMockEvent` in `assembly/test-driver.ts`). These are
 *     30+ fields that are constant for tests — keeping them AS-side
 *     means JS doesn't need an encoder for every chain primitive.
 *
 * Class IDs come from the wasm's `TypeId.*` exports (RTTI), not
 * hardcoded — so the bundle is free to change asc versions without
 * breaking the builder.
 *
 * Pinning: under `--runtime stub` (graph-cli's default, ours too)
 * `__pin` is a no-op — the bump allocator never reclaims, so pointers
 * stay live for the lifetime of the instance. We still call `__pin` on
 * the values JS holds across multiple `__new` calls so this code keeps
 * working if/when we ever switch to `--runtime incremental`.
 *
 * Value-kind tags below mirror graph-ts's `ethereum.ValueKind` enum
 * (`chain/ethereum.ts`, 0.37.0). The handler-side `Value.toBigInt()`
 * accepts both `INT` and `UINT`, so signed/unsigned dispatch differs
 * only in the tag, not the payload encoding.
 */
import type { InstanceExports } from "./runner.ts";

/** ethereum.ValueKind tags (chain/ethereum.ts in graph-ts). */
export const EthValueKind = {
  ADDRESS: 0,
  FIXED_BYTES: 1,
  BYTES: 2,
  INT: 3,
  UINT: 4,
  BOOL: 5,
  STRING: 6,
  FIXED_ARRAY: 7,
  ARRAY: 8,
  TUPLE: 9,
} as const;
export type EthValueKind = (typeof EthValueKind)[keyof typeof EthValueKind];

/**
 * Extra exports the event-builder expects from the AS test-driver
 * bundle. Production subgraph wasms won't have `newMockEvent` — those
 * need a separate path (a later step compiles a hybrid bundle).
 *
 * `id_of_type` is graph-ts's translator from the cross-host
 * `IndexForAscTypeId` enum (the value exported as
 * `TypeId.Uint8Array.value` etc.) to the wasm's actual AS RTTI class
 * id. Without it, `__new` / `__newArray` get the wrong id for
 * subgraph-specific classes (`EventParam`, `ArrayEventParam`,
 * `EthereumValue`) and either trap or silently produce garbage
 * layout. Don't be tempted to use `TypeId.X.value` as the class id
 * directly — most graph-node ids do not equal the asc-assigned ids.
 */
export interface EventBuilderExports extends InstanceExports {
  __newString: (str: string) => number;
  newMockEvent: (paramsPtr: number) => number;
  /** Test-driver export: build an `ethereum.Block` with custom core fields. */
  newCoreBlock?: (
    numberPtr: number,
    timestampPtr: number,
    hashPtr: number,
  ) => number;
  /**
   * Test-driver export: like `newMockEvent` but accepts a pre-built
   * block, optional transaction hash ptr, optional logIndex ptr.
   * Pass `0` for the txHash / logIndex args to keep defaults.
   */
  newMockEventWithBlock?: (
    paramsPtr: number,
    blockPtr: number,
    transactionHashPtr: number,
    logIndexPtr: number,
    addressPtr: number,
  ) => number;
  id_of_type: (graphNodeTypeId: number) => number;
}

/**
 * Per-event runtime context the caller can override on top of the
 * scaffold's defaults. Today only block fields + transaction hash +
 * logIndex are exposed — every other `ethereum.Block` /
 * `ethereum.Transaction` field falls back to the scaffold defaults
 * (the constants in `assembly/scaffold.ts`).
 */
export interface EventContext {
  /** Override `event.address` (the contract that emitted the log). */
  address?: string | Uint8Array;
  block?: {
    number?: bigint;
    timestamp?: bigint;
    hash?: string | Uint8Array;
  };
  transactionHash?: string | Uint8Array;
  logIndex?: bigint;
}

/**
 * Encode a JS `bigint` to graph-ts `BigInt` bytes: two's-complement
 * little-endian. Empty `bigint(0)` is represented as `[0]` (not `[]`)
 * to match the wasm side, which encodes 0 the same way for sign
 * detection during display.
 */
export function encodeSignedBigInt(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array([0]);
  const negative = value < 0n;
  let v = negative ? -(value + 1n) : value;
  const bytes: number[] = [];
  do {
    const b = Number(v & 0xffn);
    bytes.push(negative ? 0xff - b : b);
    v >>= 8n;
  } while (v > 0n);
  const msb = bytes[bytes.length - 1];
  // Pad so the high bit of the most-significant byte encodes the sign.
  if (!negative && (msb & 0x80) !== 0) {
    bytes.push(0x00);
  } else if (negative && (msb & 0x80) === 0) {
    bytes.push(0xff);
  }
  return Uint8Array.from(bytes);
}

/**
 * Builder bound to one wasm instance. Cheap to construct (just caches
 * a couple of class IDs); not stateful across `subgraph.reset()` —
 * always pass the current `subgraph.exports`.
 */
export class EventBuilder {
  private readonly exports: EventBuilderExports;
  /** asc RTTI class id (post `id_of_type` translation) for `Uint8Array`. */
  private readonly cidUint8Array: number;
  /** asc RTTI class id for `ethereum.Value`. */
  private readonly cidEthereumValue: number;
  /** asc RTTI class id for `ethereum.EventParam`. */
  private readonly cidEventParam: number;
  /** asc RTTI class id for `Array<ethereum.EventParam>`. */
  private readonly cidArrayEventParam: number;
  /** asc RTTI class id for `Array<ethereum.Value>`. */
  private readonly cidArrayEthereumValue: number;

  constructor(exports: InstanceExports) {
    const ext = exports as EventBuilderExports;
    // `newMockEvent` is only required by `buildEvent()` (the
    // test-driver bundle exposes it). Other entry points — `address`,
    // `unsignedBigInt`, `array`, ... — work against any subgraph wasm,
    // so the host shim's `ethereum.call` allocator path doesn't need
    // to fail at construction time on a production bundle.
    if (typeof ext.id_of_type !== "function") {
      throw new Error(
        "EventBuilder: wasm is missing the `id_of_type` export — needed to translate graph-node `TypeId.*` ids to asc RTTI class ids",
      );
    }
    this.exports = ext;
    const t = (graphNodeId: number) => ext.id_of_type(graphNodeId);
    this.cidUint8Array = t(exports.TypeId.Uint8Array.value as number);
    this.cidEthereumValue = t(exports.TypeId.EthereumValue.value as number);
    this.cidEventParam = t(exports.TypeId.EventParam.value as number);
    this.cidArrayEventParam = t(
      exports.TypeId.ArrayEventParam.value as number,
    );
    this.cidArrayEthereumValue = t(
      exports.TypeId.ArrayEthereumValue.value as number,
    );
  }

  /**
   * Allocate a graph-ts `BigInt` (= signed LE Uint8Array) holding
   * `value`. Returns the raw pointer; callers usually wrap this in
   * `signedBigInt()` / `unsignedBigInt()` rather than using it directly.
   */
  bigInt(value: bigint): number {
    const ptr = this.exports.__newArray(
      this.cidUint8Array,
      encodeSignedBigInt(value),
    );
    return this.exports.__pin(ptr);
  }

  /**
   * Allocate a graph-ts `Bytes` (= `Uint8Array`, byte-identical layout)
   * holding `bytes`. Used by callers building `Value(BYTES)` /
   * `Value(FIXED_BYTES)` / `Value(ADDRESS)` payloads.
   */
  bytesPayload(bytes: Uint8Array): number {
    return this.exports.__pin(
      this.exports.__newArray(this.cidUint8Array, bytes),
    );
  }

  /** Allocate an `ethereum.Value(kind, dataLo, dataHi)`. */
  private value(kind: EthValueKind, dataLo: number, dataHi = 0): number {
    // ethereum.Value layout (16 bytes):
    //   +0  kind  i32  (ValueKind tag)
    //   +4  padding (alignment for the u64 below)
    //   +8  data  u64  (lo at +8, hi at +12)
    const ptr = this.exports.__new(16, this.cidEthereumValue);
    const u32 = new Uint32Array(this.exports.memory.buffer);
    u32[ptr >>> 2] = kind;
    u32[(ptr + 4) >>> 2] = 0;
    u32[(ptr + 8) >>> 2] = dataLo;
    u32[(ptr + 12) >>> 2] = dataHi;
    return this.exports.__pin(ptr);
  }

  /** `ethereum.Value` of kind=INT wrapping a graph-ts BigInt. */
  signedBigInt(value: bigint): number {
    return this.value(EthValueKind.INT, this.bigInt(value));
  }

  /** `ethereum.Value` of kind=UINT wrapping a graph-ts BigInt. */
  unsignedBigInt(value: bigint): number {
    return this.value(EthValueKind.UINT, this.bigInt(value));
  }

  /**
   * `ethereum.Value` of kind=ADDRESS wrapping a 20-byte `Address`.
   * Accepts either a hex string (with or without `0x` prefix) or a
   * raw `Uint8Array`. Throws if the result is not exactly 20 bytes,
   * which would silently corrupt downstream `Address.toHexString()`
   * etc. once the handler runs.
   */
  address(value: string | Uint8Array): number {
    const bytes = typeof value === "string" ? hexToBytes(value) : value;
    if (bytes.length !== 20) {
      throw new Error(
        `EventBuilder.address: expected 20 bytes, got ${bytes.length}`,
      );
    }
    return this.value(EthValueKind.ADDRESS, this.bytesPayload(bytes));
  }

  /**
   * `ethereum.Value` of kind=BYTES wrapping arbitrary bytes (dynamic
   * length). Use this for solidity `bytes`. For solidity `bytesN`
   * (fixed-length), use `fixedBytes()`.
   */
  bytes(value: string | Uint8Array): number {
    const bytes = typeof value === "string" ? hexToBytes(value) : value;
    return this.value(EthValueKind.BYTES, this.bytesPayload(bytes));
  }

  /**
   * `ethereum.Value` of kind=FIXED_BYTES wrapping fixed-length bytes
   * (solidity `bytes32`, `bytes20`, etc.). Layout is identical to
   * `BYTES`; the kind tag differs so handler code that branches on
   * `value.kind` (e.g. `stringifyParameters`) prints correctly.
   */
  fixedBytes(value: string | Uint8Array): number {
    const bytes = typeof value === "string" ? hexToBytes(value) : value;
    return this.value(EthValueKind.FIXED_BYTES, this.bytesPayload(bytes));
  }

  /** `ethereum.Value` of kind=STRING wrapping an AS string. */
  string(value: string): number {
    const strPtr = this.exports.__pin(this.exports.__newString(value));
    return this.value(EthValueKind.STRING, strPtr);
  }

  /**
   * `ethereum.Value` of kind=BOOL. The payload is encoded directly in
   * `dataLo` (0 / 1) — no separate allocation; `Value.toBoolean()`
   * reads `this.data != 0`.
   */
  bool(value: boolean): number {
    return this.value(EthValueKind.BOOL, value ? 1 : 0);
  }

  /**
   * Allocate an `ethereum.EventParam(name, value)` pair. Both fields
   * are reference types (string ptr + Value ptr) so the struct is 8
   * bytes total.
   */
  param(name: string, valuePtr: number): number {
    const namePtr = this.exports.__pin(this.exports.__newString(name));
    const ptr = this.exports.__new(8, this.cidEventParam);
    const u32 = new Uint32Array(this.exports.memory.buffer);
    u32[ptr >>> 2] = namePtr;
    u32[(ptr + 4) >>> 2] = valuePtr;
    return this.exports.__pin(ptr);
  }

  /** Allocate a `Array<EventParam>` populated with the given param ptrs. */
  params(paramPtrs: readonly number[]): number {
    return this.exports.__pin(
      this.exports.__newArray(this.cidArrayEventParam, paramPtrs as number[]),
    );
  }

  /**
   * Allocate an `Array<ethereum.Value>` populated with the given Value
   * ptrs. Used by `ethereum.call`'s host shim to return the
   * decoded RPC outputs back to the wasm caller, and by `jsToValuePtr`
   * for `T[]` ABI types.
   */
  array(valuePtrs: readonly number[]): number {
    return this.exports.__pin(
      this.exports.__newArray(
        this.cidArrayEthereumValue,
        valuePtrs as number[],
      ),
    );
  }

  /**
   * Allocate an `ethereum.Value` of kind=ARRAY wrapping an
   * `Array<ethereum.Value>` of the supplied element ptrs. Used by
   * `jsToValuePtr` for `T[]` ABI types.
   */
  arrayValue(valuePtrs: readonly number[]): number {
    return this.value(EthValueKind.ARRAY, this.array(valuePtrs));
  }

  /** Like `arrayValue` but tags as FIXED_ARRAY (solidity `T[N]`). */
  fixedArray(valuePtrs: readonly number[]): number {
    return this.value(EthValueKind.FIXED_ARRAY, this.array(valuePtrs));
  }

  /**
   * One-shot: build the params array, wrap it in a default
   * `ethereum.Event` scaffold via the AS export, and return the event
   * pointer. The pointer is suitable for `exports.handleXxx(eventPtr)`
   * (graph-ts subclasses are byte-identical to the base).
   */
  buildEvent(paramPtrs: readonly number[], ctx?: EventContext): number {
    if (typeof this.exports.newMockEvent !== "function") {
      throw new Error(
        "EventBuilder.buildEvent: wasm is missing the `newMockEvent(paramsPtr)` export — only the wasm-runner test-driver bundle exposes the default Block/Transaction scaffolding for now",
      );
    }
    const paramsArrayPtr = this.params(paramPtrs);
    if (!ctx) {
      return this.exports.newMockEvent(paramsArrayPtr);
    }
    if (typeof this.exports.newMockEventWithBlock !== "function") {
      throw new Error(
        "EventBuilder.buildEvent: ctx provided but wasm is missing `newMockEventWithBlock` export — rebuild the bundle against the latest scaffold.ts",
      );
    }
    const blockPtr = this.buildBlockPtr(ctx.block);
    const txHashPtr =
      ctx.transactionHash === undefined
        ? 0
        : this.bytesPayload(toBytes(ctx.transactionHash));
    const logIndexPtr =
      ctx.logIndex === undefined ? 0 : this.bigInt(ctx.logIndex);
    const addressPtr =
      ctx.address === undefined ? 0 : this.bytesPayload(toBytes(ctx.address));
    return this.exports.newMockEventWithBlock(
      paramsArrayPtr,
      blockPtr,
      txHashPtr,
      logIndexPtr,
      addressPtr,
    );
  }

  /**
   * Allocate an `ethereum.Block` with the given core fields. Falls
   * back to the scaffold's `defaultBlock()` for fields not specified.
   * Returns `0` if `block` is undefined or empty so callers can use
   * the result as an optional ptr.
   */
  private buildBlockPtr(block: EventContext["block"]): number {
    if (!block || (block.number === undefined && block.timestamp === undefined && block.hash === undefined)) {
      return 0;
    }
    if (typeof this.exports.newCoreBlock !== "function") {
      throw new Error(
        "EventBuilder.buildEvent: block override provided but wasm is missing `newCoreBlock` export — rebuild the bundle against the latest scaffold.ts",
      );
    }
    // Defaults mirror scaffold's `defaultBlock()`. Match-stick parity:
    // missing fields don't fall through to "0", they fall through to
    // the scaffold's constant (`BigInt(1)` for number/timestamp,
    // `DEFAULT_ADDRESS_BYTES` for hash).
    const numberPtr = this.bigInt(block.number ?? 1n);
    const timestampPtr = this.bigInt(block.timestamp ?? 1n);
    const hashPtr = this.bytesPayload(
      block.hash === undefined
        ? hexToBytes("a16081f360e3847006db660bae1c6d1b2e17ec2a")
        : toBytes(block.hash),
    );
    return this.exports.newCoreBlock(numberPtr, timestampPtr, hashPtr);
  }
}

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? hexToBytes(value) : value;
}

/**
 * Permissive hex decoder used by `address`/`bytes`/`fixedBytes`. Strips
 * an optional `0x` prefix, requires even length, accepts upper/lower
 * case. Throws with a precise message rather than silently producing
 * malformed bytes.
 */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd number of hex chars in "${hex}"`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`hexToBytes: invalid hex byte at offset ${i * 2} in "${hex}"`);
    }
    out[i] = byte;
  }
  return out;
}
