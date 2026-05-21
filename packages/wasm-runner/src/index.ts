/**
 * Public entry point for the wasm-runner package.
 *
 * Step 1 exposed the static `inspectWasm` schema inspector.
 * Step 2 adds the `WasmRunner` compile/instantiate path and the host
 * shim's error types so test code can `instanceof`-check them. Event
 * replay (`runner.replay(...)`) lands in a later step.
 */
export { inspectWasm } from "./inspect.ts";
export type { WasmSchema, WasmImport, WasmExport } from "./inspect.ts";
export { WasmRunner } from "./runner.ts";
export type {
  InstantiatedRunner,
  InstanceExports,
  WasmRuntimeExports,
} from "./runner.ts";
export { NotImplementedError, WasmAbortError, createHost } from "./host.ts";
export type { Host, MemoryHandle } from "./host.ts";
export { readAsString } from "./codec.ts";
