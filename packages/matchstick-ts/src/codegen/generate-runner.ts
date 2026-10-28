/**
 * Generate the AssemblyScript matchstick runner test file from a
 * subgraph manifest.
 *
 * The runner is a single matchstick test that:
 *   1. Reads `events.json` written by `runMatchstickTest` — captured events
 *      interleaved with block-handler triggers (see `buildTriggers`).
 *   2. Routes each trigger to its handler, after pointing `dataSource.address()`
 *      / `.network()` / `.context()` at the data source it belongs to.
 *   3. Reads `reads.json` (list of `(entityType, id)` pairs) and dumps
 *      every requested entity as a structured `SNAPSHOT: {...}` line.
 *
 * Handler imports are grouped by mapping file (each data source's
 * `mapping.file`) so multi-mapping subgraphs work without modification.
 * Templates are routed like data sources; their context is empty because
 * contexts passed to `createWithContext` at runtime are not tracked.
 */
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { readSubgraphManifest, type ContextEntry } from "./parse-subgraph-manifest.ts";
import { writeIfChanged } from "./_shared.ts";

/**
 * Express a module path (relative to the cwd, with or without extension)
 * as an AS import specifier relative to the generated runner file.
 */
function importSpecifier(outputPath: string, modulePath: string): string {
  const rel = relative(dirname(outputPath), modulePath);
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
   * `entityToJson`. Defaults to `matchstick-ts/assembly` — override if
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

/** AS expression building a `Value` for one manifest `context:` entry. */
function contextValueExpr(entry: ContextEntry, path: string): string {
  const data = entry.data;
  switch (entry.type) {
    case "String":
      return `Value.fromString(${JSON.stringify(String(data))})`;
    case "Bool":
    case "Boolean":
      return `Value.fromBoolean(${data === true || data === "true"})`;
    case "Int":
      return `Value.fromI32(${Number(data)})`;
    case "Int8":
      return `Value.fromI64(${BigInt(String(data))})`;
    case "BigInt":
      return `Value.fromBigInt(BigInt.fromString(${JSON.stringify(String(data))}))`;
    case "BigDecimal":
      return `Value.fromBigDecimal(BigDecimal.fromString(${JSON.stringify(String(data))}))`;
    case "Bytes":
      return `Value.fromBytes(Bytes.fromHexString(${JSON.stringify(String(data))}))`;
    case "List": {
      if (!Array.isArray(data)) {
        throw new Error(`generateRunner: context entry ${path} is a List but its data is not an array`);
      }
      const items = (data as ContextEntry[]).map((item, i) => contextValueExpr(item, `${path}[${i}]`));
      return `Value.fromArray([${items.join(", ")}])`;
    }
    default:
      throw new Error(`generateRunner: unsupported context type "${entry.type}" for ${path}`);
  }
}

interface EventType {
  /** Name exported by `module`. */
  exported: string;
  /** cwd-relative module path, or a bare package specifier when `bare`. */
  module: string;
  bare: boolean;
}

const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

/**
 * The event class a handler's parameter is declared with, resolved through
 * the mapping file's imports. The runner must pass exactly that class:
 * AssemblyScript classes are nominal, so a template's `AnswerUpdated` is not
 * assignable to the same event generated under a data source's ABI.
 */
function handlerEventType(mappingPath: string, source: string, handler: string): EventType | undefined {
  const signature = source.match(
    new RegExp(`export\\s+function\\s+${handler}\\s*\\(\\s*\\w+\\s*:\\s*(\\w+)`),
  );
  if (!signature) return undefined;
  const local = signature[1];

  for (const [, specifiers, from] of source.matchAll(IMPORT_RE)) {
    for (const specifier of specifiers.split(",")) {
      const [exported, alias] = specifier.trim().split(/\s+as\s+/);
      if ((alias ?? exported) !== local) continue;
      if (!from.startsWith(".")) return { exported, module: from, bare: true };
      return { exported, module: relative(".", resolve(dirname(mappingPath), from)), bare: false };
    }
  }
  return undefined;
}

export async function generateRunner(options: GenerateRunnerOptions): Promise<void> {
  const { subgraphYamlPath, outputPath } = options;
  const assemblyImport = options.assemblyImport ?? "matchstick-ts/assembly";
  const tempDir = options.tempDir ?? DEFAULT_TMP_DIR;

  const yaml = await readSubgraphManifest(subgraphYamlPath);
  const manifestDir = dirname(subgraphYamlPath);
  const sources = [
    ...yaml.dataSources.map((ds) => ({ ds, template: false })),
    ...(yaml.templates ?? []).map((ds) => ({ ds, template: true })),
  ];

  const mappingSources = new Map<string, string | undefined>();
  async function mappingSource(path: string): Promise<string | undefined> {
    if (!mappingSources.has(path)) {
      mappingSources.set(path, await readFile(path, "utf8").catch(() => undefined));
    }
    return mappingSources.get(path);
  }

  // Preserve insertion order for stable output.
  const handlersByFile = new Map<string, Set<string>>();
  const eventTypeImports = new Map<string, string[]>();
  const contextFunctions: string[] = [];
  const eventRoutes: string[] = [];
  const blockRoutes: string[] = [];
  const firstOwner = new Map<string, string>();

  for (let i = 0; i < sources.length; i++) {
    const { ds, template } = sources[i];
    const mappingPath = relative(".", `${manifestDir}/${ds.mapping.file}`);
    if (!handlersByFile.has(mappingPath)) handlersByFile.set(mappingPath, new Set());
    const handlers = handlersByFile.get(mappingPath)!;

    const contextFn = `dataSourceContext${i}`;
    const contextLines = Object.entries(ds.context ?? {}).map(
      ([key, entry]) =>
        `  context.set(${JSON.stringify(key)}, ${contextValueExpr(entry, `${ds.name}.context.${key}`)});`,
    );
    contextFunctions.push(
      `function ${contextFn}(): DataSourceContext {\n  const context = new DataSourceContext();\n${contextLines.map((l) => `${l}\n`).join("")}  return context;\n}`,
    );
    const setDataSource = `dataSourceMock.setReturnValues(address, ${JSON.stringify(ds.network ?? "mainnet")}, ${contextFn}());`;
    const dsName = JSON.stringify(ds.name);

    for (const eh of ds.mapping.eventHandlers ?? []) {
      const eventMatch = eh.event.match(/^(\w+)\(/);
      const eventName = eventMatch ? eventMatch[1] : eh.event;
      handlers.add(eh.handler);

      const source = await mappingSource(mappingPath);
      // `graph codegen` writes to ./generated by default.
      const resolved =
        source === undefined ? undefined : handlerEventType(mappingPath, source, eh.handler);
      const eventType = resolved ?? {
        exported: eventName,
        module: template
          ? `generated/templates/${ds.name}/${ds.source.abi}`
          : `generated/${ds.source.abi}/${ds.source.abi}`,
        bare: false,
      };
      const alias = `${eh.handler}Event`;
      const specifier = eventType.bare ? eventType.module : importSpecifier(outputPath, eventType.module);
      if (!eventTypeImports.has(specifier)) eventTypeImports.set(specifier, []);
      const names = eventTypeImports.get(specifier)!;
      const importName = `${eventType.exported} as ${alias}`;
      if (!names.includes(importName)) names.push(importName);

      // Events captured without a data source go to the first one handling them.
      if (!firstOwner.has(eventName)) firstOwner.set(eventName, ds.name);
      const dsMatch =
        firstOwner.get(eventName) === ds.name
          ? `(dsName == ${dsName} || dsName == "")`
          : `dsName == ${dsName}`;
      eventRoutes.push(`    } else if (eventName == "${eventName}" && ${dsMatch}) {
      ${setDataSource}
      ${eh.handler}(createMockEvent<${alias}>(params, txHash, blockNum, logIndex, address, blockTimestamp));`);
    }

    for (const bh of template ? [] : ds.mapping.blockHandlers ?? []) {
      const kind = bh.filter?.kind;
      if (kind !== undefined && kind !== "once") continue;
      handlers.add(bh.handler);
      blockRoutes.push(`      } else if (dsName == ${dsName} && handler == "${bh.handler}") {
        ${setDataSource}
        ${bh.handler}(block);`);
    }
  }

  const handlerImportLines: string[] = [];
  for (const [file, handlerSet] of handlersByFile) {
    if (handlerSet.size === 0) continue;
    const handlerList = [...handlerSet].sort().join(", ");
    handlerImportLines.push(`import { ${handlerList} } from "${importSpecifier(outputPath, file)}";`);
  }

  const eventTypeImportLines = [...eventTypeImports].map(
    ([specifier, names]) => `import { ${names.join(", ")} } from "${specifier}";`,
  );

  const code = `import { test, clearStore, readFile, createMockedFunction, dataSourceMock } from "matchstick-as/assembly/index";
import { Address, BigDecimal, BigInt, Bytes, DataSourceContext, Value, ethereum, json, log, store } from "@graphprotocol/graph-ts";
import { createMockBlock, createMockEvent, ethereumValueFromTypedJson, JSONObjectBuilder, entityToJson, getAllTrackedTypes, getTrackedIdsForType, jsonString, jsonArray } from "${assemblyImport}";
${handlerImportLines.join("\n")}
${eventTypeImportLines.join("\n")}

// Values from each data source's manifest \`context:\`, in manifest order
// (data sources, then templates).
${contextFunctions.join("\n\n")}

test("process events and dump store snapshot", () => {
  clearStore();

  const eventsRaw = readFile("${tempDir}/events.json");
  const events = json.fromBytes(eventsRaw).toArray();

  // Install view-call mocks for the reads handlers may perform. Each entry
  // is one of:
  //   { kind: "revert", address, name, signature }
  //   { kind: "return", address, name, signature, outputs: [...], returns: [...] }
  // Entries with no \`kind\` field default to "revert" for backward compat
  // with pre-v0.4.0 mock payloads.
  const mocksRaw = readFile("${tempDir}/mocks.json");
  const mocks = json.fromBytes(mocksRaw).toArray();
  for (let i = 0; i < mocks.length; i++) {
    const m = mocks[i].toObject();
    const addr = Address.fromString(m.get("address")!.toString());
    const name = m.get("name")!.toString();
    const sig = m.get("signature")!.toString();
    const kindVal = m.get("kind");
    const kind = kindVal != null ? kindVal.toString() : "revert";

    if (kind == "return") {
      const outputsArr = m.get("outputs")!.toArray();
      const returnsArr = m.get("returns")!.toArray();
      const values: ethereum.Value[] = [];
      for (let j = 0; j < outputsArr.length; j++) {
        const ty = outputsArr[j].toString();
        values.push(ethereumValueFromTypedJson(ty, returnsArr[j]));
      }
      createMockedFunction(addr, name, sig).returns(values);
    } else {
      createMockedFunction(addr, name, sig).reverts();
    }
  }

  for (let i = 0; i < events.length; i++) {
    const evt = events[i].toObject();

    let dsName = "";
    const dsVal = evt.get("dataSource");
    if (dsVal != null) {
      dsName = dsVal.toString();
    }

    let address = "";
    const addressVal = evt.get("address");
    if (addressVal != null) {
      address = addressVal.toString();
    }

    // Forward receipt-derived fields onto the matchstick mock event / block
    // so handlers see realistic \`transaction.hash\` / \`block.number\` /
    // \`block.timestamp\` / \`logIndex\` / \`address\` instead of the
    // matchstick-as defaults. Empty strings (when a JSON field is missing)
    // leave the matchstick default in place.
    let blockNum = "";
    const blockNumVal = evt.get("blockNumber");
    if (blockNumVal != null) {
      blockNum = blockNumVal.toI64().toString();
    }

    let blockTimestamp = "";
    const blockTimestampVal = evt.get("blockTimestamp");
    if (blockTimestampVal != null) {
      blockTimestamp = blockTimestampVal.toI64().toString();
    }

    const triggerVal = evt.get("trigger");
    if (triggerVal != null && triggerVal.toString() == "block") {
      const handler = evt.get("handler")!.toString();
      const block = createMockBlock(blockNum, blockTimestamp);
      if (false) {
${blockRoutes.join("\n")}
      }
      continue;
    }

    const eventName = evt.get("event")!.toString();
    // Pass the JSONValue directly — createMockEvent expects the ordered
    // array shape \`[[name, value], ...]\`. Calling \`.toObject()\` here would
    // discard ABI order (TypedMap iteration is not insertion-ordered).
    const params = evt.get("params")!;

    let txHash = "";
    const txHashVal = evt.get("transactionHash");
    if (txHashVal != null) {
      txHash = txHashVal.toString();
    }

    let logIndex = "";
    const logIndexVal = evt.get("logIndex");
    if (logIndexVal != null) {
      logIndex = logIndexVal.toI64().toString();
    }

    if (false) {
${eventRoutes.join("\n")}
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
  // Track seen (entityType:id) pairs to avoid duplicate keys in the JSON output
  // when a tracked entity is also listed in explicit reads.
  const seenIds = new Set<string>();

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
    seenIds.add(entityType + ":" + id);
  }

  // Collect entities tracked via trackSave() (injected into save() by the
  // schema patch). Add them to byType so they appear in SNAPSHOT, and emit a
  // separate MANIFEST: line with just the discovered IDs.
  const trackedTypes = getAllTrackedTypes();
  const manifestBuilder = new JSONObjectBuilder();

  for (let t = 0; t < trackedTypes.length; t++) {
    const entityType = trackedTypes[t];
    const trackedIds = getTrackedIdsForType(entityType);
    const idList: Array<string> = [];

    for (let j = 0; j < trackedIds.length; j++) {
      const id = trackedIds[j];
      idList.push(jsonString(id));

      // Only add to SNAPSHOT if not already covered by an explicit read.
      if (!seenIds.has(entityType + ":" + id)) {
        if (!byType.has(entityType)) {
          byType.set(entityType, new JSONObjectBuilder());
          typeOrder.push(entityType);
        }
        const entity = store.get(entityType, id);
        const value = entity ? entityToJson(entity) : "null";
        byType.get(entityType)!.setRaw(id, value);
      }
    }

    manifestBuilder.setRaw(entityType, jsonArray(idList));
  }

  log.info("MANIFEST: " + manifestBuilder.toString(), []);

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
