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
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { runMatchstickTest, EventCapture, viewFunctionRevertMocks } from "matchstick-ts";
import { getOrCreateNode } from "hardhat-matchstick-ts/node";
import { matchstickRunOptionsFromConfig } from "hardhat-matchstick-ts";

describe("my flow", async () => {
  const node = await getOrCreateNode();
  const capture = new EventCapture(await node.conn.viem.getPublicClient());

  it("indexes events", async () => {
    // deploy, transact, then:
    await capture.captureFromReceipt(txHash, abi);

    const snap = await runMatchstickTest({
      events: capture.serialize(),
      reads: [{ entityType: "MyEntity", id: "0" }],
      revertMocks: viewFunctionRevertMocks(abi, address),
    });

    assert.equal(snap.get("MyEntity", "0", "field"), "expected");
  });

  after(() => node.close());
});
```

`runMatchstickTest` auto-codegen (default): writes `tests/runner.test.ts` and `tests/.tmp/entities.d.ts` before each run (idempotent).

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
