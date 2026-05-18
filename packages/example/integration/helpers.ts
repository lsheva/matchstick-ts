import type { CapturedEvent } from "matchstick-ts";
import type { Hex } from "viem";

/** Placeholder address from `subgraph.yaml` — matchstick sets dataSource from the first event. */
export const COUNTER_ADDRESS = "0x0000000000000000000000000000000000000001" as const;

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
