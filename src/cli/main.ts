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

  --config PATH            baton.yaml to use (default: ./baton.yaml)`;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function loadConfig(path: string): Config {
  if (!existsSync(path)) throw new Error(`no baton.yaml at ${resolve(path)}. Run setup first (see SETUP.md).`);
  return parseConfig(readFileSync(path, "utf8"));
}

function requireSecret(store: FileStore, name: "sheet_secret" | "webhook_secret", fix: string): string {
  const value = store.loadSecrets()[name];
  if (!value) throw new Error(`no ${name.replace("_", " ")} yet. Run: baton-router ${fix}`);
  return value;
}

function ensureSecret(store: FileStore, name: "sheet_secret" | "webhook_secret"): string {
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
      list.forEach((fields, i) => {
        const strFields = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)]));
        const lead: Lead = { key: `simulate:${i}`, ref: i, fields: strFields };
        const decision = route(config, lead, state, now);
        recordAssignment(config, state, decision, now);
        const p = buildPayload(lead, decision, "ld_simulated", now);
        const who = p.routed_to ? `${p.routed_to.name} <${p.routed_to.email}>` : "nobody";
        const why = decision.status === "unassigned" ? ` (${decision.reason})` : "";
        console.log(`${i + 1}. ${p.lead.email ?? "(no email)"} -> ${decision.status}: ${who}  [${decision.rule}]${why}`);
      });
      console.log("\nSimulated only: nothing saved, no webhook sent.");
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
      const js = readFileSync(join(PACKAGE_ROOT, "snippet", "baton.js"), "utf8").replace("__BATON_INBOX__", config.inbox.script_url);
      console.log(`<!-- Baton: add data-baton to the <form> tag, and put this before </body> -->\n<script>\n${js.trim()}\n</script>`);
      return 0;
    }

    case "check": {
      const config = loadConfig(configPath);
      const inbox = new SheetInbox(config.inbox.script_url, requireSecret(store, "sheet_secret", "sheet-script"));
      const sheet = await inbox.ping();
      ensureSecret(store, "webhook_secret");
      console.log(`baton.yaml is valid and the Google Sheet answers (tab "${sheet}").`);
      return 0;
    }

    case "run": {
      const config = loadConfig(configPath);
      const inbox = new SheetInbox(config.inbox.script_url, requireSecret(store, "sheet_secret", "sheet-script"));
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
      return 0;
    }

    case "timer": {
      const sub = args[0];
      if (sub === "install") {
        const config = loadConfig(configPath);
        requireSecret(store, "sheet_secret", "sheet-script");
        store.writeFile(".keep", "");
        console.log("Installed: " + installTimer({ configPath, everyMinutes: config.run.every_minutes, logPath: join(store.dir, "timer.log") }, VERSION));
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
