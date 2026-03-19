// src/mpp/client.ts
// Generic MPP client — wraps mppx with Privy-backed viem accounts.
//
// Usage:
//   const response = await mppFetch(account, url, { method: "POST", body: ... });
//
// The mppx library handles the full 402 flow:
//   1. Initial request → 402 Payment Required
//   2. mppx reads payment requirements from response
//   3. Signs a payment credential using the Privy-backed viem account
//   4. Retries request with credential → 200 OK
//
// See: https://mpp.dev/quickstart/client

import { Mppx, tempo } from "mppx/client";
import type { Account } from "viem";

/**
 * Make a paid request to any MPP-enabled service.
 *
 * @param account - viem Account (from Privy's createViemAccount) that pays for the request
 * @param url - The MPP service endpoint URL
 * @param init - Standard fetch RequestInit (method, headers, body, etc.)
 * @returns The fetch Response object
 */
export async function mppFetch(
  account: Account,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const mppx = Mppx.create({
    polyfill: false,
    methods: [tempo({ account, maxDeposit: "1" })],
  });

  return mppx.fetch(url, init);
}
