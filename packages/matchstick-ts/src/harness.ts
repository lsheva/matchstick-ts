/**
 * Stateful facade: accumulate events (from receipts or by hand), optionally
 * register revert mocks, then replay through Matchstick and return a typed
 * `Snapshot` for the requested entities.
 */
import type { Abi, Address, Hex } from "viem";
import {
  captureViewMocksFromContract,
  EventCapture,
  viewFunctionRevertMocks,
  type CallMock,
  type CapturedEvent,
  type ReceiptAwaitingClient,
  type ViewCallingClient,
} from "./event-capture.ts";
import {
  runMatchstickTest,
  type AugmentedEntities,
  type EntityRef,
  type RunOptions,
  type Snapshot,
} from "./snapshot.ts";

type RunDefaults<TEntities> = Omit<
  RunOptions<TEntities>,
  "events" | "reads" | "callMocks" | "revertMocks"
>;

export interface MatchstickHarnessOptions<TEntities = AugmentedEntities> {
  /** When set, `captureFromReceipt` parses logs from mined transactions. */
  publicClient?: ReceiptAwaitingClient;
  /** Seed events (synthetic flows). */
  events?: CapturedEvent[];
  /**
   * Pre-registered view-call mocks. `CallMock` is a discriminated union of
   * `{ kind: "revert" }` and `{ kind: "return", outputs, returns }`. The
   * legacy `RevertMock` shape (no `kind` field) is still accepted.
   */
  callMocks?: CallMock[];
  /** @deprecated Use {@link MatchstickHarnessOptions.callMocks}. */
  revertMocks?: CallMock[];
  /** subgraph.yaml / schema paths — merged into every `run()`. */
  runDefaults?: RunDefaults<TEntities>;
}

function mockKey(mock: CallMock): string {
  return `${mock.address}:${mock.signature}`;
}

/**
 * Collect events → pipe to Matchstick → return requested entities.
 *
 * @example Hardhat integration
 * ```ts
 * const harness = new MatchstickHarness(await publicClient, {
 *   runDefaults: matchstickRunOptionsFromConfig(hre.config.matchstick),
 * });
 *
 * await harness.captureFromReceipt(txHash, abi);
 * harness.mockViewsAsReverting(abi, address);
 *
 * const snap = await harness.run(readsFor("Counter", ["0"]));
 * ```
 *
 * @example Synthetic events only
 * ```ts
 * const harness = new MatchstickHarness({ events: valueSetCaptured(42n) });
 * const snap = await harness.run(readsFor("Counter", ["0"]));
 * ```
 */
export class MatchstickHarness<TEntities = AugmentedEntities> {
  private readonly capture: EventCapture | undefined;
  private readonly manualEvents: CapturedEvent[];
  private readonly callMocks = new Map<string, CallMock>();
  private readonly runDefaults: RunDefaults<TEntities>;

  constructor(
    clientOrOptions: ReceiptAwaitingClient | MatchstickHarnessOptions<TEntities> = {},
  ) {
    if (isReceiptClient(clientOrOptions)) {
      this.capture = new EventCapture(clientOrOptions);
      this.manualEvents = [];
      this.runDefaults = {};
      return;
    }

    const options = clientOrOptions;
    this.capture =
      options.publicClient === undefined
        ? undefined
        : new EventCapture(options.publicClient);
    this.manualEvents = [...(options.events ?? [])];
    this.runDefaults = options.runDefaults ?? {};
    for (const mock of [...(options.revertMocks ?? []), ...(options.callMocks ?? [])]) {
      this.callMocks.set(mockKey(mock), mock);
    }
  }

  /** Parse and append logs from a mined transaction. */
  async captureFromReceipt(txHash: Hex, abi: Abi): Promise<CapturedEvent[]> {
    if (this.capture === undefined) {
      throw new Error(
        "MatchstickHarness: captureFromReceipt requires a publicClient (pass to constructor)",
      );
    }
    return this.capture.captureFromReceipt(txHash, abi);
  }

  /** Append hand-built or fixture events. */
  pushEvents(events: CapturedEvent[]): void {
    if (this.capture !== undefined) {
      this.capture.appendEvents(events);
      return;
    }
    this.manualEvents.push(...events);
  }

  /**
   * Register 0-arg view/pure functions on `abi` to revert in Matchstick so
   * handler `try_*` reads fail gracefully. Chainable.
   *
   * Prefer {@link mockViewsFromContract} when a live client is available —
   * it captures the actual on-chain return value, so handlers see realistic
   * data instead of always seeing the `reverted = true` branch.
   */
  mockViewsAsReverting(abi: Abi, address: Address): this {
    for (const mock of viewFunctionRevertMocks(abi, address)) {
      this.callMocks.set(mockKey(mock), mock);
    }
    return this;
  }

  /**
   * Probe every 0-arg view/pure function on `abi` via the supplied client and
   * register a `return` mock with the real on-chain value (or a `revert` mock
   * if the call reverts). Async — await before {@link run}.
   */
  async mockViewsFromContract(
    client: ViewCallingClient,
    abi: Abi,
    address: Address,
  ): Promise<this> {
    for (const mock of await captureViewMocksFromContract(client, abi, address)) {
      this.callMocks.set(mockKey(mock), mock);
    }
    return this;
  }

  addCallMocks(mocks: CallMock[]): this {
    for (const mock of mocks) {
      this.callMocks.set(mockKey(mock), mock);
    }
    return this;
  }

  /** @deprecated Use {@link MatchstickHarness.addCallMocks}. */
  addRevertMocks(mocks: CallMock[]): this {
    return this.addCallMocks(mocks);
  }

  /** Events accumulated so far (capture buffer + any manual pushes). */
  events(): CapturedEvent[] {
    if (this.capture !== undefined) {
      return this.capture.serialize();
    }
    return [...this.manualEvents];
  }

  /** Drop captured events and call mocks; keeps `runDefaults`. */
  reset(): void {
    this.capture?.clear();
    this.manualEvents.length = 0;
    this.callMocks.clear();
  }

  /**
   * Replay all captured events through the subgraph mapping and return a
   * `Snapshot` containing only the entities listed in `reads`.
   */
  async run(
    reads: EntityRef<TEntities>[],
    overrides?: RunDefaults<TEntities>,
  ): Promise<Snapshot<TEntities>> {
    return runMatchstickTest<TEntities>({
      ...this.runDefaults,
      ...overrides,
      events: this.events(),
      reads,
      callMocks: [...this.callMocks.values()],
    });
  }
}

function isReceiptClient(
  value: ReceiptAwaitingClient | MatchstickHarnessOptions,
): value is ReceiptAwaitingClient {
  return typeof value === "object" && value !== null && "waitForTransactionReceipt" in value;
}
