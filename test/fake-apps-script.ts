// Runs the real apps-script/baton-inbox.gs against an in-memory Google Sheet,
// and exposes it as a fetch() so SheetInbox can talk to it like the real thing.

import { readFileSync } from "node:fs";
import vm from "node:vm";

export function fakeAppsScript(secret: string) {
  const grid: unknown[][] = [];
  const width = () => Math.max(0, ...grid.map((r) => r.length));
  const cell = (r: number, c: number) => grid[r - 1]?.[c - 1] ?? "";
  const set = (r: number, c: number, v: unknown) => {
    while (grid.length < r) grid.push([]);
    const row = grid[r - 1]!;
    while (row.length < c) row.push("");
    row[c - 1] = v;
  };
  const sheet = {
    getName: () => "Leads",
    getLastColumn: () => width(),
    getLastRow: () => grid.length,
    appendRow: (values: unknown[]) => grid.push([...values]),
    getRange: (r: number, c: number, nr = 1, nc = 1) => ({
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j))),
      setValues: (vals: unknown[][]) => vals.forEach((row, i) => row.forEach((v, j) => set(r + i, c + j, v))),
      getValue: () => cell(r, c),
      setValue: (v: unknown) => set(r, c, v),
    }),
  };
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheets: () => [sheet], getSheetByName: () => sheet, insertSheet: () => sheet }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (text: string) => ({ text, setMimeType() { return this; } }) },
    Date,
    JSON,
    String,
    Number,
  });
  const source = readFileSync(new URL("../apps-script/baton-inbox.gs", import.meta.url), "utf8")
    .replace("__BATON_SECRET__", secret);
  vm.runInContext(source, context);

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const parameter = Object.fromEntries(url.searchParams);
    const out = (init?.method ?? "GET") === "GET"
      ? context.doGet({ parameter })
      : context.doPost({ parameter, postData: { contents: String(init?.body ?? "") } });
    return new Response(out.text, { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  /** What a visitor's browser does when Baton's snippet fires. */
  const submit = (fields: Record<string, string>) => context.doPost({ parameter: {}, postData: { contents: JSON.stringify({ fields }) } });
  return { fetchImpl, submit, grid };
}
