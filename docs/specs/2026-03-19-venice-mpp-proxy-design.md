# Venice AI MPP Proxy — Design Spec

## Overview

A payment-gated proxy service that exposes Venice AI's inference APIs (chat, images, audio, embeddings) behind the Machine Payments Protocol (MPP). Clients pay in PathUSD stablecoins on Tempo — per-token via sessions for chat streaming, per-request via charges for image/audio/embeddings.

The service lives in the monorepo at `apps/mpp-service/` and runs as a Bun HTTP server using `mppx/proxy`'s built-in `openai` preset with a `baseUrl` override pointing to Venice's OpenAI-compatible API.

---

## Monorepo Placement

```
mpp-hack/
├── docs/
│   ├── specs/
│   │   ├── 2026-03-19-mpp-hack-design.md          # Original hack design
│   │   └── 2026-03-19-venice-mpp-proxy-design.md  # This file
│   └── plans/
│       ├── 2026-03-19-imessage-p2p-payments.md
│       └── 2026-03-19-venice-mpp-proxy.md          # Implementation plan
├── apps/
│   ├── imessage-bot/                               # iMessage bot (existing)
│   └── mpp-service/                                # Venice MPP proxy (this service)
│       ├── src/
│       │   └── index.ts                            # Single entry point (~45 LOC)
│       ├── package.json
│       ├── tsconfig.json
│       └── .env.example
└── package.json                                    # Root — Bun workspaces
```

---

## Architecture

```
                      ┌───────────────────────────────┐
                      │   MPP Client / Agent           │
                      │   (mppx CLI, tempo wallet,     │
                      │    imessage-bot ask command)   │
                      └──────────────┬────────────────┘
                                     │ HTTP request
                                     ▼
                      ┌───────────────────────────────┐
                      │  Bun.serve — port 3001        │
                      │                               │
                      │  mppx Proxy (mppx/proxy)      │
                      │                               │
                      │  Paid routes:                 │
                      │  POST /venice/v1/chat/...  ──► stream (session-based)
                      │  POST /venice/v1/images/.. ──► charge (one-time)
                      │  POST /venice/v1/audio/...  ──► charge (one-time)
                      │  POST /venice/v1/embeddings ──► charge (one-time)
                      │                               │
                      │  Free routes:                 │
                      │  GET  /venice/v1/models     ──► passthrough
                      │                               │
                      │  Discovery (auto-generated):  │
                      │  GET  /discover               │
                      │  GET  /llms.txt               │
                      └──────────────┬────────────────┘
                                     │ Proxied request
                                     │ + Authorization: Bearer <VENICE_API_KEY>
                                     ▼
                      ┌───────────────────────────────┐
                      │  Venice AI API                │
                      │  https://api.venice.ai/api    │
                      └───────────────────────────────┘
```

**Payment flow for a paid route:**
1. Client sends request → proxy returns `402 Payment Required` with `WWW-Authenticate: Payment` challenge
2. Client pays via Tempo:
   - **Chat completions:** client opens a session channel (escrow deposit), then sends off-chain vouchers per token — no on-chain tx after the first
   - **Images/audio/embeddings:** client submits a one-time signed on-chain transaction
3. Proxy verifies payment (voucher signature check for sessions, on-chain confirmation for charges)
4. Proxy injects `Authorization: Bearer <VENICE_API_KEY>` and forwards to Venice
5. Proxy attaches `Payment-Receipt` header to the Venice response and returns it to the client

---

## Route Map & Pricing

| Client Route | Venice Upstream | Intent | Amount | Notes |
|---|---|---|---|---|
| `POST /venice/v1/chat/completions` | `POST /v1/chat/completions` | `mppx.stream()` | `$0.0001/token` | Session-based, per-token. Streaming SSE passthrough. |
| `POST /venice/v1/images/generations` | `POST /v1/images/generations` | `mppx.charge()` | `$0.05` | One-time charge per generation request. |
| `POST /venice/v1/audio/speech` | `POST /v1/audio/speech` | `mppx.charge()` | `$0.02` | One-time charge per TTS request. |
| `POST /venice/v1/embeddings` | `POST /v1/embeddings` | `mppx.charge()` | `$0.005` | One-time charge, embeddings are low-cost. |
| `GET /venice/v1/models` | `GET /v1/models` | `true` (free) | — | Discovery; no reason to gate model listing. |

**Routing:** `mppx/proxy` mounts the `openai` service at `/venice/` (derived from the service ID passed to `Service.from` or the first arg of `openai()`). Client paths are prefixed `/venice/`; the proxy strips the prefix before forwarding to Venice.

**Pricing rationale:** These are hackathon defaults. They are trivially adjustable via the config object in `index.ts`. Venice-specific parameters (`venice_parameters`, model suffixes like `:enable_web_search=auto`) pass through transparently since the proxy forwards request bodies and query strings as-is.

---

## Technology Choices

| Component | Choice | Why |
|---|---|---|
| Runtime | Bun | Matches monorepo; `Bun.serve(proxy)` works directly with `mppx/proxy` |
| MPP layer | `mppx/proxy` — `openai` preset | Venice is OpenAI-compatible; zero custom routing code needed |
| Payment method | Tempo on-chain (via `mppx/server` `tempo()`) | Matches the rest of the hack; PathUSD stablecoin |
| Streaming pricing | `mppx.stream()` | Purpose-built for per-token SSE billing via sessions |
| Flat pricing | `mppx.charge()` | One-time on-chain tx per request for image/audio/embeddings |
| Discovery | Auto-generated by `Proxy.create()` | `/discover`, `/llms.txt`, `/discover/venice.md` for free |
| Framework | None (plain Bun) | `Proxy.create()` returns a `{ fetch }` handler; `Bun.serve` consumes it directly |

---

## Configuration & Environment

```env
# apps/mpp-service/.env.example

# Venice AI API key — Bearer token injected into upstream requests
VENICE_API_KEY=

# Recipient wallet address — where MPP payments are sent
# This is YOUR wallet address on Tempo
RECIPIENT_ADDRESS=0x...

# Tempo PathUSD token contract address (testnet)
# Default: 0x20c0000000000000000000000000000000000000
# Override only if using mainnet or a different token
PAYMENT_CURRENCY=0x20c0000000000000000000000000000000000000

# Port to listen on (default: 3001, avoids conflict with imessage-bot)
PORT=3001
```

**Tempo chain:** Moderato testnet (`eip155:42431`) for the hackathon. Switching to mainnet requires changing `currency` to the mainnet PathUSD address.

---

## Implementation Shape

```typescript
// apps/mpp-service/src/index.ts — full implementation, ~45 LOC

import { Proxy, openai } from 'mppx/proxy'
import { Mppx, tempo } from 'mppx/server'

const PATHUSD = (process.env.PAYMENT_CURRENCY ??
  '0x20c0000000000000000000000000000000000000') as `0x${string}`

const recipient = process.env.RECIPIENT_ADDRESS as `0x${string}`
if (!recipient) throw new Error('Missing required env var: RECIPIENT_ADDRESS')

const veniceApiKey = process.env.VENICE_API_KEY
if (!veniceApiKey) throw new Error('Missing required env var: VENICE_API_KEY')

const mppx = Mppx.create({
  methods: [tempo({ currency: PATHUSD, recipient })],
})

const proxy = Proxy.create({
  title: 'Venice AI',
  description: 'MPP-gated proxy for Venice AI inference APIs. Pay per token for chat, per request for images/audio/embeddings.',
  services: [
    openai({
      apiKey: veniceApiKey,
      baseUrl: 'https://api.venice.ai/api',
      routes: {
        'POST /v1/chat/completions':   mppx.stream({ amount: '0.0001' }),
        'POST /v1/images/generations': mppx.charge({ amount: '0.05' }),
        'POST /v1/audio/speech':       mppx.charge({ amount: '0.02' }),
        'POST /v1/embeddings':         mppx.charge({ amount: '0.005' }),
        'GET /v1/models':              true,
      },
    }),
  ],
})

const port = Number(process.env.PORT ?? 3001)
Bun.serve({ port, fetch: proxy.fetch })
console.log(`Venice MPP proxy running on http://localhost:${port}`)
console.log(`Discovery: http://localhost:${port}/discover`)
```

---

## Error Handling

The proxy handles errors at two levels, requiring no custom code:

**MPP layer:**
- Invalid or expired credentials → `401 Unauthorized`
- Insufficient payment → `402 Payment Required` (re-challenges client)
- Malformed credential → `400 Bad Request` with RFC 9457 problem details

**Venice layer:**
- API key invalid → `401` from Venice, proxied through
- Rate limited → `429` from Venice, proxied through
- Model not found → `404` from Venice, proxied through
- Venice down → connection error, propagated as `502`

No custom error middleware is needed. Both `mppx` and Venice produce well-formed HTTP error responses.

---

## Testing

**1. Start the service:**
```bash
bun run --cwd apps/mpp-service dev
```

**2. Verify free route (models listing):**
```bash
curl http://localhost:3001/venice/v1/models
# Expected: Venice models JSON, no payment required
```

**3. Verify 402 on paid route:**
```bash
curl -i http://localhost:3001/venice/v1/chat/completions \
  -X POST -H "Content-Type: application/json" \
  -d '{"model":"venice-uncensored","messages":[{"role":"user","content":"hi"}]}'
# Expected: HTTP/1.1 402 Payment Required
#           WWW-Authenticate: Payment ...
```

**4. Verify discovery endpoint:**
```bash
curl http://localhost:3001/discover
curl http://localhost:3001/llms.txt
# Expected: JSON / plain-text service catalog with routes and pricing
```

**5. Make a paid request with mppx CLI:**
```bash
npx mppx account create   # creates testnet wallet, auto-funded
npx mppx http://localhost:3001/venice/v1/chat/completions \
  -X POST -H "Content-Type: application/json" \
  -d '{"model":"venice-uncensored","messages":[{"role":"user","content":"hello"}]}'
# Expected: Venice AI response body + Payment-Receipt header
```

**6. Test from imessage-bot:**

Update `MPP_SERVICE_URL` in `apps/imessage-bot/.env` to point to the local Venice proxy, swap `MPP_MODEL` to `venice-uncensored`, and use the bot's `ask` command. Payments should flow from the user's iMessage wallet through the Venice proxy to Venice AI.

---

## Integration with iMessage Bot

The `ask` command in `apps/imessage-bot/src/commands/ask.ts` is already service-agnostic — it reads the target URL from `config.mpp.serviceUrl`. To point the bot at the Venice proxy instead of the OpenAI MPP proxy:

```env
# apps/imessage-bot/.env
MPP_SERVICE_URL=http://localhost:3001/venice/v1/chat/completions
MPP_MODEL=venice-uncensored
```

No code changes needed. The Venice proxy speaks OpenAI chat completions format identically.

---

## What's NOT in Scope

- Authentication of callers beyond MPP payment verification (no API keys, no accounts)
- Request/response caching
- Rate limiting per client
- Logging or analytics beyond stdout
- Image upscaling, editing, or Venice-specific character APIs (these can be added as additional routes)
- Production deployment (runs locally for the hackathon)
- Mainnet configuration (testnet only for hackathon)
