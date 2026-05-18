import { ValueSet, SignedValueSet } from "../generated/Counter/Counter";
import { Counter, SignedCounter } from "../generated/schema";

export function handleValueSet(event: ValueSet): void {
  let entity = Counter.load("0");
  if (entity == null) {
    entity = new Counter("0");
  }
  entity.value = event.params.newValue;
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
