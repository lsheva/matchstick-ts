/**
 * `SubgraphInstance` — the stateful, consumer-facing handle returned by
 * `WasmRunner.instantiate()`.
 *
 * Lifecycle (the model the API enforces):
 *
 *   const subgraph = await runner.instantiate();   // fresh state
 *   subgraph.dispatch(...);   // feed an event (accumulates)
 *   subgraph.entity(...);     // query current state (non-destructive)
 *   subgraph.dispatch(...);   // feed more (state carries over)
 *   await subgraph.reset();   // back to fresh — same object, new wasm
 *
 * Reset re-instantiates the underlying wasm in place rather than
 * returning a new object, so test setup hooks can assign once
 * (`const sub = await runner.instantiate()`) and call `sub.reset()`
 * between cases without juggling references.
 *
 * Power users still have escape hatches: `subgraph.exports` exposes
 * the loader-extended wasm exports (incl. test-driver `fire*` calls),
 * and `subgraph.host` exposes the host-side capture buffers + JS
 * entity store. Wrappers below are conveniences over those, not the
 * only access path.
 */
import type { InstanceExports } from "./runner.ts";
import type { Host } from "./host.ts";
import { decodeEntity, type EntityFields } from "./decode.ts";

/**
 * Factory the `SubgraphInstance` calls on `reset()` to build a fresh
 * `{ exports, host }` pair. The factory is supplied by `WasmRunner` so
 * the subgraph doesn't need to know how compilation works.
 */
export type InstanceFactory = () => Promise<{
  exports: InstanceExports;
  host: Host;
}>;

export class SubgraphInstance {
  /** Loader-extended wasm exports — escape hatch for test-driver `fire*` calls. */
  exports: InstanceExports;
  /** Host shim — escape hatch for capture buffers, raw store map, etc. */
  host: Host;
  private readonly factory: InstanceFactory;

  constructor(
    factory: InstanceFactory,
    exports: InstanceExports,
    host: Host,
  ) {
    this.factory = factory;
    this.exports = exports;
    this.host = host;
  }

  /**
   * Look up and decode the entity at (entityType, id). Returns `null`
   * if the store has no record for that pair (matches graph-ts's
   * `Entity.load()` contract — "not found" is null, not undefined).
   */
  entity(entityType: string, id: string): EntityFields | null {
    const ptr = this.host.store.get(entityType)?.get(id) ?? 0;
    return decodeEntity(this.exports, ptr);
  }

  /**
   * Return every stored entity of a given type as `{ [id]: fields }`.
   * Ids are returned in store-insertion order — the same order tests
   * see when iterating `host.store`.
   */
  entities(entityType: string): Record<string, EntityFields> {
    const byId = this.host.store.get(entityType);
    if (!byId) return {};
    const out: Record<string, EntityFields> = {};
    for (const [id, ptr] of byId) {
      const decoded = decodeEntity(this.exports, ptr);
      if (decoded) out[id] = decoded;
    }
    return out;
  }

  /**
   * Discard the current wasm instance and host capture, build a fresh
   * pair via the factory, and adopt them. After this resolves, the
   * subgraph behaves as if it were just returned by
   * `WasmRunner.instantiate()` — no entities, no captures, no AS-side
   * heap growth.
   */
  async reset(): Promise<void> {
    const { exports, host } = await this.factory();
    this.exports = exports;
    this.host = host;
  }
}
