/**
 * `WasmRunner` — the in-process replacement for `spawn("graph", ["test"])`.
 *
 * Step 2 surface:
 *   - `WasmRunner.compile(path)` reads + compiles the wasm once, returning
 *     a runner that holds the `WebAssembly.Module`.
 *   - `runner.instantiate()` produces a fresh `{ instance, host }` pair —
 *     instance has the exported handlers + AS runtime; host owns the JS
 *     state (store, memory handle) shared with the import functions.
 *
 * Later steps will add:
 *   - `replay({events, mocks, reads}) -> RawSnapshot` (Step 3+) — drives
 *     the instance with a sequence of `CapturedEvent`s and dumps the
 *     resulting store as JSON.
 *   - Per-replay reset: TBD between reinstantiating (~1 ms) vs. shared
 *     instance + wasm-side `clearStore`.
 */
import { readFile } from "node:fs/promises";
import { createHost, type Host } from "./host.ts";

/**
 * The minimum AS runtime surface the codec / event-builder depend on.
 * Every export is a function the host calls *into* wasm; entries marked
 * optional are nice-to-have but the runner can work without them.
 */
export interface WasmRuntimeExports {
  memory: WebAssembly.Memory;
  /** AS GC allocator. `__new(size, classId) -> ptr`. */
  __new: (size: number, classId: number) => number;
  /** Pin a pointer so the AS GC doesn't collect it across host calls. */
  __pin: (ptr: number) => number;
  /** Release a previously-pinned pointer. */
  __unpin: (ptr: number) => void;
}

/**
 * The full export shape, including subgraph handlers. Handler functions
 * accept a pointer to an `ethereum.Event` and return void. The dynamic
 * member type stays `Function` (not a typed signature) because handler
 * names vary per subgraph; callers narrow via the `handlerExports` list
 * surfaced by `inspectWasm` (or by a later `WasmRunner.handlers` map).
 */
export interface InstanceExports extends WasmRuntimeExports {
  [exportName: string]: unknown;
}

/**
 * Result of `instantiate()`. The host shares mutable state (store,
 * memoryHandle) with the import functions installed on this instance —
 * holding the host alongside the instance is how callers reach that
 * state.
 */
export interface InstantiatedRunner {
  instance: WebAssembly.Instance;
  exports: InstanceExports;
  host: Host;
}

export class WasmRunner {
  readonly wasmPath: string;
  readonly module: WebAssembly.Module;

  private constructor(wasmPath: string, module: WebAssembly.Module) {
    this.wasmPath = wasmPath;
    this.module = module;
  }

  /**
   * Read + compile (but do not instantiate) the wasm at `path`. Compiles
   * exactly once; the returned `WasmRunner` can be `instantiate()`d as
   * many times as needed.
   */
  static async compile(path: string): Promise<WasmRunner> {
    const buf = await readFile(path);
    // Copy into a plain ArrayBuffer for the same reason as `inspectWasm`:
    // Node `Buffer` is `Uint8Array<ArrayBufferLike>`, which TS won't narrow
    // against `SharedArrayBuffer` for the `BufferSource` overload.
    const ab = new ArrayBuffer(buf.byteLength);
    new Uint8Array(ab).set(buf);
    const module = await WebAssembly.compile(ab);
    return new WasmRunner(path, module);
  }

  /**
   * Build a fresh host, instantiate the module against it, attach the
   * memory export to the host, and return the bundle.
   *
   * Does NOT call `_start` — graph subgraph wasms expose `_start` only
   * as a residual AS convention; their handlers are entered via direct
   * export calls. If a future subgraph needs explicit init, the runner
   * will gain an opt-in `callStart: true` option.
   */
  async instantiate(): Promise<InstantiatedRunner> {
    const host = createHost();
    const instance = await WebAssembly.instantiate(this.module, host.imports);
    const exports = instance.exports as unknown as InstanceExports;
    if (!(exports.memory instanceof WebAssembly.Memory)) {
      throw new Error(
        "wasm-runner: instantiated module does not export `memory` as a WebAssembly.Memory",
      );
    }
    host.setMemory(exports.memory);
    return { instance, exports, host };
  }
}
