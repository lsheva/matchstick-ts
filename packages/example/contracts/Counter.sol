// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/// Minimal contract for the matchstick-ts example: one event, one handler.
///
/// `multiplier` is a 0-arg view function. The subgraph handler reads it via
/// `try_multiplier()` to demonstrate `SubgraphLogSync.captureViewMocks`, which
/// probes bound contracts via `eth_call` and registers the actual on-chain
/// return value as a matchstick `createMockedFunction(...).returns(...)` — so
/// handlers observe realistic values instead of always taking the
/// `reverted = true` branch.
contract Counter {
  event ValueSet(uint256 newValue);

  uint256 public immutable multiplier;

  constructor(uint256 _multiplier) {
    multiplier = _multiplier;
  }

  function setValue(uint256 newValue) external {
    emit ValueSet(newValue);
  }
}
