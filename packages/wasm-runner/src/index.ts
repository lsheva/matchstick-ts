/**
 * Public entry point for the wasm-runner package.
 *
 * Currently exposes only the static schema inspector. The full
 * `WasmRunner` class (compile + replay) lands in a later step.
 */
export { inspectWasm } from "./inspect.ts";
export type { WasmSchema, WasmImport, WasmExport } from "./inspect.ts";
