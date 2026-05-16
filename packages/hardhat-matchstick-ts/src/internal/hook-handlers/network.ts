import type { HookContext, NetworkHooks } from "hardhat/types/hooks";
import type { ChainType, NetworkConnection } from "hardhat/types/network";

import "../../type-extensions.ts";
import { matchstickRunOptionsFromConfig } from "../../config.ts";
import { MatchstickIndexer } from "../../indexer.ts";

export default async (): Promise<Partial<NetworkHooks>> => {
  const handlers: Partial<NetworkHooks> = {
    async newConnection<ChainTypeT extends ChainType | string>(
      context: HookContext,
      next: (nextContext: HookContext) => Promise<NetworkConnection<ChainTypeT>>,
    ) {
      const connection: NetworkConnection<ChainTypeT> = await next(context);

      const matchstickConfig = context.config.matchstick;
      const publicClient = await connection.viem.getPublicClient();

      connection.matchstick = new MatchstickIndexer({
        client: {
          getBlockNumber: () => publicClient.getBlockNumber(),
          getLogs: (args) =>
            publicClient.getLogs({
              address: args.address as `0x${string}` | `0x${string}`[],
              fromBlock: args.fromBlock,
              toBlock: args.toBlock,
            }),
        },
        startBlock: matchstickConfig?.startBlock,
        runDefaults: matchstickRunOptionsFromConfig(matchstickConfig),
      });

      return connection;
    },
  };

  return handlers;
};
