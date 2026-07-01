/**
 * Phase 1 lock-in test for the asyncify integration.
 *
 * What this proves:
 *   - `WasmRunner.compile` applies binaryen's asyncify pass — the
 *     resulting wasm exposes the five `asyncify_*` exports.
 *   - The JS-side `Asyncify` runtime allocates its unwind buffer and
 *     leaves the wasm in `STATE_NORMAL` after a sync dispatch.
 *   - `subgraph.run(() => sync handler)` is a strict superset of
 *     `subgraph.exports.handlerX(...)` — anything the sync API does
 *     today works wrapped, so Phase 2 callers can adopt `run()` once
 *     and not care whether a given handler ever suspends.
 *
 * What it does NOT prove (Phase 2):
 *   - Actual unwind/rewind across an async import.
 *   - That `asyncify.wrapAsyncImport` returns the resolved value to
 *     the wasm correctly.
 *
 * Those need a synthetic async import wired through the host shim,
 * which Phase 2 will do as part of `ethereum.call -> RpcClient`.
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

interface HandlerExports {
  handleSignedValueSet(eventPtr: number): void;
}

test("asyncify integration: exports + sync run + state hygiene", async (t) => {
  if (!existsSync(BUNDLE_WASM)) {
    t.skip(`example-bundle.wasm missing at ${BUNDLE_WASM}`);
    return;
  }

  const runner = await WasmRunner.compile(BUNDLE_WASM);
  const subgraph = await runner.instantiate();

  await t.test("transformed wasm exposes the asyncify export shape", () => {
    const e = subgraph.exports;
    for (const name of [
      "asyncify_start_unwind",
      "asyncify_stop_unwind",
      "asyncify_start_rewind",
      "asyncify_stop_rewind",
      "asyncify_get_state",
    ] as const) {
      assert.equal(typeof e[name], "function", `expected ${name} export to be a function`);
    }
  });

  await t.test("asyncify runtime starts in STATE_NORMAL (=0)", () => {
    assert.equal(subgraph.exports.asyncify_get_state(), 0);
  });

  // Use the same fire pattern as fire-event.test.ts to fully exercise
  // a real handler under asyncify, just wrapped in `run()` instead of
  // called directly.
  const builder = new EventBuilder(subgraph.exports);
  const handlers = subgraph.exports as unknown as HandlerExports;

  await t.test("subgraph.run() dispatches a sync handler successfully", async () => {
    const eventPtr = builder.buildEvent([
      builder.param("newValue", builder.signedBigInt(42n)),
    ]);
    await subgraph.run(() => handlers.handleSignedValueSet(eventPtr));
    const counter = subgraph.entity("SignedCounter", "0");
    assert.ok(counter, "handler should have written SignedCounter[0]");
    assert.equal(counter.value, 42n);
  });

  await t.test("asyncify state stays NORMAL after a sync handler", () => {
    assert.equal(
      subgraph.exports.asyncify_get_state(),
      0,
      "wasm should not be left in unwinding/rewinding after sync handler",
    );
  });

  await t.test("subgraph.run() is reusable across multiple dispatches", async () => {
    const eventPtr = builder.buildEvent([
      builder.param("newValue", builder.signedBigInt(-99n)),
    ]);
    await subgraph.run(() => handlers.handleSignedValueSet(eventPtr));
    const counter = subgraph.entity("SignedCounter", "0");
    assert.ok(counter);
    assert.equal(counter.value, -99n);
    assert.equal(subgraph.exports.asyncify_get_state(), 0);
  });

  await t.test("after reset, asyncify rebinds to the fresh wasm instance", async () => {
    await subgraph.reset();
    const e = subgraph.exports;
    assert.equal(typeof e.asyncify_start_unwind, "function");
    assert.equal(e.asyncify_get_state(), 0);

    // And dispatches still work post-reset.
    const builder2 = new EventBuilder(subgraph.exports);
    const handlers2 = subgraph.exports as unknown as HandlerExports;
    const eventPtr = builder2.buildEvent([
      builder2.param("newValue", builder2.signedBigInt(7n)),
    ]);
    await subgraph.run(() => handlers2.handleSignedValueSet(eventPtr));
    const counter = subgraph.entity("SignedCounter", "0");
    assert.ok(counter);
    assert.equal(counter.value, 7n);
  });
});
