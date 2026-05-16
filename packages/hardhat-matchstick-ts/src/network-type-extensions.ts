import type { MatchstickIndexer } from "./indexer.ts";

import "hardhat/types/network";

declare module "hardhat/types/network" {
  interface NetworkConnection {
    /**
     * Subgraph test indexer: {@link MatchstickIndexer.bind}, {@link MatchstickIndexer.ingest},
     * {@link MatchstickIndexer.index}.
     *
     * Each {@link MatchstickIndexer.index} replays the **entire** buffered event log from the
     * beginning (Matchstick has no incremental store between calls). Only `getLogs` is incremental.
     */
    matchstick: MatchstickIndexer;
  }
}
