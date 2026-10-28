import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateEntities, generateRunner, writeIfChanged } from "../src/codegen/index.ts";
import { fillTemplate } from "../src/codegen/generate-runner.ts";

describe("generateEntities", () => {
  it("emits a module-augmenting entities.d.ts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ss-entities-"));
    const outputPath = join(dir, "entities.d.ts");
    try {
      await generateEntities({
        schemaPath: "tests/fixtures/minimal-schema.graphql",
        outputPath,
        subgraphYamlPath: "tests/fixtures/subgraph.yaml",
      });
      const text = await readFile(outputPath, "utf8");
      assert.match(text, /import type \{\} from "matchstick-ts"/);
      assert.match(text, /declare module "matchstick-ts"/);
      assert.match(text, /interface Counter \{/);
      assert.match(text, /value: string;/);
      assert.match(text, /interface Entities \{/);
      assert.match(text, /Counter: Counter;/);
      assert.match(text, /interface DataSources \{/);
      assert.match(text, /Counter: Counter;/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("generateRunner", () => {
  it("emits a matchstick runner that reads JSON IO from tempDir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ss-runner-"));
    const outputPath = join(dir, "runner.test.ts");
    try {
      await generateRunner({
        subgraphYamlPath: "tests/fixtures/subgraph.yaml",
        outputPath,
        tempDir: "tests/.tmp",
      });
      const text = await readFile(outputPath, "utf8");
      assert.match(text, /handleValueSet/);
      assert.match(text, /ValueSet/);
      assert.match(text, /const TEMP_DIR = "tests\/\.tmp";/);
      assert.match(text, /readFile\(TEMP_DIR \+ "\/events\.json"\)/);
      assert.match(text, /SNAPSHOT:/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dispatches mock entries by kind (revert vs return)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ss-runner-mocks-"));
    const outputPath = join(dir, "runner.test.ts");
    try {
      await generateRunner({
        subgraphYamlPath: "tests/fixtures/subgraph.yaml",
        outputPath,
        tempDir: "tests/.tmp",
      });
      const text = await readFile(outputPath, "utf8");
      assert.match(text, /stringField\(m, "kind"\)/);
      assert.match(text, /kind == "return"/);
      assert.match(text, /m\.get\("outputs"\)/);
      assert.match(text, /m\.get\("returns"\)/);
      assert.match(text, /ethereumValueFromTypedJson\(/);
      assert.match(text, /\.returns\(values\)/);
      assert.match(text, /\.reverts\(\)/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forwards per-event transactionHash/blockNumber/logIndex/address/blockTimestamp into createMockEvent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ss-runner-fields-"));
    const outputPath = join(dir, "runner.test.ts");
    try {
      await generateRunner({
        subgraphYamlPath: "tests/fixtures/subgraph.yaml",
        outputPath,
        tempDir: "tests/.tmp",
      });
      const text = await readFile(outputPath, "utf8");
      assert.match(text, /stringField\(evt, "transactionHash"\)/);
      assert.match(text, /intField\(evt, "blockNumber"\)/);
      assert.match(text, /intField\(evt, "logIndex"\)/);
      assert.match(text, /intField\(evt, "blockTimestamp"\)/);
      assert.match(
        text,
        /createMockEvent<handleValueSetEvent>\(params, txHash, blockNum, logIndex, address, blockTimestamp\)/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("fillTemplate", () => {
  const template = [
    "before",
    "// #region generated:a",
    "stub a",
    "// #endregion",
    "middle",
    "// #region generated:b",
    "// #endregion",
    "after",
  ].join("\n");

  it("replaces only region bodies, keeping the markers", () => {
    assert.equal(
      fillTemplate(template, { a: "real a", b: "line 1\nline 2\n" }),
      [
        "before",
        "// #region generated:a",
        "real a",
        "// #endregion",
        "middle",
        "// #region generated:b",
        "line 1",
        "line 2",
        "// #endregion",
        "after",
      ].join("\n"),
    );
  });

  it("rejects missing and unknown regions", () => {
    assert.throws(() => fillTemplate(template, { a: "" }), /no replacement for region "b"/);
    assert.throws(() => fillTemplate(template, { a: "", b: "", c: "" }), /no region "c"/);
  });
});

describe("writeIfChanged", () => {
  it("skips writes when content is unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ss-write-"));
    const path = join(dir, "out.txt");
    try {
      const first = await writeIfChanged(path, "hello");
      const second = await writeIfChanged(path, "hello");
      assert.equal(first, true);
      assert.equal(second, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
