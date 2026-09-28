import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type Abi,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Hex,
  type Log,
} from "viem";
import {
  EventCapture,
  type ReceiptAwaitingClient,
  serializeEventArgs,
} from "../src/event-capture.ts";
import { type LogsQueryingClient, SubgraphLogSync } from "../src/log-sync.ts";

const address = getAddress("0x0000000000000000000000000000000000000abc");
const USER = getAddress("0x00000000000000000000000000000000000000a1");
const SENDER = getAddress("0x00000000000000000000000000000000000000a2");
const RECEIVER = getAddress("0x00000000000000000000000000000000000000a3");
const VENUE = getAddress("0x00000000000000000000000000000000000000a4");
const FROM = getAddress("0x00000000000000000000000000000000000000b1");
const TO = getAddress("0x00000000000000000000000000000000000000b2");
const TX = `0x${"ab".repeat(32)}` as Hex;

/**
 * `Deposited` and `BadDebt` both put a non-indexed param before an indexed one —
 * the shapes where viem's indexed-first object order diverges from ABI order.
 */
const vaultAbi = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "user", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: true, name: "sender", type: "address" },
    ],
    name: "Deposited",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "payer", type: "address" },
      { indexed: true, name: "receiver", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: true, name: "venue", type: "address" },
    ],
    name: "BadDebt",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
    name: "Transfer",
    type: "event",
  },
] as const satisfies Abi;

function depositedLog(value: bigint): Log {
  const topics = encodeEventTopics({
    abi: vaultAbi,
    eventName: "Deposited",
    args: { user: USER, sender: SENDER },
  }) as Hex[];
  const data = encodeAbiParameters([{ type: "uint256" }], [value]);
  return {
    address,
    topics,
    data,
    blockNumber: 3n,
    logIndex: 0,
    transactionHash: TX,
  } as Log;
}

describe("serializeEventArgs", () => {
  it("reorders args to ABI order when an indexed param follows a non-indexed one", () => {
    // viem inserts indexed params first: { user, sender, amount }.
    const args = { user: USER, sender: SENDER, amount: 123n };
    const params = serializeEventArgs(args, vaultAbi, "Deposited");
    assert.deepEqual(
      params.map(([name]) => name),
      ["user", "amount", "sender"],
    );
    assert.deepEqual(params[1], ["amount", "123"]);
  });

  it("reorders BadDebt's four-field shape", () => {
    const args = { payer: USER, receiver: RECEIVER, venue: VENUE, amount: 9n };
    const params = serializeEventArgs(args, vaultAbi, "BadDebt");
    assert.deepEqual(
      params.map(([name]) => name),
      ["payer", "receiver", "amount", "venue"],
    );
  });

  it("leaves events whose indexed params are already a prefix in order", () => {
    const args = { from: FROM, to: TO, value: 5n };
    const params = serializeEventArgs(args, vaultAbi, "Transfer");
    assert.deepEqual(
      params.map(([name]) => name),
      ["from", "to", "value"],
    );
  });

  it("keeps raw order when a named arg is missing", () => {
    const params = serializeEventArgs({ user: USER, sender: SENDER }, vaultAbi, "Deposited");
    assert.deepEqual(
      params.map(([name]) => name),
      ["user", "sender"],
    );
  });

  it("keeps unnamed (array) args as-is", () => {
    const anonAbi = [
      {
        anonymous: false,
        inputs: [
          { indexed: false, name: "", type: "uint256" },
          { indexed: false, name: "", type: "address" },
        ],
        name: "Ping",
        type: "event",
      },
    ] as const satisfies Abi;
    const params = serializeEventArgs([1n, USER], anonAbi, "Ping");
    assert.deepEqual(
      params.map(([name]) => name),
      ["0", "1"],
    );
  });
});

describe("EventCapture — viem arg order", () => {
  it("captures Deposited params in ABI order from a real encoded log", async () => {
    const log = depositedLog(123n);
    const client: ReceiptAwaitingClient = {
      waitForTransactionReceipt: async () => ({
        logs: [log],
        blockNumber: 3n,
        transactionHash: TX,
      }),
    };

    const capture = new EventCapture(client);
    const [event] = await capture.captureFromReceipt(TX, vaultAbi);

    assert.deepEqual(
      event.params.map(([name]) => name),
      ["user", "amount", "sender"],
    );
    assert.deepEqual(event.params[1], ["amount", "123"]);
  });
});

describe("SubgraphLogSync — viem arg order", () => {
  it("orders Deposited params when ingesting via eth_getLogs", async () => {
    const client: LogsQueryingClient = {
      getBlockNumber: async () => 3n,
      getLogs: async () => [depositedLog(77n)],
    };
    const sync = new SubgraphLogSync({ client, startBlock: 0n });
    sync.bind("Vault", address, vaultAbi);
    await sync.ingest({ toBlock: 3n });

    const events = (
      sync as unknown as { events: Array<{ params: Array<[string, unknown]> }> }
    ).events;
    assert.equal(events.length, 1);
    assert.deepEqual(
      events[0].params.map(([name]) => name),
      ["user", "amount", "sender"],
    );
    assert.deepEqual(events[0].params[1], ["amount", "77"]);
  });
});
