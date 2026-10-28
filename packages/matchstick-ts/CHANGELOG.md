# matchstick-ts

## 0.6.1

### Patch Changes

- d66a380: Fix two issues found in a downstream subgraph:
  
  - matchstick-ts: the runner no longer runs out of memory on large snapshots. It logged the SNAPSHOT and MANIFEST JSON by concatenating it into the log format string, which graph-ts copies one character at a time; the JSON is now passed as a format argument.
  - hardhat-matchstick-ts: register a config hook so the `matchstick` block of `hardhat.config.ts` reaches the resolved config. Hardhat dropped it before, so `subgraphYaml` and the other defaults were ignored.

## 0.6.0

### Minor Changes

- ec6bd75: Add per-data-source `dataSource.context()` overrides: `bind(dataSource, address, abi, { context })` and `runMatchstickTest({ context })`. Overridden keys replace the manifest's entries for that data source or template, other keys are kept, and plain values take their type from the manifest entry with the same key. The runner reads them from a new `context.json`.
  
  Block handlers now see the address a data source is bound to as `dataSource.address()`, even when that data source emitted no events, instead of the manifest's `source.address`. Synthetic tests can pass `RunOptions.addresses` for the same effect.

## 0.5.0

### Minor Changes

- e44e009: Support timeseries entities, block handlers, data source context and templates:
  
  - `@entity(timeseries: true)`: the generated-schema patch stores `Timestamp` values as `Int8`, which avoids matchstick 0.6.0's "value 9 is out of range for StoreValueKind" panic. It also assigns `id` and `timestamp` on `save()` the way graph-node does. Opt out of the id and timestamp emulation with `emulateTimeseries: false`.
  - `dataSource.context()` returns the manifest `context:` values, and `dataSource.address()` and `.network()` follow the data source of each trigger.
  - `once` and unfiltered block handlers are replayed alongside the captured events.
  - Template events are routed via the new `CapturedEvent.dataSource`, which `SubgraphLogSync` fills from the binding name.
  - `SubgraphLogSync` now orders events by `(blockNumber, logIndex)`. Previously, events in the same block were ordered by transaction hash.

### Patch Changes

- 8c90502: Add a README so the package page on npm has documentation.
  
  The README shipped in the tarball, but npm only renders a README that was present
  in the published version — `0.4.3` went out before the README existed, so this
  release republishes the package with it.

## 0.4.3

### Patch Changes

- 5cd056e: Serialize decoded event args in ABI input order.
  
  viem's `parseEventLogs` fills named args indexed-first, so an event like
  `Deposited(address indexed user, uint256 amount, address indexed sender)` arrived
  as `[user, sender, amount]`. Generated handlers read `event.parameters[i]`
  positionally, so `parameters[1].toBigInt()` aborted on the address in slot 1
  (`Ethereum value is not an int or uint`). Named args are now rebuilt in the
  event's declared input order before serialization. Unnamed events (array args)
  and events with incomplete input names keep the previous behavior.
