---
"matchstick-ts": minor
---

Add per-data-source `dataSource.context()` overrides: `bind(dataSource, address, abi, { context })` and `runMatchstickTest({ context })`. Overridden keys replace the manifest's entries for that data source or template, other keys are kept, and plain values take their type from the manifest entry with the same key. The runner reads them from a new `context.json`.

Block handlers now see the address a data source is bound to as `dataSource.address()`, even when that data source emitted no events, instead of the manifest's `source.address`. Synthetic tests can pass `RunOptions.addresses` for the same effect.
