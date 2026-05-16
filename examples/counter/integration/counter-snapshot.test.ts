/**
 * End-to-end example: deploy Counter on Hardhat, capture ValueSet, replay via
 * subgraph-snapshot + Matchstick, assert on the indexed Counter entity.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { runMatchstickTest, EventCapture, viewFunctionRevertMocks } from "subgraph-snapshot";
import { getOrCreateNode } from "subgraph-snapshot/hardhat";
import { deployCounter } from "../src/deploy-counter.ts";

describe("Counter ValueSet via subgraph-snapshot", async () => {
  const node = await getOrCreateNode();
  const { conn } = node;
  let capture: EventCapture;

  before(async () => {
    capture = new EventCapture(await conn.viem.getPublicClient());
  });

  it("indexes setValue through the mapping", async () => {
    const { counter, abi, address } = await deployCounter(conn);
    const walletClients = await conn.viem.getWalletClients();
    const wallet = walletClients[0];

    const newValue = 42n;
    const txHash = await counter.write.setValue([newValue], { account: wallet.account });

    await capture.captureFromReceipt(txHash, abi);

    const snap = await runMatchstickTest({
      events: capture.serialize(),
      reads: [{ entityType: "Counter", id: "0" }],
      revertMocks: viewFunctionRevertMocks(abi, address),
    });

    assert.equal(snap.get("Counter", "0", "value"), newValue.toString());

    const entity = snap.entity("Counter", "0");
    assert.ok(entity, "Counter#0 should exist after ValueSet");
    assert.equal(entity.value, "42");
  });

  after(async () => {
    await node.close();
  });
});
