/**
 * `wasm-runner` against a real Hardhat network.
 *
 * Wires Hardhat's viem `PublicClient` directly into `Subgraph.create`.
 * The runner adapts the client for both `ethereum.call` (with viem
 * revert detection) and the log-fetch loop, and auto-discovers
 * `subgraph.yaml` + auto-compiles the wasm bundle from the manifest's
 * `mapping.file`. The user-facing config is just: "here's the chain,
 * here's how to patch the deployed address into the data sources".
 *
 * What this proves:
 *   - Zero pre-build / zero manual yaml load: `Subgraph.create` walks
 *     `process.cwd()` up to find `subgraph.yaml`, compiles the wasm
 *     once per process, and reuses the result across `create()` calls.
 *   - Compile transparently falls back to a child process under
 *     Hardhat's `tsx` loader hook (which otherwise breaks asc's
 *     `package.json` resolution at load time).
 *   - Real `eth_call` round-trips through asyncify; handler's
 *     `try_multiplier()` returns the live on-chain value pinned to
 *     each event's block.
 *   - Block timestamps come from `getBlock(...)` lazily during the
 *     run loop and reach the handler's `event.block.timestamp`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { Subgraph, type DataSourceSpec } from "wasm-runner";
import type { Hex } from "viem";
import { deployCounter } from "../src/deploy-counter.ts";

const conn = await network.getOrCreate();

/**
 * Reusable `dataSources` override: stamp the deployed contract
 * address onto every entry the manifest produced. Receives the
 * auto-loaded `LoadedManifest`, returns the patched specs.
 */
function withAddress(
  address: Hex,
): (m: { dataSources: DataSourceSpec[] }) => DataSourceSpec[] {
  return (m) =>
    m.dataSources.map((ds) => ({
      ...ds,
      address: address.toLowerCase() as Hex,
    }));
}

describe("wasm-runner: Hardhat-network end-to-end via Subgraph.start", () => {
  it("backfills real chain logs and decodes them into entities", async () => {
    const { counter, address } = await deployCounter(conn, { multiplier: 7n });
    const wallet = (await conn.viem.getWalletClients())[0];
    const publicClient = await conn.viem.getPublicClient();
    if (!wallet.account) throw new Error("no wallet account");

    const fromBlock = await publicClient.getBlockNumber();
    // Three setValue calls -> three ValueSet events.
    await counter.write.setValue([5n], { account: wallet.account, chain: wallet.chain });
    await counter.write.setValue([8n], { account: wallet.account, chain: wallet.chain });
    await counter.write.setValue([13n], { account: wallet.account, chain: wallet.chain });
    const toBlock = await publicClient.getBlockNumber();

    const subgraph = await Subgraph.create({
      client: publicClient,
      dataSources: withAddress(address),
    });

    await subgraph.start({ fromBlock, toBlock });
    assert.equal(subgraph.runState, "idle");
    assert.equal(subgraph.processedBlock, toBlock);

    const entity = subgraph.entity("Counter", "0");
    assert.ok(entity);
    // Last-write-wins: latest setValue was 13n.
    assert.equal(entity.value, 13n);
    // `try_multiplier()` routed through Hardhat -> on-chain `7n`.
    // scaledValue = 13 * 7 = 91.
    assert.equal(entity.scaledValue, 91n);
  });

  it("mockCall(...) overrides the chain for selected reads", async () => {
    const { counter, address } = await deployCounter(conn, { multiplier: 7n });
    const wallet = (await conn.viem.getWalletClients())[0];
    const publicClient = await conn.viem.getPublicClient();
    if (!wallet.account) throw new Error("no wallet account");

    const fromBlock = await publicClient.getBlockNumber();
    await counter.write.setValue([3n], { account: wallet.account, chain: wallet.chain });
    const toBlock = await publicClient.getBlockNumber();

    const subgraph = await Subgraph.create({
      client: publicClient,
      dataSources: withAddress(address),
    });
    // Hijack `multiplier()` to return 100 instead of the real 7.
    // Mocks always win over the fallback `client` — handy for
    // shoving a contract into a degenerate state without redeploying.
    subgraph
      .mockCall(address as Hex, "multiplier():(uint256)")
      .withAnyArgs()
      .returns([100n]);

    await subgraph.start({ fromBlock, toBlock });
    assert.equal(subgraph.entity("Counter", "0")?.value, 3n);
    assert.equal(subgraph.entity("Counter", "0")?.scaledValue, 300n);
    assert.equal(
      subgraph.mocks.hitCount(address as Hex, "multiplier():(uint256)"),
      1,
    );
  });

  it("tail mode picks up new logs as Hardhat mines them", async () => {
    const { counter, address } = await deployCounter(conn, { multiplier: 2n });
    const wallet = (await conn.viem.getWalletClients())[0];
    const publicClient = await conn.viem.getPublicClient();
    if (!wallet.account) throw new Error("no wallet account");

    const fromBlock = await publicClient.getBlockNumber();
    const subgraph = await Subgraph.create({
      client: publicClient,
      dataSources: withAddress(address),
    });

    // Start in tail mode — no `toBlock`, so the loop polls forever.
    const done = subgraph.start({
      fromBlock,
      pollIntervalMs: 50,
    });
    try {
      // Mine some events post-start.
      await counter.write.setValue([4n], { account: wallet.account, chain: wallet.chain });
      await counter.write.setValue([9n], { account: wallet.account, chain: wallet.chain });

      // Wait for the run loop to ingest both. `processedBlock` only
      // ticks at the end of each batch, so polling on entity state
      // is the most reliable signal.
      const start = Date.now();
      while (
        (subgraph.entity("Counter", "0")?.value !== 9n) &&
        Date.now() - start < 5000
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(subgraph.entity("Counter", "0")?.value, 9n);
      assert.equal(subgraph.entity("Counter", "0")?.scaledValue, 18n);
    } finally {
      await subgraph.stop();
      await done;
    }
    assert.equal(subgraph.runState, "idle");
  });
});
