import { BigInt } from "@graphprotocol/graph-ts";
import { Counter as CounterContract, ValueSet, SignedValueSet } from "../generated/Counter/Counter";
import { Counter, SignedCounter } from "../generated/schema";

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
