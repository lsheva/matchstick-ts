---
"matchstick-ts": minor
---

Add per-data-source `dataSource.context()` overrides: `bind(dataSource, address, abi, { context })` and `runMatchstickTest({ context })`. Overridden keys replace the manifest's entries for that data source or template, other keys are kept, and plain values take their type from the manifest entry with the same key. The runner reads them from a new `context.json`.
