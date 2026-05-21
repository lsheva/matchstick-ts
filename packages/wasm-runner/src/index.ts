/**
 * Public entry point for the wasm-runner package.
 *
 * Public surface, by intended audience:
 *
 *   Consumers writing tests:
 *     - `WasmRunner.compile(path)` + `runner.instantiate() -> SubgraphInstance`
 *     - `subgraph.dispatch(...)` (via test-driver `fire*` exports, today)
 *     - `subgraph.entity(type, id)` / `subgraph.entities(type)`
 *     - `subgraph.reset()`
 *     - `EntityFields`, `FieldValue`, `ValueKind`
 *
 *   Power users / lower-level integrations:
 *     - `subgraph.exports` (loader-extended wasm exports)
 *     - `subgraph.host` (capture buffers + JS-side entity store)
 *     - `inspectWasm(path)` — static schema introspection
 *     - `decodeEntity(runtime, ptr)` — manual decode
 *     - `readAsString(memory, ptr)` — raw UTF-16 read
 *     - Error types: `NotImplementedError`, `WasmAbortError`
 */
export { WasmRunner } from "./runner.ts";
export type { InstanceExports } from "./runner.ts";

export { SubgraphInstance } from "./subgraph.ts";
export type { InstanceFactory } from "./subgraph.ts";

export {
  decodeEntity,
  decodeValue,
  decodeSignedBigInt,
  ValueKind,
} from "./decode.ts";
export type {
  EntityFields,
  FieldValue,
  UnknownValue,
  DecodeRuntime,
} from "./decode.ts";

export { inspectWasm } from "./inspect.ts";
export type { WasmSchema, WasmImport, WasmExport } from "./inspect.ts";

export {
  createHost,
  NotImplementedError,
  WasmAbortError,
} from "./host.ts";
export type {
  Host,
  HostCaptured,
  HostRuntime,
  CapturedStoreGet,
  CapturedStoreSet,
} from "./host.ts";

export { readAsString } from "./codec.ts";
