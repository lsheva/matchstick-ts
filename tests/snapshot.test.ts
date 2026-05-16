import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Snapshot, readsFor } from "../src/snapshot.ts";

describe("Snapshot", () => {
  const snap = new Snapshot({
    Counter: {
      "0": { id: "0", value: "42" },
      "1": null,
    },
  });

  it("get returns field values for found entities", () => {
    assert.equal(snap.get("Counter", "0", "value"), "42");
  });

  it("entity distinguishes missing vs not-requested", () => {
    assert.deepEqual(snap.entity("Counter", "0"), { id: "0", value: "42" });
    assert.equal(snap.entity("Counter", "1"), null);
    assert.equal(snap.entity("Counter", "2"), undefined);
    assert.equal(snap.entity("Other", "0"), undefined);
  });

  it("ids and count only include found entities", () => {
    assert.deepEqual(snap.ids("Counter"), ["0"]);
    assert.equal(snap.count("Counter"), 1);
  });

  it("requested and has reflect read-list semantics", () => {
    assert.equal(snap.requested("Counter", "1"), true);
    assert.equal(snap.requested("Counter", "2"), false);
    assert.equal(snap.has("Counter", "0"), true);
    assert.equal(snap.has("Counter", "1"), false);
  });
});

describe("readsFor", () => {
  it("expands entity type + id list into EntityRef[]", () => {
    assert.deepEqual(readsFor("Counter", ["a", "b"]), [
      { entityType: "Counter", id: "a" },
      { entityType: "Counter", id: "b" },
    ]);
  });
});
