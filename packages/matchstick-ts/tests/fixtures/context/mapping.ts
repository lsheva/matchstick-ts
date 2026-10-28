// Fixture mapping read by generate-runner tests (not compiled).
import { ethereum } from "@graphprotocol/graph-ts";
import { Updated } from "../generated/Oracle/Oracle";
import { AnswerUpdated as ProxyAnswerUpdated } from "../generated/Oracle/AggregatorProxy";

export function initFeeds(block: ethereum.Block): void {}
export function onBlock(block: ethereum.Block): void {}
export function onCall(block: ethereum.Block): void {}
export function handleUpdated(event: Updated): void {}
export function handleAnswerUpdated(event: ProxyAnswerUpdated): void {}
