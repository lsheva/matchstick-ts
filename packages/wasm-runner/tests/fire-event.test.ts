/**
 * End-to-end spike: feed a SignedValueSet event into the test-driver
 * bundle and read back the resulting entity through the consumer API.
 *
 * Closes the plan's Phase 0 exit criterion:
 *   "a passing node:test that asserts on an entity field"
 *
 * The pattern below is the API the public consumer (matchstick-ts,
 * eventually) will adopt — feed events, query state, reset between
 * scenarios:
 *
 *   const sub = await runner.instantiate();
 *   sub.dispatch(...);
 *   expect(sub.entity("X", "0").value).toEqual(...);
 *   sub.dispatch(...);
 *   await sub.reset();
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { WasmRunner } from "../src/runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DRIVER_WASM = resolve(here, "../build/test-driver.wasm");

/** Test-driver-specific entry points we call from JS. */
interface DriverExtras {
  fireSignedValueSet(newValueBytesPtr: number): void;
}

/**
 * Allocate a graph-ts `BigInt` (= signed LE byte array) in wasm memory
 * holding the provided JS bigint, pin it, and return the pointer.
 *
 * Lives here (test-only) rather than as a runner-level helper because
 * the typed event-construction API is a later step — for the spike we
 * inline the encode.
 */
function allocBigInt(
  subgraph: { exports: { __newArray: (id: number, v: Uint8Array) => number; __pin: (p: number) => number; TypeId: Record<string, WebAssembly.Global> } },
  value: bigint,
): number {
  const bytes = encodeSignedBigInt(value);
  const ptr = subgraph.exports.__newArray(
    subgraph.exports.TypeId.Uint8Array.value as number,
    bytes,
  );
  subgraph.exports.__pin(ptr);
  return ptr;
}

/**
 * JS `bigint` -> graph-ts `BigInt` byte representation (two's complement,
 * little-endian). Mirror of `decodeSignedBigInt` in src/decode.ts.
 */
function encodeSignedBigInt(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array([0]);
  const negative = value < 0n;
  let v = negative ? -(value + 1n) : value;
  const bytes: number[] = [];
  do {
    const b = Number(v & 0xffn);
    bytes.push(negative ? 0xff - b : b);
    v >>= 8n;
  } while (v > 0n);
  const msb = bytes[bytes.length - 1];
  if (!negative && (msb & 0x80) !== 0) {
    bytes.push(0x00);
  } else if (negative && (msb & 0x80) === 0) {
    bytes.push(0xff);
  }
  return Uint8Array.from(bytes);
}

test("dispatch + entity round-trip via SubgraphInstance", async (t) => {
  if (!existsSync(DRIVER_WASM)) {
    t.skip(
      `test-driver.wasm missing at ${DRIVER_WASM} — run \`pnpm --filter wasm-runner build:assembly\``,
    );
    return;
  }

  const runner = await WasmRunner.compile(DRIVER_WASM);
  const subgraph = await runner.instantiate();
  const driver = subgraph.exports as unknown as DriverExtras;

  // Fire #1: newValue = 42
  driver.fireSignedValueSet(allocBigInt(subgraph, 42n));

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

  // Fire #2: state carries over — newValue = 100
  driver.fireSignedValueSet(allocBigInt(subgraph, 100n));

  await t.test("second fire overwrites entity in place", () => {
    const counter = subgraph.entity("SignedCounter", "0");
    assert.ok(counter);
    assert.equal(counter.value, 100n);
    // Both fires recorded as separate saves.
    assert.equal(subgraph.host.captured.storeSets.length, 2);
  });

  // Fire #3 with a negative value to exercise the signed-bytes path.
  driver.fireSignedValueSet(allocBigInt(subgraph, -7n));

  await t.test("negative BigInt round-trips through two's complement", () => {
    const counter = subgraph.entity("SignedCounter", "0");
    assert.ok(counter);
    assert.equal(counter.value, -7n);
  });

  // Reset semantics: fresh state, but the runner pointer survives.
  await subgraph.reset();

  await t.test("after reset, the entity is gone", () => {
    assert.equal(subgraph.entity("SignedCounter", "0"), null);
    assert.deepEqual(subgraph.entities("SignedCounter"), {});
    assert.equal(subgraph.host.captured.storeSets.length, 0);
  });

  await t.test("post-reset, fresh dispatch works against the new instance", () => {
    const freshDriver = subgraph.exports as unknown as DriverExtras;
    freshDriver.fireSignedValueSet(allocBigInt(subgraph, 999n));
    const counter = subgraph.entity("SignedCounter", "0");
    assert.ok(counter);
    assert.equal(counter.value, 999n);
  });
});
