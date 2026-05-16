import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deployContract } from "viem/actions";
import { getContract, type Abi, type Address, type Hex } from "viem";
import type { NetworkConnection } from "hardhat/types/network";

const ARTIFACT_PATH = join("artifacts", "contracts", "Counter.sol", "Counter.json");

export type CounterContract = ReturnType<typeof getContract>;

/**
 * Deploy `Counter` via viem using the Hardhat artifact produced by `hardhat compile`.
 */
export async function deployCounter(conn: NetworkConnection): Promise<{
  counter: CounterContract;
  abi: Abi;
  address: Address;
}> {
  const walletClients = await conn.viem.getWalletClients();
  const publicClient = await conn.viem.getPublicClient();
  const wallet = walletClients[0];
  if (wallet.account === undefined) {
    throw new Error("wallet client has no account");
  }

  const raw = await readFile(ARTIFACT_PATH, "utf8");
  const artifact = JSON.parse(raw) as {
    abi: Abi;
    bytecode: { object: Hex } | Hex;
  };
  const bytecode =
    typeof artifact.bytecode === "string" ? artifact.bytecode : artifact.bytecode.object;

  const hash = await deployContract(wallet, {
    abi: artifact.abi,
    bytecode,
    args: [],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const address = receipt.contractAddress;
  if (address === null || address === undefined) {
    throw new Error("Counter deployment did not return a contract address");
  }

  const counter = getContract({
    address,
    abi: artifact.abi,
    client: { public: publicClient, wallet },
  });

  return { counter, abi: artifact.abi, address };
}
