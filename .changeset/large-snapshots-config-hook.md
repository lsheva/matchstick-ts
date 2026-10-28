---
"matchstick-ts": patch
"hardhat-matchstick-ts": patch
---

Fix two issues found in a downstream subgraph:

- matchstick-ts: the runner no longer runs out of memory on large snapshots. It logged the SNAPSHOT and MANIFEST JSON by concatenating it into the log format string, which graph-ts copies one character at a time; the JSON is now passed as a format argument.
- hardhat-matchstick-ts: register a config hook so the `matchstick` block of `hardhat.config.ts` reaches the resolved config. Hardhat dropped it before, so `subgraphYaml` and the other defaults were ignored.
