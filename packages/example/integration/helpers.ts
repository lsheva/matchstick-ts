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
