/**
 * Unit tests for `MockRpcClient`. No wasm involved — we exercise the
 * RPC contract directly:
 *   - exact-args match
 *   - wildcard-args match
 *   - selector-only matching (different selectors don't collide)
 *   - reverts() returns null
 *   - fallback delegation when no mock matches
 *   - `MockNotFoundError` when nothing matches and no fallback
 *   - hit counters
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
} from "viem";
import {
  MockRpcClient,
  MockNotFoundError,
} from "../src/mock-rpc.ts";
import type { RpcClient } from "../src/host.ts";

const ADDR_A: Hex = "0x1111111111111111111111111111111111111111";
const ADDR_B: Hex = "0x2222222222222222222222222222222222222222";
const HOLDER: Hex = "0x3333333333333333333333333333333333333333";
const HOLDER_OTHER: Hex = "0x4444444444444444444444444444444444444444";

const BALANCE_OF = "balanceOf(address):(uint256)";

const balanceOfAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address", name: "" }],
    outputs: [{ type: "uint256", name: "" }],
  },
] as const;

function buildCalldata(holder: Hex): Hex {
  return encodeFunctionData({
    abi: balanceOfAbi,
    functionName: "balanceOf",
    args: [holder],
  });
}

test("MockRpcClient: exact withArgs match returns the registered hex", async () => {
  const mock = new MockRpcClient();
  mock.on(ADDR_A, BALANCE_OF).withArgs([HOLDER]).returns([1234n]);

  const result = await mock.call({
    to: ADDR_A,
    data: buildCalldata(HOLDER),
  });
  const expected = encodeAbiParameters([{ type: "uint256" }], [1234n]);
  assert.equal(result, expected);
});

test("MockRpcClient: address matching is case-insensitive", async () => {
  const mock = new MockRpcClient();
  mock.on(ADDR_A.toUpperCase() as Hex, BALANCE_OF)
    .withArgs([HOLDER])
    .returns([1n]);

  const result = await mock.call({
    to: ADDR_A.toLowerCase() as Hex,
    data: buildCalldata(HOLDER),
  });
  assert.notEqual(result, null);
});

test("MockRpcClient: withArgs only matches the specific args", async () => {
  const mock = new MockRpcClient();
  mock.on(ADDR_A, BALANCE_OF).withArgs([HOLDER]).returns([100n]);
  mock.on(ADDR_A, BALANCE_OF).withArgs([HOLDER_OTHER]).returns([200n]);

  const a = await mock.call({ to: ADDR_A, data: buildCalldata(HOLDER) });
  const b = await mock.call({ to: ADDR_A, data: buildCalldata(HOLDER_OTHER) });
  assert.equal(
    a,
    encodeAbiParameters([{ type: "uint256" }], [100n]),
  );
  assert.equal(
    b,
    encodeAbiParameters([{ type: "uint256" }], [200n]),
  );
});

test("MockRpcClient: withAnyArgs matches any args for that selector", async () => {
  const mock = new MockRpcClient();
  mock.on(ADDR_A, BALANCE_OF).withAnyArgs().returns([42n]);

  const a = await mock.call({ to: ADDR_A, data: buildCalldata(HOLDER) });
  const b = await mock.call({ to: ADDR_A, data: buildCalldata(HOLDER_OTHER) });
  const expected = encodeAbiParameters([{ type: "uint256" }], [42n]);
  assert.equal(a, expected);
  assert.equal(b, expected);
});

test("MockRpcClient: exact match wins over withAnyArgs", async () => {
  const mock = new MockRpcClient();
  mock.on(ADDR_A, BALANCE_OF).withAnyArgs().returns([0n]);
  mock.on(ADDR_A, BALANCE_OF).withArgs([HOLDER]).returns([999n]);

  const exact = await mock.call({ to: ADDR_A, data: buildCalldata(HOLDER) });
  const fallback = await mock.call({
    to: ADDR_A,
    data: buildCalldata(HOLDER_OTHER),
  });
  assert.equal(exact, encodeAbiParameters([{ type: "uint256" }], [999n]));
  assert.equal(fallback, encodeAbiParameters([{ type: "uint256" }], [0n]));
});

test("MockRpcClient: reverts() returns null", async () => {
  const mock = new MockRpcClient();
  mock.on(ADDR_A, BALANCE_OF).withAnyArgs().reverts();
  const result = await mock.call({ to: ADDR_A, data: buildCalldata(HOLDER) });
  assert.equal(result, null);
});

test("MockRpcClient: different addresses don't collide", async () => {
  const mock = new MockRpcClient();
  mock.on(ADDR_A, BALANCE_OF).withAnyArgs().returns([1n]);
  mock.on(ADDR_B, BALANCE_OF).withAnyArgs().returns([2n]);

  const a = await mock.call({ to: ADDR_A, data: buildCalldata(HOLDER) });
  const b = await mock.call({ to: ADDR_B, data: buildCalldata(HOLDER) });
  assert.equal(a, encodeAbiParameters([{ type: "uint256" }], [1n]));
  assert.equal(b, encodeAbiParameters([{ type: "uint256" }], [2n]));
});

test("MockRpcClient: fallback delegation when no mock matches", async () => {
  const fallback: RpcClient = {
    async call() {
      return ("0x" + "ab".repeat(32)) as Hex;
    },
  };
  const mock = new MockRpcClient({ fallback });
  const result = await mock.call({ to: ADDR_A, data: buildCalldata(HOLDER) });
  assert.equal(result, "0x" + "ab".repeat(32));
});

test("MockRpcClient: throws MockNotFoundError when no match and no fallback", async () => {
  const mock = new MockRpcClient();
  await assert.rejects(
    () => mock.call({ to: ADDR_A, data: buildCalldata(HOLDER) }),
    (err: unknown) => err instanceof MockNotFoundError,
  );
});

test("MockRpcClient: hit counter increments per match", async () => {
  const mock = new MockRpcClient();
  mock.on(ADDR_A, BALANCE_OF).withAnyArgs().returns([0n]);
  await mock.call({ to: ADDR_A, data: buildCalldata(HOLDER) });
  await mock.call({ to: ADDR_A, data: buildCalldata(HOLDER_OTHER) });
  await mock.call({ to: ADDR_A, data: buildCalldata(HOLDER) });
  assert.equal(mock.hitCount(ADDR_A, BALANCE_OF), 3);
});

test("MockRpcClient: clear() drops all entries", async () => {
  const mock = new MockRpcClient();
  mock.on(ADDR_A, BALANCE_OF).withAnyArgs().returns([1n]);
  mock.clear();
  await assert.rejects(
    () => mock.call({ to: ADDR_A, data: buildCalldata(HOLDER) }),
    MockNotFoundError,
  );
});
