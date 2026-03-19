# clocky

Pay friends and talk to AI — all over iMessage, powered by [Tempo](https://tempo.xyz) and [MPP](https://mpp.dev).

Two apps in a Bun monorepo:

- **`mpp-service`** — An HTTP proxy that wraps [Venice AI](https://venice.ai) behind MPP. Clients pay in USDC on Tempo to access chat completions, image generation, audio, and embeddings.
- **`imessage-bot`** — An iMessage bot with built-in wallets. Users text commands to send money, check balances, and query AI — all paid through MPP.

## How it works

```
iMessage user
    │
    │  "ask what is dark matter"
    ▼
┌──────────────┐    MPP (USDC on Tempo)    ┌──────────────┐    Bearer auth    ┌──────────────┐
│ imessage-bot │ ──────────────────────────▶│ mpp-service  │ ────────────────▶│  Venice AI   │
│              │◀────────────────────────── │   (proxy)    │◀──────────────── │   API        │
└──────────────┘    AI response             └──────────────┘    inference      └──────────────┘
```

1. User sends a message to the bot over iMessage
2. Bot creates a [Privy](https://privy.io) embedded wallet for the user (first message only)
3. For `ask` commands, the bot calls the MPP proxy with the user's wallet
4. Proxy returns `402 Payment Required` — [mppx](https://github.com/wevm/mppx) handles the payment flow automatically (EIP-712 signed USDC payment on Tempo)
5. Proxy forwards the request to Venice AI and streams the response back

## Prerequisites

- [Bun](https://bun.sh) v1.1+
- A [Venice AI](https://venice.ai) API key with credits ([generate one here](https://venice.ai/settings/api))
- A [Privy](https://privy.io) app (for the iMessage bot's embedded wallets)
- A funded [Tempo](https://tempo.xyz) wallet (the proxy operator's recipient address)

## Setup

```bash
# Install dependencies
bun install
```

### MPP Service (Venice proxy)

```bash
cd apps/mpp-service
cp .env.example .env
# Edit .env with your values:
#   VENICE_API_KEY     — your Venice AI API key
#   RECIPIENT_ADDRESS  — your Tempo wallet (receives payments)
#   MPP_SECRET_KEY     — run: openssl rand -hex 32
#   PAYMENT_CURRENCY   — USDC on mainnet (default) or PathUSD on testnet

bun dev
# => Venice MPP proxy running on http://localhost:3001
# => Paid routes at /venice/v1/...
# => Discovery at http://localhost:3001/discover
```

### iMessage Bot

```bash
cd apps/imessage-bot
cp .env.example .env
# Edit .env with your values:
#   PRIVY_APP_ID / PRIVY_APP_SECRET
#   MPP_SERVICE_URL  — http://localhost:3001/venice/v1/chat/completions
#   MPP_MODEL        — e.g. deepseek-r1-671b, venice-uncensored, llama-3.3-70b
#   BOT_PHONE        — the phone number the bot listens on

bun dev
```

## MPP Service routes

| Route | Pricing | Description |
|---|---|---|
| `POST /venice/v1/chat/completions` | `$0.0001/token` (session) | Streaming chat with any Venice text model |
| `POST /venice/v1/images/generations` | `$0.05` (charge) | Image generation |
| `POST /venice/v1/audio/speech` | `$0.02` (charge) | Text-to-speech |
| `POST /venice/v1/embeddings` | `$0.005` (charge) | Vector embeddings |
| `GET /venice/v1/models` | free | List available models |

Discovery endpoints are auto-generated:

- `GET /discover` — JSON catalog (or markdown for `curl`)
- `GET /llms.txt` — plain-text catalog for LLM agents
- `GET /discover/venice.md` — route documentation

## iMessage Bot commands

| Command | Example | Description |
|---|---|---|
| `ask <prompt>` | `ask what is dark matter` | Query AI via MPP (costs USDC) |
| `send <amount> to <phone>` | `send $5 to +1234567890` | Transfer PathUSD to another user |
| `balance` | `balance` | Check your wallet balance |
| `deposit` | `deposit` | Get your wallet address for deposits |
| `history` | `history` | View recent transactions |
| `help` | `help` | List commands |

## Testing with the Tempo CLI

You can test the proxy directly without the iMessage bot using the [`tempo` CLI](https://tempo.xyz):

```bash
# Make a paid request to the proxy
tempo request http://localhost:3001/venice/v1/chat/completions \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"model": "deepseek-r1-671b", "messages": [{"role": "user", "content": "hello"}]}'
```

The CLI handles the full 402 payment flow automatically.

## Architecture

```
mpp-hack/
├── apps/
│   ├── mpp-service/          # Venice AI MPP proxy (86 LOC)
│   │   └── src/index.ts      # Single-file server using mppx/proxy
│   └── imessage-bot/         # iMessage bot with wallets
│       └── src/
│           ├── index.ts       # Entry point, iMessage watcher
│           ├── bot.ts         # Message router
│           ├── config.ts      # Environment config
│           ├── commands/      # ask, send, balance, deposit, history, help
│           ├── db/            # SQLite — users, transactions
│           ├── mpp/           # MPP client (wraps mppx)
│           └── wallet/        # Privy wallets, PathUSD transfers
├── docs/
│   ├── specs/                 # Design specifications
│   └── plans/                 # Implementation plans
└── package.json               # Bun workspaces
```

## Key dependencies

- [mppx](https://github.com/wevm/mppx) — TypeScript SDK for the Machine Payments Protocol
- [viem](https://viem.sh) — TypeScript interface for Ethereum
- [@privy-io/node](https://privy.io) — Embedded wallets for the iMessage bot
- [@photon-ai/imessage-kit](https://github.com/nicephoton/imessage-kit) — iMessage read/write on macOS

## Payment flow

The proxy operator and Venice AI have **separate billing**:

- **Clients pay the proxy operator** in USDC on Tempo via MPP
- **The proxy operator pays Venice** using their Venice API key credits (USD, crypto, or [DIEM staking](https://venice.ai/token))

The operator profits from the spread between MPP prices and Venice's per-token costs.

## Networks

| Network | Chain ID | Currency | Token Address |
|---|---|---|---|
| Tempo mainnet | 4217 | USDC | `0x20C000000000000000000000b9537d11c60E8b50` |
| Tempo testnet | 42431 | PathUSD | `0x20c0000000000000000000000000000000000000` |

## License

MIT
