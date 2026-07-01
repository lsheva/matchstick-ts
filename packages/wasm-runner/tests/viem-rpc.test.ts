/**
 * Unit tests for `makeViemRpc(client)`.
 *
 * No real network — we pass a hand-rolled `ViemCallClient` (just the
 * `.call(args)` slice we depend on). Each test asserts on:
 *   - what we passed to the client (block-number pinning,
 *     pass-through args),
 *   - how we translate viem's response / error into the
 *     runner's `RpcClient` contract (`Hex | null` resolve vs reject).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ExecutionRevertedError,
  HttpRequestError,
  RawContractError,
  type Hex,
} from "viem";
import { makeViemRpc, type ViemCallClient } from "../src/viem-rpc.ts";

const TO: Hex = "0x1111111111111111111111111111111111111111";
const DATA: Hex = "0xdeadbeef";

test("makeViemRpc passes args through and resolves to viem's data", async () => {
  const seen: Array<{ to: Hex; data: Hex; blockNumber?: bigint }> = [];
  const client: ViemCallClient = {
    async call(args) {
      seen.push(args);
      return { data: "0x1234" as Hex };
    },
  };
  const rpc = makeViemRpc(client);
  const result = await rpc.call({ to: TO, data: DATA });
  assert.equal(result, "0x1234");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].to, TO);
  assert.equal(seen[0].data, DATA);
  assert.equal(seen[0].blockNumber, undefined);
});

test("makeViemRpc forwards blockNumber when set", async () => {
  let observed: bigint | undefined;
  const client: ViemCallClient = {
    async call(args) {
      observed = args.blockNumber;
      return { data: "0x" as Hex };
    },
  };
  const rpc = makeViemRpc(client);
  await rpc.call({ to: TO, data: DATA, blockNumber: 18_000_000n });
  assert.equal(observed, 18_000_000n);
});

test("makeViemRpc maps undefined data -> '0x'", async () => {
  const client: ViemCallClient = {
    async call() {
      return {};
    },
  };
  const rpc = makeViemRpc(client);
  const result = await rpc.call({ to: TO, data: DATA });
  assert.equal(result, "0x");
});

test("makeViemRpc resolves null on RawContractError revert", async () => {
  const client: ViemCallClient = {
    async call() {
      throw new RawContractError({ message: "execution reverted" });
    },
  };
  const rpc = makeViemRpc(client);
  const result = await rpc.call({ to: TO, data: DATA });
  assert.equal(result, null);
});

test("makeViemRpc resolves null on ExecutionRevertedError", async () => {
  const client: ViemCallClient = {
    async call() {
      throw new ExecutionRevertedError({ message: "reverted: foo" });
    },
  };
  const rpc = makeViemRpc(client);
  const result = await rpc.call({ to: TO, data: DATA });
  assert.equal(result, null);
});

test("makeViemRpc rejects on network / non-revert errors", async () => {
  const client: ViemCallClient = {
    async call() {
      throw new HttpRequestError({
        body: {},
        details: "Service Unavailable",
        url: "http://example",
        status: 503,
      });
    },
  };
  const rpc = makeViemRpc(client);
  await assert.rejects(
    () => rpc.call({ to: TO, data: DATA }),
    (err: unknown) => err instanceof HttpRequestError,
  );
});

test("makeViemRpc treats a plain `reverted` Error message as revert", async () => {
  const client: ViemCallClient = {
    async call() {
      throw new Error("execution reverted at 0x...");
    },
  };
  const rpc = makeViemRpc(client);
  const result = await rpc.call({ to: TO, data: DATA });
  assert.equal(result, null);
});
