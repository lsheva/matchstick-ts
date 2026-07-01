/**
 * viem `PublicClient` -> `RpcClient` adapter.
 *
 * Wraps a viem `PublicClient` so the wasm-runner host can dispatch
 * `ethereum.call` to a real RPC (mainnet / fork / Anvil / Hardhat /
 * test node). Lets users replay historical events end-to-end without
 * writing per-test mocks for every contract read.
 *
 * Recommended usage:
 *
 *   const client = createPublicClient({
 *     chain: mainnet,
 *     transport: http(rpcUrl),
 *   });
 *   subgraph.host.rpcClient = makeViemRpc(client);
 *   subgraph.host.blockNumber = eventLog.blockNumber;
 *   await subgraph.run(() => handlers.handleX(eventPtr));
 *
 * Pinning `host.blockNumber` is important for replays of historical
 * events — it makes contract reads deterministic by routing through
 * the archive node's `eth_call` at that exact block.
 *
 * Revert vs network failure semantics — see `RpcClient` in `host.ts`:
 *   - real on-chain revert -> resolve `null` (graph-ts sees
 *     `CallResult.reverted = true` from `try_*` wrappers)
 *   - network / RPC infrastructure failure -> reject with the
 *     original viem error so the user sees a real stack trace
 *     instead of a silent revert
 */
import {
  BaseError,
  ExecutionRevertedError,
  RawContractError,
  type Hex,
} from "viem";
import type { RpcClient } from "./host.ts";
import type { BlockSummary, LogSource, RawLog } from "./log-source.ts";

/**
 * Minimal slice of viem's `PublicClient` we depend on. Typed as a
 * structural subset so callers can pass any of viem's client variants
 * (PublicClient, WalletClient with public actions, TestClient, ...)
 * — we only call `client.call(...)`, nothing else.
 */
export interface ViemCallClient {
  call(args: {
    to: Hex;
    data: Hex;
    blockNumber?: bigint;
  }): Promise<{ data?: Hex }>;
}

/**
 * Wrap a viem-style call-capable client into the runner's `RpcClient`.
 *
 * On revert (any error in the chain that's a viem
 * `RawContractError` / `ExecutionRevertedError` / has a code that
 * JSON-RPC uses for execution reverts), resolves `null` so graph-ts
 * sees `try_*` reverted. Anything else re-throws so e.g. a 503 from
 * the RPC provider doesn't get silently swallowed.
 */
export function makeViemRpc(client: ViemCallClient): RpcClient {
  return {
    async call({ to, data, blockNumber }) {
      try {
        const result = await client.call(
          blockNumber === undefined
            ? { to, data }
            : { to, data, blockNumber },
        );
        // viem returns `{ data: undefined }` for calls that succeed
        // but produced no return data (e.g. void-returning state
        // changes via eth_call). Mirror that as `"0x"` so ABI decode
        // for an empty output list still works.
        return result.data ?? ("0x" as Hex);
      } catch (err) {
        if (isRevert(err)) return null;
        throw err;
      }
    },
  };
}

/**
 * Detect whether a viem error represents an on-chain revert (vs a
 * network / RPC infrastructure failure).
 *
 * Implementation walks the error cause chain via
 * `BaseError#walk(fn)`. Hits we treat as revert:
 *   - `RawContractError`               (code 3 / "execution reverted: 0x...")
 *   - `ExecutionRevertedError`         (JSON-RPC -32003 family)
 *   - any error whose `name` is one of the above (covers cross-realm
 *     viem instances where `instanceof` would fail because of dual
 *     module copies in the dependency tree).
 */
/**
 * Combined chain client surface that `Subgraph.create({ client })`
 * consumes. A viem `PublicClient` satisfies this structurally with
 * no wrapper, so the common case is just `client: publicClient`.
 *
 * If you need split transports (archive node for logs, light node
 * for `eth_call`, a custom failover wrapper, etc.) build your own
 * object that satisfies this interface — that's how the runner
 * stays out of the policy business.
 */
export type ChainClient = ViemCallClient & ViemLogClient;

/**
 * Minimal slice of viem's `PublicClient` we use for log fetching.
 * `getBlockNumber()` / `getLogs(...)` / `getBlock(...)` cover what
 * `Subgraph.start()` needs.
 */
export interface ViemLogClient {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    address?: Hex | Hex[];
    topics?: (Hex[] | Hex | null)[];
    fromBlock?: bigint;
    toBlock?: bigint;
  }): Promise<
    Array<{
      address: Hex;
      topics: Hex[];
      data: Hex;
      blockNumber: bigint | null;
      blockHash: Hex | null;
      transactionHash: Hex | null;
      logIndex: number | null;
    }>
  >;
  getBlock(args: {
    blockNumber: bigint;
  }): Promise<{ number: bigint | null; hash: Hex | null; timestamp: bigint }>;
}

/**
 * Wrap a viem-style log-fetching client into the runner's
 * `LogSource`. Same client object that `makeViemRpc(...)` consumes
 * usually works here, since `PublicClient` exposes both call + log
 * actions.
 */
export function makeViemLogSource(client: ViemLogClient): LogSource {
  return {
    async getBlockNumber() {
      return client.getBlockNumber();
    },
    async getLogs({ addresses, topics, fromBlock, toBlock }) {
      const raw = await client.getLogs({
        address: addresses.length === 1 ? addresses[0] : addresses,
        topics,
        fromBlock,
        toBlock,
      });
      const out: RawLog[] = [];
      for (const r of raw) {
        // viem returns `null` for these on pending logs. Subgraph
        // replay only cares about mined logs — drop anything where
        // these are missing rather than silently corrupting state.
        if (
          r.blockNumber === null ||
          r.blockHash === null ||
          r.transactionHash === null ||
          r.logIndex === null
        ) {
          continue;
        }
        out.push({
          address: r.address,
          topics: r.topics,
          data: r.data,
          blockNumber: r.blockNumber,
          blockHash: r.blockHash,
          transactionHash: r.transactionHash,
          logIndex: BigInt(r.logIndex),
        });
      }
      // viem returns logs in (blockNumber, logIndex) order already
      // for an archive-backed RPC, but we re-sort defensively in case
      // the provider returns out-of-order across batches.
      out.sort(compareLog);
      return out;
    },
    async getBlock(number) {
      const blk = await client.getBlock({ blockNumber: number });
      const out: BlockSummary = {
        number: blk.number ?? number,
        hash: blk.hash ?? (`0x${"00".repeat(32)}` as Hex),
        timestamp: blk.timestamp,
      };
      return out;
    },
  };
}

function compareLog(a: RawLog, b: RawLog): number {
  if (a.blockNumber !== b.blockNumber) {
    return a.blockNumber < b.blockNumber ? -1 : 1;
  }
  if (a.logIndex !== b.logIndex) {
    return a.logIndex < b.logIndex ? -1 : 1;
  }
  return 0;
}

function isRevert(err: unknown): boolean {
  if (!(err instanceof BaseError)) {
    // Some viem versions throw plain Error subclasses for low-level
    // transports — fall back to a name check.
    if (err instanceof Error && /reverted/i.test(err.message)) return true;
    return false;
  }
  const hit = err.walk((cause) => {
    if (cause instanceof RawContractError) return true;
    if (cause instanceof ExecutionRevertedError) return true;
    if (cause instanceof Error) {
      const name = cause.name;
      if (
        name === "RawContractError" ||
        name === "ExecutionRevertedError" ||
        name === "ContractFunctionRevertedError"
      ) {
        return true;
      }
    }
    return false;
  });
  return hit !== null;
}
