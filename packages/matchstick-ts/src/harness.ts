/**
 * Stateful facade: accumulate events (from receipts or by hand), optionally
 * register revert mocks, then replay through Matchstick and return a typed
 * `Snapshot` for the requested entities.
 */
import type { Abi, Address, Hex } from "viem";
import {
  EventCapture,
  viewFunctionRevertMocks,
  type CapturedEvent,
  type ReceiptAwaitingClient,
  type RevertMock,
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
  "events" | "reads" | "revertMocks"
>;

export interface MatchstickHarnessOptions<TEntities = AugmentedEntities> {
  /** When set, `captureFromReceipt` parses logs from mined transactions. */
  publicClient?: ReceiptAwaitingClient;
  /** Seed events (synthetic flows). */
  events?: CapturedEvent[];
  revertMocks?: RevertMock[];
  /** subgraph.yaml / schema paths — merged into every `run()`. */
  runDefaults?: RunDefaults<TEntities>;
}

function mockKey(mock: RevertMock): string {
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
  private readonly revertMocks = new Map<string, RevertMock>();
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
    for (const mock of options.revertMocks ?? []) {
      this.revertMocks.set(mockKey(mock), mock);
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
   */
  mockViewsAsReverting(abi: Abi, address: Address): this {
    for (const mock of viewFunctionRevertMocks(abi, address)) {
      this.revertMocks.set(mockKey(mock), mock);
    }
    return this;
  }

  addRevertMocks(mocks: RevertMock[]): this {
    for (const mock of mocks) {
      this.revertMocks.set(mockKey(mock), mock);
    }
    return this;
  }

  /** Events accumulated so far (capture buffer + any manual pushes). */
  events(): CapturedEvent[] {
    if (this.capture !== undefined) {
      return this.capture.serialize();
    }
    return [...this.manualEvents];
  }

  /** Drop captured events and revert mocks; keeps `runDefaults`. */
  reset(): void {
    this.capture?.clear();
    this.manualEvents.length = 0;
    this.revertMocks.clear();
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
      revertMocks: [...this.revertMocks.values()],
    });
  }
}

function isReceiptClient(
  value: ReceiptAwaitingClient | MatchstickHarnessOptions,
): value is ReceiptAwaitingClient {
  return typeof value === "object" && value !== null && "waitForTransactionReceipt" in value;
}
