/**
 * `MockRpcClient` — matchstick-parity contract-call mocks, packaged
 * as an `RpcClient` so it slots into `host.rpcClient` like any real
 * RPC adapter.
 *
 * Why a separate class instead of bolting onto `Host`:
 *   - Tests that don't need a real RPC can use `new MockRpcClient()`
 *     directly with the lower-level `WasmRunner` API.
 *   - Tests that DO need a real RPC for *most* contracts but want to
 *     override one specific call can compose:
 *     `new MockRpcClient({ fallback: makeViemRpc(client) })`.
 *
 * Lookup discipline (closest match wins):
 *   1. Exact match: same `to`, same selector, same encoded args.
 *   2. Wildcard args: same `to`, same selector, args ANY (`.withAnyArgs`).
 *   3. Fallback (if configured) — usually a real RPC for read-through.
 *   4. Otherwise: throw `MockNotFoundError` so a missing mock is loud.
 *
 * Matchstick analogues:
 *   `MockRpcClient.on(addr, sig).withArgs(args).returns(values)`
 *     ~  `createMockedFunction(addr, name, sig).withArgs(args).returns(values)`
 *   `MockRpcClient.on(addr, sig).withArgs(args).reverts()`
 *     ~  `createMockedFunction(addr, name, sig).withArgs(args).reverts()`
 *   `MockRpcClient.on(addr, sig).withAnyArgs().returns(values)`
 *     ~  `createMockedFunction(...)` with no `.withArgs(...)` call.
 */
import {
  decodeFunctionData,
  encodeAbiParameters,
  type Hex,
} from "viem";
import { parseGraphSignature, type ParsedSignature } from "./abi.ts";
import type { RpcClient } from "./host.ts";

/** Thrown when a wasm `eth_call` has no matching mock and no fallback. */
export class MockNotFoundError extends Error {
  readonly to: Hex;
  readonly data: Hex;
  constructor(to: Hex, data: Hex) {
    super(
      `MockRpcClient: no mock for to=${to} data=${data}. Add one via mock.on(to, signature).withArgs(...).returns(...) or set a fallback rpcClient.`,
    );
    this.name = "MockNotFoundError";
    this.to = to;
    this.data = data;
  }
}

/** Single (to, selector, args) -> outcome registration. */
interface MockEntry {
  to: Hex;
  signature: string;
  parsed: ParsedSignature;
  /**
   * Pre-encoded calldata args (selector excluded) we match `data`
   * against. `null` means "match any args for this selector".
   */
  matchArgsHex: Hex | null;
  /** Resolved outcome of a successful match. */
  outcome:
    | { kind: "returns"; returnsHex: Hex }
    | { kind: "reverts" };
  /**
   * How many times this mock has been hit. Useful for tests asserting
   * a contract was queried exactly N times.
   */
  hits: number;
}

export interface MockRpcClientOptions {
  /**
   * Optional fallback `RpcClient` to delegate to when no mock matches.
   * Use this to route most calls to a real fork while overriding
   * specific ones for the test under exercise.
   */
  fallback?: RpcClient;
  /**
   * What to do when no mock matches and there's no `fallback`:
   *   - `"throw"` (default): throw `MockNotFoundError` so missing
   *     mocks are loud during test development.
   *   - `"revert"`: resolve `null` (graph-ts sees `try_*` reverted),
   *     matching matchstick's "unmocked = reverted" semantics. The
   *     `Subgraph` facade uses this when no real RPC is provided.
   */
  onMissing?: "throw" | "revert";
}

/**
 * Builder returned by `MockRpcClient.on(address, signature)`. Chain
 * `.withArgs(...)` / `.withAnyArgs()` then `.returns(...)` / `.reverts()`
 * to register an outcome. Builder methods return the parent
 * `MockRpcClient` so further mocks can be added in a fluent chain.
 */
export class MockCallBuilder {
  private matchArgsHex: Hex | null = null;
  private readonly client: MockRpcClient;
  private readonly to: Hex;
  private readonly signature: string;
  private readonly parsed: ParsedSignature;

  constructor(
    client: MockRpcClient,
    to: Hex,
    signature: string,
    parsed: ParsedSignature,
  ) {
    this.client = client;
    this.to = to;
    this.signature = signature;
    this.parsed = parsed;
  }

  /**
   * Match this mock only when the call's args ABI-encode to exactly
   * `args` (in viem's input shape: addresses as hex, ints as bigint,
   * etc.). Mutually exclusive with `withAnyArgs()` — the last call
   * wins.
   */
  withArgs(args: readonly unknown[]): this {
    if (args.length !== this.parsed.inputs.length) {
      throw new Error(
        `MockRpcClient.withArgs: signature "${this.signature}" expects ${this.parsed.inputs.length} args, got ${args.length}`,
      );
    }
    this.matchArgsHex = encodeAbiParameters(
      this.parsed.inputs,
      args as unknown[],
    );
    return this;
  }

  /** Match any args for this `(to, selector)`. */
  withAnyArgs(): this {
    this.matchArgsHex = null;
    return this;
  }

  /**
   * Resolve the call with `values` ABI-encoded against the
   * signature's outputs. Pass JS values in viem's input shape.
   */
  returns(values: readonly unknown[]): MockRpcClient {
    if (values.length !== this.parsed.outputs.length) {
      throw new Error(
        `MockRpcClient.returns: signature "${this.signature}" expects ${this.parsed.outputs.length} return values, got ${values.length}`,
      );
    }
    const returnsHex = encodeAbiParameters(
      this.parsed.outputs,
      values as unknown[],
    );
    this.client._register({
      to: this.to,
      signature: this.signature,
      parsed: this.parsed,
      matchArgsHex: this.matchArgsHex,
      outcome: { kind: "returns", returnsHex },
      hits: 0,
    });
    return this.client;
  }

  /** Make the call revert (graph-ts's `try_*` sees `reverted=true`). */
  reverts(): MockRpcClient {
    this.client._register({
      to: this.to,
      signature: this.signature,
      parsed: this.parsed,
      matchArgsHex: this.matchArgsHex,
      outcome: { kind: "reverts" },
      hits: 0,
    });
    return this.client;
  }
}

export class MockRpcClient implements RpcClient {
  private readonly entries: MockEntry[] = [];
  private readonly fallback: RpcClient | null;
  private readonly onMissing: "throw" | "revert";

  constructor(options: MockRpcClientOptions = {}) {
    this.fallback = options.fallback ?? null;
    this.onMissing = options.onMissing ?? "throw";
  }

  /**
   * Begin registering a mock for `address`. `signature` uses
   * graph-cli's compact form (e.g. `"balanceOf(address):(uint256)"`).
   */
  on(address: Hex, signature: string): MockCallBuilder {
    const parsed = parseGraphSignature(signature);
    return new MockCallBuilder(
      this,
      normalizeAddress(address),
      signature,
      parsed,
    );
  }

  /**
   * Hit count for a specific mock by exact `to` + signature. Returns
   * the sum across all `withArgs(...)` variants registered for that
   * pair. Useful for `assert.equal(mock.hitCount(addr, sig), 1)`.
   */
  hitCount(address: Hex, signature: string): number {
    const target = normalizeAddress(address);
    return this.entries
      .filter((e) => e.to === target && e.signature === signature)
      .reduce((acc, e) => acc + e.hits, 0);
  }

  /**
   * Drop every registered mock. Cheap; equivalent to constructing a
   * fresh client. Doesn't touch `fallback`.
   */
  clear(): void {
    this.entries.length = 0;
  }

  /** Internal: register a fully-resolved entry from the builder. */
  _register(entry: MockEntry): void {
    this.entries.push(entry);
  }

  async call({ to, data }: { to: Hex; data: Hex }): Promise<Hex | null> {
    const target = normalizeAddress(to);
    if (data.length < 10) {
      throw new Error(
        `MockRpcClient: calldata too short to contain a selector: ${data}`,
      );
    }
    const selector = data.slice(0, 10).toLowerCase() as Hex;
    const argsHex = ("0x" + data.slice(10)) as Hex;

    // Iterate in reverse so the most-recently registered mock wins
    // when multiple match the same (to, selector, args). Mirrors
    // matchstick's "last `createMockedFunction(...).returns(...)`
    // overrides" semantics.

    // First pass: exact arg match.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.to !== target) continue;
      if (entry.parsed.selector.toLowerCase() !== selector) continue;
      if (entry.matchArgsHex === null) continue;
      if (entry.matchArgsHex.toLowerCase() === argsHex.toLowerCase()) {
        entry.hits++;
        return resolveOutcome(entry);
      }
    }
    // Second pass: wildcard arg match.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.to !== target) continue;
      if (entry.parsed.selector.toLowerCase() !== selector) continue;
      if (entry.matchArgsHex !== null) continue;
      entry.hits++;
      return resolveOutcome(entry);
    }
    // Fallback if configured.
    if (this.fallback) return this.fallback.call({ to, data });

    // No match + no fallback. Either revert (matchstick parity) or
    // throw with helpful (to, sig, args) so the caller can paste-add
    // the missing mock.
    if (this.onMissing === "revert") return null;
    const decodedArgs = tryDecodeArgs(this.entries, target, selector, data);
    throw new MockNotFoundError(
      to,
      (data + (decodedArgs ? ` ${decodedArgs}` : "")) as Hex,
    );
  }
}

function resolveOutcome(entry: MockEntry): Hex | null {
  return entry.outcome.kind === "reverts" ? null : entry.outcome.returnsHex;
}

function normalizeAddress(addr: Hex): Hex {
  return addr.toLowerCase() as Hex;
}

function tryDecodeArgs(
  entries: readonly MockEntry[],
  to: Hex,
  selector: Hex,
  data: Hex,
): string | null {
  // Find any registered mock with the same (to, selector) — even
  // ones with non-matching args — so we can decode and surface what
  // the wasm actually passed.
  const candidate = entries.find(
    (e) =>
      e.to === to && e.parsed.selector.toLowerCase() === selector.toLowerCase(),
  );
  if (!candidate) return null;
  try {
    const decoded = decodeFunctionData({
      abi: [
        {
          type: "function",
          name: candidate.parsed.name,
          stateMutability: "view",
          inputs: candidate.parsed.inputs,
          outputs: candidate.parsed.outputs,
        },
      ],
      data,
    });
    return `args=${JSON.stringify(decoded.args, bigintReplacer)}`;
  } catch {
    return null;
  }
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}
