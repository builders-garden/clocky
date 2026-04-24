// src/commands/ask.ts
// "ask <prompt>" — query any MPP service, paid from user's wallet balance.

import type { Account } from "viem";

export interface AskDeps {
  mppFetch: (account: Account, url: string, init?: RequestInit) => Promise<Response>;
  getViemAccount: (walletId: string, address: `0x${string}`) => Account;
  serviceUrl: string;
  model: string;
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

  console.log(`[ASK] Starting — wallet=${input.walletId} address=${input.address}`);
  console.log(`[ASK] Prompt: "${input.prompt.slice(0, 80)}${input.prompt.length > 80 ? '...' : ''}"`);
  console.log(`[ASK] Service URL: ${deps.serviceUrl}`);
  console.log(`[ASK] Model: ${deps.model}`);

  try {
    const account = deps.getViemAccount(input.walletId, input.address);
    console.log(`[ASK] Account created — type=${account.type} address=${account.address}`);

    const body = JSON.stringify({
      model: deps.model,
      messages: [{ role: "user", content: input.prompt }],
    });

    console.log(`[ASK] Calling mppFetch...`);
    const t0 = Date.now();
    const response = await deps.mppFetch(account, deps.serviceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    console.log(`[ASK] mppFetch returned — status=${response.status} (${Date.now() - t0}ms)`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      console.error(`[ASK] Service error ${response.status}: ${errorText}`);
      return `Service error (${response.status}). Make sure you have sufficient balance.`;
    }

    const data = await response.json() as any;
    console.log(`[ASK] Response parsed — keys=${Object.keys(data).join(',')}`);

    // Extract the reply — OpenAI chat completions format
    const reply =
      data?.choices?.[0]?.message?.content ||
      data?.content?.[0]?.text ||
      JSON.stringify(data).slice(0, 500);

    // Show MPP cost if provided in payment-receipt header
    const receipt = response.headers.get("x-payment-receipt") || response.headers.get("payment-receipt");
    const costLine = receipt ? `\n\n(Paid via MPP)` : "";

    console.log(`[ASK] Success — reply length=${reply.length}`);
    return reply + costLine;
  } catch (err) {
    console.error("[ASK] FAILED:", err);
    const msg = err instanceof Error ? err.message : "Unknown error";
    return `Failed to query service: ${msg}`;
  }
}
