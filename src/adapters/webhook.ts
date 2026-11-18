// Sends the routing result to the customer's webhook. Signed with HMAC-SHA256
// (Web Crypto, so it runs on Node, Workers and Deno alike).

import type { WebhookPayload } from "../core/types.ts";

export async function sign(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return "sha256=" + Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function deliver(
  url: string,
  secret: string,
  payload: WebhookPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const body = JSON.stringify(payload);
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "baton-router",
      "X-Baton-Id": payload.baton_id,
      "X-Baton-Signature": await sign(secret, body),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`);
}
