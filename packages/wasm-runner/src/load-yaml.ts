/**
 * `loadSubgraphYaml(path)` — parse a graph-cli `subgraph.yaml`
 * manifest into the runner's native `DataSourceSpec[]`.
 *
 * What it resolves:
 *   - `dataSources[].source.address` -> lower-cased `Hex`
 *   - `dataSources[].source.startBlock` -> `bigint`
 *   - `dataSources[].mapping.abis[].file` -> JSON-loaded `Abi`
 *     (relative paths anchored at the yaml file's directory)
 *   - Maps each `eventHandlers[].event` (canonical signature like
 *     `"ValueSet(uint256)"`) back to the `AbiEvent.name` the runner
 *     needs (`"ValueSet"`). Mirrors viem's `toEventSignature`.
 *   - `dataSources[].mapping.file` -> absolute path string,
 *     surfaced via `mappingEntries` for callers to pass straight
 *     into `Subgraph.create({ bundle: { handlerEntry } })`.
 *
 * What it deliberately does NOT do (yet):
 *   - templates / dynamic data sources (not used by the cases we
 *     care about today)
 *   - `features` / `graft` / network-specific overrides
 *   - validation against a real graph-cli specVersion table
 *
 * The intent is a low-friction "I have a real subgraph.yaml, run it
 * end-to-end" path. For multi-mapping manifests, the loader returns
 * the dataSources plus per-mapping handlerEntry paths — building each
 * wasm and wiring multiple `Subgraph` instances is the caller's
 * responsibility (the runner currently models one wasm per Subgraph).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  toEventSignature,
  type Abi,
  type AbiEvent,
  type Hex,
} from "viem";
import type { DataSourceSpec } from "./subgraph-runner.ts";

/**
 * Walk up from `start` looking for `subgraph.yaml` (or whatever
 * `filename` is). Returns the first hit or `null` after reaching
 * the filesystem root.
 *
 * Used by `Subgraph.create()` when no explicit manifest path is
 * passed — the typical test setup runs from a package root where
 * `subgraph.yaml` lives one or two levels above the test file.
 */
export function findSubgraphYamlInAncestors(
  start: string = process.cwd(),
  filename: string = "subgraph.yaml",
): string | null {
  let dir = resolvePath(start);
  // 32 ancestors is well past any realistic project depth — guards
  // against pathological symlink loops.
  for (let i = 0; i < 32; i++) {
    const candidate = resolvePath(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * One data source's slice of the parsed manifest, plus the resolved
 * AS handler source path from `mapping.file`. Kept parallel to
 * `dataSources` so callers can do
 * `manifest.mappingEntries[i]` ⇄ `manifest.dataSources[i]`.
 */
export interface LoadedManifest {
  /** Pass straight into `Subgraph.create({ dataSources })`. */
  dataSources: DataSourceSpec[];
  /**
   * Absolute path to each data source's `mapping.file` (graph-cli's
   * `wasm/assemblyscript` source entry). Useful for
   * `Subgraph.create({ bundle: { handlerEntry: ... } })`.
   */
  mappingEntries: string[];
  /** Absolute path to the resolved `schema.file`. */
  schemaFile: string;
  /** Verbatim `specVersion` from the manifest, for downstream warnings. */
  specVersion: string;
}

/**
 * Manifest shape we read off disk. Loose-typed because we don't
 * own the schema; callers should rely on the parsed `LoadedManifest`
 * instead. Anything we don't access stays `unknown`.
 */
interface RawManifest {
  specVersion?: string;
  schema?: { file?: string };
  dataSources?: Array<{
    kind?: string;
    name?: string;
    network?: string;
    source?: {
      address?: string;
      abi?: string;
      startBlock?: number | string;
    };
    mapping?: {
      kind?: string;
      apiVersion?: string;
      language?: string;
      file?: string;
      abis?: Array<{ name?: string; file?: string }>;
      eventHandlers?: Array<{ event?: string; handler?: string }>;
    };
  }>;
}

/** Error raised when the YAML manifest is missing or malformed. */
export class ManifestParseError extends Error {
  constructor(message: string) {
    super(`loadSubgraphYaml: ${message}`);
    this.name = "ManifestParseError";
  }
}

/**
 * Read and parse a `subgraph.yaml` (or any path-equivalent) into a
 * `LoadedManifest`. All file references inside the manifest are
 * resolved relative to the manifest's own directory before being
 * returned.
 */
export async function loadSubgraphYaml(path: string): Promise<LoadedManifest> {
  const yamlPath = isAbsolute(path) ? path : resolvePath(process.cwd(), path);
  let yamlText: string;
  try {
    yamlText = await readFile(yamlPath, "utf8");
  } catch (err) {
    throw new ManifestParseError(
      `failed to read manifest at ${yamlPath}: ${(err as Error).message}`,
    );
  }
  const raw = parseYaml(yamlText) as RawManifest | null;
  if (!raw || typeof raw !== "object") {
    throw new ManifestParseError(`manifest at ${yamlPath} is not a YAML map`);
  }
  const baseDir = dirname(yamlPath);

  if (!raw.dataSources || raw.dataSources.length === 0) {
    throw new ManifestParseError(
      `manifest at ${yamlPath} has no dataSources`,
    );
  }
  if (!raw.schema?.file) {
    throw new ManifestParseError(
      `manifest at ${yamlPath} is missing schema.file`,
    );
  }

  const dataSources: DataSourceSpec[] = [];
  const mappingEntries: string[] = [];
  for (let i = 0; i < raw.dataSources.length; i++) {
    const ds = raw.dataSources[i];
    const ctx = `dataSources[${i}]${ds.name ? ` (${ds.name})` : ""}`;
    const { spec, mappingEntry } = await loadDataSource(ds, baseDir, ctx);
    dataSources.push(spec);
    mappingEntries.push(mappingEntry);
  }

  return {
    dataSources,
    mappingEntries,
    schemaFile: resolvePath(baseDir, raw.schema.file),
    specVersion: raw.specVersion ?? "",
  };
}

async function loadDataSource(
  raw: NonNullable<RawManifest["dataSources"]>[number],
  baseDir: string,
  ctx: string,
): Promise<{ spec: DataSourceSpec; mappingEntry: string }> {
  const source = raw.source;
  if (!source?.address) {
    throw new ManifestParseError(`${ctx}: source.address is required`);
  }
  if (!source.abi) {
    throw new ManifestParseError(`${ctx}: source.abi is required`);
  }
  const mapping = raw.mapping;
  if (!mapping) {
    throw new ManifestParseError(`${ctx}: mapping is required`);
  }
  if (!mapping.file) {
    throw new ManifestParseError(`${ctx}: mapping.file is required`);
  }
  if (!mapping.abis || mapping.abis.length === 0) {
    throw new ManifestParseError(`${ctx}: mapping.abis is empty`);
  }
  if (!mapping.eventHandlers || mapping.eventHandlers.length === 0) {
    throw new ManifestParseError(
      `${ctx}: mapping.eventHandlers is empty (no events to subscribe to)`,
    );
  }

  // Find the ABI entry referenced by `source.abi`.
  const abiRef = mapping.abis.find((a) => a.name === source.abi);
  if (!abiRef?.file) {
    throw new ManifestParseError(
      `${ctx}: mapping.abis has no entry named "${source.abi}" (available: ${mapping.abis.map((a) => a.name).join(", ") || "none"})`,
    );
  }
  const abiPath = resolvePath(baseDir, abiRef.file);
  let abiJson: unknown;
  try {
    abiJson = JSON.parse(await readFile(abiPath, "utf8"));
  } catch (err) {
    throw new ManifestParseError(
      `${ctx}: failed to load ABI from ${abiPath}: ${(err as Error).message}`,
    );
  }
  // ABI files generated by `graph codegen` are sometimes wrapped
  // (`{ abi: [...] }`) and sometimes raw arrays — accept both.
  const abi: Abi = Array.isArray(abiJson)
    ? (abiJson as Abi)
    : Array.isArray((abiJson as { abi?: unknown }).abi)
      ? ((abiJson as { abi: Abi }).abi)
      : (() => {
          throw new ManifestParseError(
            `${ctx}: ABI at ${abiPath} is not a JSON array (or { abi: [...] })`,
          );
        })();

  // Build a sig -> AbiEvent.name index once, so eventHandlers' canonical
  // signatures map back to the names the runner expects.
  const sigToEventName = buildSignatureIndex(abi);
  const eventHandlers = mapping.eventHandlers.map((h, idx) => {
    if (!h.event || !h.handler) {
      throw new ManifestParseError(
        `${ctx}: eventHandlers[${idx}] is missing event/handler`,
      );
    }
    const eventName = sigToEventName.get(canonicalize(h.event));
    if (!eventName) {
      throw new ManifestParseError(
        `${ctx}: eventHandlers[${idx}] event "${h.event}" not found in ABI ${abiRef.file}. Known events: ${Array.from(sigToEventName.keys()).join(", ")}`,
      );
    }
    return { event: eventName, handler: h.handler };
  });

  const address = source.address.toLowerCase() as Hex;
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    throw new ManifestParseError(
      `${ctx}: source.address "${source.address}" is not a 20-byte hex string`,
    );
  }

  const spec: DataSourceSpec = {
    address,
    abi,
    eventHandlers,
  };
  if (source.startBlock !== undefined) {
    spec.startBlock = BigInt(source.startBlock);
  }

  return {
    spec,
    mappingEntry: resolvePath(baseDir, mapping.file),
  };
}

/**
 * Build `canonicalSignature -> AbiEvent.name` for every event in
 * the ABI. We canonicalize by stripping whitespace + parameter
 * names so manifest entries like `"ValueSet(uint256 indexed)"` or
 * `"ValueSet(uint256 newValue)"` match the bare canonical form viem
 * emits.
 */
function buildSignatureIndex(abi: Abi): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of abi) {
    if (item.type !== "event") continue;
    const ev = item as AbiEvent;
    out.set(canonicalize(toEventSignature(ev)), ev.name);
    // graph-cli also accepts `Event(indexed type, type)` in
    // signatures — record the indexed-flag-stripped form too so a
    // manifest using either spelling resolves.
    const withIndexed = `${ev.name}(${ev.inputs
      .map((i) => `${i.indexed ? "indexed " : ""}${i.type}`)
      .join(",")})`;
    out.set(canonicalize(withIndexed), ev.name);
  }
  return out;
}

/**
 * Strip whitespace and parameter names from an event signature so
 * `"ValueSet(uint256 newValue)"`, `"ValueSet( uint256 )"`, and
 * `"ValueSet(uint256)"` all reduce to the same key.
 */
function canonicalize(signature: string): string {
  // Drop everything after the first space inside each comma-delimited
  // component (parameter names, `indexed` keyword for the comparison
  // flavor that doesn't preserve it).
  const m = signature.match(/^([A-Za-z_][\w$]*)\s*\((.*)\)\s*$/);
  if (!m) return signature.replace(/\s+/g, "");
  const name = m[1];
  const inner = m[2];
  if (inner.trim() === "") return `${name}()`;
  const parts = inner.split(",").map((p) => {
    const trimmed = p.trim();
    // Strip leading `indexed ` when present so both flavors collapse.
    const stripped = trimmed.replace(/^indexed\s+/, "");
    // Take the first whitespace-delimited token (the type), discard
    // any trailing parameter name.
    return stripped.split(/\s+/)[0];
  });
  return `${name}(${parts.join(",")})`;
}
