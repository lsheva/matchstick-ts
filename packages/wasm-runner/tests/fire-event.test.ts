/**
 * End-to-end (Step 6): build the `ethereum.Event` in wasm memory from
 * JS, call the user handler export directly, query state via the
 * `SubgraphInstance` API. No per-handler AS wrapper involved.
 *
 * The pattern below is the API the public consumer (matchstick-ts,
 * eventually) will adopt — feed events, query state, reset between
 * scenarios:
 *
 *   const sub = await runner.instantiate();
 *   const builder = new EventBuilder(sub.exports);
 *   const eventPtr = builder.buildEvent([
 *     builder.param("newValue", builder.signedBigInt(-7n)),
 *   ]);
 *   sub.exports.handleSignedValueSet(eventPtr);
 *   expect(sub.entity("SignedCounter", "0").value).toEqual(-7n);
 *   await sub.reset();
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { WasmRunner } from "../src/runner.ts";
import { EventBuilder } from "../src/event-builder.ts";

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE_WASM = resolve(here, "../build/example-bundle.wasm");

/** Handlers we call directly (declared on top of the loader exports). */
interface HandlerExports {
  handleSignedValueSet(eventPtr: number): void;
}

/**
 * Build a `SignedValueSet`-shaped event with the given `newValue` and
 * dispatch it to the user handler. The wasm has no per-event entry
 * point — JS allocates the param + value + array, AS scaffolds the
 * surrounding Block/Transaction/Receipt via `newMockEvent`.
 */
function fireSignedValueSet(
  builder: EventBuilder,
  handlers: HandlerExports,
  newValue: bigint,
): void {
  const eventPtr = builder.buildEvent([
    builder.param("newValue", builder.signedBigInt(newValue)),
  ]);
  handlers.handleSignedValueSet(eventPtr);
}

test("dispatch + entity round-trip via SubgraphInstance", async (t) => {
  if (!existsSync(BUNDLE_WASM)) {
    t.skip(
      `example-bundle.wasm missing at ${BUNDLE_WASM} — run \`pnpm --filter wasm-runner build:example-bundle\``,
    );
    return;
  }

  const runner = await WasmRunner.compile(BUNDLE_WASM);
  const subgraph = await runner.instantiate();
  let builder = new EventBuilder(subgraph.exports);
  let handlers = subgraph.exports as unknown as HandlerExports;

  fireSignedValueSet(builder, handlers, 42n);

  await t.test("entity exists with the expected fields after first fire", () => {
    const counter = subgraph.entity("SignedCounter", "0");
    assert.ok(counter, "SignedCounter id=0 should exist after first fire");
    assert.equal(counter.id, "0");
    assert.equal(counter.value, 42n);
  });

  await t.test("host captured one save + one load for the dispatch", () => {
    assert.equal(subgraph.host.captured.storeSets.length, 1);
    assert.equal(subgraph.host.captured.storeGets.length, 1);
    assert.equal(
      subgraph.host.captured.storeSets[0].entityType,
      "SignedCounter",
    );
  });

  fireSignedValueSet(builder, handlers, 100n);

  await t.test("second fire overwrites entity in place", () => {
    const counter = subgraph.entity("SignedCounter", "0");
    assert.ok(counter);
    assert.equal(counter.value, 100n);
    assert.equal(subgraph.host.captured.storeSets.length, 2);
  });

  fireSignedValueSet(builder, handlers, -7n);

  await t.test("negative BigInt round-trips through two's complement", () => {
    const counter = subgraph.entity("SignedCounter", "0");
    assert.ok(counter);
    assert.equal(counter.value, -7n);
  });

  await subgraph.reset();
  // Re-bind to the fresh wasm instance: exports + memory all swapped.
  builder = new EventBuilder(subgraph.exports);
  handlers = subgraph.exports as unknown as HandlerExports;

  await t.test("after reset, the entity is gone", () => {
    assert.equal(subgraph.entity("SignedCounter", "0"), null);
    assert.deepEqual(subgraph.entities("SignedCounter"), {});
    assert.equal(subgraph.host.captured.storeSets.length, 0);
  });

  await t.test("post-reset, fresh dispatch works against the new instance", () => {
    fireSignedValueSet(builder, handlers, 999n);
    const counter = subgraph.entity("SignedCounter", "0");
    assert.ok(counter);
    assert.equal(counter.value, 999n);
  });
});
