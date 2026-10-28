/**
 * AssemblyScript runtime for the matchstick-ts matchstick runner.
 *
 * Imported from the generated `tests/runner.test.ts` and compiled into the
 * matchstick WASM module. Exposes:
 *   - `createMockEvent<T>(params)` — turn a JSON params blob into a typed `ethereum.Event`
 *   - `valueToJson` / `entityToJson` — serialize a store `Entity` back to JSON
 *   - `JSONObjectBuilder` + `jsonString`/`jsonBool`/... — tiny JSON writer
 *   - `address` / `uint` / `int` / `bytes` / `bool` — sugar constructors for
 *     hand-rolled tests that build events directly
 */
import {
  Address,
  BigDecimal,
  BigInt,
  Bytes,
  Entity,
  Value,
  ValueKind,
  ethereum,
  JSONValue,
  JSONValueKind,
} from "@graphprotocol/graph-ts";
import { newMockEvent } from "matchstick-as/assembly/index";

/**
 * Create a mock event from an ordered params array, optionally overriding
 * the receipt-derived fields on the underlying matchstick mock event.
 *
 * Wire format (emitted by `serializeParams` on the TS side):
 *   params: [["name1", value1], ["name2", value2], ...]
 *
 * An array (not an object) is required because `graph-ts`'s
 * `JSONValue.toObject()` does NOT preserve insertion order, while generated
 * AS event classes access `event.parameters[i]` positionally. The `name`
 * field is forwarded to `ethereum.EventParam` purely for inspection — it
 * does not affect dispatch.
 *
 * The remaining args are decimal/hex strings (not `BigInt`/`Bytes`/`Address`)
 * to make this callable from generated runner code that has already pulled
 * scalars out of a `JSONValue`. An empty string means "leave the matchstick
 * default in place" — preserves backward compatibility with hand-rolled
 * single-arg call sites.
 *
 * @param params - ordered ABI params array
 * @param transactionHashHex - "0x..." 32-byte hash to assign to `event.transaction.hash`
 * @param blockNumberStr - decimal block number to assign to `event.block.number`
 * @param logIndexStr - decimal log index to assign to `event.logIndex`
 * @param addressHex - "0x..." 20-byte address to assign to `event.address`
 * @param blockTimestampStr - decimal unix seconds to assign to `event.block.timestamp`
 */
export function createMockEvent<T extends ethereum.Event>(
  params: JSONValue,
  transactionHashHex: string = "",
  blockNumberStr: string = "",
  logIndexStr: string = "",
  addressHex: string = "",
  blockTimestampStr: string = "",
): T {
  const entries = params.toArray();
  const eventParams: ethereum.EventParam[] = [];

  for (let i = 0; i < entries.length; i++) {
    const pair = entries[i].toArray();
    const name = pair[0].toString();
    const ethValue = jsonValueToEthereumValue(pair[1]);
    eventParams.push(new ethereum.EventParam(name, ethValue));
  }

  const event = newMockEvent();
  event.parameters = eventParams;

  if (transactionHashHex.length > 0) {
    event.transaction.hash = Bytes.fromHexString(transactionHashHex) as Bytes;
  }
  if (blockNumberStr.length > 0) {
    event.block.number = BigInt.fromString(blockNumberStr);
  }
  if (logIndexStr.length > 0) {
    event.logIndex = BigInt.fromString(logIndexStr);
  }
  if (addressHex.length > 0) {
    event.address = Address.fromString(addressHex);
  }
  if (blockTimestampStr.length > 0) {
    event.block.timestamp = BigInt.fromString(blockTimestampStr);
  }

  setCurrentBlock(event.block.number.toI64(), event.block.timestamp.toI64());

  return changetype<T>(event);
}

/**
 * Create the `ethereum.Block` passed to a block handler: matchstick's default
 * mock block with `number` / `timestamp` overridden (empty string = keep the
 * default), mirroring {@link createMockEvent}.
 */
export function createMockBlock(
  blockNumberStr: string = "",
  blockTimestampStr: string = "",
): ethereum.Block {
  const block = newMockEvent().block;
  if (blockNumberStr.length > 0) {
    block.number = BigInt.fromString(blockNumberStr);
  }
  if (blockTimestampStr.length > 0) {
    block.timestamp = BigInt.fromString(blockTimestampStr);
  }

  setCurrentBlock(block.number.toI64(), block.timestamp.toI64());

  return block;
}

/**
 * AssemblyScript-friendly check whether a string is non-empty and digits only.
 * (AS doesn't support JS regex literals reliably.)
 */
function isDigitsOnly(str: string): boolean {
  if (str.length == 0) return false;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/**
 * Convert a JSON value to an Ethereum value.
 */
function jsonValueToEthereumValue(value: JSONValue): ethereum.Value {
  if (value.kind == JSONValueKind.STRING) {
    const str = value.toString();
    if (str.startsWith("0x") && str.length == 42) {
      return ethereum.Value.fromAddress(Address.fromString(str));
    }
    if (isDigitsOnly(str)) {
      return ethereum.Value.fromUnsignedBigInt(BigInt.fromString(str));
    }
    // Negative signed integer — int256 pnl fields serialize as e.g. "-12345"
    if (str.length > 1 && str.charCodeAt(0) == 45 /* '-' */ && isDigitsOnly(str.slice(1))) {
      return ethereum.Value.fromSignedBigInt(BigInt.fromString(str));
    }
    if (str.startsWith("0x")) {
      return ethereum.Value.fromBytes(Bytes.fromHexString(str) as Bytes);
    }
    return ethereum.Value.fromString(str);
  }
  if (value.kind == JSONValueKind.NUMBER) {
    return ethereum.Value.fromSignedBigInt(BigInt.fromI64(value.toI64()));
  }
  if (value.kind == JSONValueKind.BOOL) {
    return ethereum.Value.fromBoolean(value.toBool());
  }
  if (value.kind == JSONValueKind.ARRAY) {
    // Treated as a Solidity tuple (struct). The TS-side serializer encodes
    // both tuples and dynamic arrays as JSON arrays — the AS-generated event
    // class then calls .toTuple() on the wrapper to get the struct back.
    const arr = value.toArray();
    const tuple = new ethereum.Tuple();
    for (let i = 0; i < arr.length; i++) {
      tuple.push(jsonValueToEthereumValue(arr[i]));
    }
    return ethereum.Value.fromTuple(tuple);
  }
  return ethereum.Value.fromString(value.toString());
}

/**
 * Convert a `(solidityType, jsonValue)` pair to an `ethereum.Value` using
 * the solidity type as the authoritative decoder — unlike
 * {@link jsonValueToEthereumValue} which heuristically inspects the JSON
 * string. Used to materialize the `returns: ...` payload of `CallReturnMock`
 * entries into the typed values matchstick's `createMockedFunction(...).returns([...])`
 * expects.
 *
 * Only flat scalar types are supported (the wire format only carries flat
 * scalars). Tuples and arrays should be flattened on the TS side before
 * being passed across.
 */
export function ethereumValueFromTypedJson(
  solidityType: string,
  value: JSONValue,
): ethereum.Value {
  if (solidityType == "address") {
    return ethereum.Value.fromAddress(Address.fromString(value.toString()));
  }
  if (solidityType == "bool") {
    if (value.kind == JSONValueKind.BOOL) return ethereum.Value.fromBoolean(value.toBool());
    return ethereum.Value.fromBoolean(value.toString() == "true");
  }
  if (solidityType == "string") {
    return ethereum.Value.fromString(value.toString());
  }
  if (solidityType.startsWith("uint")) {
    const s = value.kind == JSONValueKind.NUMBER ? value.toI64().toString() : value.toString();
    return ethereum.Value.fromUnsignedBigInt(BigInt.fromString(s));
  }
  if (solidityType.startsWith("int")) {
    const s = value.kind == JSONValueKind.NUMBER ? value.toI64().toString() : value.toString();
    return ethereum.Value.fromSignedBigInt(BigInt.fromString(s));
  }
  if (solidityType == "bytes" || solidityType.startsWith("bytes")) {
    return ethereum.Value.fromBytes(Bytes.fromHexString(value.toString()) as Bytes);
  }
  // Unknown / unsupported (tuple, array). Fall back to heuristic decoding so
  // simple cases (e.g. addresses passed as strings) still work.
  return jsonValueToEthereumValue(value);
}

/**
 * Helper to convert string to Address.
 */
export function address(value: string): Address {
  return Address.fromString(value);
}

/**
 * Helper to convert string to unsigned BigInt.
 */
export function uint(value: string): BigInt {
  return BigInt.fromString(value);
}

/**
 * Helper to convert string to signed BigInt.
 */
export function int(value: string): BigInt {
  return BigInt.fromString(value);
}

/**
 * Helper to convert hex string to Bytes.
 */
export function bytes(value: string): Bytes {
  return Bytes.fromHexString(value) as Bytes;
}

/**
 * Helper to convert boolean to Ethereum value.
 */
export function bool(value: boolean): ethereum.Value {
  return ethereum.Value.fromBoolean(value);
}

/* -------------------------------------------------------------------------- *
 * Minimal JSON serializer.
 *
 * graph-ts only exposes a JSON parser (json.fromBytes / JSONValue.toObject)
 * and not a builder API, so we ship a tiny serializer that's good enough for
 * emitting test results back to the orchestrator.
 * -------------------------------------------------------------------------- */

/**
 * Escape a string for use as a JSON string literal (without surrounding quotes).
 */
function escapeJsonString(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c == 0x22 /* " */) out += '\\"';
    else if (c == 0x5c /* \ */) out += "\\\\";
    else if (c == 0x08) out += "\\b";
    else if (c == 0x09) out += "\\t";
    else if (c == 0x0a) out += "\\n";
    else if (c == 0x0c) out += "\\f";
    else if (c == 0x0d) out += "\\r";
    else if (c < 0x20) {
      const hex = c.toString(16);
      out += "\\u" + "0000".substring(0, 4 - hex.length) + hex;
    } else {
      out += s.charAt(i);
    }
  }
  return out;
}

/** Serialize a string as a JSON string (with quotes). */
export function jsonString(s: string): string {
  return '"' + escapeJsonString(s) + '"';
}

/** Serialize a boolean as JSON. */
export function jsonBool(b: boolean): string {
  return b ? "true" : "false";
}

/** Serialize a signed integer as JSON. */
export function jsonNumber(n: i64): string {
  return n.toString();
}

/** Serialize a JSON `null`. */
export function jsonNull(): string {
  return "null";
}

/** Serialize an array of pre-serialized JSON values. */
export function jsonArray(items: Array<string>): string {
  return "[" + items.join(",") + "]";
}

/**
 * Builder for JSON objects. Each `set*` method appends a key/value pair and
 * returns `this` for chaining; `toString()` finalizes the object literal.
 */
export class JSONObjectBuilder {
  private parts: Array<string> = [];

  setString(key: string, value: string): JSONObjectBuilder {
    this.parts.push(jsonString(key) + ":" + jsonString(value));
    return this;
  }

  setBool(key: string, value: boolean): JSONObjectBuilder {
    this.parts.push(jsonString(key) + ":" + jsonBool(value));
    return this;
  }

  setNumber(key: string, value: i64): JSONObjectBuilder {
    this.parts.push(jsonString(key) + ":" + jsonNumber(value));
    return this;
  }

  setRaw(key: string, value: string): JSONObjectBuilder {
    this.parts.push(jsonString(key) + ":" + value);
    return this;
  }

  toString(): string {
    return "{" + this.parts.join(",") + "}";
  }
}

/* -------------------------------------------------------------------------- *
 * Entity → JSON serialization.
 *
 * Used by the runner to ship a snapshot of the matchstick store back to the
 * orchestrator. Each `Value` is serialized to its most idiomatic JSON shape:
 *   - String/Bytes/BigInt/BigDecimal/Int8/Timestamp → JSON string
 *     (i64 and BigInt would lose precision as JSON numbers)
 *   - Int (i32)                                     → JSON number
 *   - Bool                                          → JSON bool
 *   - Array                                         → JSON array (recursive)
 *   - Null                                          → JSON null
 * -------------------------------------------------------------------------- */

export function valueToJson(value: Value): string {
  if (value.kind == ValueKind.STRING) {
    return jsonString(value.toString());
  }
  if (value.kind == ValueKind.INT) {
    return jsonNumber(value.toI32() as i64);
  }
  if (value.kind == ValueKind.INT8 || value.kind == ValueKind.TIMESTAMP) {
    return jsonString(value.toI64().toString());
  }
  if (value.kind == ValueKind.BIGDECIMAL) {
    return jsonString(value.toBigDecimal().toString());
  }
  if (value.kind == ValueKind.BOOL) {
    return jsonBool(value.toBoolean());
  }
  if (value.kind == ValueKind.BYTES) {
    return jsonString(value.toBytes().toHexString());
  }
  if (value.kind == ValueKind.BIGINT) {
    return jsonString(value.toBigInt().toString());
  }
  if (value.kind == ValueKind.ARRAY) {
    const arr = value.toArray();
    const items: Array<string> = [];
    for (let i = 0; i < arr.length; i++) {
      items.push(valueToJson(arr[i]));
    }
    return jsonArray(items);
  }
  return jsonNull();
}

/** Serialize every field on an Entity as a JSON object. */
export function entityToJson(entity: Entity): string {
  const builder = new JSONObjectBuilder();
  const entries = entity.entries;
  for (let i = 0; i < entries.length; i++) {
    builder.setRaw(entries[i].key, valueToJson(entries[i].value));
  }
  return builder.toString();
}

/* -------------------------------------------------------------------------- *
 * Entity ID tracker.
 *
 * The generated schema's save() methods are patched at test time to call
 * trackSave(entityType, id) alongside store.set(). The runner then reads the
 * tracker via getAllTrackedTypes / getTrackedIdsForType to build the MANIFEST
 * line and include discovered entities in the SNAPSHOT without the caller
 * needing to know IDs upfront.
 *
 * The module-level Map is reset automatically on each fresh WASM instantiation
 * (i.e. each graph test run), so no explicit reset is needed.
 * -------------------------------------------------------------------------- */

let _tracker = new Map<string, Array<string>>();
// Parallel set for O(1) dedup: prevents an entity saved multiple times in one
// handler from appearing more than once in the manifest.
let _trackerSeen = new Map<string, Set<string>>();

/** Called by the patched save() — records (entityType, id) in the tracker. */
export function trackSave(entityType: string, id: string): void {
  if (!_tracker.has(entityType)) {
    _tracker.set(entityType, new Array<string>());
    _trackerSeen.set(entityType, new Set<string>());
  }
  if (!_trackerSeen.get(entityType).has(id)) {
    _tracker.get(entityType).push(id);
    _trackerSeen.get(entityType).add(id);
  }
}

/** Returns all entity types that had at least one save tracked. */
export function getAllTrackedTypes(): Array<string> {
  return _tracker.keys();
}

/** Returns all tracked IDs for the given entity type (empty array if none). */
export function getTrackedIdsForType(entityType: string): Array<string> {
  if (_tracker.has(entityType)) {
    return _tracker.get(entityType);
  }
  return new Array<string>();
}

/* -------------------------------------------------------------------------- *
 * Timeseries emulation.
 *
 * graph-node ignores the `id` and `timestamp` a mapping sets on an
 * `@entity(timeseries: true)` row and assigns them in `store.set`:
 *   - id        = (blockNumber << 32) | seq, where seq counts saves of any
 *                 timeseries type within the block, starting at 0
 *                 (Bytes ids: 4-byte BE block ++ 4-byte BE seq)
 *   - timestamp = block time in microseconds since the epoch
 * matchstick does neither, so the patched generated schema calls
 * `assignTimeseriesFields` before `store.set` for timeseries types.
 *
 * The timestamp is written as Int8 rather than Timestamp because matchstick
 * 0.6.0 rejects StoreValueKind 9; the payload is the same i64.
 * -------------------------------------------------------------------------- */

let _blockNumber: i64 = 0;
let _blockTimestamp: i64 = 0;
let _seqBlock: i64 = -1;
let _seq: i64 = 0;

/** Record the block the next handler runs in. Called by `createMockEvent`. */
export function setCurrentBlock(blockNumber: i64, blockTimestamp: i64): void {
  _blockNumber = blockNumber;
  _blockTimestamp = blockTimestamp;
}

/**
 * Overwrite `id` and `timestamp` on a timeseries entity the way graph-node
 * does, and return the store key to save it under.
 */
export function assignTimeseriesFields(entity: Entity): string {
  if (_seqBlock != _blockNumber) {
    _seqBlock = _blockNumber;
    _seq = 0;
  }
  const seq = _seq;
  _seq += 1;

  entity.set("timestamp", Value.fromI64(_blockTimestamp * 1000000));

  const current = entity.get("id");
  if (current != null && current.kind == ValueKind.BYTES) {
    const id = new Bytes(8);
    for (let i = 0; i < 4; i++) {
      id[i] = u8((_blockNumber >> (8 * (3 - i))) & 0xff);
      id[4 + i] = u8((seq >> (8 * (3 - i))) & 0xff);
    }
    entity.set("id", Value.fromBytes(id));
    return id.toHexString();
  }

  const id = (_blockNumber << 32) | seq;
  entity.set("id", Value.fromI64(id));
  return id.toString();
}

/* -------------------------------------------------------------------------- *
 * Context overrides.
 *
 * `runMatchstickTest` writes `context.json` entries as `{ type, data }` with
 * manifest context types. `data` is a string for every scalar (so i64 and
 * 256-bit values keep their precision), a boolean for Bool, and an array of
 * entries for List. Mirrors `contextValueExpr` in
 * `src/codegen/generate-runner.ts`, which handles the manifest's own values.
 * -------------------------------------------------------------------------- */

/** Convert one `{ type, data }` context entry to the `Value` stored in `DataSourceContext`. */
export function contextValueFromJson(entry: JSONValue): Value {
  const obj = entry.toObject();
  const type = obj.get("type")!.toString();
  const data = obj.get("data")!;

  if (type == "String") return Value.fromString(data.toString());
  if (type == "Bytes") return Value.fromBytes(Bytes.fromHexString(data.toString()) as Bytes);
  if (type == "BigInt") return Value.fromBigInt(BigInt.fromString(data.toString()));
  if (type == "BigDecimal") return Value.fromBigDecimal(BigDecimal.fromString(data.toString()));
  if (type == "Int") return Value.fromI32(BigInt.fromString(data.toString()).toI32());
  if (type == "Int8") return Value.fromI64(BigInt.fromString(data.toString()).toI64());
  if (type == "Bool" || type == "Boolean") return Value.fromBoolean(data.toBool());
  if (type == "List") {
    const items = data.toArray();
    const values = new Array<Value>(items.length);
    for (let i = 0; i < items.length; i++) {
      values[i] = contextValueFromJson(items[i]);
    }
    return Value.fromArray(values);
  }
  abort("matchstick-ts: unsupported context override type " + type);
  return Value.fromString("");
}
