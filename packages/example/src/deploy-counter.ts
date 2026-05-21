import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deployContract } from "viem/actions";
import {
  getContract,
  type Abi,
  type Address,
  type GetContractReturnType,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { NetworkConnection } from "hardhat/types/network";

const ARTIFACT_PATH = join("artifacts", "contracts", "Counter.sol", "Counter.json");

/** Matches `abis/Counter.json` — `as const` so viem types `write.setValue`. */
const counterAbi = [
  {
    anonymous: false,
    inputs: [{ indexed: false, internalType: "uint256", name: "newValue", type: "uint256" }],
    name: "ValueSet",
    type: "event",
  },
  {
    inputs: [{ internalType: "uint256", name: "newValue", type: "uint256" }],
    name: "setValue",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "multiplier",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_multiplier", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "constructor",
  },
] as const;

export type CounterContract = GetContractReturnType<
  typeof counterAbi,
  { public: PublicClient; wallet: WalletClient }
>;

/**
 * Deploy `Counter` via viem using the Hardhat artifact produced by `hardhat compile`.
 */
export async function deployCounter(
  conn: NetworkConnection,
  options: { multiplier?: bigint } = {},
): Promise<{
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
    abi: counterAbi,
    bytecode,
    args: [options.multiplier ?? 10n],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const address = receipt.contractAddress;
  if (address === null || address === undefined) {
    throw new Error("Counter deployment did not return a contract address");
  }

  const counter = getContract({
    address,
    abi: counterAbi,
    client: { public: publicClient, wallet },
  });

  return { counter, abi: counterAbi as Abi, address };
}
