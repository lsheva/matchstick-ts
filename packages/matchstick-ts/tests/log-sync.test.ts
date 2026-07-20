import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Abi,
  type Address,
  type Hex,
  type Log,
} from "viem";
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

  it("attaches blockTimestamp from getBlock during ingest", async () => {
    const topics = encodeEventTopics({
      abi: counterAbi,
      eventName: "ValueSet",
    }) as Hex[];
    const data = encodeAbiParameters([{ type: "uint256" }], [7n]);
    const log = {
      address,
      topics,
      data,
      blockNumber: 9n,
      logIndex: 0,
      transactionHash: `0x${"ab".repeat(32)}` as Hex,
    } as Log;

    const client: LogsQueryingClient = {
      getBlockNumber: async () => 9n,
      getLogs: async () => [log],
      getBlock: async ({ blockNumber }) => {
        assert.equal(blockNumber, 9n);
        return { timestamp: 1_700_000_456n };
      },
    };

    const sync = new SubgraphLogSync({ client, startBlock: 0n });
    sync.bind("Counter", address, counterAbi);
    await sync.ingest({ toBlock: 9n });

    const events = (
      sync as unknown as { events: Array<{ blockTimestamp?: number }> }
    ).events;
    assert.equal(events.length, 1);
    assert.equal(events[0].blockTimestamp, 1_700_000_456);
  });

  it("reset() deletes the generated runner and jsonDir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ss-reset-"));
    const runnerPath = join(dir, "runner.test.ts");
    const jsonDir = join(dir, ".tmp");
    await mkdir(jsonDir, { recursive: true });
    await writeFile(runnerPath, "// generated\n");
    await writeFile(join(jsonDir, "events.json"), "[]");

    const client: LogsQueryingClient = {
      getBlockNumber: async () => 0n,
      getLogs: async () => [],
    };

    const sync = new SubgraphLogSync({
      client,
      runDefaults: { runnerPath, jsonDir },
    });
    await sync.reset();

    await assert.rejects(() => access(runnerPath), /ENOENT/);
    await assert.rejects(() => access(jsonDir), /ENOENT/);
  });
});
