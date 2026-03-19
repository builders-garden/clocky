# Architecture Decisions — iMessage Pay Agent

## Decision Log

### 1. Wallet Infrastructure: ZeroDev (not Privy/Turnkey)

**Decision:** Use ZeroDev Kernel smart accounts on Tempo for phone-to-wallet mapping.

**Why:**
- ZeroDev is listed as a supported smart wallet provider on Tempo (supports both ERC-4337 and EIP-7702)
- Pimlico provides ERC-4337 bundlers and paymasters on Tempo for gas sponsorship
- No custody of private keys — the agent never holds user keys
- Audited smart wallet (Kernel is battle-tested)
- CREATE2 gives deterministic counterfactual addresses — we can compute a wallet address from a phone number hash and send funds to it before the wallet contract is even deployed
- No dependency on Privy or Turnkey for wallet management

**Alternatives considered:**
- **Privy server wallets:** Fast to ship, but custodial (Privy holds keys). Good for hackathon but not ideal long-term.
- **Turnkey embedded wallets:** Similar trade-off to Privy. Tempo's own wallet uses native passkeys, NOT Turnkey (Turnkey is just one of ~60 ecosystem partners).
- **Deterministic EOA derivation (hash-based):** Simple but dangerous — MASTER_SECRET is a single point of failure. All wallets compromised if leaked.
- **Random EOA keys + DB:** Same custody problem. DB breach = all funds lost.

### 2. No Proactive iMessages to Recipients

**Decision:** The agent does NOT send unsolicited iMessages to recipients when they receive funds.

**Why:**
- All interaction should go through the agent — users text the agent to check balance, send money, etc.
- Sending unsolicited messages could be seen as spam
- The sender can tell the recipient out-of-band ("I sent you $5, text the bot to claim it")
- Simpler implementation

**Flow:**
1. Sender texts agent: "send $5 to +15551234567"
2. Agent creates counterfactual wallet for recipient (if new), executes transfer on Tempo
3. Agent replies to sender with confirmation
4. Recipient discovers funds when they text the agent themselves

### 3. Tempo Chain + Stablecoins

**Key details:**
- **Mainnet chain ID:** 4217 (CAIP-2: `eip155:4217`)
- **Testnet (Moderato) chain ID:** 42431 (CAIP-2: `eip155:42431`)
- **PathUSD token:** `0x20c0000000000000000000000000000000000000`
- **AlphaUSD token:** `0x20c0000000000000000000000000000000000001`
- Gas is paid in stablecoins (no native ETH-like token needed)
- Sub-second finality
- EVM-compatible with extensions (EIP-7702, P256/WebAuthn signatures)

**Pre-deployed infrastructure on Tempo:**
- CreateX (deterministic CREATE2/CREATE3): `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`
- Arachnid CREATE2 Factory: `0x4e59b44847b379578588920cA78FbF26c0B4956C`
- Safe Deployer: `0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7`
- Multicall3: `0xcA11bde05977b3631167028862bE2a173976CA11`
- Permit2: `0x000000000022d473030f116ddee9f6b43ac78ba3`

### 4. User Funding

Users can fund their wallet via:
- **Fiat on-ramp:** Tempo wallet "Add funds" button, or Bridge (Stripe's stablecoin platform) API
- **Cross-chain bridges:** Stargate (LayerZero), Across, Relay, Squid, Bungee
- **Testnet faucet:** https://docs.tempo.xyz/quickstart/faucet (provides pathUSD, alphaUSD, betaUSD, thetaUSD)
- **CLI:** `tempo wallet fund`

### 5. Tech Stack

| Component | Choice | Why |
|-----------|--------|-----|
| Runtime | Bun | Required by iMessage Kit (macOS, Full Disk Access) |
| iMessage | `@photon-ai/imessage-kit` | Only viable iMessage SDK for bots on macOS |
| Smart wallets | ZeroDev Kernel | Audited, supports Tempo, CREATE2 counterfactual addresses |
| Bundler/Paymaster | Pimlico | ERC-4337 infrastructure on Tempo, gas sponsorship |
| Transfers | viem + tempoActions | Official Tempo SDK integration |
| MPP client | mppx | Official MPP library, handles full 402 payment flow |
| Database | bun:sqlite | Zero dependencies, fast, good enough for hackathon |

---

## Key Resources

- **Tempo docs:** https://docs.tempo.xyz
- **Tempo wallet:** https://wallet.tempo.xyz
- **ZeroDev dashboard:** https://dashboard.zerodev.app
- **ZeroDev SDK quickstart:** https://docs.zerodev.app/sdk/getting-started
- **Pimlico docs:** https://docs.pimlico.io
- **MPP overview:** https://mpp.dev/overview
- **MPP services directory:** https://mpp.dev/services
- **iMessage Kit:** https://github.com/photon-hq/imessage-kit
- **mppx npm:** https://www.npmjs.com/package/mppx
- **Bridge (Stripe stablecoins):** https://apidocs.bridge.xyz
- **Tempo faucet:** https://docs.tempo.xyz/quickstart/faucet
