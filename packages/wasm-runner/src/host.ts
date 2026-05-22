/**
 * Host shim for graph-subgraph wasms running under the unified
 * `WasmRunner`.
 *
 * The shim aims to be wide enough that ANY production-built subgraph
 * wasm (anything `graph build` emits today) instantiates without a
 * `LinkError`. Every `@external` declaration in graph-ts has a slot in
 * the import object; uncovered ones are filled with a `trap()` that
 * throws `NotImplementedError("<module>.<namespace>.<function>")` so
 * the first call to an unwired path identifies itself precisely.
 *
 * Buckets, by what they look like in `graph-ts`:
 *
 *   IO / context            (must live in the host — no AS alternative)
 *     env.abort
 *     index.log.log
 *     index.store.get / set / remove
 *     datasource.dataSource.address / context / network
 *     ethereum.ethereum.call            (stub: always returns null=reverted)
 *
 *   Pure compute, host-implemented (could be polyfilled in AS, but
 *   keeping in JS lets graph-build-produced production wasms work
 *   unmodified — the same shim covers both our test bundles and any
 *   third-party `.wasm` we point the runner at):
 *     conversion.typeConversion.{stringToH160, bytesToHex, bytesToString,
 *       bytesToBase58, bigIntToString, bigIntToHex}
 *     numbers.bigInt.{plus, minus, times, dividedBy, mod, pow,
 *       fromString, bitOr, bitAnd, leftShift, rightShift}
 *
 *   Trapped (semantics non-trivial or out of scope until a real test
 *   needs them):
 *     index.crypto.keccak256                   needs a keccak dep
 *     index.store.get_in_block / loadRelated   per-block / schema-aware
 *     index.ipfs.cat / map                     IPFS gateway
 *     index.ens.nameByHash                     ENS data
 *     numbers.bigInt.dividedByDecimal          mixed-domain
 *     numbers.bigDecimal.*                     needs decimal lib
 *     json.json.*                              graph-node-specific JSONValue marshalling
 *     ethereum.ethereum.{getBalance, hasCode, encode, decode}
 *     datasource.dataSource.{create, createWithContext}
 *
 * Memory and the loader's allocators aren't available until after
 * `WebAssembly.instantiate` resolves the imports. The runner closes
 * that loop by calling `host.wireRuntime` post-instantiation; until
 * then, any host import that needs them throws a clear "wireRuntime
 * not called yet" error rather than NPEing.
 */
import { readAsString } from "./codec.ts";
import { decodeSignedBigInt } from "./decode.ts";
import { encodeSignedBigInt } from "./event-builder.ts";

/**
 * Thrown when wasm calls a host import the runner hasn't implemented
 * yet. The message names the import (`module.name`).
 */
export class NotImplementedError extends Error {
  constructor(importName: string) {
    super(`wasm-runner: host import not implemented: ${importName}`);
    this.name = "NotImplementedError";
  }
}

/**
 * Thrown by `env.abort`. Carries the AS source location so test output
 * points at the failing line in the original `.ts` mapping (after
 * source-map translation, added in a later step).
 */
export class WasmAbortError extends Error {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  constructor(message: string, file: string, line: number, column: number) {
    super(`wasm abort: ${message} (${file}:${line}:${column})`);
    this.name = "WasmAbortError";
    this.file = file;
    this.line = line;
    this.column = column;
  }
}

/**
 * Recorded `store.set(type, id, entityPtr)` call. `entityPtr` is an
 * opaque pointer into wasm memory — entity-payload decoding (TypedMap
 * walking) lives in a later step.
 */
export interface CapturedStoreSet {
  entityType: string;
  id: string;
  entityPtr: number;
}

/**
 * Recorded `store.get(type, id)` call. The lookup result (the pointer
 * we returned) isn't recorded — tests assert on what the wasm asked
 * for, not what we answered with.
 */
export interface CapturedStoreGet {
  entityType: string;
  id: string;
}

/**
 * Recorded `log.log(level, msg)` call. Level mirrors graph-ts's
 * `log.Level` enum (CRITICAL=0, ERROR=1, WARNING=2, INFO=3, DEBUG=4).
 */
export interface CapturedLog {
  level: number;
  message: string;
}

/**
 * Capture buffers populated by host imports during a handler run.
 * Reset between runs by reassigning fresh arrays on the `Host` (the
 * runner does this when a caller asks to clear state, but the spike
 * tests just create a fresh runner per assertion).
 */
export interface HostCaptured {
  storeSets: CapturedStoreSet[];
  storeGets: CapturedStoreGet[];
  logs: CapturedLog[];
}

/**
 * Post-instantiation runtime helpers the host needs to allocate things
 * in wasm memory and read strings out of it. Populated by the runner
 * post-instantiate via `wireRuntime`.
 */
export interface HostRuntime {
  memory: WebAssembly.Memory;
  /** Loader's `__newArray(id, values) -> ptr`. */
  newArray: (typeId: number, values: ArrayLike<number> | number[]) => number;
  /** Loader's `__newString(str) -> ptr` — for host imports that return strings. */
  newString: (str: string) => number;
  /** asc RTTI class id of `Uint8Array` (also `Bytes` / `Address`). */
  typeIdUint8Array: number;
}

/**
 * Public host object handed back from `createHost`. The `imports`
 * field is consumed by the loader's `instantiate`; everything else is
 * exposed for the runner and tests.
 */
export interface Host {
  imports: WebAssembly.Imports;
  captured: HostCaptured;
  /**
   * JS-side entity store keyed by (entityType, id) -> entityPtr.
   * Populated by `store.set` and consulted by `store.get`. Note this
   * is the "Variant A" approach from the plan: pointers live in JS
   * across handler calls. Step 5+ may switch to in-wasm storage.
   */
  store: Map<string, Map<string, number>>;
  /**
   * Optional log sink. Defaults to `console.log`-style printing with
   * a level prefix. Tests can swap this for a silent sink or assert
   * on `captured.logs` instead.
   */
  logSink: (level: number, message: string) => void;
  /**
   * Default `dataSource.address` value the host returns to graph-ts
   * (20-byte hex, no `0x` prefix). Mutable so tests can override
   * before dispatch. Default: all zeros.
   */
  dataSourceAddress: string;
  /**
   * Default `dataSource.network` string the host returns. Subgraphs
   * sometimes branch on network name (e.g. mainnet vs sepolia) so
   * making this swappable per test avoids forcing a runner rebuild.
   * Default: `"mainnet"`.
   */
  dataSourceNetwork: string;
  /**
   * Called once by the runner after `WebAssembly.instantiate` resolves
   * and the instance's runtime exports are visible. After this call,
   * the host imports can decode string pointers / allocate Uint8Arrays.
   */
  wireRuntime(runtime: HostRuntime): void;
}

/**
 * graph-ts `log.Level` enum (`index.ts`):
 *   CRITICAL = 0, ERROR = 1, WARNING = 2, INFO = 3, DEBUG = 4
 * Used to prefix log lines and (later) to filter at runtime.
 */
const LEVEL_NAMES = ["CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"];

export function createHost(): Host {
  const captured: HostCaptured = { storeSets: [], storeGets: [], logs: [] };
  const store = new Map<string, Map<string, number>>();
  let runtime: HostRuntime | null = null;
  /**
   * Cached `Address` (Uint8Array of 20 bytes) the `dataSource.address`
   * import returns. Lazily allocated on first call so we have a wired
   * runtime; cached because handlers can call it many times per event
   * and re-allocating each time would just churn the bump heap.
   */
  let dataSourceAddressPtr = 0;

  function requireRuntime(): HostRuntime {
    if (runtime === null) {
      throw new Error(
        "wasm-runner: host import called before wireRuntime() — the runner must call host.wireRuntime() after instantiate()",
      );
    }
    return runtime;
  }

  function abort(
    msgPtr: number,
    filePtr: number,
    line: number,
    column: number,
  ): never {
    const memory = requireRuntime().memory;
    throw new WasmAbortError(
      readAsString(memory, msgPtr),
      readAsString(memory, filePtr),
      line,
      column,
    );
  }

  function stringToH160(strPtr: number): number {
    const rt = requireRuntime();
    const hex = readAsString(rt.memory, strPtr);
    const clean =
      hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
    if (clean.length !== 40) {
      throw new Error(
        `stringToH160: expected 40 hex chars, got ${clean.length} (from "${hex}")`,
      );
    }
    const bytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) {
      bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return rt.newArray(rt.typeIdUint8Array, bytes);
  }

  function storeGet(typePtr: number, idPtr: number): number {
    const rt = requireRuntime();
    const entityType = readAsString(rt.memory, typePtr);
    const id = readAsString(rt.memory, idPtr);
    captured.storeGets.push({ entityType, id });
    return store.get(entityType)?.get(id) ?? 0;
  }

  function storeSet(
    typePtr: number,
    idPtr: number,
    entityPtr: number,
  ): void {
    const rt = requireRuntime();
    const entityType = readAsString(rt.memory, typePtr);
    const id = readAsString(rt.memory, idPtr);
    captured.storeSets.push({ entityType, id, entityPtr });
    let byId = store.get(entityType);
    if (!byId) {
      byId = new Map();
      store.set(entityType, byId);
    }
    byId.set(id, entityPtr);
  }

  function storeRemove(typePtr: number, idPtr: number): void {
    const rt = requireRuntime();
    const entityType = readAsString(rt.memory, typePtr);
    const id = readAsString(rt.memory, idPtr);
    store.get(entityType)?.delete(id);
  }

  function bytesToString(bytesPtr: number): number {
    const rt = requireRuntime();
    const u8 = readUint8Array(rt, bytesPtr);
    // `fatal: false` matches graph-node's `String::from_utf8_lossy`:
    // invalid UTF-8 sequences become U+FFFD (REPLACEMENT CHARACTER).
    const s = new TextDecoder("utf-8", { fatal: false }).decode(u8);
    return rt.newString(s);
  }

  function bytesToBase58(bytesPtr: number): number {
    const rt = requireRuntime();
    return rt.newString(encodeBase58(readUint8Array(rt, bytesPtr)));
  }

  function bytesToHex(bytesPtr: number): number {
    const rt = requireRuntime();
    // Loader-backed Uint8Array read — handles the dataStart/byteLength
    // header for us; we just need the raw bytes.
    const u8 = readUint8Array(rt, bytesPtr);
    const hex = "0x" + Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
    return rt.newString(hex);
  }

  function bigIntToString(bigintPtr: number): number {
    const rt = requireRuntime();
    const bytes = readUint8Array(rt, bigintPtr);
    return rt.newString(decodeSignedBigInt(bytes).toString(10));
  }

  function bigIntToHex(bigintPtr: number): number {
    const rt = requireRuntime();
    const bytes = readUint8Array(rt, bigintPtr);
    const n = decodeSignedBigInt(bytes);
    // Mirror graph-node's `BigInt.to_hex` (`format!("0x{:x}", n)` for
    // non-negative; signed-prefixed for negatives). uint256 handler
    // inputs are always non-negative; signed callers get a clearly
    // formatted "-0x..." rather than wrapping.
    const hex =
      n >= 0n
        ? "0x" + n.toString(16)
        : "-0x" + (-n).toString(16);
    return rt.newString(hex);
  }

  /** Convenience: decode bigint args, encode bigint result back as a new pinned Uint8Array. */
  function bigIntBinOp(
    op: (a: bigint, b: bigint) => bigint,
  ): (aPtr: number, bPtr: number) => number {
    return (aPtr, bPtr) => {
      const rt = requireRuntime();
      const a = decodeSignedBigInt(readUint8Array(rt, aPtr));
      const b = decodeSignedBigInt(readUint8Array(rt, bPtr));
      return rt.newArray(rt.typeIdUint8Array, encodeSignedBigInt(op(a, b)));
    };
  }

  /**
   * `bigInt.pow(x, exp: u8)`: graph-ts passes the exponent as a u8
   * (post-asc, that's `i32` on the wire) — distinct from `bigIntBinOp`
   * which decodes both args as bigints.
   */
  function bigIntPow(aPtr: number, exp: number): number {
    const rt = requireRuntime();
    const a = decodeSignedBigInt(readUint8Array(rt, aPtr));
    const result = a ** BigInt(exp);
    return rt.newArray(rt.typeIdUint8Array, encodeSignedBigInt(result));
  }

  function bigIntFromString(strPtr: number): number {
    const rt = requireRuntime();
    const s = readAsString(rt.memory, strPtr);
    // `BigInt(s)` accepts decimal, "0x"-prefixed hex, "0o"/"0b" too.
    // graph-node's `BigInt::from_string` only accepts decimal, but
    // being permissive here doesn't break correct callers.
    const n = BigInt(s);
    return rt.newArray(rt.typeIdUint8Array, encodeSignedBigInt(n));
  }

  function bigIntShift(direction: 1 | -1) {
    return (aPtr: number, bits: number): number => {
      const rt = requireRuntime();
      const a = decodeSignedBigInt(readUint8Array(rt, aPtr));
      const result = direction > 0 ? a << BigInt(bits) : a >> BigInt(bits);
      return rt.newArray(rt.typeIdUint8Array, encodeSignedBigInt(result));
    };
  }

  function logLog(level: number, msgPtr: number): void {
    const rt = requireRuntime();
    const message = readAsString(rt.memory, msgPtr);
    captured.logs.push({ level, message });
    host.logSink(level, message);
  }

  function dataSourceAddress(): number {
    const rt = requireRuntime();
    if (dataSourceAddressPtr === 0) {
      const bytes = parseHexToBytes(host.dataSourceAddress);
      if (bytes.length !== 20) {
        throw new Error(
          `host.dataSourceAddress must be a 20-byte hex string, got ${bytes.length} bytes`,
        );
      }
      dataSourceAddressPtr = rt.newArray(rt.typeIdUint8Array, bytes);
    }
    return dataSourceAddressPtr;
  }

  function dataSourceContext(): number {
    // null TypedMap — graph-ts treats 0 as an empty/null context. Real
    // contexts (`subgraph.yaml`'s `context:` block) plug in here later.
    return 0;
  }

  function dataSourceNetwork(): number {
    return requireRuntime().newString(host.dataSourceNetwork);
  }

  const trap =
    (importName: string): ((...args: unknown[]) => never) =>
    () => {
      throw new NotImplementedError(importName);
    };

  const imports: WebAssembly.Imports = {
    env: { abort },
    conversion: {
      "typeConversion.stringToH160": stringToH160,
      "typeConversion.bytesToHex": bytesToHex,
      "typeConversion.bytesToString": bytesToString,
      "typeConversion.bytesToBase58": bytesToBase58,
      "typeConversion.bigIntToString": bigIntToString,
      "typeConversion.bigIntToHex": bigIntToHex,
    },
    datasource: {
      "dataSource.address": dataSourceAddress,
      "dataSource.context": dataSourceContext,
      "dataSource.network": dataSourceNetwork,
      "dataSource.create": trap("datasource.dataSource.create"),
      "dataSource.createWithContext": trap(
        "datasource.dataSource.createWithContext",
      ),
    },
    ethereum: {
      // Always return null (= reverted in graph-ts `try_*` calls). Real
      // RPC-backed `eth_call` is out of scope for the JS host today;
      // when a test needs a non-revert response it should wire it
      // through a future `host.mockContractCall(addr, sig, ...)` hook,
      // mirroring matchstick's `createMockedFunction(...)`.
      "ethereum.call": () => 0,
      "ethereum.getBalance": trap("ethereum.ethereum.getBalance"),
      "ethereum.hasCode": trap("ethereum.ethereum.hasCode"),
      "ethereum.encode": trap("ethereum.ethereum.encode"),
      "ethereum.decode": trap("ethereum.ethereum.decode"),
    },
    numbers: {
      "bigInt.plus": bigIntBinOp((a, b) => a + b),
      "bigInt.minus": bigIntBinOp((a, b) => a - b),
      "bigInt.times": bigIntBinOp((a, b) => a * b),
      "bigInt.dividedBy": bigIntBinOp((a, b) => a / b),
      "bigInt.mod": bigIntBinOp((a, b) => a % b),
      "bigInt.pow": bigIntPow,
      "bigInt.fromString": bigIntFromString,
      "bigInt.bitOr": bigIntBinOp((a, b) => a | b),
      "bigInt.bitAnd": bigIntBinOp((a, b) => a & b),
      "bigInt.leftShift": bigIntShift(1),
      "bigInt.rightShift": bigIntShift(-1),
      "bigInt.dividedByDecimal": trap("numbers.bigInt.dividedByDecimal"),
      "bigDecimal.plus": trap("numbers.bigDecimal.plus"),
      "bigDecimal.minus": trap("numbers.bigDecimal.minus"),
      "bigDecimal.times": trap("numbers.bigDecimal.times"),
      "bigDecimal.dividedBy": trap("numbers.bigDecimal.dividedBy"),
      "bigDecimal.equals": trap("numbers.bigDecimal.equals"),
      "bigDecimal.toString": trap("numbers.bigDecimal.toString"),
      "bigDecimal.fromString": trap("numbers.bigDecimal.fromString"),
    },
    index: {
      "store.get": storeGet,
      "store.set": storeSet,
      "store.remove": storeRemove,
      "store.get_in_block": trap("index.store.get_in_block"),
      "store.loadRelated": trap("index.store.loadRelated"),
      "log.log": logLog,
      "crypto.keccak256": trap("index.crypto.keccak256"),
      "ipfs.cat": trap("index.ipfs.cat"),
      "ipfs.map": trap("index.ipfs.map"),
      "ens.nameByHash": trap("index.ens.nameByHash"),
    },
    json: {
      "json.fromBytes": trap("json.json.fromBytes"),
      "json.try_fromBytes": trap("json.json.try_fromBytes"),
      "json.toI64": trap("json.json.toI64"),
      "json.toU64": trap("json.json.toU64"),
      "json.toF64": trap("json.json.toF64"),
      "json.toBigInt": trap("json.json.toBigInt"),
    },
  };

  const host: Host = {
    imports,
    captured,
    store,
    // Default level-prefixed printer; tests typically replace with a
    // no-op or capture-only sink.
    logSink: (level, message) => {
      const tag = LEVEL_NAMES[level] ?? `LEVEL_${level}`;
      console.log(`[${tag}] ${message}`);
    },
    dataSourceAddress: "0".repeat(40),
    dataSourceNetwork: "mainnet",
    wireRuntime(rt) {
      runtime = rt;
      // Invalidate the cached address ptr — `reset()` rebuilds the
      // wasm and we must re-allocate against the new heap.
      dataSourceAddressPtr = 0;
    },
  };
  return host;
}

/**
 * Read a graph-ts `Uint8Array` / `Bytes` / `BigInt` payload from wasm
 * memory by pointer. Walks the AS standard-library `ArrayBufferView`
 * header (`buffer | dataStart | byteLength`) directly rather than
 * going through `__getUint8Array`, because the loader's view
 * requires the rtid to match `Uint8Array`'s class id and graph-ts's
 * `class Bytes extends Uint8Array` / `class BigInt extends Uint8Array`
 * subclasses have their own class IDs that pass `__instanceof` but
 * not strict id equality. The header layout is identical, so reading
 * `dataStart` + `byteLength` works for every subclass.
 */
function readUint8Array(
  rt: HostRuntime,
  ptr: number,
): Uint8Array {
  const u32 = new Uint32Array(rt.memory.buffer);
  // ArrayBufferView header: buffer(+0) | dataStart(+4) | byteLength(+8)
  const dataStart = u32[(ptr + 4) >>> 2];
  const byteLength = u32[(ptr + 8) >>> 2];
  return new Uint8Array(rt.memory.buffer, dataStart, byteLength);
}

function parseHexToBytes(hex: string): Uint8Array {
  const clean =
    hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Bitcoin-style Base58 encoding of an arbitrary byte string. Mirrors
 * graph-node's `bs58::encode(bytes).into_string()` (the standard
 * "Bitcoin alphabet" — no `0`, `O`, `I`, `l`).
 *
 * The bytes are interpreted as a big-endian unsigned integer; leading
 * zero bytes are preserved as `'1'` characters at the start of the
 * output (this is what makes round-tripping IPFS hashes work — they
 * begin with `Qm...` because their first byte is `0x12`, but the
 * preserved leading-zeros rule covers the variants that do start
 * with `0x00`).
 */
function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const ALPHABET =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let result = "";
  while (n > 0n) {
    result = ALPHABET[Number(n % 58n)] + result;
    n /= 58n;
  }
  return "1".repeat(zeros) + result;
}
