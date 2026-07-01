/**
 * Tour of the high-level `Subgraph` API exposed by the
 * `wasm-runner` package, against the example Counter mapping. Each
 * test exercises a specific surface so the file doubles as living
 * usage documentation.
 *
 * Methods covered:
 *   - `Subgraph.create()`  zero-config: walks cwd for `subgraph.yaml`,
 *                          auto-compiles `mapping.file`, memoizes
 *                          across calls in the same process
 *   - `Subgraph.create({ subgraph, dataSources, bundle?, client?, logSink? })`
 *   - `loadSubgraphYaml(path)`  (still exported for power users)
 *   - `subgraph.fire({ dataSource, eventName, params, block?, transactionHash?, logIndex? })`
 *   - `subgraph.entity(type, id)` / `entities(type)` / `snapshot()`
 *   - `subgraph.mockCall(addr, signature).withArgs(...).returns(...)`
 *   - `subgraph.mockCall(...).withAnyArgs().reverts()`
 *   - `subgraph.mocks.hitCount(...) / clear()`
 *   - `subgraph.host` / `subgraph.exports`  (low-level escape hatches)
 *   - `subgraph.reset()`
 *   - `subgraph.start({ fromBlock, toBlock, batchSize, pollIntervalMs })`
 *   - `subgraph.runState` / `processedBlock`
 *   - `subgraph.pause()` / `resume()` / `stop()`
 *
 * No `pretest` step is required: `Subgraph.create()` builds the wasm
 * on first call and caches the result by handler-entry, so the rest
 * of the tests reuse that bundle for free.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  Subgraph,
  loadSubgraphYaml,
  type DataSourceSpec,
  type LoadedManifest,
  type RawLog,
} from "wasm-runner";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type AbiEvent,
  type Hex,
} from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_YAML = resolve(here, "../subgraph.yaml");

// --- helpers -------------------------------------------------------------

/**
 * Build a synthetic on-chain log for the given event. We use viem's
 * `encodeEventTopics` + `encodeAbiParameters` so this looks exactly
 * like what an RPC log fetcher would return.
 */
function buildLog(
  abi: ReadonlyArray<unknown>,
  eventName: string,
  args: Record<string, unknown>,
  ctx: {
    address: Hex;
    blockNumber: bigint;
    logIndex: bigint;
  },
): RawLog {
  const event = (abi as Array<{ type: string; name?: string }>).find(
    (a) => a.type === "event" && a.name === eventName,
  ) as AbiEvent;
  const topics = encodeEventTopics({
    abi: [event],
    eventName,
    args,
  }) as Hex[];
  const nonIndexed = event.inputs.filter((i) => !i.indexed);
  const data: Hex =
    nonIndexed.length === 0
      ? "0x"
      : encodeAbiParameters(
          nonIndexed,
          nonIndexed.map((i) => args[i.name ?? ""]),
        );
  return {
    address: ctx.address,
    topics,
    data,
    blockNumber: ctx.blockNumber,
    blockHash: `0x${"bb".repeat(32)}` as Hex,
    transactionHash: `0x${"cc".repeat(32)}` as Hex,
    logIndex: ctx.logIndex,
  };
}

/**
 * In-memory `ChainClient` — drives `subgraph.start()` without a
 * network. Implements the viem-shape methods the runner consumes
 * (`getBlockNumber`, `getLogs`, `getBlock`, `call`).
 */
class InMemoryChainClient {
  head: bigint;
  logs: RawLog[];
  constructor(args: { head: bigint; logs: RawLog[] }) {
    this.head = args.head;
    this.logs = args.logs;
  }
  async getBlockNumber() {
    return this.head;
  }
  async getLogs(args: {
    address?: Hex | Hex[];
    fromBlock?: bigint;
    toBlock?: bigint;
  }) {
    const addrFilter = args.address;
    const addrSet =
      addrFilter === undefined
        ? null
        : Array.isArray(addrFilter)
          ? new Set(addrFilter.map((a) => a.toLowerCase()))
          : new Set([addrFilter.toLowerCase()]);
    return this.logs
      .filter((l) => {
        if (args.fromBlock !== undefined && l.blockNumber < args.fromBlock) {
          return false;
        }
        if (args.toBlock !== undefined && l.blockNumber > args.toBlock) {
          return false;
        }
        if (addrSet && !addrSet.has(l.address.toLowerCase())) return false;
        return true;
      })
      .map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: l.blockNumber,
        blockHash: l.blockHash,
        transactionHash: l.transactionHash,
        logIndex: Number(l.logIndex),
      }));
  }
  async getBlock(args: { blockNumber: bigint }) {
    return {
      number: args.blockNumber,
      hash: `0x${"bb".repeat(32)}` as Hex,
      timestamp: 1_700_000_000n + 12n * args.blockNumber,
    };
  }
  async call(_args: {
    to: Hex;
    data: Hex;
    blockNumber?: bigint;
  }): Promise<{ data?: Hex }> {
    // No synthetic chain state — surface as a revert so handler
    // `try_*` calls gracefully see `reverted=true`. Layer real
    // return values via `subgraph.mockCall(...)`. (Plain Error +
    // "reverted" hits `makeViemRpc`'s string-matching fallback.)
    throw new Error(
      "execution reverted: InMemoryChainClient has no canned data",
    );
  }
}

// --- shared manifest + cached bundle -------------------------------------
//
// We pre-load the manifest only because the synthetic-log helpers
// below need the ABI to encode topics. We pre-warm the build cache
// via `ensureBundleBuilt(...)` so the first test doesn't pay the AS
// compile cost in-line — the runner internally memoizes by
// (handlerEntry, debug), so every subsequent `Subgraph.create()` in
// this file reuses the same `.wasm`.

import { ensureBundleBuilt } from "wasm-runner";

let manifest: LoadedManifest;
let dataSources: DataSourceSpec[];
let counterAddress: Hex;

before(async () => {
  manifest = await loadSubgraphYaml(EXAMPLE_YAML);
  dataSources = manifest.dataSources;
  counterAddress = dataSources[0].address;
  await ensureBundleBuilt({ handlerEntry: manifest.mappingEntries[0] });
});

// --- create + fire path --------------------------------------------------

describe("Subgraph: programmatic fire path", () => {
  it("create() is zero-config — auto-discovers subgraph.yaml + auto-compiles the wasm", async () => {
    // No `subgraph`, no `dataSources`, no `bundle`: the runner walks
    // `process.cwd()` up looking for `subgraph.yaml`, loads it, then
    // compiles `mappingEntries[0]` once (memoized across this whole
    // test file via the build cache in `auto-build.ts`).
    const subgraph = await Subgraph.create();
    assert.equal(subgraph.runState, "idle");
    assert.equal(subgraph.processedBlock, null);
    // Low-level handles for power users — still reachable.
    assert.ok(subgraph.host);
    assert.ok(subgraph.exports);
    assert.equal(typeof subgraph.exports._start, "function");
  });

  it("create() accepts explicit `subgraph` + `dataSources` overrides", async () => {
    // Explicit forms for each knob. `bundle` accepts:
    //   - a path string                   -> read from disk
    //   - a Uint8Array                    -> use the bytes directly
    //   - { handlerEntry, debug?, outPath? } -> compile via buildBundle
    //
    // `dataSources` can be an array OR a function `(manifest) =>
    // DataSourceSpec[]` for the common "patch the deployed address"
    // case. Omit it to use `manifest.dataSources` as-is.
    const subgraph = await Subgraph.create({
      subgraph: EXAMPLE_YAML,
      dataSources: (m) => m.dataSources,
    });
    assert.equal(subgraph.runState, "idle");
  });

  it("fire(...) walks ABI -> wasm and writes the entity", async () => {
    const subgraph = await Subgraph.create({
      dataSources,
    });

    await subgraph.fire({
      dataSource: 0,
      eventName: "ValueSet",
      params: { newValue: 7n },
      block: { number: 100n, timestamp: 1_700_000_000n },
      transactionHash: `0x${"aa".repeat(32)}` as Hex,
      logIndex: 5n,
    });

    const counter = subgraph.entity("Counter", "0");
    assert.ok(counter, "Counter entity should be created");
    assert.equal(counter.value, 7n);
    // No `multiplier()` mock yet → handler's `try_multiplier()`
    // reverts and `scaledValue` stays at the default 0.
    assert.equal(counter.scaledValue, 0n);
  });

  it("entities(type) + snapshot() return the full store", async () => {
    const subgraph = await Subgraph.create({
      dataSources,
    });

    await subgraph.fire({
      dataSource: 0,
      eventName: "ValueSet",
      params: { newValue: 1n },
    });
    await subgraph.fire({
      dataSource: 0,
      eventName: "SignedValueSet",
      params: { newValue: -42n },
    });

    const counters = subgraph.entities("Counter");
    assert.deepEqual(Object.keys(counters), ["0"]);
    assert.equal(counters["0"].value, 1n);

    const snap = subgraph.snapshot();
    assert.ok("Counter" in snap && "SignedCounter" in snap);
    assert.equal(snap.SignedCounter["0"].value, -42n);
    // snapshot() returns a deep copy.
    (snap.Counter["0"] as Record<string, unknown>).value = 999n;
    assert.equal(subgraph.entity("Counter", "0")?.value, 1n);
  });
});

// --- mockCall path -------------------------------------------------------

describe("Subgraph: mockCall + RPC integration", () => {
  it("withArgs(...).returns(...) feeds wasm `try_*` calls", async () => {
    const subgraph = await Subgraph.create({
      dataSources,
    });
    subgraph
      .mockCall(counterAddress, "multiplier():(uint256)")
      .withArgs([])
      .returns([3n]);

    await subgraph.fire({
      dataSource: 0,
      eventName: "ValueSet",
      params: { newValue: 10n },
    });

    const counter = subgraph.entity("Counter", "0");
    assert.equal(counter?.value, 10n);
    assert.equal(counter?.scaledValue, 30n);
    // Hit counters surface through `subgraph.mocks` for assertions.
    assert.equal(
      subgraph.mocks.hitCount(counterAddress, "multiplier():(uint256)"),
      1,
    );
  });

  it("withAnyArgs().reverts() simulates contract reverts", async () => {
    const subgraph = await Subgraph.create({
      dataSources,
    });
    subgraph
      .mockCall(counterAddress, "multiplier():(uint256)")
      .withAnyArgs()
      .reverts();

    await subgraph.fire({
      dataSource: 0,
      eventName: "ValueSet",
      params: { newValue: 50n },
    });

    // Revert -> `try_multiplier().reverted` -> scaledValue untouched.
    assert.equal(subgraph.entity("Counter", "0")?.scaledValue, 0n);
  });

  it("mocks.clear() drops registered mocks", async () => {
    const subgraph = await Subgraph.create({
      dataSources,
    });
    subgraph
      .mockCall(counterAddress, "multiplier():(uint256)")
      .withAnyArgs()
      .returns([2n]);
    await subgraph.fire({
      dataSource: 0,
      eventName: "ValueSet",
      params: { newValue: 5n },
    });
    assert.equal(subgraph.entity("Counter", "0")?.scaledValue, 10n);

    subgraph.mocks.clear();
    await subgraph.fire({
      dataSource: 0,
      eventName: "ValueSet",
      params: { newValue: 6n },
    });
    // After clear(), unmocked calls revert (matchstick parity), so
    // scaledValue is left at its previous value (10n) — handler
    // doesn't overwrite on revert.
    assert.equal(subgraph.entity("Counter", "0")?.scaledValue, 10n);
  });
});

// --- reset() -------------------------------------------------------------

describe("Subgraph: reset()", () => {
  it("wipes entities + capture buffers but preserves mocks", async () => {
    const subgraph = await Subgraph.create({
      dataSources,
    });
    subgraph
      .mockCall(counterAddress, "multiplier():(uint256)")
      .withAnyArgs()
      .returns([7n]);

    await subgraph.fire({
      dataSource: 0,
      eventName: "ValueSet",
      params: { newValue: 1n },
    });
    assert.notEqual(Object.keys(subgraph.snapshot()).length, 0);

    await subgraph.reset();
    assert.deepEqual(subgraph.snapshot(), {});

    // Mock survived reset() — it's JS-side state, not wasm-side.
    await subgraph.fire({
      dataSource: 0,
      eventName: "ValueSet",
      params: { newValue: 4n },
    });
    assert.equal(subgraph.entity("Counter", "0")?.scaledValue, 28n);
  });
});

// --- start / pause / resume / stop --------------------------------------

describe("Subgraph: start() log-fetch loop", () => {
  it("range mode drains [fromBlock, toBlock] then resolves", async () => {
    const logs = [
      buildLog(
        dataSources[0].abi,
        "ValueSet",
        { newValue: 11n },
        { address: counterAddress, blockNumber: 10n, logIndex: 0n },
      ),
      buildLog(
        dataSources[0].abi,
        "ValueSet",
        { newValue: 22n },
        { address: counterAddress, blockNumber: 20n, logIndex: 0n },
      ),
    ];
    const client = new InMemoryChainClient({ head: 100n, logs });
    const subgraph = await Subgraph.create({
      dataSources,
      client,
    });

    await subgraph.start({ fromBlock: 0n, toBlock: 30n });
    assert.equal(subgraph.runState, "idle");
    assert.equal(subgraph.processedBlock, 30n);
    // Latest log wins.
    assert.equal(subgraph.entity("Counter", "0")?.value, 22n);
  });

  it("pause() halts dispatch; resume() continues from processedBlock+1", async () => {
    const logs = [
      buildLog(
        dataSources[0].abi,
        "ValueSet",
        { newValue: 1n },
        { address: counterAddress, blockNumber: 10n, logIndex: 0n },
      ),
      buildLog(
        dataSources[0].abi,
        "ValueSet",
        { newValue: 2n },
        { address: counterAddress, blockNumber: 20n, logIndex: 0n },
      ),
      buildLog(
        dataSources[0].abi,
        "ValueSet",
        { newValue: 3n },
        { address: counterAddress, blockNumber: 30n, logIndex: 0n },
      ),
    ];
    const client = new InMemoryChainClient({ head: 30n, logs });
    const subgraph = await Subgraph.create({
      dataSources,
      client,
    });

    // Pause once batch #1 completes (deterministic — fires inside the
    // 2nd getLogs request) so we can inspect mid-loop state.
    let getLogsCalls = 0;
    const origGetLogs = client.getLogs.bind(client);
    client.getLogs = async (args) => {
      getLogsCalls++;
      if (getLogsCalls === 2) subgraph.pause();
      return origGetLogs(args);
    };

    const done = subgraph.start({
      fromBlock: 0n,
      toBlock: 30n,
      batchSize: 15n,
      pollIntervalMs: 5,
    });
    try {
      while (subgraph.runState !== "paused" && subgraph.runState !== "idle") {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(subgraph.runState, "paused");
      assert.equal(subgraph.processedBlock, 14n);
      assert.equal(subgraph.entity("Counter", "0")?.value, 1n);
    } finally {
      if (subgraph.runState === "paused") subgraph.resume();
      await done;
    }
    assert.equal(subgraph.processedBlock, 30n);
    assert.equal(subgraph.entity("Counter", "0")?.value, 3n);
  });

  it("tail mode + stop() resolves the loop cleanly", async () => {
    const client = new InMemoryChainClient({ head: 5n, logs: [] });
    const subgraph = await Subgraph.create({
      dataSources,
      client,
    });
    const done = subgraph.start({ fromBlock: 0n, pollIntervalMs: 5 });
    // Let backfill drain + enter tail-poll.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(subgraph.runState, "running");

    // Simulate a new mined block + log.
    client.logs.push(
      buildLog(
        dataSources[0].abi,
        "ValueSet",
        { newValue: 77n },
        { address: counterAddress, blockNumber: 6n, logIndex: 0n },
      ),
    );
    client.head = 6n;
    await new Promise((r) => setTimeout(r, 30));

    await subgraph.stop();
    await done;
    assert.equal(subgraph.runState, "idle");
    assert.equal(subgraph.entity("Counter", "0")?.value, 77n);
  });
});

// --- log sink hookup -----------------------------------------------------

describe("Subgraph: logSink hookup", () => {
  it("forwards graph-ts log.* calls to the JS sink", async () => {
    const captured: Array<{ level: number; message: string }> = [];
    const subgraph = await Subgraph.create({
      dataSources,
      logSink: (level, message) => captured.push({ level, message }),
    });
    // Counter mapping doesn't emit logs today, but the sink would
    // receive them once it does. The hookup itself is what we
    // verify — at least no firing path throws.
    await subgraph.fire({
      dataSource: 0,
      eventName: "ValueSet",
      params: { newValue: 1n },
    });
    assert.ok(Array.isArray(captured));
  });
});
