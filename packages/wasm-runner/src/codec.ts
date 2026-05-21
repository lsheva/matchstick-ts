/**
 * Pointer codec for AssemblyScript values in wasm linear memory.
 *
 * Step 2 implements only `readAsString` — needed by the host's `env.abort`
 * shim to decode error messages. The full codec (Bytes, BigInt, Entity,
 * Value, Event, ...) is built out incrementally in later steps as each
 * import is filled in.
 *
 * AssemblyScript object layout (runtime: incremental GC, the default for
 * `asc` 0.19+) puts a 16-byte managed object header *immediately before*
 * the pointer the user code holds. The 4 bytes at `ptr - 4` are the
 * "rtSize" field — the payload size in bytes (UTF-16 code units * 2 for
 * strings). The 4 bytes at `ptr - 8` are the runtime type id (rtId).
 * See https://www.assemblyscript.org/runtime.html#memory-layout.
 *
 * We rely only on `ptr - 4` here. Reading other header fields will be
 * added in `rtti.ts` (Step 4 or so) when the codec grows to need it.
 */

/**
 * Read an AssemblyScript `string` from linear memory.
 *
 * Strings in AS are UTF-16 code units stored back-to-back, with the byte
 * length (NOT the code-unit count) recorded in the 4-byte header slot at
 * `ptr - 4`. A null pointer (ptr === 0) is returned as the empty string,
 * matching how the host typically wants to render absent values in
 * diagnostic output.
 */
export function readAsString(memory: WebAssembly.Memory, ptr: number): string {
  if (ptr === 0) return "";
  const view = new DataView(memory.buffer);
  const byteLen = view.getUint32(ptr - 4, true);
  const codeUnits = new Uint16Array(memory.buffer, ptr, byteLen >>> 1);
  // Build incrementally rather than `String.fromCharCode(...codeUnits)` to
  // avoid stack overflow on long strings (V8 spreads through the call frame).
  let out = "";
  for (let i = 0; i < codeUnits.length; i++) {
    out += String.fromCharCode(codeUnits[i]);
  }
  return out;
}
