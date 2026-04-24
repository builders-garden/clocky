// src/commands/deposit.ts

import type { User } from "../db/users";

export function handleDeposit(user: User): string {
  return [
    "Your deposit address (Tempo mainnet):",
    "",
    user.address,
    "",
    "Send USDC to this address to fund your account.",
  ].join("\n");
}
