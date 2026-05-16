import { defineConfig } from "hardhat/config";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatViem from "@nomicfoundation/hardhat-viem";

export default defineConfig({
  solidity: {
    version: "0.8.28",
  },
  plugins: [hardhatNetworkHelpers, hardhatViem],
  networks: {
    default: {
      type: "edr-simulated",
      mining: {
        auto: true,
      },
    },
  },
});
