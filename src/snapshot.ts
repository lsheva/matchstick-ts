/**
 * Snapshot harness: runs Matchstick against captured events and returns a
 * typed `Snapshot<TEntities>` containing the requested entities in their JSON
 * shape. All assertion logic stays in the consumer's test file — use
 * `node:assert/strict` (or any matcher library) on the result.
 */
import { spawn } from "node:child_process";
import { writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import type { CapturedEvent, RevertMock } from "./event-capture.ts";
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
 *   declare module "subgraph-snapshot" {
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
 * Resolves to the augmented `Entities` interface if the consumer has
 * generated one, otherwise the loose `DefaultEntityMap`. This is the
 * default generic for `runMatchstickTest` / `Snapshot` — no type
 * argument needed in the typical case.
 */
export type AugmentedEntities = keyof Entities extends never ? DefaultEntityMap : Entities;

// Generics are unconstrained so a closed-shape `interface Entities`
// (which lacks an index signature) can still be passed in.
type EntityKey<T> = Extract<keyof T, string>;
type FieldKey<T, K extends EntityKey<T>> = Extract<keyof T[K], string>;

export interface RunOptions<TEntities = AugmentedEntities> {
  events: CapturedEvent[];
  /** Entities to read out of the store after replay. */
  reads: EntityRef<TEntities>[];
  /**
   * Functions to register as reverting mocks before processing events. Allows
   * handler best-effort `try_*` contract reads to resolve gracefully without
   * Matchstick failing on "no mocked function".
   */
  revertMocks?: RevertMock[];
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
   * for `subgraph-snapshot`'s `Entities` interface). Defaults to
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
   * Whether to remove the JSON IO files after the run completes. Defaults to
   * true. Set `KEEP_TEMP=1` in the environment to override.
   */
  cleanup?: boolean;
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
  constructor(raw: RawSnapshot) {
    this.raw = raw;
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

  if (options.autoCodegen !== false) {
    // Both generators write only if content changed, so this is cheap on the
    // hot path: subgraph.yaml / schema.graphql parses + a couple of stats.
    await Promise.all([
      generateRunner({ subgraphYamlPath: subgraphYaml, outputPath: runnerPath, tempDir: jsonDir }),
      generateEntities({ schemaPath, outputPath: typesPath }),
    ]);
  }

  await mkdir(jsonDir, { recursive: true });
  await writeFile(join(jsonDir, "events.json"), JSON.stringify(options.events, null, 2));
  await writeFile(join(jsonDir, "reads.json"), JSON.stringify(options.reads, null, 2));
  await writeFile(
    join(jsonDir, "mocks.json"),
    JSON.stringify(options.revertMocks ?? [], null, 2),
  );

  // `graph test` resolves test files relative to `tests/`, by basename.
  const runnerArg = runnerPath.replace(/^tests\//, "").replace(/\.test\.ts$/, "");

  const proc = spawn("graph", ["test", runnerArg], {
    env: { ...process.env, RUST_BACKTRACE: "1" },
  });

  let output = "";
  for await (const chunk of proc.stdout ?? []) {
    output += chunk;
  }

  let stderr = "";
  for await (const chunk of proc.stderr ?? []) {
    stderr += chunk;
  }

  const [exitCode] = await once(proc, "exit");

  if (exitCode !== 0) {
    console.log("Matchstick output:", output);
    throw new Error(`Matchstick failed with exit code ${exitCode}:\n${stderr}`);
  }

  const match = output.match(/SNAPSHOT:\s*(.+)/);
  if (!match) {
    throw new Error("No SNAPSHOT line found in Matchstick output");
  }

  let raw: RawSnapshot;
  try {
    raw = JSON.parse(match[1]);
  } catch (err) {
    throw new Error(`Failed to parse snapshot JSON: ${match[1]}\nError: ${err}`);
  }

  if (process.env.DEBUG_SNAPSHOT) {
    console.log("Snapshot:", JSON.stringify(raw, null, 2));
  }

  if (options.cleanup !== false) {
    await cleanupJsonFiles(jsonDir);
  }

  return new Snapshot<TEntities>(raw);
}

/**
 * Remove the JSON IO files written by `runMatchstickTest`. Honors the
 * `KEEP_TEMP=1` env var (set by `test:integration:debug` scripts).
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
