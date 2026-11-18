import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseConfig, ConfigError } from "../src/core/config.ts";
import { route } from "../src/core/engine.ts";
import { emptyState, type Config, type CrmOwner, type Lead } from "../src/core/types.ts";
import { SalesforceClient, hostOf, lookup, type SalesforceCredentials } from "../src/adapters/salesforce.ts";

const NOW = new Date("2026-11-17T15:00:00");
const user = (email: string, extra: Partial<CrmOwner> = {}): CrmOwner => ({ id: "005" + email, name: email, email, active: true, is_user: true, ...extra });

function config(extra = ""): Config {
  const base = readFileSync(new URL("../examples/baton.yaml", import.meta.url), "utf8");
  return parseConfig(
    base.replace(
      "routes:\n",
      `crm:\n  type: salesforce\n  account_fields: [Industry]\nroutes:\n  - name: Existing owner\n    assign: { owner: [contact, lead, account], if_not_rep: ${extra || "skip"} }\n`,
    ),
  );
}

const lead = (crm: Lead["crm"], fields: Record<string, string> = { email: "x@big.com" }): Lead => ({ key: "k", ref: 2, fields, crm });

test("owner order: contact first, then lead, then account", () => {
  const d = route(config(), lead({ lead: { id: "00Q", owner: user("ben@example.com") }, account: { id: "001", name: "A", fields: {}, owner: user("ana@example.com") } }), emptyState(), NOW);
  assert.equal(d.status === "routed" && d.rep.id, "ben");
  assert.equal(d.rule, "route: Existing owner (lead owner)");
});

test("queues, inactive owners and away reps are passed over", () => {
  const c = config();
  c.reps.find((r) => r.id === "ana")!.away_until = "2026-12-01";
  const d = route(
    c,
    lead({
      contact: { id: "003", owner: user("ana@example.com") },
      lead: { id: "00Q", owner: user("queue@example.com", { is_user: false }) },
      account: { id: "001", name: "A", fields: {}, owner: user("ben@example.com", { active: false }) },
    }, { email: "x@big.com", "company size": "5000" }),
    emptyState(),
    NOW,
  );
  assert.equal(d.rule, "route: Enterprise (1,000+ employees)", "no usable owner, so the next route");
});

test("owner who isn't a rep: skip, or route to them anyway", () => {
  const crm = { account: { id: "001", name: "A", fields: {}, owner: user("someone@else.com") } };
  assert.equal(route(config("skip"), lead(crm), emptyState(), NOW).rule, "fallback");
  const d = route(config("route_to_owner"), lead(crm), emptyState(), NOW);
  assert.equal(d.status === "routed" && d.rep.email, "someone@else.com");
});

test("account fields work in rules, and must be listed", () => {
  const base = readFileSync(new URL("../examples/baton.yaml", import.meta.url), "utf8");
  const withIndustry = (fields: string) =>
    base.replace("routes:\n", `crm:\n  type: salesforce\n  account_fields: [${fields}]\nroutes:\n  - name: Tech\n    when: { all: [ { field: account.Industry, equals: technology } ] }\n    assign: { rep: dee }\n`);
  const c = parseConfig(withIndustry("Industry"));
  const d = route(c, lead({ account: { id: "001", name: "A", fields: { Industry: "Technology" } } }), emptyState(), NOW);
  assert.equal(d.status === "routed" && d.rep.id, "dee");
  assert.throws(() => parseConfig(withIndustry("")), (e: unknown) => e instanceof ConfigError && e.problems.some((p) => p.includes("crm.account_fields")));
  assert.throws(() => parseConfig(base.replace("fallback: { pool: sdr }", "fallback: { owner: [account], if_not_rep: skip }")), ConfigError);
});

test("hostOf reads any way people type a website", () => {
  assert.equal(hostOf("https://www.Acme.com/about"), "acme.com");
  assert.equal(hostOf("acme.com"), "acme.com");
  assert.equal(hostOf("  "), null);
});

/** A pretend Salesforce: answers the token refresh and composite queries. */
function fakeSalesforce(accounts: Record<string, unknown>[], opts: { expireFirst?: boolean } = {}) {
  const soql: string[] = [];
  let tokens = 0;
  let expire = opts.expireFirst ?? false;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/services/oauth2/token") {
      tokens += 1;
      return Response.json({ access_token: `at${tokens}`, refresh_token: `rt${tokens}`, instance_url: "https://x.my.salesforce.com" });
    }
    if (expire) {
      expire = false;
      return new Response("[]", { status: 401 });
    }
    const body = JSON.parse(String(init?.body)) as { compositeRequest: { url: string; referenceId: string }[] };
    const compositeResponse = body.compositeRequest.map((r) => {
      const q = decodeURIComponent(r.url.split("q=")[1]!);
      soql.push(q);
      const records = r.referenceId === "accounts" ? accounts : [];
      return { referenceId: r.referenceId, httpStatusCode: 200, body: { records } };
    });
    return Response.json({ compositeResponse });
  }) as typeof fetch;
  return { fetchImpl, soql, tokens: () => tokens };
}

const creds: SalesforceCredentials = { login_url: "https://login.salesforce.com", instance_url: "https://x.my.salesforce.com", client_id: "c", refresh_token: "rt0" };
const acct = (name: string, website: string) => ({ Id: "001" + name, Name: name, Website: website, OwnerId: "005", Owner: { Name: "O", Email: "o@x.com", IsActive: true } });

test("lookup keeps only accounts whose website really matches, including parent domains", async () => {
  const sf = fakeSalesforce([acct("NotAcme", "https://notacme.com"), acct("Acme", "www.acme.com")]);
  const client = new SalesforceClient(creds, () => {}, sf.fetchImpl);
  const ctx = await lookup(client, { type: "salesforce" }, "jo@eu.acme.com");
  assert.equal(ctx.account?.name, "Acme");
  assert.equal(client.calls, 1, "one API call per lead");
});

test("emails are quoted safely in SOQL", async () => {
  const sf = fakeSalesforce([]);
  await lookup(new SalesforceClient(creds, () => {}, sf.fetchImpl), { type: "salesforce" }, "o'brien@acme.com");
  assert.ok(sf.soql.some((q) => q.includes("Email = 'o\\'brien@acme.com'")));
  assert.ok(sf.soql.some((q) => q.includes("Website LIKE '%acme.com%'")));
});

test("personal email domains never match an account", async () => {
  const sf = fakeSalesforce([acct("Google", "gmail.com")]);
  const ctx = await lookup(new SalesforceClient(creds, () => {}, sf.fetchImpl), { type: "salesforce" }, "a@gmail.com");
  assert.equal(ctx.account, undefined);
  assert.ok(!sf.soql.some((q) => q.includes("FROM Account")));
});

test("an expired session refreshes once, and the rotated login is saved", async () => {
  const sf = fakeSalesforce([], { expireFirst: true });
  const saved: string[] = [];
  const client = new SalesforceClient(creds, (c) => saved.push(c.refresh_token), sf.fetchImpl);
  await lookup(client, { type: "salesforce" }, "a@acme.com");
  assert.equal(sf.tokens(), 2);
  assert.deepEqual(saved, ["rt1", "rt2"]);
});
