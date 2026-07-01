/**
 * `WasmRunner` — the in-process replacement for `spawn("graph", ["test"])`.
 *
 * After Step 4 consolidation:
 *   - Instantiation goes through `@assemblyscript/loader`, so we get
 *     `__newString`, `__newArray`, `__getUint8Array`, `__pin`, `__unpin`,
 *     `__instanceof`, and the AS runtime helpers wired automatically.
 *   - The host shim (`createHost` from `./host.ts`) provides every
 *     graph-ts host import the production `Counter.wasm` and the
 *     test-driver bundle need. Both wasms work through this one path.
 *   - `instantiate()` finishes the import handshake by calling
 *     `host.wireRuntime(...)` with the loader-exposed runtime helpers
 *     (memory + `__newArray` + `TypeId.Uint8Array` value), enabling the
 *     host imports that needed those (e.g. `stringToH160`).
 *
 * Later steps will add:
 *   - `replay({events, mocks, reads}) -> RawSnapshot` once we have the
 *     event-builder + snapshot-dump on the AS side.
 */
import { readFile } from "node:fs/promises";
import { instantiate as loaderInstantiate } from "@assemblyscript/loader";
import { createHost, type Host } from "./host.ts";
import { SubgraphInstance } from "./subgraph.ts";
import { Asyncify, applyAsyncifyTransform } from "./asyncify.ts";

/**
 * The minimum AS runtime + graph-ts surface the runner relies on. The
 * loader installs `__newString` / `__getString` / `__newArray` / etc.,
 * and the AS compiler exports `__new` / `__pin` / `__unpin` / `memory`
 * via `--exportRuntime`. `TypeId` is graph-ts's nested namespace of
 * runtime class IDs (e.g. `TypeId.Uint8Array.value`).
 */
export interface InstanceExports extends Record<string, unknown> {
  memory: WebAssembly.Memory;
  __new: (size: number, classId: number) => number;
  __pin: (ptr: number) => number;
  __unpin: (ptr: number) => void;
  __newArray: (typeId: number, values: ArrayLike<number> | number[]) => number;
  __newString: (str: string) => number;
  __getUint8Array: (ptr: number) => Uint8Array;
  __getArray: (ptr: number) => number[];
  /**
   * graph-ts export: translates a graph-node `IndexForAscTypeId` enum
   * value (the integer in `TypeId.*` globals) into the wasm's actual
   * asc-assigned RTTI class id. Required when allocating any
   * subgraph-specific class via `__new` / `__newArray`.
   */
  id_of_type: (graphNodeTypeId: number) => number;
  TypeId: Record<string, WebAssembly.Global>;
  // `--explicitStart` makes AS top-level initialization a manual export
  // instead of the wasm `start` section. `@assemblyscript/loader` does
  // NOT call it for us, so the runner must invoke it post-instantiate;
  // otherwise graph-ts globals stay uninitialized and the wasm corrupts
  // its own data section after a handful of allocations.
  _start: () => void;
  // Asyncify-injected exports (added by `applyAsyncifyTransform` —
  // see `asyncify.ts`). Used by the JS-side `Asyncify` runtime to
  // suspend / resume the wasm stack across async host imports.
  asyncify_start_unwind: (dataPtr: number) => void;
  asyncify_stop_unwind: () => void;
  asyncify_start_rewind: (dataPtr: number) => void;
  asyncify_stop_rewind: () => void;
  asyncify_get_state: () => number;
}

export class WasmRunner {
  readonly wasmPath: string;
  private readonly bytes: Uint8Array;

  private constructor(wasmPath: string, bytes: Uint8Array) {
    this.wasmPath = wasmPath;
    this.bytes = bytes;
  }

  /**
   * Read the wasm at `path`. We hold the bytes (not a compiled
   * `WebAssembly.Module`) because the loader's `instantiate(source,
   * imports)` does the compile itself and prefers bytes over modules
   * (it can register the demangled exports during instantiation).
   *
   * For 30-50 KB subgraph wasms the compile overhead is sub-ms, so
   * caching the compiled module across `instantiate()` calls isn't
   * worth the extra wiring today.
   */
  /**
   * Build a `WasmRunner` from a wasm file path or pre-loaded bytes.
   * Bytes are useful for the high-level `Subgraph.create({...})`
   * path which may compile a bundle in-memory; the path form keeps
   * existing test harnesses simple.
   */
  static async compile(source: string | Uint8Array): Promise<WasmRunner> {
    let bytes: Uint8Array;
    let label: string;
    if (typeof source === "string") {
      const buf = await readFile(source);
      const ab = new ArrayBuffer(buf.byteLength);
      new Uint8Array(ab).set(buf);
      bytes = new Uint8Array(ab);
      label = source;
    } else {
      bytes = source;
      label = "<bytes>";
    }
    // Apply asyncify pass once at compile time — adds the
    // suspend/resume bookkeeping needed for any future async host
    // imports (e.g. real `ethereum.call` over RPC). The transform
    // is a no-op for executions that never trigger an unwind, so
    // existing sync test paths keep behaving identically.
    const transformed = applyAsyncifyTransform(bytes);
    return new WasmRunner(label, transformed);
  }

  /**
   * Build a fresh `SubgraphInstance` — a wasm instance plus its host
   * shim, wired together. Internal: also bakes a factory closure into
   * the instance so `subgraph.reset()` can rebuild the pair without
   * the consumer having to hold a `WasmRunner` reference.
   */
  async instantiate(): Promise<SubgraphInstance> {
    const factory = () => this.buildInstance();
    const { exports, host, asyncify } = await factory();
    return new SubgraphInstance(factory, exports, host, asyncify);
  }

  /**
   * One round of: build a host, instantiate the wasm against it via
   * @assemblyscript/loader, wire post-instantiation runtime helpers.
   * Used by both `instantiate()` (initial build) and
   * `SubgraphInstance.reset()` (rebuild via the captured factory).
   */
  private async buildInstance(): Promise<{
    exports: InstanceExports;
    host: Host;
    asyncify: Asyncify;
  }> {
    const host = createHost();
    const { exports } = await loaderInstantiate<InstanceExports>(
      this.bytes,
      host.imports,
    );

    const typeIdUint8ArrayGlobal = exports.TypeId.Uint8Array;
    if (!typeIdUint8ArrayGlobal) {
      throw new Error(
        "wasm-runner: instantiated module is missing `TypeId.Uint8Array` export — host.stringToH160 cannot allocate bytes",
      );
    }
    // graph-ts's `TypeId.*` values are graph-node's `IndexForAscTypeId`
    // enum, not the wasm's asc-assigned RTTI class ids. Translate via
    // the `id_of_type` graph-ts export so `__newArray` gets the right
    // class id. (We've seen the untranslated id "happen to work" for
    // Uint8Array in some bundles — that's coincidence, don't rely on it.)
    const idOfType = exports.id_of_type as
      | ((graphNodeTypeId: number) => number)
      | undefined;
    if (typeof idOfType !== "function") {
      throw new Error(
        "wasm-runner: instantiated module is missing `id_of_type` export — required to translate graph-node `TypeId.*` ids to asc class ids",
      );
    }
    const ascUint8ArrayId = idOfType(typeIdUint8ArrayGlobal.value as number);

    // Wire the host with a fresh (uninitialized) asyncify. Host
    // closures capture `asyncify` by reference; calling
    // `asyncify.init` later populates `exports` / `dataPtr` on the
    // same object, so the captured closures see the live state when
    // they're actually invoked. This breaks the ordering cycle
    // between `_start` (may call host imports) and `asyncify.init`
    // (needs `__new`, only safe post-`_start`).
    const asyncify = new Asyncify();
    host.wireRuntime({
      memory: exports.memory,
      newArray: exports.__newArray,
      newString: exports.__newString,
      typeIdUint8Array: ascUint8ArrayId,
      exports,
      asyncify,
    });

    if (typeof exports._start !== "function") {
      throw new Error(
        "wasm-runner: module is missing `_start` — wasm must be built with `--explicitStart` and `--exportRuntime` (graph-cli defaults)",
      );
    }
    exports._start();

    // Initialize the asyncify runtime AFTER `_start` so the AS heap
    // allocator is fully set up — `asyncify.init` calls `__new` for
    // the unwind buffer and that needs a ready heap.
    asyncify.init(exports);

    return { exports, host, asyncify };
  }
}
