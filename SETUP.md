# Baton setup

You are an AI assistant setting up **Baton**, an open-source lead router, for the person you're talking with. Baton reads each new form lead, decides which rep gets it using rules the person chooses, and sends the result to a webhook so their own tools (Zapier, n8n, an agent) can act on it.

Your job is to walk them through the questions below and produce a working `baton.yaml`.

## How to run this interview

- **One question at a time.** Wait for the answer before moving on.
- **Every question has a recommended answer.** Say what you recommend and why in one line, then let them choose.
- **Never invent values.** Names, emails, numbers, field names, URLs: ask for them. If they say "you pick", use the recommended answer and say so.
- **Tell them everything is editable later.** Every answer becomes a line in `baton.yaml`. They can change it by editing the file or by pasting the setup one-liner again.
- **Can you run commands?** If you're a coding agent (Claude Code, Cursor, Codex and similar), run the commands yourself and show what they printed. If you're a chat app that can't run commands, write the files out for them and give them the exact commands to run, one at a time.
- Commands use `npx -y baton-router@latest <command>`. It needs Node.js 20 or newer (`node -v`). If Node is missing, help them install it first.

## 1. Where will Baton run?

Show this table, then ask which they want.

| | **1. We host it** | **2. You host it** | **3. Your computer** |
|---|---|---|---|
| Cost | Paid | Free (your own hosting) | Free |
| Routing speed | Instant | Instant | Every few minutes, only while the computer is on |
| Calendar pop-up after the form | Yes | Yes | No |
| Who keeps it running | Us | You | Stops while the computer sleeps |
| Effort | Least | Most (Docker) | One command |

**Today only option 3 is available.** Options 1 and 2 are coming. If they want 1 or 2, tell them plainly, and offer to set up option 3 now: the same `baton.yaml` moves to options 1 and 2 later without starting over.

## 2. Do you use a CRM?

- **Salesforce:** account and owner lookups are coming (log in through a browser tab, Baton reads who owns each account). Until then, set it up as below.
- **Any other CRM, or none:** say this clearly:

> **Baton can't look up accounts in your CRM.** It can't check who owns an account or read account fields. It routes using your form answers and round robin only. To get leads into your CRM, use the webhook: here's what you'll get for every lead.

Show them the payload from step 10.

## 3. Create the inbox (a Google Sheet)

On option 3, form leads wait in a Google Sheet until the computer picks them up. A small script pasted into the Sheet gives it a private web address. No Google login or Google Cloud project needed.

1. Ask them to create a new Google Sheet (or pick an existing one their form tool already writes to) and tell you the tab name. Recommend a new Sheet with a tab called `Leads`.
2. Make a folder for Baton (recommend `~/baton`) and run, in that folder:
   `npx -y baton-router@latest sheet-script --sheet "<tab name>"`
   This writes `.baton/baton-inbox.gs`. It contains a private secret, so tell them not to share it.
3. Walk them through, one step at a time:
   1. In the Sheet: **Extensions > Apps Script**.
   2. Delete what's in the editor, paste the whole contents of `.baton/baton-inbox.gs`, and click **Save**.
   3. Click **Deploy > New deployment**. Click the gear next to "Select type" and choose **Web app**.
   4. Set **Execute as: Me** and **Who has access: Anyone**. Click **Deploy**.
   5. Google asks them to authorize: click through (it's their own script, so "Advanced > Go to project" is expected).
   6. Copy the **Web app URL** (ends in `/exec`) and give it to you.

"Anyone" only lets forms add rows. Reading leads back out needs the secret, which only their Baton has.

## 4. How do leads get into the Sheet?

Ask which applies (both are fine):

- **Their form tool writes to Google Sheets** (Tally, Typeform, Webflow, Zapier, n8n, Google Forms): point it at the same tab. Each form field becomes a column. Ask them to submit one test entry and tell you the column names.
- **A plain HTML form on their site:** after step 11, run `npx -y baton-router@latest snippet`. It prints a `<script>` to put before `</body>`, plus one change: add `data-baton` to the `<form>` tag. Ask for the form's field names (the `name=` of each input).

Either way, you need the exact field names. Rules match on them (case, spaces and underscores don't matter).

## 5. Who gets leads?

Ask for each rep's **name** and **email**. Optional: a **booking link** (Calendly, HubSpot Meetings, Cal.com and so on). It's passed along in the webhook so their tools can send it. Give each rep a short lowercase id (`sam`, `jo`).

If someone is out right now, set `away_until: YYYY-MM-DD`.

## 6. Drop junk leads?

Dropped leads still go out the webhook, marked `dropped`, so nothing is lost.

- **Personal emails** (gmail.com, yahoo.com and so on). Recommend: yes.
- **Specific domains**, like competitors. Ask for the list. Subdomains are included.
- **Anything else**, as conditions (see step 7), for example a "student" job title.

## 7. How should leads be split?

Ask them to describe it in their own words ("companies over 1,000 employees go to the AE team, everyone else to SDRs"). Turn it into **routes**, checked top to bottom, where the first match wins. Read the routes back in plain English and confirm the order.

Each condition names a form field and one test:

| Test | Example |
|---|---|
| `equals` | `{ field: country, equals: US }` |
| `in` | `{ field: country, in: [UK, DE, FR] }` |
| `contains` | `{ field: job title, contains: VP }` |
| `gte` / `lte` | `{ field: company size, gte: 1000 }` (reads "1,000", "5k" and "51-200" as numbers; a range uses its low end) |

Use `all:` when every condition must hold and `any:` when one is enough. `email_domain` works as a field too.

A route sends leads to **one rep** (`{ rep: sam }`) or a **pool** (`{ pool: sdr }`). If a route matches but nobody in it can take the lead (away or capped), the lead goes to the fallback.

## 8. Pools

For each pool, ask:
- **Who's in it.**
- **Even or weighted?** Recommend even. Weighted is for uneven loads, for example a new rep at half: `weights: { sam: 2, jo: 1 }` gives Sam twice Jo's leads.
- **Daily cap per rep?** Recommend none to start. With a cap, a rep who hits it is skipped until tomorrow.

Fairness counts every lead a rep gets from the pool. A rep added later starts level with the others instead of getting every lead until they catch up.

## 9. Fallback

Who gets a lead that matches no route, or whose route can't take it? A rep or a pool. Recommend their main pool.

## 10. Webhook

Ask for the URL that should receive every result (a Zapier "Catch Hook", an n8n Webhook node, their own endpoint). This is how leads get into their CRM, Slack, email and anything else: Baton itself sends nothing else.

Every lead (routed, dropped or unassigned) is sent as:

```json
{
  "baton_id": "ld_3f9a1c2b7d4e5f60",
  "status": "routed",
  "lead": {
    "email": "jane@acme.com",
    "name": "Jane Doe",
    "company": "Acme",
    "form": { "every": "field the form sent" }
  },
  "routed_to": { "name": "Sam Rep", "email": "sam@theirco.com", "booking_link": "https://calendly.com/sam" },
  "rule": "route: Enterprise",
  "routed_at": "2026-11-17T18:04:11.000Z"
}
```

- `status` is `routed`, `dropped` or `unassigned`. `routed_to` is `null` unless routed.
- Each request has an `X-Baton-Signature: sha256=<hex>` header: an HMAC-SHA256 of the raw body using their webhook secret (`npx -y baton-router@latest webhook-secret` shows it). Checking it is optional but recommended.
- If the webhook is down, Baton keeps the result and retries on every run until it's delivered.

## 11. Write baton.yaml

How often should the computer check for new leads? Recommend every 5 minutes.

Write `baton.yaml` in their Baton folder. The schema is at `schema/baton.schema.json` in the package. Example:

```yaml
version: 1
run:
  mode: laptop
  every_minutes: 5
inbox:
  type: google_sheet
  script_url: https://script.google.com/macros/s/.../exec
reps:
  - { id: ana, name: Ana Ortiz, email: ana@theirco.com }
  - { id: ben, name: Ben Cole, email: ben@theirco.com, booking_link: https://calendly.com/ben }
  - { id: cy, name: Cy Park, email: cy@theirco.com }
pools:
  enterprise: { reps: [ana, ben], distribution: even }
  sdr: { reps: [cy], distribution: even }
drop:
  personal_email: true
  domains: [competitor.com]
routes:
  - name: Enterprise
    when: { all: [ { field: company size, gte: 1000 } ] }
    assign: { pool: enterprise }
fallback: { pool: sdr }
webhook:
  url: https://hooks.zapier.com/hooks/catch/...
```

Then:
1. `npx -y baton-router@latest validate`. Fix anything it reports.
2. `npx -y baton-router@latest check`. Confirms the Sheet answers.
3. Read the whole setup back in plain English: who gets what, in what order, what's dropped, where results go.

## 12. Test with made-up leads

Write 5 made-up leads that exercise their rules (one per route, one for the fallback, one that should be dropped) to `test-leads.json` as a JSON array of form fields, using their real field names. Run:

`npx -y baton-router@latest simulate --file test-leads.json`

Nothing is saved and no webhook is sent. Ask them to confirm each result is what they expect. Fix the rules until it is.

## 13. Go live

1. `npx -y baton-router@latest timer install`. It routes every few minutes whenever the computer is awake, with no window open. Remove it any time with `timer uninstall`.
2. If they use the HTML snippet, add it to the page now (step 4).
3. Ask them to submit one real test through their form, then run `npx -y baton-router@latest run` instead of waiting for the timer.
4. Check together: the Sheet row shows `baton_status`, `baton_routed_to` and `baton_rule`, and their webhook tool received the payload.

## After setup

Tell them:
- **Change anything:** edit `baton.yaml` (then `validate`), or paste the setup one-liner again.
- **Someone's out:** set `away_until` on that rep.
- **What happened:** `status` (last run, webhooks waiting, today's counts) and `log` (recent decisions).
- **Their files:** `baton.yaml` is the setup. `.baton/` holds the secrets, the counts and the log: keep it, and keep it private.
