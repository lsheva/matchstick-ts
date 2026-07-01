Mock contract registry (matchstick parity for eth_call). Today: host.rpcClient = { call: ... } is one global handler. Goal: host.mockCall(to, sig).withArgs(...).returns(...) like matchstick's createMockedFunction. Internally it's a registry-backed RpcClient. This is what unlocks porting existing \*.test.ts matchstick suites onto our runner without rewrites.

viem PublicClient adapter. Tiny — makeViemRpc(client) -> RpcClient. Lets callers use a real fork or mainnet without writing the wrapper.

Snapshot / diff API — the original goal of subgraph-snapshot. Serialize the post-dispatch entity store, diff against a baseline. We already have subgraph.entities(type); this is "walk all types + canonicalize + diff".

Block context overrides in EventBuilder — today defaultBlock() is constant; handlers reading event.block.timestamp always see 1. Adding builder.buildEvent(params, { block: { number, timestamp, hash }, transaction: {...} }) would unblock time-based tests.

Source map for WasmAbortError — abort messages point at compiled wasm offsets, not the .ts mapping. Wire asc's .wasm.map into the error so failures point at the right line.

Matchstick assert.fieldEquals shim — once (1) and (3) land, a thin assert.entityCount(type, n) / assert.fieldEquals(type, id, field, value) API makes existing matchstick suites copy-paste runnable.

CLI entry (subgraph-snapshot test <pattern>) — auto-discover \*.test.ts, build bundle, run, report. The "actually replace graph test" piece.

numbers.bigDecimal.\* — currently trapped. Needed if any target subgraph uses BigDecimal (uniswap-style fee math). Not blocking futures-marketplace / perps, but blocks broader adoption.
