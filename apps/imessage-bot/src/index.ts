// src/index.ts
// Entry point — starts iMessage watcher, wires dependencies, handles shutdown
// Supports both DM and group chat messages with reply routing.

import { IMessageSDK, type Message } from "@photon-ai/imessage-kit";
import { initDb } from "./db/schema";
import { handleMessage, type BotReply } from "./bot";
import { config } from "./config";

async function main() {
  console.log("Starting iMessage Pay bot...");

  // Initialize database
  const db = initDb(config.dbPath);
  console.log("Database initialized.");

  // Initialize iMessage SDK
  const sdk = new IMessageSDK();

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
  async function processMessage(msg: Message) {
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
        console.log(
          `[BOT -> ${senderPhone} (DM)]: ${reply.text.slice(0, 100)}...`
        );
      } else {
        // Public reply in group
        await sdk.send(msg.chatId, reply.text);
        console.log(
          `[BOT -> GROUP ${msg.chatId.slice(0, 12)}...]: ${reply.text.slice(0, 100)}...`
        );
      }
    } catch (err) {
      console.error(`Error handling message from ${senderPhone}:`, err);
      // Error replies go to the same channel as the original message
      const errorTarget = msg.isGroupChat ? msg.chatId : senderPhone;
      await sdk.send(errorTarget, "Something went wrong. Please try again.");
    }
  }

  // Start watching for messages — both DMs and group chats
  await sdk.startWatching({
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
