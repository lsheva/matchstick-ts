/**
 * Optional Hardhat 3 in-process node helper. Imported via
 * `subgraph-snapshot/hardhat` so users on anvil / Foundry can skip pulling
 * Hardhat as a peer dependency.
 */
import "@nomicfoundation/hardhat-viem";
import "@nomicfoundation/hardhat-network-helpers";
import { network } from "hardhat";
import type { JsonRpcServer, NetworkConnection } from "hardhat/types/network";

export interface Node {
  server: JsonRpcServer;
  conn: NetworkConnection;
  rpcUrl: string;
  address: string;
  port: number;
  close: () => Promise<void>;
}

let nodeCache: Node | null = null;

/**
 * Reuse an existing node spawned by `createNode` (process-local cache), or
 * spawn a fresh one.
 */
export async function getOrCreateNode(): Promise<Node> {
  if (nodeCache) {
    return nodeCache;
  }
  return createNode();
}

/**
 * Spawn a Hardhat 3 in-process JSON-RPC server using the consumer's
 * `hardhat.config.ts` and return a handle for tests to use.
 */
export async function createNode(): Promise<Node> {
  const server = await network.createServer({
    network: "default",
    override: { loggingEnabled: true },
  });

  const { address, port } = await server.listen();
  const rpcUrl = `http://${address}:${port}`;

  const conn = await network.create({
    network: "default",
    override: { url: rpcUrl },
  });

  nodeCache = {
    server,
    conn,
    rpcUrl,
    address,
    port,
    close: async () => {
      await conn.close();
      await server.close();
      nodeCache = null;
    },
  };

  return nodeCache;
}
