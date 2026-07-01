/**
 * `Subgraph` — high-level facade that hides the
 * `WasmRunner.compile().instantiate()` + EventBuilder + Host wiring
 * behind a `new Subgraph({...})` / `subgraph.fire(event)` API.
 *
 * Stage 1 surface (this file): bundle compile, programmatic event
 * firing with realistic block context, entity queries + snapshot,
 * reset, and a mock RPC layer reachable through `subgraph.mockCall`.
 *
 * Stage 2 (follow-up) will add `start({ fromBlock, toBlock })` / tail
 * mode that fetches logs from the configured `RpcClient` and
 * dispatches them automatically.
 *
 * Layering:
 *
 *     Subgraph                 (this file — orchestration)
 *       |
 *       +-- SubgraphInstance   (one wasm instance + Host + Asyncify)
 *       |
 *       +-- WasmRunner         (bytes -> instance, asyncify transform)
 *       |
 *       +-- EventBuilder       (JS -> wasm event allocation)
 *       |
 *       +-- MockRpcClient      (matchstick-parity mocks)
 *       |
 *       +-- Host               (graph-ts host imports)
 *
 * Consumers shouldn't need to reach below `Subgraph` for the common
 * test cases. `subgraph.host` / `subgraph.exports` remain public for
 * power users wiring up custom code paths.
 */
import { existsSync } from "node:fs";
import {
  decodeEventLog,
  toEventSelector,
  type Abi,
  type AbiEvent,
  type AbiParameter,
  type Hex,
} from "viem";
import { jsToValuePtr } from "./abi.ts";
import { ensureBundleBuilt } from "./auto-build.ts";
import {
  decodeEntity,
  type EntityFields,
} from "./decode.ts";
import {
  EventBuilder,
  type EventContext,
} from "./event-builder.ts";
import type { Host, RpcClient } from "./host.ts";
import type { LogSource, RawLog, BlockSummary } from "./log-source.ts";
import {
  findSubgraphYamlInAncestors,
  loadSubgraphYaml,
  type LoadedManifest,
} from "./load-yaml.ts";
import { MockRpcClient, type MockCallBuilder } from "./mock-rpc.ts";
import type { InstanceExports } from "./runner.ts";
import { WasmRunner } from "./runner.ts";
import type { SubgraphInstance } from "./subgraph.ts";
import {
  makeViemLogSource,
  makeViemRpc,
  type ChainClient,
} from "./viem-rpc.ts";

/** A handler binding inside a `DataSource`. */
export interface EventHandlerSpec {
  /**
   * Solidity event name (e.g. `"OrderCreated"`). Must match an
   * `AbiEvent` in the data source's `abi`.
   */
  event: string;
  /**
   * Handler export name in the wasm (e.g. `"handleOrderCreated"`).
   */
  handler: string;
}

/** One contract + its event-to-handler routing. */
export interface DataSourceSpec {
  /** Lower-cased automatically. */
  address: Hex;
  /**
   * viem-shape ABI. We only consume the `AbiEvent` entries today;
   * functions are used by `mockCall(...)` indirectly via
   * graph-cli signature strings.
   */
  abi: Abi;
  /** Optional start block (used by `start()` in Stage 2). */
  startBlock?: bigint;
  eventHandlers: EventHandlerSpec[];
}

/**
 * Bundle source for `Subgraph.create({ bundle })`.
 *
 *   - `string`      pre-built `.wasm` on disk
 *   - `Uint8Array`  raw bytes already in memory
 *   - `{ handlerEntry }`  compile-on-the-fly from an AS handler
 *     source file (under tsx/ts-node the compile transparently
 *     runs in a child process — see `auto-build.ts`)
 *
 * When omitted altogether, the runner auto-compiles the manifest's
 * first `mappingEntries[0]`. Pre-building once and caching the
 * resulting path remains the fastest option for tight test loops.
 */
export type BundleSpec =
  | string
  | Uint8Array
  | { handlerEntry: string; debug?: boolean; outPath?: string };

/**
 * Inline `{ dataSources, mappingEntries? }` object used as a
 * `subgraph:` override — skips YAML parsing entirely. Useful when
 * the data sources are programmatically generated.
 */
export interface InlineManifest {
  dataSources: DataSourceSpec[];
  /** Optional — only consumed when `bundle` is also omitted. */
  mappingEntries?: string[];
}

/**
 * Subgraph manifest source. Resolved by `Subgraph.create({ subgraph })`.
 *
 *  - `string`            path to a `subgraph.yaml` (relative paths
 *                        anchored at `process.cwd()`)
 *  - `LoadedManifest`    pre-loaded via `loadSubgraphYaml(...)`
 *  - `InlineManifest`    inline `{ dataSources, mappingEntries? }`
 *
 * Omitting `subgraph` triggers walking up from `process.cwd()` for
 * the first `subgraph.yaml`. Pass `false` to skip discovery (you
 * then need `dataSources` and `bundle` explicitly).
 */
export type ManifestSource = string | LoadedManifest | InlineManifest;

/**
 * Hook form of `dataSources` — receives the loaded manifest and
 * returns the actual data sources to feed the runner. Handy for the
 * common test pattern "patch the deployed address into the
 * manifest's defaults" without pre-loading the YAML yourself.
 */
export type DataSourcesOverride =
  | DataSourceSpec[]
  | ((
      manifest: LoadedManifest,
    ) => DataSourceSpec[] | Promise<DataSourceSpec[]>);

/** Top-level config for `Subgraph.create({...})`. */
export interface SubgraphConfig {
  /**
   * Subgraph manifest. Provides default `dataSources` and the
   * `mappingEntries[0]` used for auto-compile. Omit to walk up from
   * `process.cwd()` looking for `subgraph.yaml`; pass `false` to
   * disable discovery entirely.
   */
  subgraph?: ManifestSource | false;
  /**
   * Override the manifest's `dataSources`. Function form receives
   * the loaded manifest — typical use is patching the deployed
   * address in tests:
   *
   *     dataSources: (m) =>
   *       m.dataSources.map((ds) => ({ ...ds, address: deployed }))
   */
  dataSources?: DataSourcesOverride;
  /**
   * Wasm bundle source. When omitted, the runner auto-compiles
   * `manifest.mappingEntries[0]`. Compiles are memoized per
   * `(handlerEntry, debug)` for the lifetime of the process, so
   * repeated `Subgraph.create()` calls in one test file cost
   * effectively zero past the first.
   */
  bundle?: BundleSpec;
  /**
   * Chain client. Powers both `ethereum.call` (with revert
   * detection layered on top) and `subgraph.start()`'s log fetcher.
   *
   * Set to a viem `PublicClient` and you're done — it satisfies the
   * `ChainClient` interface structurally.
   *
   * When omitted:
   *   - every `eth_call` reverts (matchstick parity) unless an
   *     explicit `mockCall(...)` matches — handlers using `try_*`
   *     see `reverted=true`,
   *   - `start()` throws (no source for logs).
   *
   * For split transports (archive node for logs, light node for
   * calls; custom failover; etc.) wrap your providers into a single
   * object that implements `ChainClient` and pass that.
   */
  client?: ChainClient;
  /**
   * Custom log sink for graph-ts `log.*` calls. Defaults to silent —
   * tests typically prefer that. Forward to `console.log` to debug
   * a failing handler.
   */
  logSink?: (level: number, message: string) => void;
}

/**
 * Programmatic event input for `subgraph.fire(...)`. Reference a
 * configured data source by index, name the event by its solidity
 * name, and pass params keyed by the parameter name (event params
 * without a name aren't supported by this shape — use the lower
 * level `EventBuilder` directly for those).
 */
export interface FireEventInput {
  /** Index into `config.dataSources`. */
  dataSource: number;
  /** Solidity event name — must match an `AbiEvent` in the data source. */
  eventName: string;
  /**
   * Args by name in viem's input shape:
   *   - address          -> `0x...`
   *   - uintN / intN     -> `bigint`
   *   - bool             -> `boolean`
   *   - bytes / bytesN   -> `0x...`
   *   - string           -> `string`
   *   - T-array          -> `Array<T>`
   */
  params: Record<string, unknown>;
  /** Override `event.block.{number,timestamp,hash}` for this fire. */
  block?: EventContext["block"];
  /** Override `event.transaction.hash`. */
  transactionHash?: Hex;
  /** Override `event.logIndex`. */
  logIndex?: bigint;
}

/**
 * Snapshot of the entity store. Outer key = entity type name; inner
 * key = entity id. Returned by `subgraph.snapshot()` for diffing
 * across dispatches or comparing against a saved baseline.
 */
export type SubgraphSnapshot = Record<string, Record<string, EntityFields>>;

/**
 * Internal: indexed view of a `DataSourceSpec` for fast lookup at
 * fire time. Built once at `create` time so we don't re-scan ABIs
 * per event.
 */
interface CompiledDataSource {
  spec: DataSourceSpec;
  /** AbiEvent by event name, for fire(...) param encoding. */
  events: Map<string, AbiEvent>;
}

/**
 * One entry in the topic-router. Built at create time:
 *   `(addressLower, topic0Hash) -> { dataSource, abiEvent, handlerName }`.
 * Pre-resolves the AbiEvent + handler once so `start()`'s dispatch
 * loop stays O(1) per log.
 */
interface TopicRoute {
  dataSourceIndex: number;
  abiEvent: AbiEvent;
  handlerName: string;
  eventName: string;
}

/** Lifecycle states for the `start()`/`pause()`/`stop()` loop. */
export type SubgraphRunState = "idle" | "running" | "paused" | "stopping";

export interface StartOptions {
  /**
   * Block to start fetching from. Defaults to the minimum
   * `dataSources[].startBlock`, or `0n` if none specified.
   */
  fromBlock?: bigint;
  /**
   * Final block to dispatch (inclusive). When set, the `start()`
   * Promise resolves once that block has been processed and exits
   * cleanly — no tailing. When omitted, the loop tails head forever
   * (until `stop()`).
   */
  toBlock?: bigint;
  /**
   * Polling interval for tail mode (no `toBlock`). Default: 1000ms.
   */
  pollIntervalMs?: number;
  /**
   * Max blocks per `getLogs` request during backfill. Default 1000n.
   * Lower this if your RPC provider rejects wide ranges.
   */
  batchSize?: bigint;
}

export class Subgraph {
  private readonly compiledDataSources: CompiledDataSource[];
  /**
   * Topic-router built once at create time. Key:
   *   `${addressLower}|${topic0Hash}`
   * Value: pre-resolved `{ dataSourceIndex, abiEvent, handlerName }`.
   * Lookup is O(1) per log.
   */
  private readonly topicRoutes: Map<string, TopicRoute>;
  /**
   * Distinct lower-cased contract addresses across all data sources;
   * passed to `LogSource.getLogs({ addresses })`.
   */
  private readonly addresses: Hex[];
  /** Distinct event-signature hashes across all data sources. */
  private readonly topic0s: Hex[];
  private instance: SubgraphInstance;
  private builder: EventBuilder;
  private mockRpc: MockRpcClient;
  private readonly logSource: LogSource | null;
  private readonly logSink: (level: number, message: string) => void;

  /** Run-loop state machine — exposed via `runState` for tests + UIs. */
  private state: SubgraphRunState = "idle";
  /**
   * Resolves when the running loop exits — either because `toBlock`
   * was reached or `stop()` was called. `null` while the loop is
   * not active.
   */
  private startPromise: Promise<void> | null = null;
  /**
   * Last block fully processed (inclusive). `null` before `start()`
   * runs at least once.
   */
  private lastProcessedBlock: bigint | null = null;

  private constructor(
    instance: SubgraphInstance,
    compiledDataSources: CompiledDataSource[],
    topicRoutes: Map<string, TopicRoute>,
    addresses: Hex[],
    topic0s: Hex[],
    userRpc: RpcClient | null,
    logSource: LogSource | null,
    logSink: (level: number, message: string) => void,
  ) {
    this.instance = instance;
    this.compiledDataSources = compiledDataSources;
    this.topicRoutes = topicRoutes;
    this.addresses = addresses;
    this.topic0s = topic0s;
    this.logSource = logSource;
    this.logSink = logSink;
    this.builder = new EventBuilder(instance.exports);
    this.mockRpc = new MockRpcClient(
      userRpc === null
        ? { onMissing: "revert" }
        : { fallback: userRpc },
    );
    this.applyHostConfig();
  }

  /**
   * Build the wasm + wire host config in one step.
   *
   * Resolution order (each step short-circuits if the prior gave a
   * concrete value):
   *
   *   1. **Manifest**: `config.subgraph` if set (path / loaded /
   *      inline). Otherwise walk up from `process.cwd()` for
   *      `subgraph.yaml`. Pass `subgraph: false` to skip.
   *   2. **dataSources**: `config.dataSources` (array or function
   *      that receives the loaded manifest). Falls back to
   *      `manifest.dataSources`.
   *   3. **bundle**: `config.bundle` if set. Otherwise auto-compile
   *      `manifest.mappingEntries[0]` via `ensureBundleBuilt(...)`
   *      with the child-process fallback baked in.
   */
  static async create(config: SubgraphConfig = {}): Promise<Subgraph> {
    const manifest = await resolveManifest(config.subgraph);
    const dataSources = await resolveDataSources(
      config.dataSources,
      manifest,
    );
    const bytes = await resolveBundleBytes(config.bundle, manifest);
    // The WasmRunner only matters as a factory for the
    // SubgraphInstance — once we have the instance, we don't need to
    // hold a separate handle.
    const instance = await (await WasmRunner.compile(bytes)).instantiate();
    const compiled = dataSources.map(compileDataSource);
    const { routes, addresses, topic0s } = buildTopicRouter(compiled);
    const logSink = config.logSink ?? (() => {});
    // Fan out the single `client` into the two internal adapters.
    // `makeViemRpc` adds the revert-vs-network-error policy on top of
    // raw `client.call(...)`; `makeViemLogSource` normalizes the
    // log-fetch shape. Tests that want canned eth_call results plug
    // in via `mockCall(...)` rather than replacing the client.
    const userRpc: RpcClient | null = config.client
      ? makeViemRpc(config.client)
      : null;
    const logSource: LogSource | null = config.client
      ? makeViemLogSource(config.client)
      : null;
    return new Subgraph(
      instance,
      compiled,
      routes,
      addresses,
      topic0s,
      userRpc,
      logSource,
      logSink,
    );
  }

  /** Underlying wasm instance — power-user escape hatch. */
  get host(): Host {
    return this.instance.host;
  }

  /** Underlying wasm exports — power-user escape hatch. */
  get exports(): InstanceExports {
    return this.instance.exports;
  }

  /** The MockRpcClient powering `subgraph.mockCall(...)`. */
  get mocks(): MockRpcClient {
    return this.mockRpc;
  }

  /**
   * Begin registering a contract-call mock. Forwards to the embedded
   * `MockRpcClient`; see `MockCallBuilder` for the chained API.
   * Example:
   *
   *     subgraph
   *       .mockCall("0x...", "balanceOf(address):(uint256)")
   *       .withArgs(["0x..."])
   *       .returns([1234n]);
   */
  mockCall(address: Hex, signature: string): MockCallBuilder {
    return this.mockRpc.on(address, signature);
  }

  /**
   * Allocate the event in wasm and dispatch it through the matching
   * handler. The handler runs inside `subgraph.run()` so any async
   * `ethereum.call` inside it can suspend via asyncify.
   *
   * Handler resolution: looks up `eventName` in the data source's
   * `eventHandlers` to get the wasm export name. Throws if no
   * handler is registered (configuration bug, not a runtime
   * condition).
   */
  async fire(input: FireEventInput): Promise<void> {
    const source = this.compiledDataSources[input.dataSource];
    if (!source) {
      throw new Error(
        `Subgraph.fire: dataSource index ${input.dataSource} out of range (have ${this.compiledDataSources.length})`,
      );
    }
    const handlerName = source.spec.eventHandlers.find(
      (h) => h.event === input.eventName,
    )?.handler;
    if (!handlerName) {
      throw new Error(
        `Subgraph.fire: no handler registered for event "${input.eventName}" in dataSource ${input.dataSource} (address ${source.spec.address})`,
      );
    }
    const handler = this.instance.exports[handlerName];
    if (typeof handler !== "function") {
      throw new Error(
        `Subgraph.fire: wasm doesn't export "${handlerName}" — check the bundle was built against the correct mapping`,
      );
    }
    const abiEvent = source.events.get(input.eventName);
    if (!abiEvent) {
      throw new Error(
        `Subgraph.fire: ABI for dataSource ${input.dataSource} has no event "${input.eventName}"`,
      );
    }

    const paramPtrs = abiEvent.inputs.map((param) =>
      this.encodeParam(param, input.params),
    );
    const ctx: EventContext = {
      // Default `event.address` to the data source's address so
      // `event.address` reads inside the handler match the contract
      // the user mocked / pinned. Caller can still override per fire.
      address: source.spec.address,
    };
    if (input.block) ctx.block = input.block;
    if (input.transactionHash !== undefined) {
      ctx.transactionHash = input.transactionHash;
    }
    if (input.logIndex !== undefined) ctx.logIndex = input.logIndex;
    const eventPtr = this.builder.buildEvent(paramPtrs, ctx);

    // Pin the host's blockNumber so any ethereum.call inside the
    // handler routes to the same block — matches graph-node's
    // "block currently being processed" semantics. `null` falls
    // through to `latest` if the user later wires a real RPC.
    const previousBlockNumber = this.instance.host.blockNumber;
    if (input.block?.number !== undefined) {
      this.instance.host.blockNumber = input.block.number;
    }
    try {
      await this.instance.run(() =>
        (handler as (eventPtr: number) => unknown)(eventPtr),
      );
    } finally {
      this.instance.host.blockNumber = previousBlockNumber;
    }
  }

  /**
   * Read a single entity. Walks wasm memory each call — there's no
   * hidden cache, so the result reflects the latest `store.set`.
   * Returns `null` if the entity doesn't exist.
   */
  entity(entityType: string, id: string): EntityFields | null {
    const ptr = this.instance.host.store.get(entityType)?.get(id);
    if (ptr === undefined || ptr === 0) return null;
    return decodeEntity(this.instance.exports, ptr);
  }

  /**
   * Read every entity of `entityType`, keyed by id. Returns an empty
   * object if the type has no entities yet.
   */
  entities(entityType: string): Record<string, EntityFields> {
    const byId = this.instance.host.store.get(entityType);
    if (!byId) return {};
    const out: Record<string, EntityFields> = {};
    for (const [id, ptr] of byId) {
      const decoded = decodeEntity(this.instance.exports, ptr);
      if (decoded !== null) out[id] = decoded;
    }
    return out;
  }

  /**
   * Decode the entire entity store into a plain JS object. Suitable
   * for diffing against a baseline snapshot or for serializing as
   * test fixtures. The result is a fresh copy — mutating it doesn't
   * affect wasm state.
   */
  snapshot(): SubgraphSnapshot {
    const out: SubgraphSnapshot = {};
    for (const entityType of this.instance.host.store.keys()) {
      out[entityType] = this.entities(entityType);
    }
    return out;
  }

  /**
   * Wipe the entity store, reset capture buffers, and rebuild the
   * underlying wasm so AS-side `_start()` initializers re-run. Mocks
   * registered via `mockCall(...)` are preserved (call `mocks.clear()`
   * separately if you want them gone).
   */
  async reset(): Promise<void> {
    await this.instance.reset();
    this.builder = new EventBuilder(this.instance.exports);
    this.applyHostConfig();
  }

  /** Current run-loop state. */
  get runState(): SubgraphRunState {
    return this.state;
  }

  /** Last block fully processed by the run loop, or `null` if untouched. */
  get processedBlock(): bigint | null {
    return this.lastProcessedBlock;
  }

  /**
   * Drive the configured `LogSource`: fetch logs in batches from
   * `fromBlock` to `toBlock` (or to head + tail if `toBlock` is
   * omitted), decode them against the data-source ABIs, and fire
   * the matching handler for each.
   *
   * Resolves when:
   *   - `toBlock` is reached (range mode), or
   *   - `stop()` is called (tail mode).
   *
   * `pause()` halts further dispatches without exiting the loop;
   * `resume()` continues. Calling `start()` while already running
   * throws — there's only one loop per Subgraph.
   */
  async start(options: StartOptions = {}): Promise<void> {
    // Async wrapper so validation errors surface as rejected
    // promises (matching `assert.rejects` semantics in tests and
    // letting callers `.catch` instead of bracketing in try/catch).
    if (this.state !== "idle") {
      throw new Error(
        `Subgraph.start: already ${this.state} — call stop() before starting again`,
      );
    }
    if (!this.logSource) {
      throw new Error(
        "Subgraph.start: no `logSource` configured — pass one in `Subgraph.create({ logSource: makeViemLogSource(client) })`, or use `subgraph.fire(...)` for manual dispatch",
      );
    }
    const fromBlock = options.fromBlock ?? this.minStartBlock();
    const toBlock = options.toBlock;
    const pollIntervalMs = options.pollIntervalMs ?? 1000;
    const batchSize = options.batchSize ?? 1000n;
    if (batchSize <= 0n) {
      throw new Error(`Subgraph.start: batchSize must be > 0, got ${batchSize}`);
    }
    this.state = "running";
    this.startPromise = this.runLoop(this.logSource, {
      fromBlock,
      toBlock,
      pollIntervalMs,
      batchSize,
    });
    await this.startPromise;
  }

  /**
   * Halt dispatches after the current in-flight handler finishes.
   * The run-loop stays alive — `resume()` continues from
   * `processedBlock + 1`. No-op if not running.
   */
  pause(): void {
    if (this.state === "running") this.state = "paused";
  }

  /** Continue the loop after `pause()`. No-op if not paused. */
  resume(): void {
    if (this.state === "paused") this.state = "running";
  }

  /**
   * Exit the run-loop at the next safe point and resolve `start()`'s
   * Promise. Idempotent / safe to call when not running.
   */
  async stop(): Promise<void> {
    if (this.state === "idle") return;
    this.state = "stopping";
    if (this.startPromise) await this.startPromise;
  }

  // --- Internal helpers ---

  /**
   * Lowest block across all configured data sources, or `0n`. Used
   * as the default `fromBlock` for `start()`.
   */
  private minStartBlock(): bigint {
    let min: bigint | null = null;
    for (const ds of this.compiledDataSources) {
      if (ds.spec.startBlock !== undefined) {
        if (min === null || ds.spec.startBlock < min) min = ds.spec.startBlock;
      }
    }
    return min ?? 0n;
  }

  /**
   * Core dispatch loop. Backfill (or range) phase + tail phase share
   * one body — the head moves with each `getBlockNumber()` poll
   * unless a fixed `toBlock` was given.
   */
  private async runLoop(
    logSource: LogSource,
    opts: {
      fromBlock: bigint;
      toBlock: bigint | undefined;
      pollIntervalMs: number;
      batchSize: bigint;
    },
  ): Promise<void> {
    try {
      let cursor = opts.fromBlock;
      // TS narrows `this.state` aggressively inside the loop body
      // even though `pause()` / `stop()` mutate it from the outside
      // between awaits. Read through a widened alias each iteration
      // so the comparisons against all four states stay legal.
      const stateOf = (): SubgraphRunState => this.state;
      while (stateOf() !== "stopping" && stateOf() !== "idle") {
        if (stateOf() === "paused") {
          await sleep(50);
          continue;
        }
        // Determine the upper bound for this batch. Range mode caps
        // at toBlock; tail mode caps at the latest block on every
        // iteration so we drain backfill, then poll.
        const head = await logSource.getBlockNumber();
        const ceiling = opts.toBlock !== undefined ? opts.toBlock : head;
        if (cursor > ceiling) {
          if (opts.toBlock !== undefined) {
            // Range mode complete.
            break;
          }
          // Tail mode: nothing new yet, sleep then re-poll.
          await sleep(opts.pollIntervalMs);
          continue;
        }
        const batchEnd =
          cursor + opts.batchSize - 1n < ceiling
            ? cursor + opts.batchSize - 1n
            : ceiling;
        const logs = await logSource.getLogs({
          addresses: this.addresses,
          topics: this.topic0s.length > 0 ? [this.topic0s] : undefined,
          fromBlock: cursor,
          toBlock: batchEnd,
        });
        // Cache block summaries for this batch — most batches have
        // far fewer unique blocks than logs.
        const blockCache = new Map<bigint, BlockSummary>();
        for (const log of logs) {
          if (stateOf() === "stopping" || stateOf() === "idle") break;
          while (stateOf() === "paused") await sleep(50);
          let block = blockCache.get(log.blockNumber);
          if (block === undefined) {
            block = await logSource.getBlock(log.blockNumber);
            blockCache.set(log.blockNumber, block);
          }
          await this.dispatchLog(log, block);
        }
        if (stateOf() === "stopping" || stateOf() === "idle") break;
        this.lastProcessedBlock = batchEnd;
        cursor = batchEnd + 1n;
      }
    } finally {
      this.state = "idle";
      this.startPromise = null;
    }
  }

  /**
   * Decode a raw log against the matching data-source ABI and fire
   * the registered handler. Block context is stamped from the
   * cached `BlockSummary` so handlers reading
   * `event.block.{number,timestamp,hash}` see real values.
   */
  private async dispatchLog(log: RawLog, block: BlockSummary): Promise<void> {
    if (log.topics.length === 0) return;
    const key = routerKey(log.address, log.topics[0]);
    const route = this.topicRoutes.get(key);
    if (!route) {
      // Log emitted by an address we DO listen on but with a topic
      // we don't have a handler for. Skip silently — graph-node
      // does the same for unsubscribed events on the same contract.
      return;
    }
    const decoded = decodeEventLog({
      abi: [route.abiEvent],
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    });
    // viem returns `args` as either an array (positional) or an
    // object (when all inputs are named). graph-cli ABIs have
    // named inputs, so we normalize to an object — falling back to
    // array indexing for the rare nameless input.
    const params = paramsFromDecoded(route.abiEvent, decoded.args);
    await this.fire({
      dataSource: route.dataSourceIndex,
      eventName: route.eventName,
      params,
      block: {
        number: block.number,
        timestamp: block.timestamp,
        hash: block.hash,
      },
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
    });
  }

  /**
   * Apply config-derived host settings. Run after every fresh
   * instance (initial build + each `reset()`). Mock layer is rebuilt
   * with the same user-supplied fallback so mocks registered against
   * the OLD instance continue to match calls from the NEW one.
   */
  private applyHostConfig(): void {
    this.instance.host.logSink = this.logSink;
    // Re-hand the existing entries to the new wasm — the
    // MockRpcClient is JS-side state, not wasm-side, so it survives
    // a `reset()`. We just need to re-bind it as host.rpcClient.
    this.instance.host.rpcClient = this.mockRpc;
  }

  /**
   * Encode a single AbiEvent param into an `ethereum.EventParam` ptr
   * (name + Value), looking up the JS arg by the param's name in
   * `params`. We don't handle nameless tuple components yet — that
   * path lives in the lower-level `EventBuilder` for callers that
   * need it.
   */
  private encodeParam(
    param: AbiParameter,
    params: Record<string, unknown>,
  ): number {
    const name = param.name;
    if (!name) {
      throw new Error(
        `Subgraph.fire: ABI param has no name (type "${param.type}") — pass it via the lower-level EventBuilder API or fix the ABI`,
      );
    }
    if (!(name in params)) {
      throw new Error(
        `Subgraph.fire: missing param "${name}" (type "${param.type}")`,
      );
    }
    const valuePtr = jsToValuePtr(this.builder, params[name], param.type);
    return this.builder.param(name, valuePtr);
  }
}

function compileDataSource(spec: DataSourceSpec): CompiledDataSource {
  const events = new Map<string, AbiEvent>();
  for (const item of spec.abi) {
    if (item.type === "event") {
      events.set(item.name, item);
    }
  }
  return { spec, events };
}

/**
 * Build the `(addressLower, topic0Hash) -> route` lookup table once
 * at create() time. The dispatcher leans on this for every log it
 * sees, so doing the keccak / signature work upfront is the
 * difference between O(handlers) and O(1) per log.
 *
 * Also returns the de-duped address + topic-hash sets so the run
 * loop can pass them straight to `LogSource.getLogs(...)` without
 * reconstructing them every batch.
 */
function buildTopicRouter(compiled: CompiledDataSource[]): {
  routes: Map<string, TopicRoute>;
  addresses: Hex[];
  topic0s: Hex[];
} {
  const routes = new Map<string, TopicRoute>();
  const addressSet = new Set<Hex>();
  const topicSet = new Set<Hex>();
  for (let i = 0; i < compiled.length; i++) {
    const ds = compiled[i];
    const addressLower = ds.spec.address.toLowerCase() as Hex;
    addressSet.add(addressLower);
    for (const handler of ds.spec.eventHandlers) {
      const abiEvent = ds.events.get(handler.event);
      if (!abiEvent) {
        throw new Error(
          `Subgraph.create: dataSource[${i}] (${ds.spec.address}) registers handler "${handler.handler}" for event "${handler.event}" but the ABI has no such event`,
        );
      }
      const topic0 = toEventSelector(abiEvent);
      topicSet.add(topic0);
      const key = routerKey(addressLower, topic0);
      const existing = routes.get(key);
      if (existing) {
        // Two handlers on the same (address, topic0) means an
        // ambiguous routing — graph-node enforces unique handler
        // per event, so we mirror that rule.
        throw new Error(
          `Subgraph.create: duplicate handler for (address ${addressLower}, event ${handler.event}). Existing: "${existing.handlerName}", new: "${handler.handler}"`,
        );
      }
      routes.set(key, {
        dataSourceIndex: i,
        abiEvent,
        handlerName: handler.handler,
        eventName: handler.event,
      });
    }
  }
  return {
    routes,
    addresses: Array.from(addressSet),
    topic0s: Array.from(topicSet),
  };
}

function routerKey(address: Hex, topic0: Hex): string {
  return `${address.toLowerCase()}|${topic0.toLowerCase()}`;
}

/**
 * Convert viem's `decodeEventLog` args (array OR object) into the
 * name-keyed object `Subgraph.fire` wants. graph-cli ABIs always
 * include parameter names, but anonymous params do happen — fall
 * back to positional `arg{i}` keys for those (matching graph-cli's
 * own behavior).
 */
function paramsFromDecoded(
  abiEvent: AbiEvent,
  args: readonly unknown[] | Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (args === undefined) return {};
  if (Array.isArray(args)) {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < abiEvent.inputs.length; i++) {
      const name = abiEvent.inputs[i].name || `arg${i}`;
      out[name] = args[i];
    }
    return out;
  }
  return args as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Walk `config.subgraph` to a `LoadedManifest`, or `null` if the
 * caller opted out (`false`) and no manifest can be discovered.
 *
 * Inline objects (no `specVersion`) are wrapped into a minimal
 * manifest with empty `schemaFile` / `specVersion` so downstream
 * code can treat the result uniformly.
 */
async function resolveManifest(
  spec: SubgraphConfig["subgraph"],
): Promise<LoadedManifest | null> {
  if (spec === false) return null;
  if (typeof spec === "string") return loadSubgraphYaml(spec);
  if (spec !== undefined) {
    // `LoadedManifest` carries `specVersion`; the inline form does not.
    if ("specVersion" in spec && "mappingEntries" in spec) {
      return spec;
    }
    const inline = spec as InlineManifest;
    return {
      dataSources: inline.dataSources,
      mappingEntries: inline.mappingEntries ?? [],
      schemaFile: "",
      specVersion: "",
    };
  }
  // Auto-discover from cwd. Missing manifest is not an error here —
  // it's only fatal later if neither `dataSources` nor `bundle` is
  // provided to fill in for it.
  const found = findSubgraphYamlInAncestors();
  return found ? loadSubgraphYaml(found) : null;
}

async function resolveDataSources(
  override: DataSourcesOverride | undefined,
  manifest: LoadedManifest | null,
): Promise<DataSourceSpec[]> {
  if (override !== undefined) {
    if (typeof override === "function") {
      if (!manifest) {
        throw new Error(
          "Subgraph.create: dataSources is a function but no manifest was resolved — pass `subgraph` explicitly or provide an array.",
        );
      }
      return await override(manifest);
    }
    return override;
  }
  if (manifest) return manifest.dataSources;
  throw new Error(
    "Subgraph.create: no `dataSources` and no manifest found. Pass `subgraph: '<path/to/subgraph.yaml>'`, place a `subgraph.yaml` in an ancestor of cwd, or provide `dataSources` directly.",
  );
}

async function resolveBundleBytes(
  spec: BundleSpec | undefined,
  manifest: LoadedManifest | null,
): Promise<Uint8Array | string> {
  if (spec === undefined) {
    const entry = manifest?.mappingEntries[0];
    if (!entry) {
      throw new Error(
        "Subgraph.create: no `bundle` provided and the resolved manifest has no `mappingEntries` to compile from. Pass `bundle: '<path/to/build.wasm>'` or `bundle: { handlerEntry: '<path/to/mapping.ts>' }`.",
      );
    }
    return ensureBundleBuilt({ handlerEntry: entry });
  }
  if (typeof spec === "string") {
    if (!existsSync(spec)) {
      throw new Error(`Subgraph.create: bundle path not found: ${spec}`);
    }
    return spec;
  }
  if (spec instanceof Uint8Array) return spec;
  if ("handlerEntry" in spec) {
    return ensureBundleBuilt({
      handlerEntry: spec.handlerEntry,
      outPath: spec.outPath,
      debug: spec.debug,
    });
  }
  throw new Error(
    "Subgraph.create: bundle must be a path, Uint8Array, or { handlerEntry } config",
  );
}
