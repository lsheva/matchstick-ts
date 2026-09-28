# matchstick-ts

## 0.4.4

### Patch Changes

- 8c90502: Add a README so the package page on npm has documentation.
  
  The README shipped in the tarball, but npm only renders a README that was present
  in the published version — `0.4.3` went out before the README existed, so this
  release republishes the package with it.

## 0.4.3

### Patch Changes

- 5cd056e: Serialize decoded event args in ABI input order.
  
  viem's `parseEventLogs` fills named args indexed-first, so an event like
  `Deposited(address indexed user, uint256 amount, address indexed sender)` arrived
  as `[user, sender, amount]`. Generated handlers read `event.parameters[i]`
  positionally, so `parameters[1].toBigInt()` aborted on the address in slot 1
  (`Ethereum value is not an int or uint`). Named args are now rebuilt in the
  event's declared input order before serialization. Unnamed events (array args)
  and events with incomplete input names keep the previous behavior.
