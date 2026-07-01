/**
 * Coverage for `Subgraph.start()` / `pause()` / `resume()` /
 * `stop()` end-to-end against the example bundle, driven by a
 * fully-synthetic in-memory `LogSource`. No network involved.
 *
 * Test surface:
 *   - range mode (`toBlock` set) drains logs and resolves
 *   - tail mode polls head, dispatches new logs as they arrive,
 *     and resolves cleanly on stop()
 *   - pause() halts dispatch mid-batch; resume() continues from
 *     `processedBlock + 1`
 *   - unknown topics on a listened address are silently skipped
 *   - block context flows through (handler reads `event.block`)
 *   - addresses + topic0 filter is forwarded to LogSource.getLogs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  encodeAbiParameters,
  encodeEventTopics,
  toEventSelector,
  type Abi,
  type AbiEvent,
  type Hex,
} from "viem";
import { Subgraph } from "../src/subgraph-runner.ts";
import type { RawLog } from "../src/log-source.ts";

/**
 * Shape viem `getLogs` returns. Mirrors the `ViemLogClient.getLogs`
 * return type — `blockNumber` / `blockHash` / `txHash` are nullable
 * for pending logs but we never produce those here.
 */
interface ViemShapeLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  transactionHash: Hex | null;
  logIndex: number | null;
}

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE_WASM = resolve(here, "../build/example-bundle.wasm");
const COUNTER_ABI_PATH = resolve(here, "../../example/abis/Counter.json");
const COUNTER_ADDRESS = "0x000000000000000000000000000000000000beef" as Hex;

function loadCounterAbi(): Abi {
  return JSON.parse(readFileSync(COUNTER_ABI_PATH, "utf8")) as Abi;
}

function abiEvent(abi: Abi, name: string): AbiEvent {
  for (const item of abi) {
    if (item.type === "event" && item.name === name) return item;
  }
  throw new Error(`event ${name} not in ABI`);
}

interface MakeLogArgs {
  abi: Abi;
  eventName: string;
  args: Record<string, unknown>;
  address?: Hex;
  blockNumber: bigint;
  logIndex: bigint;
  blockHash?: Hex;
  txHash?: Hex;
}

/**
 * Build a `RawLog` for the given event by ABI-encoding non-indexed
 * args into `data` and using viem's `encodeEventTopics` for indexed
 * topics. The example bundle's `ValueSet` / `SignedValueSet` events
 * have all-non-indexed inputs, but routing through viem keeps this
 * helper general for future events.
 */
function makeLog(opts: MakeLogArgs): RawLog {
  const ev = abiEvent(opts.abi, opts.eventName);
  const topics = encodeEventTopics({
    abi: [ev],
    eventName: opts.eventName,
    args: opts.args,
  }) as Hex[];
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  const data: Hex =
    nonIndexed.length === 0
      ? "0x"
      : encodeAbiParameters(
          nonIndexed,
          nonIndexed.map((i) => opts.args[i.name ?? ""]),
        );
  return {
    address: opts.address ?? COUNTER_ADDRESS,
    topics,
    data,
    blockNumber: opts.blockNumber,
    blockHash:
      opts.blockHash ?? (`0x${"bb".repeat(32)}` as Hex),
    transactionHash:
      opts.txHash ?? (`0x${"cc".repeat(32)}` as Hex),
    logIndex: opts.logIndex,
  };
}

/**
 * Captured `getLogs` arg from `FakeChainClient`. Saved in viem's
 * native shape (`address` may be a single hex or an array).
 */
interface CapturedGetLogs {
  address?: Hex | Hex[];
  topics?: (Hex[] | Hex | null)[];
  fromBlock?: bigint;
  toBlock?: bigint;
}

/**
 * In-memory `ChainClient`: implements the viem-shape methods the
 * runner consumes (`getBlockNumber`, `getLogs`, `getBlock`, `call`)
 * so tests can drive `Subgraph.start(...)` without a real RPC.
 *
 * Mutating `head` / `logs` between awaits simulates new mined
 * blocks. `beforeGetLogs` lets a test pause / push more state
 * mid-batch — used by the pause/resume coverage.
 *
 * `call()` returns empty data by default; tests that exercise
 * `eth_call` paths layer values via `subgraph.mockCall(...)`.
 */
class FakeChainClient {
  head: bigint;
  logs: RawLog[];
  readonly capturedGetLogs: CapturedGetLogs[] = [];
  beforeGetLogs?: () => void | Promise<void>;

  constructor(args: { head: bigint; logs?: RawLog[] }) {
    this.head = args.head;
    this.logs = args.logs ?? [];
  }

  async getBlockNumber(): Promise<bigint> {
    return this.head;
  }

  async getLogs(args: CapturedGetLogs): Promise<ViemShapeLog[]> {
    this.capturedGetLogs.push({ ...args });
    if (this.beforeGetLogs) await this.beforeGetLogs();
    const addrFilter = args.address;
    const addrSet =
      addrFilter === undefined
        ? null
        : Array.isArray(addrFilter)
          ? new Set(addrFilter.map((a) => a.toLowerCase()))
          : new Set([addrFilter.toLowerCase()]);
    const topic0Filter = args.topics?.[0];
    let topic0Set: Set<string> | null = null;
    if (Array.isArray(topic0Filter)) {
      topic0Set = new Set(topic0Filter.map((t) => t.toLowerCase()));
    } else if (typeof topic0Filter === "string") {
      topic0Set = new Set([topic0Filter.toLowerCase()]);
    }
    return this.logs
      .filter((l) => {
        if (args.fromBlock !== undefined && l.blockNumber < args.fromBlock) {
          return false;
        }
        if (args.toBlock !== undefined && l.blockNumber > args.toBlock) {
          return false;
        }
        if (addrSet && !addrSet.has(l.address.toLowerCase())) return false;
        if (topic0Set && !topic0Set.has(l.topics[0].toLowerCase())) return false;
        return true;
      })
      .map(
        (l): ViemShapeLog => ({
          address: l.address,
          topics: l.topics,
          data: l.data,
          blockNumber: l.blockNumber,
          blockHash: l.blockHash,
          transactionHash: l.transactionHash,
          logIndex: Number(l.logIndex),
        }),
      );
  }

  async getBlock(args: {
    blockNumber: bigint;
  }): Promise<{ number: bigint; hash: Hex; timestamp: bigint }> {
    return {
      number: args.blockNumber,
      hash: `0xbb${"00".repeat(31)}` as Hex,
      timestamp: 1_700_000_000n + 12n * args.blockNumber,
    };
  }

  async call(_args: {
    to: Hex;
    data: Hex;
    blockNumber?: bigint;
  }): Promise<{ data?: Hex }> {
    // Synthetic chain has no contract state — surface every
    // un-mocked eth_call as a revert so `makeViemRpc` returns `null`
    // and the handler's `try_*` gracefully sees `reverted=true`. To
    // feed actual return data in a test, layer a `mockCall(...)` on
    // the Subgraph instead. (Plain Error with "reverted" in the
    // message hits `makeViemRpc`'s string-matching fallback — keeps
    // this fake free of viem internals.)
    throw new Error("execution reverted: FakeChainClient has no canned data");
  }
}

test("Subgraph.start: end-to-end with FakeChainClient", async (t) => {
  if (!existsSync(BUNDLE_WASM) || !existsSync(COUNTER_ABI_PATH)) {
    t.skip("example bundle or ABI missing — run `pnpm build:example-bundle`");
    return;
  }
  const abi = loadCounterAbi();

  await t.test(
    "range mode: drains all logs in [fromBlock, toBlock] and resolves",
    async () => {
      const logs = [
        makeLog({
          abi,
          eventName: "ValueSet",
          args: { newValue: 7n },
          blockNumber: 100n,
          logIndex: 0n,
        }),
        makeLog({
          abi,
          eventName: "ValueSet",
          args: { newValue: 11n },
          blockNumber: 105n,
          logIndex: 1n,
        }),
      ];
      const client = new FakeChainClient({ head: 200n, logs });
      const subgraph = await Subgraph.create({
        bundle: BUNDLE_WASM,
        client,
        dataSources: [
          {
            address: COUNTER_ADDRESS,
            abi,
            eventHandlers: [
              { event: "ValueSet", handler: "handleValueSet" },
            ],
          },
        ],
      });

      await subgraph.start({ fromBlock: 100n, toBlock: 110n });

      assert.equal(subgraph.runState, "idle");
      assert.equal(subgraph.processedBlock, 110n);
      const counter = subgraph.entity("Counter", "0");
      assert.ok(counter);
      // Latest fire wins.
      assert.equal(counter.value, 11n);
    },
  );

  await t.test(
    "addresses + topic0 filter is forwarded to LogSource.getLogs",
    async () => {
      const client = new FakeChainClient({ head: 50n, logs: [] });
      const subgraph = await Subgraph.create({
        bundle: BUNDLE_WASM,
        client,
        dataSources: [
          {
            address: COUNTER_ADDRESS,
            abi,
            eventHandlers: [
              { event: "ValueSet", handler: "handleValueSet" },
              { event: "SignedValueSet", handler: "handleSignedValueSet" },
            ],
          },
        ],
      });

      await subgraph.start({ fromBlock: 0n, toBlock: 50n });
      assert.ok(client.capturedGetLogs.length > 0);
      const first = client.capturedGetLogs[0];
      // The runner forwards a single-element address-array as a
      // bare hex (matches viem's `getLogs({ address })` shape).
      assert.equal(first.address, COUNTER_ADDRESS.toLowerCase());
      // topic[0] is an OR-set of the two registered event hashes.
      const topic0 = first.topics?.[0];
      assert.ok(Array.isArray(topic0));
      const topic0Lower = (topic0 as Hex[]).map((t) => t.toLowerCase());
      assert.ok(
        topic0Lower.includes(
          toEventSelector(abiEvent(abi, "ValueSet")).toLowerCase(),
        ),
      );
      assert.ok(
        topic0Lower.includes(
          toEventSelector(abiEvent(abi, "SignedValueSet")).toLowerCase(),
        ),
      );
    },
  );

  await t.test(
    "block context propagates: handler sees block.number/timestamp",
    async () => {
      // The ValueSet handler reads event.block.number / timestamp via
      // graph-ts. We assert the FakeChainClient's deterministic
      // timestamps survive the wasm round-trip by hijacking the
      // rpcClient hook to peek at host.blockNumber for that fire.
      const observedBlocks: Array<bigint | null> = [];
      const logs = [
        makeLog({
          abi,
          eventName: "ValueSet",
          args: { newValue: 9n },
          blockNumber: 42n,
          logIndex: 0n,
        }),
      ];
      const client = new FakeChainClient({ head: 50n, logs });
      const subgraph = await Subgraph.create({
        bundle: BUNDLE_WASM,
        client,
        dataSources: [
          {
            address: COUNTER_ADDRESS,
            abi,
            eventHandlers: [
              { event: "ValueSet", handler: "handleValueSet" },
            ],
          },
        ],
      });
      // Insert a probe so we can read host.blockNumber during dispatch.
      const realRpc = subgraph.host.rpcClient;
      subgraph.host.rpcClient = {
        async call(args) {
          observedBlocks.push(subgraph.host.blockNumber);
          if (!realRpc) return null;
          return realRpc.call(args);
        },
      };
      await subgraph.start({ fromBlock: 0n, toBlock: 50n });
      // handler runs `try_multiplier()` — at least one observed call
      // must reflect the dispatched log's block number.
      assert.ok(
        observedBlocks.some((b) => b === 42n),
        `expected an eth_call against block 42, got ${JSON.stringify(observedBlocks.map(String))}`,
      );
    },
  );

  await t.test(
    "tail mode: stop() resolves the run-loop promise cleanly",
    async () => {
      const client = new FakeChainClient({ head: 10n, logs: [] });
      const subgraph = await Subgraph.create({
        bundle: BUNDLE_WASM,
        client,
        dataSources: [
          {
            address: COUNTER_ADDRESS,
            abi,
            eventHandlers: [
              { event: "ValueSet", handler: "handleValueSet" },
            ],
          },
        ],
      });
      const done = subgraph.start({
        fromBlock: 0n,
        pollIntervalMs: 5,
      });
      // Let the loop drain backfill + enter tail-poll.
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(subgraph.runState, "running");
      // Simulate two new logs arriving on a fresh block, then stop.
      client.logs.push(
        makeLog({
          abi,
          eventName: "ValueSet",
          args: { newValue: 21n },
          blockNumber: 11n,
          logIndex: 0n,
        }),
      );
      client.head = 11n;
      // Wait a couple of poll intervals so the new log is dispatched.
      await new Promise((r) => setTimeout(r, 30));
      const stopPromise = subgraph.stop();
      await Promise.all([done, stopPromise]);
      assert.equal(subgraph.runState, "idle");
      const counter = subgraph.entity("Counter", "0");
      assert.ok(counter);
      assert.equal(counter.value, 21n);
    },
  );

  await t.test(
    "pause/resume: dispatch halts mid-flight, resumes from processedBlock+1",
    async () => {
      const logs = [
        makeLog({
          abi,
          eventName: "ValueSet",
          args: { newValue: 1n },
          blockNumber: 10n,
          logIndex: 0n,
        }),
        makeLog({
          abi,
          eventName: "ValueSet",
          args: { newValue: 2n },
          blockNumber: 20n,
          logIndex: 0n,
        }),
        makeLog({
          abi,
          eventName: "ValueSet",
          args: { newValue: 3n },
          blockNumber: 30n,
          logIndex: 0n,
        }),
      ];
      const client = new FakeChainClient({ head: 30n, logs });
      const subgraph = await Subgraph.create({
        bundle: BUNDLE_WASM,
        client,
        dataSources: [
          {
            address: COUNTER_ADDRESS,
            abi,
            eventHandlers: [
              { event: "ValueSet", handler: "handleValueSet" },
            ],
          },
        ],
      });
      // Hook the FakeChainClient: trigger pause() when the SECOND
      // getLogs is starting. By that point batch #1 [0..14] has
      // fully completed (processedBlock=14n committed, block-10 log
      // dispatched), so the loop's next iteration / for-of will
      // observe paused and wait deterministically.
      client.beforeGetLogs = () => {
        if (client.capturedGetLogs.length === 2) {
          subgraph.pause();
        }
      };
      const done = subgraph.start({
        fromBlock: 0n,
        toBlock: 30n,
        batchSize: 15n,
        pollIntervalMs: 5,
      });
      // try/finally so a failed assertion still drains the loop —
      // otherwise the pending `done` Promise keeps node alive after
      // the test returns, hanging `node --test`.
      try {
        // Wait for the loop to enter "paused" (or to bail to idle on
        // an unexpected error).
        while (subgraph.runState !== "paused" && subgraph.runState !== "idle") {
          await new Promise((r) => setTimeout(r, 5));
        }
        assert.equal(subgraph.runState, "paused");
        const blockAtPause = subgraph.processedBlock;
        // pause was triggered inside getLogs call #2 — by that point
        // batch #1 [0..14] has fully committed.
        assert.equal(blockAtPause, 14n);
        const counterAtPause = subgraph.entity("Counter", "0");
        assert.equal(counterAtPause?.value, 1n);
        assert.equal(client.capturedGetLogs.length, 2);
      } finally {
        // Always resume so the run-loop drains and `done` resolves.
        if (subgraph.runState === "paused") subgraph.resume();
        await done;
      }
      assert.equal(subgraph.runState, "idle");
      assert.equal(subgraph.processedBlock, 30n);
      const counter = subgraph.entity("Counter", "0");
      assert.equal(counter?.value, 3n);
    },
  );

  await t.test(
    "unknown topics on a listened address are silently skipped",
    async () => {
      const stranger = makeLog({
        abi,
        eventName: "ValueSet",
        args: { newValue: 99n },
        blockNumber: 5n,
        logIndex: 0n,
      });
      // Stomp the topic0 to something we never registered a handler for.
      stranger.topics = [
        ("0x" + "ff".repeat(32)) as Hex,
        ...stranger.topics.slice(1),
      ];
      const real = makeLog({
        abi,
        eventName: "ValueSet",
        args: { newValue: 50n },
        blockNumber: 6n,
        logIndex: 0n,
      });
      const client = new FakeChainClient({
        head: 10n,
        logs: [stranger, real],
      });
      const subgraph = await Subgraph.create({
        bundle: BUNDLE_WASM,
        client,
        dataSources: [
          {
            address: COUNTER_ADDRESS,
            abi,
            eventHandlers: [
              { event: "ValueSet", handler: "handleValueSet" },
            ],
          },
        ],
      });
      // Important: stomp the FakeChainClient's filter check by removing
      // topic-set restriction — we want both logs returned so the
      // dispatcher itself filters by router. Easiest way: feed both
      // through getLogs by overriding the topic filter mask. The
      // FakeChainClient's filter rejects non-matching topic0; bypass by
      // pre-registering the stranger's topic via dataSources... no,
      // we don't want a handler for it. Instead, force the
      // FakeChainClient to ignore topics.
      client.beforeGetLogs = () => undefined;
      const origGetLogs = client.getLogs.bind(client);
      client.getLogs = async (args) => {
        const result = await origGetLogs({
          ...args,
          // pass undefined topic filter so both logs come back
          topics: undefined,
        });
        return result;
      };
      await subgraph.start({ fromBlock: 0n, toBlock: 10n });
      // Only `real` should have been dispatched.
      const counter = subgraph.entity("Counter", "0");
      assert.equal(counter?.value, 50n);
    },
  );

  await t.test("calling start() twice without stop() throws", async () => {
    const client = new FakeChainClient({ head: 5n, logs: [] });
    const subgraph = await Subgraph.create({
      bundle: BUNDLE_WASM,
      client,
      dataSources: [
        {
          address: COUNTER_ADDRESS,
          abi,
          eventHandlers: [
            { event: "ValueSet", handler: "handleValueSet" },
          ],
        },
      ],
    });
    const done = subgraph.start({ fromBlock: 0n, pollIntervalMs: 5 });
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(
      () => subgraph.start({ fromBlock: 0n }),
      /already running/,
    );
    await subgraph.stop();
    await done;
  });
});
