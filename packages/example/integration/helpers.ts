import {
  viewFunctionRevertMocks,
  type CallMock,
  type CapturedEvent,
} from "matchstick-ts";
import type { Abi, Hex } from "viem";

/** Placeholder address from `subgraph.yaml` — matchstick sets dataSource from the first event. */
export const COUNTER_ADDRESS = "0x0000000000000000000000000000000000000001" as const;

const counterAbi = [
  {
    inputs: [],
    name: "multiplier",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const satisfies Abi;

/**
 * Revert mocks for every 0-arg view function on Counter. The handler reads
 * `multiplier()` via `try_*` — matchstick refuses to run a handler that calls
 * an un-mocked function, so synthetic tests (without a `bind()` / chain) must
 * supply these manually. Pass to `runMatchstickTest({ callMocks: ... })`.
 *
 * To observe real values instead, use the Hardhat path
 * (`conn.matchstick.captureViewMocks()`) — see `hardhat-e2e.test.ts`.
 */
export const counterCallMocks: CallMock[] = viewFunctionRevertMocks(counterAbi, COUNTER_ADDRESS);

const TX_HASH = `0x${"ab".repeat(32)}` as Hex;

/** Build a serialized `ValueSet` event for `runMatchstickTest` without a live chain. */
export function valueSetCaptured(newValue: bigint, blockNumber = 1): CapturedEvent {
  return {
    event: "ValueSet",
    address: COUNTER_ADDRESS,
    blockNumber,
    transactionHash: TX_HASH,
    params: [["newValue", newValue.toString()]],
  };
}

/**
 * Build a serialized `SignedValueSet` event (int256 parameter).
 * Negative values serialize as e.g. "-99" which exercises the signed-integer
 * branch of `jsonValueToEthereumValue` in the matchstick-ts assembly runtime.
 */
export function signedValueSetCaptured(newValue: bigint, blockNumber = 1): CapturedEvent {
  return {
    event: "SignedValueSet",
    address: COUNTER_ADDRESS,
    blockNumber,
    transactionHash: TX_HASH,
    params: [["newValue", newValue.toString()]],
  };
}
