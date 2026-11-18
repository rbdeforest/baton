import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { parseConfig } from "../src/core/config.ts";
import { emptyState, type State, type WebhookPayload } from "../src/core/types.ts";
import { createBatonServer } from "../src/server/server.ts";

const SITE = "https://www.acme.com";

function serverConfig(rate = 100) {
  const base = readFileSync(new URL("../examples/baton.yaml", import.meta.url), "utf8")
    .replace(/run:\n  mode: laptop\n  every_minutes: 5\ninbox:\n  type: google_sheet\n  script_url: \S+\n/, `run: { mode: server }\nserver:\n  public_url: https://baton.acme.com\n  form_origins: [${SITE}]\n  rate_limit_per_minute: ${rate}\n`);
  return parseConfig(base);
}

async function start(opts: { rate?: number; lookupFails?: () => boolean } = {}) {
  let state: State = emptyState();
  const sent: WebhookPayload[] = [];
  const baton = createBatonServer({
    config: serverConfig(opts.rate),
    hookSecret: "hook-key",
    loadState: () => structuredClone(state),
    saveState: (s) => { state = structuredClone(s); },
    appendLog: () => {},
    deliver: async (p) => { sent.push(p); },
    ...(opts.lookupFails ? { lookup: async () => { if (opts.lookupFails!()) throw new Error("Salesforce is down"); return {}; } } : {}),
    log: () => {},
    version: "test",
  });
  await new Promise<void>((r) => baton.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(baton.server.address() as AddressInfo).port}`;
  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: "POST", body, headers: { "Content-Type": "text/plain", ...headers } });
  const close = async () => { baton.stop(); await baton.drain(); await new Promise((r) => baton.server.close(r)); };
  return { baton, base, post, sent, state: () => state, close };
}

const lead = (email: string, extra: Record<string, string> = {}, sid?: string) => JSON.stringify({ fields: { email, ...extra }, ...(sid ? { submission_id: sid } : {}) });

test("a form on an allowed website routes instantly and the webhook goes out", async () => {
  const s = await start();
  const res = await s.post("/lead", lead("maria@bigbank.com", { "company size": "12000" }), { Origin: SITE });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), SITE);
  const body = (await res.json()) as { ok: boolean; baton_id: string };
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body).sort(), ["baton_id", "ok"], "visitors learn nothing about the team");
  await s.baton.drain();
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0]!.routed_to!.email, "ana@example.com");
  assert.equal(s.sent[0]!.baton_id, body.baton_id);
  await s.close();
});

test("other websites and non-browser posts are turned away from /lead", async () => {
  const s = await start();
  assert.equal((await s.post("/lead", lead("a@b.com"), { Origin: "https://evil.example" })).status, 403);
  assert.equal((await s.post("/lead", lead("a@b.com"))).status, 403);
  const pre = await fetch(s.base + "/lead", { method: "OPTIONS", headers: { Origin: SITE } });
  assert.equal(pre.status, 204);
  await s.close();
});

test("one IP sending too fast is slowed down", async () => {
  const s = await start({ rate: 2 });
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await s.post("/lead", lead(`p${i}@co.com`), { Origin: SITE })).status);
  assert.deepEqual(codes, [200, 200, 429]);
  await s.close();
});

test("form tools use /hook with the key, as JSON or a form", async () => {
  const s = await start();
  assert.equal((await s.post("/hook", lead("a@co.com"))).status, 401);
  assert.equal((await s.post("/hook", lead("a@co.com"), { Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await s.post("/hook", JSON.stringify({ email: "flat@co.com" }), { Authorization: "Bearer hook-key", "Content-Type": "application/json" })).status, 200);
  assert.equal((await s.post("/hook", "email=form%40co.com&name=Jo", { "X-Baton-Key": "hook-key", "Content-Type": "application/x-www-form-urlencoded" })).status, 200);
  await s.baton.drain();
  assert.deepEqual(s.sent.map((p) => p.lead.email), ["flat@co.com", "form@co.com"]);
  await s.close();
});

test("the same submission sent twice is routed once", async () => {
  const s = await start();
  const a = (await (await s.post("/lead", lead("x@co.com", {}, "sub-1"), { Origin: SITE })).json()) as { baton_id: string };
  const b = (await (await s.post("/lead", lead("x@co.com", {}, "sub-1"), { Origin: SITE })).json()) as { baton_id: string; duplicate: boolean };
  assert.equal(b.baton_id, a.baton_id);
  assert.equal(b.duplicate, true);
  await s.baton.drain();
  assert.equal(s.sent.length, 1);
  await s.close();
});

test("Salesforce down: the form still gets an answer, and the lead routes once it's back", async () => {
  let down = true;
  const s = await start({ lookupFails: () => down });
  const res = (await (await s.post("/lead", lead("x@co.com"), { Origin: SITE })).json()) as { ok: boolean; baton_id: string };
  assert.equal(res.ok, true);
  await s.baton.drain();
  assert.equal(s.sent.length, 0);
  assert.equal(s.state().pending!.length, 1);
  down = false;
  await s.baton.retry();
  await s.baton.drain();
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0]!.baton_id, res.baton_id, "the ID the form got is the one in the webhook");
  assert.equal(s.state().pending!.length, 0);
  await s.close();
});
