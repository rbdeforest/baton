// Installs the laptop timer as an OS background job: launchd on macOS,
// cron on Linux, Task Scheduler on Windows. Calendar-based on macOS because
// launchd's interval timer can silently stop after sleep.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface TimerSpec {
  configPath: string;
  everyMinutes: number;
  logPath: string;
}

function jobId(configPath: string): string {
  return createHash("sha256").update(resolve(configPath)).digest("hex").slice(0, 10);
}

/** The command the job runs. Uses npx when we were started from the npx cache, which can be cleared. */
export function runCommand(configPath: string, version: string): string[] {
  const script = fileURLToPath(new URL("./main.js", import.meta.url));
  const config = resolve(configPath);
  if (script.includes(`${"/"}_npx${"/"}`) || script.includes("\\_npx\\")) {
    const npx = join(dirname(process.execPath), platform() === "win32" ? "npx.cmd" : "npx");
    return [npx, "-y", `baton-router@${version}`, "run", "--config", config];
  }
  return [process.execPath, script, "run", "--config", config];
}

function launchdMinutes(every: number): string {
  if (every >= 60) {
    const hours = Math.max(1, Math.round(every / 60));
    const entries: string[] = [];
    for (let h = 0; h < 24; h += hours) entries.push(`<dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>0</integer></dict>`);
    return entries.join("");
  }
  const entries: string[] = [];
  for (let m = 0; m < 60; m += every) entries.push(`<dict><key>Minute</key><integer>${m}</integer></dict>`);
  return entries.join("");
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plistPath(id: string): string {
  return join(homedir(), "Library", "LaunchAgents", `dev.baton-router.${id}.plist`);
}

export function installTimer(spec: TimerSpec, version: string): string {
  const id = jobId(spec.configPath);
  const cmd = runCommand(spec.configPath, version);
  const os = platform();
  if (os === "darwin") {
    const path = plistPath(id);
    mkdirSync(dirname(path), { recursive: true });
    const label = `dev.baton-router.${id}`;
    writeFileSync(
      path,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${cmd.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(dirname(resolve(spec.configPath)))}</string>
<key>StartCalendarInterval</key><array>${launchdMinutes(spec.everyMinutes)}</array>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(spec.logPath)}</string>
<key>StandardErrorPath</key><string>${xml(spec.logPath)}</string>
</dict></plist>
`,
    );
    try {
      execFileSync("launchctl", ["bootout", `gui/${process.getuid!()}`, path], { stdio: "ignore" });
    } catch {
      // Not loaded yet.
    }
    execFileSync("launchctl", ["bootstrap", `gui/${process.getuid!()}`, path]);
    return `macOS background job ${label}, every ${spec.everyMinutes} min (${path})`;
  }
  if (os === "linux") {
    const marker = `# baton-router ${id}`;
    const quoted = cmd.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
    const schedule = spec.everyMinutes >= 60 ? `0 */${Math.max(1, Math.round(spec.everyMinutes / 60))} * * *` : `*/${spec.everyMinutes} * * * *`;
    const line = `${schedule} ${quoted} >> '${spec.logPath}' 2>&1 ${marker}`;
    const current = readCrontab().filter((l) => !l.endsWith(marker));
    writeCrontab([...current, line]);
    return `cron job, every ${spec.everyMinutes} min`;
  }
  if (os === "win32") {
    const name = `Baton Router ${id}`;
    const tr = cmd.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
    execFileSync("schtasks", ["/Create", "/F", "/SC", "MINUTE", "/MO", String(spec.everyMinutes), "/TN", name, "/TR", tr]);
    return `Windows scheduled task "${name}", every ${spec.everyMinutes} min`;
  }
  throw new Error(`no background job support for ${os} yet; run "baton-router run" from your own scheduler`);
}

export function uninstallTimer(configPath: string): string {
  const id = jobId(configPath);
  const os = platform();
  if (os === "darwin") {
    const path = plistPath(id);
    if (!existsSync(path)) return "no background job was installed for this baton.yaml";
    try {
      execFileSync("launchctl", ["bootout", `gui/${process.getuid!()}`, path], { stdio: "ignore" });
    } catch {
      // Already unloaded.
    }
    unlinkSync(path);
    return "background job removed";
  }
  if (os === "linux") {
    const marker = `# baton-router ${id}`;
    writeCrontab(readCrontab().filter((l) => !l.endsWith(marker)));
    return "cron job removed";
  }
  if (os === "win32") {
    execFileSync("schtasks", ["/Delete", "/F", "/TN", `Baton Router ${id}`]);
    return "scheduled task removed";
  }
  return "nothing to remove";
}

export function timerInstalled(configPath: string): boolean {
  const id = jobId(configPath);
  const os = platform();
  if (os === "darwin") return existsSync(plistPath(id));
  if (os === "linux") return readCrontab().some((l) => l.endsWith(`# baton-router ${id}`));
  if (os === "win32") {
    try {
      execFileSync("schtasks", ["/Query", "/TN", `Baton Router ${id}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function readCrontab(): string[] {
  try {
    return execFileSync("crontab", ["-l"], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function writeCrontab(lines: string[]): void {
  const tmp = join(homedir(), `.baton-crontab-${process.pid}`);
  writeFileSync(tmp, lines.join("\n") + "\n");
  try {
    execFileSync("crontab", [tmp]);
  } finally {
    unlinkSync(tmp);
  }
}
