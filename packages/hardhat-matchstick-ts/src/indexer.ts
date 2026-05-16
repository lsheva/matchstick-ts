/**
 * Hardhat-facing indexer on a {@link NetworkConnection}: bind deployments,
 * ingest logs incrementally, query subgraph entity state via Matchstick.
 */
import { SubgraphLogSync, type SubgraphLogSyncOptions } from "matchstick-ts";

export type MatchstickIndexerOptions = SubgraphLogSyncOptions;

/** Attached to {@link NetworkConnection.matchstick} by the plugin hook. */
export class MatchstickIndexer extends SubgraphLogSync {}
