// Five fake form leads: snippet -> Google Sheet script -> router -> signed
// webhook -> rows marked. Then the same run again must do nothing new.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseConfig } from "../src/core/config.ts";
import { runOnce } from "../src/core/run.ts";
import { emptyState, type State, type WebhookPayload } from "../src/core/types.ts";
import { SheetInbox } from "../src/adapters/sheet.ts";
import { deliver, sign } from "../src/adapters/webhook.ts";
import { fakeAppsScript } from "./fake-apps-script.ts";

const LEADS = [
  { email: "maria@bigbank.com", name: "Maria Lopez", company: "Big Bank", "company size": "12000" },
  { email: "tom@tinystartup.io", name: "Tom Reed", company: "Tiny", "company size": "15" },
  { email: "someone@gmail.com", name: "Pat Doe", company: "", "company size": "" },
  { email: "lee@megacorp.com", name: "Lee Chan", company: "MegaCorp", "company size": "3,000" },
  { email: "sam@midsize.co", name: "Sam Ford", company: "Midsize", "company size": "200" },
];

test("five fake leads route end to end, exactly once", async () => {
  const config = parseConfig(readFileSync(new URL("../examples/baton.yaml", import.meta.url), "utf8"));
  const sheet = fakeAppsScript("sheet-secret");
  for (const l of LEADS) sheet.submit(l);

  const received: { body: string; signature: string }[] = [];
  const webhookFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    received.push({ body: String(init?.body), signature: headers.get("X-Baton-Signature") ?? "" });
    return new Response("ok");
  }) as typeof fetch;

  let state: State = emptyState();
  const deps = {
    config,
    inbox: new SheetInbox(config.inbox.script_url, "sheet-secret", sheet.fetchImpl),
    deliver: (p: WebhookPayload) => deliver(config.webhook.url, "hook-secret", p, webhookFetch),
    loadState: () => structuredClone(state),
    saveState: (s: State) => { state = structuredClone(s); },
    appendLog: () => {},
    now: () => new Date("2026-11-17T15:00:00"),
  };

  const first = await runOnce(deps);
  assert.deepEqual(
    { read: first.read, routed: first.routed, dropped: first.dropped, sent: first.webhooks_sent, marked: first.marked },
    { read: 5, routed: 4, dropped: 1, sent: 5, marked: 5 },
  );

  const payloads = received.map((r) => JSON.parse(r.body) as WebhookPayload);
  const byEmail = Object.fromEntries(payloads.map((p) => [p.lead.email, p]));
  assert.equal(byEmail["maria@bigbank.com"]!.routed_to!.email, "ana@example.com");
  assert.equal(byEmail["lee@megacorp.com"]!.routed_to!.email, "ben@example.com");
  assert.equal(byEmail["someone@gmail.com"]!.status, "dropped");
  assert.equal(byEmail["someone@gmail.com"]!.routed_to, null);
  assert.equal(byEmail["tom@tinystartup.io"]!.rule, "fallback");
  assert.equal(byEmail["maria@bigbank.com"]!.lead.name, "Maria Lopez");
  assert.equal(byEmail["maria@bigbank.com"]!.lead.form["company size"], "12000");

  for (const r of received) assert.equal(r.signature, await sign("hook-secret", r.body));

  // The Sheet shows the result on every row.
  const headers = sheet.grid[0]!.map(String);
  const col = (name: string) => headers.indexOf(name);
  for (const row of sheet.grid.slice(1)) {
    assert.notEqual(row[col("baton_status")], "");
    assert.match(String(row[col("baton_id")]), /^ld_[0-9a-f]{16}$/);
  }

  // Second run: nothing new to read, nothing re-sent.
  const second = await runOnce(deps);
  assert.equal(second.read, 0);
  assert.equal(received.length, 5);
});

test("a failed webhook waits and goes out on the next run", async () => {
  const config = parseConfig(readFileSync(new URL("../examples/baton.yaml", import.meta.url), "utf8"));
  const sheet = fakeAppsScript("s");
  sheet.submit(LEADS[0]!);
  let up = false;
  let sent = 0;
  let state: State = emptyState();
  const deps = {
    config,
    inbox: new SheetInbox(config.inbox.script_url, "s", sheet.fetchImpl),
    deliver: async () => {
      if (!up) throw new Error("webhook answered HTTP 503");
      sent += 1;
    },
    loadState: () => structuredClone(state),
    saveState: (s: State) => { state = structuredClone(s); },
    appendLog: () => {},
  };
  const first = await runOnce(deps);
  assert.equal(first.webhooks_waiting, 1);
  assert.equal(first.marked, 1);
  up = true;
  const second = await runOnce(deps);
  assert.equal(second.webhooks_sent, 1);
  assert.equal(sent, 1);
  assert.equal(state.outbox.length, 0);
});

test("re-sorting the Sheet between reading and marking never routes a lead twice", async () => {
  const config = parseConfig(readFileSync(new URL("../examples/baton.yaml", import.meta.url), "utf8"));
  const sheet = fakeAppsScript("s");
  sheet.submit(LEADS[1]!);
  sheet.submit(LEADS[4]!);
  let state: State = emptyState();
  const inbox = new SheetInbox(config.inbox.script_url, "s", sheet.fetchImpl);
  // Swap the two rows right after Baton reads them, before it marks them.
  const realMark = inbox.mark.bind(inbox);
  let swapped = false;
  inbox.mark = async (rows) => {
    if (!swapped) {
      [sheet.grid[1], sheet.grid[2]] = [sheet.grid[2]!, sheet.grid[1]!];
      swapped = true;
    }
    return realMark(rows);
  };
  let sent = 0;
  const deps = {
    config,
    inbox,
    deliver: async () => { sent += 1; },
    loadState: () => structuredClone(state),
    saveState: (s: State) => { state = structuredClone(s); },
    appendLog: () => {},
  };
  const first = await runOnce(deps);
  assert.equal(first.marked, 0);
  assert.equal(first.mark_problems.length, 2);
  const second = await runOnce(deps);
  assert.equal(second.routed, 0, "already decided, so only marked");
  assert.equal(second.marked, 2);
  assert.equal(sent, 2);
});
