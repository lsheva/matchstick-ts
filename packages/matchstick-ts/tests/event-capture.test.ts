import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeEventTopics, encodeAbiParameters, type Abi, type Address, type Hex } from "viem";
import { EventCapture, type ReceiptAwaitingClient } from "../src/event-capture.ts";

const counterAbi = [
  {
    anonymous: false,
    inputs: [{ indexed: false, internalType: "uint256", name: "newValue", type: "uint256" }],
    name: "ValueSet",
    type: "event",
  },
] as const satisfies Abi;

const contractAddress = "0x0000000000000000000000000000000000000abc" as Address;

function makeLog(value: bigint, logIndex: number | null): {
  address: Address;
  topics: Hex[];
  data: Hex;
  logIndex: number | null;
  blockNumber: bigint;
  transactionHash: Hex;
} {
  const topics = encodeEventTopics({
    abi: counterAbi,
    eventName: "ValueSet",
  }) as Hex[];
  const data = encodeAbiParameters([{ type: "uint256" }], [value]);
  return {
    address: contractAddress,
    topics,
    data,
    logIndex,
    blockNumber: 42n,
    transactionHash: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex,
  };
}

describe("EventCapture.captureFromReceipt", () => {
  it("propagates per-log logIndex into the captured event", async () => {
    const client: ReceiptAwaitingClient = {
      waitForTransactionReceipt: async () => ({
        logs: [makeLog(1n, 3), makeLog(2n, 7)],
        blockNumber: 42n,
        transactionHash:
          "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex,
      }),
    };

    const capture = new EventCapture(client);
    const captured = await capture.captureFromReceipt(
      "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex,
      counterAbi,
    );

    assert.equal(captured.length, 2);
    assert.equal(captured[0].logIndex, 3);
    assert.equal(captured[1].logIndex, 7);
    assert.equal(captured[0].blockNumber, 42);
    assert.equal(
      captured[0].transactionHash,
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    );
  });

  it("defaults logIndex to 0 when the underlying log omits it", async () => {
    const client: ReceiptAwaitingClient = {
      waitForTransactionReceipt: async () => ({
        logs: [makeLog(1n, null)],
        blockNumber: 1n,
        transactionHash:
          "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex,
      }),
    };

    const capture = new EventCapture(client);
    const captured = await capture.captureFromReceipt(
      "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex,
      counterAbi,
    );

    assert.equal(captured.length, 1);
    assert.equal(captured[0].logIndex, 0);
  });
});
