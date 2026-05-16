# Counter example

Minimal subgraph that demonstrates **subgraph-snapshot** end to end:

1. Deploy `Counter` on an in-process Hardhat node
2. Call `setValue` and capture `ValueSet` with `EventCapture`
3. Replay through Matchstick via `runMatchstickTest` (auto-codegen for runner + `entities.d.ts`)
4. Assert on the indexed `Counter` entity in TypeScript

## Run

From this directory:

```bash
pnpm install
pnpm test
```

`pretest` runs `hardhat compile` and `graph codegen` so mapping types exist before Matchstick runs.

From the package root:

```bash
pnpm test:example
```
