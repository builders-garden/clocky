// src/commands/ask.ts
// "ask <prompt>" — query any MPP service, paid from user's wallet balance.

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

    // Show MPP cost if provided in payment-receipt header
    const receipt = response.headers.get("x-payment-receipt") || response.headers.get("payment-receipt");
    const costLine = receipt ? `\n\n(Paid via MPP)` : "";

    return reply + costLine;
  } catch (err) {
    console.error("Ask command failed:", err);
    const msg = err instanceof Error ? err.message : "Unknown error";
    return `Failed to query service: ${msg}`;
  }
}
