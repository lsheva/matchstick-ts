# matchstick-ts

Typed snapshot testing for [The Graph](https://thegraph.com/) subgraphs via [Matchstick](https://github.com/LimeChain/matchstick).

Replay captured EVM events through your mapping handlers, dump store entities as JSON, and assert in TypeScript. Auto-generated `entities.d.ts` augments `matchstick-ts` (Hardhat `artifacts.d.ts` style) — no `import type { Entities }` in tests.

## Packages

| Package | npm | Role |
| --- | --- | --- |
| [`packages/matchstick-ts`](packages/matchstick-ts/) | `matchstick-ts` | `runMatchstickTest`, `Snapshot`, `EventCapture`, codegen, AS helpers |
| [`packages/hardhat-matchstick-ts`](packages/hardhat-matchstick-ts/) | `hardhat-matchstick-ts` | Hardhat 3 plugin + `conn.matchstick` |
| [`packages/example`](packages/example/) | — | Reference subgraph + **integration tests** (CI) |

## Package layout (TypeScript-first)

Published tarballs include **`src/`** and **`dist/`**:

| Export condition | Resolves to | Used by |
| --- | --- | --- |
| `types` | `./src/*.ts` | TypeScript, editors (jump-to-def on source) |
| `typescript` | `./src/*.ts` | Node 22.6+ with type stripping (opt-in) |
| `default` | `./dist/*.js` | Normal Node / production / Hardhat plugin |

Opt into runtime source with:

```bash
node --conditions=typescript --experimental-strip-types your-test.mjs
```

Or set `NODE_OPTIONS='--conditions=typescript --experimental-strip-types'`. Without that, Node loads compiled **`dist/`** (no experimental flags required). The CLI always uses `dist/bin/cli.js`.

## Requirements

- **Node.js** 22.6+ (22+ works; 22.6+ for optional `--experimental-strip-types` on source)
- **`@graphprotocol/graph-cli`** — provides `graph test` / Matchstick (`pnpm add -D @graphprotocol/graph-cli`)
- **`matchstick-as`** — in your subgraph project (`pnpm add -D matchstick-as`)
- **`viem`** — optional peer; required for chain log capture / Hardhat tests

## Install

```bash
pnpm add -D matchstick-ts @graphprotocol/graph-cli matchstick-as
pnpm add -D hardhat-matchstick-ts   # Hardhat integration tests only
```

From GitHub:

```bash
pnpm add -D "github:lsheva/matchstick-ts"
```

## Quick start (Hardhat 3)

### `hardhat.config.ts`

```ts
import hardhatMatchstick from "hardhat-matchstick-ts";

export default defineConfig({
  plugins: [/* viem, network-helpers, node-test-runner, … */, hardhatMatchstick],
  matchstick: {
    subgraphYaml: "subgraph.yaml",
    schemaPath: "schema.graphql",
    verbose: false, // set true to print full graph test output
  },
});
```

### Integration test

```ts
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { read } from "matchstick-ts";
import { deployMyContract } from "./deploy.js";

const conn = await network.getOrCreate();

describe("subgraph integration", () => {
  after(() => conn.matchstick.reset());

  it("indexes a contract event", async () => {
    const { address, abi, contract } = await deployMyContract(conn);
    const wallet = (await conn.viem.getWalletClients())[0];

    conn.matchstick.bind("MyDataSource", address, abi);
    await conn.matchstick.anchor();

    await contract.write.myEvent([/* args */], {
      account: wallet.account,
      chain: wallet.chain,
    });

    const [entity] = await conn.matchstick.index([read("MyEntity", "0")]);

    assert.ok(entity);
    assert.equal(entity.someField, "expected");
  });
});
```

### TypeScript setup

Include generated types in your test `tsconfig`:

```json
{
  "include": [
    "integration/**/*.ts",
    "tests/.tmp/entities.d.ts"
  ]
}
```

Gitignore generated scratch files:

```
tests/runner.test.ts
tests/.tmp/
```

First `index()` or `runMatchstickTest()` run creates `tests/runner.test.ts` and `entities.d.ts` (idempotent).

## `conn.matchstick` API

| Method | Role |
| --- | --- |
| `bind(dataSource, address, abi)` | Map manifest data source → contract (typed via generated `DataSources`) |
| `anchor()` | Set log cursor to chain head, clear event buffer |
| `ingest()` | Append new `eth_getLogs` only |
| `index(reads)` | Ingest + replay **all** buffered events + return entity rows |
| `reset()` | Clear bindings, events, cursor |

**Important:** each `index()` replays the **entire** event buffer from the first event (Matchstick has no incremental store). Only `getLogs` is incremental. Use `anchor()` after deploy and `reset()` between tests.

`lastSyncedBlock` is the **log ingest cursor** (last block fetched via `ingest`), not subgraph sync state.

## Synthetic events (no chain)

```ts
import { runMatchstickTest, readsFor } from "matchstick-ts";

const snap = await runMatchstickTest({
  events: [{ event: "MyEvent", address: "0x…", blockNumber: 1, transactionHash: "0x…", params: {} }],
  reads: readsFor("MyEntity", ["0"]),
});
assert.equal(snap.get("MyEntity", "0", "field"), "99");
```

## Verbose Matchstick output

- `matchstick: { verbose: true }` in Hardhat config
- `verbose: true` on `runMatchstickTest` / `index({ run: { verbose: true } })`
- `MATCHSTICK_VERBOSE=1` in the environment

Prints full `graph test` stdout (handler `log.*` lines included).

## Alternative: `MatchstickHarness`

For receipt-based capture without `conn.matchstick`:

```ts
import { MatchstickHarness, readsFor } from "matchstick-ts";

const harness = new MatchstickHarness(publicClient, { runDefaults: { subgraphYaml: "subgraph.yaml" } });
await harness.captureFromReceipt(txHash, abi);
const snap = await harness.run(readsFor("MyEntity", ["0"]));
```

## CLI

```bash
matchstick-ts generate-runner   <subgraph.yaml>  <tests/runner.test.ts>  [--temp-dir tests/.tmp]
matchstick-ts generate-entities <schema.graphql> <tests/.tmp/entities.d.ts>  [--subgraph <subgraph.yaml>]
```

Optional when `autoCodegen: true` (default on `runMatchstickTest`).

## Testing this repo

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

## License

MIT
