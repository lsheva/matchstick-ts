/**
 * Pure-WebAssembly schema introspection: compile a wasm module without
 * instantiating it, then enumerate its imports and exports.
 *
 * The wasm-runner uses this to:
 *   1. Discover the host-import surface a given subgraph wasm needs, so the
 *      host shim can refuse to instantiate (with a clear error) if any
 *      required import is missing instead of crashing mid-handler.
 *   2. Validate at instantiation time that the runtime exports the AS
 *      helpers (`__new`, `__pin`, `__unpin`, `memory`, `table`) the pointer
 *      codec depends on.
 *   3. Build the handler-name -> export lookup that the event-builder uses
 *      to dispatch events without a string-keyed router inside wasm.
 *
 * Kept dependency-free and side-effect-free so it can be imported from
 * test setup hooks and CI tooling without dragging in the rest of the
 * runner.
 */
import { readFile } from "node:fs/promises";

/**
 * Description of a single wasm import. `kind` mirrors the WebAssembly
 * import descriptor kinds (`function`, `global`, `memory`, `table`).
 */
export interface WasmImport {
  module: string;
  name: string;
  kind: WebAssembly.ImportExportKind;
}

/**
 * Description of a single wasm export, mirroring
 * `WebAssembly.Module.exports`.
 */
export interface WasmExport {
  name: string;
  kind: WebAssembly.ImportExportKind;
}

/**
 * Structured view of a wasm module's external interface. Returned by
 * `inspectWasm`. Handler exports (in the subgraph sense — functions whose
 * name starts with `handle`) are surfaced separately for convenience.
 */
export interface WasmSchema {
  imports: WasmImport[];
  exports: WasmExport[];
  /** Function exports whose name begins with `handle` (e.g. `handleValueSet`). */
  handlerExports: string[];
}

/**
 * Compile (but do not instantiate) the wasm at `source` and return its
 * import/export schema.
 *
 * `source` may be a file path (string), a `URL` pointing at a wasm file,
 * or the raw bytes (`Uint8Array` / `ArrayBuffer` / `Buffer`). Strings and
 * `URL`s are read from disk via `node:fs/promises`.
 */
export async function inspectWasm(
  source: string | URL | Uint8Array | ArrayBuffer,
): Promise<WasmSchema> {
  const bytes = await readBytes(source);
  // Copy into a fresh plain `ArrayBuffer` so the strict
  // `WebAssembly.compile(BufferSource)` overload accepts it. Node's
  // `Buffer` is typed as `Uint8Array<ArrayBufferLike>` (could be
  // SharedArrayBuffer) which TS refuses to narrow.
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ab = new ArrayBuffer(view.byteLength);
  new Uint8Array(ab).set(view);
  const mod = await WebAssembly.compile(ab);

  const imports: WasmImport[] = WebAssembly.Module.imports(mod).map((i) => ({
    module: i.module,
    name: i.name,
    kind: i.kind,
  }));

  const exports: WasmExport[] = WebAssembly.Module.exports(mod).map((e) => ({
    name: e.name,
    kind: e.kind,
  }));

  const handlerExports = exports
    .filter((e) => e.kind === "function" && e.name.startsWith("handle"))
    .map((e) => e.name);

  return { imports, exports, handlerExports };
}

async function readBytes(
  source: string | URL | Uint8Array | ArrayBuffer,
): Promise<Uint8Array | ArrayBuffer> {
  if (typeof source === "string" || source instanceof URL) {
    return await readFile(source);
  }
  return source;
}
