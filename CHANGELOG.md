# Changelog

## 0.4.2 — 2026-07-20

### `matchstick-ts`

- **Forward `block.timestamp` onto mock events.** Capture/ingest now resolves
  the including block's unix timestamp (via `getBlock`) into
  `CapturedEvent.blockTimestamp`, and the generated runner assigns it to
  `event.block.timestamp`. Handlers that branch on time (e.g. expired vs
  cancelled) now see the same value Graph Node would. Optional for synthetic
  events / clients without `getBlock` — missing values keep the matchstick
  default.
- **`SubgraphLogSync.reset()` actually deletes generated artifacts.** The
  method previously only cleared in-memory state, leaving `tests/runner.test.ts`
  and `tests/.tmp` behind so a later `graph test` could pick up the leftover
  runner. It now calls `cleanupGeneratedFiles` with the configured
  `runnerPath` / `jsonDir` (honors `KEEP_TEMP=1`).

### `hardhat-matchstick-ts`

- Wires `publicClient.getBlock` into the matchstick indexer client so ingested
  logs receive `blockTimestamp`.

## 0.4.1 — 2026-07-01

### `matchstick-ts`

- **Solidity tuple / struct event params now decode end-to-end.** Previously,
  struct params (e.g. `ConfigUpdated(Config)`) broke on both sides of the wire:
  `serializeParams` called `JSON.stringify` on the object and threw on any
  `bigint` field (every `uint256`), and the assembly runtime fell back to a
  string, so the generated event class's `.toTuple()` aborted with "Ethereum
  value is not a tuple".
  - TS side: `serializeParams` now recursively encodes tuples/arrays as nested
    JSON arrays (`bigint`s stringified) instead of `JSON.stringify`.
  - AS side: `jsonValueToEthereumValue` decodes `JSONValueKind.ARRAY` into an
    `ethereum.Tuple`, so struct params round-trip correctly.
  - This lands the fix that downstream indexers previously applied via a
    `postinstall` monkey-patch — that patch can now be removed.
- The example subgraph gained a `ConfigUpdated(Config)` struct event with unit,
  synthetic, and on-chain e2e test coverage for the tuple path.

### Packaging

- `pnpm-workspace.yaml` now approves `esbuild`'s build script via `allowBuilds`
  so installs (and git-hosted `prepare`) succeed under pnpm v11's stricter
  build-script policy.

## 0.4.0 — 2026-05-21

### `matchstick-ts`

- **Return-value view mocks.** Handler `try_*` reads can now observe real on-chain values
  instead of always seeing `reverted = true`. New `captureViewMocksFromContract(client, abi, address)`
  probes every 0-arg view/pure function via `eth_call` and emits a `CallReturnMock` per
  successful call (revert mocks are still emitted as a fallback). The mock wire format
  is now a discriminated union: `{ kind: "revert" | "return", ... }`. Legacy
  payloads without `kind` continue to be treated as revert mocks.
- New types: `CallMock`, `CallRevertMock`, `CallReturnMock`, `ViewCallingClient`.
  `RevertMock` kept as a deprecated alias for `CallRevertMock`.
- New `RunOptions.callMocks` (preferred); `revertMocks` kept as a deprecated alias —
  both flow into the same mock map.
- `MatchstickHarness.mockViewsFromContract(client, abi, address)` — async sibling of
  `mockViewsAsReverting` that captures real return values.
- `SubgraphLogSync`:
  - `bind(name, address, abi, { mocks })` — stays synchronous (pure bookkeeping):
    records the data source, seeds a revert mock per 0-arg view fn, and accepts
    optional preset mocks via `options.mocks`.
  - `captureViewMocks({ dataSource?, viewClient? })` — new async sibling that
    probes bound contracts via `eth_call` and upgrades revert mocks to return
    mocks with real on-chain values. Defaults to every bound source.
  - `addCallMocks(mocks)` — sync helper to add/override individual mocks.
  - Constructor `viewClient` option supplies the default client for
    `captureViewMocks`.

### `hardhat-matchstick-ts`

- The plugin forwards the connection's viem `PublicClient.readContract` as the
  default `viewClient` for the `NetworkConnection.matchstick` indexer, so tests
  can just write `await conn.matchstick.captureViewMocks()` after `bind()` to
  populate realistic return-value mocks.

## 0.1.0 — 2026-05-16

First public release.

### `matchstick-ts`

- `runMatchstickTest` — replay events through Matchstick, return typed `Snapshot`
- Auto-codegen: `tests/runner.test.ts` + `tests/.tmp/entities.d.ts` (module augmentation)
- `read` / `readsFor` / `indexResultsFromSnapshot` for typed entity refs
- `SubgraphLogSync` — `bind`, `ingest`, `index`, `anchor`, `reset`
- `EventCapture`, `MatchstickHarness`, `viewFunctionRevertMocks`
- CLI: `generate-runner`, `generate-entities` (`--subgraph` for `DataSources` typing)
- Verbose: `verbose: true` or `MATCHSTICK_VERBOSE=1` prints full `graph test` output

### `hardhat-matchstick-ts`

- Hardhat 3 plugin: `matchstick` config block
- `NetworkConnection.matchstick` indexer (`bind` / `ingest` / `index`)
- Optional `hardhat-matchstick-ts/node` helpers (`getOrCreateNode`)

### Publishing

- npm tarballs ship **`src/`** + **`dist/`** (TypeScript-first: `types` → source, `default` → compiled JS).
- Opt-in runtime source: `node --conditions=typescript --experimental-strip-types`.

### Notes

- Each `index()` replays the **full** event buffer (incremental `getLogs` only).
- Requires Node 22.6+, `@graphprotocol/graph-cli` (`graph test`), and `matchstick-as` in the subgraph project.
