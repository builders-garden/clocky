# iMessage Pay Bot — Implementation Plan

> **Design spec:** See `docs/specs/2026-03-19-mpp-hack-design.md` for architecture, design decisions, and rationale.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an iMessage bot that lets users (1) send PathUSD stablecoins to each other via natural language commands, and (2) consume any MPP-enabled service (AI, search, data) paid from their wallet — all with zero-step onboarding and Privy-managed custody. Supports both 1:1 DMs and group chats (e.g., add the bot to a group so multiple people can use it for GPT queries, each paying from their own wallet).

**Architecture:** iMessage Kit watches incoming messages on macOS via both `onDirectMessage` and `onGroupMessage` callbacks — both feed into the same command router. A reply-routing layer decides per-command whether to respond in the group (public: `ask`, `send`, `help`) or via private DM (sensitive: `balance`, `deposit`, `history`). Users are identified by `msg.sender` (phone number), which works identically in DMs and groups. Privy server wallets provide per-user custody — each phone number gets a dedicated Privy wallet via `@privy-io/node`. P2P transfers use viem + `tempoActions()` with `createViemAccount` from `@privy-io/node/viem`. MPP-paid services use `mppx` with the same Privy-backed viem account. Gas is sponsored by Privy (`sponsor: true` in dashboard). SQLite stores phone→walletId mapping and transaction history.

**Tech Stack:**
- Bun (runtime)
- TypeScript
- `@photon-ai/imessage-kit` (iMessage reading/sending)
- `@privy-io/node` + `@privy-io/node/viem` (wallet custody + viem account adapter)
- `viem` + `viem/tempo` + `tempoActions()` (Tempo chain interaction)
- `mppx` (MPP client for paid service consumption)
- `bun:sqlite` (persistence)

**Key docs referenced:**
- Privy + Tempo recipe: https://docs.privy.io/recipes/evm/tempo
- Privy MPP recipe: https://docs.privy.io/recipes/agent-integrations/mpp
- MPP client quickstart: https://mpp.dev/quickstart/client
- MPP services: https://mpp.dev/services
- iMessage Kit: https://github.com/photon-hq/imessage-kit

---

## File Structure

```
~/Desktop/GitHub/mpp-hack/                       # Monorepo root
├── docs/
│   ├── specs/
│   │   └── 2026-03-19-mpp-hack-design.md        # Design spec
│   └── plans/
│       └── 2026-03-19-imessage-p2p-payments.md   # This plan
├── apps/
│   ├── imessage-bot/                             # iMessage bot app
│   │   ├── src/
│   │   │   ├── index.ts          # Entry point — iMessage watcher + graceful shutdown
│   │   │   ├── bot.ts            # Message router — parse commands, dispatch handlers
│   │   │   ├── config.ts         # Env vars, constants, chain config
│   │   │   ├── commands/
│   │   │   │   ├── send.ts       # "send $X to +Y" — core P2P transfer
│   │   │   │   ├── ask.ts        # "ask <prompt>" — query any MPP service
│   │   │   │   ├── balance.ts    # "balance" — check PathUSD balance
│   │   │   │   ├── deposit.ts    # "deposit" — show wallet address
│   │   │   │   ├── help.ts       # "help" — list available commands
│   │   │   │   └── history.ts    # "history" — recent transactions
│   │   │   ├── wallet/
│   │   │   │   ├── privy.ts      # Privy client init, wallet creation, viem account
│   │   │   │   └── transfer.ts   # PathUSD transfers + balance queries on Tempo
│   │   │   ├── mpp/
│   │   │   │   └── client.ts     # Generic MPP client — wraps mppx
│   │   │   └── db/
│   │   │       ├── schema.ts     # SQLite schema init
│   │   │       ├── users.ts      # User CRUD — phone ↔ walletId ↔ address
│   │   │       └── transactions.ts # Transaction log CRUD
│   │   ├── package.json          # Bot-specific dependencies
│   │   ├── tsconfig.json
│   │   └── .env.example          # Privy + Tempo + MPP vars
│   └── mpp-service/              # Custom MPP service (future, not in this plan)
│       └── ...
├── package.json                  # Root — Bun workspaces config only
├── .gitignore
└── .env.example                  # Shared env template
```

**Responsibility boundaries:**
- `wallet/` owns all Privy + Tempo chain interactions. Exports: `createUserWallet()`, `getViemAccount()`, `getBalance()`, `transferPathUSD()`, `parseAmount()`.
- `mpp/` owns MPP service consumption. Exports: `mppFetch()`. Takes a viem account + URL + request options, returns the response.
- `db/` owns all SQLite access. Nothing else opens the database.
- `commands/` are handlers: receive parsed input + dependencies, return a reply string.
- `bot.ts` is the glue: parses messages, resolves users, calls commands.
- `index.ts` is boot only: start watcher, wire dependencies, handle shutdown.

---

## Prerequisites (Manual, Before Task 1)

Before starting implementation, complete these one-time setup steps:

1. **Privy Account Setup:**
   - Sign up at https://dashboard.privy.io
   - Create a new app → note the `PRIVY_APP_ID`
   - Generate an app secret → note the `PRIVY_APP_SECRET`

2. **Gas Sponsorship:**
   - In the Privy Dashboard, enable gas sponsorship for Tempo (chain ID `eip155:42431` for testnet, `eip155:4217` for mainnet)
   - This lets users transact without holding native Tempo tokens

3. **Treasury Wallet (optional, for funding users):**
   - In the Privy dashboard, create a server wallet — this is your "treasury"
   - Note its `TREASURY_WALLET_ID` and `TREASURY_ADDRESS`
   - Fund it with testnet PathUSD from https://docs.tempo.xyz/quickstart/faucet

4. **macOS Permissions:**
   - Grant Full Disk Access to your terminal app (System Settings → Privacy & Security → Full Disk Access)
   - Required for iMessage Kit to read the Messages database

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json` (root — workspaces)
- Create: `.gitignore` (root)
- Create: `apps/imessage-bot/package.json`
- Create: `apps/imessage-bot/tsconfig.json`
- Create: `apps/imessage-bot/.env.example`
- Create: `apps/imessage-bot/src/config.ts`

- [ ] **Step 1: Set up monorepo root**

```bash
cd ~/Desktop/GitHub/mpp-hack
```

Write root `package.json`:
```json
{
  "name": "mpp-hack",
  "private": true,
  "workspaces": ["apps/*"]
}
```

Write root `.gitignore`:
```gitignore
node_modules/
dist/
.env
*.db
*.sqlite
```

- [ ] **Step 2: Initialize the bot app**

```bash
mkdir -p apps/imessage-bot
cd apps/imessage-bot
bun init -y
```

- [ ] **Step 3: Install dependencies**

```bash
cd ~/Desktop/GitHub/mpp-hack/apps/imessage-bot
bun add @photon-ai/imessage-kit @privy-io/node viem mppx
```

- [ ] **Step 4: Write apps/imessage-bot/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["bun-types"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 5: Write apps/imessage-bot/.env.example**

```env
# Privy
PRIVY_APP_ID=your-app-id
PRIVY_APP_SECRET=your-app-secret

# Treasury (optional — for funding user wallets)
TREASURY_WALLET_ID=your-treasury-wallet-id
TREASURY_ADDRESS=0x...

# MPP service (default: OpenAI via MPP proxy)
# Swap this URL to use any MPP service: https://mpp.dev/services
MPP_SERVICE_URL=https://openai.mpp.tempo.xyz/v1/chat/completions
MPP_MODEL=gpt-4o

# Bot
BOT_PHONE=+1234567890
```

- [ ] **Step 6: Write apps/imessage-bot/src/config.ts**

```typescript
// src/config.ts
// Central configuration — env vars + constants

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const config = {
  privy: {
    appId: required("PRIVY_APP_ID"),
    appSecret: required("PRIVY_APP_SECRET"),
  },
  treasury: {
    walletId: process.env.TREASURY_WALLET_ID || "",
    address: (process.env.TREASURY_ADDRESS || "") as `0x${string}`,
  },
  mpp: {
    serviceUrl: optional(
      "MPP_SERVICE_URL",
      "https://openai.mpp.tempo.xyz/v1/chat/completions"
    ),
    model: optional("MPP_MODEL", "gpt-4o"),
  },
  botPhone: process.env.BOT_PHONE || "",
  dbPath: optional("DB_PATH", "imessage-pay.db"),
} as const;

// PathUSD token address on Tempo
export const PATHUSD_ADDRESS =
  "0x20c0000000000000000000000000000000000000" as const;

// Tempo CAIP-2 identifiers for Privy
export const TEMPO_TESTNET_CAIP2 = "eip155:42431";
export const TEMPO_MAINNET_CAIP2 = "eip155:4217";
```

- [ ] **Step 7: Verify it compiles**

Run: `bun run apps/imessage-bot/src/config.ts 2>&1 || true`
Expected: May error on missing env vars — that's fine. Should NOT error on import/syntax issues.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: monorepo scaffold with imessage-bot app"
```

---

## Task 2: Database Layer

**Files:**
- Create: `apps/imessage-bot/src/db/schema.ts`
- Create: `apps/imessage-bot/src/db/users.ts`
- Create: `apps/imessage-bot/src/db/transactions.ts`

- [ ] **Step 1: Write apps/imessage-bot/src/db/schema.ts**

```typescript
// src/db/schema.ts
// SQLite schema initialization using bun:sqlite

import { Database } from "bun:sqlite";

export function initDb(path: string): Database {
  const db = new Database(path, { create: true });

  db.run("PRAGMA journal_mode=WAL");

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY,
      privy_wallet_id TEXT NOT NULL UNIQUE,
      address TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_phone TEXT NOT NULL,
      to_phone TEXT NOT NULL,
      amount TEXT NOT NULL,
      tx_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (from_phone) REFERENCES users(phone),
      FOREIGN KEY (to_phone) REFERENCES users(phone)
    )
  `);

  return db;
}
```

- [ ] **Step 2: Write apps/imessage-bot/src/db/users.ts**

```typescript
// src/db/users.ts
// User CRUD — maps phone numbers to Privy wallets

import type { Database } from "bun:sqlite";

export interface User {
  phone: string;
  privy_wallet_id: string;
  address: string;
  created_at: string;
}

export function getUser(db: Database, phone: string): User | null {
  return db.query<User, [string]>(
    "SELECT * FROM users WHERE phone = ?"
  ).get(phone);
}

export function getUserByAddress(db: Database, address: string): User | null {
  return db.query<User, [string]>(
    "SELECT * FROM users WHERE address = ?"
  ).get(address);
}

export function createUser(
  db: Database,
  phone: string,
  privyWalletId: string,
  address: string
): User {
  db.run(
    "INSERT INTO users (phone, privy_wallet_id, address) VALUES (?, ?, ?)",
    [phone, privyWalletId, address]
  );
  return getUser(db, phone)!;
}

export function getAllUsers(db: Database): User[] {
  return db.query<User, []>("SELECT * FROM users").all();
}
```

- [ ] **Step 3: Write apps/imessage-bot/src/db/transactions.ts**

```typescript
// src/db/transactions.ts
// Transaction log CRUD

import type { Database } from "bun:sqlite";

export interface Transaction {
  id: number;
  from_phone: string;
  to_phone: string;
  amount: string;
  tx_hash: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

export function logTransaction(
  db: Database,
  fromPhone: string,
  toPhone: string,
  amount: string
): number {
  const result = db.run(
    "INSERT INTO transactions (from_phone, to_phone, amount, status) VALUES (?, ?, ?, 'pending')",
    [fromPhone, toPhone, amount]
  );
  return Number(result.lastInsertRowid);
}

export function updateTransaction(
  db: Database,
  id: number,
  update: { txHash?: string; status?: string; error?: string }
): void {
  const sets: string[] = [];
  const vals: (string | number)[] = [];

  if (update.txHash !== undefined) {
    sets.push("tx_hash = ?");
    vals.push(update.txHash);
  }
  if (update.status !== undefined) {
    sets.push("status = ?");
    vals.push(update.status);
  }
  if (update.error !== undefined) {
    sets.push("error = ?");
    vals.push(update.error);
  }

  if (sets.length === 0) return;

  vals.push(id);
  db.run(`UPDATE transactions SET ${sets.join(", ")} WHERE id = ?`, vals);
}

export function getTransactionsForUser(
  db: Database,
  phone: string,
  limit: number = 5
): Transaction[] {
  return db.query<Transaction, [string, string, number]>(
    "SELECT * FROM transactions WHERE from_phone = ? OR to_phone = ? ORDER BY created_at DESC LIMIT ?",
  ).all(phone, phone, limit);
}
```

- [ ] **Step 4: Verify schema initialization works**

Run: `bun -e "import { initDb } from './apps/imessage-bot/src/db/schema'; const db = initDb(':memory:'); console.log('OK:', db.query('SELECT name FROM sqlite_master').all())"`
Expected: `OK: [ { name: "users" }, { name: "transactions" } ]`

- [ ] **Step 5: Commit**

```bash
git add apps/imessage-bot/src/db/
git commit -m "feat: SQLite database layer for users and transactions"
```

---

## Task 3: Privy Wallet Layer

**Files:**
- Create: `apps/imessage-bot/src/wallet/privy.ts`

This task uses Privy's official APIs per https://docs.privy.io/recipes/evm/tempo:
- `@privy-io/node` for wallet creation
- `createViemAccount` from `@privy-io/node/viem` for the viem account adapter (replaces our old manual 50-line signer)

- [ ] **Step 1: Write apps/imessage-bot/src/wallet/privy.ts**

```typescript
// src/wallet/privy.ts
// Privy SDK: wallet creation + viem account adapter
//
// Uses createViemAccount from @privy-io/node/viem — this is the official
// Privy adapter that bridges server wallets to viem's Account interface.
// See: https://docs.privy.io/recipes/evm/tempo

import { PrivyClient } from "@privy-io/node";
import { createViemAccount } from "@privy-io/node/viem";
import type { Account } from "viem";
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
  address: string;
}

/**
 * Create a new Ethereum wallet via Privy.
 * Each user gets their own server-managed wallet.
 * Works on any EVM chain including Tempo.
 */
export async function createUserWallet(): Promise<PrivyWallet> {
  const privy = getPrivyClient();
  const wallet = await privy.wallets().create({ chainType: "ethereum" });
  return {
    id: wallet.id,
    address: wallet.address,
  };
}

/**
 * Get a viem-compatible Account backed by a Privy server wallet.
 * This account can be used with:
 *   - viem wallet clients (for P2P transfers via tempoActions)
 *   - mppx (for MPP-paid service consumption)
 */
export function getViemAccount(
  walletId: string,
  address: `0x${string}`
): Account {
  const privy = getPrivyClient();
  return createViemAccount(privy, { walletId, address });
}
```

**Note:** The `chainType` parameter in `wallets().create()` may be `chain_type` depending on the SDK version. Check `@privy-io/node` types after install and adjust if needed.

- [ ] **Step 2: Verify Privy client instantiation**

Run: `bun -e "import { getPrivyClient } from './apps/imessage-bot/src/wallet/privy'; console.log('Client:', typeof getPrivyClient())"`
Expected: Requires env vars. With proper `.env`: `Client: object`

- [ ] **Step 3: Commit**

```bash
git add apps/imessage-bot/src/wallet/privy.ts
git commit -m "feat: Privy wallet layer with createViemAccount adapter"
```

---

## Task 4: Transfer Module

**Files:**
- Create: `apps/imessage-bot/src/wallet/transfer.ts`

Uses the official Privy+Tempo approach: `createWalletClient` + `tempoActions()` for `token.transferSync()`.
See: https://docs.privy.io/recipes/evm/tempo

There are two transfer approaches documented by Privy:
1. **viem + tempoActions()** — `walletClient.token.transferSync()` (cleaner, used for P2P)
2. **Privy direct** — `privy.wallets().ethereum().sendTransaction()` with `sponsor: true` (needed if gas sponsorship via Privy dashboard is required)

We implement both: approach 1 as default (cleaner), with approach 2 as the fallback for gas-sponsored transfers if approach 1 fails due to gas issues.

- [ ] **Step 1: Write apps/imessage-bot/src/wallet/transfer.ts**

```typescript
// src/wallet/transfer.ts
// PathUSD transfers + balance on Tempo chain
//
// Uses tempoActions() per https://docs.privy.io/recipes/evm/tempo

import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  parseUnits,
  encodeFunctionData,
  type Account,
} from "viem";
import { tempoModerato } from "viem/chains";
import { tempoActions } from "viem/tempo";
import { PATHUSD_ADDRESS, TEMPO_TESTNET_CAIP2 } from "../config";
import { getPrivyClient } from "./privy";

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
  chain: tempoModerato,
  transport: http(),
});

/**
 * Get PathUSD balance for an address.
 * Returns formatted string like "5.00".
 */
export async function getBalance(address: `0x${string}`): Promise<string> {
  const balance = await publicClient.readContract({
    address: PATHUSD_ADDRESS,
    abi: TOKEN_ABI,
    functionName: "balanceOf",
    args: [address],
  });
  return formatUnits(balance, 6); // PathUSD has 6 decimals
}

/**
 * Transfer PathUSD from one Privy-backed account to another address.
 * 
 * Primary approach: viem walletClient + tempoActions().token.transferSync()
 * Fallback: Privy direct sendTransaction with sponsor: true (for gas sponsorship)
 *
 * Returns the transaction hash.
 */
export async function transferPathUSD(
  fromAccount: Account,
  fromWalletId: string,
  toAddress: `0x${string}`,
  amount: string // e.g. "5.00"
): Promise<string> {
  const parsedAmount = parseUnits(amount, 6);

  // Try viem + tempoActions first (cleaner API)
  try {
    const walletClient = createWalletClient({
      account: fromAccount,
      chain: tempoModerato,
      transport: http(),
    }).extend(tempoActions());

    const receipt = await walletClient.token.transferSync({
      to: toAddress,
      amount: parsedAmount,
      token: PATHUSD_ADDRESS,
    });

    return receipt.transactionHash;
  } catch (err) {
    console.warn("tempoActions transfer failed, trying Privy direct:", err);
  }

  // Fallback: Privy direct with gas sponsorship
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
      caip2: TEMPO_TESTNET_CAIP2,
      params: {
        transaction: {
          to: PATHUSD_ADDRESS,
          data: encodedData,
        },
      },
      sponsor: true,
    });

  return result.transactionHash;
}

/**
 * Parse a dollar amount string like "$5", "$5.00", "5", "5.50" into a clean decimal string.
 * Returns null if the input is not a valid amount.
 */
export function parseAmount(input: string): string | null {
  const cleaned = input.replace(/^\$/, "").trim();
  const num = parseFloat(cleaned);
  if (isNaN(num) || num <= 0) return null;
  return num.toFixed(6).replace(/\.?0+$/, "");
}
```

**Note:** The `walletClient.token.transferSync()` return shape may vary — it might return a receipt object or a hash string. The `result.transactionHash` from the Privy direct approach may also be named differently. Check types after install.

- [ ] **Step 2: Quick smoke test**

Run: `bun -e "import { parseAmount } from './apps/imessage-bot/src/wallet/transfer'; console.log(parseAmount('$5.00'), parseAmount('invalid'))"`
Expected: `5 null`

- [ ] **Step 3: Commit**

```bash
git add apps/imessage-bot/src/wallet/transfer.ts
git commit -m "feat: PathUSD transfers via tempoActions with Privy gas sponsorship fallback"
```

---

## Task 5: MPP Client

**Files:**
- Create: `apps/imessage-bot/src/mpp/client.ts`

Generic MPP client that wraps `mppx` with a Privy-backed viem account. Service-agnostic — the URL and request shape are passed in by the caller. This lets us plug in any MPP service (OpenAI, Anthropic, Exa, weather, etc.) without changing this module.

- [ ] **Step 1: Write apps/imessage-bot/src/mpp/client.ts**

```typescript
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
    methods: [tempo({ account })],
  });

  return mppx.fetch(url, init);
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/imessage-bot/src/mpp/client.ts
git commit -m "feat: generic MPP client wrapping mppx with Privy accounts"
```

---

## Task 6: Command Handlers

**Files:**
- Create: `apps/imessage-bot/src/commands/help.ts`
- Create: `apps/imessage-bot/src/commands/balance.ts`
- Create: `apps/imessage-bot/src/commands/deposit.ts`
- Create: `apps/imessage-bot/src/commands/history.ts`
- Create: `apps/imessage-bot/src/commands/send.ts`
- Create: `apps/imessage-bot/src/commands/ask.ts`

Each handler receives dependencies and returns a reply string.

- [ ] **Step 1: Write apps/imessage-bot/src/commands/help.ts**

```typescript
// src/commands/help.ts

export function handleHelp(): string {
  return [
    "iMessage Pay — Commands:",
    "",
    "send $5 to +1234567890 — Send PathUSD to someone",
    "ask <question> — Ask AI (paid via MPP from your balance)",
    "balance — Check your PathUSD balance",
    "deposit — Get your wallet address to receive funds",
    "history — View recent transactions",
    "help — Show this message",
  ].join("\n");
}
```

- [ ] **Step 2: Write apps/imessage-bot/src/commands/balance.ts**

```typescript
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
    return `Your balance: $${balance} PathUSD`;
  } catch (err) {
    console.error("Balance check failed:", err);
    return "Sorry, couldn't check your balance right now. Try again in a moment.";
  }
}
```

- [ ] **Step 3: Write apps/imessage-bot/src/commands/deposit.ts**

```typescript
// src/commands/deposit.ts

import type { User } from "../db/users";

export function handleDeposit(user: User): string {
  return [
    "Your deposit address (Tempo network):",
    "",
    user.address,
    "",
    "Send PathUSD to this address to fund your account.",
    "Faucet (testnet): https://docs.tempo.xyz/quickstart/faucet",
  ].join("\n");
}
```

- [ ] **Step 4: Write apps/imessage-bot/src/commands/history.ts**

```typescript
// src/commands/history.ts

import type { Database } from "bun:sqlite";
import { getTransactionsForUser } from "../db/transactions";

export function handleHistory(db: Database, phone: string): string {
  const txs = getTransactionsForUser(db, phone, 5);

  if (txs.length === 0) {
    return "No transactions yet. Send your first payment with: send $5 to +1234567890";
  }

  const lines = txs.map((tx) => {
    const direction = tx.from_phone === phone ? "Sent" : "Received";
    const other = tx.from_phone === phone ? tx.to_phone : tx.from_phone;
    const status = tx.status === "confirmed" ? "" : ` (${tx.status})`;
    return `${direction} $${tx.amount} ${direction === "Sent" ? "to" : "from"} ${other}${status}`;
  });

  return ["Recent transactions:", "", ...lines].join("\n");
}
```

- [ ] **Step 5: Write apps/imessage-bot/src/commands/send.ts**

```typescript
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

  // 2. Can't send to yourself
  if (input.recipientPhone === sender.phone) {
    return "You can't send money to yourself.";
  }

  // 3. Check balance
  const balance = await deps.getBalance(sender.address as `0x${string}`);
  if (parseFloat(balance) < parseFloat(amount)) {
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
```

- [ ] **Step 6: Write apps/imessage-bot/src/commands/ask.ts**

This is the MPP-powered command. It's service-agnostic — the configured MPP_SERVICE_URL
determines what service gets called. Default is OpenAI chat completions via MPP proxy.

```typescript
// src/commands/ask.ts
// "ask <prompt>" — query any MPP service, paid from user's wallet balance.
//
// The service URL comes from config.mpp.serviceUrl.
// Default: OpenAI chat completions via https://openai.mpp.tempo.xyz
// To swap services, just change MPP_SERVICE_URL in .env.

import type { Account } from "viem";
import { config } from "../config";

export interface AskDeps {
  mppFetch: (account: Account, url: string, init?: RequestInit) => Promise<Response>;
  getViemAccount: (walletId: string, address: `0x${string}`) => Account;
}

export interface AskInput {
  prompt: string;
  walletId: string;
  address: `0x${string}`;
}

export async function handleAsk(
  input: AskInput,
  deps: AskDeps
): Promise<string> {
  if (!input.prompt.trim()) {
    return 'Please provide a question. Example: ask what is the capital of France';
  }

  try {
    const account = deps.getViemAccount(input.walletId, input.address);

    // Build the request for OpenAI-compatible chat completions
    // This format works with: openai.mpp.tempo.xyz, anthropic.mpp.tempo.xyz,
    // openrouter.mpp.tempo.xyz, gemini.mpp.tempo.xyz, etc.
    const body = JSON.stringify({
      model: config.mpp.model,
      messages: [{ role: "user", content: input.prompt }],
    });

    const response = await deps.mppFetch(account, config.mpp.serviceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      console.error(`MPP service error ${response.status}:`, errorText);
      return `Service error (${response.status}). Make sure you have sufficient balance.`;
    }

    const data = await response.json() as any;

    // Extract the reply — OpenAI chat completions format
    const reply =
      data?.choices?.[0]?.message?.content ||
      data?.content?.[0]?.text ||
      JSON.stringify(data).slice(0, 500);

    return reply;
  } catch (err) {
    console.error("Ask command failed:", err);
    const msg = err instanceof Error ? err.message : "Unknown error";
    return `Failed to query service: ${msg}`;
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add apps/imessage-bot/src/commands/
git commit -m "feat: command handlers — send, ask (MPP), balance, deposit, history, help"
```

---

## Task 7: Bot Router

**Files:**
- Create: `apps/imessage-bot/src/bot.ts`

**Group chat design:**

The bot supports both DMs and group chats. The key design decision is **reply routing** — where the bot sends its response:

| Command | Reply goes to | Reason |
|---------|---------------|--------|
| `ask`   | Group (public) | Everyone benefits from seeing the answer |
| `send`  | Group (public) | Confirmation is useful context for both parties |
| `help`  | Same channel (group or DM) | Contextual |
| `balance` | Private DM | Sensitive — don't leak balances to group |
| `deposit` | Private DM | Sensitive — wallet address is private |
| `history` | Private DM | Sensitive — transaction history is private |
| `unknown` | Same channel | Helpful for everyone |

The `handleMessage` function returns a `BotReply` object with the reply text and a `private` flag. The caller (index.ts) uses the flag to decide where to send it: if `private` is true, always DM the sender regardless of whether the message came from a group. If false, reply to wherever the message came from (group chatId or DM sender).

- [ ] **Step 1: Write apps/imessage-bot/src/bot.ts**

```typescript
// src/bot.ts
// Message router — parses natural language commands, dispatches to handlers
// Supports both DMs and group chats with per-command reply routing.

import type { Database } from "bun:sqlite";
import type { User } from "./db/users";
import { getUser, createUser } from "./db/users";
import { handleHelp } from "./commands/help";
import { handleBalance } from "./commands/balance";
import { handleDeposit } from "./commands/deposit";
import { handleHistory } from "./commands/history";
import { handleSend, type SendInput } from "./commands/send";
import { handleAsk } from "./commands/ask";
import { createUserWallet, getViemAccount } from "./wallet/privy";
import { getBalance, transferPathUSD, parseAmount } from "./wallet/transfer";
import { mppFetch } from "./mpp/client";

export interface BotDeps {
  db: Database;
  sendMessage: (phone: string, text: string) => Promise<void>;
}

/**
 * A reply from the bot, with routing info.
 * - `text`: the reply content
 * - `private`: if true, always send as a DM to the sender (even if the
 *   original message came from a group). Used for sensitive info like
 *   balances and deposit addresses.
 */
export interface BotReply {
  text: string;
  private: boolean;
}

/**
 * Ensure a user exists for the given phone number.
 * If they don't exist, create a Privy wallet and register them.
 */
async function getOrCreateUser(db: Database, phone: string): Promise<User> {
  const existing = getUser(db, phone);
  if (existing) return existing;

  console.log(`Creating wallet for new user: ${phone}`);
  const wallet = await createUserWallet();
  return createUser(db, phone, wallet.id, wallet.address);
}

/**
 * Parse a message into a command.
 */
type Command =
  | { type: "send"; input: SendInput }
  | { type: "ask"; prompt: string }
  | { type: "balance" }
  | { type: "deposit" }
  | { type: "history" }
  | { type: "help" }
  | { type: "unknown" };

function parseCommand(text: string): Command {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // "send $5 to +1234567890"
  const sendMatch = trimmed.match(
    /^send\s+(\$?[\d.]+)\s+to\s+(\+\d{10,15})$/i
  );
  if (sendMatch) {
    return {
      type: "send",
      input: { amount: sendMatch[1], recipientPhone: sendMatch[2] },
    };
  }

  // "ask <anything>"
  const askMatch = trimmed.match(/^ask\s+(.+)$/is);
  if (askMatch) {
    return { type: "ask", prompt: askMatch[1] };
  }

  if (lower === "balance" || lower === "bal") return { type: "balance" };
  if (lower === "deposit" || lower === "address") return { type: "deposit" };
  if (lower === "history" || lower === "txs") return { type: "history" };

  if (
    lower === "help" ||
    lower === "?" ||
    lower === "commands" ||
    lower === "start" ||
    lower === "hey" ||
    lower === "hi" ||
    lower === "hello"
  ) {
    return { type: "help" };
  }

  return { type: "unknown" };
}

/**
 * Process an incoming message and return a reply with routing info.
 *
 * The `private` flag tells the caller whether to reply in-channel or via DM:
 * - private: true  → always DM the sender (balance, deposit, history)
 * - private: false → reply to wherever the message came from (group or DM)
 */
export async function handleMessage(
  senderPhone: string,
  text: string,
  deps: BotDeps
): Promise<BotReply> {
  const sender = await getOrCreateUser(deps.db, senderPhone);
  const command = parseCommand(text);

  switch (command.type) {
    case "help":
      return { text: handleHelp(), private: false };

    case "balance":
      return {
        text: await handleBalance(sender, { getBalance }),
        private: true,  // Don't leak balance to group
      };

    case "deposit":
      return {
        text: handleDeposit(sender),
        private: true,  // Don't leak wallet address to group
      };

    case "history":
      return {
        text: handleHistory(deps.db, senderPhone),
        private: true,  // Don't leak tx history to group
      };

    case "send":
      return {
        text: await handleSend(deps.db, sender, command.input, {
          getBalance,
          transferPathUSD,
          parseAmount,
          getOrCreateUser: (phone) => getOrCreateUser(deps.db, phone),
          getViemAccount,
          sendMessage: deps.sendMessage,
        }),
        private: false,  // Send confirmations are public
      };

    case "ask":
      return {
        text: await handleAsk(
          {
            prompt: command.prompt,
            walletId: sender.privy_wallet_id,
            address: sender.address as `0x${string}`,
          },
          { mppFetch, getViemAccount }
        ),
        private: false,  // GPT answers are public — the whole point of group usage
      };

    case "unknown":
      return {
        text: [
          `I didn't understand that. Try:`,
          ``,
          `send $5 to +1234567890`,
          `ask what is the capital of France`,
          `balance`,
          `deposit`,
          `history`,
          `help`,
        ].join("\n"),
        private: false,
      };
  }
}
```

- [ ] **Step 2: Verify imports resolve**

Run: `bun build apps/imessage-bot/src/bot.ts --outdir /tmp/test-build 2>&1`
Expected: Build succeeds (runtime errors from missing env are OK).

- [ ] **Step 3: Commit**

```bash
git add apps/imessage-bot/src/bot.ts
git commit -m "feat: bot message router with group chat reply routing"
```

---

## Task 8: Entry Point

**Files:**
- Create: `apps/imessage-bot/src/index.ts`

- [ ] **Step 1: Write apps/imessage-bot/src/index.ts**

```typescript
// src/index.ts
// Entry point — starts iMessage watcher, wires dependencies, handles shutdown
// Supports both DM and group chat messages with reply routing.

import { ImessageKit } from "@photon-ai/imessage-kit";
import { initDb } from "./db/schema";
import { handleMessage, type BotReply } from "./bot";
import { config } from "./config";

async function main() {
  console.log("Starting iMessage Pay bot...");

  // Initialize database
  const db = initDb(config.dbPath);
  console.log("Database initialized.");

  // Initialize iMessage SDK
  const sdk = new ImessageKit();

  async function sendMessage(phone: string, text: string): Promise<void> {
    await sdk.send(phone, text);
  }

  /**
   * Core message handler — used by both onDirectMessage and onGroupMessage.
   *
   * Reply routing:
   * - If reply.private is true → always DM the sender (balance, deposit, history)
   * - If reply.private is false:
   *   - In a DM → reply to sender
   *   - In a group → reply to the group chatId
   */
  async function processMessage(msg: {
    sender: string;
    text: string | null;
    isFromMe: boolean;
    isGroupChat: boolean;
    chatId: string;
  }) {
    const senderPhone = msg.sender;
    const text = msg.text;

    if (!senderPhone || !text) return;
    if (msg.isFromMe) return;
    if (config.botPhone && senderPhone === config.botPhone) return;

    const label = msg.isGroupChat
      ? `[GROUP ${msg.chatId.slice(0, 12)}... | ${senderPhone}]`
      : `[${senderPhone}]`;
    console.log(`${label}: ${text}`);

    try {
      const reply: BotReply = await handleMessage(senderPhone, text, {
        db,
        sendMessage,
      });

      // Reply routing: private replies always go as DM to sender
      if (reply.private || !msg.isGroupChat) {
        await sdk.send(senderPhone, reply.text);
        console.log(`[BOT -> ${senderPhone} (DM)]: ${reply.text.slice(0, 100)}...`);
      } else {
        // Public reply in group
        await sdk.send(msg.chatId, reply.text);
        console.log(`[BOT -> GROUP ${msg.chatId.slice(0, 12)}...]: ${reply.text.slice(0, 100)}...`);
      }
    } catch (err) {
      console.error(`Error handling message from ${senderPhone}:`, err);
      // Error replies go to the same channel as the original message
      const errorTarget = msg.isGroupChat ? msg.chatId : senderPhone;
      await sdk.send(errorTarget, "Something went wrong. Please try again.");
    }
  }

  // Start watching for messages — both DMs and group chats
  sdk.startWatching({
    onDirectMessage: processMessage,
    onGroupMessage: processMessage,
  });

  console.log(`
  ┌────────────────────────────────┐
  │     iMessage Pay Bot           │
  │     Tempo Testnet              │
  │     Privy Custody + MPP        │
  ├────────────────────────────────┤
  │  Watching DMs + Groups...      │
  └────────────────────────────────┘
  `);

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    db.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("\nShutting down...");
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
```

**Note:** The iMessage Kit SDK provides `msg.sender` (individual phone), `msg.isGroupChat`, `msg.chatId`, and `msg.isFromMe` on every message — identical shape for DMs and groups. `sdk.send(chatId, text)` auto-detects group vs DM targets.

- [ ] **Step 2: Add start scripts to apps/imessage-bot/package.json**

Add to `apps/imessage-bot/package.json` scripts:
```json
{
  "scripts": {
    "start": "bun run src/index.ts",
    "dev": "bun --watch run src/index.ts"
  }
}
```

- [ ] **Step 3: Verify the entry point compiles**

Run: `bun build apps/imessage-bot/src/index.ts --outdir /tmp/test-build 2>&1`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/imessage-bot/src/index.ts apps/imessage-bot/package.json
git commit -m "feat: entry point with iMessage watcher, group chat, and graceful shutdown"
```

---

## Task 9: Integration Testing

**Files:** No new files — manual testing against real iMessage + Tempo testnet.

- [ ] **Step 1: Set up .env**

```bash
cp .env.example .env
```
Fill in: `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `TREASURY_WALLET_ID`, `TREASURY_ADDRESS`, `BOT_PHONE`

- [ ] **Step 2: Start the bot**

```bash
bun run --cwd apps/imessage-bot dev
```
Expected: Startup banner appears.

- [ ] **Step 3: Test onboarding**

Text "hi" to your Mac's iMessage from another phone.
Expected: Bot replies with help message. Console shows "Creating wallet for new user: +1..."

- [ ] **Step 4: Test balance**

Text "balance"
Expected: "Your balance: $0 PathUSD"

- [ ] **Step 5: Test deposit**

Text "deposit"
Expected: Bot replies with Tempo wallet address.

- [ ] **Step 6: Fund via faucet**

Go to https://docs.tempo.xyz/quickstart/faucet and send PathUSD to the deposit address.

- [ ] **Step 7: Test P2P send**

Text: "send $1 to +SECOND_PHONE"
Expected: Confirmation with explorer link. Second phone gets notification.

- [ ] **Step 8: Test MPP ask command**

Text: "ask what is 2+2"
Expected: AI response from the configured MPP service. User's balance decreases slightly.

- [ ] **Step 9: Test group chat — add bot to a group**

Create an iMessage group with your Mac and at least one other phone.
Text "help" in the group.
Expected: Bot replies in the group with help text.

- [ ] **Step 10: Test group chat — ask command (public reply)**

In the group, text: "ask what is the tallest mountain"
Expected: Bot replies in the group — everyone in the group sees the answer.

- [ ] **Step 11: Test group chat — balance command (private reply)**

In the group, text: "balance"
Expected: Bot replies via private DM to the sender, NOT in the group. Other group members should not see the balance.

- [ ] **Step 12: Test group chat — send command**

In the group, text: "send $1 to +OTHER_PHONE"
Expected: Confirmation appears in the group. Recipient gets a DM notification.

- [ ] **Step 13: Fix any issues found**

Address API mismatches, property name differences, reply routing issues, etc.

- [ ] **Step 14: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration testing adjustments"
```

---

## Task 10: Polish

**Files:**
- Modify: `apps/imessage-bot/src/commands/send.ts` (input validation)
- Modify: `apps/imessage-bot/src/commands/ask.ts` (cost display)

- [ ] **Step 1: Add input validation to send command**

In `apps/imessage-bot/src/commands/send.ts`, after `parseAmount`:
```typescript
if (parseFloat(amount) < 0.01) {
  return "Minimum transfer amount is $0.01.";
}
if (parseFloat(amount) > 1000) {
  return "Maximum transfer amount is $1,000.";
}
```

- [ ] **Step 2: Show cost in ask replies**

In `apps/imessage-bot/src/commands/ask.ts`, after a successful response, try to extract the cost from the `Payment-Receipt` header:
```typescript
// After const data = await response.json():
const receipt = response.headers.get("payment-receipt");
const costNote = receipt ? `\n\n(MPP cost: see receipt)` : "";
return reply + costNote;
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "polish: input validation, cost display for MPP queries"
```

---

## Open Questions for Implementation

1. **`createViemAccount` import path** — Documented as `@privy-io/node/viem`. If this subpath doesn't resolve, check if it's exported from the main `@privy-io/node` package instead.

2. **`tempoActions()` return type** — The `token.transferSync()` method may return a receipt object or throw differently than expected. Check viem/tempo types after install.

3. **`wallets().create()` parameter** — May be `{ chainType: "ethereum" }` or `{ chain_type: "ethereum" }`. Check SDK types.

4. **iMessage Kit `msg` shape** — `msg.sender` vs `msg.handle`, `msg.text` vs `msg.body`. Check SDK types after install.

5. **Gas sponsorship** — The Privy fallback path uses `sponsor: true`. This requires gas sponsorship to be enabled for Tempo in the Privy Dashboard. If not configured, the fallback will also fail.

6. **mppx + Privy account compatibility** — The `tempo()` method in mppx expects a viem `Account`. Verify `createViemAccount` output satisfies this interface (it should, since both use viem's Account type).

7. **MPP service response format** — The `ask.ts` handler assumes OpenAI chat completions format (`choices[0].message.content`). If swapping to a non-chat-completions service, the response parsing needs adjustment. The fallback `JSON.stringify(data).slice(0, 500)` handles unknown formats gracefully.

---

## Resolved Design Decisions

### Group Chat Support

**Status:** Designed and integrated into Tasks 7-9.

**How it works:** iMessage Kit provides `onGroupMessage` with identical `Message` shape to DMs. `msg.sender` gives the individual phone number in groups, so wallet resolution works identically. `sdk.send(chatId, text)` auto-routes to the correct group.

**Reply routing by command:**

| Command | Reply to | Reason |
|---------|----------|--------|
| `ask` | Group (public) | Everyone benefits from seeing the answer |
| `send` | Group (public) | Confirmation is useful context |
| `help` | Same channel | Contextual |
| `unknown` | Same channel | Helpful for everyone |
| `balance` | Private DM | Don't leak balance info |
| `deposit` | Private DM | Don't leak wallet address |
| `history` | Private DM | Don't leak transaction history |

**Implementation:** `handleMessage()` returns `BotReply { text, private }`. The entry point checks `reply.private` — if true, always DMs the sender; if false, replies to the original channel (group chatId or DM sender).
