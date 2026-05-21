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
  __getUint8Array: (ptr: number) => Uint8Array;
  __getArray: (ptr: number) => number[];
  TypeId: Record<string, WebAssembly.Global>;
  // `--explicitStart` makes AS top-level initialization a manual export
  // instead of the wasm `start` section. `@assemblyscript/loader` does
  // NOT call it for us, so the runner must invoke it post-instantiate;
  // otherwise graph-ts globals stay uninitialized and the wasm corrupts
  // its own data section after a handful of allocations.
  _start: () => void;
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
  static async compile(path: string): Promise<WasmRunner> {
    const buf = await readFile(path);
    // Copy into a plain ArrayBuffer for the same `BufferSource` typing
    // reasons as `inspectWasm`.
    const ab = new ArrayBuffer(buf.byteLength);
    new Uint8Array(ab).set(buf);
    return new WasmRunner(path, new Uint8Array(ab));
  }

  /**
   * Build a fresh `SubgraphInstance` — a wasm instance plus its host
   * shim, wired together. Internal: also bakes a factory closure into
   * the instance so `subgraph.reset()` can rebuild the pair without
   * the consumer having to hold a `WasmRunner` reference.
   */
  async instantiate(): Promise<SubgraphInstance> {
    const factory = () => this.buildInstance();
    const { exports, host } = await factory();
    return new SubgraphInstance(factory, exports, host);
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

    host.wireRuntime({
      memory: exports.memory,
      newArray: exports.__newArray,
      typeIdUint8Array: typeIdUint8ArrayGlobal.value as number,
    });

    // Must run AFTER wireRuntime: AS top-level code may call host imports
    // (e.g. graph-ts modules that build constants via `BigInt.fromI32`)
    // and those imports decode string ptrs via the runtime we just wired.
    if (typeof exports._start !== "function") {
      throw new Error(
        "wasm-runner: module is missing `_start` — wasm must be built with `--explicitStart` and `--exportRuntime` (graph-cli defaults)",
      );
    }
    exports._start();

    return { exports, host };
  }
}
