/**
 * Shared subgraph.yaml parsing for codegen (runner + entities.d.ts).
 */
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export interface SubgraphDataSource {
  name: string;
  source: { abi: string };
  mapping: {
    file: string;
    eventHandlers: { event: string; handler: string }[];
  };
}

export interface SubgraphManifest {
  dataSources: SubgraphDataSource[];
}

export function parseSubgraphManifest(source: string): SubgraphManifest {
  return parse(source) as SubgraphManifest;
}

export async function readSubgraphManifest(subgraphYamlPath: string): Promise<SubgraphManifest> {
  return parseSubgraphManifest(await readFile(subgraphYamlPath, "utf8"));
}

/** `dataSources[].name` values from the manifest (insertion order). */
export function dataSourceNamesFromManifest(manifest: SubgraphManifest): string[] {
  return manifest.dataSources.map((ds) => ds.name);
}
