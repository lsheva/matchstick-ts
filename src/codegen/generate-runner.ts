/**
 * Generate the AssemblyScript matchstick runner test file from a
 * subgraph manifest.
 *
 * The runner is a single matchstick test that:
 *   1. Reads `events.json` written by `runMatchstickTest`.
 *   2. Routes each event by name to the registered handler.
 *   3. Reads `reads.json` (list of `(entityType, id)` pairs) and dumps
 *      every requested entity as a structured `SNAPSHOT: {...}` line.
 *
 * Handler imports are grouped by mapping file (each data source's
 * `mapping.file`) so multi-mapping subgraphs work without modification.
 */
import { readFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { parse } from "yaml";
import { writeIfChanged } from "./_shared.ts";

interface DataSource {
  name: string;
  source: { abi: string };
  mapping: {
    file: string;
    eventHandlers: { event: string; handler: string }[];
  };
}

interface SubgraphManifest {
  dataSources: DataSource[];
}

/**
 * Convert a mapping file path (as it appears in subgraph.yaml, relative to
 * the manifest) into a TS-style import specifier relative to the generated
 * runner file. Strips `.ts` / `.js` extensions because AS imports omit them.
 */
function mappingImportSpecifier(outputPath: string, mappingFilePath: string): string {
  const fromDir = dirname(outputPath);
  const rel = relative(fromDir, mappingFilePath);
  const noExt = rel.replace(/\.(ts|js)$/, "");
  // Force a leading "./" for sibling/child paths so AS treats it as relative.
  if (noExt.startsWith(".")) return noExt;
  return `./${noExt}`;
}

export interface GenerateRunnerOptions {
  /** Path to the subgraph manifest (e.g., "subgraph.yaml"). */
  subgraphYamlPath: string;
  /** Output path for the generated AS runner (e.g., "tests/runner.test.ts"). */
  outputPath: string;
  /**
   * AS module specifier that exports `createMockEvent`, `JSONObjectBuilder`,
   * `entityToJson`. Defaults to `subgraph-snapshot/assembly` — override if
   * you've installed the package under a different name.
   */
  assemblyImport?: string;
  /**
   * Directory (relative to the subgraph root) where the orchestrator will
   * write `events.json` / `reads.json` / `mocks.json` and the AS runner will
   * read them from. Defaults to `tests/.tmp` — must match
   * `RunOptions.jsonDir` in the consumer test.
   */
  tempDir?: string;
}

export const DEFAULT_TMP_DIR = "tests/.tmp";

export async function generateRunner(options: GenerateRunnerOptions): Promise<void> {
  const { subgraphYamlPath, outputPath } = options;
  const assemblyImport = options.assemblyImport ?? "subgraph-snapshot/assembly";
  const tempDir = options.tempDir ?? DEFAULT_TMP_DIR;

  const yaml = parse(await readFile(subgraphYamlPath, "utf8")) as SubgraphManifest;

  // Group handler imports by mapping file (relative to manifest), and event
  // types by ABI name. Preserve insertion order for stable output.
  const handlersByFile = new Map<string, Set<string>>();
  const eventTypesByAbi = new Map<string, Set<string>>();
  const routes: string[] = [];

  for (const ds of yaml.dataSources) {
    const abi = ds.source.abi;
    if (!eventTypesByAbi.has(abi)) eventTypesByAbi.set(abi, new Set());

    const mappingFile = ds.mapping.file;
    if (!handlersByFile.has(mappingFile)) handlersByFile.set(mappingFile, new Set());

    for (const eh of ds.mapping.eventHandlers) {
      const handlerName = eh.handler;
      const eventMatch = eh.event.match(/^(\w+)\(/);
      const eventName = eventMatch ? eventMatch[1] : eh.event;

      handlersByFile.get(mappingFile)!.add(handlerName);
      eventTypesByAbi.get(abi)!.add(eventName);
      routes.push(`    } else if (eventName == "${eventName}") {
      ${handlerName}(createMockEvent<${eventName}>(params));`);
    }
  }

  // Resolve each mapping file path relative to the manifest's directory,
  // then express it as an import specifier relative to the runner output.
  const manifestDir = dirname(subgraphYamlPath);
  const handlerImportLines: string[] = [];
  for (const [file, handlerSet] of handlersByFile) {
    const handlerList = [...handlerSet].sort().join(", ");
    const absMapping = relative(".", `${manifestDir}/${file}`);
    const specifier = mappingImportSpecifier(outputPath, absMapping);
    handlerImportLines.push(`import { ${handlerList} } from "${specifier}";`);
  }

  const eventTypeImportLines: string[] = [];
  for (const [abi, types] of eventTypesByAbi) {
    const sortedTypes = [...types].sort();
    eventTypeImportLines.push(
      `import { ${sortedTypes.join(", ")} } from "../generated/${abi}/${abi}";`,
    );
  }

  const code = `import { test, clearStore, readFile, createMockedFunction, dataSourceMock } from "matchstick-as/assembly/index";
import { Address, json, log, store } from "@graphprotocol/graph-ts";
import { createMockEvent, JSONObjectBuilder, entityToJson } from "${assemblyImport}";
${handlerImportLines.join("\n")}
${eventTypeImportLines.join("\n")}

test("process events and dump store snapshot", () => {
  clearStore();

  const eventsRaw = readFile("${tempDir}/events.json");
  const events = json.fromBytes(eventsRaw).toArray();

  // Point dataSource.address() at the real contract address from the first
  // captured event so handler-bound contract calls hit the mocks below.
  if (events.length > 0) {
    const firstAddr = events[0].toObject().get("address")!.toString();
    dataSourceMock.setAddress(firstAddr);
  }

  // Install revert-mocks for all view-call reads handlers may perform.
  // The handlers wrap these in \`try_*\`, so reverts resolve gracefully and
  // Matchstick stops complaining about unmocked functions.
  const mocksRaw = readFile("${tempDir}/mocks.json");
  const mocks = json.fromBytes(mocksRaw).toArray();
  for (let i = 0; i < mocks.length; i++) {
    const m = mocks[i].toObject();
    const addr = Address.fromString(m.get("address")!.toString());
    const name = m.get("name")!.toString();
    const sig = m.get("signature")!.toString();
    createMockedFunction(addr, name, sig).reverts();
  }

  for (let i = 0; i < events.length; i++) {
    const evt = events[i].toObject();
    const eventName = evt.get("event")!.toString();
    const params = evt.get("params")!.toObject();

    if (false) {
${routes.join("\n")}
    }
  }

  // Read the list of (entityType, id) pairs to dump and emit a nested JSON
  // snapshot: { [entityType]: { [id]: { ...fields } | null } }
  // Missing entities are emitted as \`null\` so the orchestrator can distinguish
  // "asked but not found" from "didn't ask".
  const readsRaw = readFile("${tempDir}/reads.json");
  const reads = json.fromBytes(readsRaw).toArray();

  // Group reads by entity type for compact nested output.
  const byType = new Map<string, JSONObjectBuilder>();
  const typeOrder: Array<string> = [];

  for (let i = 0; i < reads.length; i++) {
    const r = reads[i].toObject();
    const entityType = r.get("entityType")!.toString();
    const id = r.get("id")!.toString();

    if (!byType.has(entityType)) {
      byType.set(entityType, new JSONObjectBuilder());
      typeOrder.push(entityType);
    }

    const entity = store.get(entityType, id);
    const value = entity ? entityToJson(entity) : "null";
    byType.get(entityType)!.setRaw(id, value);
  }

  const outer = new JSONObjectBuilder();
  for (let i = 0; i < typeOrder.length; i++) {
    const t = typeOrder[i];
    outer.setRaw(t, byType.get(t)!.toString());
  }

  log.info("SNAPSHOT: " + outer.toString(), []);
});
`;

  await writeIfChanged(outputPath, code);
}
