// src/commands/send.ts

import type { Database } from "bun:sqlite";
import type { User } from "../db/users";
import type { Account } from "viem";
import { logTransaction, updateTransaction } from "../db/transactions";

export interface SendDeps {
  getBalance: (address: `0x${string}`) => Promise<string>;
  transferPathUSD: (
    from: Account,
    fromWalletId: string,
    to: `0x${string}`,
    amount: string
  ) => Promise<string>;
  parseAmount: (input: string) => string | null;
  getOrCreateUser: (phone: string) => Promise<User>;
  getViemAccount: (walletId: string, address: `0x${string}`) => Account;
  sendMessage: (phone: string, text: string) => Promise<void>;
}

export interface SendInput {
  amount: string;
  recipientPhone: string;
}

export async function handleSend(
  db: Database,
  sender: User,
  input: SendInput,
  deps: SendDeps
): Promise<string> {
  // 1. Parse amount
  const amount = deps.parseAmount(input.amount);
  if (!amount) {
    return `Invalid amount: "${input.amount}". Use: send $5 to +1234567890`;
  }

  // Input validation: enforce transfer limits
  const amountVal = parseFloat(amount);
  if (amountVal < 0.01) {
    return "Minimum transfer amount is $0.01.";
  }
  if (amountVal > 1000) {
    return "Maximum transfer amount is $1,000.";
  }

  // 2. Can't send to yourself
  if (input.recipientPhone === sender.phone) {
    return "You can't send money to yourself.";
  }

  // 3. Check balance
  let balance: string;
  try {
    balance = await deps.getBalance(sender.address as `0x${string}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("Failed to fetch balance:", err);
    return `Could not retrieve your balance: ${msg}`;
  }

  // Use epsilon comparison to handle floating-point precision (PathUSD has 6 decimals)
  const balanceNum = parseFloat(balance);
  const amountNum = parseFloat(amount);
  if (balanceNum - amountNum < -1e-9) {
    return `Insufficient balance. You have $${balance} but tried to send $${amount}.`;
  }

  // 4. Resolve or create recipient
  const recipient = await deps.getOrCreateUser(input.recipientPhone);

  // 5. Log pending transaction
  const txId = logTransaction(db, sender.phone, recipient.phone, amount);

  // 6. Execute transfer
  try {
    const senderAccount = deps.getViemAccount(
      sender.privy_wallet_id,
      sender.address as `0x${string}`
    );

    const txHash = await deps.transferPathUSD(
      senderAccount,
      sender.privy_wallet_id,
      recipient.address as `0x${string}`,
      amount
    );

    updateTransaction(db, txId, { txHash, status: "confirmed" });

    // 7. Notify recipient
    try {
      await deps.sendMessage(
        recipient.phone,
        `You received $${amount} PathUSD from ${sender.phone}! Reply "balance" to check your balance.`
      );
    } catch (notifyErr) {
      console.error("Failed to notify recipient:", notifyErr);
    }

    const explorerUrl = `https://explore.tempo.xyz/tx/${txHash}`;
    return `Sent $${amount} to ${recipient.phone}\nTx: ${explorerUrl}`;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    updateTransaction(db, txId, { status: "failed", error: errorMsg });
    console.error("Transfer failed:", err);
    return `Transfer failed: ${errorMsg}`;
  }
}
