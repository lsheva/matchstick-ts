# hardhat-matchstick-ts

## 0.4.4

### Patch Changes

- d66a380: Fix two issues found in a downstream subgraph:
  
  - matchstick-ts: the runner no longer runs out of memory on large snapshots. It logged the SNAPSHOT and MANIFEST JSON by concatenating it into the log format string, which graph-ts copies one character at a time; the JSON is now passed as a format argument.
  - hardhat-matchstick-ts: register a config hook so the `matchstick` block of `hardhat.config.ts` reaches the resolved config. Hardhat dropped it before, so `subgraphYaml` and the other defaults were ignored.

## 0.4.3

### Patch Changes

- e274be9: Version independently of `matchstick-ts`, and declare the versions this plugin supports.
  
  `matchstick-ts` is now a peer dependency instead of a hard dependency, with a wide compatible range
  (`>=0.4.2 <1.0.0`), alongside `hardhat` (`^3`).
  
  Compatibility is proven by the `packages/example` integration suite, which drives `matchstick-ts`
  through this plugin on every change and gates every publish. A `matchstick-ts` release that breaks
  the plugin fails CI before either package is published, and a new `hardhat-matchstick-ts` version is
  released only when that happens (or when the plugin itself changes). The two packages therefore
  version independently instead of moving together.
