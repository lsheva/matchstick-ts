import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeEventTopics, encodeAbiParameters, type Abi, type Address, type Hex } from "viem";
import {
  captureViewMocksFromContract,
  EventCapture,
  type CallReturnMock,
  type CallRevertMock,
  type ReceiptAwaitingClient,
  type ViewCallingClient,
} from "../src/event-capture.ts";

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

const viewAbi = [
  {
    inputs: [],
    name: "deliveryDurationDays",
    outputs: [{ type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "collateralVault",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "paused",
    outputs: [{ type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "broken",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  // Non-zero-arg view — should be skipped entirely.
  {
    inputs: [{ type: "uint256" }],
    name: "balanceOf",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const satisfies Abi;

describe("captureViewMocksFromContract", () => {
  it("emits return mocks for successful reads and revert mocks for reverts", async () => {
    const address = "0x0000000000000000000000000000000000000abc" as Address;
    const client: ViewCallingClient = {
      readContract: async (args) => {
        if (args.functionName === "deliveryDurationDays") return 30;
        if (args.functionName === "collateralVault") {
          return "0x000000000000000000000000000000000000aaaa";
        }
        if (args.functionName === "paused") return false;
        if (args.functionName === "broken") throw new Error("execution reverted");
        throw new Error(`unexpected call: ${args.functionName}`);
      },
    };

    const mocks = await captureViewMocksFromContract(client, viewAbi, address);

    // 4 zero-arg views; `balanceOf` is skipped.
    assert.equal(mocks.length, 4);

    const byName = new Map(mocks.map((m) => [m.name, m]));

    const days = byName.get("deliveryDurationDays") as CallReturnMock;
    assert.equal(days.kind, "return");
    assert.deepEqual(days.outputs, ["uint8"]);
    assert.deepEqual(days.returns, [30]);
    assert.equal(days.signature, "deliveryDurationDays():(uint8)");

    const vault = byName.get("collateralVault") as CallReturnMock;
    assert.equal(vault.kind, "return");
    assert.deepEqual(vault.outputs, ["address"]);
    assert.deepEqual(vault.returns, ["0x000000000000000000000000000000000000aaaa"]);

    const paused = byName.get("paused") as CallReturnMock;
    assert.equal(paused.kind, "return");
    assert.deepEqual(paused.returns, [false]);

    const broken = byName.get("broken") as CallRevertMock;
    assert.equal(broken.kind, "revert");
    assert.equal(broken.signature, "broken():(uint256)");
  });

  it("stringifies bigint return values to preserve precision over the wire", async () => {
    const address = "0x0000000000000000000000000000000000000abc" as Address;
    const big = 12345678901234567890n;
    const client: ViewCallingClient = {
      readContract: async () => big,
    };
    const abi = [
      {
        inputs: [],
        name: "totalSupply",
        outputs: [{ type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
    ] as const satisfies Abi;

    const [mock] = (await captureViewMocksFromContract(client, abi, address)) as CallReturnMock[];

    assert.equal(mock.kind, "return");
    assert.deepEqual(mock.returns, [big.toString()]);
  });
});
