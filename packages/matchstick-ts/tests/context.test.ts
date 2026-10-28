import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Address } from "viem";
import { mergeContextOverrides, resolveContextOverrides, type ContextOverrides } from "../src/context.ts";
import { readSubgraphManifest } from "../src/codegen/parse-subgraph-manifest.ts";
import { cleanupJsonFiles, writeJsonInputs } from "../src/snapshot.ts";
import { SubgraphLogSync, type LogsQueryingClient } from "../src/log-sync.ts";

const MANIFEST = "tests/fixtures/context/subgraph.yaml";
const manifest = await readSubgraphManifest(MANIFEST);

describe("resolveContextOverrides", () => {
  it("infers plain value types from the manifest entry with the same key", () => {
    const resolved = resolveContextOverrides(manifest, {
      Oracle: {
        feed: "0x00000000000000000000000000000000000000bb",
        startBlock: 9007199254740993n,
        enabled: false,
      },
    });
    assert.deepEqual(resolved, {
      Oracle: {
        feed: { type: "String", data: "0x00000000000000000000000000000000000000bb" },
        startBlock: { type: "BigInt", data: "9007199254740993" },
        enabled: { type: "Bool", data: false },
      },
    });
  });

  it("accepts explicit entries for keys the manifest does not declare, including templates", () => {
    const resolved = resolveContextOverrides(manifest, {
      Oracle: { decimals: { type: "Int", data: 8 } },
      Aggregator: {
        pair: { type: "String", data: "BTC/USD" },
        weights: { type: "List", data: [{ type: "Int8", data: 5n }, { type: "Boolean", data: "true" }] },
      },
    });
    assert.deepEqual(resolved, {
      Oracle: { decimals: { type: "Int", data: "8" } },
      Aggregator: {
        pair: { type: "String", data: "BTC/USD" },
        weights: {
          type: "List",
          data: [
            { type: "Int8", data: "5" },
            { type: "Boolean", data: true },
          ],
        },
      },
    });
  });

  it("throws for a plain value whose key is not in the manifest", () => {
    assert.throws(
      () => resolveContextOverrides(manifest, { Aggregator: { pair: "BTC/USD" } }),
      /context key "pair" is not in the manifest context of "Aggregator".*pass \{ type, data \}/,
    );
  });

  it("throws for an unknown data source", () => {
    assert.throws(
      () => resolveContextOverrides(manifest, { Nope: { feed: "x" } }),
      /unknown data source "Nope" \(manifest has "Oracle", "Aggregator"\)/,
    );
  });

  it("requires explicit entries for List keys and mismatched data", () => {
    assert.throws(
      () => resolveContextOverrides(manifest, { Oracle: { weights: 1 } }),
      /Oracle\.context\.weights is a List in the manifest/,
    );
    assert.throws(
      () => resolveContextOverrides(manifest, { Oracle: { enabled: "yes" } }),
      /Oracle\.context\.enabled is Bool but got "yes"/,
    );
  });
});

describe("mergeContextOverrides", () => {
  it("lets later maps win per key and keeps the other keys", () => {
    const merged = mergeContextOverrides(
      { Oracle: { feed: "a", startBlock: 1n } },
      undefined,
      { Oracle: { feed: "b" }, Aggregator: { pair: { type: "String", data: "x" } } },
    );
    assert.deepEqual(merged, {
      Oracle: { feed: "b", startBlock: 1n },
      Aggregator: { pair: { type: "String", data: "x" } },
    });
  });
});

describe("writeJsonInputs", () => {
  it("writes resolved overrides to context.json and cleanupJsonFiles removes it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctx-json-"));
    try {
      await writeJsonInputs(dir, manifest, {
        events: [],
        reads: [],
        context: { Oracle: { startBlock: 7 } },
      });
      const written = JSON.parse(await readFile(join(dir, "context.json"), "utf8"));
      assert.deepEqual(written, { Oracle: { startBlock: { type: "BigInt", data: "7" } } });

      await cleanupJsonFiles(dir);
      await assert.rejects(() => readFile(join(dir, "context.json")), /ENOENT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes an empty object without overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctx-json-"));
    try {
      await writeJsonInputs(dir, manifest, { events: [], reads: [] });
      assert.equal(await readFile(join(dir, "context.json"), "utf8"), "{}");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects before writing anything when an override is invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctx-json-"));
    try {
      await writeFile(join(dir, "events.json"), "stale");
      await assert.rejects(
        () => writeJsonInputs(dir, manifest, { events: [], reads: [], context: { Oracle: { missing: 1 } } }),
        /context key "missing"/,
      );
      assert.equal(await readFile(join(dir, "events.json"), "utf8"), "stale");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("SubgraphLogSync context overrides", () => {
  const client: LogsQueryingClient = { getBlockNumber: async () => 0n, getLogs: async () => [] };
  const address = "0x0000000000000000000000000000000000000001" as Address;
  type WithOverrides = { contextOverrides(run?: { context?: ContextOverrides }): ContextOverrides };

  it("merges run defaults, bindings and per-call overrides, and reset() clears bindings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctx-sync-"));
    const sync = new SubgraphLogSync({
      client,
      runDefaults: {
        context: { Oracle: { feed: "default", startBlock: 1n } },
        runnerPath: join(dir, "runner.test.ts"),
        jsonDir: join(dir, ".tmp"),
      },
    });
    sync.bind("Oracle", address, [], { context: { feed: "bound" } });
    sync.bind("Aggregator", address, [], { context: { pair: { type: "String", data: "BTC/USD" } } });

    const merge = (run?: { context?: ContextOverrides }) =>
      (sync as unknown as WithOverrides).contextOverrides(run);
    assert.deepEqual(merge({ context: { Oracle: { startBlock: 2n } } }), {
      Oracle: { feed: "bound", startBlock: 2n },
      Aggregator: { pair: { type: "String", data: "BTC/USD" } },
    });

    await sync.reset();
    assert.deepEqual(merge(), { Oracle: { feed: "default", startBlock: 1n } });
    await rm(dir, { recursive: true, force: true });
  });
});
