# MPP Hack — Design Spec

## Overview

A hackathon project demonstrating real-world usage of the Machine Payments Protocol (MPP) on Tempo. The project is a monorepo containing two independent applications:

1. **imessage-bot** — An iMessage bot for P2P stablecoin payments and AI queries, paid via MPP
2. **mpp-service** — A custom MPP-enabled service that the bot consumes (future, not designed yet)

The iMessage bot is the primary deliverable. It lets users send PathUSD to each other and query AI services — all through natural language commands in iMessage, with zero-step onboarding.

---

## Monorepo Structure

```
mpp-hack/
├── docs/
│   ├── specs/
│   │   └── 2026-03-19-mpp-hack-design.md     # This file
│   └── plans/
│       └── 2026-03-19-imessage-p2p-payments.md # Implementation plan (bot)
├── apps/
│   ├── imessage-bot/          # iMessage bot — P2P payments + MPP consumption
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── mpp-service/           # Custom MPP service (future)
│       ├── src/
│       ├── package.json
│       └── tsconfig.json
├── package.json               # Root — workspaces config only
├── .gitignore
└── .env.example               # Shared env template (each app may have its own too)
```

**Why a monorepo?** The two apps share context (same Tempo chain, same wallet infrastructure, same hackathon demo). During the hackathon, having them side-by-side makes iteration fast. No shared packages are needed — each app is fully independent with its own dependencies and build.

**Workspace manager:** Bun workspaces (configured in root `package.json`). Each app runs independently via `bun run --cwd apps/imessage-bot start`.

---

## App 1: iMessage Bot

### Purpose

An iMessage bot running on macOS that provides:
1. **P2P payments** — Send PathUSD stablecoins via natural language ("send $5 to +1234567890")
2. **AI queries via MPP** — Ask questions paid from the user's wallet ("ask what is the capital of France")
3. **Group chat support** — Add the bot to a group so multiple people can share AI access, each paying from their own wallet

### User Experience

**Zero-step onboarding:** The first message from any phone number auto-creates a Privy server wallet. No signup, no app download, no seed phrase. The user just texts the bot.

**DM flow (1:1):**
```
User:  hi
Bot:   iMessage Pay — Commands:
       send $5 to +1234567890 — Send PathUSD to someone
       ask <question> — Ask AI (paid via MPP from your balance)
       balance — Check your PathUSD balance
       deposit — Get your wallet address to receive funds
       history — View recent transactions
       help — Show this message

User:  balance
Bot:   Your balance: $0.00 PathUSD

User:  deposit
Bot:   Your deposit address (Tempo network):
       0xabc123...
       Send PathUSD to this address to fund your account.

User:  send $5 to +1987654321
Bot:   Sent $5 to +1987654321
       Tx: https://explore.tempo.xyz/tx/0x...
```

**Group chat flow:**
```
[Group: Alice, Bob, Bot]

Alice: ask what is the tallest building in the world
Bot:   The Burj Khalifa in Dubai at 828 meters (2,717 ft).
       ← reply visible to everyone in the group
       ← paid from Alice's wallet

Bob:   balance
       ← Bob gets a private DM with his balance, not shown in group

Bob:   ask who won the 2024 world series
Bot:   The Los Angeles Dodgers.
       ← reply visible to everyone in the group
       ← paid from Bob's wallet
```

### Reply Routing

The bot supports both DMs and group chats through a single message handler. The key design decision is **where the bot sends its reply**:

| Command   | Reply goes to  | Reason                                    |
|-----------|----------------|-------------------------------------------|
| `ask`     | Group (public) | Everyone benefits from seeing the answer   |
| `send`    | Group (public) | Confirmation is useful context             |
| `help`    | Same channel   | Contextual                                 |
| `unknown` | Same channel   | Helpful for everyone                       |
| `balance` | Private DM     | Don't leak balance info to group           |
| `deposit` | Private DM     | Don't leak wallet address to group         |
| `history` | Private DM     | Don't leak transaction history to group    |

**Implementation:** `handleMessage()` returns `{ text, private }`. The entry point checks `private` — if true, always DMs the sender; if false, replies to the original channel (group chatId or DM sender).

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  index.ts — Entry Point                                     │
│  Starts iMessage watcher, wires deps, handles shutdown      │
│  onDirectMessage + onGroupMessage → processMessage()        │
│  Reply routing: private → DM sender, public → same channel  │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  bot.ts — Message Router                                    │
│  parseCommand(text) → Command                               │
│  handleMessage(phone, text, deps) → BotReply { text, priv } │
│  getOrCreateUser(phone) → auto-onboarding                   │
└────┬──────┬──────┬──────┬──────┬──────┬─────────────────────┘
     │      │      │      │      │      │
     ▼      ▼      ▼      ▼      ▼      ▼
  send   ask    balance deposit history help     ← commands/
     │      │      │
     ▼      │      ▼
  wallet/   │   wallet/
  transfer  │   transfer.getBalance()
  .ts       │
     │      ▼
     │   mpp/
     │   client.ts → mppx → 402 flow → MPP service
     │
     ▼
  wallet/
  privy.ts → @privy-io/node + createViemAccount
     │
     ▼
  db/
  schema.ts + users.ts + transactions.ts → bun:sqlite
```

**Module boundaries:**
- `wallet/` — All Privy + Tempo chain interactions. Exports: `createUserWallet()`, `getViemAccount()`, `getBalance()`, `transferPathUSD()`, `parseAmount()`
- `mpp/` — MPP service consumption. Exports: `mppFetch()`. Takes a viem account + URL + request options, returns the response. Service-agnostic.
- `db/` — All SQLite access. Nothing else opens the database.
- `commands/` — Pure handlers: receive parsed input + dependencies, return a reply string.
- `bot.ts` — Glue: parses messages, resolves users, calls commands, returns `BotReply`.
- `index.ts` — Boot only: start watcher, wire dependencies, reply routing, shutdown.

### Technology Choices

| Component | Choice | Why |
|-----------|--------|-----|
| Runtime | Bun | Required by iMessage Kit (macOS, Full Disk Access) |
| iMessage | `@photon-ai/imessage-kit` | Only viable iMessage SDK for bots on macOS |
| Wallet custody | Privy server wallets (`@privy-io/node`) | Per-user wallets, no seed phrases, gas sponsorship |
| Viem adapter | `createViemAccount` from `@privy-io/node/viem` | Official one-liner, replaces manual 50-line signer |
| Transfers | `tempoActions()` + `token.transferSync()` | Official Privy+Tempo recipe for clean transfers |
| Gas | Privy `sponsor: true` | Users don't need native Tempo tokens |
| MPP client | `mppx` | Official MPP library, handles full 402 payment flow |
| Database | `bun:sqlite` | Zero dependencies, fast, good enough for hackathon |

### Wallet & Payment Design

**Custody model:** Each phone number gets a dedicated Privy server wallet. Privy holds the keys. The bot signs transactions on behalf of users via `createViemAccount`.

**P2P transfers:** viem wallet client extended with `tempoActions()` for `token.transferSync()`. Fallback: Privy direct `sendTransaction()` with `sponsor: true` for gas-sponsored transfers.

**MPP consumption:** `mppx` wraps the HTTP 402 payment flow. The bot sends a request to an MPP-enabled service; if the service returns 402, mppx auto-signs a payment credential using the user's Privy-backed viem account and retries. The user's PathUSD balance pays for the API call.

**Default MPP service:** OpenAI chat completions via `https://openai.mpp.tempo.xyz/v1/chat/completions`. Configurable via `MPP_SERVICE_URL` env var. Can point to any MPP service (Anthropic, Exa, Perplexity, our custom service, etc.) without code changes.

### Data Model

```sql
users
├── phone TEXT PRIMARY KEY        -- e.g. "+1234567890"
├── privy_wallet_id TEXT UNIQUE   -- Privy wallet ID
├── address TEXT UNIQUE           -- Ethereum address on Tempo
└── created_at TEXT               -- ISO timestamp

transactions
├── id INTEGER PRIMARY KEY
├── from_phone TEXT → users.phone
├── to_phone TEXT → users.phone
├── amount TEXT                   -- e.g. "5.00"
├── tx_hash TEXT                  -- Tempo transaction hash
├── status TEXT                   -- pending | confirmed | failed
├── error TEXT                    -- error message if failed
└── created_at TEXT
```

### iMessage Kit API Surface

Verified from SDK source (not just README):

- `onDirectMessage(msg)` — fires for 1:1 DMs
- `onGroupMessage(msg)` — fires for group messages
- `msg.sender` — individual phone number, works in both DMs and groups
- `msg.text` — message body
- `msg.isGroupChat` — boolean
- `msg.chatId` — group GUID or DM chat ID
- `msg.isFromMe` — boolean (skip bot's own messages)
- `sdk.send(target, text)` — auto-detects phone (DM) vs chatId (group)

---

## App 2: MPP Service (Future)

A custom MPP-enabled HTTP service that the iMessage bot can consume. Not designed yet — placeholder in the monorepo at `apps/mpp-service/`.

The idea: instead of (or in addition to) proxying through `openai.mpp.tempo.xyz`, we build our own service that accepts MPP payments and provides some custom functionality. This could be anything — a specialized AI agent, a data service, a tool.

Will be designed and implemented separately after the bot is working.

---

## Open Questions

1. **`createViemAccount` import path** — Documented as `@privy-io/node/viem`. May not resolve; check after install.
2. **`tempoActions()` source** — May be `viem/tempo` or a separate `@tempo-xyz/viem` package. Verify after install.
3. **`tempoModerato` chain** — May need a custom chain definition if not in `viem/chains`.
4. **`PrivyClient` constructor** — Some SDK versions use positional args `new PrivyClient(appId, appSecret)` not `{ appId, appSecret }`. Verify after install.
5. **mppx import paths** — `Mppx` and `tempo` may come from `mppx/client` or `mppx`. Check after install.
6. **Gas sponsorship config** — Requires enabling in Privy Dashboard for Tempo chain. CAIP-2: `eip155:42431` (testnet), `eip155:4217` (mainnet).
7. **MPP service response format** — Default OpenAI handler assumes `choices[0].message.content`. Fallback handles unknown formats with `JSON.stringify(data).slice(0, 500)`.

---

## What's NOT in Scope

- Group expense splitting (v2)
- Multi-chain support (Tempo only)
- Web UI or mobile app
- User authentication beyond phone number
- Rate limiting or abuse prevention
- Production deployment (this runs on a Mac)
