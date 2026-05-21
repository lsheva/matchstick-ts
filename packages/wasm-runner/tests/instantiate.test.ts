/**
 * Verifies that `WasmRunner.instantiate()` returns a working
 * `SubgraphInstance` against the production `Counter.wasm` artifact
 * `graph build` produces for the example subgraph. Counter.wasm has
 * no `fire*` entry points (those live in the test-driver bundle), so
 * we exercise just instantiation, the wrapper surface, reset()
 * semantics, and the not-implemented trap behavior.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { WasmRunner } from "../src/runner.ts";
import { NotImplementedError, WasmAbortError } from "../src/host.ts";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_WASM = resolve(
  here,
  "../../example/build/Counter/Counter.wasm",
);

function ensureWasmExists(t: { skip: (msg: string) => void }): boolean {
  if (!existsSync(EXAMPLE_WASM)) {
    t.skip(
      `Counter.wasm missing at ${EXAMPLE_WASM} — run \`pnpm graph build\` in packages/example`,
    );
    return false;
  }
  return true;
}

test("WasmRunner instantiates Counter.wasm into a SubgraphInstance", async (t) => {
  if (!ensureWasmExists(t)) return;

  const runner = await WasmRunner.compile(EXAMPLE_WASM);
  const subgraph = await runner.instantiate();

  await t.test("exports the AS runtime + handler functions", () => {
    const exps = subgraph.exports as Record<string, unknown>;
    assert.equal(typeof subgraph.exports.__new, "function");
    assert.equal(typeof subgraph.exports.__pin, "function");
    assert.equal(typeof subgraph.exports.__unpin, "function");
    assert.equal(typeof subgraph.exports.__newArray, "function");
    assert.equal(typeof subgraph.exports.__getUint8Array, "function");
    assert.equal(typeof exps.handleValueSet, "function");
    assert.equal(typeof exps.handleSignedValueSet, "function");
    assert.ok(subgraph.exports.memory instanceof WebAssembly.Memory);
  });

  await t.test("fresh subgraph has no entities and no captures", () => {
    assert.equal(subgraph.host.store.size, 0);
    assert.equal(subgraph.host.captured.storeGets.length, 0);
    assert.equal(subgraph.host.captured.storeSets.length, 0);
    assert.equal(subgraph.entity("Counter", "0"), null);
    assert.deepEqual(subgraph.entities("Counter"), {});
  });

  await t.test("WasmAbortError class is exported and constructible", () => {
    const err = new WasmAbortError("msg", "file.ts", 1, 2);
    assert.match(err.message, /wasm abort: msg \(file\.ts:1:2\)/);
    assert.equal(err.file, "file.ts");
    assert.equal(err.line, 1);
    assert.equal(err.column, 2);
  });

  await t.test(
    "calling a not-yet-implemented import throws NotImplementedError",
    () => {
      const ethereumImports = subgraph.host.imports.ethereum as Record<
        string,
        unknown
      >;
      const ethCall = ethereumImports["ethereum.call"] as () => void;
      assert.throws(
        () => ethCall(),
        (err: unknown) =>
          err instanceof NotImplementedError &&
          /ethereum\.ethereum\.call/.test(err.message),
      );
    },
  );
});

test("WasmRunner.compile produces independent SubgraphInstances", async (t) => {
  if (!ensureWasmExists(t)) return;

  const runner = await WasmRunner.compile(EXAMPLE_WASM);
  const a = await runner.instantiate();
  const b = await runner.instantiate();

  assert.notEqual(a.host, b.host);
  assert.notEqual(a.exports.memory, b.exports.memory);

  a.host.store.set("X", new Map([["1", 42]]));
  assert.equal(b.host.store.size, 0);
});

test("SubgraphInstance.reset() returns the subgraph to fresh state", async (t) => {
  if (!ensureWasmExists(t)) return;

  const runner = await WasmRunner.compile(EXAMPLE_WASM);
  const subgraph = await runner.instantiate();

  // Pollute state manually (no handler dispatch here — Counter.wasm
  // has no fire* entry — so we just write directly into host.store
  // to simulate accumulated state).
  subgraph.host.store.set("Counter", new Map([["0", 12345]]));
  subgraph.host.captured.storeSets.push({
    entityType: "Counter",
    id: "0",
    entityPtr: 12345,
  });
  assert.equal(subgraph.host.store.size, 1);
  assert.equal(subgraph.host.captured.storeSets.length, 1);

  const memoryBefore = subgraph.exports.memory;
  await subgraph.reset();

  await t.test("host state cleared", () => {
    assert.equal(subgraph.host.store.size, 0);
    assert.equal(subgraph.host.captured.storeSets.length, 0);
    assert.equal(subgraph.host.captured.storeGets.length, 0);
  });

  await t.test("wasm instance was rebuilt (memory swapped)", () => {
    assert.notEqual(subgraph.exports.memory, memoryBefore);
  });
});
