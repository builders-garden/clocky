# Venice AI MPP Proxy — Implementation Plan

> **Design spec:** See `docs/specs/2026-03-19-venice-mpp-proxy-design.md` for architecture, design decisions, and rationale.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MPP-gated HTTP proxy that exposes Venice AI's inference APIs (chat, images, audio, embeddings) behind the Machine Payments Protocol — clients pay in PathUSD stablecoins on Tempo, with per-token session billing for chat and one-time charges for images/audio/embeddings.

**Architecture:** A single `src/index.ts` (~45 LOC) uses `mppx/proxy`'s built-in `openai` preset with a `baseUrl` override pointing at Venice's OpenAI-compatible API (`https://api.venice.ai/api`). `Mppx.create()` configures the Tempo payment method; `Proxy.create()` wires the route map and generates discovery endpoints automatically. `Bun.serve({ fetch: proxy.fetch })` starts the server.

**Tech Stack:**
- Bun (runtime + HTTP server)
- TypeScript (strict, bundler module resolution, bun-types)
- `mppx` ^0.4.7 — `mppx/proxy` (server-side proxy + payment gating) + `mppx/server` (Tempo payment method)
- Venice AI API — OpenAI-compatible at `https://api.venice.ai/api`

**Active worktree:** All files go in `.worktrees/build/` (the `feature/build` git worktree). Run all commands from that directory.

---

## File Structure

```
.worktrees/build/
├── apps/
│   ├── imessage-bot/                   # Existing — do not modify
│   └── mpp-service/                    # New — this plan creates it
│       ├── src/
│       │   └── index.ts                # ONLY source file — entire service
│       ├── package.json                # Bun app manifest + dependencies
│       ├── tsconfig.json               # TypeScript config (mirrors imessage-bot)
│       └── .env.example                # Environment variable template
└── docs/
    └── plans/
        └── 2026-03-19-venice-mpp-proxy.md   # This file
```

**Responsibility boundaries:**
- `src/index.ts` owns everything: env validation, mppx server setup, proxy config, Bun.serve startup. No other source files needed.
- `package.json` declares dependencies. `mppx` is the only runtime dependency (`viem` is a peer dep of mppx, already in the workspace root).
- `tsconfig.json` is identical to `apps/imessage-bot/tsconfig.json` — no divergence.
- `.env.example` documents the three required env vars (`VENICE_API_KEY`, `RECIPIENT_ADDRESS`) and one optional one (`PORT`).

---

## Prerequisites (Manual, Before Task 1)

Before starting, you need:

1. **Venice AI API key:**
   - Sign up at https://venice.ai → Dashboard → API Keys → Create key
   - Note the key value for `VENICE_API_KEY`

2. **Recipient wallet address:**
   - This is the Tempo address that receives MPP payments (your wallet)
   - Get a testnet address + fund it: https://docs.tempo.xyz/quickstart/faucet
   - Note the address for `RECIPIENT_ADDRESS`

3. **Verify worktree is active:**
   ```bash
   git -C .worktrees/build branch --show-current
   # Expected: feature/build
   ```

---

## Task 1: Scaffold `apps/mpp-service/`

**Files:**
- Create: `.worktrees/build/apps/mpp-service/package.json`
- Create: `.worktrees/build/apps/mpp-service/tsconfig.json`
- Create: `.worktrees/build/apps/mpp-service/.env.example`

- [ ] **Step 1: Create the app directory**

```bash
mkdir -p .worktrees/build/apps/mpp-service/src
```

- [ ] **Step 2: Write apps/mpp-service/package.json**

```json
{
  "name": "mpp-service",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "bun run src/index.ts",
    "dev": "bun --watch src/index.ts"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "bun-types": "^1.3.11"
  },
  "peerDependencies": {
    "typescript": "^5"
  },
  "dependencies": {
    "mppx": "^0.4.7"
  }
}
```

- [ ] **Step 3: Write apps/mpp-service/tsconfig.json**

Mirrors `apps/imessage-bot/tsconfig.json` exactly:

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

- [ ] **Step 4: Write apps/mpp-service/.env.example**

```env
# Venice AI API key — injected as Bearer token into upstream requests
VENICE_API_KEY=

# Your Tempo wallet address — receives MPP payments from clients
RECIPIENT_ADDRESS=0x...

# PathUSD token contract address on Tempo (testnet default shown)
# Only override if using mainnet or a different token
PAYMENT_CURRENCY=0x20c0000000000000000000000000000000000000

# Port to listen on (default: 3001 — avoids conflict with other local services)
PORT=3001
```

- [ ] **Step 5: Install dependencies**

```bash
bun install --cwd .worktrees/build/apps/mpp-service
```

Expected: `mppx` and dev deps installed. The workspace root `bun.lock` is updated.

- [ ] **Step 6: Commit scaffold**

```bash
cd .worktrees/build
git add apps/mpp-service/package.json apps/mpp-service/tsconfig.json apps/mpp-service/.env.example
git commit -m "feat: scaffold mpp-service app for Venice AI proxy"
```

---

## Task 2: Write `src/index.ts` — The Full Service

**Files:**
- Create: `.worktrees/build/apps/mpp-service/src/index.ts`

This is the entire service. No other source files.

- [ ] **Step 1: Write apps/mpp-service/src/index.ts**

```typescript
// src/index.ts
// Venice AI MPP Proxy — full service implementation
//
// Exposes Venice AI's OpenAI-compatible API behind the Machine Payments Protocol.
// Clients pay in PathUSD on Tempo:
//   - Chat completions: per-token via MPP sessions (off-chain EIP-712 vouchers)
//   - Images / audio / embeddings: one-time on-chain charge per request
//
// Discovery endpoints (auto-generated by mppx/proxy):
//   GET /discover            → JSON service catalog
//   GET /llms.txt            → plain-text catalog for LLM agents
//   GET /discover/venice.md  → Markdown route docs

import { Proxy, openai } from 'mppx/proxy'
import { Mppx, tempo } from 'mppx/server'

// --- Environment validation ---

const PATHUSD = (process.env.PAYMENT_CURRENCY ??
  '0x20c0000000000000000000000000000000000000') as `0x${string}`

const recipient = process.env.RECIPIENT_ADDRESS as `0x${string}`
if (!recipient) throw new Error('Missing required env var: RECIPIENT_ADDRESS')

const veniceApiKey = process.env.VENICE_API_KEY
if (!veniceApiKey) throw new Error('Missing required env var: VENICE_API_KEY')

const port = Number(process.env.PORT ?? 3001)

// --- Payment method ---

const mppx = Mppx.create({
  methods: [tempo({ currency: PATHUSD, recipient })],
})

// --- Proxy config ---

const proxy = Proxy.create({
  title: 'Venice AI',
  description:
    'MPP-gated proxy for Venice AI inference APIs. Pay per token for chat ' +
    'completions via sessions; flat fee for images, audio, and embeddings.',
  services: [
    openai({
      apiKey: veniceApiKey,
      baseUrl: 'https://api.venice.ai/api',
      routes: {
        // Session-based per-token billing — ideal for streaming chat
        'POST /v1/chat/completions':   mppx.stream({ amount: '0.0001' }),
        // Flat charge per request — images are expensive and non-streaming
        'POST /v1/images/generations': mppx.charge({ amount: '0.05' }),
        // Flat charge per TTS request
        'POST /v1/audio/speech':       mppx.charge({ amount: '0.02' }),
        // Flat charge per embedding batch — embeddings are cheap
        'POST /v1/embeddings':         mppx.charge({ amount: '0.005' }),
        // Free passthrough — no reason to gate model listing
        'GET /v1/models':              true,
      },
    }),
  ],
})

// --- Start server ---

Bun.serve({ port, fetch: proxy.fetch })

console.log(`Venice MPP proxy running on http://localhost:${port}`)
console.log(`Paid routes mounted at: /venice/v1/...`)
console.log(`Discovery: http://localhost:${port}/discover`)
console.log(`LLM agents: http://localhost:${port}/llms.txt`)
```

- [ ] **Step 2: Verify it type-checks**

```bash
bun build .worktrees/build/apps/mpp-service/src/index.ts --outdir /tmp/mpp-service-build 2>&1
```

Expected: Build succeeds with no errors. (Runtime errors from missing env vars are expected — that's intentional.)

- [ ] **Step 3: Commit**

```bash
cd .worktrees/build
git add apps/mpp-service/src/index.ts
git commit -m "feat: Venice AI MPP proxy service — full implementation"
```

---

## Task 3: Smoke Test

**Files:** No new files — run the service and verify key behaviors with `curl`.

- [ ] **Step 1: Create `.env` from example**

```bash
cp .worktrees/build/apps/mpp-service/.env.example .worktrees/build/apps/mpp-service/.env
```

Fill in `VENICE_API_KEY` and `RECIPIENT_ADDRESS`. Leave `PAYMENT_CURRENCY` and `PORT` at defaults.

- [ ] **Step 2: Start the service**

```bash
bun run --cwd .worktrees/build/apps/mpp-service dev
```

Expected output:
```
Venice MPP proxy running on http://localhost:3001
Paid routes mounted at: /venice/v1/...
Discovery: http://localhost:3001/discover
LLM agents: http://localhost:3001/llms.txt
```

Keep this running in a separate terminal for the next steps.

- [ ] **Step 3: Verify free route — model listing**

```bash
curl -s http://localhost:3001/venice/v1/models | head -c 200
```

Expected: Venice models JSON (no payment required, no `402`). You should see a list with `"object": "list"` and model IDs including `venice-uncensored`.

- [ ] **Step 4: Verify 402 on paid route**

```bash
curl -i http://localhost:3001/venice/v1/chat/completions \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"model":"venice-uncensored","messages":[{"role":"user","content":"hi"}]}'
```

Expected:
```
HTTP/1.1 402 Payment Required
WWW-Authenticate: Payment ...
```

The body should contain a payment challenge. This confirms mppx is gating the route correctly.

- [ ] **Step 5: Verify discovery endpoint**

```bash
curl -s http://localhost:3001/discover | head -c 500
```

Expected: JSON catalog listing the `venice` service with routes and pricing amounts.

```bash
curl -s http://localhost:3001/llms.txt | head -c 500
```

Expected: Plain-text catalog for LLM agents.

- [ ] **Step 6: Fix any issues found**

Common issues to look for:
- **`openai` preset import path** — if `from 'mppx/proxy'` fails, check mppx package exports. May be `from 'mppx/proxy/openai'` or similar.
- **`Mppx` vs `MppxServer`** — the server-side API may export under a different name. Check `mppx/server` exports.
- **`mppx.stream()` vs `mppx.intent.stream()`** — the intent API shape depends on mppx version. Check types.
- **Route prefix** — if routes appear at `/v1/...` instead of `/venice/v1/...`, the service ID argument to `openai()` may need to be set explicitly (e.g., `openai('venice', { ... })`).

After any fix, re-run steps 3-5.

- [ ] **Step 7: Commit fixes (if any)**

```bash
cd .worktrees/build
git add apps/mpp-service/src/index.ts
git commit -m "fix: mppx API shape adjustments from smoke testing"
```

---

## Task 4: Paid Request via mppx CLI

**Files:** No new files — test a full end-to-end paid request.

This task verifies the complete payment flow: client sends request → 402 → client pays via Tempo → proxy forwards to Venice → response returned.

- [ ] **Step 1: Create an mppx CLI test wallet**

```bash
npx mppx account create
```

Expected: Creates a testnet wallet and auto-funds it with PathUSD. Note the wallet address shown.

- [ ] **Step 2: Make a paid chat completions request**

```bash
npx mppx http://localhost:3001/venice/v1/chat/completions \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"model":"venice-uncensored","messages":[{"role":"user","content":"hello, say hi back in one word"}]}'
```

Expected:
- mppx handles the `402` automatically
- Opens a session channel (one on-chain tx)
- Sends off-chain voucher
- Returns Venice AI response JSON with `choices[0].message.content`
- `Payment-Receipt` header visible in verbose output

- [ ] **Step 3: Make a paid image generation request**

```bash
npx mppx http://localhost:3001/venice/v1/images/generations \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"model":"venice-sd-3.5","prompt":"a cat","n":1,"size":"256x256"}'
```

Expected: Venice image generation response with base64 or URL. One-time `$0.05` charge applied.

- [ ] **Step 4: Verify recipient received payment**

Check that the `RECIPIENT_ADDRESS` wallet received PathUSD on Tempo testnet:

```bash
# Replace 0x... with your RECIPIENT_ADDRESS
curl -s "https://explore.tempo.xyz/api?module=account&action=tokenbalance&contractaddress=0x20c0000000000000000000000000000000000000&address=0x..." | head -c 200
```

Or check via the Tempo explorer UI at https://explore.tempo.xyz.

- [ ] **Step 5: Commit any final fixes**

```bash
cd .worktrees/build
git add -A
git commit -m "test: end-to-end paid request verification complete"
```

---

## Task 5: Point iMessage Bot at Venice Proxy

**Files:**
- Modify: `.worktrees/build/apps/imessage-bot/.env` (env vars only — no code changes)

This task wires the existing `ask` command to use the Venice proxy instead of the default OpenAI MPP proxy.

- [ ] **Step 1: Update imessage-bot `.env`**

In `.worktrees/build/apps/imessage-bot/.env`, set:

```env
MPP_SERVICE_URL=http://localhost:3001/venice/v1/chat/completions
MPP_MODEL=venice-uncensored
```

No code changes needed — `ask.ts` is already service-agnostic and reads both from `config.mpp`.

- [ ] **Step 2: Start both services**

Terminal 1:
```bash
bun run --cwd .worktrees/build/apps/mpp-service dev
```

Terminal 2:
```bash
bun run --cwd .worktrees/build/apps/imessage-bot dev
```

- [ ] **Step 3: Test the `ask` command via iMessage**

Send from your phone: `ask what is 2 + 2`

Expected:
- Bot responds with Venice AI's answer
- `mpp-service` terminal shows an inbound request and payment verification log
- Balance decreases by `$0.0001` × token count on the sender's Privy wallet

- [ ] **Step 4: Done — no commit needed (`.env` is gitignored)**

---

## Open Questions for Implementation

1. **`mppx/proxy` export shape** — The `openai` preset and `Proxy` class are documented in the design spec. If imports fail, check the mppx package's `exports` field in `node_modules/mppx/package.json` to find the actual subpath.

2. **`mppx/server` vs `mppx/proxy`** — `Mppx.create()` and `tempo()` are documented as coming from `mppx/server`. If that subpath doesn't exist, they may be on `mppx` directly. Check mppx exports.

3. **`mppx.stream()` intent shape** — The design spec uses `mppx.stream({ amount: '0.0001' })`. The actual method may be `mppx.intent.stream(...)` or similar. Check mppx types after install.

4. **Service ID / route prefix** — `openai()` may derive the service ID (`venice`) from a first string argument or from `title`. If routes appear at `/v1/...` instead of `/venice/v1/...`, pass the service ID explicitly: `openai('venice', { apiKey, baseUrl, routes })`.

5. **`Proxy.create()` return shape** — The design spec uses `proxy.fetch`. If the return is `{ fetch, listener }` or similar, use the appropriate property for `Bun.serve`.

6. **Venice model names** — `venice-uncensored` is used in tests. The free `/venice/v1/models` endpoint lists all available Venice models. Use whichever model is available in your Venice account.
