# matchstick-ts

Typed snapshot testing for [The Graph](https://thegraph.com/) subgraphs, running your mapping
handlers through [Matchstick](https://github.com/LimeChain/matchstick).

Replay captured EVM events through your handlers, dump store entities as JSON, and assert in
TypeScript. Auto-generated `entities.d.ts` augments `matchstick-ts` (Hardhat `artifacts.d.ts` style),
so tests need no `import type { Entities }`.

- Documentation and source: <https://github.com/lsheva/matchstick-ts>
- Hardhat 3 integration: [`hardhat-matchstick-ts`](https://www.npmjs.com/package/hardhat-matchstick-ts)

## Requirements

- Node.js 22.6+
- `@graphprotocol/graph-cli` (provides `graph test` / Matchstick)
- `matchstick-as` in your subgraph project

## Install

```sh
pnpm add -D matchstick-ts @graphprotocol/graph-cli matchstick-as
```

## Quick start — synthetic events

```ts
import assert from "node:assert/strict";
import { runMatchstickTest, readsFor } from "matchstick-ts";

const snap = await runMatchstickTest({
  events: [
    {
      event: "ValueSet",
      address: "0x0000000000000000000000000000000000000000",
      blockNumber: 1,
      transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      params: [["newValue", "99"]],
    },
  ],
  reads: readsFor("Counter", ["0"]),
});

assert.equal(snap.get("Counter", "0", "value"), "99");
```

## Quick start — replay real chain logs

```ts
import { SubgraphLogSync, readsFor } from "matchstick-ts";

const sync = new SubgraphLogSync({
  client: publicClient, // any viem PublicClient
  runDefaults: { subgraphYaml: "subgraph.yaml" },
});

sync.bind("Counter", address, abi);
await sync.captureViewMocks(); // realistic return values for handler try_* reads
await sync.anchor(); // start from the current chain head

const [counter] = await sync.index(readsFor("Counter", ["0"]));
```

`index()` ingests new logs (`eth_getLogs`) and then replays the **entire** buffered event history
through Matchstick — Matchstick has no incremental store. Use `anchor()` after deploy and `reset()`
between tests; see the repository README for `bind` / `anchor` / `ingest` / `index` / `reset`.

## CLI

```sh
matchstick-ts generate-runner   <subgraph.yaml>  <tests/runner.test.ts>    [--temp-dir tests/.tmp]
matchstick-ts generate-entities <schema.graphql> <tests/.tmp/entities.d.ts> [--subgraph subgraph.yaml]
```

Optional when `autoCodegen: true` (the default).

## Notes

- Event arguments are serialized in ABI input order, matching the positional `event.parameters[i]`
  accessors in graph-cli–generated classes.
- Published tarballs ship `src/` and `dist/`: `types` resolves to source for editors, `default` to
  compiled JS for normal Node. Node 22.6+ can opt into source at runtime with
  `--conditions=typescript --experimental-strip-types`.

## License

MIT
