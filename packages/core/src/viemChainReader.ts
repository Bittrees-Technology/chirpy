import { createPublicClient, getAddress, http, parseAbi, type Address } from "viem";
import { mainnet } from "viem/chains";
import type { ChainReader } from "./gating";

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const erc721Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const erc1155Abi = parseAbi(["function balanceOf(address,uint256) view returns (uint256)"]);
const safeAbi = parseAbi(["function getOwners() view returns (address[])"]);

export interface ViemChainReaderOptions {
  rolesOf?: ChainReader["rolesOf"];
  power?: ChainReader["power"];
  safeDelegates?: ChainReader["safeDelegates"];
}

const addr = (value: string): Address => getAddress(value);

export function makeViemChainReader(
  rpcUrl?: string,
  opts: ViemChainReaderOptions = {},
): ChainReader {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });

  return {
    erc20Balance: (token, user) => client.readContract({
      address: addr(token),
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [addr(user)],
    }),
    erc20Decimals: async (token) => Number(await client.readContract({
      address: addr(token),
      abi: erc20Abi,
      functionName: "decimals",
    })),
    erc721Balance: (token, user) => client.readContract({
      address: addr(token),
      abi: erc721Abi,
      functionName: "balanceOf",
      args: [addr(user)],
    }),
    erc1155Balance: (token, user, id) => client.readContract({
      address: addr(token),
      abi: erc1155Abi,
      functionName: "balanceOf",
      args: [addr(user), id],
    }),
    erc1155BalanceAny: async (token, user) => {
      const tokenAddress = addr(token);
      const userAddress = addr(user);
      const ids = Array.from({ length: 256 }, (_, i) => BigInt(i));
      const results = await client.multicall({
        allowFailure: true,
        contracts: ids.map((id) => ({
          address: tokenAddress,
          abi: erc1155Abi,
          functionName: "balanceOf",
          args: [userAddress, id] as const,
        })),
      });
      return results.reduce((sum, result) => (
        result.status === "success" ? sum + result.result : sum
      ), 0n);
    },
    ensAddress: async (name) => await client.getEnsAddress({ name }) ?? null,
    ensName: async (user) => await client.getEnsName({ address: addr(user) }) ?? null,
    safeOwners: async (safe) => {
      try {
        return [...await client.readContract({
          address: addr(safe),
          abi: safeAbi,
          functionName: "getOwners",
        })];
      } catch {
        return [];
      }
    },
    safeDelegates: opts.safeDelegates ?? (async () => []),
    rolesOf: opts.rolesOf ?? (async () => []),
    power: opts.power ?? (async () => 0),
  };
}
