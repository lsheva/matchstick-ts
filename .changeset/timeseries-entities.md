---
"matchstick-ts": minor
---

Support timeseries entities, block handlers, data source context and templates:

- `@entity(timeseries: true)`: the generated-schema patch stores `Timestamp` values as `Int8`, which avoids matchstick 0.6.0's "value 9 is out of range for StoreValueKind" panic. It also assigns `id` and `timestamp` on `save()` the way graph-node does. Opt out of the id and timestamp emulation with `emulateTimeseries: false`.
- `dataSource.context()` returns the manifest `context:` values, and `dataSource.address()` and `.network()` follow the data source of each trigger.
- `once` and unfiltered block handlers are replayed alongside the captured events.
- Template events are routed via the new `CapturedEvent.dataSource`, which `SubgraphLogSync` fills from the binding name.
- `SubgraphLogSync` now orders events by `(blockNumber, logIndex)`. Previously, events in the same block were ordered by transaction hash.
