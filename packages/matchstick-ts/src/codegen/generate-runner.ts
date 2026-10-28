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
 * The code lives in `templates/runner.ts`, a regular AssemblyScript file
 * typechecked with the rest of `assembly/`. This module only fills its
 * `// #region generated:<name>` blocks: imports, the JSON IO directory, and
 * the per-manifest `dispatchBlock` / `dispatchEvent` routing.
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

/** The runner template: a regular AssemblyScript file, typechecked via `assembly/tsconfig.json`. */
const TEMPLATE_URL = new URL("../../templates/runner.ts", import.meta.url);

const REGION_RE = /^\/\/ #region generated:([\w-]+)\n[\s\S]*?^\/\/ #endregion$/gm;

/**
 * Replace the body of every `// #region generated:<name>` block in
 * `template` with `regions[name]`. Throws if the template and `regions`
 * disagree on the set of names, so the two cannot drift apart silently.
 */
export function fillTemplate(template: string, regions: Record<string, string>): string {
  const filled = new Set<string>();
  const output = template.replace(REGION_RE, (_block, name: string) => {
    if (!Object.hasOwn(regions, name)) {
      throw new Error(`fillTemplate: no replacement for region "${name}"`);
    }
    filled.add(name);
    const body = regions[name];
    const separator = body === "" || body.endsWith("\n") ? "" : "\n";
    return `// #region generated:${name}\n${body}${separator}// #endregion`;
  });
  for (const name of Object.keys(regions)) {
    if (!filled.has(name)) throw new Error(`fillTemplate: template has no region "${name}"`);
  }
  return output;
}

interface Branch {
  condition: string;
  body: string[];
}

/** `if (a) { ... } else if (b) { ... }` at two-space indentation inside a function. */
function ifChain(branches: Branch[]): string {
  if (branches.length === 0) return "";
  const parts = branches.map(
    (b) => `if (${b.condition}) {\n${b.body.map((line) => `    ${line}\n`).join("")}  }`,
  );
  return `  ${parts.join(" else ")}\n`;
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
  const eventBranches: Branch[] = [];
  const blockBranches: Branch[] = [];
  const firstOwner = new Map<string, string>();

  for (let i = 0; i < sources.length; i++) {
    const { ds, template } = sources[i];
    const mappingPath = relative(".", `${manifestDir}/${ds.mapping.file}`);
    if (!handlersByFile.has(mappingPath)) handlersByFile.set(mappingPath, new Set());
    const handlers = handlersByFile.get(mappingPath)!;

    const contextFn = `dataSourceContext${i}`;
    const contextLines = Object.entries(ds.context ?? {}).map(
      ([key, entry]) =>
        `  context.set(${JSON.stringify(key)}, ${contextValueExpr(entry, `${ds.name}.context.${key}`)});\n`,
    );
    contextFunctions.push(
      `/** Manifest \`context:\` of ${template ? "template" : "data source"} ${ds.name}. */\n` +
        `function ${contextFn}(): DataSourceContext {\n  const context = new DataSourceContext();\n${contextLines.join("")}  return context;\n}\n`,
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
      eventBranches.push({
        condition: `eventName == "${eventName}" && ${dsMatch}`,
        body: [
          setDataSource,
          `${eh.handler}(createMockEvent<${alias}>(params, txHash, blockNum, logIndex, address, blockTimestamp));`,
        ],
      });
    }

    for (const bh of template ? [] : ds.mapping.blockHandlers ?? []) {
      const kind = bh.filter?.kind;
      if (kind !== undefined && kind !== "once") continue;
      handlers.add(bh.handler);
      blockBranches.push({
        condition: `dsName == ${dsName} && handler == "${bh.handler}"`,
        body: [setDataSource, `${bh.handler}(block);`],
      });
    }
  }

  const imports = [
    `import { dataSourceMock } from "matchstick-as/assembly/index";`,
    `import { BigDecimal, BigInt, Bytes, DataSourceContext, Value } from "@graphprotocol/graph-ts";`,
    `import { createMockEvent } from "${assemblyImport}";`,
  ];
  for (const [file, handlerSet] of handlersByFile) {
    if (handlerSet.size === 0) continue;
    const handlerList = [...handlerSet].sort().join(", ");
    imports.push(`import { ${handlerList} } from "${importSpecifier(outputPath, file)}";`);
  }
  for (const [specifier, names] of eventTypeImports) {
    imports.push(`import { ${names.join(", ")} } from "${specifier}";`);
  }

  const dispatch = [
    ...contextFunctions,
    `function dispatchBlock(dsName: string, handler: string, address: string, block: ethereum.Block): void {\n${ifChain(blockBranches)}}\n`,
    `function dispatchEvent(\n  eventName: string,\n  dsName: string,\n  address: string,\n  params: JSONValue,\n  txHash: string,\n  blockNum: string,\n  logIndex: string,\n  blockTimestamp: string,\n): void {\n${ifChain(eventBranches)}}`,
  ].join("\n");

  const template = await readFile(TEMPLATE_URL, "utf8");
  const code = fillTemplate(template, {
    header: `// AUTOGENERATED by matchstick-ts from templates/runner.ts and ${subgraphYamlPath} — do not edit.`,
    imports: imports.join("\n"),
    config: `const TEMP_DIR = ${JSON.stringify(tempDir)};`,
    dispatch,
  }).replaceAll('from "matchstick-ts/assembly"', `from "${assemblyImport}"`);

  await writeIfChanged(outputPath, code);
}
