// src/commands/balance.ts

import type { User } from "../db/users";

export interface BalanceDeps {
  getBalance: (address: `0x${string}`) => Promise<string>;
}

export async function handleBalance(
  user: User,
  deps: BalanceDeps
): Promise<string> {
  try {
    const balance = await deps.getBalance(user.address as `0x${string}`);
    return `Your balance: $${balance} USDC`;
  } catch (err) {
    console.error("Balance check failed:", err);
    return "Sorry, couldn't check your balance right now. Try again in a moment.";
  }
}
