/**
 * Capture and serialize EVM events from transaction receipts into a
 * Matchstick-friendly JSON shape (`CapturedEvent[]`).
 *
 * Framework-agnostic — takes a viem `PublicClient`, works with Hardhat,
 * anvil, or any other RPC.
 */
import { parseEventLogs, type Abi, type AbiParameter, type Address, type Hex } from "viem";

/**
 * Structural alias for the bit of viem's `PublicClient` we actually use.
 *
 * Why not `PublicClient` directly: viem's full PublicClient type is invariant
 * in the `Chain` generic (its methods accept `CallParameters<Chain>`), which
 * means a parameter typed `PublicClient<Transport, Chain | undefined>` does
 * NOT accept a concrete `PublicClient<Transport, BaseChain>` returned by
 * `hardhat-viem`, and vice versa. Structural typing on just
 * `waitForTransactionReceipt` sidesteps this — every viem client implements
 * it the same way.
 */
export interface ReceiptAwaitingClient {
  waitForTransactionReceipt(args: { hash: Hex }): Promise<{
    // Typed as `any[]` so we can forward straight to `parseEventLogs`, which
    // accepts both `Log` and `RpcLog` shapes (and viem's Receipt type narrows
    // based on chain — pinning a shape here would re-introduce the variance
    // problem we're avoiding).
    // biome-ignore lint/suspicious/noExplicitAny: see comment
    logs: any[];
    blockNumber: bigint;
    transactionHash: Hex;
  }>;
}

/**
 * One event parameter, captured in ABI declaration order.
 *
 * - `name` is the ABI input name (purely for inspection — the AS runner accesses
 *   `event.parameters[i]` positionally).
 * - `value` is the native JSON representation: `bigint` and large numbers are
 *   stringified (JSON has no bigint), booleans stay booleans, hex strings stay
 *   strings, tuples/arrays/structs are JSON-stringified. The AS side recovers
 *   the Ethereum kind heuristically (see `jsonValueToEthereumValue`).
 */
export type ParamEntry = [name: string, value: string | number | boolean];

export interface CapturedEvent {
  event: string;
  address: Address;
  blockNumber: number;
  /**
   * Position of the log within its block. Mirrors `receipt.logs[i].logIndex` /
   * `eth_getLogs` `logIndex`. Forwarded into `event.logIndex` on the mock
   * event so handlers that compose IDs from `(blockNumber, logIndex)` see
   * realistic per-event values instead of the matchstick-as default.
   *
   * Optional for backward-compat with hand-rolled synthetic events; when
   * absent the AS runner defaults to 0.
   */
  logIndex?: number;
  transactionHash: Hex;
  /**
   * Parameters in ABI declaration order — `graph-ts`'s `JSONValue.toObject()`
   * does NOT preserve insertion order, so an ordered array is the only way to
   * line up with positional `event.parameters[i]` accessors in generated
   * AssemblyScript event classes.
   */
  params: ParamEntry[];
}

/**
 * A registered mock for a single contract view call. The AS runner installs
 * one matchstick `createMockedFunction(...).reverts()` or `.returns([...])`
 * per entry before processing events. Discriminated by `kind`; when the
 * field is missing (legacy callers), the runner treats the entry as a
 * revert mock.
 */
export type CallMock = CallRevertMock | CallReturnMock;

export interface CallRevertMock {
  kind?: "revert";
  /** Contract address to register the mock at. */
  address: Address;
  /** Function name (e.g., "collateralVault"). */
  name: string;
  /** Canonical signature (e.g., "collateralVault():(address)"). */
  signature: string;
}

/**
 * Captured view-call return value(s). The AS runner reconstructs the
 * `ethereum.Value[]` from `outputs` (solidity types) + `returns` (raw values)
 * so handler `try_*` calls observe a real on-chain value instead of revert.
 */
export interface CallReturnMock {
  kind: "return";
  address: Address;
  name: string;
  signature: string;
  /** Solidity type strings, aligned 1:1 with `returns`. e.g. `["uint256"]`, `["address","uint256"]`. */
  outputs: string[];
  /** Native JSON values aligned with `outputs` — bigints stringified, addresses lower-cased hex. */
  returns: (string | number | boolean)[];
}

/**
 * @deprecated Use {@link CallRevertMock}. Kept as an alias for backward compat.
 */
export type RevertMock = CallRevertMock;

/**
 * Derive a list of revert-mocks for every 0-arg view/pure function on the ABI.
 *
 * Use this to satisfy Matchstick when handlers do best-effort `try_*` reads on
 * the bound contract: every registered mock simply reverts so `try_*` returns
 * `reverted = true` and the handler skips the field gracefully.
 *
 * Prefer {@link captureViewMocksFromContract} when a live client is available
 * — it captures the real on-chain return value so handlers see realistic data
 * instead of always seeing the `reverted = true` branch.
 */
export function viewFunctionRevertMocks(abi: Abi, address: Address): CallRevertMock[] {
  const mocks: CallRevertMock[] = [];
  for (const item of abi) {
    if (item.type !== "function") continue;
    if (item.stateMutability !== "view" && item.stateMutability !== "pure") continue;
    if (item.inputs.length !== 0) continue;

    const inputs = "";
    const outputs = item.outputs.map((o) => o.type).join(",");
    mocks.push({
      kind: "revert",
      address,
      name: item.name,
      signature: `${item.name}(${inputs}):(${outputs})`,
    });
  }
  return mocks;
}

/**
 * Structural alias for the bit of viem's `PublicClient` we use to probe
 * 0-arg view functions. viem's full `PublicClient.readContract` is invariant
 * over `Chain`, so we type only the slice we need.
 */
export interface ViewCallingClient {
  // biome-ignore lint/suspicious/noExplicitAny: structural typing over viem's invariant PublicClient
  readContract(args: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
    // biome-ignore lint/suspicious/noExplicitAny: see comment
  }): Promise<any>;
}

/**
 * Probe every 0-arg view/pure function on `abi` via the supplied client and
 * return a list of {@link CallMock}s: a `return` mock per successful call
 * (carrying the actual on-chain return value), and a `revert` mock for any
 * call that reverts.
 *
 * Use this from a Hardhat / anvil test fixture to make subgraph handlers
 * see realistic contract state when they do `try_*` reads on bound contracts.
 */
export async function captureViewMocksFromContract(
  client: ViewCallingClient,
  abi: Abi,
  address: Address,
): Promise<CallMock[]> {
  const mocks: CallMock[] = [];
  for (const item of abi) {
    if (item.type !== "function") continue;
    if (item.stateMutability !== "view" && item.stateMutability !== "pure") continue;
    if (item.inputs.length !== 0) continue;

    const outputs = item.outputs.map((o) => o.type).join(",");
    const signature = `${item.name}():(${outputs})`;

    try {
      const result = await client.readContract({
        address,
        abi: [item],
        functionName: item.name,
        args: [],
      });
      const returns = serializeReturnValues(result, item.outputs);
      mocks.push({
        kind: "return",
        address,
        name: item.name,
        signature,
        outputs: item.outputs.map((o) => o.type),
        returns,
      });
    } catch {
      mocks.push({ kind: "revert", address, name: item.name, signature });
    }
  }
  return mocks;
}

/**
 * Convert a viem `readContract` result into JSON-friendly values aligned 1:1
 * with the ABI outputs.
 *
 * viem returns a single value for single-output functions and a tuple
 * (typed as array or object depending on output names) for multi-output
 * functions. Tuple-struct returns are passed through `JSON.stringify` —
 * the AS side does NOT currently decode struct returns; only flat scalar
 * tuples are supported.
 */
function serializeReturnValues(
  result: unknown,
  outputs: readonly AbiParameter[],
): (string | number | boolean)[] {
  if (outputs.length === 0) return [];
  if (outputs.length === 1) {
    return [serializeReturnValue(result)];
  }
  // Multi-output: viem returns an array (or struct-shaped object when outputs
  // are named). Coerce to an ordered tuple.
  const tuple = Array.isArray(result)
    ? result
    : outputs.map((o) => (result as Record<string, unknown>)[o.name ?? ""]);
  return tuple.map((v) => serializeReturnValue(v));
}

function serializeReturnValue(v: unknown): string | number | boolean {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.startsWith("0x") ? v.toLowerCase() : v;
  // Struct / array / null fall back to a JSON-string; the AS side
  // currently only consumes scalar return mocks, so this is best-effort
  // for forward compatibility.
  return JSON.stringify(v);
}

export class EventCapture {
  private publicClient: ReceiptAwaitingClient;
  private events: CapturedEvent[] = [];

  constructor(pc: ReceiptAwaitingClient) {
    this.publicClient = pc;
  }

  /**
   * Parse events from a transaction receipt and append them to the buffer.
   */
  async captureFromReceipt(txHash: Hex, abi: Abi): Promise<CapturedEvent[]> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });

    const logs = parseEventLogs({
      logs: receipt.logs,
      abi,
    });

    const captured: CapturedEvent[] = [];

    for (const log of logs) {
      const event: CapturedEvent = {
        event: log.eventName,
        address: log.address,
        blockNumber: Number(receipt.blockNumber),
        logIndex: typeof log.logIndex === "number" ? log.logIndex : 0,
        transactionHash: receipt.transactionHash,
        params: this.serializeParams(log.args),
      };
      captured.push(event);
      this.events.push(event);
    }

    return captured;
  }

  getEvents(): CapturedEvent[] {
    return this.events;
  }

  /** Append events without going through a receipt (synthetic / fixture data). */
  appendEvents(events: CapturedEvent[]): void {
    this.events.push(...events);
  }

  /** Snapshot the captured events for passing to `runMatchstickTest`. */
  serialize(): CapturedEvent[] {
    return this.events;
  }

  clear(): void {
    this.events = [];
  }

  private serializeParams(args: unknown): ParamEntry[] {
    return serializeParams(args);
  }
}

/** Internal — shared by {@link EventCapture} and the log-sync ingester. */
export function serializeParams(args: unknown): ParamEntry[] {
  if (args === null || typeof args !== "object") return [];

  const result: ParamEntry[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "bigint") {
      result.push([key, value.toString()]);
    } else if (typeof value === "boolean") {
      result.push([key, value]);
    } else if (typeof value === "number") {
      result.push([key, value]);
    } else if (typeof value === "string" && value.startsWith("0x")) {
      result.push([key, value.toLowerCase()]);
    } else if (typeof value === "object" && value !== null) {
      result.push([key, JSON.stringify(value)]);
    } else {
      result.push([key, String(value)]);
    }
  }
  return result;
}
