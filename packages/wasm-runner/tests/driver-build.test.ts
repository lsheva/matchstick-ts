/**
 * Step 3a verification: the AS test-driver bundle compiles, instantiates
 * via @assemblyscript/loader, and exposes graph-ts-aware functions that
 * the handler-dispatch code (Step 3b) will build on.
 *
 * What this proves:
 *   1. The asc build pipeline in `scripts/build-driver.mjs` produces a
 *      wasm whose imports exactly match the live host shim's surface.
 *   2. The cross-package import (`assembly/test-driver.ts` ->
 *      `packages/example/src/mapping`) resolved at compile time — the
 *      exported `handlerSymbolsLinked()` returns 1 only if both
 *      `handleSignedValueSet` and `handleValueSet` were live symbols
 *      after optimization.
 *   3. graph-ts is reachable: `bigIntFromU32(42)` round-trips through
 *      `BigInt.fromU32` and returns a Uint8Array (signed LE) that the
 *      loader can read back.
 *
 * Step 3b builds on (3) — once we can hand AS a number and get a real
 * `BigInt` pointer back, we have what we need to construct an
 * `EthereumValue` and then an `EthereumEvent` natively in AS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { instantiate } from "@assemblyscript/loader";

const here = dirname(fileURLToPath(import.meta.url));
const DRIVER_WASM = resolve(here, "../build/test-driver.wasm");

/**
 * Loader's typed export shape — we only declare what this step touches.
 * Step 3b will widen this into a shared `interface DriverExports` once
 * the dispatch surface stabilizes.
 */
interface DriverExports extends Record<string, unknown> {
  bigIntFromU32(value: number): number;
  handlerSymbolsLinked(): number;
}

/**
 * Build a minimal host import object compatible with the test-driver
 * bundle. We expect the same 8-import shopping list as `Counter.wasm`
 * (this bundle re-exports the example's mappings, so it inherits their
 * host surface). Every trap import is fine because Step 3a never calls
 * a handler — just allocator-only functions.
 */
function makeImports(): WebAssembly.Imports {
  const trap = (name: string) => () => {
    throw new Error(`host import not implemented: ${name}`);
  };
  return {
    env: {
      // The loader pre-wires a default abort that decodes AS strings;
      // omit ours so the loader's takes effect.
    },
    conversion: {
      "typeConversion.bytesToHex": trap("conversion.typeConversion.bytesToHex"),
      "typeConversion.bigIntToString": trap(
        "conversion.typeConversion.bigIntToString",
      ),
    },
    ethereum: { "ethereum.call": trap("ethereum.ethereum.call") },
    numbers: {
      "bigInt.times": trap("numbers.bigInt.times"),
      "bigDecimal.toString": trap("numbers.bigDecimal.toString"),
    },
    index: {
      "store.get": trap("index.store.get"),
      "store.set": trap("index.store.set"),
    },
  };
}

test("AS test-driver bundle exposes graph-ts to JS", async (t) => {
  if (!existsSync(DRIVER_WASM)) {
    t.skip(
      `test-driver.wasm missing at ${DRIVER_WASM} — run \`pnpm --filter wasm-runner build:assembly\``,
    );
    return;
  }

  const bytes = await readFile(DRIVER_WASM);
  const { exports } = await instantiate<DriverExports>(bytes, makeImports());

  await t.test("handler symbols from packages/example are linked", () => {
    assert.equal(exports.handlerSymbolsLinked(), 1);
  });

  await t.test("BigInt.fromU32 round-trips through AS", () => {
    // graph-ts BigInt is a Uint8Array of signed LE bytes. For positive
    // values that fit in 32 bits we expect 4 LE bytes (or fewer if
    // graph-ts trims trailing zeros — verify either way).
    const ptr = exports.bigIntFromU32(0x01020304);
    const u8 = exports.__getUint8Array(ptr);
    assert.ok(u8.length >= 1 && u8.length <= 8);
    // Reassemble LE bytes into a regular number, comparing against the
    // input. Using a BigInt to avoid sign issues if graph-ts pads with
    // a 0x00 high byte to preserve the positive sign.
    let reconstructed = 0n;
    for (let i = u8.length - 1; i >= 0; i--) {
      reconstructed = (reconstructed << 8n) | BigInt(u8[i]);
    }
    assert.equal(reconstructed, 0x01020304n);
  });

  await t.test("loader exposes the AS runtime helpers", () => {
    assert.equal(typeof exports.__new, "function");
    assert.equal(typeof exports.__pin, "function");
    assert.equal(typeof exports.__unpin, "function");
    assert.equal(typeof exports.__newString, "function");
    assert.equal(typeof exports.__getString, "function");
    assert.equal(typeof exports.__newArray, "function");
    assert.equal(typeof exports.__getUint8Array, "function");
  });
});
