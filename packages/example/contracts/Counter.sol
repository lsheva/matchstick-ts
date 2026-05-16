// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/// Minimal contract for the matchstick-ts example: one event, one handler.
contract Counter {
  event ValueSet(uint256 newValue);

  function setValue(uint256 newValue) external {
    emit ValueSet(newValue);
  }
}
