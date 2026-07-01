/**
 * `loadSubgraphYaml` unit tests + one round-trip integration test
 * that loads the example manifest and feeds the result straight
 * into `Subgraph.create({...})`.
 *
 * Coverage:
 *   - example/subgraph.yaml parses into the expected DataSourceSpec
 *   - relative ABI / mapping.file paths resolve against the manifest's
 *     directory
 *   - eventHandlers' canonical-form signatures map back to AbiEvent
 *     names (handles `(indexed type)` + named-param spellings)
 *   - missing required fields raise `ManifestParseError` with a
 *     reference to the offending dataSource
 *   - manifest output drives `Subgraph.create` end-to-end
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  loadSubgraphYaml,
  ManifestParseError,
} from "../src/load-yaml.ts";
import { Subgraph } from "../src/subgraph-runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_YAML = resolve(here, "../../example/subgraph.yaml");
const BUNDLE_WASM = resolve(here, "../build/example-bundle.wasm");

test("loadSubgraphYaml: parses the example manifest", async () => {
  if (!existsSync(EXAMPLE_YAML)) {
    return; // example package not present — skip
  }
  const manifest = await loadSubgraphYaml(EXAMPLE_YAML);
  assert.equal(manifest.specVersion, "1.0.0");
  assert.equal(manifest.dataSources.length, 1);
  assert.equal(
    manifest.schemaFile,
    resolve(dirname(EXAMPLE_YAML), "schema.graphql"),
  );

  const ds = manifest.dataSources[0];
  // Address is lower-cased.
  assert.equal(ds.address, "0x0000000000000000000000000000000000000001");
  assert.ok(Array.isArray(ds.abi));
  assert.ok(
    ds.abi.some((item) => item.type === "event" && item.name === "ValueSet"),
    "Counter ABI should expose the ValueSet event",
  );
  // Canonical sig "ValueSet(uint256)" maps back to AbiEvent name "ValueSet".
  assert.deepEqual(
    ds.eventHandlers.find((h) => h.handler === "handleValueSet"),
    { event: "ValueSet", handler: "handleValueSet" },
  );
  assert.deepEqual(
    ds.eventHandlers.find((h) => h.handler === "handleSignedValueSet"),
    { event: "SignedValueSet", handler: "handleSignedValueSet" },
  );

  // mapping.file (the AS source) is resolved to an absolute path.
  assert.equal(
    manifest.mappingEntries[0],
    resolve(dirname(EXAMPLE_YAML), "src/mapping.ts"),
  );
});

test("loadSubgraphYaml: drives Subgraph.create end-to-end", async (t) => {
  if (!existsSync(EXAMPLE_YAML) || !existsSync(BUNDLE_WASM)) {
    t.skip("example yaml or bundle missing");
    return;
  }
  const manifest = await loadSubgraphYaml(EXAMPLE_YAML);
  // The example yaml uses a placeholder address; override it to
  // match the wasm scaffold's default `event.address` so the
  // mockCall the handler reads through does the same thing
  // subgraph.test.ts asserts.
  const subgraph = await Subgraph.create({
    bundle: BUNDLE_WASM,
    dataSources: manifest.dataSources,
  });
  await subgraph.fire({
    dataSource: 0,
    eventName: "ValueSet",
    params: { newValue: 42n },
  });
  const counter = subgraph.entity("Counter", "0");
  assert.ok(counter);
  assert.equal(counter.value, 42n);
});

test("loadSubgraphYaml: missing dataSources -> ManifestParseError", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "yaml-loader-"));
  const path = resolve(dir, "subgraph.yaml");
  writeFileSync(
    path,
    "specVersion: 0.0.5\nschema:\n  file: ./schema.graphql\n",
  );
  await assert.rejects(
    () => loadSubgraphYaml(path),
    (err: Error) =>
      err instanceof ManifestParseError && /no dataSources/.test(err.message),
  );
});

test("loadSubgraphYaml: malformed address -> ManifestParseError", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "yaml-loader-"));
  // Write a minimal-but-bad yaml + ABI alongside it.
  writeFileSync(
    resolve(dir, "abi.json"),
    JSON.stringify([
      {
        type: "event",
        name: "Pinged",
        inputs: [{ name: "n", type: "uint256", indexed: false }],
        anonymous: false,
      },
    ]),
  );
  writeFileSync(
    resolve(dir, "mapping.ts"),
    "export function handlePinged(): void {}\n",
  );
  writeFileSync(
    resolve(dir, "subgraph.yaml"),
    `specVersion: 1.0.0
schema:
  file: ./schema.graphql
dataSources:
  - kind: ethereum
    name: Bad
    network: mainnet
    source:
      address: "0xNOT_HEX"
      abi: Bad
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.9
      language: wasm/assemblyscript
      file: ./mapping.ts
      entities: [X]
      abis:
        - name: Bad
          file: ./abi.json
      eventHandlers:
        - event: Pinged(uint256)
          handler: handlePinged
`,
  );
  await assert.rejects(
    () => loadSubgraphYaml(resolve(dir, "subgraph.yaml")),
    (err: Error) =>
      err instanceof ManifestParseError &&
      /not a 20-byte hex string/.test(err.message),
  );
});

test("loadSubgraphYaml: unknown event signature -> ManifestParseError", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "yaml-loader-"));
  writeFileSync(
    resolve(dir, "abi.json"),
    JSON.stringify([
      {
        type: "event",
        name: "Pinged",
        inputs: [{ name: "n", type: "uint256", indexed: false }],
        anonymous: false,
      },
    ]),
  );
  writeFileSync(
    resolve(dir, "mapping.ts"),
    "export function handlePonged(): void {}\n",
  );
  writeFileSync(
    resolve(dir, "subgraph.yaml"),
    `specVersion: 1.0.0
schema:
  file: ./schema.graphql
dataSources:
  - kind: ethereum
    name: Mismatch
    network: mainnet
    source:
      address: "0x0000000000000000000000000000000000000099"
      abi: A
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.9
      language: wasm/assemblyscript
      file: ./mapping.ts
      entities: [X]
      abis:
        - name: A
          file: ./abi.json
      eventHandlers:
        - event: Ponged(uint256)
          handler: handlePonged
`,
  );
  await assert.rejects(
    () => loadSubgraphYaml(resolve(dir, "subgraph.yaml")),
    (err: Error) =>
      err instanceof ManifestParseError &&
      /event "Ponged\(uint256\)" not found/.test(err.message),
  );
});

test("loadSubgraphYaml: accepts named params + indexed flavor in eventHandlers", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "yaml-loader-"));
  writeFileSync(
    resolve(dir, "abi.json"),
    JSON.stringify([
      {
        type: "event",
        name: "Transfer",
        inputs: [
          { name: "from", type: "address", indexed: true },
          { name: "to", type: "address", indexed: true },
          { name: "value", type: "uint256", indexed: false },
        ],
        anonymous: false,
      },
    ]),
  );
  writeFileSync(
    resolve(dir, "mapping.ts"),
    "export function handleTransfer(): void {}\n",
  );
  writeFileSync(
    resolve(dir, "subgraph.yaml"),
    `specVersion: 1.0.0
schema:
  file: ./schema.graphql
dataSources:
  - kind: ethereum
    name: ERC20
    network: mainnet
    source:
      address: "0x000000000000000000000000000000000000aaaa"
      abi: ERC20
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.9
      language: wasm/assemblyscript
      file: ./mapping.ts
      entities: [X]
      abis:
        - name: ERC20
          file: ./abi.json
      eventHandlers:
        - event: Transfer(indexed address, indexed address, uint256)
          handler: handleTransfer
`,
  );
  const manifest = await loadSubgraphYaml(resolve(dir, "subgraph.yaml"));
  assert.equal(manifest.dataSources[0].eventHandlers[0].event, "Transfer");
});
