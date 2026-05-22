/**
 * Smoke test for the per-indexer bundle build pipeline.
 *
 * Asserts the asc multi-entry build (`scaffold.ts` + indexer handler
 * entry) actually produces a wasm with:
 *   1. The scaffold's indexer-agnostic exports (`newMockEvent`,
 *      `bigIntFromU32`).
 *   2. The example indexer's handler exports (`handleValueSet`,
 *      `handleSignedValueSet`), proving cross-package compilation
 *      works and asc didn't tree-shake them.
 *   3. A working graph-ts linkage — `BigInt.fromU32` round-trips a
 *      u32 through the bundle.
 *
 * Anything broader (entity dispatch, store capture) lives in
 * `fire-event.test.ts` against the same wasm.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { WasmRunner } from "../src/runner.ts";
import { inspectWasm } from "../src/inspect.ts";

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE_WASM = resolve(here, "../build/example-bundle.wasm");

interface ScaffoldExports {
  bigIntFromU32(value: number): number;
}

test("buildBundle produces a wasm with scaffold + handler exports", async (t) => {
  if (!existsSync(BUNDLE_WASM)) {
    t.skip(
      `example-bundle.wasm missing at ${BUNDLE_WASM} — run \`pnpm --filter wasm-runner build:example-bundle\``,
    );
    return;
  }

  const schema = await inspectWasm(BUNDLE_WASM);
  const fnNames = schema.exports
    .filter((e) => e.kind === "function")
    .map((e) => e.name);

  await t.test("scaffold exports are present", () => {
    for (const required of ["newMockEvent", "bigIntFromU32"]) {
      assert.ok(
        fnNames.includes(required),
        `missing scaffold export \`${required}\``,
      );
    }
  });

  await t.test("example indexer handler exports are present", () => {
    assert.deepEqual(schema.handlerExports.sort(), [
      "handleSignedValueSet",
      "handleValueSet",
    ]);
  });

  const runner = await WasmRunner.compile(BUNDLE_WASM);
  const subgraph = await runner.instantiate();
  const scaffold = subgraph.exports as unknown as ScaffoldExports;

  await t.test("BigInt.fromU32 round-trips through the bundle", () => {
    const ptr = scaffold.bigIntFromU32(0x01020304);
    const u8 = subgraph.exports.__getUint8Array(ptr);
    assert.ok(u8.length >= 1 && u8.length <= 8);
    let reconstructed = 0n;
    for (let i = u8.length - 1; i >= 0; i--) {
      reconstructed = (reconstructed << 8n) | BigInt(u8[i]);
    }
    assert.equal(reconstructed, 0x01020304n);
  });
});
