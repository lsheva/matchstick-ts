/**
 * ABI bridge for `ethereum.call` integration.
 *
 * graph-ts call-sites pass a function "signature" string in
 * graph-cli's compact format:
 *
 *   "balanceOf(address):(uint256)"
 *   "transfer(address,uint256):(bool)"
 *   "collateralVault():(address)"
 *
 * That's the same shape graph-cli's codegen emits when it generates
 * `try_*` wrappers for contract ABIs. We parse it into a viem-shaped
 * `AbiParameter[]` for inputs and outputs so we can lean on viem's
 * encoders (`encodeAbiParameters` / `decodeAbiParameters`) and
 * selector helper (`toFunctionSelector`) for the ABI side, instead of
 * shipping our own ABI codec.
 *
 * The other half of this module is the `ethereum.Value` <-> JS bridge:
 *
 *   - `ethereumValueToJs(rt, valuePtr, abiType)` reads an
 *     `ethereum.Value` ptr from wasm memory and produces a JS value
 *     in the shape viem expects for that ABI type (addresses /
 *     bytes -> `0x...` hex, ints -> `bigint`, bool -> `boolean`,
 *     string -> `string`).
 *   - `jsToValuePtr(builder, js, abiType)` takes a JS value (in
 *     viem's output shape) plus an ABI type and allocates the
 *     corresponding `ethereum.Value` in wasm via `EventBuilder`.
 *
 * Tuples and nested arrays of tuples aren't supported yet — they
 * throw `NotSupportedAbiTypeError` so the user sees the precise
 * unsupported type rather than a silent encoding bug. Most subgraph
 * `eth_call`s return primitives; tuples/arrays land in a future step
 * once a real test needs them.
 */
import {
  decodeAbiParameters,
  encodeAbiParameters,
  toFunctionSelector,
  type AbiParameter,
  type Hex,
} from "viem";
import type { EventBuilder } from "./event-builder.ts";
import { readAsString } from "./codec.ts";
import { decodeSignedBigInt } from "./decode.ts";

/** ethereum.ValueKind tags (chain/ethereum.ts in graph-ts). */
const ETH_VALUE_KIND_ADDRESS = 0;
const ETH_VALUE_KIND_FIXED_BYTES = 1;
const ETH_VALUE_KIND_BYTES = 2;
const ETH_VALUE_KIND_INT = 3;
const ETH_VALUE_KIND_UINT = 4;
const ETH_VALUE_KIND_BOOL = 5;
const ETH_VALUE_KIND_STRING = 6;

/** Thrown when the ABI string contains a type our bridge can't translate. */
export class UnsupportedAbiTypeError extends Error {
  readonly abiType: string;
  constructor(abiType: string) {
    super(`abi: unsupported type "${abiType}"`);
    this.name = "UnsupportedAbiTypeError";
    this.abiType = abiType;
  }
}

/** Thrown when `parseGraphSignature` can't make sense of the input. */
export class GraphSignatureParseError extends Error {
  constructor(signature: string) {
    super(`abi: cannot parse graph-ts signature: "${signature}"`);
    this.name = "GraphSignatureParseError";
  }
}

export interface ParsedSignature {
  /** Function name (e.g. "balanceOf"). */
  name: string;
  /** Inputs as viem `AbiParameter[]`. */
  inputs: AbiParameter[];
  /** Outputs as viem `AbiParameter[]`. */
  outputs: AbiParameter[];
  /** Canonical form `name(t1,t2,...)` — fed to `toFunctionSelector`. */
  canonical: string;
  /** 4-byte selector, hex prefixed. */
  selector: Hex;
}

/**
 * Parse a graph-cli-style signature string into viem-shaped inputs +
 * outputs and pre-compute the 4-byte selector.
 */
export function parseGraphSignature(signature: string): ParsedSignature {
  const trimmed = signature.trim();
  // Match "name(inputs):(outputs)" — `inputs` and `outputs` may be empty.
  const match = /^([a-zA-Z_$][a-zA-Z0-9_$]*)\((.*?)\):\((.*)\)$/.exec(trimmed);
  if (!match) throw new GraphSignatureParseError(signature);
  const [, name, inputStr, outputStr] = match;
  const inputs = splitTopLevel(inputStr).map<AbiParameter>((type) => ({
    type: type.trim(),
    name: "",
  }));
  const outputs = splitTopLevel(outputStr).map<AbiParameter>((type) => ({
    type: type.trim(),
    name: "",
  }));
  const canonical = `${name}(${inputs.map((i) => i.type).join(",")})`;
  const selector = toFunctionSelector(canonical);
  return { name, inputs, outputs, canonical, selector };
}

/**
 * Split a comma-separated type list at the top level only. Handles
 * nested tuple parens (e.g. `"address,(uint256,bool),uint256"`) and
 * array brackets (`"uint256[][]"`) without breaking inside them. Empty
 * input returns an empty list (zero-arg / zero-output functions).
 */
function splitTopLevel(s: string): string[] {
  const trimmed = s.trim();
  if (trimmed === "") return [];
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(trimmed.slice(start, i));
      start = i + 1;
    }
  }
  out.push(trimmed.slice(start));
  return out;
}

/**
 * Subset of the loader's exports the value bridge needs. Same shape
 * the host uses; kept narrow so tests can pass mocks.
 */
export interface AbiRuntime {
  memory: WebAssembly.Memory;
  __getArray(ptr: number): number[];
}

/**
 * Read a graph-ts `Uint8Array` / `Bytes` payload by pointer. Uses the
 * `ArrayBufferView` header layout directly so subclasses (`Bytes`,
 * `Address`, `BigInt`) all work — same trick `host.ts` uses.
 */
function readBytes(rt: AbiRuntime, ptr: number): Uint8Array {
  const u32 = new Uint32Array(rt.memory.buffer);
  const dataStart = u32[(ptr + 4) >>> 2];
  const byteLength = u32[(ptr + 8) >>> 2];
  return new Uint8Array(rt.memory.buffer, dataStart, byteLength);
}

function bytesToHex(bytes: Uint8Array): Hex {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s as Hex;
}

/**
 * Decode an `ethereum.Value` ptr into the JS shape viem expects for
 * the given ABI type. The output is suitable for direct use as an
 * argument to `encodeAbiParameters`.
 */
export function ethereumValueToJs(
  rt: AbiRuntime,
  valuePtr: number,
  abiType: string,
): unknown {
  const u32 = new Uint32Array(rt.memory.buffer);
  const kind = u32[valuePtr >>> 2];
  const dataLo = u32[(valuePtr + 8) >>> 2];

  if (abiType === "address") {
    expectKind(kind, ETH_VALUE_KIND_ADDRESS, abiType);
    return bytesToHex(readBytes(rt, dataLo));
  }
  if (abiType === "bytes") {
    expectKind(kind, ETH_VALUE_KIND_BYTES, abiType);
    return bytesToHex(readBytes(rt, dataLo));
  }
  if (/^bytes\d+$/.test(abiType)) {
    expectKind(kind, ETH_VALUE_KIND_FIXED_BYTES, abiType);
    return bytesToHex(readBytes(rt, dataLo));
  }
  if (/^u?int\d*$/.test(abiType)) {
    // graph-ts encodes both signed and unsigned ints as the same
    // signed-twos-complement byte layout on the wire. Decode either
    // INT or UINT — `decodeSignedBigInt` correctly handles both
    // (uints get a leading 0x00 byte during encode if their MSB is set).
    if (kind !== ETH_VALUE_KIND_INT && kind !== ETH_VALUE_KIND_UINT) {
      throw new Error(
        `abi: expected ethereum.Value of kind INT/UINT for "${abiType}", got kind=${kind}`,
      );
    }
    return decodeSignedBigInt(readBytes(rt, dataLo));
  }
  if (abiType === "bool") {
    expectKind(kind, ETH_VALUE_KIND_BOOL, abiType);
    return dataLo !== 0;
  }
  if (abiType === "string") {
    expectKind(kind, ETH_VALUE_KIND_STRING, abiType);
    return readAsString(rt.memory, dataLo);
  }
  // `T[]` / `T[N]` arrays of supported primitives.
  const arrayMatch = /^(.+)\[(\d*)\]$/.exec(abiType);
  if (arrayMatch) {
    const elemType = arrayMatch[1];
    // ARRAY=8 / FIXED_ARRAY=7 / TUPLE=9 all carry an `Array<Value>`
    // ptr in dataLo, so reading is uniform regardless of kind.
    const ptrs = rt.__getArray(dataLo);
    return ptrs.map((p) => ethereumValueToJs(rt, p, elemType));
  }
  throw new UnsupportedAbiTypeError(abiType);
}

function expectKind(kind: number, expected: number, abiType: string): void {
  if (kind !== expected) {
    throw new Error(
      `abi: expected ethereum.Value kind=${expected} for "${abiType}", got kind=${kind}`,
    );
  }
}

/**
 * Allocate an `ethereum.Value` for `js` matching the ABI type, using
 * the bound `EventBuilder` for actual wasm allocation. Returns the
 * Value ptr.
 *
 * `js` must be in viem's decoded shape (the result of
 * `decodeAbiParameters`):
 *
 *   address / bytes* -> `0x...` Hex string
 *   uint* / int*     -> `bigint`
 *   bool             -> `boolean`
 *   string           -> `string`
 *   T[] / T[N]       -> `Array<JS-shape-of-T>`
 */
export function jsToValuePtr(
  builder: EventBuilder,
  js: unknown,
  abiType: string,
): number {
  if (abiType === "address") {
    if (typeof js !== "string") {
      throw new Error(`abi: expected hex string for address, got ${typeof js}`);
    }
    return builder.address(js);
  }
  if (abiType === "bytes") {
    if (typeof js !== "string") {
      throw new Error(`abi: expected hex string for bytes, got ${typeof js}`);
    }
    return builder.bytes(js);
  }
  if (/^bytes\d+$/.test(abiType)) {
    if (typeof js !== "string") {
      throw new Error(`abi: expected hex string for ${abiType}, got ${typeof js}`);
    }
    return builder.fixedBytes(js);
  }
  if (/^uint\d*$/.test(abiType)) {
    const n = typeof js === "bigint" ? js : BigInt(js as number | string);
    return builder.unsignedBigInt(n);
  }
  if (/^int\d*$/.test(abiType)) {
    const n = typeof js === "bigint" ? js : BigInt(js as number | string);
    return builder.signedBigInt(n);
  }
  if (abiType === "bool") {
    return builder.bool(Boolean(js));
  }
  if (abiType === "string") {
    return builder.string(String(js));
  }
  const arrayMatch = /^(.+)\[(\d*)\]$/.exec(abiType);
  if (arrayMatch) {
    const elemType = arrayMatch[1];
    const fixed = arrayMatch[2] !== "";
    if (!Array.isArray(js)) {
      throw new Error(`abi: expected array for "${abiType}", got ${typeof js}`);
    }
    const elemPtrs = js.map((v) => jsToValuePtr(builder, v, elemType));
    return fixed ? builder.fixedArray(elemPtrs) : builder.arrayValue(elemPtrs);
  }
  throw new UnsupportedAbiTypeError(abiType);
}

/**
 * Build an `eth_call` calldata hex (`selector || encodedArgs`) for
 * the parsed signature and JS args. Args are in viem's input shape.
 */
export function encodeCalldata(
  parsed: ParsedSignature,
  args: readonly unknown[],
): Hex {
  if (parsed.inputs.length === 0) return parsed.selector;
  const encodedArgs = encodeAbiParameters(parsed.inputs, args);
  // encodedArgs starts with `0x`; strip and concat onto the selector.
  return (parsed.selector + encodedArgs.slice(2)) as Hex;
}

/**
 * Decode an `eth_call` return-data hex into JS values shaped per
 * `parsed.outputs`. Always returns an array (even for single-output
 * functions) so callers can iterate uniformly.
 */
export function decodeReturnData(
  parsed: ParsedSignature,
  returnHex: Hex,
): readonly unknown[] {
  if (parsed.outputs.length === 0) return [];
  return decodeAbiParameters(parsed.outputs, returnHex);
}
