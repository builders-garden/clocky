// scripts/create-treasury.ts
// Creates a Privy server wallet to use as the treasury.
// Run: bun run scripts/create-treasury.ts

import { PrivyClient } from "@privy-io/node";

const appId = process.env.PRIVY_APP_ID;
const appSecret = process.env.PRIVY_APP_SECRET;

if (!appId || !appSecret) {
  console.error("Set PRIVY_APP_ID and PRIVY_APP_SECRET in your .env first.");
  process.exit(1);
}

const privy = new PrivyClient({ appId, appSecret });
const wallet = await privy.wallets().create({ chain_type: "ethereum" });

console.log("Treasury wallet created!\n");
console.log(`TREASURY_WALLET_ID=${wallet.id}`);
console.log(`TREASURY_ADDRESS=${wallet.address}`);
console.log("\nAdd these to your .env, then fund the address with PathUSD from your Tempo wallet.");
