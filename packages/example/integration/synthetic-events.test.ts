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

describe("timeseries entity (ValueSample)", () => {
  // graph-node assigns timeseries ids as (blockNumber << 32) | seq, with seq
  // restarting at 0 in each block.
  const timeseriesId = (block: number, seq: number) => ((BigInt(block) << 32n) | BigInt(seq)).toString();

  it("assigns graph-node ids and block timestamps instead of colliding on id 0", async () => {
    const snap = await runMatchstickTest({
      events: [
        { ...valueSetCaptured(1n, 7), blockTimestamp: 1_700_000_000, logIndex: 0 },
        { ...valueSetCaptured(2n, 7), blockTimestamp: 1_700_000_000, logIndex: 1 },
        { ...valueSetCaptured(3n, 8), blockTimestamp: 1_700_000_012 },
      ],
      reads: [],
      callMocks: counterCallMocks,
    });

    const samples = snap.saved("ValueSample");
    assert.deepEqual(
      samples.map((s) => [s.id, s.value, s.timestamp]),
      [
        [timeseriesId(7, 0), "1", "1700000000000000"],
        [timeseriesId(7, 1), "2", "1700000000000000"],
        [timeseriesId(8, 0), "3", "1700000012000000"],
      ],
    );
  });

  it("can be turned off, leaving the mapping's id and timestamp in place", async () => {
    const snap = await runMatchstickTest({
      events: [valueSetCaptured(1n, 7), valueSetCaptured(2n, 8)],
      reads: [],
      callMocks: counterCallMocks,
      emulateTimeseries: false,
    });

    assert.deepEqual(
      snap.saved("ValueSample").map((s) => [s.id, s.value, s.timestamp]),
      [["0", "2", "0"]],
    );
  });
});

describe("block handlers and data source context", () => {
  const events = [
    { ...valueSetCaptured(1n, 5), blockTimestamp: 1_000, logIndex: 0, dataSource: "Counter" },
    { ...valueSetCaptured(2n, 5), blockTimestamp: 1_000, logIndex: 1, dataSource: "Counter" },
    { ...valueSetCaptured(3n, 9), blockTimestamp: 1_048, logIndex: 0, dataSource: "Counter" },
  ];

  it("runs the once handler with the manifest context before the first event", async () => {
    const snap = await runMatchstickTest({ events, reads: [], callMocks: counterCallMocks });

    assert.deepEqual(snap.entity("Init", "0"), {
      id: "0",
      label: "primary",
      threshold: "100",
      address: COUNTER_ADDRESS,
      blockNumber: "5",
    });
  });

  it("runs the unfiltered handler once per block that carries events", async () => {
    const snap = await runMatchstickTest({ events, reads: [], callMocks: counterCallMocks });

    assert.deepEqual(
      snap.saved("BlockTick").map((t) => [t.number, t.timestamp]),
      [
        ["5", "1000"],
        ["9", "1048"],
      ],
    );
  });

  it("routes template events by data source, with an empty context", async () => {
    const clone = "0x00000000000000000000000000000000000000c1";
    const snap = await runMatchstickTest({
      events: [
        valueSetCaptured(7n, 3),
        { ...valueSetCaptured(8n, 4), address: clone, dataSource: "CounterClone" },
      ],
      reads: [],
      callMocks: counterCallMocks,
    });

    assert.deepEqual(snap.saved("Counter").map((c) => c.value), ["7"]);
    assert.deepEqual(snap.saved("CloneValue"), [{ id: clone, value: "8", hasContext: false }]);
  });
});

describe("context overrides", () => {
  const events = [{ ...valueSetCaptured(1n, 5), dataSource: "Counter" }];

  it("replaces overridden keys and keeps the other manifest keys", async () => {
    const snap = await runMatchstickTest({
      events,
      reads: [],
      callMocks: counterCallMocks,
      context: { Counter: { label: "override" } },
    });

    const init = snap.entity("Init", "0");
    assert.equal(init?.label, "override");
    assert.equal(init?.threshold, "100");
  });

  it("infers the manifest type for plain values", async () => {
    const snap = await runMatchstickTest({
      events,
      reads: [],
      callMocks: counterCallMocks,
      context: { Counter: { threshold: 2n ** 200n } },
    });

    assert.equal(snap.entity("Init", "0")?.threshold, (2n ** 200n).toString());
    assert.equal(snap.entity("Init", "0")?.label, "primary");
  });

  it("sets keys the template manifest lacks from explicit { type, data }", async () => {
    const clone = "0x00000000000000000000000000000000000000c1";
    const snap = await runMatchstickTest({
      events: [{ ...valueSetCaptured(8n, 4), address: clone, dataSource: "CounterClone" }],
      reads: [],
      callMocks: counterCallMocks,
      context: { CounterClone: { pair: { type: "String", data: "BTC/USD" } } },
    });

    assert.deepEqual(snap.saved("CloneValue"), [
      { id: clone, value: "8", hasContext: false, pair: "BTC/USD" },
    ]);
  });

  it("rejects a plain value for a key the manifest does not declare", async () => {
    await assert.rejects(
      () =>
        runMatchstickTest({
          events,
          reads: [],
          callMocks: counterCallMocks,
          context: { CounterClone: { pair: "BTC/USD" } },
        }),
      /context key "pair" is not in the manifest context of "CounterClone"/,
    );
  });
});
