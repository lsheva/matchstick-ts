import { ValueSet } from "../generated/Counter/Counter";
import { Counter } from "../generated/schema";

export function handleValueSet(event: ValueSet): void {
  let entity = Counter.load("0");
  if (entity == null) {
    entity = new Counter("0");
  }
  entity.value = event.params.newValue;
  entity.save();
}
