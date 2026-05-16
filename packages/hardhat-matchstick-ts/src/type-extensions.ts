import "hardhat/config";

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
}

declare module "hardhat/config" {
  interface HardhatUserConfig {
    matchstick?: MatchstickUserConfig;
  }

  interface HardhatConfig {
    matchstick?: MatchstickUserConfig;
  }
}
