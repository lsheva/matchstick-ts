/**
 * Capture and serialize EVM events from transaction receipts into a
 * Matchstick-friendly JSON shape (`CapturedEvent[]`).
 *
 * Framework-agnostic — takes a viem `PublicClient`, works with Hardhat,
 * anvil, or any other RPC.
 */
import { parseEventLogs, type Abi, type Address, type Hex } from "viem";

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

export interface CapturedEvent {
  event: string;
  address: Address;
  blockNumber: number;
  transactionHash: Hex;
  params: Record<string, string>;
}

export interface RevertMock {
  /** Contract address to register the mock at. */
  address: Address;
  /** Function name (e.g., "collateralVault"). */
  name: string;
  /** Canonical signature (e.g., "collateralVault():(address)"). */
  signature: string;
}

/**
 * Derive a list of revert-mocks for every 0-arg view/pure function on the ABI.
 *
 * Use this to satisfy Matchstick when handlers do best-effort `try_*` reads on
 * the bound contract: every registered mock simply reverts so `try_*` returns
 * `reverted = true` and the handler skips the field gracefully.
 */
export function viewFunctionRevertMocks(abi: Abi, address: Address): RevertMock[] {
  const mocks: RevertMock[] = [];
  for (const item of abi) {
    if (item.type !== "function") continue;
    if (item.stateMutability !== "view" && item.stateMutability !== "pure") continue;
    if (item.inputs.length !== 0) continue;

    const inputs = "";
    const outputs = item.outputs.map((o) => o.type).join(",");
    mocks.push({
      address,
      name: item.name,
      signature: `${item.name}(${inputs}):(${outputs})`,
    });
  }
  return mocks;
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

  private serializeParams(args: unknown): Record<string, string> {
    const result: Record<string, string> = {};
    if (args === null || typeof args !== "object") return result;

    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "bigint") {
        result[key] = value.toString();
      } else if (typeof value === "string" && value.startsWith("0x")) {
        result[key] = value.toLowerCase();
      } else if (typeof value === "object" && value !== null) {
        result[key] = JSON.stringify(value);
      } else {
        result[key] = String(value);
      }
    }

    return result;
  }
}
