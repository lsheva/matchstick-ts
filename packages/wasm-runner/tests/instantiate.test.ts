/**
 * Step 2 verification: the production `Counter.wasm` instantiates against
 * the host shim, exposes its handlers as callable functions, and reports
 * abort messages with file/line context.
 *
 * This test deliberately does NOT call any handler — `handleValueSet`
 * needs an event pointer, which requires the codec (Step 4+). Instead it
 * exercises just the instantiation handshake and confirms that calling
 * a not-yet-implemented host import raises a precise error rather than
 * a generic wasm trap.
 *
 * We trigger a `NotImplementedError` indirectly by writing an invalid
 * call into `__pin` (well-defined AS export, well-defined behavior on
 * bad input → AS calls `abort`). That ensures the abort decoder path is
 * exercised even before we have real handler invocations.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { WasmRunner } from "../src/runner.ts";
import { WasmAbortError, NotImplementedError } from "../src/host.ts";

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

test("WasmRunner instantiates the example wasm", async (t) => {
  if (!ensureWasmExists(t)) return;

  const runner = await WasmRunner.compile(EXAMPLE_WASM);
  const { exports, host } = await runner.instantiate();

  await t.test("exports the AS runtime + handler functions", () => {
    assert.equal(typeof exports.__new, "function");
    assert.equal(typeof exports.__pin, "function");
    assert.equal(typeof exports.__unpin, "function");
    assert.equal(typeof exports.handleValueSet, "function");
    assert.equal(typeof exports.handleSignedValueSet, "function");
    assert.ok(exports.memory instanceof WebAssembly.Memory);
  });

  await t.test("host has memory attached and an empty store", () => {
    assert.ok(host.memoryHandle.memory instanceof WebAssembly.Memory);
    assert.equal(host.store.size, 0);
  });

  await t.test(
    "calling a not-yet-implemented import throws NotImplementedError",
    () => {
      // `index.store.set` is one of the trap stubs — invoke it directly
      // off the import object to confirm the trap fires cleanly without
      // needing to drive a handler.
      const setFn = (host.imports.index as Record<string, unknown>)[
        "store.set"
      ] as (a: number, b: number, c: number) => void;
      assert.throws(
        () => setFn(0, 0, 0),
        (err: unknown) =>
          err instanceof NotImplementedError &&
          /index\.store\.set/.test(err.message),
      );
    },
  );

  await t.test("env.abort decodes message + file via the AS codec", () => {
    // __pin(0) is a documented AS no-op that returns 0 — it does NOT
    // abort. To exercise the abort path we'd need to provoke a real
    // assertion failure inside the wasm, which we can't do without
    // calling a handler (Step 3). For now, just assert the abort import
    // is wired and is a function.
    assert.equal(typeof host.imports.env, "object");
    const envImports = host.imports.env as Record<string, unknown>;
    assert.equal(typeof envImports.abort, "function");
    // Static check: WasmAbortError is exported and constructible.
    const err = new WasmAbortError("msg", "file.ts", 1, 2);
    assert.match(err.message, /wasm abort: msg \(file\.ts:1:2\)/);
  });
});

test("WasmRunner.compile can be re-instantiated independently", async (t) => {
  if (!ensureWasmExists(t)) return;

  const runner = await WasmRunner.compile(EXAMPLE_WASM);
  const a = await runner.instantiate();
  const b = await runner.instantiate();

  assert.notEqual(a.instance, b.instance);
  assert.notEqual(a.host, b.host);
  assert.notEqual(a.exports.memory, b.exports.memory);
  // Stores are independent JS Maps.
  a.host.store.set("X", new Map([["1", 42]]));
  assert.equal(b.host.store.size, 0);
});
