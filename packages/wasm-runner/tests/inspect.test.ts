/**
 * Smoke test for `inspectWasm`. Locks in the contract between the
 * wasm-runner host shim (yet to be written) and the production subgraph
 * wasm produced by `graph build`:
 *
 *   - Handler functions are surfaced as direct exports (no test-runner
 *     wrapper), so the event-builder can dispatch by export name.
 *   - The AssemblyScript runtime helpers (`__new`, `__pin`, `__unpin`,
 *     `memory`) are exported, so the pointer codec can allocate inside
 *     wasm memory.
 *   - The host-import surface is small and known, so Step 2's host shim
 *     can declare each import explicitly and fail loudly when a new one
 *     appears.
 *
 * Failing this test means either `graph build` wasn't run (regenerate
 * `packages/example/build/Counter/Counter.wasm` via `pnpm graph build`
 * in `packages/example`), or the example's mappings grew a new
 * dependency — in which case Step 2's host shim needs updating too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { inspectWasm } from "../src/inspect.ts";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_WASM = resolve(
  here,
  "../../example/build/Counter/Counter.wasm",
);

test("example subgraph wasm exposes the expected schema", async (t) => {
  if (!existsSync(EXAMPLE_WASM)) {
    t.skip(
      `Counter.wasm missing at ${EXAMPLE_WASM} — run \`pnpm graph build\` in packages/example`,
    );
    return;
  }

  const schema = await inspectWasm(EXAMPLE_WASM);

  await t.test("exports the example's handlers", () => {
    assert.deepEqual(schema.handlerExports.sort(), [
      "handleSignedValueSet",
      "handleValueSet",
    ]);
  });

  await t.test("exports the AssemblyScript runtime helpers", () => {
    const fnNames = schema.exports
      .filter((e) => e.kind === "function")
      .map((e) => e.name);
    for (const required of ["__new", "__pin", "__unpin"]) {
      assert.ok(
        fnNames.includes(required),
        `expected wasm to export function \`${required}\`, got: ${fnNames.join(", ")}`,
      );
    }
    const memoryExport = schema.exports.find(
      (e) => e.kind === "memory" && e.name === "memory",
    );
    assert.ok(memoryExport, "expected wasm to export linear memory as `memory`");
  });

  await t.test(
    "import surface matches the host-shim shopping list",
    () => {
      const importKeys = schema.imports
        .map((i) => `${i.module}.${i.name}`)
        .sort();

      // Every entry here MUST be implemented by the host shim in Step 2.
      // Any new entry showing up in the wasm means either the example's
      // mappings grew a graph-ts dependency, or the indexer pulled in a
      // new vendored module — and Step 2 needs a matching host stub.
      const expected = [
        "conversion.typeConversion.bigIntToString",
        "conversion.typeConversion.bytesToHex",
        "env.abort",
        "ethereum.ethereum.call",
        "index.store.get",
        "index.store.set",
        "numbers.bigDecimal.toString",
        "numbers.bigInt.times",
      ].sort();

      assert.deepEqual(importKeys, expected);
    },
  );
});
