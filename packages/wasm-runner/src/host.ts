/**
 * Host shim for graph-subgraph wasms running under the unified
 * `WasmRunner`.
 *
 * Responsibilities split across this module:
 *   - Build the `WebAssembly.Imports` object that satisfies the union
 *     of the production `Counter.wasm` and the wasm-runner test-driver
 *     bundle's import lists.
 *   - Implement the imports we actually need today:
 *       env.abort                        -> decode + throw WasmAbortError
 *       conversion.typeConversion.stringToH160 -> hex string -> Bytes20
 *       index.store.get / store.set      -> JS-side Map<type, Map<id, ptr>>
 *     plus capture buffers (`captured.storeGets`, `captured.storeSets`)
 *     for assertions.
 *   - Trap every other declared graph-ts host import with
 *     `NotImplementedError("<module>.<name>")` so the first call to an
 *     unwired import produces a precise "implement this next" message
 *     rather than a generic wasm `unreachable`.
 *
 * Memory and the loader's `__newArray` / `TypeId.Uint8Array` value
 * aren't available until after `WebAssembly.instantiate` resolves the
 * imports. The runner closes that loop by calling `host.wireRuntime`
 * post-instantiation; until then, any host import that needs them
 * throws a clear "wireRuntime not called yet" error rather than NPEing.
 */
import { readAsString } from "./codec.ts";

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
 * Capture buffers populated by host imports during a handler run.
 * Reset between runs by reassigning fresh arrays on the `Host` (the
 * runner does this when a caller asks to clear state, but the spike
 * tests just create a fresh runner per assertion).
 */
export interface HostCaptured {
  storeSets: CapturedStoreSet[];
  storeGets: CapturedStoreGet[];
}

/**
 * Post-instantiation runtime helpers the host needs to allocate things
 * in wasm memory (for `stringToH160`) and read strings out of it (for
 * `store.set` arg decoding).
 */
export interface HostRuntime {
  memory: WebAssembly.Memory;
  /** Loader's `__newArray(id, values) -> ptr`. */
  newArray: (typeId: number, values: ArrayLike<number> | number[]) => number;
  /** Class id of `Uint8Array` from the wasm's RTTI. */
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
   * Called once by the runner after `WebAssembly.instantiate` resolves
   * and the instance's runtime exports are visible. After this call,
   * the host imports can decode string pointers / allocate Uint8Arrays.
   */
  wireRuntime(runtime: HostRuntime): void;
}

export function createHost(): Host {
  const captured: HostCaptured = { storeSets: [], storeGets: [] };
  const store = new Map<string, Map<string, number>>();
  let runtime: HostRuntime | null = null;

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

  const trap =
    (importName: string): ((...args: unknown[]) => never) =>
    () => {
      throw new NotImplementedError(importName);
    };

  const imports: WebAssembly.Imports = {
    env: { abort },
    conversion: {
      "typeConversion.stringToH160": stringToH160,
      "typeConversion.bytesToHex": trap("conversion.typeConversion.bytesToHex"),
      "typeConversion.bigIntToString": trap(
        "conversion.typeConversion.bigIntToString",
      ),
    },
    ethereum: { "ethereum.call": trap("ethereum.ethereum.call") },
    numbers: {
      "bigInt.times": trap("numbers.bigInt.times"),
      "bigDecimal.toString": trap("numbers.bigDecimal.toString"),
    },
    index: {
      "store.get": storeGet,
      "store.set": storeSet,
    },
  };

  return {
    imports,
    captured,
    store,
    wireRuntime(rt) {
      runtime = rt;
    },
  };
}
