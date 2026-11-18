// One pass of the laptop timer: retry undelivered webhooks, read new leads,
// route them, send the webhook, mark the rows. Every decision is saved before
// anything leaves the machine, so a crash mid-run never routes a lead twice.

import type { Config, CrmContext, Decision, Lead, OutboxItem, Processed, State, WebhookPayload } from "./types.ts";
import { findCompany, findEmail, findName } from "./fields.ts";
import { pruneDaily, recordAssignment, route } from "./engine.ts";
import type { MarkRow, SheetInbox } from "../adapters/sheet.ts";
import type { LogLine } from "../adapters/store.ts";

export interface RunDeps {
  config: Config;
  inbox: SheetInbox;
  deliver: (payload: WebhookPayload) => Promise<void>;
  loadState: () => State;
  saveState: (state: State) => void;
  appendLog: (lines: LogLine[]) => void;
  /** Looks the lead up in the CRM before routing, when one is connected. */
  lookup?: (lead: Lead) => Promise<CrmContext>;
  now?: () => Date;
  newId?: () => string;
}

export interface RunSummary {
  read: number;
  routed: number;
  dropped: number;
  unassigned: number;
  webhooks_sent: number;
  webhooks_waiting: number;
  marked: number;
  mark_problems: string[];
  /** Leads left for the next run because the CRM lookup failed. */
  lookup_errors: string[];
}

const MAX_PROCESSED = 10_000;

export function newBatonId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return "ld_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildPayload(lead: Lead, decision: Decision, batonId: string, at: Date): WebhookPayload {
  const rep = decision.status === "routed" ? decision.rep : null;
  return {
    baton_id: batonId,
    status: decision.status,
    lead: {
      email: findEmail(lead.fields),
      name: findName(lead.fields),
      company: findCompany(lead.fields),
      form: lead.fields,
    },
    routed_to: rep ? { name: rep.name, email: rep.email, ...(rep.booking_link ? { booking_link: rep.booking_link } : {}) } : null,
    rule: decision.rule,
    routed_at: at.toISOString(),
    ...(lead.crm
      ? {
          salesforce: {
            account: lead.crm.account ? { id: lead.crm.account.id, name: lead.crm.account.name } : null,
            contact_id: lead.crm.contact?.id ?? null,
            lead_id: lead.crm.lead?.id ?? null,
          },
        }
      : {}),
  };
}

export async function runOnce(deps: RunDeps): Promise<RunSummary> {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? newBatonId;
  const state = deps.loadState();
  const summary: RunSummary = {
    read: 0, routed: 0, dropped: 0, unassigned: 0,
    webhooks_sent: 0, webhooks_waiting: 0, marked: 0, mark_problems: [], lookup_errors: [],
  };

  // 1. Read and decide. Nothing leaves the machine until the decisions are saved.
  const leads = await deps.inbox.pending();
  summary.read = leads.length;
  const logLines: LogLine[] = [];
  for (const lead of leads) {
    if (state.processed[lead.key]) continue; // decided on an earlier run; just needs marking
    if (deps.lookup) {
      try {
        lead.crm = await deps.lookup(lead);
      } catch (e) {
        // Routing without what Salesforce knows could send an owned account to the wrong rep: wait and retry.
        summary.lookup_errors.push(`${findEmail(lead.fields) ?? lead.key}: ${(e as Error).message}`);
        continue;
      }
    }
    const at = now();
    const decision = route(deps.config, lead, state, at);
    recordAssignment(deps.config, state, decision, at);
    const batonId = newId();
    const payload = buildPayload(lead, decision, batonId, at);
    state.outbox.push({ id: batonId, payload, attempts: 0 });
    state.processed[lead.key] = {
      baton_id: batonId,
      status: decision.status,
      routed_to: decision.status === "routed" ? decision.rep.email : null,
      rule: decision.rule,
      routed_at: at.toISOString(),
      marked: false,
    };
    summary[decision.status] += 1;
    logLines.push({
      at: at.toISOString(),
      baton_id: batonId,
      lead_key: lead.key,
      email: payload.lead.email,
      status: decision.status,
      routed_to: payload.routed_to?.email ?? null,
      rule: decision.rule,
      ...(decision.status === "unassigned" ? { reason: decision.reason } : {}),
      ...(lead.crm ? { salesforce: { account: lead.crm.account?.name, contact: lead.crm.contact?.id, lead: lead.crm.lead?.id } } : {}),
    });
  }
  pruneDaily(state, now());
  trimProcessed(state);
  deps.saveState(state);
  deps.appendLog(logLines);

  // 2. Webhooks: everything waiting, oldest first. Failures stay for the next run.
  const waiting: OutboxItem[] = [];
  for (const item of state.outbox) {
    try {
      await deps.deliver(item.payload);
      summary.webhooks_sent += 1;
    } catch (e) {
      item.attempts += 1;
      item.last_error = (e as Error).message;
      waiting.push(item);
    }
  }
  state.outbox = waiting;
  summary.webhooks_waiting = waiting.length;
  deps.saveState(state);

  // 3. Mark rows in the Sheet so they aren't read again.
  const toMark: MarkRow[] = [];
  const keyByRow = new Map<number, string>();
  for (const lead of leads) {
    const p: Processed | undefined = state.processed[lead.key];
    if (!p) continue;
    // Exact duplicate rows share a key: each row still gets marked.
    const row = lead.ref;
    keyByRow.set(row, lead.key);
    toMark.push({ row, email: findEmail(lead.fields), status: p.status, routed_to: p.routed_to, rule: p.rule, routed_at: p.routed_at, baton_id: p.baton_id });
  }
  const results = await deps.inbox.mark(toMark);
  for (const r of results) {
    const key = keyByRow.get(r.row);
    if (r.ok && key) {
      state.processed[key]!.marked = true;
      summary.marked += 1;
    } else {
      summary.mark_problems.push(`row ${r.row}: ${r.error ?? "not marked"}`);
    }
  }
  deps.saveState(state);
  return summary;
}

function trimProcessed(state: State): void {
  const keys = Object.keys(state.processed);
  if (keys.length <= MAX_PROCESSED) return;
  const oldest = keys
    .filter((k) => state.processed[k]!.marked)
    .sort((a, b) => state.processed[a]!.routed_at.localeCompare(state.processed[b]!.routed_at))
    .slice(0, keys.length - MAX_PROCESSED);
  for (const k of oldest) delete state.processed[k];
}
