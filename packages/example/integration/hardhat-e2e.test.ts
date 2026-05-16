/**
 * Full-stack integration: Hardhat deploy → viem receipt → EventCapture → Matchstick.
 * Exercises hardhat-matchstick-ts/node and contract revert mocks.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  runMatchstickTest,
  EventCapture,
  viewFunctionRevertMocks,
  readsFor,
} from "matchstick-ts";
import { getOrCreateNode } from "hardhat-matchstick-ts/node";
import { deployCounter } from "../src/deploy-counter.ts";

describe("Hardhat → Matchstick → Counter", async () => {
  const node = await getOrCreateNode();
  const { conn } = node;
  let capture: EventCapture;

  before(async () => {
    capture = new EventCapture(await conn.viem.getPublicClient());
  });

  it("indexes setValue from a real transaction", async () => {
    const { counter, abi, address } = await deployCounter(conn);
    const walletClients = await conn.viem.getWalletClients();
    const wallet = walletClients[0];

    const newFee = 42n;
    const txHash = await counter.write.setValue([newFee], { account: wallet.account });
    await capture.captureFromReceipt(txHash, abi);

    // Paths default to subgraph.yaml / schema.graphql in this package (also set under
    // `matchstick` in hardhat.config.ts via matchstickRunOptionsFromConfig).
    const snap = await runMatchstickTest({
      events: capture.serialize(),
      reads: readsFor("Counter", ["0"]),
      revertMocks: viewFunctionRevertMocks(abi, address),
    });

    assert.equal(snap.get("Counter", "0", "value"), newFee.toString());
    const entity = snap.entity("Counter", "0");
    assert.ok(entity);
    assert.equal(entity.value, "42");
  });

  after(async () => {
    await node.close();
  });
});
