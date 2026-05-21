/**
 * Compile-time smoke test for the AS test-driver bundle.
 *
 * Asserts two things the rest of the suite assumes:
 *   1. The asc build pipeline produced `build/test-driver.wasm` and it
 *      contains the cross-package handler symbols (`handleSignedValueSet`,
 *      `handleValueSet`) live after optimization.
 *   2. graph-ts is reachable from JS through the bundle: a u32 enters
 *      `BigInt.fromU32` on the AS side and comes back as the expected
 *      little-endian byte array via the loader's `__getUint8Array`.
 *
 * Anything broader (entity dispatch, store capture, runtime helpers)
 * is covered by `fire-event.test.ts` against the same wasm.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { WasmRunner } from "../src/runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DRIVER_WASM = resolve(here, "../build/test-driver.wasm");

interface DriverExtras {
  bigIntFromU32(value: number): number;
  handlerSymbolsLinked(): number;
}

test("AS test-driver bundle was built and links graph-ts + handlers", async (t) => {
  if (!existsSync(DRIVER_WASM)) {
    t.skip(
      `test-driver.wasm missing at ${DRIVER_WASM} — run \`pnpm --filter wasm-runner build:assembly\``,
    );
    return;
  }

  const runner = await WasmRunner.compile(DRIVER_WASM);
  const subgraph = await runner.instantiate();
  const exports = subgraph.exports;
  const driver = exports as unknown as DriverExtras;

  await t.test("handler symbols from packages/example are linked", () => {
    assert.equal(driver.handlerSymbolsLinked(), 1);
  });

  await t.test("BigInt.fromU32 round-trips through AS", () => {
    const ptr = driver.bigIntFromU32(0x01020304);
    const u8 = exports.__getUint8Array(ptr);
    assert.ok(u8.length >= 1 && u8.length <= 8);
    let reconstructed = 0n;
    for (let i = u8.length - 1; i >= 0; i--) {
      reconstructed = (reconstructed << 8n) | BigInt(u8[i]);
    }
    assert.equal(reconstructed, 0x01020304n);
  });
});
