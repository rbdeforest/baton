#!/usr/bin/env node
// baton-router command line. SETUP.md tells the AI tool which of these to run.

import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, parseConfig } from "../core/config.ts";
import { localDate, recordAssignment, route } from "../core/engine.ts";
import { buildPayload, runOnce } from "../core/run.ts";
import { emptyState, type Config, type Lead } from "../core/types.ts";
import { SheetInbox } from "../adapters/sheet.ts";
import { FileStore } from "../adapters/store.ts";
import { deliver } from "../adapters/webhook.ts";
import { installTimer, timerInstalled, uninstallTimer } from "./timer.ts";
import { connectSalesforce } from "./connect.ts";
import { API_VERSION, DEFAULT_CLIENT_ID, SalesforceClient, lookup } from "../adapters/salesforce.ts";
import { findEmail } from "../core/fields.ts";
import { createBatonServer } from "../server/server.ts";
import { CalendarChecker, parseBookingLink } from "../adapters/calendars.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VERSION = (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }).version;

const HELP = `baton-router ${VERSION}: open-source lead router

  validate                 Check baton.yaml
  simulate --lead JSON     Route made-up leads without saving anything
           --file FILE     (a JSON array of form-field objects)
  sheet-script [--sheet N] Write the Apps Script to paste into your Google Sheet
  webhook-secret           Show the secret that signs webhooks (X-Baton-Signature)
  snippet                  Print the form snippet with your inbox URL filled in
  check                    Validate and make sure the Sheet answers
  run                      Route new leads once (what the timer runs)
  timer install|uninstall|status
  status                   Last run, today's counts, webhooks waiting
  log [--n 20]             Recent routing decisions

  serve                    Run Baton as an always-on server (server mode)
  hook-secret              The key form tools send to /hook (server mode)
  secrets export           One line to copy the logins onto a new server
                           (set it as BATON_SECRETS there; used once)
  config export            baton.yaml as one line, for BATON_YAML_B64 on
                           hosts like Render (edit there to change rules)

  calendar token calendly|hubspot TOKEN
                           Save a token so Baton can check reps' open time
  calendar check           Each rep's booking page and whether it has open time

  connect salesforce       Log in to Salesforce in your browser
           [--login-url URL]  (sandbox: https://test.salesforce.com)
  salesforce check         Who Baton is logged in as
  salesforce users         Active users, to pick reps from
  salesforce fields        Account fields rules can use
  salesforce lookup EMAIL  What Baton finds in Salesforce for one email

  --config PATH            baton.yaml to use (default: ./baton.yaml)`;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * baton.yaml, or on hosts where files can't be handed over (deploy buttons),
 * the whole file from the BATON_YAML_B64 setting, which always wins.
 */
function loadConfig(path: string): Config {
  if (process.env.BATON_YAML_B64) return parseConfig(Buffer.from(process.env.BATON_YAML_B64, "base64").toString("utf8"));
  if (!existsSync(path)) throw new Error(`no baton.yaml at ${resolve(path)}. Run setup first (see SETUP.md).`);
  return parseConfig(readFileSync(path, "utf8"));
}

function salesforceClient(store: FileStore): SalesforceClient {
  const creds = store.loadSecrets().salesforce;
  if (!creds) throw new Error("not connected to Salesforce yet. Run: baton-router connect salesforce");
  return new SalesforceClient(creds, (next) => store.saveSecrets({ ...store.loadSecrets(), salesforce: next }));
}

function crmLookup(config: Config, store: FileStore): ((lead: Lead) => ReturnType<typeof lookup>) | undefined {
  if (config.crm?.type !== "salesforce") return undefined;
  const client = salesforceClient(store);
  const crm = config.crm;
  return (lead) => lookup(client, crm, findEmail(lead.fields));
}

/** The laptop's Google Sheet inbox, or a clear error in server mode. */
function laptopOnly(config: Config, command: string): { script_url: string; every_minutes: number } {
  if (config.run.mode !== "laptop" || !config.inbox) {
    throw new Error(`"${command}" is for the laptop version. This baton.yaml runs as a server: use "baton-router serve".`);
  }
  return { script_url: config.inbox.script_url, every_minutes: config.run.every_minutes };
}

function requireSecret(store: FileStore, name: "sheet_secret" | "webhook_secret", fix: string): string {
  const value = store.loadSecrets()[name];
  if (!value) throw new Error(`no ${name.replace("_", " ")} yet. Run: baton-router ${fix}`);
  return value;
}

function ensureSecret(store: FileStore, name: "sheet_secret" | "webhook_secret" | "hook_secret"): string {
  const secrets = store.loadSecrets();
  if (!secrets[name]) {
    secrets[name] = randomSecret();
    store.saveSecrets(secrets);
  }
  return secrets[name]!;
}

/** One run at a time; a lock older than 10 minutes is from a crashed run. */
function withLock<T>(store: FileStore, fn: () => Promise<T>): Promise<T | null> {
  const path = join(store.dir, "run.lock");
  if (existsSync(path) && Date.now() - statSync(path).mtimeMs > 10 * 60_000) unlinkSync(path);
  let fd: number;
  try {
    store.writeFile(".keep", "");
    fd = openSync(path, "wx");
  } catch {
    return Promise.resolve(null);
  }
  writeSync(fd, String(process.pid));
  closeSync(fd);
  return fn().finally(() => unlinkSync(path));
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const configPath = arg(args, "--config") ?? process.env.BATON_CONFIG ?? "baton.yaml";
  const store = new FileStore(configPath);

  switch (cmd) {
    case "validate": {
      const config = loadConfig(configPath);
      console.log(`baton.yaml is valid: ${config.reps.length} rep(s), ${Object.keys(config.pools ?? {}).length} pool(s), ${(config.routes ?? []).length} route(s).`);
      return 0;
    }

    case "simulate": {
      const config = loadConfig(configPath);
      const raw = arg(args, "--lead") ?? (arg(args, "--file") ? readFileSync(arg(args, "--file")!, "utf8") : undefined);
      if (!raw) throw new Error("give --lead '{\"email\":\"...\"}' or --file leads.json");
      const parsed = JSON.parse(raw) as Record<string, unknown> | Record<string, unknown>[];
      const list = Array.isArray(parsed) ? parsed : [parsed];
      // Start from the real counts so the answer matches what would happen next.
      const state = existsSync(join(store.dir, "state.json")) ? store.loadState() : emptyState();
      const now = new Date();
      const crm = crmLookup(config, store);
      for (const [i, fields] of list.entries()) {
        const strFields = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)]));
        const lead: Lead = { key: `simulate:${i}`, ref: i, fields: strFields };
        if (crm) lead.crm = await crm(lead);
        const decision = route(config, lead, state, now);
        recordAssignment(config, state, decision, now);
        const p = buildPayload(lead, decision, "ld_simulated", now);
        const who = p.routed_to ? `${p.routed_to.name} <${p.routed_to.email}>` : "nobody";
        const why = decision.status === "unassigned" ? ` (${decision.reason})` : "";
        const sf = lead.crm ? `  (Salesforce: ${lead.crm.account ? `account ${lead.crm.account.name}` : "no account"}${lead.crm.contact ? ", contact" : ""}${lead.crm.lead ? ", lead" : ""})` : "";
        console.log(`${i + 1}. ${p.lead.email ?? "(no email)"} -> ${decision.status}: ${who}  [${decision.rule}]${why}${sf}`);
      }
      console.log("\nSimulated only: nothing saved, no webhook sent, nothing written to Salesforce.");
      return 0;
    }

    case "sheet-script": {
      const secret = ensureSecret(store, "sheet_secret");
      const template = readFileSync(join(PACKAGE_ROOT, "apps-script", "baton-inbox.gs"), "utf8");
      const sheet = arg(args, "--sheet") ?? "";
      const script = template.replace("__BATON_SECRET__", secret).replace("__SHEET_NAME__", sheet.replace(/'/g, "\\'"));
      const path = store.writeFile("baton-inbox.gs", script);
      console.log(`Apps Script written to ${path}\n(It contains your private Sheet secret: don't share it.)`);
      return 0;
    }

    case "webhook-secret": {
      console.log(ensureSecret(store, "webhook_secret"));
      return 0;
    }

    case "snippet": {
      const config = loadConfig(configPath);
      const target = config.run.mode === "server" ? `${config.server!.public_url.replace(/\/$/, "")}/lead` : laptopOnly(config, "snippet").script_url;
      const js = readFileSync(join(PACKAGE_ROOT, "snippet", "baton.js"), "utf8")
        .replace("__BATON_INBOX__", target)
        .replace('"__BATON_MODE__"', JSON.stringify(config.run.mode));
      console.log(`<!-- Baton: add data-baton to the <form> tag, and put this before </body> -->\n<script>\n${js.trim()}\n</script>`);
      return 0;
    }

    case "check": {
      const config = loadConfig(configPath);
      const inbox = new SheetInbox(laptopOnly(config, "check").script_url, requireSecret(store, "sheet_secret", "sheet-script"));
      const sheet = await inbox.ping();
      ensureSecret(store, "webhook_secret");
      console.log(`baton.yaml is valid and the Google Sheet answers (tab "${sheet}").`);
      return 0;
    }

    case "run": {
      const config = loadConfig(configPath);
      const inbox = new SheetInbox(laptopOnly(config, "run").script_url, requireSecret(store, "sheet_secret", "sheet-script"));
      const webhookSecret = ensureSecret(store, "webhook_secret");
      const startedAt = new Date().toISOString();
      const summary = await withLock(store, () =>
        runOnce({
          config,
          inbox,
          deliver: (payload) => deliver(config.webhook.url, webhookSecret, payload),
          loadState: () => store.loadState(),
          saveState: (s) => store.saveState(s),
          appendLog: (lines) => store.appendLog(lines),
          lookup: crmLookup(config, store),
        }),
      ).catch((e: unknown) => {
        store.writeHeartbeat({ last_run: startedAt, error: (e as Error).message });
        throw e;
      });
      if (!summary) {
        console.log(`${startedAt} another run is still going; skipped.`);
        return 0;
      }
      store.writeHeartbeat({ last_run: startedAt, ...summary });
      console.log(
        `${startedAt} read ${summary.read}, routed ${summary.routed}, dropped ${summary.dropped}, unassigned ${summary.unassigned}, ` +
          `webhooks sent ${summary.webhooks_sent} (waiting ${summary.webhooks_waiting}), rows marked ${summary.marked}`,
      );
      for (const p of summary.mark_problems) console.log(`  could not mark ${p}`);
      for (const p of summary.lookup_errors) console.log(`  waiting for next run, Salesforce lookup failed for ${p}`);
      return 0;
    }

    case "timer": {
      const sub = args[0];
      if (sub === "install") {
        const { every_minutes } = laptopOnly(loadConfig(configPath), "timer install");
        requireSecret(store, "sheet_secret", "sheet-script");
        store.writeFile(".keep", "");
        console.log("Installed: " + installTimer({ configPath, everyMinutes: every_minutes, logPath: join(store.dir, "timer.log") }, VERSION));
        console.log("It runs whenever this computer is awake. Remove it with: baton-router timer uninstall");
        return 0;
      }
      if (sub === "uninstall") {
        console.log(uninstallTimer(configPath));
        return 0;
      }
      if (sub === "status") {
        console.log(timerInstalled(configPath) ? "Background job is installed." : "No background job installed.");
        return 0;
      }
      throw new Error("use: timer install | timer uninstall | timer status");
    }

    case "status": {
      const beat = store.readHeartbeat();
      const state = store.loadState();
      if (!beat) console.log("No runs yet.");
      else if (beat.error) console.log(`Last run: ${beat.last_run} FAILED: ${beat.error}`);
      else console.log(`Last run: ${beat.last_run} (read ${beat.read}, routed ${beat.routed})`);
      console.log(`Background job: ${timerInstalled(configPath) ? "installed" : "not installed"}`);
      console.log(`Webhooks waiting to send: ${state.outbox.length}${state.outbox[0]?.last_error ? ` (last error: ${state.outbox[0].last_error})` : ""}`);
      const today = state.daily[localDate(new Date())] ?? {};
      for (const [pool, reps] of Object.entries(today)) {
        console.log(`Today in ${pool}: ${Object.entries(reps).map(([r, n]) => `${r} ${n}`).join(", ")}`);
      }
      return 0;
    }

    case "log": {
      const n = Number(arg(args, "--n") ?? 20);
      for (const l of store.readLog().slice(-n)) {
        console.log(`${l.at}  ${l.email ?? "(no email)"} -> ${l.status}${l.routed_to ? ` ${l.routed_to}` : ""}  [${l.rule}]${l.reason ? ` (${l.reason})` : ""}`);
      }
      return 0;
    }

    case "serve": {
      const config = loadConfig(configPath);
      if (config.run.mode !== "server" || !config.server) throw new Error('baton.yaml must have run: { mode: server } and a server section to use "serve"');
      // A new server gets its logins once from BATON_SECRETS; after that the saved copy wins,
      // because Salesforce replaces its login key on every refresh.
      if (!store.hasSecrets() && process.env.BATON_SECRETS) {
        store.saveSecrets(JSON.parse(Buffer.from(process.env.BATON_SECRETS, "base64").toString("utf8")));
        console.log("Saved the logins from BATON_SECRETS. You can remove that setting now.");
      }
      const webhookSecret = ensureSecret(store, "webhook_secret");
      const { server, drain, stop } = createBatonServer({
        config,
        hookSecret: ensureSecret(store, "hook_secret"),
        loadState: () => store.loadState(),
        saveState: (s) => store.saveState(s),
        appendLog: (lines) => store.appendLog(lines),
        deliver: (payload) => deliver(config.webhook.url, webhookSecret, payload),
        lookup: crmLookup(config, store),
        calendars: new CalendarChecker(store.loadSecrets()),
        version: VERSION,
      });
      const port = Number(process.env.PORT ?? arg(args, "--port") ?? 8080);
      server.listen(port, "0.0.0.0", () => {
        console.log(`Baton ${VERSION} is running on port ${port}. Forms post to ${config.server!.public_url.replace(/\/$/, "")}/lead; form tools to /hook.`);
        console.log(`Saving data in ${store.dir}: this folder must survive restarts.`);
      });
      await new Promise<void>((resolve) => {
        const shutdown = () => {
          stop();
          server.close();
          drain().finally(resolve);
        };
        process.once("SIGTERM", shutdown);
        process.once("SIGINT", shutdown);
      });
      return 0;
    }

    case "hook-secret": {
      const config = loadConfig(configPath);
      const url = config.server ? `${config.server.public_url.replace(/\/$/, "")}/hook` : "(your Baton address)/hook";
      console.log(`Send leads to: POST ${url}\nWith header: Authorization: Bearer ${ensureSecret(store, "hook_secret")}`);
      return 0;
    }

    case "config": {
      if (args[0] !== "export") throw new Error("use: config export");
      loadConfig(configPath);
      console.log(Buffer.from(readFileSync(configPath, "utf8")).toString("base64"));
      return 0;
    }

    case "secrets": {
      if (args[0] !== "export") throw new Error("use: secrets export");
      ensureSecret(store, "webhook_secret");
      ensureSecret(store, "hook_secret");
      console.log(Buffer.from(JSON.stringify(store.loadSecrets())).toString("base64"));
      return 0;
    }

    case "calendar": {
      const sub = args[0];
      if (sub === "token") {
        const which = args[1];
        const token = args[2];
        if ((which !== "calendly" && which !== "hubspot") || !token) throw new Error("use: calendar token calendly|hubspot TOKEN");
        store.saveSecrets({ ...store.loadSecrets(), [`${which}_token`]: token });
        console.log(`Saved the ${which === "calendly" ? "Calendly" : "HubSpot"} token.`);
        return 0;
      }
      if (sub === "check") {
        const config = loadConfig(configPath);
        const checker = new CalendarChecker(store.loadSecrets());
        const days = config.calendar?.days_ahead ?? 5;
        for (const rep of config.reps) {
          if (!rep.booking_link) {
            console.log(`${rep.name}: no booking link`);
            continue;
          }
          const page = parseBookingLink(rep.booking_link);
          const free = await checker.isFree(rep.booking_link, days);
          const status = page.provider === "link" ? "not checked (pop-up only)" : free === null ? "couldn't check (counts as free)" : free ? `open time in the next ${days} days` : `no open time in the next ${days} days`;
          console.log(`${rep.name}: ${page.provider}, ${status}`);
        }
        return 0;
      }
      throw new Error("use: calendar token calendly|hubspot TOKEN | calendar check");
    }

    case "connect": {
      if (args[0] !== "salesforce") throw new Error("use: connect salesforce");
      const loginUrl = arg(args, "--login-url") ?? "https://login.salesforce.com";
      const clientId = arg(args, "--client-id") ?? DEFAULT_CLIENT_ID;
      if (!clientId) throw new Error("no Salesforce app yet: pass --client-id");
      const creds = await connectSalesforce(loginUrl, clientId);
      store.saveSecrets({ ...store.loadSecrets(), salesforce: creds });
      console.log(`Connected to Salesforce as ${creds.username ?? "(unknown user)"} (${creds.instance_url}). Baton stays connected; it only reads.`);
      return 0;
    }

    case "salesforce": {
      const client = salesforceClient(store);
      const sub = args[0];
      if (sub === "check") {
        const r = await client.query<{ Name: string; OrganizationType: string }>("SELECT Name, OrganizationType FROM Organization");
        const c = client.connection;
        console.log(`Connected as ${c.username ?? "(unknown)"} to "${r.records[0]?.Name}" (${r.records[0]?.OrganizationType}), ${c.instance_url}`);
        return 0;
      }
      if (sub === "users") {
        const r = await client.query<{ Name: string; Email: string; Title: string | null }>(
          "SELECT Name, Email, Title FROM User WHERE IsActive = true AND UserType = 'Standard' ORDER BY Name LIMIT 500",
        );
        for (const u of r.records) console.log(`${u.Name}\t${u.Email}${u.Title ? `\t${u.Title}` : ""}`);
        return 0;
      }
      if (sub === "fields") {
        const d = await client.request<{ fields: { name: string; label: string; type: string }[] }>(`/services/data/${API_VERSION}/sobjects/Account/describe`);
        for (const f of d.fields) console.log(`${f.name}\t${f.label}\t${f.type}`);
        return 0;
      }
      if (sub === "lookup") {
        const email = args[1];
        if (!email) throw new Error("use: salesforce lookup someone@company.com");
        const config = existsSync(configPath) ? loadConfig(configPath) : undefined;
        const ctx = await lookup(client, config?.crm ?? { type: "salesforce" }, email);
        console.log(JSON.stringify(ctx, null, 2));
        console.log(`(${client.calls} Salesforce API call${client.calls === 1 ? "" : "s"})`);
        return 0;
      }
      throw new Error("use: salesforce check | users | fields | lookup EMAIL");
    }

    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;

    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;

    default:
      console.error(`unknown command "${cmd}"\n\n${HELP}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof ConfigError) console.error(e.message);
    else console.error(`baton-router: ${(e as Error).message}`);
    process.exit(1);
  },
);
