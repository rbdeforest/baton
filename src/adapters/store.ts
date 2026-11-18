// Laptop storage: a .baton/ folder next to baton.yaml holding state, secrets,
// the decision log and the timer heartbeat. Other run places get their own store.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { emptyState, type State } from "../core/types.ts";
import type { SalesforceCredentials } from "./salesforce.ts";

export interface Secrets {
  sheet_secret?: string;
  webhook_secret?: string;
  /** Server mode: the key form tools send to /hook. */
  hook_secret?: string;
  salesforce?: SalesforceCredentials;
  /** Calendar tokens for checking open time (server mode). */
  calendly_token?: string;
  hubspot_token?: string;
}

export interface LogLine {
  at: string;
  baton_id: string;
  lead_key: string;
  email: string | null;
  status: string;
  routed_to: string | null;
  rule: string;
  reason?: string;
  /** What Salesforce knew, when it was looked up. */
  salesforce?: { account?: string; contact?: string; lead?: string };
}

export class FileStore {
  readonly dir: string;

  constructor(configPath: string) {
    this.dir = join(dirname(resolve(configPath)), ".baton");
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private readJson<T>(name: string, fallback: T): T {
    const p = this.path(name);
    if (!existsSync(p)) return fallback;
    return JSON.parse(readFileSync(p, "utf8")) as T;
  }

  /** Write to a temp file and rename, so a crash never leaves half a file. */
  private writeJson(name: string, data: unknown, mode = 0o600): void {
    this.ensureDir();
    const tmp = this.path(name + ".tmp");
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
    renameSync(tmp, this.path(name));
  }

  loadState(): State {
    return { ...emptyState(), ...this.readJson<Partial<State>>("state.json", {}) };
  }

  saveState(state: State): void {
    this.writeJson("state.json", state);
  }

  loadSecrets(): Secrets {
    return this.readJson<Secrets>("secrets.json", {});
  }

  hasSecrets(): boolean {
    return existsSync(this.path("secrets.json"));
  }

  saveSecrets(secrets: Secrets): void {
    this.writeJson("secrets.json", secrets);
  }

  appendLog(lines: LogLine[]): void {
    if (lines.length === 0) return;
    this.ensureDir();
    appendFileSync(this.path("log.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
  }

  readLog(): LogLine[] {
    const p = this.path("log.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LogLine);
  }

  writeHeartbeat(info: Record<string, unknown>): void {
    this.writeJson("heartbeat.json", info, 0o644);
  }

  readHeartbeat(): Record<string, unknown> | null {
    return this.readJson<Record<string, unknown> | null>("heartbeat.json", null);
  }

  writeFile(name: string, text: string): string {
    this.ensureDir();
    writeFileSync(this.path(name), text, { mode: 0o600 });
    return this.path(name);
  }
}
