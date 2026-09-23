#!/usr/bin/env node
// The submit preflight (src/plan/preflight.mjs) run over a frozen application record.
//
//   node scripts/preflight.mjs --slug together-ai-4385540007
//   node scripts/preflight.mjs --file /path/to/decisions.json [--schema recorded.json]
//
// Prints exactly one JSON object — `{ok, slug, status, failures[], checked[], unchecked[]}` — and
// exits 0 whatever the verdict, like every other script here: `ok:false` is an answer, not a
// crash. `--json` is implied; there is nothing else to print.
//
// This is the same function `scripts/apply.mjs` calls before it clicks Submit, with two inputs it
// cannot have after the fact: there is no live page, so "required and empty" is read from the
// form schema when one is given (`--schema`, the file `--record-schema` writes) and reported as
// `unchecked` when none is. The frozen record carries no `required` flag of its own.
//
// Nothing personal is printed. Rows are named by qid and label, sources and memory ids by name;
// no `value`, `option` or read-back text ever reaches stdout.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { paths } from "../src/config.mjs";
import { loadMemory } from "../src/memory/store.mjs";
import { preflight } from "../src/plan/preflight.mjs";
import { loadFormPlan } from "../src/schema/index.mjs";

const USAGE = "usage: preflight.mjs --slug <application-slug> | --file <decisions.json> [--schema <recorded.json>]";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--slug") args.slug = next();
    else if (arg === "--file") args.file = next();
    else if (arg === "--schema") args.schema = next();
    else if (arg === "--json") args.json = true; // accepted and ignored: the output is always JSON
    else throw new Error(`unknown flag ${arg}`);
  }
  if (!args.slug && !args.file) throw new Error("need --slug <slug> or --file <decisions.json>");
  if (args.slug && args.file) throw new Error("pick one: --slug or --file");
  return args;
}

const decisionsFile = (args) => args.file ?? path.join(paths.applications, args.slug, "decisions.json");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = decisionsFile(args);
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw == null) throw new Error(`no frozen record at ${file}`);
  const frozen = JSON.parse(raw);
  if (!Array.isArray(frozen?.decisions)) throw new Error(`${file} holds no decisions[]`);

  // The schema, when the caller has one. Frozen rows carry `required` themselves now (B2), but
  // `control` and `dependency` still only exist on the FormPlan, so `--schema` is what lets the
  // date and conditional-child rules run after the fact.
  const formPlan = args.schema ? await loadFormPlan(args.schema) : null;
  const mem = await loadMemory();

  const report = preflight({
    decisions: frozen.decisions,
    questions: formPlan?.questions ?? [],
    mem,
    live: null,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: report.ok,
        slug: frozen.slug ?? args.slug ?? null,
        status: frozen.status ?? null,
        rows: frozen.decisions.length,
        failures: report.failures,
        checked: report.checked,
        unchecked: report.unchecked,
      },
      null,
      1,
    )}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`${err?.message ?? err}\n${USAGE}\n`);
  process.exit(1);
});
