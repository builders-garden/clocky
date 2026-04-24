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
import { getBalance, transferUSDC, parseAmount } from "./wallet/transfer";
import { mppFetch } from "./mpp/client";
import { config } from "./config";

/** Amount of USDC to seed new users with from the treasury */
const SEED_AMOUNT = "1"; // $1 USDC

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
 *
 * TOCTOU safety: wallet creation is inside the try block so that if two
 * concurrent messages race, only the winner's wallet is saved. The loser
 * never calls createUserWallet() — it reads the row the winner inserted.
 * This prevents orphaned Privy wallets on concurrent first-message bursts.
 */
async function getOrCreateUser(db: Database, phone: string): Promise<User> {
  const existing = getUser(db, phone);
  if (existing) return existing;

  // Re-check inside try: concurrent request may have inserted between read and here
  try {
    console.log(`Creating wallet for new user: ${phone}`);
    const wallet = await createUserWallet();
    const user = createUser(db, phone, wallet.id, wallet.address);

    // Auto-fund from treasury if configured
    if (config.treasury.walletId && config.treasury.address) {
      try {
        const treasuryAccount = getViemAccount(
          config.treasury.walletId,
          config.treasury.address
        );
        const txHash = await transferUSDC(
          treasuryAccount,
          config.treasury.walletId,
          wallet.address,
          SEED_AMOUNT
        );
        console.log(
          `Seeded ${phone} with $${SEED_AMOUNT} USDC (tx: ${txHash})`
        );
      } catch (err) {
        console.warn(`Failed to seed ${phone} from treasury:`, err);
      }
    }

    return user;
  } catch {
    // Lost the race — another concurrent request already inserted this user.
    // The wallet we may have created is unused; read the winner's row instead.
    const created = getUser(db, phone);
    if (created) return created;
    throw new Error(`Failed to create or retrieve user for phone: ${phone}`);
  }
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
 *
 * Wallet provisioning is lazy — new Privy wallets are created only for commands
 * that require a wallet (balance, deposit, history, send, ask). Commands that
 * don't need a wallet (help, unknown) never trigger wallet creation.
 */
export async function handleMessage(
  senderPhone: string,
  text: string,
  deps: BotDeps
): Promise<BotReply> {
  const command = parseCommand(text);

  // Commands that don't require a wallet — respond immediately without provisioning
  if (command.type === "help") {
    return { text: handleHelp(), private: false };
  }
  if (command.type === "unknown") {
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

  // All other commands need a wallet — provision lazily on first use
  const sender = await getOrCreateUser(deps.db, senderPhone);

  switch (command.type) {
    case "balance":
      return {
        text: await handleBalance(sender, { getBalance }),
        private: true, // Don't leak balance to group
      };

    case "deposit":
      return {
        text: handleDeposit(sender),
        private: true, // Don't leak wallet address to group
      };

    case "history":
      return {
        text: handleHistory(deps.db, senderPhone),
        private: true, // Don't leak tx history to group
      };

    case "send":
      return {
        text: await handleSend(deps.db, sender, command.input, {
          getBalance,
          transferUSDC,
          parseAmount,
          getOrCreateUser: (phone) => getOrCreateUser(deps.db, phone),
          getViemAccount,
          sendMessage: deps.sendMessage,
        }),
        private: false, // Send confirmations are public
      };

    case "ask":
      return {
        text: await handleAsk(
          {
            prompt: command.prompt,
            walletId: sender.privy_wallet_id,
            address: sender.address as `0x${string}`,
          },
          { mppFetch, getViemAccount, serviceUrl: config.mpp.serviceUrl, model: config.mpp.model }
        ),
        private: false, // GPT answers are public — the whole point of group usage
      };
  }
}
