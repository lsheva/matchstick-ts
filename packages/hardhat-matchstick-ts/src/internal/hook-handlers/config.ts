import type { ConfigHooks } from "hardhat/types/hooks";

import "../../type-extensions.ts";

// Hardhat builds the resolved config only from what plugins return, so the
// `matchstick` block is dropped unless it is copied over here.
export default async (): Promise<Partial<ConfigHooks>> => ({
  async resolveUserConfig(userConfig, resolveConfigurationVariable, next) {
    const resolved = await next(userConfig, resolveConfigurationVariable);
    return userConfig.matchstick === undefined
      ? resolved
      : { ...resolved, matchstick: { ...userConfig.matchstick } };
  },
});
