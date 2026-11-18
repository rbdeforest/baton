// Talks to the Apps Script pasted into the customer's Google Sheet
// (apps-script/baton-inbox.gs). Plain fetch, so it runs anywhere.

import type { Lead } from "../core/types.ts";

export interface SheetRow {
  row: number;
  fields: Record<string, string>;
}

export interface MarkRow {
  row: number;
  email: string | null;
  status: string;
  routed_to: string | null;
  rule: string;
  routed_at: string;
  baton_id: string;
}

export interface MarkResult {
  row: number;
  ok: boolean;
  error?: string;
}

export class SheetInbox {
  private url: string;
  private secret: string;
  private fetchImpl: typeof fetch;

  constructor(url: string, secret: string, fetchImpl: typeof fetch = fetch) {
    this.url = url;
    this.secret = secret;
    this.fetchImpl = fetchImpl;
  }

  async ping(): Promise<string> {
    const res = await this.get("ping");
    return String(res.sheet);
  }

  async pending(): Promise<Lead[]> {
    const res = await this.get("pending");
    const rows = (res.rows ?? []) as SheetRow[];
    return Promise.all(rows.map(async (r) => ({ key: await leadKey(r.fields), ref: r.row, fields: r.fields })));
  }

  async mark(rows: MarkRow[]): Promise<MarkResult[]> {
    if (rows.length === 0) return [];
    const res = await this.call(this.url, {
      method: "POST",
      // text/plain keeps Apps Script from needing a CORS preflight.
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ secret: this.secret, action: "mark", rows }),
    });
    return (res.results ?? []) as MarkResult[];
  }

  private async get(action: string): Promise<Record<string, unknown> & { rows?: unknown; sheet?: unknown }> {
    const u = new URL(this.url);
    u.searchParams.set("secret", this.secret);
    u.searchParams.set("action", action);
    return this.call(u.toString(), { method: "GET" });
  }

  private async call(url: string, init: RequestInit): Promise<Record<string, any>> {
    const res = await this.fetchImpl(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let body: Record<string, any>;
    try {
      body = JSON.parse(text);
    } catch {
      if (/accounts\.google\.com|<title>(Sign[ -]in|Access Denied)/i.test(text)) {
        throw new Error(
          'Google asked for a sign-in instead of running the Sheet script. Redeploy it with "Who has access: Anyone" (not "Anyone with Google account"), and authorize it once: in the Apps Script editor, pick doGet and click Run. ' +
            "If that option isn't offered, your company's Google Workspace blocks it: use a Sheet in a personal Google account instead.",
        );
      }
      throw new Error(
        `the Sheet script didn't answer with JSON (HTTP ${res.status}). Is the web app deployed with access "Anyone"? First bytes: ${text.slice(0, 120)}`,
      );
    }
    if (!body.ok) throw new Error(`the Sheet script said: ${body.error ?? "unknown error"}`);
    return body;
  }
}

/**
 * A hash of the submission's own non-empty fields, so sorting rows, inserting rows
 * or adding a new column never changes it.
 */
export async function leadKey(fields: Record<string, string>): Promise<string> {
  const sorted = Object.keys(fields)
    .filter((k) => fields[k] !== "")
    .sort()
    .map((k) => [k, fields[k]]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(sorted)));
  return "sheet:" + Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}
