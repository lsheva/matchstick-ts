# Changelog

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
