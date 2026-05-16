# matchstick-ts

Typed snapshot testing for [The Graph](https://thegraph.com/) subgraphs via [Matchstick](https://github.com/LimeChain/matchstick).

Replay captured EVM events through your mapping handlers, dump store entities as JSON, and assert in TypeScript. Auto-generated `entities.d.ts` augments `matchstick-ts` (Hardhat `artifacts.d.ts` style) — no `import type { Entities }` in tests.

## Packages

| Package | npm | Role |
| --- | --- | --- |
| [`packages/matchstick-ts`](packages/matchstick-ts/) | `matchstick-ts` | `runMatchstickTest`, `Snapshot`, `EventCapture`, codegen, AS helpers |
| [`packages/hardhat-matchstick-ts`](packages/hardhat-matchstick-ts/) | `hardhat-matchstick-ts` | Hardhat 3 plugin + in-process node |
| [`packages/example`](packages/example/) | — | Reference subgraph + **integration tests** (CI) |

## Install

```bash
pnpm add -D matchstick-ts
pnpm add -D hardhat-matchstick-ts   # Hardhat integration tests only
```

From GitHub:

```bash
pnpm add -D "github:lsheva/matchstick-ts"
```

## Quick start

### `hardhat.config.ts`

```ts
import hardhatMatchstick from "hardhat-matchstick-ts";

export default defineConfig({
  plugins: [/* viem, network-helpers, … */, hardhatMatchstick],
  matchstick: {
    subgraphYaml: "subgraph.yaml",
    schemaPath: "schema.graphql",
  },
});
```

### Integration test

```ts
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { MatchstickHarness, readsFor } from "matchstick-ts";
import { getOrCreateNode } from "hardhat-matchstick-ts/node";
import { matchstickRunOptionsFromConfig } from "hardhat-matchstick-ts";

describe("my flow", async () => {
  const node = await getOrCreateNode();
  const harness = new MatchstickHarness(await node.conn.viem.getPublicClient(), {
    runDefaults: matchstickRunOptionsFromConfig(node.hre.config.matchstick),
  });

  it("indexes events", async () => {
    // deploy, transact, then:
    await harness.captureFromReceipt(txHash, abi);
    harness.mockViewsAsReverting(abi, address);

    const snap = await harness.run(readsFor("MyEntity", ["0"]));
    assert.equal(snap.get("MyEntity", "0", "field"), "expected");
  });

  after(() => node.close());
});
```

Lower-level pieces (`EventCapture`, `runMatchstickTest`) remain available when you need finer control.

### Hardhat `conn.matchstick`

```ts
const conn = await network.getOrCreate();
conn.matchstick.bind("Counter", address, abi);
await conn.matchstick.anchor(); // skip history before deploy
await counter.write.setValue([42n]);
const [entity] = await conn.matchstick.index([read("Counter", "0")]);
```

**Important:** each `index()` call ingests new chain logs incrementally, then replays **every** buffered event from the beginning through Matchstick (fresh WASM store). Only `getLogs` is incremental; the subgraph store is not retained between calls. Use `anchor()` after deploy and `reset()` between fixtures.

`runMatchstickTest` auto-codegen (default): writes `tests/runner.test.ts` and `tests/.tmp/entities.d.ts` before each run (idempotent).

**Verbose Matchstick output:** set `matchstick: { verbose: true }` in `hardhat.config.ts`, pass `verbose: true` to `runMatchstickTest`, or run tests with `MATCHSTICK_VERBOSE=1` to print full `graph test` stdout (handler `log.*` lines included).

Reference subgraph + tests: [`packages/example`](packages/example/).

If you have multiple Node integration files, run them with `--test-concurrency=1`. Node’s test runner executes files in parallel by default; concurrent `graph test` / Matchstick runs corrupt each other.

## Testing this repo

```bash
pnpm test              # unit tests + example integration
pnpm test:unit           # matchstick-ts only (fast)
pnpm test:integration    # packages/example (Matchstick + optional Hardhat)
```

## CLI

```bash
matchstick-ts generate-runner   <subgraph.yaml>  <tests/runner.test.ts>  [--temp-dir tests/.tmp]
matchstick-ts generate-entities <schema.graphql> <tests/.tmp/entities.d.ts>
```

Optional when `autoCodegen: true` (default).

## Develop

```bash
pnpm install
pnpm test
pnpm typecheck
```

## License

MIT
