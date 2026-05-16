/**
 * Hardhat 3 plugin for matchstick-ts.
 *
 * Registers the `matchstick` config block (see `./type-extensions.ts`).
 *
 * Import node helpers from `hardhat-matchstick-ts/node` — not from this entry —
 * so loading `hardhat.config.ts` does not pull in Hardhat network APIs before
 * Hardhat has finished bootstrapping.
 */
import type { HardhatPlugin } from "hardhat/types/plugins";

import "./type-extensions.ts";

const hardhatMatchstickPlugin: HardhatPlugin = {
  id: "hardhat-matchstick-ts",
  npmPackage: "hardhat-matchstick-ts",
};

export default hardhatMatchstickPlugin;

export type { MatchstickUserConfig } from "./type-extensions.ts";

/**
 * Merge `hardhat.config` `matchstick` defaults into {@link runMatchstickTest}
 * options. Import `runMatchstickTest` from `matchstick-ts` and spread:
 *
 *   await runMatchstickTest({
 *     ...matchstickRunOptionsFromConfig(hre.config.matchstick),
 *     events,
 *     reads,
 *   });
 */
export { matchstickRunOptionsFromConfig } from "./config.ts";
