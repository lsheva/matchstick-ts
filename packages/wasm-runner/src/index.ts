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

export { Asyncify, applyAsyncifyTransform } from "./asyncify.ts";
export type { AsyncifyExports } from "./asyncify.ts";

export {
  decodeEntity,
  decodeValue,
  decodeSignedBigInt,
  ValueKind,
} from "./decode.ts";
export type {
  EntityFields,
  FieldValue,
  BigDecimal,
  UnknownValue,
  DecodeRuntime,
} from "./decode.ts";

export { EventBuilder, EthValueKind, encodeSignedBigInt } from "./event-builder.ts";
export type { EventBuilderExports } from "./event-builder.ts";

export { buildBundle } from "./build.ts";
export type { BuildBundleOptions } from "./build.ts";

export { ensureBundleBuilt, defaultBundleOutPath } from "./auto-build.ts";

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
  CapturedLog,
  CapturedEthCall,
  RpcClient,
} from "./host.ts";

export {
  parseGraphSignature,
  encodeCalldata,
  decodeReturnData,
  ethereumValueToJs,
  jsToValuePtr,
  UnsupportedAbiTypeError,
  GraphSignatureParseError,
} from "./abi.ts";
export type { ParsedSignature, AbiRuntime } from "./abi.ts";

export { makeViemRpc, makeViemLogSource } from "./viem-rpc.ts";
export type { ViemCallClient, ViemLogClient, ChainClient } from "./viem-rpc.ts";

export type { LogSource, RawLog, BlockSummary } from "./log-source.ts";

export {
  loadSubgraphYaml,
  findSubgraphYamlInAncestors,
  ManifestParseError,
} from "./load-yaml.ts";
export type { LoadedManifest } from "./load-yaml.ts";

export {
  MockRpcClient,
  MockCallBuilder,
  MockNotFoundError,
} from "./mock-rpc.ts";
export type { MockRpcClientOptions } from "./mock-rpc.ts";

export { Subgraph } from "./subgraph-runner.ts";
export type {
  SubgraphConfig,
  SubgraphSnapshot,
  SubgraphRunState,
  StartOptions,
  DataSourceSpec,
  EventHandlerSpec,
  BundleSpec,
  FireEventInput,
  ManifestSource,
  InlineManifest,
  DataSourcesOverride,
} from "./subgraph-runner.ts";

export type { EventContext } from "./event-builder.ts";

export { readAsString } from "./codec.ts";
