import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Abi, Address, Hex, Log } from "viem";
import { SubgraphLogSync, type LogsQueryingClient } from "../src/log-sync.ts";

const counterAbi = [
  {
    anonymous: false,
    inputs: [{ indexed: false, internalType: "uint256", name: "newValue", type: "uint256" }],
    name: "ValueSet",
    type: "event",
  },
] as const satisfies Abi;

const address = "0x0000000000000000000000000000000000000001" as Address;

describe("SubgraphLogSync", () => {
  it("accumulates logs across incremental ingest ranges", async () => {
    const logsByRange = new Map<string, Log[]>();

    let head = 1n;
    const client: LogsQueryingClient = {
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock, toBlock }) => {
        const key = `${fromBlock}:${toBlock}`;
        return logsByRange.get(key) ?? [];
      },
    };

    const sync = new SubgraphLogSync({ client, startBlock: 0n });
    sync.bind("Counter", address, counterAbi);

    head = 1n;
    await sync.ingest({ toBlock: 1n });
    assert.equal(sync.eventCount, 0);

    head = 2n;
    const second = await sync.ingest({ toBlock: 2n });
    assert.equal(second.fromBlock, 2n);
  });

  it("anchor clears events and sets the cursor", async () => {
    let head = 5n;
    const client: LogsQueryingClient = {
      getBlockNumber: async () => head,
      getLogs: async () => [],
    };

    const sync = new SubgraphLogSync({ client });
    sync.bind("Counter", address, counterAbi);
    const anchored = await sync.anchor();
    assert.equal(anchored, 5n);
    assert.equal(sync.lastSyncedBlock, 5n);
    assert.equal(sync.eventCount, 0);
  });
});
