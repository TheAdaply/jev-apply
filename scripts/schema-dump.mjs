#!/usr/bin/env node
// schema-dump — read a posting's FormPlan without a browser and print it.
//
//   node scripts/schema-dump.mjs --url https://job-boards.greenhouse.io/togetherai/jobs/5179372007
//   node scripts/schema-dump.mjs --schema eval/fixtures/greenhouse-togetherai-5179372007.json
//   node scripts/schema-dump.mjs --url <U> --json        # the FormPlan itself, one JSON object
//
// Table columns: qid | class | type | control | required | label (truncated to 60).
// Rows are grouped by form section, so the application block and the EEO/demographic blocks that
// the runner skips (PLAN §2.2 step 4) are counted separately.

import { loadFormPlan } from "../src/schema/index.mjs";

const LABEL_MAX = 60;
const QID_MAX = 38;
const HEAD = ["qid", "class", "type", "control", "required", "label"];

main().catch((err) => {
  process.stderr.write(`schema-dump: ${err.message}\n`);
  process.exit(1);
});

async function main() {
  const { source, json } = parseArgs(process.argv.slice(2));
  const plan = await loadFormPlan(source);
  process.stdout.write(json ? `${JSON.stringify(plan, null, 2)}\n` : table(plan));
}

function parseArgs(argv) {
  let source = null;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--url" || arg === "--schema") source = argv[++i];
    else if (arg.startsWith("--url=")) source = arg.slice(6);
    else if (arg.startsWith("--schema=")) source = arg.slice(9);
    else throw new Error(`unknown argument ${arg}\nusage: schema-dump.mjs --url <U> | --schema <file> [--json]`);
  }
  if (!source) throw new Error("usage: schema-dump.mjs --url <U> | --schema <file> [--json]");
  return { source, json };
}

function table(plan) {
  const rows = plan.questions.map((q) => [
    clip(q.qid, QID_MAX),
    q.class,
    q.type,
    q.control,
    q.required ? "yes" : "no",
    clip(q.label, LABEL_MAX),
  ]);
  const width = HEAD.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(width[i]))).join(" | ");

  const out = [
    `${plan.ats} · ${plan.job.company} — ${plan.job.title}${plan.job.location ? ` · ${plan.job.location}` : ""}`,
    plan.url,
    ...(plan.job.payRange ? [`pay: ${plan.job.payRange.text}`] : []),
    "",
    line(HEAD),
  ];

  let section = null;
  plan.questions.forEach((q, i) => {
    if (q.section !== section) {
      section = q.section;
      out.push(`— ${section || "Application"} (${plan.questions.filter((o) => o.section === section).length}) —`);
    }
    out.push(line(rows[i]));
  });

  out.push("", `${plan.questions.length} rows · ${tally(plan.questions, "section")}`, `classes: ${tally(plan.questions, "class")}`);
  const deps = plan.questions.filter((q) => q.dependency);
  if (deps.length) out.push(`dependencies: ${deps.map((q) => `${q.qid} ← ${q.dependency.parent}=${q.dependency.condition}`).join(" · ")}`);
  return `${out.join("\n")}\n`;
}

function tally(questions, key) {
  const counts = new Map();
  for (const q of questions) {
    const value = q[key] || "—";
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts].map(([value, n]) => `${n} ${value}`).join(" · ");
}

function clip(text, max) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
