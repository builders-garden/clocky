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
          transferPathUSD,
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
          { mppFetch, getViemAccount }
        ),
        private: false, // GPT answers are public — the whole point of group usage
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
