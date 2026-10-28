import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { patchGeneratedSchema } from "../src/snapshot.ts";
import { timeseriesEntityTypes } from "../src/codegen/generate-entities.ts";

const generated = `
export class Sample extends Entity {
  save(): void {
    let id = this.get("id");
    if (id) {
      store.set("Sample", id.toI64().toString(), this);
    }
  }

  get timestamp(): i64 {
    let value = this.get("timestamp");
    return value.toTimestamp();
  }

  set timestamp(value: i64) {
    this.set("timestamp", Value.fromTimestamp(value));
  }
}

export class User extends Entity {
  save(): void {
    let id = this.get("id");
    if (id) {
      store.set("User", id.toString(), this);
    }
  }
}
`;

describe("patchGeneratedSchema", () => {
  it("rewrites Timestamp values to Int8 so matchstick's store accepts them", () => {
    const patched = patchGeneratedSchema(generated);
    assert.doesNotMatch(patched, /Timestamp\(/);
    assert.match(patched, /return value\.toI64\(\);/);
    assert.match(patched, /this\.set\("timestamp", Value\.fromI64\(value\)\);/);
  });

  it("assigns timeseries fields only for the listed types", () => {
    const patched = patchGeneratedSchema(generated, ["Sample"]);
    assert.match(
      patched,
      /const __timeseriesId = assignTimeseriesFields\(this\);\s+store\.set\("Sample", __timeseriesId, this\);\s+trackSave\("Sample", __timeseriesId\)/,
    );
    assert.match(patched, /store\.set\("User", id\.toString\(\), this\);\s+trackSave\("User", id\.toString\(\)\)/);
  });

  it("leaves save() untouched for timeseries types when none are listed", () => {
    const patched = patchGeneratedSchema(generated);
    assert.doesNotMatch(patched, /assignTimeseriesFields\(this\)/);
    assert.match(patched, /trackSave\("Sample", id\.toI64\(\)\.toString\(\)\)/);
  });
});

describe("timeseriesEntityTypes", () => {
  it("lists @entity(timeseries: true) types only", () => {
    const schema = `
      type A @entity(timeseries: true) { id: Int8! timestamp: Timestamp! }
      type B @entity(immutable: true) { id: ID! }
      type C @entity(timeseries: false) { id: ID! }
      type D @aggregation(intervals: ["hour"], source: "A") {
        id: Int8!
        timestamp: Timestamp!
        n: Int8! @aggregate(fn: "count")
      }
    `;
    assert.deepEqual(timeseriesEntityTypes(schema), ["A"]);
  });
});
