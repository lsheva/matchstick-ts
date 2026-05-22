/**
 * Phase-0 spike: prove the wasm-runner can drive a real third-party
 * subgraph end-to-end. The target is `futures-marketplace/indexer/src/
 * futures.ts`, which is significantly more complex than `example`:
 *   - 15 event handlers, codegen'd `OrderCreated` etc.
 *   - graph-ts `BigInt.toString` / `BigInt.toHexString` paths (host imports
 *     `typeConversion.bigIntToString` + `bigIntToHex`).
 *   - `log.debug` paths (`index.log.log`).
 *   - `dataSource.address` / `dataSource.context` lookups.
 *   - `try_X()` ABI calls into the on-chain Futures contract (all reverted
 *     by our stub `ethereum.call` for now — same pattern as matchstick).
 *
 * If futures-marketplace isn't checked out alongside subgraph-snapshot, or
 * its `pnpm codegen` hasn't been run, this test skips rather than failing
 * — it's purpose-built for our local dev loop, not CI.
 *
 * What we assert is intentionally narrow: the entities that
 * `handleOrderCreated` is supposed to create, with the field values
 * derived from the event payload. We deliberately don't try to match
 * the full matchstick assertion list — that's the conformance test in a
 * later phase. The goal here is "did one real-world handler run without
 * trapping, and did the entities land in the JS store with correct
 * shapes".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle } from "../src/build.ts";
import { WasmRunner } from "../src/runner.ts";
import { EventBuilder } from "../src/event-builder.ts";

const FUTURES_HANDLER_ENTRY =
  "/Users/shev/Dev/titan/futures-marketplace/indexer/src/futures.ts";
const FUTURES_CODEGEN_MARKER =
  "/Users/shev/Dev/titan/futures-marketplace/indexer/generated/schema.ts";
const BUNDLE_OUT = join(tmpdir(), "wasm-runner-futures-spike-bundle.wasm");

/**
 * The matchstick test's defaults — same address, same price, same
 * delivery so the order aggregate id is deterministic and we can
 * cross-check against `orderAggregateId` from the indexer's `ids.ts`.
 */
const USER_HEX = "0x" + "1".padStart(40, "0");
const ORDER_ID_HEX = "0x" + "1".padStart(64, "0");
const DEST_URL = "https://node1.example";
const PRICE = 1_000_000n;
const DELIVERY = 1_700_000_000n;

interface FuturesHandlers {
  handleOrderCreated(eventPtr: number): void;
}

test("futures-marketplace: handleOrderCreated end-to-end", async (t) => {
  if (!existsSync(FUTURES_HANDLER_ENTRY) || !existsSync(FUTURES_CODEGEN_MARKER)) {
    t.skip(
      `futures-marketplace not checked out or codegen missing — looked for ${FUTURES_HANDLER_ENTRY} and ${FUTURES_CODEGEN_MARKER}`,
    );
    return;
  }

  // Compile-once: warm asc, build the bundle, hand the wasm to a runner.
  // ~3-5s wall clock on a warm cache; cold first run is ~10s.
  await buildBundle({
    handlerEntry: FUTURES_HANDLER_ENTRY,
    outPath: BUNDLE_OUT,
    debug: true,
  });

  const runner = await WasmRunner.compile(BUNDLE_OUT);
  const subgraph = await runner.instantiate();
  // Silence log.debug noise in test output — the host still records
  // every line into `host.captured.logs` if we want to assert on it.
  subgraph.host.logSink = () => {};

  const builder = new EventBuilder(subgraph.exports);
  const handlers = subgraph.exports as unknown as FuturesHandlers;

  const eventPtr = builder.buildEvent([
    builder.param("orderId", builder.fixedBytes(ORDER_ID_HEX)),
    builder.param("participant", builder.address(USER_HEX)),
    builder.param("destURL", builder.string(DEST_URL)),
    builder.param("pricePerDay", builder.unsignedBigInt(PRICE)),
    builder.param("deliveryAt", builder.unsignedBigInt(DELIVERY)),
    builder.param("isBuy", builder.bool(true)),
  ]);

  handlers.handleOrderCreated(eventPtr);

  // Schema `Int` (graph-ts `ValueKind.INT`) decodes to JS `bigint`, not
  // `number`. The wasm stores them as i32 in the low word of a u64
  // payload; the decoder widens to bigint for parity with `BIGINT`
  // (BigInt) so consumers don't have to branch on width.
  await t.test("Order aggregate landed with the event's tuple", () => {
    const orders = subgraph.entities("Order");
    const ids = Object.keys(orders);
    assert.equal(ids.length, 1, `expected 1 Order, got ${ids.length}: ${ids.join(", ")}`);
    const order = orders[ids[0]];
    assert.equal(order.price, PRICE);
    assert.equal(order.deliveryAt, DELIVERY);
    assert.equal(order.isBuy, true);
    assert.equal(order.quantity, 1n);
    assert.equal(order.originalQuantity, 1n);
    assert.equal(order.filledQuantity, 0n);
    assert.equal(order.cancelledQuantity, 0n);
    assert.equal(order.status, "ACTIVE");
  });

  await t.test("OrderEntry stored with destURL + ACTIVE status", () => {
    const entries = subgraph.entities("OrderEntry");
    const ids = Object.keys(entries);
    assert.equal(ids.length, 1, `expected 1 OrderEntry, got ${ids.length}`);
    const entry = entries[ids[0]];
    assert.equal(entry.destURL, DEST_URL);
    assert.equal(entry.status, "ACTIVE");
  });

  await t.test("User created with initial counters bumped", () => {
    const users = subgraph.entities("User");
    const ids = Object.keys(users);
    assert.equal(ids.length, 1, `expected 1 User, got ${ids.length}`);
    const user = users[ids[0]];
    assert.equal(user.orderCount, 1n);
    assert.equal(user.activeOrderCount, 1n);
    assert.equal(user.tradeCount, 0n);
    assert.equal(user.fillCount, 0n);
  });

  await t.test("PriceLevel created with totalQuantity=1", () => {
    const levels = subgraph.entities("PriceLevel");
    const ids = Object.keys(levels);
    assert.equal(ids.length, 1, `expected 1 PriceLevel, got ${ids.length}`);
    const level = levels[ids[0]];
    assert.equal(level.totalQuantity, 1n);
    assert.equal(level.price, PRICE);
    assert.equal(level.deliveryAt, DELIVERY);
    assert.equal(level.isBid, true);
  });

  await t.test("Futures singleton lazily created with bumped counters", () => {
    const futures = subgraph.entities("Futures");
    const ids = Object.keys(futures);
    assert.equal(ids.length, 1, `expected 1 Futures, got ${ids.length}`);
    const f = futures[ids[0]];
    assert.equal(f.totalUsers, 1n);
    assert.equal(f.totalOrders, 1n);
    assert.equal(f.activeOrders, 1n);
  });

  await t.test("host captured store activity for every entity touched", () => {
    const setTypes = new Set(
      subgraph.host.captured.storeSets.map((s) => s.entityType),
    );
    assert.ok(setTypes.has("Order"));
    assert.ok(setTypes.has("OrderEntry"));
    assert.ok(setTypes.has("User"));
    assert.ok(setTypes.has("PriceLevel"));
    assert.ok(setTypes.has("Futures"));
  });
});
