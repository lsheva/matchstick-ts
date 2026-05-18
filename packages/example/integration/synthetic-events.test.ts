/**
 * Integration tests for matchstick-ts using hand-built events (no Hardhat).
 * Fast path — still runs Matchstick against the real mapping in `src/mapping.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runMatchstickTest, readsFor } from "matchstick-ts";
import { valueSetCaptured, signedValueSetCaptured } from "./helpers.ts";

describe("synthetic ValueSet → Counter entity", () => {
  it("indexes a single event", async () => {
    const snap = await runMatchstickTest({
      events: [valueSetCaptured(99n)],
      reads: [{ entityType: "Counter", id: "0" }],
    });

    assert.equal(snap.get("Counter", "0", "value"), "99");
    assert.equal(snap.count("Counter"), 1);
  });

  it("applies events in order (last write wins)", async () => {
    const snap = await runMatchstickTest({
      events: [valueSetCaptured(10n), valueSetCaptured(20n, 2)],
      reads: [{ entityType: "Counter", id: "0" }],
    });

    assert.equal(snap.entity("Counter", "0")?.value, "20");
  });

  it("readsFor + requested / null / undefined semantics", async () => {
    const snap = await runMatchstickTest({
      events: [valueSetCaptured(5n)],
      reads: [...readsFor("Counter", ["0", "missing-id"])],
    });

    assert.equal(snap.get("Counter", "0", "value"), "5");
    assert.equal(snap.entity("Counter", "missing-id"), null);
    assert.equal(snap.requested("Counter", "missing-id"), true);
    assert.equal(snap.has("Counter", "missing-id"), false);
    assert.equal(snap.entity("Counter", "never-asked"), undefined);
    assert.equal(snap.requested("Counter", "never-asked"), false);
  });

  it("returns saved entities without knowing their IDs upfront", async () => {
    const snap = await runMatchstickTest({
      events: [valueSetCaptured(42n)],
      reads: [], // caller does not need to know the ID in advance
    });

    const [counter] = snap.saved("Counter");
    assert.ok(counter);
    assert.equal(counter.value, "42");
  });
});

describe("negative int256 parameter (SignedValueSet)", () => {
  it("handles a negative int256 value without crashing", async () => {
    const snap = await runMatchstickTest({
      events: [signedValueSetCaptured(-99n)],
      reads: [],
    });

    const [counter] = snap.saved("SignedCounter");
    assert.ok(counter, "SignedCounter entity should be saved");
    assert.equal(counter.value, "-99");
  });

  it("handles a positive int256 value the same as uint256", async () => {
    const snap = await runMatchstickTest({
      events: [signedValueSetCaptured(42n)],
      reads: [],
    });

    const [counter] = snap.saved("SignedCounter");
    assert.ok(counter);
    assert.equal(counter.value, "42");
  });

  it("handles large negative int256 (boundary near int256 min range)", async () => {
    const large = -(2n ** 128n);
    const snap = await runMatchstickTest({
      events: [signedValueSetCaptured(large)],
      reads: [],
    });

    const [counter] = snap.saved("SignedCounter");
    assert.ok(counter);
    assert.equal(counter.value, large.toString());
  });
});
