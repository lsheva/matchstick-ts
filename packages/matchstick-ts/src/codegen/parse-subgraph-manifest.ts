/**
 * Shared subgraph.yaml parsing for codegen (runner + entities.d.ts).
 */
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

/** One `context:` entry, e.g. `{ type: BigInt, data: "123" }`. */
export interface ContextEntry {
  type: string;
  data: unknown;
}

export interface BlockHandler {
  handler: string;
  /** `once`, `call` or `polling`; absent means every block. */
  filter?: { kind: string; every?: number };
}

export interface SubgraphDataSource {
  name: string;
  network?: string;
  source: { abi: string; address?: string; startBlock?: number };
  context?: Record<string, ContextEntry>;
  mapping: {
    file: string;
    eventHandlers?: { event: string; handler: string }[];
    blockHandlers?: BlockHandler[];
  };
}

export interface SubgraphManifest {
  dataSources: SubgraphDataSource[];
  templates?: SubgraphDataSource[];
}

export function parseSubgraphManifest(source: string): SubgraphManifest {
  return parse(source) as SubgraphManifest;
}

export async function readSubgraphManifest(subgraphYamlPath: string): Promise<SubgraphManifest> {
  return parseSubgraphManifest(await readFile(subgraphYamlPath, "utf8"));
}

/** `dataSources[].name` then `templates[].name` from the manifest (insertion order). */
export function dataSourceNamesFromManifest(manifest: SubgraphManifest): string[] {
  return [...manifest.dataSources, ...(manifest.templates ?? [])].map((ds) => ds.name);
}
