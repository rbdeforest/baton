// Reads whether a rep has open time on their own booking page: Calendly,
// HubSpot Meetings or Cal.com. Any other booking link is shown in the pop-up
// but never checked. Anything that can't be checked counts as free, so a
// calendar problem never stops a lead from routing.

export type Provider = "calendly" | "hubspot" | "calcom" | "link";

export interface BookingPage {
  provider: Provider;
  url: string;
  /** calendly: the page URL itself; hubspot: the link slug; calcom: username + event slug. */
  slug?: string;
  username?: string;
  event?: string;
}

export interface CalendarTokens {
  calendly_token?: string;
  hubspot_token?: string;
}

export function parseBookingLink(link: string): BookingPage {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return { provider: "link", url: link };
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "calendly.com" && parts.length >= 1) return { provider: "calendly", url: link };
  if (/^meetings(-[a-z0-9]+)?\.hubspot\.com$/.test(host) && parts.length >= 1) {
    return { provider: "hubspot", url: link, slug: parts.join("/") };
  }
  if (host === "cal.com" && parts.length >= 2) return { provider: "calcom", url: link, username: parts[0]!, event: parts[1]! };
  return { provider: "link", url: link };
}

/** The booking page with the lead's name and email filled in, ready for the pop-up. */
export function prefilledUrl(page: BookingPage, name: string | null, email: string | null): string {
  let u: URL;
  try {
    u = new URL(page.url);
  } catch {
    return page.url;
  }
  const [first, ...rest] = (name ?? "").trim().split(/\s+/);
  const set = (k: string, v: string | null | undefined) => {
    if (v) u.searchParams.set(k, v);
  };
  if (page.provider === "hubspot") {
    u.searchParams.set("embed", "true");
    set("firstName", first);
    set("lastName", rest.join(" "));
    set("email", email);
  } else if (page.provider === "calendly" || page.provider === "calcom") {
    set("name", name);
    set("email", email);
  }
  return u.toString();
}

/** True if open, false if booked up, null if it couldn't be checked. */
export type Availability = boolean | null;

const TIMEOUT_MS = 2500;

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetchImpl(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export class CalendarChecker {
  private tokens: CalendarTokens;
  private fetchImpl: typeof fetch;
  private cache = new Map<string, { value: Availability; at: number }>();
  private calendlyTypes: Map<string, string> | null = null;
  private cacheMs: number;
  now: () => number = () => Date.now();

  constructor(tokens: CalendarTokens, fetchImpl: typeof fetch = fetch, cacheMinutes = 5) {
    this.tokens = tokens;
    this.fetchImpl = fetchImpl;
    this.cacheMs = cacheMinutes * 60_000;
  }

  /** Open time in the next `days` days? Cached for a few minutes per page. */
  async isFree(link: string, days: number): Promise<Availability> {
    const page = parseBookingLink(link);
    if (page.provider === "link") return null;
    const key = `${link}|${days}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.cacheMs) return hit.value;
    let value: Availability;
    try {
      value = await this.check(page, days);
    } catch {
      value = null;
    }
    this.cache.set(key, { value, at: this.now() });
    return value;
  }

  private async check(page: BookingPage, days: number): Promise<Availability> {
    const start = new Date(this.now() + 60_000);
    const end = new Date(start.getTime() + days * 86_400_000);
    if (page.provider === "calcom") {
      const q = new URLSearchParams({ username: page.username!, eventSlug: page.event!, startTime: start.toISOString(), endTime: end.toISOString() });
      const body = await getJson(this.fetchImpl, `https://api.cal.com/v2/slots?${q}`, { "cal-api-version": "2024-09-04" });
      // Slots come grouped by day, either under data.slots or directly under data.
      const byDay = body?.data?.slots ?? body?.data ?? {};
      return Object.values(byDay).some((v) => Array.isArray(v) && v.length > 0);
    }
    if (page.provider === "hubspot") {
      if (!this.tokens.hubspot_token) return null;
      const body = await getJson(
        this.fetchImpl,
        `https://api.hubapi.com/scheduler/2026-03/meetings/meeting-links/book/availability-page/${encodeURIComponent(page.slug!)}?timezone=UTC`,
        { Authorization: `Bearer ${this.tokens.hubspot_token}` },
      );
      const byDuration = body?.linkAvailability?.linkAvailabilityByDuration ?? {};
      for (const d of Object.values(byDuration) as { availabilities?: { startMillisUtc: number }[] }[]) {
        if ((d.availabilities ?? []).some((a) => a.startMillisUtc >= start.getTime() && a.startMillisUtc <= end.getTime())) return true;
      }
      return false;
    }
    // Calendly: find the event type behind the page, then ask for open times (7 days per call at most).
    if (!this.tokens.calendly_token) return null;
    const auth = { Authorization: `Bearer ${this.tokens.calendly_token}` };
    const eventType = await this.calendlyEventType(page.url, auth);
    if (!eventType) return null;
    for (let from = start; from < end; from = new Date(from.getTime() + 7 * 86_400_000)) {
      const to = new Date(Math.min(end.getTime(), from.getTime() + 7 * 86_400_000));
      const q = new URLSearchParams({ event_type: eventType, start_time: from.toISOString(), end_time: to.toISOString() });
      const body = await getJson(this.fetchImpl, `https://api.calendly.com/event_type_available_times?${q}`, auth);
      if ((body?.collection ?? []).length > 0) return true;
    }
    return false;
  }

  /** Booking page URL -> Calendly event type URI, from every event type the token can see. */
  private async calendlyEventType(pageUrl: string, auth: Record<string, string>): Promise<string | null> {
    if (!this.calendlyTypes) {
      const types = new Map<string, string>();
      const me = await getJson(this.fetchImpl, "https://api.calendly.com/users/me", auth);
      const org = me?.resource?.current_organization;
      const user = me?.resource?.uri;
      // An admin's token sees the whole organization; anyone else's sees only their own pages.
      const scopes = [org ? `organization=${encodeURIComponent(org)}` : null, user ? `user=${encodeURIComponent(user)}` : null].filter(Boolean);
      for (const scope of scopes) {
        try {
          let next: string | null = `https://api.calendly.com/event_types?${scope}&active=true&count=100`;
          while (next) {
            const body: any = await getJson(this.fetchImpl, next, auth);
            for (const t of body?.collection ?? []) if (t.scheduling_url) types.set(normalizePage(t.scheduling_url), t.uri);
            next = body?.pagination?.next_page ?? null;
          }
        } catch {
          // Not an admin: the organization listing is refused; the user listing still works.
        }
      }
      this.calendlyTypes = types;
    }
    return this.calendlyTypes.get(normalizePage(pageUrl)) ?? null;
  }
}

function normalizePage(url: string): string {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
