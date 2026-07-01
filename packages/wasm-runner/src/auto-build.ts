/**
 * `ensureBundleBuilt` — process-wide cached wasm compile with a
 * child-process fallback for environments where a global ESM loader
 * hook (tsx, ts-node) is active.
 *
 * Why the fallback exists: AssemblyScript's `cli/asc.js` (CommonJS)
 * calls `require("../package.json")` at load time. Under tsx the
 * loader chain returns a transformed JS bundle for that resolution
 * instead of the raw JSON, and Node's `.json` extension handler
 * crashes with `Unexpected token 'v', "var name="`. Spawning a
 * fresh `node` (no inherited loader hook) sidesteps the issue
 * entirely.
 *
 * Heuristic: in-process compile is tried first; the fallback only
 * fires on errors that look like the tsx-style failure. Any other
 * error (real handler typo, missing dep, etc.) surfaces unchanged.
 *
 * Cache: keyed by `(handlerEntry, debug, outPath)`. A successful
 * build memoizes the resulting path; failed builds are evicted so
 * the next caller retries fresh.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundle, type BuildBundleOptions } from "./build.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..");
const FALLBACK_SCRIPT = resolve(PKG_ROOT, "scripts/build-bundle.mjs");

const cache = new Map<string, Promise<string>>();

/**
 * Deterministic output path under the OS tmpdir. A short hash of
 * the absolute handler-entry keeps the basename stable across runs
 * (so unchanged sources reuse the same `.wasm`) while avoiding
 * collisions between projects.
 */
export function defaultBundleOutPath(handlerEntry: string): string {
  const abs = resolve(handlerEntry);
  const h = createHash("sha256").update(abs).digest("hex").slice(0, 12);
  const stem = basename(abs, extname(abs));
  return resolve(tmpdir(), `wasm-runner-${stem}-${h}.wasm`);
}

/**
 * Build a bundle from `handlerEntry`, returning the absolute output
 * path. Subsequent calls with the same key short-circuit to the
 * same Promise — never compile the same entry twice in one process.
 */
export async function ensureBundleBuilt(opts: {
  handlerEntry: string;
  outPath?: string;
  debug?: boolean;
}): Promise<string> {
  const handlerEntry = resolve(opts.handlerEntry);
  const debug = opts.debug ?? true;
  const outPath = resolve(opts.outPath ?? defaultBundleOutPath(handlerEntry));
  const key = `${handlerEntry}::${debug}::${outPath}`;
  let p = cache.get(key);
  if (!p) {
    p = compileWithFallback({ handlerEntry, outPath, debug });
    cache.set(key, p);
    // Evict on failure so the next caller gets a fresh attempt
    // instead of inheriting the stale rejection.
    p.catch(() => cache.delete(key));
  }
  return p;
}

async function compileWithFallback(opts: BuildBundleOptions): Promise<string> {
  try {
    await buildBundle(opts);
  } catch (err) {
    if (!looksLikeLoaderHookFailure(err)) throw err;
    await spawnChildBuild(opts);
  }
  if (!existsSync(opts.outPath)) {
    throw new Error(
      `wasm-runner: compile produced no output at ${opts.outPath}`,
    );
  }
  return opts.outPath;
}

/**
 * Detect the tsx/ts-node interference pattern. Symptom: Node's JSON
 * extension handler chokes on `assemblyscript/package.json` because
 * the loader chain returned a transformed JS module instead of raw
 * JSON, producing `Unexpected token 'v', "var name=" ...`.
 */
function looksLikeLoaderHookFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const haystack = `${err.message}\n${err.stack ?? ""}`;
  if (/Unexpected token .* "var name=/.test(haystack)) return true;
  if (/assemblyscript[/\\]package\.json/.test(haystack)) {
    return /Unexpected token|JSON\.parse|is not valid JSON/.test(haystack);
  }
  return false;
}

async function spawnChildBuild(opts: BuildBundleOptions): Promise<void> {
  if (!existsSync(FALLBACK_SCRIPT)) {
    throw new Error(
      `wasm-runner: child-process build fallback unavailable — missing ${FALLBACK_SCRIPT}`,
    );
  }
  const args = [
    FALLBACK_SCRIPT,
    "--handler-entry",
    opts.handlerEntry,
    "--out",
    opts.outPath,
  ];
  if (opts.debug === false) args.push("--no-debug");

  // Strip NODE_OPTIONS tokens that would re-install a loader hook
  // in the child (e.g. NODE_OPTIONS="--import tsx"). Other env stays.
  const env = { ...process.env };
  if (env.NODE_OPTIONS) {
    const filtered = env.NODE_OPTIONS.split(/\s+/).filter(
      (tok) =>
        tok.length > 0 &&
        !/^--(?:import|loader|require)[=\s]?.*(?:tsx|ts-node)/.test(tok),
    );
    if (filtered.length === 0) delete env.NODE_OPTIONS;
    else env.NODE_OPTIONS = filtered.join(" ");
  }

  await new Promise<void>((res, rej) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      cwd: PKG_ROOT,
    });
    let stderrBuf = "";
    child.stderr?.on("data", (b) => {
      stderrBuf += b.toString();
    });
    // Drain stdout so backpressure doesn't stall the build script.
    child.stdout?.on("data", () => {});
    child.on("error", rej);
    child.on("exit", (code) => {
      if (code === 0) res();
      else
        rej(
          new Error(
            `wasm-runner: child-process build exited with code ${code}\n${stderrBuf}`,
          ),
        );
    });
  });
}
