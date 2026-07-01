/**
 * `LogSource` — read side of the chain, used by `Subgraph.start()`
 * to drive the log-fetch / dispatch loop. Kept separate from
 * `RpcClient` (which is the `eth_call` side) because:
 *
 *   - Tests often want a synthetic LogSource (canned events) but a
 *     real or mocked RpcClient (canned contract reads), or vice-versa.
 *   - Some providers expose archive logs only; some expose only call.
 *     Modeling them apart avoids forcing a single RpcClient impl to
 *     do both.
 *
 * Shape is intentionally tiny — `getBlockNumber`, `getLogs`,
 * `getBlock(number)` — so a hand-rolled implementation in a test is
 * a few lines (see `tests/subgraph-start.test.ts`). The viem
 * `PublicClient` adapter `makeViemLogSource` covers the production
 * path without ceremony.
 */
import type { Hex } from "viem";

/**
 * Single decoded log as returned by `getLogs`. Mirrors viem's `Log`
 * shape narrowed to what the dispatcher actually reads — explicitly
 * NOT a passthrough so a hand-rolled test LogSource doesn't need to
 * fill in fields like `removed` / `transactionIndex`.
 */
export interface RawLog {
  address: Hex;
  /** [eventTopicHash, ...indexedTopics]; first element routes to the handler. */
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: bigint;
}

/** Coarse block metadata fetched lazily per dispatched-block. */
export interface BlockSummary {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

export interface LogSource {
  /** Latest mined block number. Used to drive backfill termination + tail. */
  getBlockNumber(): Promise<bigint>;
  /**
   * Fetch logs for the given address+topic filter in `[fromBlock, toBlock]`
   * inclusive. Implementations should sort the result ascending by
   * (blockNumber, logIndex) — the dispatcher relies on that order
   * to match graph-node replay semantics.
   */
  getLogs(args: {
    addresses: Hex[];
    /**
     * `topics[0]` is an OR-set of event signature hashes. Indexed
     * topic filters past `topics[0]` aren't used today (we always
     * filter by event signature only and decode all matched logs
     * by topic[0] -> AbiEvent lookup).
     */
    topics?: (Hex[] | Hex | null)[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<RawLog[]>;
  /**
   * Block timestamp + hash for the given number. Called once per
   * unique block in a batch; the dispatcher caches the result for
   * the duration of one batch so a 1k-block range with 50 events
   * across 20 blocks does 20 `getBlock` calls, not 50.
   */
  getBlock(number: bigint): Promise<BlockSummary>;
}
