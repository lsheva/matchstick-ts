/**
 * Integration tests for matchstick-ts using hand-built events (no Hardhat).
 * Fast path — still runs Matchstick against the real mapping in `src/mapping.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runMatchstickTest, readsFor } from "matchstick-ts";
import {
  counterCallMocks,
  COUNTER_ADDRESS,
  valueSetCaptured,
  signedValueSetCaptured,
  configUpdatedCaptured,
} from "./helpers.ts";

describe("synthetic ValueSet → Counter entity", () => {
  it("indexes a single event", async () => {
    const snap = await runMatchstickTest({
      events: [valueSetCaptured(99n)],
      reads: [{ entityType: "Counter", id: "0" }],
      // Counter's handler reads `multiplier()` via `try_*`; with no chain to
      // probe, supply pre-built revert mocks so matchstick doesn't reject the
      // un-mocked call.
      callMocks: counterCallMocks,
    });

    assert.equal(snap.get("Counter", "0", "value"), "99");
    assert.equal(snap.count("Counter"), 1);
  });

  it("applies events in order (last write wins)", async () => {
    const snap = await runMatchstickTest({
      events: [valueSetCaptured(10n), valueSetCaptured(20n, 2)],
      reads: [{ entityType: "Counter", id: "0" }],
      callMocks: counterCallMocks,
    });

    assert.equal(snap.entity("Counter", "0")?.value, "20");
  });

  it("readsFor + requested / null / undefined semantics", async () => {
    const snap = await runMatchstickTest({
      events: [valueSetCaptured(5n)],
      reads: [...readsFor("Counter", ["0", "missing-id"])],
      callMocks: counterCallMocks,
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
      callMocks: counterCallMocks,
    });

    const [counter] = snap.saved("Counter");
    assert.ok(counter);
    assert.equal(counter.value, "42");
  });

  it("CallReturnMock: synthetic test sees a fixed multiplier value", async () => {
    const snap = await runMatchstickTest({
      events: [valueSetCaptured(3n)],
      reads: [{ entityType: "Counter", id: "0" }],
      // Hand-built return mock: handler observes `try_multiplier().value = 11n`
      // → `scaledValue = 3 * 11 = 33`. No `eth_call` needed.
      callMocks: [
        {
          kind: "return",
          address: COUNTER_ADDRESS,
          name: "multiplier",
          signature: "multiplier():(uint256)",
          outputs: ["uint256"],
          returns: ["11"],
        },
      ],
    });

    assert.equal(snap.get("Counter", "0", "value"), "3");
    assert.equal(snap.get("Counter", "0", "scaledValue"), "33");
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

describe("struct/tuple parameter (ConfigUpdated)", () => {
  const TREASURY = "0x00000000000000000000000000000000DeaDBeef";

  it("decodes a Config struct (uint256, int256, address, bool) into an entity", async () => {
    const snap = await runMatchstickTest({
      events: [
        configUpdatedCaptured({ fee: 500n, offset: -25n, treasury: TREASURY, active: true }),
      ],
      reads: [{ entityType: "Config", id: "0" }],
    });

    assert.equal(snap.get("Config", "0", "fee"), "500");
    assert.equal(snap.get("Config", "0", "offset"), "-25");
    assert.equal(snap.get("Config", "0", "treasury"), TREASURY.toLowerCase());
    assert.equal(snap.get("Config", "0", "active"), true);
  });

  it("preserves uint256 precision far beyond Number range", async () => {
    const bigFee = 123456789012345678901234567890n;
    const snap = await runMatchstickTest({
      events: [
        configUpdatedCaptured({ fee: bigFee, offset: 0n, treasury: TREASURY, active: false }),
      ],
      reads: [{ entityType: "Config", id: "0" }],
    });

    assert.equal(snap.get("Config", "0", "fee"), bigFee.toString());
    assert.equal(snap.get("Config", "0", "active"), false);
  });
});
