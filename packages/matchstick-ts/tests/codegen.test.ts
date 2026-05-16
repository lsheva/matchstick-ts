import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateEntities, generateRunner, writeIfChanged } from "../src/codegen/index.ts";

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
      assert.match(text, /readFile\("tests\/\.tmp\/events\.json"\)/);
      assert.match(text, /SNAPSHOT:/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
