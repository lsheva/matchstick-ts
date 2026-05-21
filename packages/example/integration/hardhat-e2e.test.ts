/**
 * Full-stack integration: deploy → bind → index.
 * Each index() replays the full event buffer from the start (see package README).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { read } from "matchstick-ts";
import { deployCounter } from "../src/deploy-counter.ts";

const conn = await network.getOrCreate();

describe("Hardhat → Matchstick → Counter", () => {
  after(() => conn.matchstick.reset());

  it("indexes setValue from chain logs", async () => {
    const { counter, abi, address } = await deployCounter(conn);
    const walletClients = await conn.viem.getWalletClients();
    const wallet = walletClients[0];

    // `bind` is sync — records the data source and seeds revert mocks for
    // every 0-arg view fn so handler `try_*` reads resolve gracefully.
    conn.matchstick.bind("Counter", address, abi);
    await conn.matchstick.anchor();

    const newFee = 42n;
    await counter.write.setValue([newFee], {
      account: wallet.account,
      chain: wallet.chain,
    });

    const [entity] = await conn.matchstick.index([read("Counter", "0")]);

    assert.ok(entity);
    assert.equal(entity.value, newFee.toString());
    // Without `captureViewMocks()`, the handler's `try_multiplier()` reverts
    // and `scaledValue` stays at its initial zero.
    assert.equal(entity.scaledValue, "0");
    assert.equal(conn.matchstick.eventCount, 1);
  });

  it("captures real on-chain view values via `captureViewMocks`", async () => {
    const { counter, abi, address } = await deployCounter(conn, { multiplier: 7n });
    await conn.matchstick.reset();

    conn.matchstick.bind("Counter", address, abi);
    // Probe every 0-arg view fn on bound contracts via `eth_call` and
    // upgrade the seeded revert mocks to return mocks carrying the real
    // values — handler `try_multiplier()` now observes `7n`.
    await conn.matchstick.captureViewMocks();
    await conn.matchstick.anchor();

    const wallet = (await conn.viem.getWalletClients())[0];
    await counter.write.setValue([6n], { account: wallet.account, chain: wallet.chain });

    const [entity] = await conn.matchstick.index([read("Counter", "0")]);
    assert.ok(entity);
    assert.equal(entity.value, "6");
    assert.equal(entity.scaledValue, "42", "scaledValue = newValue * multiplier (6 * 7)");
  });

  it("second index() only ingests blocks after the first", async () => {
    const { counter, abi, address } = await deployCounter(conn);
    conn.matchstick.reset();
    conn.matchstick.bind("Counter", address, abi);
    await conn.matchstick.anchor();

    const wallet = (await conn.viem.getWalletClients())[0];
    const reads = [read("Counter", "0")] as const;

    await counter.write.setValue([1n], { account: wallet.account, chain: wallet.chain });
    await conn.matchstick.index(reads);
    const blockAfterFirst = conn.matchstick.lastSyncedBlock;

    await counter.write.setValue([2n], { account: wallet.account, chain: wallet.chain });
    const [entity] = await conn.matchstick.index(reads);

    assert.ok(entity);
    assert.equal(entity.value, "2");
    assert.equal(conn.matchstick.eventCount, 2);
    assert.ok(blockAfterFirst !== undefined);
    assert.ok(conn.matchstick.lastSyncedBlock! > blockAfterFirst);
  });

  it("returns saved entities without knowing their IDs upfront", async () => {
    const { counter, abi, address } = await deployCounter(conn);
    conn.matchstick.reset();
    conn.matchstick.bind("Counter", address, abi);
    await conn.matchstick.anchor();

    const wallet = (await conn.viem.getWalletClients())[0];
    await counter.write.setValue([7n], { account: wallet.account, chain: wallet.chain });

    const snap = await conn.matchstick.indexSnapshot([]);

    const [entity] = snap.saved("Counter");
    assert.ok(entity);
    assert.equal(entity.value, "7");
  });
});
