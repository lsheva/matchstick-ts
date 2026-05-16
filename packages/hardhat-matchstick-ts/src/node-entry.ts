/**
 * Re-export node helpers. Separate entry so `import hardhatMatchstick from
 * "hardhat-matchstick-ts"` in hardhat.config does not load this module.
 *
 * Side-effect import: augments `NetworkConnection` with `matchstick` for tsc.
 */
import "./network-type-extensions.ts";

export { getOrCreateNode, createNode } from "./node.ts";
export type { Node } from "./node.ts";
