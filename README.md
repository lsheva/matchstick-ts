# subgraph-snapshot

Typed snapshot testing for The Graph subgraphs via Matchstick.

Replays captured EVM events through your mapping handlers inside Matchstick,
dumps the resulting store entities as JSON, and hands your test a fully typed
`Snapshot<Entities>` so all assertions stay in idiomatic TypeScript
(`node:assert/strict`, vitest, jest — your pick, no lock-in).

## Why

`graph test` (Matchstick) is the only WASM runner for AssemblyScript mappings,
but writing assertions inside AS is painful: no `BigInt` comparisons, no deep
equality, no snapshot diffing, no rich matchers. This package keeps the AS
runner minimal — it just dumps requested entities — and moves every assertion
into TS where the tooling is mature.

It also generates a typed `Entities` interface from your `schema.graphql`
(emitted as a `.d.ts` that augments this package — Hardhat
`artifacts.d.ts`-style), so `snap.get("Futures", "0", "orderFee")`
autocompletes the entity name, the field name, and types the return value —
without any `import type` in your test.

## Install

```bash
pnpm add -D subgraph-snapshot
```

From GitHub (before npm publish):

```bash
pnpm add -D github:lsheva/subgraph-snapshot
```

## Tests

This package includes:

- **Unit tests** (`tests/`) — codegen output shape, `Snapshot` accessors, `writeIfChanged`.
- **Example subgraph** (`examples/counter/`) — minimal Hardhat + Matchstick project that
  uses the library like a consumer would. Run from the repo root:

  ```bash
  pnpm test              # unit + example
  pnpm test:unit         # unit only
  pnpm test:example      # example only
  ```

Peer deps (already installed if you have a working subgraph indexer):
`@graphprotocol/graph-ts`, `matchstick-as`, `viem`.

For the Hardhat 3 node helper (optional): `hardhat`,
`@nomicfoundation/hardhat-viem`, `@nomicfoundation/hardhat-network-helpers`.

## Quick start

### 1. Add a single test script

```json
{
  "scripts": {
    "test:integration": "node --test integration/*.test.ts"
  }
}
```

That's it — no `pretest` step. `runMatchstickTest` auto-generates both
artifacts on every call (idempotent, see [Auto-codegen](#auto-codegen)):

- `tests/runner.test.ts` — the AS matchstick runner.
- `tests/.tmp/entities.d.ts` — the typed `Entities` interface, as a
  `.d.ts` that augments this package.

Both paths are configurable. The `.d.ts` is never loaded at runtime, only
seen by tsserver/tsc — exactly like Hardhat's `artifacts.d.ts`.

### 2. Write a test

```ts
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { runMatchstickTest, readsFor, EventCapture, viewFunctionRevertMocks } from "subgraph-snapshot";
import { getOrCreateNode } from "subgraph-snapshot/hardhat";

describe("MyContract integration", async () => {
  const node = await getOrCreateNode();
  const capture = new EventCapture(await node.conn.viem.getPublicClient());

  it("indexes orderFee updates", async () => {
    // 1. Trigger transactions on Hardhat / anvil / whatever
    const txHash = await futures.write.setOrderFee([12345n], { account: owner });

    // 2. Capture emitted events
    await capture.captureFromReceipt(txHash, futures.abi);

    // 3. Replay through Matchstick, dump requested entities — no type import,
    //    no generic; the augmented `Entities` interface flows through.
    const snap = await runMatchstickTest({
      events: capture.serialize(),
      reads: [{ entityType: "Futures", id: "0" }],
      revertMocks: viewFunctionRevertMocks(futures.abi, futures.address),
    });

    // 4. Assert in plain TS — full autocomplete + per-field types
    assert.equal(snap.get("Futures", "0", "orderFee"), "12345");

    const futures_ = snap.entity("Futures", "0");
    assert.ok(futures_);
    assert.equal(futures_.orderFee, "12345");
    assert.equal(futures_.totalUsers, 0);
  });

  after(() => node.close());
});
```

### 3. Gitignore the generated artifacts

```gitignore
tests/runner.test.ts
tests/.tmp/
```

### 4. Make sure the augmenting `.d.ts` is visible to tsserver

`tests/.tmp/entities.d.ts` must be loaded by the same TypeScript project
as your test files for the `Entities` augmentation to flow.

- If you have a TS-side `tsconfig.json` covering your tests, ensure its
  `include` reaches `tests/.tmp/**/*.d.ts` (or just `tests/**/*`).
- If your project also has an AssemblyScript tsconfig that includes
  `tests/`, exclude `tests/.tmp` from it so the AS compiler doesn't
  try to parse the augmentation:

  ```json
  { "exclude": ["node_modules", "generated", "build", "tests/.tmp"] }
  ```

- Prefer a different location? Set `typesPath` on `runMatchstickTest`:

  ```ts
  await runMatchstickTest({ typesPath: "types/subgraph-snapshot.d.ts", ... });
  ```

## Auto-codegen

`runMatchstickTest` runs the runner + entities generators in-process on
every call, then writes only if the output content has changed. Result:

- **Fresh checkouts work without any pre-step** — clone, run the test,
  done. Schema changes propagate to types on the next test invocation.
- **Matchstick's WASM cache stays warm** — files aren't touched when
  unchanged, so AS doesn't recompile, and tsserver doesn't re-index.
- **CI is a single command** — no `pretest`, no codegen step before tests.

If you'd rather drive codegen externally (e.g., gated on a `git diff` of
the schema in CI), set `autoCodegen: false` and call the
[`subgraph-snapshot` CLI](#cli) yourself.

## API

### Core (`subgraph-snapshot`)

- `runMatchstickTest(options): Promise<Snapshot>` — auto-generates the AS
  runner + entities `.d.ts`, runs `graph test`, parses the `SNAPSHOT:` line,
  returns the typed wrapper. The default generic is the augmented
  `Entities` interface; pass an explicit `<T>` to override.

  Options (all optional):
  - `jsonDir` — JSON IO scratch dir. Default `tests/.tmp`.
  - `subgraphYaml` — manifest path for runner codegen. Default `subgraph.yaml`.
  - `schemaPath` — schema path for entities codegen. Default `schema.graphql`.
  - `runnerPath` — AS runner output. Default `tests/runner.test.ts`.
  - `typesPath` — augmenting `.d.ts` output. Default `tests/.tmp/entities.d.ts`.
  - `autoCodegen` — set to `false` to skip in-process codegen. Default `true`.
  - `cleanup` — remove JSON IO after the run. Default `true` (`KEEP_TEMP=1` overrides).
- `Snapshot<TEntities>` — `entity(type, id)`, `get(type, id, field)`,
  `ids(type)`, `count(type)`, `requested(type, id)`, `has(type, id)`, plus
  `.raw` for escape-hatch access.
- `readsFor<TEntities>(type, ids[])` — sugar for expanding `(type, ids[])` into
  `EntityRef[]`. Composes via spread.
- `interface Entities {}` — augmentation target; the generated `.d.ts` re-opens
  this with one property per entity in your schema.
- `EventCapture` + `viewFunctionRevertMocks` — viem-based event capture and
  auto-generated reverting mocks for 0-arg view functions on a contract ABI.

### Hardhat helper (`subgraph-snapshot/hardhat`)

- `getOrCreateNode() / createNode()` — spawns an in-process Hardhat 3
  JSON-RPC server using the consumer's `hardhat.config.ts`. Opt-in subpath so
  anvil/foundry users don't pull hardhat as a transitive dep.

### Codegen (`subgraph-snapshot/codegen`)

Programmatic access to the generators. You don't need these when
`autoCodegen: true` (the default) — only reach for them if you want to
drive codegen from a script or CI step.

- `generateRunner({ subgraphYamlPath, outputPath, assemblyImport?, tempDir? })`
  — `tempDir` defaults to `tests/.tmp`; must match `RunOptions.jsonDir`.
- `generateEntities({ schemaPath, outputPath, moduleSpecifier? })`
  — emits a `.d.ts` that augments `subgraph-snapshot`'s `Entities` interface.
  `moduleSpecifier` (default `"subgraph-snapshot"`) only needs to change if
  you've installed the package under a different name.
- `writeIfChanged(path, contents)` — helper used by both generators; only
  touches the file when the contents differ.

### CLI

```
subgraph-snapshot generate-runner   <subgraph.yaml>  <output.test.ts>  [--assembly <spec>] [--temp-dir <path>]
subgraph-snapshot generate-entities <schema.graphql> <output.d.ts>     [--module-specifier <name>]
```

Optional with `autoCodegen: true` — retained for explicit / CI-driven workflows.

### AssemblyScript runtime (`subgraph-snapshot/assembly`)

Imported only by the generated `runner.test.ts`. Exposes the JSON serializer
(`entityToJson`, `valueToJson`, `JSONObjectBuilder`), the mock-event factory
(`createMockEvent`), and the sugar constructors (`address`, `uint`, `int`,
`bytes`, `bool`).

## Snapshot semantics

- Asked-and-found → entity object
- Asked-and-not-found → `null`
- Not-in-the-reads-list → `undefined`

Use `requested(type, id)` to disambiguate. Use `KEEP_TEMP=1` to keep
`events.json` / `reads.json` / `mocks.json` after a run for debugging.

## Type mapping (schema.graphql → TS)

| GraphQL                          | TS        |
| -------------------------------- | --------- |
| `ID` / `String` / `Bytes`        | `string`  |
| `BigInt` / `BigDecimal`          | `string`  |
| `Int8` / `Timestamp`             | `string`  |
| `Int`                            | `number`  |
| `Boolean`                        | `boolean` |
| Enum                             | string union |
| `User!` (entity reference)       | type of `User.id`        |
| `[T!]!`                          | `T[]`     |
| Nullable (no `!`)                | `T \| null` |
| `@derivedFrom`                   | omitted (not stored)     |

Precision-sensitive scalars come back as JSON strings because JS `Number` can't
represent `i64` or arbitrary-precision integers safely.
