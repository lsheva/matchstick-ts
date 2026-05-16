# matchstick-ts-example

Reference subgraph **and** the monorepo’s integration test suite. Copy this layout into your indexer; CI runs the same tests via `pnpm test` at the repo root.

## Layout

```
contracts/Counter.sol     # ValueSet(uint256) + setValue
schema.graphql            # Counter @entity
src/mapping.ts            # handleValueSet
subgraph.yaml
hardhat.config.ts         # hardhat-matchstick-ts plugin + matchstick { … }
integration/                  # Node test runner (not Matchstick)
  synthetic-events.test.ts   # fast — hand-built events, no chain
  hardhat-e2e.test.ts         # full — deploy, receipt, EventCapture
  helpers.ts
tests/                        # Matchstick-generated (gitignored)
  runner.test.ts
  .tmp/entities.d.ts
```

## Run

From the monorepo root:

```bash
pnpm test                 # matchstick-ts unit tests + all tests here
pnpm test:unit            # library unit tests only
pnpm test:integration     # this package only (pretest + all tests)
pnpm --filter matchstick-ts-example test:fast   # synthetic only (graph codegen, no compile)
pnpm --filter matchstick-ts-example test:e2e    # Hardhat path only
```

From this directory:

```bash
pnpm test
```

`pretest` runs `graph codegen` and `hardhat compile` so Matchstick can compile the mapping.

## What each test proves

| Test | Stack |
| --- | --- |
| `integration/synthetic-events.test.ts` | `runMatchstickTest`, `readsFor`, snapshot null/undefined semantics |
| `integration/hardhat-e2e.test.ts` | `hardhat-matchstick-ts/node`, `EventCapture`, `viewFunctionRevertMocks` |

Generated at runtime (gitignored): `tests/runner.test.ts`, `tests/.tmp/entities.d.ts`.
