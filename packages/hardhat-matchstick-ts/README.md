# hardhat-matchstick-ts

Hardhat 3 plugin for [`matchstick-ts`](https://www.npmjs.com/package/matchstick-ts): deploy a real
subgraph data source, run its mapping handlers through Matchstick, and assert on the resulting store
— all inside your existing Hardhat tests.

- Documentation and source: <https://github.com/lsheva/matchstick-ts>

## Requirements

- Node.js 22.6+
- Hardhat 3, `matchstick-ts`, `@graphprotocol/graph-cli`, `matchstick-as`

## Install

```sh
pnpm add -D hardhat-matchstick-ts matchstick-ts @graphprotocol/graph-cli matchstick-as
```

## Setup

```ts
// hardhat.config.ts
import hardhatMatchstick from "hardhat-matchstick-ts";

export default defineConfig({
  plugins: [
    /* viem, network-helpers, node-test-runner, … */
    hardhatMatchstick,
  ],
  matchstick: {
    subgraphYaml: "subgraph.yaml",
    schemaPath: "schema.graphql",
    verbose: false, // true prints the full `graph test` output
  },
});
```

## Usage

```ts
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { read } from "matchstick-ts";

const conn = await network.getOrCreate();

describe("subgraph integration", () => {
  after(() => conn.matchstick.reset());

  it("indexes a contract event", async () => {
    conn.matchstick.bind("MyDataSource", address, abi);
    await conn.matchstick.captureViewMocks();
    await conn.matchstick.anchor();

    await contract.write.myEvent([/* args */]);

    const [entity] = await conn.matchstick.index([read("MyEntity", "0")]);
    assert.ok(entity);
    assert.equal(entity.someField, "expected");
  });
});
```

Add the generated types to your test `tsconfig` and gitignore the scratch files:

```json
{ "include": ["integration/**/*.ts", "tests/.tmp/entities.d.ts"] }
```

```
tests/runner.test.ts
tests/.tmp/
```

## `conn.matchstick`

| Method | Role |
| --- | --- |
| `bind(dataSource, address, abi, { mocks?, context? })` | Map a manifest data source (or template) to a contract, optionally overriding `dataSource.context()` keys |
| `captureViewMocks()` | Probe view functions for realistic `try_*` return values |
| `anchor()` | Set the log cursor to chain head and clear the buffer |
| `ingest()` | Append new `eth_getLogs` only |
| `index(reads)` | Ingest + replay all buffered events, return entity rows |
| `reset()` | Clear bindings, events, and cursor (and generated files) |

### Context overrides

Contracts deployed by the test have new addresses, so override the manifest `context:` entries that hold them. Overridden keys replace the manifest's; the rest are kept. Plain values take the manifest entry's type, and keys the manifest lacks (always the case for templates) need `{ type, data }`:

```ts
conn.matchstick.bind("Oracle", oracle.address, oracleAbi, {
  context: { btcUsdAddress: btcUsd.address },
});
conn.matchstick.bind("Aggregator", aggregator.address, aggregatorAbi, {
  context: { pair: { type: "String", data: "BTC/USD" } },
});
```

## License

MIT
