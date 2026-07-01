/**
 * Asyncify integration for the wasm-runner.
 *
 * What asyncify does:
 *   binaryen's asyncify pass rewrites a wasm module so that
 *   synchronous-looking imports can suspend execution and resume later.
 *   The transform inserts state-machine instrumentation into every
 *   function that could be on the stack during a suspension. On
 *   suspend, locals get spilled to a heap-allocated frame; on resume,
 *   the frame is restored and execution continues from where it
 *   stopped.
 *
 * Why we use it:
 *   `ethereum.call` (graph-ts) is a synchronous import from the
 *   subgraph's perspective, but a real `eth_call` is HTTP — async in
 *   JS. Asyncify lets the wasm side keep its sync API while the JS
 *   side does the async work under an `await`. The user's dispatch
 *   call becomes `Promise<void>` instead of `void`, and that's the
 *   only API change.
 *
 * What this module exposes:
 *   - `applyAsyncifyTransform(bytes)` — bytes-level binaryen pass.
 *     Adds five exports to the wasm:
 *       asyncify_start_unwind(dataPtr)
 *       asyncify_stop_unwind()
 *       asyncify_start_rewind(dataPtr)
 *       asyncify_stop_rewind()
 *       asyncify_get_state() -> i32   (0=none, 1=unwinding, 2=rewinding)
 *   - `Asyncify` — the JS-side state machine. Holds the unwind buffer
 *     ptr, owns the run-loop that re-enters the handler after each
 *     suspension. Phase 1 (this file): wires the buffer + exports but
 *     does not yet hook any async imports. Phase 2 will use
 *     `wrapAsyncImport` to make `ethereum.call` suspend-capable.
 *
 * Why we apply at compile time, not at runtime:
 *   The transform is deterministic and the cost is paid once per
 *   `WasmRunner.compile()` (a few ms for our 50-100KB bundles). Doing
 *   it on every `instantiate()` would re-run binaryen for every reset,
 *   which is wasteful when the bytes are immutable.
 */
import binaryen from "binaryen";

/**
 * Run binaryen's asyncify pass over the given wasm bytes. Returns the
 * transformed module bytes; the input is unchanged.
 *
 * Phase 1 instruments unconditionally: no `asyncify-imports` filter,
 * so asyncify treats every import as potentially async and instruments
 * every reachable function. That bloats the wasm by ~30-50% but is the
 * conservative correctness-first choice. Phase 2 may switch to
 * `pass-arg=asyncify-imports@<list>` to limit instrumentation to
 * functions reachable from genuinely async imports (today: just
 * `ethereum.call`).
 *
 * The returned wasm has identical observable behavior to the input
 * for any execution that does NOT call `asyncify_start_unwind` — so
 * existing sync tests continue to pass after the transform applies.
 */
export function applyAsyncifyTransform(bytes: Uint8Array): Uint8Array {
  // binaryen.readBinary expects a `Uint8Array` view; pass through.
  const module = binaryen.readBinary(bytes);
  try {
    // Optimize to level 0 around the pass — `--optimize` already ran
    // upstream in `buildBundle`, and re-optimizing post-asyncify can
    // remove some of the instrumentation we just added.
    binaryen.setOptimizeLevel(0);
    binaryen.setShrinkLevel(0);
    module.runPasses(["asyncify"]);
    return module.emitBinary();
  } finally {
    module.dispose();
  }
}

/**
 * Asyncify dataPtr layout (memory32):
 *   [+0] u32 current pointer  (cursor into the spill buffer)
 *   [+4] u32 end pointer      (one past the last writable byte)
 *   [+8...] spill buffer      (asyncify writes locals here)
 *
 * We size the buffer at 8 KB. graph-ts handlers don't recurse deeply
 * (no >2 KB stacks observed in the futures-marketplace handlers), so
 * 8 KB is comfortable headroom. If a handler ever overflows we'd see
 * an `unreachable` from the asyncify pass at the spill site; the fix
 * is to bump this constant.
 */
const ASYNCIFY_BUFFER_SIZE = 8192;

/**
 * Wasm exports asyncify-instrumented modules expose, in addition to
 * everything the original module exported.
 */
export interface AsyncifyExports {
  memory: WebAssembly.Memory;
  __new: (size: number, classId: number) => number;
  asyncify_start_unwind: (dataPtr: number) => void;
  asyncify_stop_unwind: () => void;
  asyncify_start_rewind: (dataPtr: number) => void;
  asyncify_stop_rewind: () => void;
  asyncify_get_state: () => number;
}

/** Asyncify runtime state values (mirror binaryen's `Asyncify::State`). */
const STATE_NORMAL = 0;
const STATE_UNWINDING = 1;
const STATE_REWINDING = 2;

/**
 * JS-side state machine for asyncify. One instance per wasm instance
 * (so per `SubgraphInstance.host` lifecycle). Tracks pending Promise +
 * the buffer ptr so the import-suspend / handler-rewind dance has
 * somewhere to coordinate.
 *
 * Usage (Phase 2, once `ethereum.call` is wrapped):
 *
 *   await asyncify.run(() => exports.handleX(eventPtr));
 *
 * `run` invokes the handler. If the handler triggers an async import,
 * the import calls `markSuspending(promise)` and returns a placeholder.
 * Asyncify unwinds the wasm stack into the buffer. `run` awaits the
 * promise, then re-calls the handler — asyncify rewinds and execution
 * continues from where it suspended, with the resolved value as the
 * import's "return".
 */
export class Asyncify {
  private exports: AsyncifyExports | null = null;
  private dataPtr = 0;
  private state: 0 | 1 | 2 = STATE_NORMAL;
  private pendingPromise: Promise<unknown> | null = null;
  /** Resolved value the rewinding import call should return. */
  private resumeValue: unknown = undefined;

  /**
   * Wire the runtime to a freshly-instantiated wasm. Allocates the
   * spill buffer in wasm linear memory and writes the cursor/end
   * pointers asyncify expects.
   *
   * Must be called once per instance, after `WebAssembly.instantiate`
   * resolves. The runner does this from `buildInstance`.
   */
  init(exports: AsyncifyExports): void {
    this.exports = exports;
    // `__new(size, 0)` allocates `size` bytes with class id 0 (raw
    // bytes — asyncify doesn't need RTTI). The bump allocator under
    // `--runtime stub` won't reclaim this ever, which is exactly what
    // we want — the buffer must outlive the handler.
    const total = 8 + ASYNCIFY_BUFFER_SIZE;
    const ptr = exports.__new(total, 0);
    const u32 = new Uint32Array(exports.memory.buffer);
    u32[ptr >>> 2] = ptr + 8;
    u32[(ptr + 4) >>> 2] = ptr + 8 + ASYNCIFY_BUFFER_SIZE;
    this.dataPtr = ptr;
  }

  /**
   * Run a wasm-export call, awaiting any async imports it triggers.
   * Each suspension goes through one unwind/rewind cycle.
   *
   * Phase 1: nothing actually suspends, so `fn()` runs once and
   * returns. The loop below is dormant. Phase 2 plumbs in the
   * suspending imports.
   */
  async run<T>(fn: () => T): Promise<T> {
    if (this.exports === null) {
      throw new Error(
        "Asyncify.run called before init() — runner must call asyncify.init(exports) post-instantiate",
      );
    }
    let result = fn();
    while (this.state === STATE_UNWINDING) {
      // Wasm has unwound into the spill buffer; the import that
      // started it has stashed its Promise on us.
      this.exports.asyncify_stop_unwind();
      const value = await (this.pendingPromise as Promise<unknown>);
      this.pendingPromise = null;
      this.resumeValue = value;
      this.state = STATE_REWINDING;
      this.exports.asyncify_start_rewind(this.dataPtr);
      result = fn();
    }
    return result;
  }

  /**
   * Wrap an async JS function as a wasm-callable import that the wasm
   * sees as synchronous. First call: caches the Promise, kicks off
   * unwind, returns a placeholder (asyncify discards it during unwind).
   * Re-entry during rewind: returns the resolved value as if the
   * original call had returned synchronously.
   *
   * The wrapped function MUST always return a Promise resolving to a
   * value matching the wasm-side expected type (typically a pointer
   * the host has already allocated in wasm memory).
   */
  wrapAsyncImport<R>(
    impl: (...args: number[]) => Promise<R>,
    placeholder: R,
  ): (...args: number[]) => R {
    return (...args: number[]): R => {
      const exports = this.exports;
      if (exports === null) {
        throw new Error(
          "Asyncify import invoked before runtime init — call asyncify.init(exports) first",
        );
      }
      if (this.state === STATE_NORMAL) {
        this.pendingPromise = impl(...args);
        exports.asyncify_start_unwind(this.dataPtr);
        this.state = STATE_UNWINDING;
        // Placeholder: asyncify is unwinding the stack right now,
        // this return value is never observed by the wasm caller.
        return placeholder;
      }
      if (this.state === STATE_REWINDING) {
        exports.asyncify_stop_rewind();
        this.state = STATE_NORMAL;
        return this.resumeValue as R;
      }
      // STATE_UNWINDING and we're being called again — that's a bug
      // in the wrap discipline (the wasm shouldn't call us during its
      // own unwind). Surface clearly.
      throw new Error(
        `Asyncify.wrapAsyncImport: re-entered import during state=${this.state}`,
      );
    };
  }
}
