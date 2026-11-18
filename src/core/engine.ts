// The router. Pure: no files, no network, no clock except the `now` passed in,
// so the same code runs on a laptop, in Docker, or on a serverless host.

import type { Condition, Config, Decision, Lead, OwnerSource, Pool, Rep, State, Target, When } from "./types.ts";
import { PERSONAL_DOMAINS, emailDomain, findEmail, getField, normalizeKey } from "./fields.ts";

/** A form field, or account.<Field> from Salesforce. */
export function valueOf(lead: Lead, field: string): string | undefined {
  if (field.toLowerCase().startsWith("account.")) {
    const account = lead.crm?.account;
    if (!account) return undefined;
    const want = normalizeKey(field.slice("account.".length));
    if (want === "name") return account.name;
    for (const [k, v] of Object.entries(account.fields)) {
      if (normalizeKey(k) === want) return v;
    }
    return undefined;
  }
  return getField(lead.fields, field);
}

export function matchesCondition(lead: Lead, c: Condition): boolean {
  const raw = valueOf(lead, c.field);
  if (raw === undefined || raw === "") return false;
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (c.equals !== undefined && lower !== String(c.equals).toLowerCase()) return false;
  if (c.in !== undefined && !c.in.some((x) => String(x).toLowerCase() === lower)) return false;
  if (c.contains !== undefined && !lower.includes(c.contains.toLowerCase())) return false;
  if (c.gte !== undefined || c.lte !== undefined) {
    const n = toNumber(value);
    if (n === null) return false;
    if (c.gte !== undefined && n < c.gte) return false;
    if (c.lte !== undefined && n > c.lte) return false;
  }
  return true;
}

/** "1,000", "$5k", "250+" and "51-200" (lower bound) all read as numbers. */
function toNumber(value: string): number | null {
  const m = value.replace(/[,$\s]/g, "").match(/^(\d+(?:\.\d+)?)(k|m)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]?.toLowerCase();
  return unit === "k" ? n * 1_000 : unit === "m" ? n * 1_000_000 : n;
}

export function matchesWhen(lead: Lead, when: When | undefined): boolean {
  if (!when) return true;
  if (when.all && !when.all.every((c) => matchesCondition(lead, c))) return false;
  if (when.any && when.any.length > 0 && !when.any.some((c) => matchesCondition(lead, c))) return false;
  return true;
}

export function localDate(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isAway(rep: Rep, now: Date): boolean {
  return rep.away_until !== undefined && localDate(now) <= rep.away_until;
}

/** Why a drop rule fired, or null to keep the lead. */
function dropReason(config: Config, lead: Lead): string | null {
  const drop = config.drop;
  if (!drop) return null;
  const domain = emailDomain(findEmail(lead.fields));
  if (drop.personal_email && domain && PERSONAL_DOMAINS.has(domain)) return "drop: personal email";
  if (domain && drop.domains?.some((d) => domain === d.toLowerCase() || domain.endsWith("." + d.toLowerCase()))) {
    return "drop: blocked domain";
  }
  for (const rule of drop.rules ?? []) {
    if (matchesWhen(lead, rule.when)) return `drop: ${rule.name}`;
  }
  return null;
}

/** Pick the next rep in a pool, or explain why nobody can take the lead. */
/** Rep id -> has open time. Reps missing from the map are treated as free. */
export type Availability = Map<string, boolean>;

export function pickFromPool(
  config: Config,
  poolId: string,
  state: State,
  now: Date,
  available?: Availability,
): { rep: Rep } | { reason: string } {
  const pool: Pool | undefined = config.pools?.[poolId];
  if (!pool) return { reason: `pool "${poolId}" does not exist` };
  const counters = state.pools[poolId] ?? {};
  const today = state.daily[localDate(now)]?.[poolId] ?? {};
  const known = pool.reps.map((id) => counters[id]?.count).filter((n): n is number => n !== undefined);
  // A rep new to the pool starts level with the lowest count, so they don't get every lead until caught up.
  const startCount = known.length ? Math.min(...known) : 0;

  const candidates = pool.reps
    .map((id, order) => ({ rep: config.reps.find((r) => r.id === id), order, id }))
    .filter((c): c is { rep: Rep; order: number; id: string } => c.rep !== undefined)
    .filter((c) => !isAway(c.rep, now))
    .filter((c) => pool.daily_cap === undefined || (today[c.id] ?? 0) < pool.daily_cap)
    .filter((c) => pool.distribution !== "weighted" || (pool.weights?.[c.id] ?? 1) > 0);

  if (candidates.length === 0) return { reason: `everyone in pool "${poolId}" is away or at their daily cap` };
  if (available) {
    const free = candidates.filter((c) => available.get(c.id) !== false);
    if (free.length > 0) candidates.splice(0, candidates.length, ...free);
    else if (config.calendar?.if_nobody_free === "fallback") return { reason: `nobody in pool "${poolId}" has open time` };
  }

  const score = (id: string) => {
    const count = counters[id]?.count ?? startCount;
    return pool.distribution === "weighted" ? count / (pool.weights?.[id] ?? 1) : count;
  };
  candidates.sort((a, b) => {
    const diff = score(a.id) - score(b.id);
    if (Math.abs(diff) > 1e-9) return diff;
    // Tie: whoever got a lead longest ago (never = first), then list order.
    const la = counters[a.id]?.last_at ?? "";
    const lb = counters[b.id]?.last_at ?? "";
    if (la !== lb) return la < lb ? -1 : 1;
    return a.order - b.order;
  });
  return { rep: candidates[0]!.rep };
}

/**
 * The first usable Salesforce owner in the order given. Queues, inactive users
 * and away reps are passed over. Null when nobody qualifies.
 */
function ownerDecision(
  config: Config,
  lead: Lead,
  order: OwnerSource[],
  ifNotRep: "route_to_owner" | "skip",
  rule: string,
  now: Date,
): Decision | null {
  for (const source of order) {
    const owner = lead.crm?.[source]?.owner;
    if (!owner || !owner.is_user || !owner.active || !owner.email) continue;
    const rep = config.reps.find((r) => r.email.toLowerCase() === owner.email!.toLowerCase());
    if (rep) {
      if (isAway(rep, now)) continue;
      return { status: "routed", rep, rule: `${rule} (${source} owner)` };
    }
    if (ifNotRep === "route_to_owner") {
      return {
        status: "routed",
        rep: { id: `salesforce:${owner.id}`, name: owner.name, email: owner.email },
        rule: `${rule} (${source} owner, not a Baton rep)`,
      };
    }
  }
  return null;
}

function resolveTarget(
  config: Config,
  target: Target,
  rule: string,
  state: State,
  now: Date,
  available?: Availability,
): Decision {
  if ("owner" in target) {
    return { status: "unassigned", rule, reason: "owner targets are resolved in route()" };
  }
  if ("rep" in target) {
    const rep = config.reps.find((r) => r.id === target.rep);
    if (!rep) return { status: "unassigned", rule, reason: `rep "${target.rep}" does not exist` };
    if (isAway(rep, now)) return { status: "unassigned", rule, reason: `${rep.name} is away` };
    return { status: "routed", rep, rule };
  }
  const picked = pickFromPool(config, target.pool, state, now, available);
  if ("reason" in picked) return { status: "unassigned", rule, reason: picked.reason };
  return { status: "routed", rep: picked.rep, pool: target.pool, rule };
}

/**
 * Route one lead: drop rules, then routes top to bottom (first match wins),
 * then the fallback. A matched route whose pool can't take the lead
 * (everyone away or capped) falls through to the fallback. A Salesforce-owner
 * route with no usable owner doesn't count as a match: the next route is tried.
 */
export function route(config: Config, lead: Lead, state: State, now: Date, available?: Availability): Decision {
  const dropped = dropReason(config, lead);
  if (dropped) return { status: "dropped", rule: dropped };

  for (const r of config.routes ?? []) {
    if (!matchesWhen(lead, r.when)) continue;
    if ("owner" in r.assign) {
      const owned = ownerDecision(config, lead, r.assign.owner, r.assign.if_not_rep, `route: ${r.name}`, now);
      if (owned) return owned;
      continue;
    }
    const decision = resolveTarget(config, r.assign, `route: ${r.name}`, state, now, available);
    if (decision.status === "routed") return decision;
    break;
  }
  const fb = config.fallback;
  if ("owner" in fb) {
    const owned = ownerDecision(config, lead, fb.owner, fb.if_not_rep, "fallback", now);
    return owned ?? { status: "unassigned", rule: "fallback", reason: "no usable Salesforce owner" };
  }
  const fallback = resolveTarget(config, fb, "fallback", state, now, available);
  if (fallback.status === "unassigned") {
    return { ...fallback, reason: `fallback can't take it: ${fallback.reason}` };
  }
  return fallback;
}

/** Count an assignment toward fairness and daily caps. Mutates state. */
export function recordAssignment(config: Config, state: State, decision: Decision, now: Date): void {
  if (decision.status !== "routed" || !decision.pool) return;
  const members = config.pools?.[decision.pool]?.reps ?? [];
  // A pool seen for the first time starts everyone at zero; only reps added later start level.
  const pool = (state.pools[decision.pool] ??= Object.fromEntries(members.map((id) => [id, { count: 0 }])));
  const counter = (pool[decision.rep.id] ??= { count: startingCount(pool, members) });
  counter.count += 1;
  counter.last_at = now.toISOString();
  const day = (state.daily[localDate(now)] ??= {});
  const dayPool = (day[decision.pool] ??= {});
  dayPool[decision.rep.id] = (dayPool[decision.rep.id] ?? 0) + 1;
}

function startingCount(pool: Record<string, { count: number }>, members: string[]): number {
  const counts = members.map((id) => pool[id]?.count).filter((n): n is number => n !== undefined);
  return counts.length ? Math.min(...counts) : 0;
}

/** Keep the last 7 days of daily counts. */
export function pruneDaily(state: State, now: Date): void {
  const cutoff = new Date(now.getTime() - 7 * 86_400_000);
  const keepFrom = localDate(cutoff);
  for (const day of Object.keys(state.daily)) {
    if (day < keepFrom) delete state.daily[day];
  }
}
