// Salesforce: the browser-tab login (OAuth with PKCE, no secret), token refresh,
// and the per-lead lookups. Read-only: Baton never writes to Salesforce.
// Uses fetch only, so the same code runs on a laptop, in Docker or hosted.

import type { CrmContext, CrmOwner, SalesforceConfig } from "../core/types.ts";
import { PERSONAL_DOMAINS, emailDomain } from "../core/fields.ts";

export const API_VERSION = "v64.0";
export const CALLBACK_PORT = 8749;
export const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`;
/** Baton's published Salesforce app. Empty until the package is released; --client-id overrides it. */
export const DEFAULT_CLIENT_ID = "";

export interface SalesforceCredentials {
  login_url: string;
  instance_url: string;
  client_id: string;
  refresh_token: string;
  username?: string;
  org_id?: string;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

export function authorizeUrl(loginUrl: string, clientId: string, challenge: string, state: string): string {
  const u = new URL("/services/oauth2/authorize", loginUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", CALLBACK_URL);
  u.searchParams.set("scope", "api refresh_token");
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  u.searchParams.set("prompt", "login consent");
  return u.toString();
}

async function tokenRequest(loginUrl: string, body: Record<string, string>, fetchImpl: typeof fetch) {
  const res = await fetchImpl(new URL("/services/oauth2/token", loginUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok) throw new Error(`Salesforce login failed: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`);
  return json;
}

/** Trade the code from the browser login for a lasting connection. */
export async function exchangeCode(
  loginUrl: string,
  clientId: string,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SalesforceCredentials> {
  const t = await tokenRequest(loginUrl, { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CALLBACK_URL, code_verifier: verifier }, fetchImpl);
  if (!t.refresh_token) throw new Error("Salesforce didn't return a refresh token. The app needs the refresh_token scope.");
  const creds: SalesforceCredentials = { login_url: loginUrl, instance_url: t.instance_url!, client_id: clientId, refresh_token: t.refresh_token };
  try {
    const id = await fetchImpl(t.id!, { headers: { Authorization: `Bearer ${t.access_token}` } });
    const who = (await id.json()) as { username?: string; organization_id?: string };
    creds.username = who.username;
    creds.org_id = who.organization_id;
  } catch {
    // Who's logged in is only for display.
  }
  return creds;
}

export class SalesforceClient {
  private creds: SalesforceCredentials;
  private onRotate: (creds: SalesforceCredentials) => void;
  private fetchImpl: typeof fetch;
  private accessToken: string | null = null;
  /** API calls made, for the run summary. */
  calls = 0;

  constructor(creds: SalesforceCredentials, onRotate: (creds: SalesforceCredentials) => void, fetchImpl: typeof fetch = fetch) {
    this.creds = creds;
    this.onRotate = onRotate;
    this.fetchImpl = fetchImpl;
  }

  /** Salesforce rotates the refresh token on every use: the new one must be saved right away. */
  private async refresh(): Promise<void> {
    const t = await tokenRequest(this.creds.login_url, { grant_type: "refresh_token", refresh_token: this.creds.refresh_token, client_id: this.creds.client_id }, this.fetchImpl).catch((e: Error) => {
      throw new Error(`${e.message}. Log in again with: baton-router connect salesforce`);
    });
    this.accessToken = t.access_token!;
    const next = { ...this.creds, instance_url: t.instance_url ?? this.creds.instance_url };
    if (t.refresh_token && t.refresh_token !== this.creds.refresh_token) next.refresh_token = t.refresh_token;
    if (next.refresh_token !== this.creds.refresh_token || next.instance_url !== this.creds.instance_url) {
      this.creds = next;
      this.onRotate(next);
    }
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.accessToken) await this.refresh();
    for (let attempt = 0; attempt < 2; attempt++) {
      this.calls += 1;
      const res = await this.fetchImpl(new URL(path, this.creds.instance_url), {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 401 && attempt === 0) {
        await this.refresh();
        continue;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = Array.isArray(body) ? body.map((e: { message?: string }) => e.message).join("; ") : `HTTP ${res.status}`;
        throw new Error(`Salesforce said: ${msg}`);
      }
      return body as T;
    }
    throw new Error("Salesforce rejected the login twice. Log in again with: baton-router connect salesforce");
  }

  query<T = Record<string, unknown>>(soql: string): Promise<{ records: T[]; totalSize: number }> {
    return this.request(`/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`);
  }

  /** Several queries in one API call. Each result is null if that query failed. */
  async queries(named: Record<string, string>): Promise<Record<string, Record<string, unknown>[] | null>> {
    const compositeRequest = Object.entries(named).map(([referenceId, soql]) => ({
      method: "GET",
      url: `/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`,
      referenceId,
    }));
    const res = await this.request<{ compositeResponse: { referenceId: string; httpStatusCode: number; body: unknown }[] }>(
      `/services/data/${API_VERSION}/composite`,
      { method: "POST", body: JSON.stringify({ allOrNone: false, compositeRequest }) },
    );
    const out: Record<string, Record<string, unknown>[] | null> = {};
    for (const r of res.compositeResponse) {
      if (r.httpStatusCode === 200) out[r.referenceId] = (r.body as { records: Record<string, unknown>[] }).records;
      else {
        const msg = Array.isArray(r.body) ? (r.body as { message?: string }[]).map((e) => e.message).join("; ") : `HTTP ${r.httpStatusCode}`;
        throw new Error(`Salesforce ${r.referenceId} lookup failed: ${msg}`);
      }
    }
    return out;
  }

  get connection(): SalesforceCredentials {
    return this.creds;
  }
}

/** Quote a value for SOQL. */
export function soqlString(value: string): string {
  return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

/** A SOQL LIKE pattern matching `value` anywhere, with % and _ in it taken literally. */
function soqlContains(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/%/g, "\\%").replace(/_/g, "\\_");
  return `'%${escaped}%'`;
}

/** "https://www.Acme.com/about" -> "acme.com" */
export function hostOf(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  const withScheme = /^[a-z]+:\/\//.test(v) ? v : `http://${v}`;
  try {
    return new URL(withScheme).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function fieldName(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*(__c)?$/.test(name)) throw new Error(`"${name}" isn't a valid Salesforce field name`);
  return name;
}

function owner(record: Record<string, unknown>, isUserDefault: boolean): CrmOwner | undefined {
  const o = record.Owner as Record<string, unknown> | null | undefined;
  if (!o || !record.OwnerId) return undefined;
  return {
    id: String(record.OwnerId),
    name: String(o.Name ?? ""),
    email: (o.Email as string | null) ?? null,
    active: o.IsActive !== false,
    is_user: o.Type !== undefined ? o.Type === "User" : isUserDefault,
  };
}

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/**
 * Everything Salesforce knows about one email: the oldest contact and open lead
 * with that email, and the account (the contact's account, or the one whose
 * website matches the email domain). One API call, two if the contact's account
 * has a different domain.
 */
export async function lookup(client: SalesforceClient, config: SalesforceConfig, email: string | null): Promise<CrmContext> {
  if (!email) return {};
  const domainField = fieldName(config.account_domain_field ?? "Website");
  const extra = [...new Set((config.account_fields ?? []).map(fieldName).filter((f) => f !== "Name" && f !== domainField))];
  const accountSelect = ["Id", "Name", domainField, "CreatedDate", "OwnerId", "Owner.Name", "Owner.Email", "Owner.IsActive", ...extra].join(", ");
  const e = soqlString(email.toLowerCase());

  const named: Record<string, string> = {
    contact: `SELECT Id, AccountId, OwnerId, Owner.Name, Owner.Email, Owner.IsActive FROM Contact WHERE Email = ${e} ORDER BY CreatedDate ASC LIMIT 1`,
    lead: `SELECT Id, OwnerId, Owner.Name, Owner.Email, Owner.IsActive, Owner.Type FROM Lead WHERE Email = ${e} AND IsConverted = false ORDER BY CreatedDate ASC LIMIT 1`,
  };
  const domain = emailDomain(email);
  const candidates: string[] = [];
  if (domain && !PERSONAL_DOMAINS.has(domain)) {
    candidates.push(domain);
    const labels = domain.split(".");
    if (labels.length > 2) candidates.push(labels.slice(1).join("."));
    const like = candidates.map((d) => `${domainField} LIKE ${soqlContains(d)}`).join(" OR ");
    named.accounts = `SELECT ${accountSelect} FROM Account WHERE ${like} ORDER BY CreatedDate ${config.multiple_accounts === "newest" ? "DESC" : "ASC"} LIMIT 50`;
  }
  const res = await client.queries(named);

  const ctx: CrmContext = {};
  const contact = res.contact?.[0];
  if (contact) ctx.contact = { id: String(contact.Id), owner: owner(contact, true) };
  const lead = res.lead?.[0];
  if (lead) ctx.lead = { id: String(lead.Id), owner: owner(lead, true) };

  const matches = (res.accounts ?? []).filter((a) => {
    const host = hostOf(text(a[domainField]));
    return host !== null && domain !== null && (domain === host || domain.endsWith(`.${host}`));
  });
  let account = contact?.AccountId ? matches.find((a) => a.Id === contact.AccountId) : matches[0];
  if (!account && contact?.AccountId) {
    const r = await client.query(`SELECT ${accountSelect} FROM Account WHERE Id = ${soqlString(String(contact.AccountId))}`);
    account = r.records[0];
  }
  if (account) {
    const fields: Record<string, string> = {};
    for (const f of [domainField, ...extra]) fields[f] = text(account[f]);
    ctx.account = { id: String(account.Id), name: text(account.Name), fields, owner: owner(account, true) };
  }
  return ctx;
}
