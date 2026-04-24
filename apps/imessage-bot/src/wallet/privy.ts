// src/wallet/privy.ts
// Privy SDK: wallet creation + viem account adapter
//
// Uses createViemAccount from @privy-io/node/viem with a wrapper that adds
// support for Tempo's custom transaction type (`0x76`).
//
// Problem: Privy's signTransaction sends the full tx to their remote API,
// which only understands standard EVM types (legacy/eip2930/eip1559).
// Tempo transactions have type: 'tempo' which Privy rejects.
//
// Solution: Override signTransaction to accept the { serializer } option
// that viem passes (containing Tempo's custom serializer), serialize the
// unsigned tx locally, hash it, use Privy's raw sign({ hash }) for the
// secp256k1 signature, then re-serialize with the signature attached.
// This matches viem's privateKeyToAccount pattern exactly.

import { PrivyClient } from "@privy-io/node";
import { createViemAccount } from "@privy-io/node/viem";
import type { LocalAccount } from "viem/accounts";
import { keccak256, parseSignature, type Hex, type TransactionSerializable } from "viem";
import { config } from "../config";

let privyClient: PrivyClient | null = null;

export function getPrivyClient(): PrivyClient {
  if (!privyClient) {
    privyClient = new PrivyClient({
      appId: config.privy.appId,
      appSecret: config.privy.appSecret,
    });
  }
  return privyClient;
}

export interface PrivyWallet {
  id: string;
  // Cast to branded hex type at the boundary — Privy returns string,
  // but all Tempo/viem APIs require `0x${string}`.
  address: `0x${string}`;
}

/**
 * Create a new Ethereum wallet via Privy.
 * Each user gets their own server-managed wallet.
 * Works on any EVM chain including Tempo.
 */
export async function createUserWallet(): Promise<PrivyWallet> {
  const privy = getPrivyClient();
  const wallet = await privy.wallets().create({ chain_type: "ethereum" }).catch((err) => {
    throw new Error(`Failed to create Privy wallet: ${err instanceof Error ? err.message : String(err)}`);
  });
  return {
    id: wallet.id,
    address: wallet.address as `0x${string}`,
  };
}

/**
 * Get a viem-compatible LocalAccount backed by a Privy server wallet.
 * This account can be used with:
 *   - viem wallet clients (for P2P transfers via tempoActions)
 *   - mppx (for MPP-paid service consumption)
 *
 * The returned account wraps Privy's createViemAccount with a custom
 * signTransaction that supports Tempo's custom tx type (`0x76`).
 *
 * How it works:
 *   1. viem's signTransaction action passes { serializer } from the chain config
 *   2. Privy's default signTransaction ignores this and sends the full tx to
 *      their API, which rejects type 'tempo'
 *   3. Our override accepts { serializer }, serializes the unsigned tx locally,
 *      hashes it with keccak256, calls Privy's raw sign({ hash }) for the
 *      secp256k1 signature, then re-serializes with the signature
 *   4. For standard EVM types (no custom serializer), we fall through to
 *      Privy's original signTransaction
 */
export function getViemAccount(
  walletId: string,
  address: `0x${string}`
): LocalAccount {
  const privy = getPrivyClient();
  const base = createViemAccount(privy, { walletId, address });

  return {
    ...base,
    signTransaction: async (
      transaction: TransactionSerializable,
      options?: { serializer?: ((tx: any, sig?: any) => any) | undefined }
    ): Promise<Hex> => {
      const serializer = options?.serializer;
      const txType = (transaction as any).type ?? 'unknown';
      console.log(`[SIGN] signTransaction called — type=${txType} hasSerializer=${!!serializer}`);

      // If no custom serializer provided, this is a standard EVM tx type —
      // delegate to Privy's original signTransaction which handles it fine.
      if (!serializer) {
        console.log(`[SIGN] Delegating to Privy's original signTransaction`);
        return base.signTransaction!(transaction) as Promise<Hex>;
      }

      // Custom serializer present (Tempo chain) — sign locally using the
      // same pattern as viem's privateKeyToAccount:
      //   1. Serialize unsigned tx → hash
      //   2. Sign hash via Privy's raw secp256k1 signer
      //   3. Re-serialize with signature

      // Step 1: Serialize the unsigned transaction and hash it
      console.log(`[SIGN] Step 1: Serializing unsigned tx...`);
      const unsignedSerialized = await serializer(transaction);
      const hash = keccak256(unsignedSerialized as Hex);
      console.log(`[SIGN] Step 1 done — hash=${hash.slice(0, 18)}...`);

      // Step 2: Sign the hash using Privy's raw sign() — this does pure
      // secp256k1 signing with NO transaction type validation
      console.log(`[SIGN] Step 2: Calling Privy sign({ hash })...`);
      const rawSignature = await base.sign!({ hash });
      console.log(`[SIGN] Step 2 done — sig=${rawSignature.slice(0, 18)}...`);

      // Step 3: Parse the signature into { r, s, yParity } and re-serialize
      // the transaction with the signature attached
      console.log(`[SIGN] Step 3: Re-serializing with signature...`);
      const signature = parseSignature(rawSignature);
      const signedSerialized = await serializer(transaction, signature);
      console.log(`[SIGN] Step 3 done — signed tx length=${(signedSerialized as string).length}`);

      return signedSerialized as Hex;
    },
  } as LocalAccount;
}
