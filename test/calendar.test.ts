import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { parseConfig } from "../src/core/config.ts";
import { recordAssignment, route } from "../src/core/engine.ts";
import { emptyState, type State, type WebhookPayload } from "../src/core/types.ts";
import { CalendarChecker, parseBookingLink, prefilledUrl } from "../src/adapters/calendars.ts";
import { createBatonServer } from "../src/server/server.ts";

const NOW = new Date("2026-11-18T15:00:00");

test("booking links are recognized", () => {
  assert.equal(parseBookingLink("https://calendly.com/sam/30min").provider, "calendly");
  assert.deepEqual(parseBookingLink("https://meetings.hubspot.com/sam-rep").slug, "sam-rep");
  assert.equal(parseBookingLink("https://meetings-eu1.hubspot.com/sam").provider, "hubspot");
  const cal = parseBookingLink("https://cal.com/sam/intro");
  assert.deepEqual([cal.provider, cal.username, cal.event], ["calcom", "sam", "intro"]);
  assert.equal(parseBookingLink("https://savvycal.com/sam/chat").provider, "link");
});

test("the pop-up page has the lead's name and email filled in", () => {
  assert.equal(prefilledUrl(parseBookingLink("https://calendly.com/sam/30min"), "Jane Doe", "jane@acme.com"), "https://calendly.com/sam/30min?name=Jane+Doe&email=jane%40acme.com");
  const hs = new URL(prefilledUrl(parseBookingLink("https://meetings.hubspot.com/sam"), "Jane van Doe", "jane@acme.com"));
  assert.deepEqual([hs.searchParams.get("firstName"), hs.searchParams.get("lastName"), hs.searchParams.get("embed")], ["Jane", "van Doe", "true"]);
});

function fakeApis(free: Record<string, boolean>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    calls.push(u.hostname + u.pathname);
    if (u.hostname === "api.cal.com") {
      const open = free[`cal:${u.searchParams.get("username")}`];
      return Response.json({ status: "success", data: { "2026-11-19": open ? [{ start: "2026-11-19T15:00:00Z" }] : [] } });
    }
    if (u.hostname === "api.hubapi.com") {
      const slug = u.pathname.split("/").pop()!;
      const t = NOW.getTime() + 86_400_000;
      return Response.json({ allUsersBusyTimes: [], linkAvailability: { hasMore: false, linkAvailabilityByDuration: { "1800000": { meetingDurationMillis: 1800000, availabilities: free[`hs:${slug}`] ? [{ startMillisUtc: t, endMillisUtc: t + 1800000 }] : [] } } } });
    }
    if (u.pathname === "/users/me") return Response.json({ resource: { uri: "https://api.calendly.com/users/U1", current_organization: "https://api.calendly.com/organizations/O1" } });
    if (u.pathname === "/event_types") {
      if (u.searchParams.has("organization")) return new Response("{}", { status: 403 });
      return Response.json({ collection: [{ uri: "https://api.calendly.com/event_types/E1", scheduling_url: "https://calendly.com/sam/30min" }], pagination: { next_page: null } });
    }
    if (u.pathname === "/event_type_available_times") return Response.json({ collection: free["calendly:E1"] ? [{ status: "available", start_time: "2026-11-19T15:00:00Z" }] : [] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("each provider's answer is read correctly, and unknowns count as free", async () => {
  const api = fakeApis({ "cal:ana": true, "cal:ben": false, "hs:cy": true, "hs:dee": false, "calendly:E1": false });
  const c = new CalendarChecker({ hubspot_token: "h", calendly_token: "k" }, api.fetchImpl);
  c.now = () => NOW.getTime();
  assert.equal(await c.isFree("https://cal.com/ana/intro", 5), true);
  assert.equal(await c.isFree("https://cal.com/ben/intro", 5), false);
  assert.equal(await c.isFree("https://meetings.hubspot.com/cy", 5), true);
  assert.equal(await c.isFree("https://meetings.hubspot.com/dee", 5), false);
  assert.equal(await c.isFree("https://calendly.com/sam/30min", 5), false, "a non-admin token still finds its own page");
  assert.equal(await c.isFree("https://calendly.com/someone-else/30min", 5), null, "a page the token can't see isn't held against the rep");
  assert.equal(await c.isFree("https://savvycal.com/x/y", 5), null);
  assert.equal(await new CalendarChecker({}, api.fetchImpl).isFree("https://meetings.hubspot.com/cy", 5), null, "no token, no check");
  const before = api.calls.length;
  await c.isFree("https://cal.com/ana/intro", 5);
  assert.equal(api.calls.length, before, "answers are cached for a few minutes");
});

function calendarConfig(ifNobodyFree: "route_anyway" | "fallback") {
  const base = readFileSync(new URL("../examples/baton.yaml", import.meta.url), "utf8")
    .replace(/run:\n  mode: laptop\n  every_minutes: 5\ninbox:\n  type: google_sheet\n  script_url: \S+\n/, "run: { mode: server }\nserver:\n  public_url: https://baton.acme.com\n  form_origins: [https://www.acme.com]\n  rate_limit_per_minute: 100\n")
    .replace("{ id: ana, name: Ana Ortiz, email: ana@example.com }", "{ id: ana, name: Ana Ortiz, email: ana@example.com, booking_link: https://cal.com/ana/intro }")
    .replace("{ id: ben, name: Ben Cole, email: ben@example.com }", "{ id: ben, name: Ben Cole, email: ben@example.com, booking_link: https://cal.com/ben/intro }");
  return parseConfig(`${base}calendar:\n  popup: true\n  check_availability: true\n  days_ahead: 5\n  if_nobody_free: ${ifNobodyFree}\n`);
}

test("pools skip reps with no open time; with nobody free, route anyway or fall back", () => {
  const big = { key: "k", ref: 0, fields: { email: "x@big.com", "company size": "5000" } };
  const c = calendarConfig("route_anyway");
  const state = emptyState();
  const anaBusy = new Map([["ana", false], ["ben", true]]);
  for (let i = 0; i < 3; i++) {
    const d = route(c, big, state, NOW, anaBusy);
    assert.equal(d.status === "routed" && d.rep.id, "ben");
    recordAssignment(c, state, d, NOW);
  }
  const nobody = new Map([["ana", false], ["ben", false]]);
  assert.equal(route(c, big, emptyState(), NOW, nobody).rule, "route: Enterprise (1,000+ employees)");
  assert.equal(route(calendarConfig("fallback"), big, emptyState(), NOW, nobody).rule, "fallback");
});

test("the server answers the form with the free rep's prefilled booking page", async () => {
  const api = fakeApis({ "cal:ana": false, "cal:ben": true });
  let state: State = emptyState();
  const sent: WebhookPayload[] = [];
  const baton = createBatonServer({
    config: calendarConfig("route_anyway"),
    hookSecret: "k",
    loadState: () => structuredClone(state),
    saveState: (s) => { state = structuredClone(s); },
    appendLog: () => {},
    deliver: async (p) => { sent.push(p); },
    calendars: new CalendarChecker({}, api.fetchImpl),
    log: () => {},
    version: "test",
  });
  await new Promise<void>((r) => baton.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(baton.server.address() as AddressInfo).port}/lead`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Origin: "https://www.acme.com", "Content-Type": "text/plain" },
    body: JSON.stringify({ fields: { email: "jane@big.com", name: "Jane Doe", "company size": "5000" } }),
  });
  const body = (await res.json()) as { booking: { url: string; provider: string } };
  assert.deepEqual(body.booking, { url: "https://cal.com/ben/intro?name=Jane+Doe&email=jane%40big.com", provider: "calcom" });
  baton.stop();
  await baton.drain();
  await new Promise((r) => baton.server.close(r));
  assert.equal(sent[0]!.routed_to!.email, "ben@example.com");
});
