/**
 * Incremental chain log ingestion for subgraph snapshot tests.
 * Fetches via `eth_getLogs`, decodes with ABIs from {@link bind}, and
 * accumulates {@link CapturedEvent}s for {@link runMatchstickTest}.
 */
import { parseEventLogs, type Abi, type Address, type Log } from "viem";
import {
  captureViewMocksFromContract,
  serializeParams,
  viewFunctionRevertMocks,
  type CallMock,
  type CapturedEvent,
  type ViewCallingClient,
} from "./event-capture.ts";
import {
  cleanupGeneratedFiles,
  DEFAULT_TMP_DIR,
  indexResultsFromSnapshot,
  runMatchstickTest,
  type AugmentedDataSources,
  type AugmentedEntities,
  type EntityRef,
  type IndexResults,
  type RunOptions,
  type Snapshot,
} from "./snapshot.ts";

/** Minimal RPC surface for block head + log filters (viem `PublicClient` satisfies this). */
export interface LogsQueryingClient {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    address: Address | readonly Address[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly Log[]>;
}

export interface DataSourceBinding {
  name: string;
  address: Address;
  abi: Abi;
}

/** Block range and data sources for {@link SubgraphLogSync.ingest}. */
export interface IngestOptions {
  fromBlock?: bigint;
  toBlock?: bigint | "latest";
  dataSources?: readonly AugmentedDataSources[];
}

export interface IngestStats {
  fromBlock: bigint;
  toBlock: bigint;
  newEvents: number;
  totalEvents: number;
}

type RunDefaults<TEntities> = Omit<
  RunOptions<TEntities>,
  "events" | "reads" | "callMocks" | "revertMocks"
>;

/** Options for {@link SubgraphLogSync.index} (log ingest range + Matchstick run overrides). */
export interface IndexOptions<TEntities = AugmentedEntities> extends IngestOptions {
  run?: RunDefaults<TEntities>;
}

export interface SubgraphLogSyncOptions<TEntities = AugmentedEntities> {
  client: LogsQueryingClient;
  /**
   * Optional view-call client used to capture realistic `try_*` return
   * values for bound contracts. When set, every {@link SubgraphLogSync.bind}
   * call kicks off an `eth_call` sweep against this client and registers a
   * `return` mock per 0-arg view function (falling back to a `revert` mock
   * if the call reverts). Override per-bind via `bind(..., { viewClient })`.
   */
  viewClient?: ViewCallingClient;
  /** First ingest when never synced and no explicit `fromBlock`. Default `0`. */
  startBlock?: bigint;
  runDefaults?: RunDefaults<TEntities>;
}

function mockKey(mock: CallMock): string {
  return `${mock.address}:${mock.signature}`;
}

function decodeLogs(logs: readonly Log[], abi: Abi): CapturedEvent[] {
  const captured: CapturedEvent[] = [];

  for (const log of parseEventLogs({ logs: [...logs] as Log[], abi })) {
    if (log.blockNumber == null || log.transactionHash == null) {
      continue;
    }
    captured.push({
      event: log.eventName,
      address: log.address,
      blockNumber: Number(log.blockNumber),
      logIndex: log.logIndex ?? 0,
      transactionHash: log.transactionHash,
      params: serializeParams(log.args),
    });
  }

  captured.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) {
      return a.blockNumber - b.blockNumber;
    }
    if (a.transactionHash !== b.transactionHash) {
      return a.transactionHash.localeCompare(b.transactionHash);
    }
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });

  return captured;
}

function sortCaptured(events: CapturedEvent[]): CapturedEvent[] {
  return [...events].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) {
      return a.blockNumber - b.blockNumber;
    }
    return a.transactionHash.localeCompare(b.transactionHash);
  });
}

/**
 * Stateful subgraph test indexer.
 *
 * - {@link ingest} incrementally appends chain logs to an in-memory buffer.
 * - {@link index} always replays the **entire** buffer from the first event (Matchstick
 *   has no incremental store between calls). Log fetching alone is incremental via
 *   {@link lastSyncedBlock}.
 */
export class SubgraphLogSync<TEntities = AugmentedEntities> {
  private readonly client: LogsQueryingClient;
  private readonly defaultViewClient: ViewCallingClient | undefined;
  private readonly startBlock: bigint;
  private readonly runDefaults: RunDefaults<TEntities>;
  private readonly bindings = new Map<string, DataSourceBinding>();
  private callMocks = new Map<string, CallMock>();
  /**
   * In-flight `eth_call` sweeps kicked off from {@link bind}; awaited inside
   * {@link ingest}/{@link index}/{@link indexSnapshot} so callers don't need
   * to await `bind()` to ensure the mock map is populated before the next
   * Matchstick run.
   */
  private pendingMockPopulation: Promise<void>[] = [];
  /**
   * Monotonic counter bumped on every {@link reset}. Each {@link bind} closes
   * over the current value so a sweep that settles AFTER a reset is dropped
   * instead of leaking into the next test's mock map.
   */
  private bindGeneration = 0;
  private events: CapturedEvent[] = [];
  private syncedBlock: bigint | undefined;

  constructor(options: SubgraphLogSyncOptions<TEntities>) {
    this.client = options.client;
    this.defaultViewClient = options.viewClient;
    this.startBlock = options.startBlock ?? 0n;
    this.runDefaults = (options.runDefaults ?? {}) as RunDefaults<TEntities>;
  }

  /**
   * Last block fully ingested via {@link ingest} (`undefined` if never ingested).
   * This is only the `eth_getLogs` cursor — not subgraph sync state.
   */
  get lastSyncedBlock(): bigint | undefined {
    return this.syncedBlock;
  }

  /** Buffered events; {@link index} replays this entire array on every call. */
  get eventCount(): number {
    return this.events.length;
  }

  /**
   * Register a deployed contract as a subgraph data source.
   *
   * - Records the (address, abi) so {@link ingest} can fetch & decode logs.
   * - Seeds every 0-arg view/pure function as a `revert` mock so handlers
   *   doing best-effort `try_*` reads don't crash Matchstick on "no mocked
   *   function".
   * - When `options.viewClient` is supplied, asynchronously upgrades those
   *   revert mocks to `return` mocks carrying the *real* on-chain return
   *   value. The sweep runs in the background; {@link ingest} / {@link index}
   *   await it transparently before each Matchstick run, so callers don't
   *   need to await `bind()` itself.
   */
  bind(
    dataSource: AugmentedDataSources,
    address: Address,
    abi: Abi,
    options: { viewClient?: ViewCallingClient } = {},
  ): this {
    this.bindings.set(dataSource, { name: dataSource, address, abi });
    for (const mock of viewFunctionRevertMocks(abi, address)) {
      this.callMocks.set(mockKey(mock), mock);
    }
    const viewClient = options.viewClient ?? this.defaultViewClient;
    if (viewClient !== undefined) {
      // Pin to the current `callMocks` map and `bindGeneration` so a sweep
      // that settles AFTER `reset()` (which swaps the map and bumps the
      // generation) cannot leak mocks into the next test's state.
      const targetMap = this.callMocks;
      const targetGeneration = this.bindGeneration;
      this.pendingMockPopulation.push(
        captureViewMocksFromContract(viewClient, abi, address).then((mocks) => {
          if (targetGeneration !== this.bindGeneration) return;
          for (const mock of mocks) {
            targetMap.set(mockKey(mock), mock);
          }
        }),
      );
    }
    return this;
  }

  /**
   * Await any in-flight view-call sweeps queued by {@link bind}. Called
   * automatically by {@link ingest}, {@link index}, and {@link indexSnapshot}
   * — exposed for tests that want to inspect {@link callMocks} directly.
   */
  async awaitMockPopulation(): Promise<void> {
    while (this.pendingMockPopulation.length > 0) {
      const pending = this.pendingMockPopulation;
      this.pendingMockPopulation = [];
      await Promise.all(pending);
    }
  }

  /**
   * Set the cursor to the current chain head without ingesting logs.
   * Clears the event buffer so the next ingest only sees logs after this point.
   */
  async anchor(): Promise<bigint> {
    const head = await this.client.getBlockNumber();
    this.syncedBlock = head;
    this.events = [];
    return head;
  }

  /**
   * Append new logs from bound contracts (`eth_getLogs`) to the in-memory buffer.
   * Does not run the subgraph mapping — use {@link index} for that.
   */
  async ingest(options: IngestOptions = {}): Promise<IngestStats> {
    await this.awaitMockPopulation();
    const toBlock =
      options.toBlock === undefined || options.toBlock === "latest"
        ? await this.client.getBlockNumber()
        : options.toBlock;

    const fromBlock =
      options.fromBlock ??
      (this.syncedBlock === undefined ? this.startBlock : this.syncedBlock + 1n);

    if (fromBlock > toBlock) {
      return {
        fromBlock,
        toBlock,
        newEvents: 0,
        totalEvents: this.events.length,
      };
    }

    const sources = this.resolveBindings(options.dataSources);
    if (sources.length === 0) {
      throw new Error(
        "SubgraphLogSync.ingest: no bindings — call bind(dataSource, address, abi) first",
      );
    }

    const batch: CapturedEvent[] = [];
    for (const source of sources) {
      const logs = await this.client.getLogs({
        address: source.address,
        fromBlock,
        toBlock,
      });
      const decoded = decodeLogs(logs, source.abi);
      batch.push(...decoded);
    }

    const before = this.events.length;
    this.events = sortCaptured([...this.events, ...batch]);
    this.syncedBlock = toBlock;

    return {
      fromBlock,
      toBlock,
      newEvents: this.events.length - before,
      totalEvents: this.events.length,
    };
  }

  /**
   * Ingest any new chain logs, then replay **all** buffered events from the beginning
   * through the subgraph mapping in Matchstick (fresh WASM store every call).
   *
   * Returns one store row per ref in the same order as `reads` (`null` if that id
   * was requested but not in the store after replay).
   */
  async index<const R extends readonly EntityRef<TEntities>[]>(
    reads: R,
    options: IndexOptions<TEntities> = {},
  ): Promise<IndexResults<TEntities, R>> {
    const { run: runOverrides, ...ingestOptions } = options;
    await this.ingest(ingestOptions);

    const snapshot = await runMatchstickTest<TEntities>({
      ...this.runDefaults,
      ...runOverrides,
      events: this.events,
      reads: [...reads],
      callMocks: [...this.callMocks.values()],
    });

    return indexResultsFromSnapshot(snapshot, reads);
  }

  /**
   * Like {@link index}, but returns the full {@link Snapshot} instead of
   * aligned `IndexResults`. Use this when you need {@link Snapshot.discoveredIds}
   * to find entity IDs that were not known upfront.
   *
   * @example
   *   const snap = await conn.matchstick.indexSnapshot([]);
   *   const ids = snap.discoveredIds("Order");   // IDs created during replay
   *   snap.entity("Order", ids[0]);              // full entity data, no second run
   */
  async indexSnapshot<const R extends readonly EntityRef<TEntities>[]>(
    reads: R,
    options: IndexOptions<TEntities> = {},
  ): Promise<Snapshot<TEntities>> {
    const { run: runOverrides, ...ingestOptions } = options;
    await this.ingest(ingestOptions);
    return runMatchstickTest<TEntities>({
      ...this.runDefaults,
      ...runOverrides,
      events: this.events,
      reads: [...reads],
      callMocks: [...this.callMocks.values()],
    });
  }

  /**
   * Clear in-memory state AND remove generated test artifacts (the AS runner
   * file and the JSON IO directory). Intended for `after()` hooks so a
   * subsequent `graph test` run doesn't accidentally pick up the auto-
   * generated `tests/runner.test.ts`.
   *
   * Honors `KEEP_TEMP=1` — see {@link cleanupGeneratedFiles}.
   */
  async reset(): Promise<void> {
    this.bindings.clear();
    // Swap in a fresh map (not `.clear()`) so any in-flight mock-population
    // promises that resolve after this point write into the orphaned map
    // and not the new one. The generation bump below ensures the early-out
    // guard in `bind()`'s callback catches them too.
    this.callMocks = new Map();
    this.pendingMockPopulation = [];
    this.bindGeneration++;
    this.events = [];
    this.syncedBlock = undefined;
    await cleanupGeneratedFiles({
      runnerPath: this.runDefaults.runnerPath ?? "tests/runner.test.ts",
      jsonDir: this.runDefaults.jsonDir ?? DEFAULT_TMP_DIR,
    });
  }

  private resolveBindings(names: readonly AugmentedDataSources[] | undefined): DataSourceBinding[] {
    if (names === undefined) {
      return [...this.bindings.values()];
    }
    return names.map((name) => {
      const binding = this.bindings.get(name);
      if (binding === undefined) {
        throw new Error(`SubgraphLogSync: unknown data source "${name}"`);
      }
      return binding;
    });
  }
}
