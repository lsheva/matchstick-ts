/**
 * Per-data-source `dataSource.context()` overrides.
 *
 * Tests deploy contracts fresh, so addresses a mapping reads from its
 * manifest `context:` are wrong under test. Overrides replace individual
 * keys of a data source's (or template's) context for one run; keys that are
 * not overridden keep their manifest value.
 *
 * `runMatchstickTest` resolves overrides against the manifest and writes them
 * to `context.json` as `{ [dataSource]: { [key]: { type, data } } }`. The
 * generated runner applies them on top of the manifest context before each
 * handler call (`withContextOverrides` in `templates/runner.ts`).
 */
import type { ContextEntry, SubgraphManifest } from "./codegen/parse-subgraph-manifest.ts";

/**
 * One override. A plain value takes its type from the manifest entry with
 * the same key; `{ type, data }` is required for keys the manifest does not
 * declare (always the case for templates). `type` is a manifest context
 * type: `String`, `Bytes`, `BigInt`, `BigDecimal`, `Int`, `Int8`, `Bool` /
 * `Boolean`, or `List` with `data` an array of `{ type, data }`.
 */
export type ContextValue = string | bigint | number | boolean | ContextEntry;

/** Overrides for one data source: context key → value. */
export type DataSourceContextOverride = Record<string, ContextValue>;

/** Overrides keyed by `dataSources[].name` / `templates[].name`. */
export type ContextOverrides = Record<string, DataSourceContextOverride>;

/**
 * Wire form: every scalar `data` is a string (so i64 / 256-bit values keep
 * their precision through `json.fromBytes`), except `Bool` data, which is a
 * boolean.
 */
export type ResolvedContextOverrides = Record<string, Record<string, ContextEntry>>;

const SCALAR_TYPES = new Set(["String", "Bytes", "BigInt", "BigDecimal", "Int", "Int8", "Bool", "Boolean"]);
const NUMERIC_TYPES = new Set(["BigInt", "BigDecimal", "Int", "Int8"]);

/**
 * Merge override maps; later maps win per key, and data sources present in
 * several maps keep the keys of all of them.
 */
export function mergeContextOverrides(...maps: (ContextOverrides | undefined)[]): ContextOverrides {
  const merged: ContextOverrides = {};
  for (const map of maps) {
    for (const [dataSource, override] of Object.entries(map ?? {})) {
      merged[dataSource] = { ...merged[dataSource], ...override };
    }
  }
  return merged;
}

function isEntry(value: ContextValue): value is ContextEntry {
  return typeof value === "object" && value !== null && "type" in value && "data" in value;
}

function normalizeEntry(entry: ContextEntry, path: string): ContextEntry {
  const { type, data } = entry;
  if (type === "List") {
    if (!Array.isArray(data)) {
      throw new Error(`matchstick-ts: context override ${path} is a List but its data is not an array`);
    }
    return {
      type,
      data: data.map((item, i) => {
        if (!isEntry(item as ContextValue)) {
          throw new Error(
            `matchstick-ts: context override ${path}[${i}] must be { type, data } — List items carry no manifest type to infer from`,
          );
        }
        return normalizeEntry(item as ContextEntry, `${path}[${i}]`);
      }),
    };
  }
  if (!SCALAR_TYPES.has(type)) {
    throw new Error(`matchstick-ts: context override ${path} has unsupported type "${type}"`);
  }
  return { type, data: normalizeScalar(type, data, path) };
}

function normalizeScalar(type: string, data: unknown, path: string): string | boolean {
  if (type === "Bool" || type === "Boolean") {
    if (typeof data === "boolean") return data;
    if (data === "true" || data === "false") return data === "true";
    throw new Error(`matchstick-ts: context override ${path} is ${type} but got ${describe(data)}`);
  }
  if (NUMERIC_TYPES.has(type)) {
    if (typeof data === "bigint" || typeof data === "number" || typeof data === "string") {
      return String(data);
    }
    throw new Error(`matchstick-ts: context override ${path} is ${type} but got ${describe(data)}`);
  }
  if (typeof data === "string") return data;
  throw new Error(`matchstick-ts: context override ${path} is ${type} but got ${describe(data)}`);
}

function describe(value: unknown): string {
  return typeof value === "bigint" ? `${value}n` : JSON.stringify(value) ?? String(value);
}

/**
 * Resolve overrides against the manifest: infer the type of plain values
 * from the manifest's `context:` and normalize `data` to the wire form.
 *
 * @throws for an unknown data source, or a plain value whose key the
 *   manifest does not declare for that data source.
 */
export function resolveContextOverrides(
  manifest: SubgraphManifest,
  overrides: ContextOverrides = {},
): ResolvedContextOverrides {
  const sources = new Map(
    [...manifest.dataSources, ...(manifest.templates ?? [])].map((ds) => [ds.name, ds]),
  );
  const resolved: ResolvedContextOverrides = {};

  for (const [dataSource, override] of Object.entries(overrides)) {
    const ds = sources.get(dataSource);
    if (ds === undefined) {
      throw new Error(
        `matchstick-ts: context override for unknown data source "${dataSource}" (manifest has ${[...sources.keys()].map((n) => `"${n}"`).join(", ")})`,
      );
    }
    const entries: Record<string, ContextEntry> = {};
    for (const [key, value] of Object.entries(override)) {
      const path = `${dataSource}.context.${key}`;
      if (isEntry(value)) {
        entries[key] = normalizeEntry(value, path);
        continue;
      }
      const manifestEntry = ds.context?.[key];
      if (manifestEntry === undefined) {
        throw new Error(
          `matchstick-ts: context key "${key}" is not in the manifest context of "${dataSource}", so its type cannot be inferred — pass { type, data }, e.g. { type: "String", data: ${describe(value)} }`,
        );
      }
      if (manifestEntry.type === "List") {
        throw new Error(
          `matchstick-ts: context key ${path} is a List in the manifest — pass { type: "List", data: [{ type, data }, ...] }`,
        );
      }
      entries[key] = normalizeEntry({ type: manifestEntry.type, data: value }, path);
    }
    resolved[dataSource] = entries;
  }
  return resolved;
}
