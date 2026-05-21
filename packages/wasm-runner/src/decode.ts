/**
 * Decode graph-ts `Entity` payloads (which are `TypedMap<string, Value>`)
 * from wasm memory into JS values.
 *
 * Memory layout (verified empirically — see `tests/fire-event.test.ts`
 * for the original probe):
 *
 *   Entity  (extends TypedMap<string, Value>)
 *     +0  entries  -> Array<TypedMapEntry<string, Value>>
 *                    (decoded via the loader's `__getArray` so we get an
 *                     RTTI-aware number[] of entry pointers without
 *                     having to walk `dataStart`/`length` by hand)
 *
 *   TypedMapEntry<K, V>
 *     +0  key   K (here: AS string ptr)
 *     +4  value V (here: ethereum.Value ptr)
 *
 *   ethereum.Value
 *     +0  kind  ValueKind (i32)
 *     +4  (padding)
 *     +8  data  u64       (low 32 bits == ptr for pointer-typed kinds)
 *
 * Reading is intentionally tolerant: any unknown `ValueKind` round-trips
 * as `{ __unknown: kind, dataLo, dataHi }` so a test failure points at
 * the specific kind that needs decoder support, instead of throwing in
 * the middle of an otherwise-correct entity walk.
 */
import { readAsString } from "./codec.ts";

/**
 * Mirror of graph-ts `common/value.ts`'s `ValueKind` enum (0.37.0).
 * Declared as a frozen object rather than a TS `enum` because Node's
 * strip-only TS execution mode (`node --test foo.ts`) doesn't support
 * enums. Indexed reads (`ValueKind.STRING`) still work identically.
 */
export const ValueKind = {
  STRING: 0,
  INT: 1,
  BIGDECIMAL: 2,
  BOOL: 3,
  ARRAY: 4,
  NULL: 5,
  BYTES: 6,
  BIGINT: 7,
  INT8: 8,
  TIMESTAMP: 9,
} as const;
export type ValueKind = (typeof ValueKind)[keyof typeof ValueKind];

/**
 * One field of a decoded entity. Mirrors the kinds we currently support;
 * `unknown` is reserved for kinds whose decoder hasn't been written yet
 * (today: BIGDECIMAL, ARRAY) so we don't silently drop data.
 */
export type FieldValue =
  | string
  | bigint
  | boolean
  | null
  | Uint8Array
  | UnknownValue
  | FieldValue[];

export interface UnknownValue {
  __unknown: true;
  kind: number;
  dataLo: number;
  dataHi: number;
}

export type EntityFields = Record<string, FieldValue>;

/**
 * Subset of the loader's exports the decoder actually needs. Kept as a
 * narrow interface so tests can pass mocks (when probing layouts) and
 * the runner can pass a real instance.
 */
export interface DecodeRuntime {
  memory: WebAssembly.Memory;
  __getUint8Array(ptr: number): Uint8Array;
  /**
   * Loader-provided `Array<T>` decoder. For managed-element arrays
   * (`TypedMap.entries` is `Array<TypedMapEntry>`) the returned
   * `number[]` is the raw element pointers — exactly what we want for
   * a manual entry walk.
   */
  __getArray(ptr: number): number[];
}

/**
 * Walk an entity ptr and return the decoded field map. Returns `null`
 * if `ptr === 0` so callers can use this as the universal "load by
 * pointer" path including absent-entity cases.
 */
export function decodeEntity(
  runtime: DecodeRuntime,
  ptr: number,
): EntityFields | null {
  if (ptr === 0) return null;
  const u32 = new Uint32Array(runtime.memory.buffer);
  const entriesPtr = u32[ptr >>> 2];
  if (entriesPtr === 0) return {};

  // `__getArray` reads the Array<T> header (buffer/dataStart/byteLength/length)
  // for us and, for managed-element arrays like `Array<TypedMapEntry>`,
  // returns each element as the raw entry pointer.
  const entryPtrs = runtime.__getArray(entriesPtr);

  const out: EntityFields = {};
  for (const entryPtr of entryPtrs) {
    if (entryPtr === 0) continue;
    const keyPtr = u32[entryPtr >>> 2];
    const valuePtr = u32[(entryPtr + 4) >>> 2];
    const key = readAsString(runtime.memory, keyPtr);
    out[key] = decodeValue(runtime, valuePtr);
  }
  return out;
}

/**
 * Decode a single `ethereum.Value` (graph-ts's `common/value.ts`
 * tagged union). Pointer types pull their payload from `dataLo`;
 * primitive kinds use one of `dataLo` / `dataHi` directly.
 */
export function decodeValue(
  runtime: DecodeRuntime,
  ptr: number,
): FieldValue {
  if (ptr === 0) return null;
  const u32 = new Uint32Array(runtime.memory.buffer);
  const kind = u32[ptr >>> 2];
  const dataLo = u32[(ptr + 8) >>> 2];
  const dataHi = u32[(ptr + 12) >>> 2];

  switch (kind) {
    case ValueKind.STRING:
      return readAsString(runtime.memory, dataLo);
    case ValueKind.INT:
      // graph-ts stores `Int` as i32 in the low word; high word is
      // sign-extension (0 or 0xFFFFFFFF). Treat as a signed 32-bit
      // value, then widen to JS bigint for parity with BIGINT.
      return BigInt(new Int32Array(runtime.memory.buffer)[ptr / 4 + 2]);
    case ValueKind.INT8:
    case ValueKind.TIMESTAMP: {
      // 64-bit signed integers stored as (lo, hi). Reassemble via
      // BigInt64Array on the same offset.
      const bi = new BigInt64Array(runtime.memory.buffer);
      return bi[(ptr + 8) / 8];
    }
    case ValueKind.BOOL:
      return dataLo !== 0;
    case ValueKind.NULL:
      return null;
    case ValueKind.BYTES: {
      const bytes = runtime.__getUint8Array(dataLo);
      // Copy out of the live view; the underlying memory may shift on
      // the next AS allocation and we don't want assertions to silently
      // see a moved buffer.
      return new Uint8Array(bytes);
    }
    case ValueKind.BIGINT: {
      const bytes = runtime.__getUint8Array(dataLo);
      return decodeSignedBigInt(bytes);
    }
    default:
      return { __unknown: true, kind, dataLo, dataHi };
  }
}

/**
 * graph-ts represents `BigInt` as a `Uint8Array` of *signed*
 * little-endian bytes (two's complement). Decode back to a JS
 * `bigint`. Empty array is 0.
 */
export function decodeSignedBigInt(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n;
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  // Sign-extend if the high bit of the most-significant (last) byte
  // is set: subtract 2^(8*N).
  if ((bytes[bytes.length - 1] & 0x80) !== 0) {
    result -= 1n << BigInt(bytes.length * 8);
  }
  return result;
}
