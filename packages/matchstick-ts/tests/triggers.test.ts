import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CapturedEvent } from "../src/event-capture.ts";
import { buildTriggers } from "../src/triggers.ts";
import { generateRunner } from "../src/codegen/index.ts";
import { readSubgraphManifest } from "../src/codegen/parse-subgraph-manifest.ts";

const MANIFEST = "tests/fixtures/context/subgraph.yaml";
const ORACLE = "0x00000000000000000000000000000000000000b0";

function updated(blockNumber: number, logIndex: number): CapturedEvent {
  return {
    event: "Updated",
    address: ORACLE,
    dataSource: "Oracle",
    blockNumber,
    blockTimestamp: blockNumber * 12,
    logIndex,
    transactionHash: `0x${"ab".repeat(32)}`,
    params: [],
  };
}

describe("buildTriggers", () => {
  it("runs once handlers first and every-block handlers after each block's events", async () => {
    const manifest = await readSubgraphManifest(MANIFEST);
    const events = [updated(50, 0), updated(50, 1), updated(51, 0)];
    const triggers = buildTriggers(manifest, events);

    const summary = triggers.map((t) =>
      "trigger" in t ? `${t.handler}@${t.blockNumber}/${t.blockTimestamp}` : `${t.event}@${t.blockNumber}`,
    );
    assert.deepEqual(summary, [
      "initFeeds@50/600",
      "Updated@50",
      "Updated@50",
      "onBlock@50/600",
      "Updated@51",
      "onBlock@51/612",
    ]);
  });

  it("uses the bound address for block triggers, falling back to the manifest", async () => {
    const manifest = await readSubgraphManifest(MANIFEST);
    const [withEvents] = buildTriggers(manifest, [updated(50, 0)]);
    const [withoutEvents] = buildTriggers(manifest, []);

    assert.ok("trigger" in withEvents && "trigger" in withoutEvents);
    assert.equal(withEvents.address, ORACLE);
    assert.equal(withoutEvents.address, "0x0000000000000000000000000000000000000002");
    assert.equal(withoutEvents.blockNumber, 40);
  });

  it("prefers the bound address even when the data source has no captured events", async () => {
    const manifest = await readSubgraphManifest(MANIFEST);
    const bound = "0x00000000000000000000000000000000000000b1";
    const [once] = buildTriggers(manifest, [{ ...updated(50, 0), dataSource: "Aggregator" }], {
      Oracle: bound,
    });

    assert.ok("trigger" in once);
    assert.equal(once.dataSource, "Oracle");
    assert.equal(once.address, bound);
  });

  it("passes events through unchanged when no data source has block handlers", () => {
    const events = [updated(1, 0)];
    const manifest = {
      dataSources: [
        {
          name: "Oracle",
          source: { abi: "Oracle" },
          mapping: { file: "x.ts", eventHandlers: [] },
        },
      ],
    };
    assert.deepEqual(buildTriggers(manifest, events), events);
  });
});

describe("generateRunner: context, block handlers, templates", () => {
  async function generate(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ss-runner-context-"));
    try {
      const outputPath = join(dir, "runner.test.ts");
      await generateRunner({ subgraphYamlPath: MANIFEST, outputPath });
      return await readFile(outputPath, "utf8");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("builds each data source's manifest context", async () => {
    const text = await generate();
    assert.match(
      text,
      /context\.set\("feed", Value\.fromString\("0x00000000000000000000000000000000000000aa"\)\);/,
    );
    assert.match(text, /context\.set\("startBlock", Value\.fromBigInt\(BigInt\.fromString\("40"\)\)\);/);
    assert.match(text, /context\.set\("enabled", Value\.fromBoolean\(true\)\);/);
    assert.match(
      text,
      /context\.set\("weights", Value\.fromArray\(\[Value\.fromI32\(1\), Value\.fromI64\(9007199254740993\)\]\)\);/,
    );
  });

  it("routes block handlers and skips call filters", async () => {
    const text = await generate();
    assert.match(
      text,
      /dsName == "Oracle" && handler == "initFeeds"\) \{\s+dataSourceMock\.setReturnValues\(address, "base-sepolia", withContextOverrides\("Oracle", dataSourceContext0\(\)\)\);\s+initFeeds\(block\);/,
    );
    assert.match(text, /handler == "onBlock"/);
    assert.doesNotMatch(text, /handler == "onCall"/);
  });

  it("imports the event class each handler is declared with", async () => {
    const text = await generate();
    assert.match(text, /import \{ Updated as handleUpdatedEvent \} from "[^"]*generated\/Oracle\/Oracle";/);
    assert.match(
      text,
      /import \{ AnswerUpdated as handleAnswerUpdatedEvent \} from "[^"]*generated\/Oracle\/AggregatorProxy";/,
    );
    assert.match(
      text,
      /eventName == "AnswerUpdated" && \(dsName == "Aggregator" \|\| dsName == ""\)\) \{\s+dataSourceMock\.setReturnValues\(address, "base-sepolia", withContextOverrides\("Aggregator", dataSourceContext1\(\)\)\);/,
    );
  });
});
