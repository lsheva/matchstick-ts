// #region generated:header
/**
 * Template for the matchstick runner that `generateRunner` writes to
 * `tests/runner.test.ts`. The generator copies this file verbatim except for
 * the body of each `// #region generated:<name>` block, which it replaces
 * with code derived from the subgraph manifest. The bodies below are stubs
 * with the same signatures, so the template typechecks on its own.
 */
// #endregion
import { test, clearStore, readFile, createMockedFunction } from "matchstick-as/assembly/index";
import { Address, DataSourceContext, JSONValue, TypedMap, ethereum, json, log, store } from "@graphprotocol/graph-ts";
import {
  contextValueFromJson,
  createMockBlock,
  ethereumValueFromTypedJson,
  JSONObjectBuilder,
  entityToJson,
  getAllTrackedTypes,
  getTrackedIdsForType,
  jsonString,
  jsonArray,
} from "matchstick-ts/assembly";
// #region generated:imports
// #endregion

// #region generated:config
/** Directory `runMatchstickTest` writes `events.json` / `reads.json` / `mocks.json` / `context.json` to. */
const TEMP_DIR = "tests/.tmp";
// #endregion

// #region generated:dispatch
/**
 * Run the block handler `handler` of data source `dsName`, after pointing
 * `dataSource.address()` / `.network()` / `.context()` at that data source.
 */
function dispatchBlock(dsName: string, handler: string, address: string, block: ethereum.Block): void {}

/**
 * Route one captured event to its handler. `dsName` is empty for events
 * captured without a data source; they go to the first data source handling
 * `eventName`.
 */
function dispatchEvent(
  eventName: string,
  dsName: string,
  address: string,
  params: JSONValue,
  txHash: string,
  blockNum: string,
  logIndex: string,
  blockTimestamp: string,
): void {}
// #endregion

/**
 * Per-data-source context overrides from `context.json`:
 * `{ [dataSource]: { [key]: { type, data } } }`. Loaded once per run.
 */
let contextOverrides = new TypedMap<string, JSONValue>();

/** `context` (a data source's manifest context) with its overridden keys replaced. */
function withContextOverrides(dsName: string, context: DataSourceContext): DataSourceContext {
  const override = contextOverrides.get(dsName);
  if (override == null) return context;
  const entries = override!.toObject().entries;
  for (let i = 0; i < entries.length; i++) {
    context.set(entries[i].key, contextValueFromJson(entries[i].value));
  }
  return context;
}

/** Optional string field of a JSON object, or "" when absent. */
function stringField(obj: TypedMap<string, JSONValue>, key: string): string {
  const value = obj.get(key);
  return value != null ? value.toString() : "";
}

/** Optional integer field of a JSON object as a decimal string, or "" when absent. */
function intField(obj: TypedMap<string, JSONValue>, key: string): string {
  const value = obj.get(key);
  return value != null ? value.toI64().toString() : "";
}

test("process events and dump store snapshot", () => {
  clearStore();

  const events = json.fromBytes(readFile(TEMP_DIR + "/events.json")).toArray();
  contextOverrides = json.fromBytes(readFile(TEMP_DIR + "/context.json")).toObject();

  // Install view-call mocks for the reads handlers may perform. Each entry
  // is one of:
  //   { kind: "revert", address, name, signature }
  //   { kind: "return", address, name, signature, outputs: [...], returns: [...] }
  // Entries with no `kind` field default to "revert" for backward compat
  // with pre-v0.4.0 mock payloads.
  const mocks = json.fromBytes(readFile(TEMP_DIR + "/mocks.json")).toArray();
  for (let i = 0; i < mocks.length; i++) {
    const m = mocks[i].toObject();
    const addr = Address.fromString(m.get("address")!.toString());
    const name = m.get("name")!.toString();
    const sig = m.get("signature")!.toString();
    const kind = stringField(m, "kind");

    if (kind == "return") {
      const outputsArr = m.get("outputs")!.toArray();
      const returnsArr = m.get("returns")!.toArray();
      const values: ethereum.Value[] = [];
      for (let j = 0; j < outputsArr.length; j++) {
        values.push(ethereumValueFromTypedJson(outputsArr[j].toString(), returnsArr[j]));
      }
      createMockedFunction(addr, name, sig).returns(values);
    } else {
      createMockedFunction(addr, name, sig).reverts();
    }
  }

  for (let i = 0; i < events.length; i++) {
    const evt = events[i].toObject();
    const dsName = stringField(evt, "dataSource");
    const address = stringField(evt, "address");
    // Receipt-derived fields forwarded onto the matchstick mock event / block
    // so handlers see realistic `block.number` / `block.timestamp` / ...
    // instead of the matchstick-as defaults. "" keeps the default.
    const blockNum = intField(evt, "blockNumber");
    const blockTimestamp = intField(evt, "blockTimestamp");

    if (stringField(evt, "trigger") == "block") {
      const handler = evt.get("handler")!.toString();
      dispatchBlock(dsName, handler, address, createMockBlock(blockNum, blockTimestamp));
      continue;
    }

    // Pass the JSONValue directly — createMockEvent expects the ordered
    // array shape `[[name, value], ...]`. Calling `.toObject()` here would
    // discard ABI order (TypedMap iteration is not insertion-ordered).
    dispatchEvent(
      evt.get("event")!.toString(),
      dsName,
      address,
      evt.get("params")!,
      stringField(evt, "transactionHash"),
      blockNum,
      intField(evt, "logIndex"),
      blockTimestamp,
    );
  }

  // Read the list of (entityType, id) pairs to dump and emit a nested JSON
  // snapshot: { [entityType]: { [id]: { ...fields } | null } }
  // Missing entities are emitted as `null` so the orchestrator can distinguish
  // "asked but not found" from "didn't ask".
  const reads = json.fromBytes(readFile(TEMP_DIR + "/reads.json")).toArray();

  // Group reads by entity type for compact nested output.
  const byType = new Map<string, JSONObjectBuilder>();
  const typeOrder: Array<string> = [];
  // Track seen (entityType:id) pairs to avoid duplicate keys in the JSON output
  // when a tracked entity is also listed in explicit reads.
  const seenIds = new Set<string>();

  for (let i = 0; i < reads.length; i++) {
    const r = reads[i].toObject();
    const entityType = r.get("entityType")!.toString();
    const id = r.get("id")!.toString();

    if (!byType.has(entityType)) {
      byType.set(entityType, new JSONObjectBuilder());
      typeOrder.push(entityType);
    }

    const entity = store.get(entityType, id);
    byType.get(entityType).setRaw(id, entity ? entityToJson(entity) : "null");
    seenIds.add(entityType + ":" + id);
  }

  // Collect entities tracked via trackSave() (injected into save() by the
  // schema patch). Add them to byType so they appear in SNAPSHOT, and emit a
  // separate MANIFEST: line with just the discovered IDs.
  const trackedTypes = getAllTrackedTypes();
  const manifestBuilder = new JSONObjectBuilder();

  for (let t = 0; t < trackedTypes.length; t++) {
    const entityType = trackedTypes[t];
    const trackedIds = getTrackedIdsForType(entityType);
    const idList: Array<string> = [];

    for (let j = 0; j < trackedIds.length; j++) {
      const id = trackedIds[j];
      idList.push(jsonString(id));

      // Only add to SNAPSHOT if not already covered by an explicit read.
      if (!seenIds.has(entityType + ":" + id)) {
        if (!byType.has(entityType)) {
          byType.set(entityType, new JSONObjectBuilder());
          typeOrder.push(entityType);
        }
        const entity = store.get(entityType, id);
        byType.get(entityType).setRaw(id, entity ? entityToJson(entity) : "null");
      }
    }

    manifestBuilder.setRaw(entityType, jsonArray(idList));
  }

  // Pass the JSON as an argument: graph-ts `format` copies the format string
  // one character at a time, which is quadratic in its length.
  log.info("MANIFEST: {}", [manifestBuilder.toString()]);

  const outer = new JSONObjectBuilder();
  for (let i = 0; i < typeOrder.length; i++) {
    const t = typeOrder[i];
    outer.setRaw(t, byType.get(t).toString());
  }

  log.info("SNAPSHOT: {}", [outer.toString()]);
});
