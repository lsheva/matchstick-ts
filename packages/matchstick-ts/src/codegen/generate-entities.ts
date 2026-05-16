/**
 * Generate a TypeScript declaration file (`.d.ts`) that augments the
 * `matchstick-ts` module's `Entities` interface with one entry per
 * `@entity` type in `schema.graphql`. Hardhat-`artifacts.d.ts`-style.
 *
 * The output is consumed by tsserver/tsc only — it's never loaded at
 * runtime — so the consumer's test code needs no `import type { Entities }`
 * and no generic on `runMatchstickTest`.
 *
 * The shape matches what `runMatchstickTest` returns in its Snapshot, not
 * the AssemblyScript class shape from `generated/schema.ts`.
 *
 * Mapping decisions:
 *   - ID / String / Bytes               → string
 *   - BigInt / BigDecimal               → string (precision)
 *   - Int8 / Timestamp                  → string (i64 precision)
 *   - Int                               → number (i32 fits)
 *   - Boolean                           → boolean
 *   - Enum                              → "A" | "B" | ...
 *   - Entity reference (e.g. user: User!) → the referenced entity's id TS type
 *   - @derivedFrom fields               → omitted (computed at query time, not stored)
 *   - Nullable (no `!`)                 → `T | null`
 */
import { readFile } from "node:fs/promises";
import {
  dataSourceNamesFromManifest,
  readSubgraphManifest,
} from "./parse-subgraph-manifest.ts";
import { writeIfChanged } from "./_shared.ts";
import {
  parse,
  type DocumentNode,
  type EnumTypeDefinitionNode,
  type FieldDefinitionNode,
  type ObjectTypeDefinitionNode,
  type TypeNode,
} from "graphql";

const SCALAR_TS: Record<string, string> = {
  ID: "string",
  String: "string",
  Bytes: "string",
  BigInt: "string",
  BigDecimal: "string",
  Int8: "string",
  Timestamp: "string",
  Int: "number",
  Boolean: "boolean",
};

interface Context {
  /** entity name → TS type of its `id` field (used to resolve references) */
  entityIdType: Map<string, string>;
  enums: Set<string>;
}

function isDerivedFrom(field: FieldDefinitionNode): boolean {
  return (field.directives ?? []).some((d) => d.name.value === "derivedFrom");
}

function isEntity(node: ObjectTypeDefinitionNode): boolean {
  return (node.directives ?? []).some((d) => d.name.value === "entity");
}

interface UnwrappedType {
  named: string;
  nonNull: boolean;
  isList: boolean;
  listElementNonNull: boolean;
}

function unwrap(type: TypeNode): UnwrappedType {
  let nonNull = false;
  let cur: TypeNode = type;
  if (cur.kind === "NonNullType") {
    nonNull = true;
    // After this `cur` is NamedTypeNode | ListTypeNode.
    cur = cur.type;
  }
  if (cur.kind === "ListType") {
    let element: TypeNode = cur.type;
    let listElementNonNull = false;
    if (element.kind === "NonNullType") {
      listElementNonNull = true;
      element = element.type;
    }
    if (element.kind !== "NamedType") {
      throw new Error(`Unsupported nested list type at ${JSON.stringify(type)}`);
    }
    return { named: element.name.value, nonNull, isList: true, listElementNonNull };
  }
  // cur is narrowed to NamedTypeNode here.
  return { named: cur.name.value, nonNull, isList: false, listElementNonNull: false };
}

function tsType(type: TypeNode, ctx: Context): string {
  const u = unwrap(type);

  let base: string;
  if (u.named in SCALAR_TS) {
    base = SCALAR_TS[u.named];
  } else if (ctx.enums.has(u.named)) {
    base = u.named;
  } else if (ctx.entityIdType.has(u.named)) {
    // Entity reference: stored as the referenced entity's id value.
    base = ctx.entityIdType.get(u.named)!;
  } else {
    base = "string";
  }

  if (u.isList) {
    const element = u.listElementNonNull ? base : `${base} | null`;
    const list = `${element}[]`;
    return u.nonNull ? list : `${list} | null`;
  }
  return u.nonNull ? base : `${base} | null`;
}

export interface GenerateEntitiesOptions {
  /** Path to the GraphQL schema (e.g., "schema.graphql"). */
  schemaPath: string;
  /** Output `.d.ts` path. Augments `Entities` via `declare module`. */
  outputPath: string;
  /**
   * Subgraph manifest — when set, also augments `DataSources` from
   * `dataSources[].name` (same names as {@link SubgraphLogSync.bind}).
   */
  subgraphYamlPath?: string;
  /**
   * Module specifier whose `Entities` interface gets augmented. Defaults to
   * `"matchstick-ts"` — override if you've installed the package under a
   * different name.
   */
  moduleSpecifier?: string;
}

interface ParsedSchema {
  entities: ObjectTypeDefinitionNode[];
  enums: EnumTypeDefinitionNode[];
  ctx: Context;
}

function parseSchema(source: string): ParsedSchema {
  const doc: DocumentNode = parse(source);

  const entities: ObjectTypeDefinitionNode[] = [];
  const enums: EnumTypeDefinitionNode[] = [];

  for (const def of doc.definitions) {
    if (def.kind === "ObjectTypeDefinition" && isEntity(def)) entities.push(def);
    else if (def.kind === "EnumTypeDefinition") enums.push(def);
  }

  const ctx: Context = {
    entityIdType: new Map(),
    enums: new Set(enums.map((e) => e.name.value)),
  };

  for (const e of entities) {
    const idField = (e.fields ?? []).find((f) => f.name.value === "id");
    if (!idField) continue;
    const u = unwrap(idField.type);
    ctx.entityIdType.set(e.name.value, SCALAR_TS[u.named] ?? "string");
  }

  return { entities, enums, ctx };
}

function renderDataSourcesRegistry(
  dataSourceNames: readonly string[],
  entityNames: ReadonlySet<string>,
): string | undefined {
  if (dataSourceNames.length === 0) return undefined;

  const markers: string[] = [];
  const entries: string[] = [];

  for (const name of dataSourceNames) {
    if (entityNames.has(name)) {
      entries.push(`    ${name}: ${name};`);
    } else {
      const marker = `${name}DataSource`;
      markers.push(`  interface ${marker} {}`);
      entries.push(`    ${name}: ${marker};`);
    }
  }

  const registry = `  interface DataSources {\n${entries.join("\n")}\n  }`;
  return [...markers, registry].join("\n\n");
}

function renderDts(
  parsed: ParsedSchema,
  moduleSpecifier: string,
  dataSourceNames: readonly string[],
): string {
  const { entities, enums, ctx } = parsed;
  const entityNames = new Set(entities.map((e) => e.name.value));

  const enumLines = enums.map((e) => {
    const values = (e.values ?? []).map((v) => `"${v.name.value}"`).join(" | ");
    return `  type ${e.name.value} = ${values};`;
  });

  const entityBlocks: string[] = [];
  for (const e of entities) {
    const fields = (e.fields ?? []).filter((f) => !isDerivedFrom(f));
    const lines = fields.map((f) => `    ${f.name.value}: ${tsType(f.type, ctx)};`);
    entityBlocks.push(`  interface ${e.name.value} {\n${lines.join("\n")}\n  }`);
  }

  const registryEntries = entities.map((e) => `    ${e.name.value}: ${e.name.value};`).join("\n");
  const registry = `  interface Entities {\n${registryEntries}\n  }`;
  const dataSources = renderDataSourcesRegistry(dataSourceNames, entityNames);

  const sections: string[] = [];
  if (enumLines.length > 0) sections.push(enumLines.join("\n"));
  if (entityBlocks.length > 0) sections.push(entityBlocks.join("\n\n"));
  sections.push(registry);
  if (dataSources !== undefined) sections.push(dataSources);

  const banner = [
    "// AUTOGENERATED — do not edit by hand.",
    "// Module augmentation for matchstick-ts (`Entities` from schema.graphql,",
    "// `DataSources` from subgraph.yaml when provided).",
  ].join("\n");

  // Must be a module (top-level import) so this augments the real package
  // instead of replacing it with an ambient-only declaration.
  return `${banner}\n\nimport type {} from "${moduleSpecifier}";\n\ndeclare module "${moduleSpecifier}" {\n${sections.join("\n\n")}\n}\n`;
}

export async function generateEntities(options: GenerateEntitiesOptions): Promise<void> {
  const { schemaPath, outputPath } = options;
  const moduleSpecifier = options.moduleSpecifier ?? "matchstick-ts";

  const source = await readFile(schemaPath, "utf8");
  const parsed = parseSchema(source);

  let dataSourceNames: string[] = [];
  if (options.subgraphYamlPath !== undefined) {
    const manifest = await readSubgraphManifest(options.subgraphYamlPath);
    dataSourceNames = dataSourceNamesFromManifest(manifest);
  }

  await writeIfChanged(outputPath, renderDts(parsed, moduleSpecifier, dataSourceNames));
}
