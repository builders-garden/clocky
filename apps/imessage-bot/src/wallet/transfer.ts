// src/wallet/transfer.ts
// USDC transfers + balance on Tempo mainnet
//
// Uses tempoActions() per https://docs.privy.io/recipes/evm/tempo
//
// Primary approach: viem walletClient + tempoActions().token.transferSync()
// Fallback: Privy direct sendTransaction with sponsor: true (gas sponsorship)

import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  parseUnits,
  encodeFunctionData,
  type Account,
} from "viem";
import { tempo } from "viem/chains";
import { tempoActions } from "viem/tempo";
import { USDC_ADDRESS, TEMPO_MAINNET_CAIP2 } from "../config";
import { getPrivyClient } from "./privy";

// The CAIP-2 identifier used for the Privy fallback path must match the chain
// used by the primary (tempoActions) path. tempo.id = 4217 = mainnet.
const ACTIVE_CAIP2 = TEMPO_MAINNET_CAIP2; // derived from tempo (chain 4217)

// TIP-20 ABI subset for balanceOf (read-only, no signing needed)
const TOKEN_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const publicClient = createPublicClient({
  chain: tempo,
  transport: http(),
});

/**
 * Get USDC balance for an address.
 * Returns formatted string like "5.00".
 */
export async function getBalance(address: `0x${string}`): Promise<string> {
  const balance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: TOKEN_ABI,
    functionName: "balanceOf",
    args: [address],
  });
  return formatUnits(balance, 6); // USDC has 6 decimals
}

/**
 * Transfer USDC from one Privy-backed account to another address.
 *
 * Primary approach: viem walletClient + tempoActions().token.transferSync()
 *   - transferSync({ to, amount, token }) waits for receipt
 *   - Returns { receipt: TransactionReceipt, ...eventArgs }
 *   - receipt.transactionHash is the tx hash
 *
 * Fallback: Privy direct sendTransaction with sponsor: true (gas sponsorship)
 *   - privy.wallets().ethereum().sendTransaction(walletId, input)
 *   - input: { caip2, params: { transaction: { to, data } }, sponsor: true }
 *   - response.hash is the tx hash (NOT .transactionHash)
 *
 * Returns the transaction hash.
 */
export async function transferUSDC(
  fromAccount: Account,
  fromWalletId: string, // INVARIANT: fromAccount and fromWalletId must refer to the same Privy wallet
  toAddress: `0x${string}`,
  amount: string // pre-validated decimal string (use parseAmount() before calling this)
): Promise<string> {
  const parsedAmount = parseUnits(amount, 6);

  // Try viem + tempoActions first (cleaner API)
  try {
    const walletClient = createWalletClient({
      account: fromAccount,
      chain: tempo,
      transport: http(),
    }).extend(tempoActions());

    const result = await walletClient.token.transferSync({
      to: toAddress,
      amount: parsedAmount,
      token: USDC_ADDRESS,
    });

    return result.receipt.transactionHash;
  } catch (err) {
    console.warn("tempoActions transfer failed, trying Privy direct:", err);
  }

  // Fallback: Privy direct with gas sponsorship
  // API: privy.wallets().ethereum().sendTransaction(walletId, input)
  // Input type omits 'chain_type' and 'method' (set internally by the service)
  // Response type: EthereumSendTransactionRpcResponse.Data — has .hash field
  const privy = getPrivyClient();
  const encodedData = encodeFunctionData({
    abi: TOKEN_ABI,
    functionName: "transfer",
    args: [toAddress, parsedAmount],
  });

  const result = await privy
    .wallets()
    .ethereum()
    .sendTransaction(fromWalletId, {
      caip2: ACTIVE_CAIP2,
      params: {
        transaction: {
          to: USDC_ADDRESS,
          data: encodedData,
        },
      },
      sponsor: true,
    });

  return result.hash;
}

/**
 * Parse a dollar amount string like "$5", "$5.00", "5", "5.50" into a clean decimal string.
 * Returns null if the input is not a valid amount.
 *
 * Uses strict regex — rejects partial matches like "5abc" that parseFloat would accept.
 * Returns the canonical decimal form (no trailing zeros): "$5.00" → "5", "5.50" → "5.5"
 */
export function parseAmount(input: string): string | null {
  const cleaned = input.replace(/^\$/, "").trim();
  // Strict: only digits, optional decimal point + digits (no trailing text allowed)
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const num = parseFloat(cleaned);
  if (isNaN(num) || num <= 0) return null;
  // Strip trailing zeros safely — only after the decimal point
  return num.toFixed(6).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}
