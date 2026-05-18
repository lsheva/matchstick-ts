import "hardhat/config";
import "hardhat/types/config";

/**
 * Optional defaults for {@link runMatchstickTest} from `matchstick-ts`.
 * Set under `matchstick` in `hardhat.config.ts` when using this plugin.
 */
export interface MatchstickUserConfig {
  /** Defaults to `subgraph.yaml`. */
  subgraphYaml?: string;
  /** Defaults to `schema.graphql`. */
  schemaPath?: string;
  /** Defaults to `tests/runner.test.ts`. */
  runnerPath?: string;
  /** Defaults to `tests/.tmp/entities.d.ts`. */
  typesPath?: string;
  /** JSON IO dir shared with the AS runner. Defaults to `tests/.tmp`. */
  jsonDir?: string;
  /** First `ingest` / `index` when never synced and not anchored. Defaults to `0`. */
  startBlock?: bigint;
  /** Print full Matchstick / `graph test` output after each replay. */
  verbose?: boolean;
  /**
   * Path to the `graph codegen`-generated `schema.ts`. Patched at test time
   * to enable {@link Snapshot.discoveredIds}. Defaults to `"generated/schema.ts"`.
   * Pass an empty string to disable patching.
   */
  generatedSchemaPath?: string;
}

declare module "hardhat/config" {
  interface HardhatUserConfig {
    matchstick?: MatchstickUserConfig;
  }
}

declare module "hardhat/types/config" {
  interface HardhatConfig {
    matchstick?: MatchstickUserConfig;
  }
}

