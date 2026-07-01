/**
 * End-to-end coverage for the high-level `Subgraph` facade against
 * the example bundle. Asserts:
 *   - bundle path resolution + create()
 *   - fire(...) routes ABI-decoded params through to the right
 *     handler export
 *   - block-context override flows into `event.block.{number,
 *     timestamp,hash}` and `host.blockNumber` for the duration of
 *     the dispatch
 *   - mockCall(...) integrates so wasm `try_*` reads see the mocked
 *     value (handleValueSet calls `try_multiplier()` and writes
 *     `scaledValue = newValue.times(multiplier)`)
 *   - entity / entities / snapshot
 *   - reset() rebuilds wasm and re-applies the mock layer
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Abi, Hex } from "viem";
import { Subgraph } from "../src/subgraph-runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE_WASM = resolve(here, "../build/example-bundle.wasm");
const COUNTER_ABI_PATH = resolve(here, "../../example/abis/Counter.json");

const COUNTER_ADDRESS = "0x000000000000000000000000000000000000beef" as Hex;

function loadCounterAbi(): Abi {
  return JSON.parse(readFileSync(COUNTER_ABI_PATH, "utf8")) as Abi;
}

test("Subgraph: end-to-end via the example bundle", async (t) => {
  if (!existsSync(BUNDLE_WASM) || !existsSync(COUNTER_ABI_PATH)) {
    t.skip(`example bundle or ABI missing — run \`pnpm build:example-bundle\``);
    return;
  }

  const abi = loadCounterAbi();
  const subgraph = await Subgraph.create({
    bundle: BUNDLE_WASM,
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

  await t.test("fire(ValueSet) creates the entity with default scaledValue", async () => {
    await subgraph.fire({
      dataSource: 0,
      eventName: "ValueSet",
      params: { newValue: 7n },
    });
    const counter = subgraph.entity("Counter", "0");
    assert.ok(counter, "Counter id=0 should exist");
    assert.equal(counter.value, 7n);
    // No mock for `multiplier()` → reverted, scaledValue stays 0.
    assert.equal(counter.scaledValue, 0n);
  });

  await t.test("mockCall(multiplier()) makes try_multiplier succeed", async () => {
    subgraph
      .mockCall(COUNTER_ADDRESS, "multiplier():(uint256)")
      .withAnyArgs()
      .returns([3n]);

    await subgraph.fire({
      dataSource: 0,
      eventName: "ValueSet",
      params: { newValue: 10n },
    });
    const counter = subgraph.entity("Counter", "0");
    assert.ok(counter);
    assert.equal(counter.value, 10n);
    assert.equal(counter.scaledValue, 30n);
    assert.equal(
      subgraph.mocks.hitCount(COUNTER_ADDRESS, "multiplier():(uint256)"),
      1,
    );
  });

  await t.test("fire(SignedValueSet) round-trips negative BigInt", async () => {
    await subgraph.fire({
      dataSource: 0,
      eventName: "SignedValueSet",
      params: { newValue: -42n },
    });
    const signed = subgraph.entity("SignedCounter", "0");
    assert.ok(signed);
    assert.equal(signed.value, -42n);
  });

  await t.test("block context override flows into host.blockNumber during dispatch", async () => {
    let observedBlockDuringCall: bigint | null = null;
    subgraph
      .mockCall(COUNTER_ADDRESS, "multiplier():(uint256)")
      .withAnyArgs()
      .returns([5n]);
    // Hijack the rpcClient to peek at host.blockNumber when wasm calls.
    const realRpc = subgraph.host.rpcClient;
    subgraph.host.rpcClient = {
      async call(args) {
        observedBlockDuringCall = subgraph.host.blockNumber;
        if (!realRpc) throw new Error("real rpc gone");
        return realRpc.call(args);
      },
    };
    await subgraph.fire({
      dataSource: 0,
      eventName: "ValueSet",
      params: { newValue: 1n },
      block: { number: 18_000_000n, timestamp: 1_700_000_000n },
    });
    subgraph.host.rpcClient = realRpc;
    assert.equal(observedBlockDuringCall, 18_000_000n);
    // After the dispatch, host.blockNumber is restored to whatever it was.
    assert.equal(subgraph.host.blockNumber, null);
  });

  await t.test("snapshot() returns every entity type", () => {
    const snap = subgraph.snapshot();
    assert.ok(Object.hasOwn(snap, "Counter"));
    assert.ok(Object.hasOwn(snap, "SignedCounter"));
    // Snapshots are deep copies — mutating shouldn't affect future reads.
    (snap.Counter["0"] as Record<string, unknown>).value = 999n;
    const refetched = subgraph.entity("Counter", "0");
    assert.notEqual(refetched?.value, 999n);
  });

  await t.test("reset() wipes entities and survives the mock layer", async () => {
    await subgraph.reset();
    assert.deepEqual(subgraph.snapshot(), {});

    // Mocks should still be active after reset (they're JS-side state).
    await subgraph.fire({
      dataSource: 0,
      eventName: "ValueSet",
      params: { newValue: 4n },
    });
    const counter = subgraph.entity("Counter", "0");
    assert.ok(counter);
    assert.equal(counter.value, 4n);
    // multiplier() was last set to return 5n.
    assert.equal(counter.scaledValue, 20n);
  });

  await t.test("unknown event name throws a clear error", async () => {
    await assert.rejects(
      () =>
        subgraph.fire({
          dataSource: 0,
          eventName: "DoesNotExist",
          params: {},
        }),
      /no handler registered for event "DoesNotExist"/,
    );
  });

  await t.test("start() requires a logSource — clear error otherwise", async () => {
    await assert.rejects(() => subgraph.start(), /no `logSource` configured/);
  });
});
