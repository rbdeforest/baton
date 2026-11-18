// Parse and check baton.yaml: first against the published schema, then the
// cross-references a schema can't express (pools naming real reps, and so on).

import { parse } from "yaml";
import { Ajv } from "ajv";
import schema from "../../schema/baton.schema.json" with { type: "json" };
import type { Config, Target } from "./types.ts";

const validateSchema = new Ajv({ allErrors: true, allowUnionTypes: true }).compile(schema);

export class ConfigError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`baton.yaml has ${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
    this.problems = problems;
  }
}

export function parseConfig(text: string): Config {
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    throw new ConfigError([`not valid YAML: ${(e as Error).message}`]);
  }
  if (!validateSchema(data)) {
    const problems = (validateSchema.errors ?? []).map(
      (e) => `${e.instancePath || "(top level)"} ${e.message}${e.params && "allowedValues" in e.params ? `: ${(e.params.allowedValues as unknown[]).join(", ")}` : ""}`,
    );
    throw new ConfigError(problems);
  }
  const config = data as unknown as Config;
  const problems = crossCheck(config);
  if (problems.length) throw new ConfigError(problems);
  return config;
}

function crossCheck(config: Config): string[] {
  const problems: string[] = [];
  const repIds = new Set<string>();
  for (const r of config.reps) {
    if (repIds.has(r.id)) problems.push(`rep id "${r.id}" is used twice`);
    repIds.add(r.id);
  }
  const pools = config.pools ?? {};
  for (const [id, pool] of Object.entries(pools)) {
    for (const rep of pool.reps) {
      if (!repIds.has(rep)) problems.push(`pool "${id}" lists rep "${rep}", who isn't in reps`);
    }
    for (const rep of Object.keys(pool.weights ?? {})) {
      if (!pool.reps.includes(rep)) problems.push(`pool "${id}" has a weight for "${rep}", who isn't in that pool`);
    }
    if (pool.distribution === "weighted" && !pool.weights) problems.push(`pool "${id}" is weighted but has no weights`);
  }
  const checkTarget = (t: Target, where: string) => {
    if ("owner" in t && config.crm?.type !== "salesforce") problems.push(`${where} routes to the Salesforce owner, but crm isn't set to salesforce`);
    if ("rep" in t && !repIds.has(t.rep)) problems.push(`${where} assigns to rep "${t.rep}", who isn't in reps`);
    if ("pool" in t && !(t.pool in pools)) problems.push(`${where} assigns to pool "${t.pool}", which doesn't exist`);
  };
  (config.routes ?? []).forEach((r, i) => {
    checkTarget(r.assign, `route ${i + 1} ("${r.name}")`);
    for (const c of [...(r.when?.all ?? []), ...(r.when?.any ?? [])]) {
      if (!c.field.toLowerCase().startsWith("account.")) continue;
      if (config.crm?.type !== "salesforce") problems.push(`route "${r.name}" uses ${c.field}, which needs crm: salesforce`);
      else {
        const name = c.field.slice("account.".length).toLowerCase();
        const listed = name === "name" || (config.crm.account_fields ?? []).some((f) => f.toLowerCase() === name);
        if (!listed) problems.push(`route "${r.name}" uses ${c.field}: add ${c.field.slice(8)} to crm.account_fields`);
      }
    }
  });
  checkTarget(config.fallback, "fallback");
  if (config.calendar && config.run.mode !== "server") problems.push("calendar only works when Baton runs as a server (run: { mode: server })");
  if (config.calendar?.popup && !config.reps.some((r) => r.booking_link)) problems.push("calendar.popup is on, but no rep has a booking_link");
  return problems;
}
