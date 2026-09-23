#!/usr/bin/env node
// Writer smoke test (PLAN A5). Real writer calls, synthetic memory — no user data is read.
//   node scripts/writer-smoke.mjs                  narrative + why_us + the two post-checks
//   node scripts/writer-smoke.mjs --detect         which backend would write, and nothing else
//   node scripts/writer-smoke.mjs --extract F.txt  extractResume over a text file (needs a model)
//   node scripts/writer-smoke.mjs --extract-basic F.txt
//                                                  the deterministic extractor, no model at all
// Human-readable on stdout; exits 1 if a draft cannot be made to satisfy the writing rules.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { OPENAI_MODEL, OPENAI_MODEL_FAST } from "../src/config.mjs";
import { describeWriter, detectWriter } from "../src/writer/backend.mjs";
import { extractBasic } from "../src/writer/extract-basic.mjs";
import { VARIANT_WORDS, WHY_US_WORDS, jobBlock } from "../src/writer/prompts.mjs";
import { extractResume, groundingCheck, narrative, substitutionCheck, whyUs } from "../src/writer/openai.mjs";

// --- synthetic memory (invented people, invented companies) -------------------------------------
const FACTS = [
  { id: "f.identity.full_name", value: "Robin Vale", source: "resume:sample.txt#p1" },
  { id: "f.title.current", value: "Senior backend engineer at Northwind Labs", since: "2022-03", source: "resume:sample.txt#p1" },
  { id: "f.skill.go", value: "Go", since: "2019-06", source: "resume:sample.txt#p1" },
  { id: "f.skill.postgres", value: "PostgreSQL", since: "2018-01", source: "resume:sample.txt#p1" },
  { id: "f.team", value: "led a team of 4 engineers", since: "2023-01", source: "resume:sample.txt#p2" },
];
const STORIES = [
  {
    id: "b.story.queue",
    title: "Which project shows you cutting a system's tail latency?",
    text:
      "At Northwind Labs I replaced a polling job queue with a PostgreSQL LISTEN/NOTIFY worker pool written in Go. " +
      "p99 pickup time went from 9 seconds to 400 milliseconds, and the nightly backlog of 12000 jobs cleared before 06:00. " +
      "I shipped the migration in 3 steps so the old and new workers ran side by side for a week.",
    tags: ["backend", "latency", "postgres"],
    source: "resume:sample.txt#p1",
  },
  {
    id: "b.story.oncall",
    title: "Which project shows you reducing on-call load for a team?",
    text:
      "I rewrote the alerting rules for our 18 services after a quarter with 63 pages. " +
      "I grouped alerts by user-visible symptom, deleted 31 rules that had never fired, and put a runbook link on every remaining alert. " +
      "The next quarter the team took 11 pages, and I led the 4 engineers who owned the runbooks.",
    tags: ["sre", "on-call", "reliability"],
    source: "resume:sample.txt#p2",
  },
];
const JOB = {
  company: "Acme",
  title: "Senior Backend Engineer",
  location: "Berlin",
  description:
    "Acme runs a scheduling platform for logistics operators. The backend team owns the job queue, the alerting stack and the Go services behind it.",
};
const SENTENCE = "I want to work on Acme's scheduling backend because queueing under load is the part of the job I keep choosing.";

const PROMPT = "Describe a technical project you are proud of";
const LIMITS = { words: 150 };

function line(label, text, cap, grounding) {
  const words = String(text).trim().split(/\s+/).length;
  const g = groundingCheck(text, grounding);
  const flag = g.ok ? "grounding ok" : `grounding MISSING ${JSON.stringify(g.missing)}`;
  return `  ${label.padEnd(7)} ${String(words).padStart(3)} words (cap ${cap})  ${flag}`;
}

async function runExtract(file) {
  const text = await readFile(file, "utf8");
  const t0 = Date.now();
  const { facts, stories } = await extractResume({ text, doc: path.basename(file) });
  console.log(`extractResume ${file} · ${OPENAI_MODEL_FAST} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  facts ${facts.length} · stories ${stories.length} · with since: ${facts.filter((f) => f.since).length}`);
  console.log(`  ids   ${facts.map((f) => f.id).join(" ")}`);
  for (const f of facts.slice(0, 3)) console.log(`  fact  ${f.id} = ${f.value} [${f.source}]`);
  for (const s of stories.slice(0, 3)) console.log(`  story ${s.id} | ${s.title} [${s.source}]`);
  const bad = stories.filter((s) => !s.title.trim().endsWith("?"));
  console.log(`  titles that are questions: ${stories.length - bad.length}/${stories.length}`);
}

/** The deterministic extractor `learn.mjs` falls back to when no writer model is configured. */
async function runExtractBasic(file) {
  const text = await readFile(file, "utf8");
  const { facts, stories } = extractBasic(text, { doc: path.basename(file) });
  console.log(`extractBasic ${file} · no model`);
  console.log(`  facts ${facts.length} · stories ${stories.length}`);
  for (const f of facts) console.log(`  fact  ${f.id} = ${f.value} [${f.source}]`);
  for (const s of stories.slice(0, 4)) console.log(`  story ${s.id} | ${s.title} [${s.source}]`);
  const questions = stories.filter((s) => s.title.trim().endsWith("?")).length;
  console.log(`  titles that are questions: ${questions}/${stories.length}`);
}

async function runWriter() {
  const caps = {
    short: Math.min(VARIANT_WORDS.short, LIMITS.words),
    medium: Math.min(VARIANT_WORDS.medium, LIMITS.words),
    long: Math.min(VARIANT_WORDS.long, LIMITS.words),
  };
  const narrativeGrounding = [...FACTS, ...STORIES];

  const t0 = Date.now();
  const variants = await narrative({ prompt: PROMPT, facts: FACTS, stories: STORIES, family: "backend", limits: LIMITS });
  console.log(`narrative "${PROMPT}" limits ${JSON.stringify(LIMITS)} · ${OPENAI_MODEL} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const v of ["short", "medium", "long"]) console.log(line(v, variants[v], caps[v], narrativeGrounding));
  console.log(`  medium: ${variants.medium}`);

  const t1 = Date.now();
  const paragraph = await whyUs({ sentence: SENTENCE, stories: STORIES, job: JOB, limits: { words: WHY_US_WORDS } });
  const whyGrounding = [SENTENCE, ...STORIES.slice(0, 2), ...FACTS, jobBlock(JOB)];
  console.log(`whyUs ${JOB.company} — ${JOB.title} · ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log(line("why_us", paragraph.text, WHY_US_WORDS, whyGrounding));
  console.log(`  ${paragraph.text}`);

  const clean = substitutionCheck(paragraph.text, ["Globex", "Initech"]);
  const dirty = substitutionCheck(paragraph.text, ["Acme"]);
  console.log(`substitutionCheck(why_us, ["Globex","Initech"]) -> ok=${clean.ok} found=${JSON.stringify(clean.found)}`);
  console.log(`substitutionCheck(why_us, ["Acme"])             -> ok=${dirty.ok} found=${JSON.stringify(dirty.found)}`);
}

const argv = process.argv.slice(2);
const extractAt = argv.indexOf("--extract");
const basicAt = argv.indexOf("--extract-basic");
try {
  if (argv.includes("--detect")) {
    const cfg = detectWriter({ refresh: true });
    // The kind on its own line: this is what a setup script greps for.
    console.log(cfg.kind);
    console.log(`  ${describeWriter(cfg)}`);
  } else if (basicAt !== -1) {
    const file = argv[basicAt + 1];
    if (!file) throw new Error("--extract-basic needs a text file");
    await runExtractBasic(file);
  } else if (extractAt !== -1) {
    const file = argv[extractAt + 1];
    if (!file) throw new Error("--extract needs a text file");
    await runExtract(file);
  } else if (detectWriter().kind === "host") {
    // Not a failure: no writer model is a supported configuration. There is simply nothing for
    // this script to call — the host agent writes those few paragraphs and `apply.mjs` checks them.
    console.log(`writer backend: ${describeWriter()}`);
    console.log("nothing to smoke — set OPENAI_API_KEY, or JEV_APPLY_WRITER_URL + JEV_APPLY_WRITER_MODEL.");
  } else {
    console.log(`writer backend: ${describeWriter()}`);
    await runWriter();
  }
} catch (err) {
  console.error(`writer-smoke failed: ${err.message}`);
  if (err.problems) for (const p of err.problems) console.error(`  - ${p}`);
  process.exit(1);
}
