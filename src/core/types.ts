// The shape of baton.yaml. schema/baton.schema.json is the published contract;
// keep the two in sync (test/schema.test.ts checks the examples against both).

export type Scalar = string | number | boolean;

export interface Condition {
  field: string;
  equals?: Scalar;
  in?: Scalar[];
  contains?: string;
  gte?: number;
  lte?: number;
}

/** Every condition in `all` must hold, and at least one in `any` (when given). */
export interface When {
  all?: Condition[];
  any?: Condition[];
}

/** Which Salesforce record's owner to try, in order. */
export type OwnerSource = "account" | "contact" | "lead";

export type Target =
  | { rep: string }
  | { pool: string }
  | {
      owner: OwnerSource[];
      /** The owner isn't one of your reps: send it to them anyway, or skip to the next route. */
      if_not_rep: "route_to_owner" | "skip";
    };

export interface Rep {
  id: string;
  name: string;
  email: string;
  booking_link?: string;
  /** Skipped by pools until the end of this date (YYYY-MM-DD, local time). */
  away_until?: string;
}

export interface Pool {
  reps: string[];
  distribution: "even" | "weighted";
  /** Only for weighted pools. A rep with weight 2 gets twice the leads of weight 1. */
  weights?: Record<string, number>;
  /** Most leads one rep gets from this pool per day. */
  daily_cap?: number;
}

export interface DropRule {
  name: string;
  when: When;
}

export interface Route {
  name: string;
  when?: When;
  assign: Target;
}

export interface Config {
  version: 1;
  run: { mode: "laptop"; every_minutes: number };
  inbox: { type: "google_sheet"; script_url: string };
  reps: Rep[];
  pools?: Record<string, Pool>;
  drop?: { personal_email?: boolean; domains?: string[]; rules?: DropRule[] };
  routes?: Route[];
  fallback: Target;
  webhook: { url: string };
  crm?: SalesforceConfig;
}

export interface SalesforceConfig {
  type: "salesforce";
  /** Account field holding the company's website or domain. */
  account_domain_field?: string;
  /** Account fields rules can use, as account.<Field>. */
  account_fields?: string[];
  /** Several accounts share the lead's domain: use the oldest or newest. */
  multiple_accounts?: "oldest" | "newest";
}

export interface CrmOwner {
  id: string;
  name: string;
  email: string | null;
  active: boolean;
  /** False for queues. */
  is_user: boolean;
}

/** What Salesforce already knows about a lead, looked up just before routing. */
export interface CrmContext {
  account?: { id: string; name: string; fields: Record<string, string>; owner?: CrmOwner };
  contact?: { id: string; owner?: CrmOwner };
  lead?: { id: string; owner?: CrmOwner };
}

/** One form submission, as read from the inbox. */
export interface Lead {
  /** Stable key: the same submission always gets the same key, even if the Sheet is re-sorted. */
  key: string;
  /** Where the inbox keeps it right now (for the Sheet: the row number). */
  ref: number;
  fields: Record<string, string>;
  crm?: CrmContext;
}

export type Decision =
  | { status: "routed"; rep: Rep; pool?: string; rule: string }
  | { status: "dropped"; rule: string }
  | { status: "unassigned"; rule: string; reason: string };

export interface PoolCounter {
  count: number;
  last_at?: string;
}

/** Everything Baton remembers between runs. */
export interface State {
  /** pool -> rep -> running count, for fairness. */
  pools: Record<string, Record<string, PoolCounter>>;
  /** YYYY-MM-DD -> pool -> rep -> leads that day, for daily caps. */
  daily: Record<string, Record<string, Record<string, number>>>;
  /** lead key -> what was decided, so a lead is never routed twice. */
  processed: Record<string, Processed>;
  /** Webhook payloads not yet delivered. */
  outbox: OutboxItem[];
}

export interface Processed {
  baton_id: string;
  status: Decision["status"];
  routed_to: string | null;
  rule: string;
  routed_at: string;
  marked: boolean;
}

export interface OutboxItem {
  id: string;
  payload: WebhookPayload;
  attempts: number;
  last_error?: string;
}

export interface WebhookPayload {
  baton_id: string;
  status: Decision["status"];
  lead: {
    email: string | null;
    name: string | null;
    company: string | null;
    form: Record<string, string>;
  };
  routed_to: { name: string; email: string; booking_link?: string } | null;
  rule: string;
  routed_at: string;
  /** Only when Salesforce is connected: the records Baton found, so your tools can update them. */
  salesforce?: {
    account: { id: string; name: string } | null;
    contact_id: string | null;
    lead_id: string | null;
  };
}

export function emptyState(): State {
  return { pools: {}, daily: {}, processed: {}, outbox: [] };
}
