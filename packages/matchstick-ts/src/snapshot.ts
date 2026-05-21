/**
 * Snapshot harness: runs Matchstick against captured events and returns a
 * typed `Snapshot<TEntities>` containing the requested entities in their JSON
 * shape. All assertion logic stays in the consumer's test file — use
 * `node:assert/strict` (or any matcher library) on the result.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import type { CallMock, CapturedEvent } from "./event-capture.ts";
import { generateRunner } from "./codegen/generate-runner.ts";
import { generateEntities } from "./codegen/generate-entities.ts";
/**
 * Default location for the JSON IO files (`events.json`, `reads.json`,
 * `mocks.json`) shared between the TS orchestrator and the AS runner.
 *
 * Lives under `tests/` so it sits next to matchstick's generated
 * `runner.test.ts`, and is dotfile-prefixed so it's obvious it's scratch.
 * Override via `RunOptions.jsonDir` and the generator's `--temp-dir` flag —
 * both sides must agree on the path.
 */
export const DEFAULT_TMP_DIR = "tests/.tmp";

/**
 * A single (entityType, id) pair the runner should serialize into the
 * snapshot. Anything not listed here will not appear in the dump.
 *
 * Generic over the entity-map type so `entityType` autocompletes against the
 * keys of your `Entities` type when one is supplied.
 */
export interface EntityRef<TEntities = AugmentedEntities> {
  entityType: EntityKey<TEntities>;
  id: string;
}

/**
 * Raw shape returned by the AS runner:
 *   { [entityType]: { [id]: { ...fields } | null } }
 * `null` means "asked for that id, but no entity was found".
 */
export type EntityFields = Record<string, FieldValue>;
export type FieldValue = string | number | boolean | null | FieldValue[];
export type RawSnapshot = Record<string, Record<string, EntityFields | null>>;

/** Default loose shape when no typed `Entities` is supplied. */
export type DefaultEntityMap = Record<string, EntityFields>;

/**
 * Augmentable entity registry — Hardhat-`artifacts.d.ts`-style. The
 * generated `entities.d.ts` re-opens this interface via:
 *
 *   declare module "matchstick-ts" {
 *     interface Entities {
 *       Futures: Futures;
 *       User: User;
 *       // ...
 *     }
 *   }
 *
 * tsserver/tsc pick the augmentation up automatically; at runtime the
 * `.d.ts` is never loaded, so consumers never need a runtime import of
 * generated code.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentional augmentation target
export interface Entities {}

/**
 * Augmentable registry of subgraph manifest `dataSources[].name` values.
 * Emitted into `entities.d.ts` when codegen receives `subgraphYamlPath`.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentional augmentation target
export interface DataSources {}

/**
 * Resolves to the augmented `Entities` interface if the consumer has
 * generated one, otherwise the loose `DefaultEntityMap`. This is the
 * default generic for `runMatchstickTest` / `Snapshot` — no type
 * argument needed in the typical case.
 */
export type AugmentedEntities = keyof Entities extends never ? DefaultEntityMap : Entities;

/**
 * Resolves to augmented `dataSources[].name` keys when `entities.d.ts`
 * includes `DataSources`; otherwise falls back to entity keys.
 */
export type AugmentedDataSources = keyof DataSources extends never
  ? EntityKey<AugmentedEntities>
  : Extract<keyof DataSources, string>;

// Generics are unconstrained so a closed-shape `interface Entities`
// (which lacks an index signature) can still be passed in.
export type EntityKey<T> = Extract<keyof T, string>;
type FieldKey<T, K extends EntityKey<T>> = Extract<keyof T[K], string>;

export interface RunOptions<TEntities = AugmentedEntities> {
  events: CapturedEvent[];
  /** Entities to read out of the store after replay. */
  reads: EntityRef<TEntities>[];
  /**
   * View-call mocks registered before processing events. Each entry is a
   * discriminated union: `{ kind: "revert" }` causes the handler's `try_*`
   * read to return `reverted = true`, while `{ kind: "return", outputs,
   * returns }` returns the captured value.
   */
  callMocks?: CallMock[];
  /** @deprecated Use {@link RunOptions.callMocks}. */
  revertMocks?: CallMock[];
  /**
   * Directory where JSON IO files (`events.json`, `reads.json`, `mocks.json`)
   * are written. Defaults to `tests/.tmp`. Auto-codegen passes this path to
   * the runner template so both sides stay in sync; override only if you've
   * disabled auto-codegen and want to relocate them yourself.
   */
  jsonDir?: string;
  /**
   * Path to the subgraph manifest. Used by auto-codegen to discover handlers
   * + event types. Defaults to `subgraph.yaml`.
   */
  subgraphYaml?: string;
  /**
   * Path to the GraphQL schema. Used by auto-codegen to emit the typed
   * `entities.d.ts`. Defaults to `schema.graphql`.
   */
  schemaPath?: string;
  /**
   * Output path for the generated AS runner test. Defaults to
   * `tests/runner.test.ts`.
   */
  runnerPath?: string;
  /**
   * Output path for the generated `entities.d.ts` (TS module augmentation
   * for `matchstick-ts`'s `Entities` interface). Defaults to
   * `tests/.tmp/entities.d.ts`.
   *
   * The file is purely a TypeScript declaration — never loaded at runtime.
   * It must be visible to tsserver/tsc: ensure the path is in a project
   * scope (e.g., tsconfig `include`) for full type inference. If your
   * matchstick AS tsconfig includes the parent dir, exclude this path
   * there to avoid noise.
   */
  typesPath?: string;
  /**
   * Auto-generate `runnerPath` and `typesPath` on every call (idempotent —
   * files are only re-written when their contents change, so matchstick's
   * incremental WASM build stays warm). Default `true`.
   *
   * Set `false` if you'd rather drive codegen externally via the CLI.
   */
  autoCodegen?: boolean;
  /**
   * Path to the `graph codegen`-generated `schema.ts` file. Before running
   * `graph test`, matchstick-ts patches each entity's `save()` method to also
   * call `trackSave(entityType, id)`, enabling {@link Snapshot.discoveredIds}.
   * The original file is restored in a `finally` block regardless of outcome.
   *
   * Defaults to `"generated/schema.ts"`. Set to `null` / `undefined` explicitly
   * (via `generatedSchemaPath: ""`) to disable patching.
   */
  generatedSchemaPath?: string;
  /**
   * Whether to remove the JSON IO files after the run completes. Defaults to
   * true. Set `KEEP_TEMP=1` in the environment to override.
   */
  cleanup?: boolean;
  /**
   * Print full `graph test` stdout (and stderr) after each run.
   * Also enabled when `MATCHSTICK_VERBOSE=1` (or `true`) is set in the environment.
   */
  verbose?: boolean;
}

/**
 * Patch the `graph codegen`-generated `schema.ts` so that every entity's
 * `save()` method calls `trackSave(entityType, id)` after `store.set(...)`.
 * This is applied temporarily around each `graph test` run — the original is
 * restored in a `finally` block.
 *
 * The regex matches the consistent pattern emitted by `graph codegen`:
 *   store.set("EntityType", id<expr>, this)
 * where `id<expr>` is `id.toString()`, `id.toI64().toString()`,
 * `id.toBytes().toHexString()`, etc.
 */
function patchGeneratedSchema(content: string): string {
  const importLine = 'import { trackSave } from "matchstick-ts/assembly";';
  const patched = content.replace(
    /store\.set\(("([^"]+)"),\s*([\w.!()]+),\s*this\)/g,
    "store.set($1, $3, this);\n      trackSave($1, $3)",
  );
  return `${importLine}\n${patched}`;
}

function matchstickVerbose(options: { verbose?: boolean }): boolean {
  if (options.verbose === true) return true;
  const env = process.env.MATCHSTICK_VERBOSE;
  return env === "1" || env === "true";
}

function printMatchstickOutput(stdout: string, stderr: string): void {
  process.stdout.write("\n--- matchstick ---\n");
  if (stdout.length > 0) {
    process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  }
  if (stderr.length > 0) {
    process.stdout.write("--- matchstick stderr ---\n");
    process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
  }
  process.stdout.write("--- end matchstick ---\n\n");
}

/**
 * Sugar: expand `(entityType, ids[])` into an `EntityRef[]`. Composes via
 * array spread:
 *
 *   reads: [
 *     ...readsFor<Entities>("User", [alice, bob]),
 *     ...readsFor<Entities>("Position", positionIds),
 *     { entityType: "Futures", id: "0" },
 *   ]
 */
export function readsFor<
  TEntities = AugmentedEntities,
  K extends EntityKey<TEntities> = EntityKey<TEntities>,
>(entityType: K, ids: readonly string[]): EntityRef<TEntities>[] {
  return ids.map((id) => ({ entityType, id }));
}

/** Single {@link EntityRef} — use in `index([read("Counter", "0")])`. */
export function read<
  TEntities = AugmentedEntities,
  K extends EntityKey<TEntities> = EntityKey<TEntities>,
>(entityType: K, id: string): EntityRef<TEntities> {
  return { entityType, id };
}

/** Entity shape for one ref: found row or `null` if requested but missing. */
export type EntityForRef<TEntities, R extends EntityRef<TEntities>> = R extends {
  entityType: infer K;
}
  ? K extends EntityKey<TEntities>
    ? TEntities[K] | null
    : never
  : never;

/** Tuple/array of entities aligned 1:1 with the refs passed to `index()`. */
export type IndexResults<TEntities, R extends readonly EntityRef<TEntities>[]> = {
  readonly [I in keyof R]: EntityForRef<TEntities, R[I]>;
};

/** Map a {@link Snapshot} to index results in the same order as `reads`. */
export function indexResultsFromSnapshot<
  TEntities,
  const R extends readonly EntityRef<TEntities>[],
>(snapshot: Snapshot<TEntities>, reads: R): IndexResults<TEntities, R> {
  const results = reads.map((ref) => {
    const entity = snapshot.entity(ref.entityType, ref.id);
    return entity === undefined ? null : entity;
  });
  return results as IndexResults<TEntities, R>;
}

/**
 * Friendly typed wrapper around the raw snapshot dict.
 *
 * Field values are typed JSON: BigInt / Bytes / BigDecimal come back as
 * strings (to avoid precision loss); Int (i32) as numbers; Bool as booleans.
 *
 * With auto-codegen enabled (default), the augmented `Entities` interface
 * supplies field names and per-field types — no generic needed:
 *
 *   const snap = await runMatchstickTest({ ... });
 *   snap.get("Futures", "0", "orderFee");  // typed as string | undefined
 *
 * All accessors return `undefined` when the entity/field was not present in
 * the dump (either not requested or genuinely missing). To distinguish, use
 * `requested(type, id)`: `false` = not in the reads list, `null` entity
 * value = requested-but-missing.
 */
export class Snapshot<TEntities = AugmentedEntities> {
  private raw: RawSnapshot;
  private manifest: Record<string, string[]>;
  constructor(raw: RawSnapshot, manifest: Record<string, string[]> = {}) {
    this.raw = raw;
    this.manifest = manifest;
  }

  /** Whole entity, or `null` if requested but not found, or
   *  `undefined` if not requested. */
  entity<K extends EntityKey<TEntities>>(
    entityType: K,
    id: string,
  ): TEntities[K] | null | undefined {
    const bucket = this.raw[entityType];
    if (bucket === undefined) return undefined;
    if (!(id in bucket)) return undefined;
    return bucket[id] as TEntities[K] | null;
  }

  /** Single field value, or `undefined` if the entity / field is missing. */
  get<K extends EntityKey<TEntities>, F extends FieldKey<TEntities, K>>(
    entityType: K,
    id: string,
    field: F,
  ): TEntities[K][F] | undefined {
    const e = this.entity(entityType, id);
    if (e === null || e === undefined) return undefined;
    return e[field] as TEntities[K][F] | undefined;
  }

  /** All IDs that were requested *and* found for the given entity type. */
  ids<K extends EntityKey<TEntities>>(entityType: K): string[] {
    const bucket = this.raw[entityType];
    if (!bucket) return [];
    return Object.keys(bucket).filter((id) => bucket[id] !== null);
  }

  /** Number of entities that were requested *and* found for the given type. */
  count<K extends EntityKey<TEntities>>(entityType: K): number {
    return this.ids(entityType).length;
  }

  /** Was this (type, id) included in the read list? */
  requested<K extends EntityKey<TEntities>>(entityType: K, id: string): boolean {
    const bucket = this.raw[entityType];
    return bucket !== undefined && id in bucket;
  }

  /** Was this (type, id) requested *and* found in the store? */
  has<K extends EntityKey<TEntities>>(entityType: K, id: string): boolean {
    return this.entity(entityType, id) != null;
  }

  /**
   * Entities that were saved during the run, discovered via the schema patch.
   * The caller does not need to know IDs upfront — every entity whose
   * `save()` was called is returned here, in save order, deduplicated.
   *
   * Only populated when the generated schema was patched (requires
   * `generatedSchemaPath` to resolve, defaults to `"generated/schema.ts"`).
   *
   * Each returned entity is also present in the snapshot, so `entity()` and
   * `get()` work on it by ID as well.
   *
   * @example
   *   const [order] = snap.saved("Order");
   *   assert.equal(order.amount, "100");
   */
  saved<K extends EntityKey<TEntities>>(entityType: K): NonNullable<TEntities[K]>[] {
    const ids = (this.manifest[entityType as string] as string[] | undefined) ?? [];
    const result: NonNullable<TEntities[K]>[] = [];
    for (const id of ids) {
      const e = this.entity(entityType, id);
      if (e != null) result.push(e as NonNullable<TEntities[K]>);
    }
    return result;
  }
}

/**
 * Run Matchstick against the supplied events, then return a Snapshot of the
 * entities listed in `reads`.
 *
 * Auto-generates the AS runner and the augmenting `entities.d.ts` on every
 * call (idempotent, see `autoCodegen`).
 *
 * @example
 *   const snap = await runMatchstickTest({
 *     events,
 *     reads: [{ entityType: "Futures", id: "0" }],
 *     revertMocks,
 *   });
 *   assert.equal(snap.get("Futures", "0", "orderFee"), "12345");
 */
export async function runMatchstickTest<TEntities = AugmentedEntities>(
  options: RunOptions<TEntities>,
): Promise<Snapshot<TEntities>> {
  const jsonDir = options.jsonDir ?? DEFAULT_TMP_DIR;
  const subgraphYaml = options.subgraphYaml ?? "subgraph.yaml";
  const schemaPath = options.schemaPath ?? "schema.graphql";
  const runnerPath = options.runnerPath ?? "tests/runner.test.ts";
  const typesPath = options.typesPath ?? join(jsonDir, "entities.d.ts");
  // Default to the conventional graph-codegen output location. Pass an empty
  // string to disable patching entirely.
  const generatedSchemaPath = options.generatedSchemaPath ?? "generated/schema.ts";

  if (options.autoCodegen !== false) {
    // Both generators write only if content changed, so this is cheap on the
    // hot path: subgraph.yaml / schema.graphql parses + a couple of stats.
    await Promise.all([
      generateRunner({ subgraphYamlPath: subgraphYaml, outputPath: runnerPath, tempDir: jsonDir }),
      generateEntities({ schemaPath, outputPath: typesPath, subgraphYamlPath: subgraphYaml }),
    ]);
  }

  await mkdir(jsonDir, { recursive: true });
  await writeFile(join(jsonDir, "events.json"), JSON.stringify(options.events, null, 2));
  await writeFile(join(jsonDir, "reads.json"), JSON.stringify(options.reads, null, 2));
  const mergedCallMocks = [...(options.callMocks ?? []), ...(options.revertMocks ?? [])];
  await writeFile(join(jsonDir, "mocks.json"), JSON.stringify(mergedCallMocks, null, 2));

  // Patch generated/schema.ts so every save() also calls trackSave(type, id).
  // The original is restored in the finally block regardless of outcome.
  let originalGeneratedSchema: string | null = null;
  if (generatedSchemaPath) {
    originalGeneratedSchema = await readFile(generatedSchemaPath, "utf8").catch(() => null);
    if (originalGeneratedSchema !== null) {
      await writeFile(generatedSchemaPath, patchGeneratedSchema(originalGeneratedSchema));
    }
  }

  // `graph test` resolves test files relative to `tests/`, by basename.
  const runnerArg = runnerPath.replace(/^tests\//, "").replace(/\.test\.ts$/, "");

  let output = "";
  let stderr = "";
  let exitCode: number | null = null;

  try {
    const proc = spawn("graph", ["test", runnerArg], {
      env: { ...process.env, RUST_BACKTRACE: "1" },
    });

    for await (const chunk of proc.stdout ?? []) {
      output += chunk;
    }

    for await (const chunk of proc.stderr ?? []) {
      stderr += chunk;
    }

    [exitCode] = await once(proc, "exit");
  } finally {
    if (originalGeneratedSchema !== null) {
      await writeFile(generatedSchemaPath, originalGeneratedSchema);
    }
  }

  const verbose = matchstickVerbose(options);

  if (exitCode !== 0) {
    printMatchstickOutput(output, stderr);
    throw new Error(`Matchstick failed with exit code ${exitCode}`);
  }

  if (verbose) {
    printMatchstickOutput(output, stderr);
  }

  const match = output.match(/SNAPSHOT:\s*(.+)/);
  if (!match) {
    throw new Error("No SNAPSHOT line found in Matchstick output");
  }

  let raw: RawSnapshot;
  try {
    raw = JSON.parse(match[1]) as RawSnapshot;
  } catch (err) {
    throw new Error(`Failed to parse snapshot JSON: ${match[1]}\nError: ${err}`);
  }

  const manifestMatch = output.match(/MANIFEST:\s*(.+)/);
  let manifest: Record<string, string[]> = {};
  if (manifestMatch) {
    try {
      manifest = JSON.parse(manifestMatch[1]) as Record<string, string[]>;
    } catch {
      // Tolerate a malformed MANIFEST line — discoveredIds() returns [] for all types.
    }
  }

  if (process.env.DEBUG_SNAPSHOT) {
    console.log("Snapshot:", JSON.stringify(raw, null, 2));
    console.log("Manifest:", JSON.stringify(manifest, null, 2));
  }

  if (options.cleanup !== false) {
    await cleanupJsonFiles(jsonDir);
  }

  return new Snapshot<TEntities>(raw, manifest);
}

/**
 * Remove the JSON IO files written by `runMatchstickTest`. Honors the
 * `KEEP_TEMP=1` env var (set by `test:integration:debug` scripts).
 *
 * Per-call cleanup — leaves the auto-generated `tests/runner.test.ts` and
 * `entities.d.ts` in place so subsequent `runMatchstickTest` calls can reuse
 * them. Use {@link cleanupGeneratedFiles} from an `after()` hook to nuke
 * everything once the test suite is done.
 */
export async function cleanupJsonFiles(jsonDir: string): Promise<void> {
  if (process.env.KEEP_TEMP) {
    console.log(`Keeping generated files in: ${jsonDir}`);
    return;
  }

  await rm(join(jsonDir, "events.json"), { force: true });
  await rm(join(jsonDir, "reads.json"), { force: true });
  await rm(join(jsonDir, "mocks.json"), { force: true });
}

/**
 * Remove every file the matchstick-ts codegen + runner produce: the
 * auto-generated AS runner test file and the entire JSON IO directory
 * (which includes the leftover `entities.d.ts` augmentation file).
 *
 * Call this from an `after()` hook so `graph test` doesn't pick up the
 * runner.test.ts during a subsequent unit-test run. Honors `KEEP_TEMP=1`.
 *
 * `SubgraphLogSync.reset()` invokes this with the indexer's configured
 * paths, so the typical consumer just writes `after(() => conn.matchstick.reset())`.
 */
export async function cleanupGeneratedFiles(opts: {
  runnerPath?: string;
  jsonDir?: string;
}): Promise<void> {
  if (process.env.KEEP_TEMP) {
    console.log(
      `Keeping generated files: ${opts.runnerPath ?? "<no runner>"} ${opts.jsonDir ?? "<no jsonDir>"}`,
    );
    return;
  }

  const tasks: Promise<unknown>[] = [];
  if (opts.runnerPath !== undefined) {
    tasks.push(rm(opts.runnerPath, { force: true }));
  }
  if (opts.jsonDir !== undefined) {
    tasks.push(rm(opts.jsonDir, { recursive: true, force: true }));
  }
  await Promise.all(tasks);
}
