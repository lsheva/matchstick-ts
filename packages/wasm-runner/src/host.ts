/**
 * Host shim for a graph-subgraph wasm.
 *
 * Step 2 scope: just enough of the host surface to *instantiate* the
 * production `Counter.wasm` without crashing. Every import is wired,
 * but most are intentionally trap stubs that throw `NotImplementedError`
 * with a clear name. Calling any of them during a handler execution
 * surfaces a precise "the runner needs to implement X next" message.
 *
 * The two non-trap imports today:
 *   - `env.abort` decodes AS string pointers via the codec and throws a
 *     JS `Error` with `file:line:col` — without this, an AS assertion
 *     failure inside wasm becomes a generic `unreachable` trap with no
 *     context.
 *   - `index.store.get` returns 0 (null) so handlers that call
 *     `Entity.load(id)` against an empty store get the expected
 *     "not found" path. `index.store.set` is *also* not yet implemented
 *     and traps — this is fine for instantiation (no handler runs
 *     during instantiate) and Step 3 will replace both with the JS-map
 *     backed implementation.
 *
 * Memory is supplied lazily: `WebAssembly.instantiate` resolves imports
 * before exports are available, so the runner calls `setMemory(...)`
 * once the instance exists. The `env.abort` shim guards against being
 * called before memory is set (shouldn't happen for `abort`, but a
 * defensive error is cheap).
 */
import { readAsString } from "./codec.ts";

/**
 * Thrown when wasm calls a host import the runner hasn't implemented
 * yet. The message names the import (`module.name`) so Step 3+ knows
 * which one to fill in next.
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
 * Mutable handle the runner uses to plug in the instance's exported
 * memory after `WebAssembly.instantiate` resolves. All host functions
 * close over this object rather than the memory directly so the import
 * map is constructible *before* the instance exists.
 */
export interface MemoryHandle {
  memory: WebAssembly.Memory | null;
}

/**
 * Public host object handed back from `createHost`. The `imports` field
 * is consumed by `WebAssembly.instantiate`; everything else is exposed
 * for the runner and tests to inspect store contents, set memory, etc.
 */
export interface Host {
  imports: WebAssembly.Imports;
  memoryHandle: MemoryHandle;
  /**
   * In-memory entity store. Maps `entityType -> id -> ptr-into-wasm`.
   * Step 2 leaves this empty; Step 3 wires `store.get/set` to read/write
   * it. Exposed on `Host` so tests can assert on its contents directly.
   */
  store: Map<string, Map<string, number>>;
  setMemory(memory: WebAssembly.Memory): void;
}

/**
 * Build the import object for a graph-subgraph wasm.
 *
 * The returned `Host` shares state (memoryHandle, store) with the
 * import functions via closure, so `WebAssembly.instantiate(module,
 * host.imports)` followed by `host.setMemory(instance.exports.memory)`
 * is the standard handshake.
 */
export function createHost(): Host {
  const memoryHandle: MemoryHandle = { memory: null };
  const store = new Map<string, Map<string, number>>();

  function requireMemory(): WebAssembly.Memory {
    if (memoryHandle.memory === null) {
      throw new Error(
        "wasm-runner: host import called before memory was attached (call host.setMemory after instantiation)",
      );
    }
    return memoryHandle.memory;
  }

  // env.abort is special-cased: AS calls it on assertion failure /
  // null deref / out-of-bounds, and we want a human-readable error
  // rather than a generic `unreachable` trap.
  function abort(
    msgPtr: number,
    filePtr: number,
    line: number,
    column: number,
  ): never {
    const memory = requireMemory();
    const message = readAsString(memory, msgPtr);
    const file = readAsString(memory, filePtr);
    throw new WasmAbortError(message, file, line, column);
  }

  const notImpl =
    (importName: string): ((...args: unknown[]) => never) =>
    (..._args: unknown[]) => {
      throw new NotImplementedError(importName);
    };

  const imports: WebAssembly.Imports = {
    env: {
      abort,
    },
    conversion: {
      "typeConversion.bytesToHex": notImpl("conversion.typeConversion.bytesToHex"),
      "typeConversion.bigIntToString": notImpl(
        "conversion.typeConversion.bigIntToString",
      ),
    },
    ethereum: {
      "ethereum.call": notImpl("ethereum.ethereum.call"),
    },
    numbers: {
      "bigInt.times": notImpl("numbers.bigInt.times"),
      "bigDecimal.toString": notImpl("numbers.bigDecimal.toString"),
    },
    index: {
      // Returning 0 (null pointer) means "no entity for that (type, id)".
      // Safe for instantiation; Step 3 swaps in the real lookup.
      "store.get": (_typePtr: number, _idPtr: number): number => 0,
      "store.set": notImpl("index.store.set"),
    },
  };

  return {
    imports,
    memoryHandle,
    store,
    setMemory(memory: WebAssembly.Memory) {
      memoryHandle.memory = memory;
    },
  };
}
