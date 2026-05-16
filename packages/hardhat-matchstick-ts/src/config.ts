import type { RunOptions } from "matchstick-ts";
import type { MatchstickUserConfig } from "./type-extensions.ts";

/** Pick path defaults from `hardhat.config` → `runMatchstickTest` options. */
export function matchstickRunOptionsFromConfig(
  config: MatchstickUserConfig | undefined,
): Pick<
  RunOptions,
  "subgraphYaml" | "schemaPath" | "runnerPath" | "typesPath" | "jsonDir" | "verbose"
> {
  if (config === undefined) {
    return {};
  }
  return {
    subgraphYaml: config.subgraphYaml,
    schemaPath: config.schemaPath,
    runnerPath: config.runnerPath,
    typesPath: config.typesPath,
    jsonDir: config.jsonDir,
    verbose: config.verbose,
  };
}
