// `baton-router serve`: Baton as an always-on web server. Website forms post
// to /lead (only from the websites listed in setup, rate limited per IP), form
// tools post to /hook with a secret key, and every lead is routed the moment
// it arrives. Webhooks go out right after; failures retry every minute.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { findEmail, findName } from "../core/fields.ts";
import { decide, flushOutbox, newBatonId, trimProcessed } from "../core/run.ts";
import { pruneDaily, route, type Availability } from "../core/engine.ts";
import type { Config, CrmContext, Decision, Lead, State, WebhookPayload } from "../core/types.ts";
import { parseBookingLink, prefilledUrl, type CalendarChecker, type Provider } from "../adapters/calendars.ts";
import type { LogLine } from "../adapters/store.ts";

export interface ServerDeps {
  config: Config;
  hookSecret: string;
  loadState: () => State;
  saveState: (state: State) => void;
  appendLog: (lines: LogLine[]) => void;
  deliver: (payload: WebhookPayload) => Promise<void>;
  lookup?: (lead: Lead) => Promise<CrmContext>;
  calendars?: CalendarChecker;
  log?: (line: string) => void;
  now?: () => Date;
  version: string;
}

const MAX_BODY = 32 * 1024;
const MAX_FIELDS = 60;
const MAX_VALUE = 2000;
const RETRY_EVERY_MS = 60_000;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** JSON ({fields, submission_id} or a flat object) or form-encoded, into string fields. */
export function parseSubmission(raw: string, contentType: string): { fields: Record<string, string>; submissionId?: string } {
  let data: Record<string, unknown>;
  if (contentType.includes("application/x-www-form-urlencoded")) {
    data = Object.fromEntries(new URLSearchParams(raw));
  } else {
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "body must be JSON or a form");
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "body must be an object");
  const source = data.fields && typeof data.fields === "object" && !Array.isArray(data.fields) ? (data.fields as Record<string, unknown>) : data;
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (k === "submission_id" || k === "fields" || v === null || v === undefined || typeof v === "object") continue;
    if (Object.keys(fields).length >= MAX_FIELDS) break;
    fields[k.slice(0, 200)] = String(v).slice(0, MAX_VALUE);
  }
  if (Object.keys(fields).length === 0) throw new HttpError(400, "no fields");
  const sid = typeof data.submission_id === "string" ? data.submission_id.slice(0, 100) : undefined;
  return { fields, ...(sid ? { submissionId: sid } : {}) };
}

/** Per-IP counts for the current minute. */
class RateLimiter {
  private limit: number;
  private minute = 0;
  private counts = new Map<string, number>();
  constructor(limit: number) {
    this.limit = limit;
  }
  allow(ip: string, now: Date): boolean {
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute !== this.minute) {
      this.minute = minute;
      this.counts.clear();
    }
    const n = (this.counts.get(ip) ?? 0) + 1;
    this.counts.set(ip, n);
    return n <= this.limit;
  }
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

function sameOrigin(a: string, b: string): boolean {
  return a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export function createBatonServer(deps: ServerDeps): { server: Server; drain: () => Promise<void>; retry: () => Promise<void>; stop: () => void } {
  const { config } = deps;
  const settings = config.server!;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const state = deps.loadState();
  state.pending ??= [];
  const limiter = new RateLimiter(settings.rate_limit_per_minute);

  // Every change to state runs one at a time, in arrival order.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };

  const save = () => {
    trimProcessed(state);
    pruneDaily(state, now());
    deps.saveState(state);
  };

  const flush = () =>
    serial(async () => {
      if (state.outbox.length === 0) return;
      await flushOutbox(state, deps.deliver);
      save();
    }).catch((e: Error) => log(`webhook flush failed: ${e.message}`));

  /**
   * Which pool reps have open time, checked only for the pool the lead is
   * headed to (and the fallback pool if it moves there). Pools only: an owner
   * or a named rep gets the lead whatever their calendar says.
   */
  async function availabilityFor(lead: Lead): Promise<Availability | undefined> {
    const cal = config.calendar;
    if (!cal?.check_availability || !deps.calendars) return undefined;
    const available: Availability = new Map();
    const checked = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const d = route(config, lead, state, now(), available);
      const pool = d.status === "routed" ? d.pool : undefined;
      if (!pool || checked.has(pool)) break;
      checked.add(pool);
      const reps = (config.pools?.[pool]?.reps ?? []).map((id) => config.reps.find((r) => r.id === id)).filter((r) => r?.booking_link);
      const free = await Promise.all(reps.map((r) => deps.calendars!.isFree(r!.booking_link!, cal.days_ahead)));
      reps.forEach((r, j) => available.set(r!.id, free[j] !== false));
    }
    return available;
  }

  /** Look up, route and record one lead. Null if Salesforce didn't answer (the lead waits). */
  async function process(lead: Lead, batonId: string): Promise<Decision | null> {
    if (deps.lookup) {
      try {
        lead.crm = await deps.lookup(lead);
      } catch (e) {
        const pending = state.pending!.find((p) => p.lead.key === lead.key);
        if (pending) {
          pending.attempts += 1;
          pending.last_error = (e as Error).message;
        } else {
          state.pending!.push({ lead, baton_id: batonId, received_at: now().toISOString(), attempts: 1, last_error: (e as Error).message });
        }
        log(`${findEmail(lead.fields) ?? "(no email)"} waiting: Salesforce lookup failed: ${(e as Error).message}`);
        return null;
      }
    }
    const { decision, logLine } = decide(config, state, lead, now(), batonId, await availabilityFor(lead));
    deps.appendLog([logLine]);
    log(`${logLine.email ?? "(no email)"} -> ${decision.status}${logLine.routed_to ? ` ${logLine.routed_to}` : ""} [${decision.rule}]`);
    return decision;
  }

  /** The routed rep's booking page for the pop-up, with the lead's name and email filled in. */
  function bookingFor(decision: Decision | null, fields: Record<string, string>): { url: string; provider: Provider } | undefined {
    if (!config.calendar?.popup || decision?.status !== "routed" || !decision.rep.booking_link) return undefined;
    const page = parseBookingLink(decision.rep.booking_link);
    return { url: prefilledUrl(page, findName(fields), findEmail(fields)), provider: page.provider };
  }

  function accept(
    fields: Record<string, string>,
    submissionId: string | undefined,
  ): Promise<{ baton_id: string; duplicate?: boolean; booking?: { url: string; provider: Provider } }> {
    return serial(async () => {
      const batonId = newBatonId();
      const key = `srv:${submissionId ?? batonId}`;
      const done = state.processed[key];
      if (done) return { baton_id: done.baton_id, duplicate: true };
      const waiting = state.pending!.find((p) => p.lead.key === key);
      if (waiting) return { baton_id: waiting.baton_id, duplicate: true };
      const decision = await process({ key, ref: 0, fields }, batonId);
      save();
      const booking = bookingFor(decision, fields);
      return { baton_id: batonId, ...(booking ? { booking } : {}) };
    });
  }

  async function retryPending(): Promise<void> {
    await serial(async () => {
      const queue = [...state.pending!];
      for (const p of queue) {
        if ((await process(p.lead, p.baton_id)) !== null) state.pending = state.pending!.filter((x) => x !== p);
      }
      if (queue.length) save();
    });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://baton");
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const allowed = origin ? settings.form_origins.some((o) => sameOrigin(o, origin)) : false;
    const cors: Record<string, string> = allowed ? { "Access-Control-Allow-Origin": origin!, Vary: "Origin" } : {};
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        send(res, 200, { ok: true, version: deps.version, waiting_webhooks: state.outbox.length, waiting_lookups: state.pending!.length });
        return;
      }
      if (url.pathname === "/lead") {
        if (req.method === "OPTIONS") {
          if (!allowed) throw new HttpError(403, "this website isn't allowed to send leads");
          res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" });
          res.end();
          return;
        }
        if (req.method !== "POST") throw new HttpError(405, "POST only");
        if (!allowed) throw new HttpError(403, "this website isn't allowed to send leads (add it to server.form_origins)");
        if (!limiter.allow(clientIp(req), now())) throw new HttpError(429, "too many submissions, try again in a minute");
        const { fields, submissionId } = parseSubmission(await readBody(req), String(req.headers["content-type"] ?? ""));
        send(res, 200, { ok: true, ...(await accept(fields, submissionId)) }, cors);
        void flush();
        return;
      }
      if (url.pathname === "/hook") {
        if (req.method !== "POST") throw new HttpError(405, "POST only");
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || String(req.headers["x-baton-key"] ?? "");
        if (!auth || auth !== deps.hookSecret) throw new HttpError(401, "missing or wrong key");
        const { fields, submissionId } = parseSubmission(await readBody(req), String(req.headers["content-type"] ?? ""));
        send(res, 200, { ok: true, ...(await accept(fields, submissionId)) });
        void flush();
        return;
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`error: ${(e as Error).message}`);
      if (!res.headersSent) send(res, status, { ok: false, error: status === 500 ? "something went wrong" : (e as Error).message }, cors);
    }
  });

  const timer = setInterval(() => {
    void retryPending().then(flush);
  }, RETRY_EVERY_MS);
  timer.unref();

  return {
    server,
    /** Wait until everything in flight is saved and sent (tests and shutdown). */
    drain: async () => {
      await chain;
      await flush();
      await chain;
    },
    /** Retry leads waiting on Salesforce now (normally every minute). */
    retry: retryPending,
    stop: () => clearInterval(timer),
  };
}
