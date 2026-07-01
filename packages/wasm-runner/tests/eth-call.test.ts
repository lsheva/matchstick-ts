/**
 * Phase-2 test for the `ethereum.call` -> RpcClient async path.
 *
 * What this exercises end-to-end:
 *   1. The asyncify transform applied at `WasmRunner.compile` time
 *      injected unwind/rewind hooks into the wasm.
 *   2. `host.rpcClient` is wired to a fake `{ async call() }` so the
 *      sync wasm-side `ethereum.call` import suspends on it via
 *      `asyncify.wrapAsyncImport`.
 *   3. The host shim correctly:
 *        - decodes `SmartContractCall` from wasm memory,
 *        - parses graph-cli's compact signature into viem inputs+outputs,
 *        - encodes calldata (selector + ABI-encoded args),
 *        - awaits the fake RPC,
 *        - decodes the canned hex back into JS values,
 *        - allocates an `Array<ethereum.Value>` in wasm with the
 *          appropriate Value tags,
 *        - rewinds asyncify with that pointer.
 *   4. The wasm-side `result![0].toBigInt()` produces the expected
 *      bigint.
 *
 * The test uses the `smokeEthCallReadUint` export from `scaffold.ts`,
 * so the example-bundle.wasm produced by `pnpm build:example-bundle`
 * is sufficient — no codegen + no third-party indexer needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  type Address as ViemAddress,
} from "viem";
import { WasmRunner } from "../src/runner.ts";
import type { RpcClient } from "../src/host.ts";

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE_WASM = resolve(here, "../build/example-bundle.wasm");

interface SmokeExports {
  smokeEthCallReadUint(
    addressPtr: number,
    signaturePtr: number,
    argAddrPtr: number,
  ): number;
}

const CONTRACT = "0x1111111111111111111111111111111111111111" as ViemAddress;
const HOLDER = "0x2222222222222222222222222222222222222222" as ViemAddress;
const SIGNATURE = "balanceOf(address):(uint256)";
const RETURN_VALUE = 1234567890123456789n;

test("ethereum.call uses RpcClient via asyncify and decodes into BigInt", async (t) => {
  if (!existsSync(BUNDLE_WASM)) {
    t.skip(
      `example-bundle.wasm missing at ${BUNDLE_WASM} — run \`pnpm build:example-bundle\``,
    );
    return;
  }

  const runner = await WasmRunner.compile(BUNDLE_WASM);
  const subgraph = await runner.instantiate();

  // viem-canned response: ABI-encoded uint256 = RETURN_VALUE.
  const cannedReturn = encodeAbiParameters(
    [{ type: "uint256" }],
    [RETURN_VALUE],
  );

  const calls: { to: Hex; data: Hex }[] = [];
  const fakeRpc: RpcClient = {
    async call({ to, data }) {
      calls.push({ to, data });
      return cannedReturn;
    },
  };
  subgraph.host.rpcClient = fakeRpc;

  // Allocate the address + signature + arg-address strings/bytes inside
  // wasm — the smoke export expects ptrs in its own linear memory.
  const exports = subgraph.exports as unknown as SmokeExports & {
    __newString(s: string): number;
    __newArray(typeId: number, values: number[]): number;
    TypeId: { Uint8Array: WebAssembly.Global };
    id_of_type(graphNodeId: number): number;
  };
  const uint8Cid = exports.id_of_type(
    exports.TypeId.Uint8Array.value as number,
  );
  const hexToBytes = (hex: string): Uint8Array => {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  };
  const contractPtr = exports.__newArray(
    uint8Cid,
    Array.from(hexToBytes(CONTRACT)),
  );
  const argPtr = exports.__newArray(uint8Cid, Array.from(hexToBytes(HOLDER)));
  const sigPtr = exports.__newString(SIGNATURE);

  // The wasm export must run inside `subgraph.run(...)` so asyncify's
  // unwind/rewind dance has a JS-side host to drive.
  const resultPtr = await subgraph.run(() =>
    (subgraph.exports as unknown as SmokeExports).smokeEthCallReadUint(
      contractPtr,
      sigPtr,
      argPtr,
    ),
  );

  await t.test("RPC was invoked exactly once with correct calldata", () => {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].to.toLowerCase(), CONTRACT.toLowerCase());
    // Selector + abi-encoded address arg via viem (canonical reference).
    const expectedCalldata = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ type: "address", name: "" }],
          outputs: [{ type: "uint256", name: "" }],
        },
      ],
      functionName: "balanceOf",
      args: [HOLDER],
    });
    assert.equal(calls[0].data.toLowerCase(), expectedCalldata.toLowerCase());
  });

  await t.test("host captured the ethereum.call with the canned response", () => {
    const captured = subgraph.host.captured.ethCalls;
    assert.equal(captured.length, 1);
    assert.equal(captured[0].functionSignature, SIGNATURE);
    assert.equal(captured[0].contractAddress.toLowerCase(), CONTRACT.toLowerCase());
    assert.equal(
      captured[0].resultHex?.toLowerCase(),
      cannedReturn.toLowerCase(),
    );
  });

  await t.test("wasm received the decoded uint256 as a BigInt", () => {
    // The returned ptr is a graph-ts `BigInt` (= signed-LE Uint8Array).
    const u8 = subgraph.exports.__getUint8Array(resultPtr);
    let n = 0n;
    for (let i = u8.length - 1; i >= 0; i--) {
      n = (n << 8n) | BigInt(u8[i]);
    }
    // graph-ts encodes uint as signed-twos-complement, so values with
    // the high bit clear (which RETURN_VALUE is) reconstruct directly.
    assert.equal(n, RETURN_VALUE);
  });

  await t.test(
    "without a configured RpcClient, ethereum.call short-circuits to revert",
    async () => {
      const runner2 = await WasmRunner.compile(BUNDLE_WASM);
      const sg2 = await runner2.instantiate();
      // No rpcClient wired — default null.
      const e2 = sg2.exports as unknown as SmokeExports & {
        __newString(s: string): number;
        __newArray(typeId: number, values: number[]): number;
        TypeId: { Uint8Array: WebAssembly.Global };
        id_of_type(graphNodeId: number): number;
      };
      const cid = e2.id_of_type(e2.TypeId.Uint8Array.value as number);
      const cPtr = e2.__newArray(cid, Array.from(hexToBytes(CONTRACT)));
      const aPtr = e2.__newArray(cid, Array.from(hexToBytes(HOLDER)));
      const sPtr = e2.__newString(SIGNATURE);
      const ptr = await sg2.run(() =>
        e2.smokeEthCallReadUint(cPtr, sPtr, aPtr),
      );
      // Reverted -> wasm returns BigInt.fromI32(0). graph-ts encodes 0
      // as a single zero byte.
      const u8 = sg2.exports.__getUint8Array(ptr);
      let n = 0n;
      for (let i = u8.length - 1; i >= 0; i--) {
        n = (n << 8n) | BigInt(u8[i]);
      }
      assert.equal(n, 0n);
      assert.equal(sg2.host.captured.ethCalls.length, 0);
    },
  );
});
