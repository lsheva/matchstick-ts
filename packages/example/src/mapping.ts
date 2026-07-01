import { BigInt } from "@graphprotocol/graph-ts";
import {
  Counter as CounterContract,
  ValueSet,
  SignedValueSet,
  ConfigUpdated,
} from "../generated/Counter/Counter";
import { Counter, SignedCounter, Config } from "../generated/schema";

export function handleValueSet(event: ValueSet): void {
  let entity = Counter.load("0");
  if (entity == null) {
    entity = new Counter("0");
    entity.scaledValue = BigInt.zero();
  }
  entity.value = event.params.newValue;

  // Best-effort view-call read — demonstrates how `captureViewMocks()`
  // upgrades this from `reverted = true` (default) to a real value.
  const bound = CounterContract.bind(event.address);
  const multiplier = bound.try_multiplier();
  if (!multiplier.reverted) {
    entity.scaledValue = event.params.newValue.times(multiplier.value);
  }

  entity.save();
}

export function handleSignedValueSet(event: SignedValueSet): void {
  let entity = SignedCounter.load("0");
  if (entity == null) {
    entity = new SignedCounter("0");
  }
  entity.value = event.params.newValue;
  entity.save();
}

// Reads fields off a decoded struct param. `event.params.config` calls
// `.toTuple()` on the underlying value, which only works if the assembly
// runtime decoded the JSON-array wire form into an `ethereum.Tuple`.
export function handleConfigUpdated(event: ConfigUpdated): void {
  let entity = Config.load("0");
  if (entity == null) {
    entity = new Config("0");
  }
  const config = event.params.config;
  entity.fee = config.fee;
  entity.offset = config.offset;
  entity.treasury = config.treasury;
  entity.active = config.active;
  entity.save();
}
