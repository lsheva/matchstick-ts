/**
 * Expand captured events into the trigger stream the generated runner
 * replays: the events themselves plus the manifest's block handlers.
 *
 * Replay only sees blocks that carry captured events, so block handlers are
 * placed relative to those:
 *   - `filter: { kind: once }` runs before the first event, in that event's
 *     block (graph-node runs it at `startBlock`, which a test chain rarely
 *     reproduces);
 *   - unfiltered handlers run after the last event of every block, matching
 *     graph-node, which orders block triggers after a block's log triggers;
 *   - `call` and `polling` filters are not replayed.
 */
import type { CapturedEvent } from "./event-capture.ts";
import type { SubgraphManifest } from "./codegen/parse-subgraph-manifest.ts";

export interface BlockTrigger {
  trigger: "block";
  dataSource: string;
  handler: string;
  /** `dataSource.address()` seen by the handler. */
  address: string;
  blockNumber: number;
  blockTimestamp?: number;
}

export type Trigger = CapturedEvent | BlockTrigger;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * `addresses` maps data source names to the addresses they are bound to under
 * test. A block handler's `dataSource.address()` is the bound address, else
 * the address of the data source's first captured event, else the manifest's
 * `source.address`.
 */
export function buildTriggers(
  manifest: SubgraphManifest,
  events: CapturedEvent[],
  addresses: Record<string, string> = {},
): Trigger[] {
  const once: BlockTrigger[] = [];
  const everyBlock: Omit<BlockTrigger, "blockNumber" | "blockTimestamp">[] = [];

  for (const ds of manifest.dataSources) {
    const blockHandlers = ds.mapping.blockHandlers ?? [];
    if (blockHandlers.length === 0) continue;

    const ownEvent = events.find((e) => e.dataSource === ds.name);
    const address = addresses[ds.name] ?? ownEvent?.address ?? ds.source.address ?? ZERO_ADDRESS;

    for (const bh of blockHandlers) {
      const kind = bh.filter?.kind;
      const base = { trigger: "block" as const, dataSource: ds.name, handler: bh.handler, address };
      if (kind === undefined) {
        everyBlock.push(base);
      } else if (kind === "once") {
        const first = events[0];
        once.push({
          ...base,
          blockNumber: first?.blockNumber ?? ds.source.startBlock ?? 0,
          ...(first?.blockTimestamp !== undefined && { blockTimestamp: first.blockTimestamp }),
        });
      }
    }
  }

  const triggers: Trigger[] = [...once];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    triggers.push(event);
    const next = events[i + 1];
    if (everyBlock.length > 0 && next?.blockNumber !== event.blockNumber) {
      for (const bh of everyBlock) {
        triggers.push({
          ...bh,
          blockNumber: event.blockNumber,
          ...(event.blockTimestamp !== undefined && { blockTimestamp: event.blockTimestamp }),
        });
      }
    }
  }
  return triggers;
}
