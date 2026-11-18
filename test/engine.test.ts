import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseConfig, ConfigError } from "../src/core/config.ts";
import { recordAssignment, route } from "../src/core/engine.ts";
import { emptyState, type Config, type Decision } from "../src/core/types.ts";

const example = () => parseConfig(readFileSync(new URL("../examples/baton.yaml", import.meta.url), "utf8"));
const lead = (fields: Record<string, string>) => ({ key: JSON.stringify(fields), ref: 2, fields });
const NOW = new Date("2026-11-17T15:00:00");
const who = (d: Decision) => (d.status === "routed" ? d.rep.id : d.status);

function routeMany(config: Config, leads: Record<string, string>[]) {
  const state = emptyState();
  return leads.map((f) => {
    const d = route(config, lead(f), state, NOW);
    recordAssignment(config, state, d, NOW);
    return d;
  });
}

test("example config is valid", () => {
  assert.equal(example().reps.length, 4);
});

test("personal emails and blocked domains are dropped", () => {
  const c = example();
  assert.equal(route(c, lead({ email: "x@gmail.com" }), emptyState(), NOW).status, "dropped");
  assert.equal(route(c, lead({ Email: "x@eu.competitor.com" }), emptyState(), NOW).status, "dropped");
});

test("first matching route wins, field names are forgiving", () => {
  const d = route(example(), lead({ "Work Email": "a@acme.com", Company_Size: "1,500" }), emptyState(), NOW);
  assert.equal(d.status, "routed");
  assert.equal(d.rule, "route: Enterprise (1,000+ employees)");
});

test("even pool alternates", () => {
  const ds = routeMany(example(), Array.from({ length: 4 }, (_, i) => ({ email: `p${i}@big.com`, "company size": "5000" })));
  assert.deepEqual(ds.map(who), ["ana", "ben", "ana", "ben"]);
});

test("weighted pool gives weight 2 twice the leads", () => {
  const ds = routeMany(example(), Array.from({ length: 6 }, (_, i) => ({ email: `p${i}@small.com` })));
  const counts = ds.map(who).reduce<Record<string, number>>((m, r) => ((m[r] = (m[r] ?? 0) + 1), m), {});
  assert.deepEqual(counts, { cy: 4, dee: 2 });
});

test("away reps are skipped", () => {
  const c = example();
  c.reps.find((r) => r.id === "ana")!.away_until = "2026-11-20";
  const ds = routeMany(c, Array.from({ length: 3 }, (_, i) => ({ email: `p${i}@big.com`, "company size": "5000" })));
  assert.deepEqual(ds.map(who), ["ben", "ben", "ben"]);
});

test("daily cap, then the route falls through to the fallback", () => {
  const c = example();
  c.pools!.enterprise!.daily_cap = 1;
  const ds = routeMany(c, Array.from({ length: 3 }, (_, i) => ({ email: `p${i}@big.com`, "company size": "5000" })));
  assert.deepEqual(ds.map((d) => d.rule), ["route: Enterprise (1,000+ employees)", "route: Enterprise (1,000+ employees)", "fallback"]);
});

test("nobody available anywhere is unassigned, with a reason", () => {
  const c = example();
  for (const r of c.reps) r.away_until = "2026-12-31";
  const d = route(c, lead({ email: "a@small.com" }), emptyState(), NOW);
  assert.equal(d.status, "unassigned");
  assert.match(d.status === "unassigned" ? d.reason : "", /away or at their daily cap/);
});

test("a rep added later starts level instead of taking every lead", () => {
  const c = example();
  const state = emptyState();
  const send = () => {
    const d = route(c, lead({ email: "x@big.com", "company size": "5000" }), state, NOW);
    recordAssignment(c, state, d, NOW);
    return who(d);
  };
  for (let i = 0; i < 10; i++) send();
  c.pools!.enterprise!.reps.push("cy");
  const next = Array.from({ length: 3 }, send);
  assert.deepEqual([...next].sort(), ["ana", "ben", "cy"]);
});

test("bad configs explain themselves", () => {
  const text = readFileSync(new URL("../examples/baton.yaml", import.meta.url), "utf8").replace("reps: [ana, ben]", "reps: [ana, zed]");
  assert.throws(() => parseConfig(text), (e: unknown) => e instanceof ConfigError && e.problems.some((p) => p.includes('"zed"')));
  assert.throws(() => parseConfig("version: 2"), ConfigError);
});
