#!/usr/bin/env node
// answers — pre-answer the canonical question bank from the user's own memory (PLAN §2.7, Q4).
//
//   node scripts/answers.mjs --families ml_engineer,research_engineer [--curate]
//   node scripts/answers.mjs --accept ~/.config/jev-apply/review/narratives.md
//
// Onboarding's last step. The six day-1 questions and the résumé are already in memory; this walks
// the universal layers (core · auth · legal · comp · narrative) plus the screening layer of the
// families the user picked, and writes `~/.config/jev-apply/memory/answers.yaml`:
//
//   constants  copied from stated facts                       silent
//   rules      a `rule_ref` evaluated at fill time            silent
//   policies   only where a preference states a stance        silent
//   narratives written by the OpenAI writer from facts +      shown once, with --curate
//              usable stories, three length variants
//
// `company` answers belong to queue time and `never` answers are never auto-filled, so neither is
// produced here. Nothing is invented: a canonical question whose backing fact or preference is
// missing is left out and listed under `missing` with the memory id that would fill it.
//
// Re-running is safe. A row the user has read (`reviewed: true`) or written (`source: user`) is
// never overwritten, so a curation pass survives every later run.
//
// One JSON object on stdout, logs on stderr, exit 0 for `ready_to_submit` / `needs_user`.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OPENAI_MODEL } from "../src/config.mjs";
import {
  REVIEW_DIR,
  REVIEW_FILE,
  acceptReview,
  coverageLine,
  factRows,
  mergeAnswers,
  narrativePrompts,
  narrativeRows,
  policyRows,
  renderReview,
} from "../src/canon/answers.mjs";
import { canonMeta, loadCanon } from "../src/canon/index.mjs";
import { FAMILY_IDS } from "../src/canon/families.mjs";
import { loadMemory, loadSection } from "../src/memory/store.mjs";
import { stamp } from "../src/memory/schema.mjs";
import { loadPipeline } from "../src/pipeline/store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const USAGE = [
  "usage: answers.mjs --families <a,b> [--curate] [--concurrency N] [--dry-run] [--json]",
  "       answers.mjs --accept <narratives.md>",
  "  --dry-run  print the rows that would be written; no writer calls, nothing saved",
  "  --json     the JSON object on stdout only, no progress logs on stderr",
  `families: ${FAMILY_IDS.join(" ")}`,
].join("\n");

function parseArgs(argv) {
  const args = { families: [], curate: false, accept: null, concurrency: 4, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--families") args.families = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--curate") args.curate = true;
    else if (a === "--accept") args.accept = path.resolve(next().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    else if (a === "--concurrency") args.concurrency = Number(next());
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      process.stderr.write(`${USAGE}\n`);
      process.exit(0);
    } else throw new Error(`unknown flag: ${a}`);
  }
  if (!args.accept && !args.families.length) throw new Error(`--families is required\n${USAGE}`);
  const unknown = args.families.filter((f) => !FAMILY_IDS.includes(f));
  if (unknown.length) throw new Error(`unknown role families: ${unknown.join(", ")}\n${USAGE}`);
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) throw new Error("--concurrency must be ≥ 1");
  return args;
}

let quiet = false;
const log = (msg) => {
  if (!quiet) process.stderr.write(`${msg}\n`);
};
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

// ─── --accept ─────────────────────────────────────────────────────────────────────────────────

async function runAccept(file, canon, meta) {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text == null) throw new Error(`${file} does not exist — run --curate first`);
  const result = await acceptReview(text);
  const stored = await loadSection("answers");
  log(`accept: ${result.reviewed} reviewed, ${result.edited} edited${result.unknown.length ? `, ${result.unknown.length} unknown` : ""}`);
  emit({
    status: "ready_to_submit",
    constants: stored.filter((r) => r.kind === "constant").length,
    rules: stored.filter((r) => r.kind === "rule").length,
    policies: stored.filter((r) => r.kind === "policy").length,
    narratives: stored.filter((r) => r.kind === "narrative").length,
    coverage_line: coverageLine(canon, stored, meta),
    reviewed: result.reviewed,
    edited: result.edited,
    ...(result.unknown.length ? { unknown: result.unknown } : {}),
  });
}

// ──────────────────────────────────────── main ────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  quiet = args.json;
  const date = stamp();

  const canon = await loadCanon(path.join(REPO, "canon"));
  if (!canon) throw new Error("canon/questions.yaml is missing — run scripts/canon-cluster.mjs first");
  const meta = await canonMeta(path.join(REPO, "canon"));

  if (args.accept) return runAccept(args.accept, canon, meta);

  const mem = await loadMemory();
  // The one rule the pipeline backs is "have you applied to this company before?" — the row is
  // written only when there is history to answer from, and it is re-evaluated at fill time.
  const pipeline = await loadPipeline();
  log(`answers: ${canon.questions.length} canonical questions · families ${args.families.join(", ")}`);

  // 1. facts and preferences — deterministic, no model, no network.
  const facts = factRows(canon, mem, { date, pipeline });
  const policies = policyRows(canon, mem, { date });
  log(`answers: ${facts.rows.filter((r) => r.kind === "constant").length} constants, ${facts.rows.filter((r) => r.kind === "rule").length} rules, ${policies.rows.length} policies`);

  // 2. narratives — the only model-written rows (PLAN §2.4).
  const prompts = narrativePrompts(canon, mem, args.families);

  // `--dry-run` stops here: what the deterministic passes produced, and which narratives the writer
  // would be asked for. Nothing is authored, nothing is merged, memory is untouched.
  if (args.dryRun) {
    const would = [...facts.rows, ...policies.rows, ...prompts.map((p) => ({ qid: p.qid, kind: "narrative", reviewed: false }))];
    emit({
      status: "ready_to_submit",
      dry_run: true,
      constants: facts.rows.filter((r) => r.kind === "constant").length,
      rules: facts.rows.filter((r) => r.kind === "rule").length,
      policies: policies.rows.length,
      narratives: prompts.length,
      coverage_line: coverageLine(canon, would, meta),
      missing: [...facts.omitted, ...policies.omitted].map((o) => `${o.qid} needs ${o.need}`),
    });
    return;
  }

  log(`answers: authoring ${prompts.length} narrative answer(s) with ${OPENAI_MODEL}`);
  const narratives = await narrativeRows(prompts, {
    mem,
    date,
    concurrency: args.concurrency,
    onProgress: ({ done, total, qid, family }) => log(`answers: ${done}/${total} ${qid}${family ? ` [${family}]` : ""}`),
  });
  for (const f of narratives.failed) log(`answers: ${f.qid}${f.family ? ` [${f.family}]` : ""} not written — ${f.reason}`);

  // 3. merge into memory; a curated or user-written row always wins.
  const merged = await mergeAnswers([...facts.rows, ...policies.rows, ...narratives.rows]);
  if (merged.rejected.length) for (const r of merged.rejected) log(`answers: rejected ${r}`);
  log(`answers.yaml: ${merged.added} added, ${merged.updated} updated, ${merged.kept} kept (already yours), ${merged.rows} rows`);

  const stored = await loadSection("answers");

  // 4. the one curation pass.
  let reviewFile = null;
  if (args.curate) {
    await mkdir(REVIEW_DIR, { recursive: true, mode: 0o700 });
    await writeFile(REVIEW_FILE, renderReview(stored, canon, { date }), { encoding: "utf8", mode: 0o600 });
    reviewFile = REVIEW_FILE;
    log(`review: ${REVIEW_FILE}`);
  }

  const counts = {
    constants: stored.filter((r) => r.kind === "constant").length,
    rules: stored.filter((r) => r.kind === "rule").length,
    policies: stored.filter((r) => r.kind === "policy").length,
    narratives: stored.filter((r) => r.kind === "narrative").length,
  };
  const toReview = stored.filter((r) => r.kind === "narrative" && r.reviewed !== true).length;

  emit({
    status: toReview ? "needs_user" : "ready_to_submit",
    ...counts,
    coverage_line: coverageLine(canon, stored, meta),
    missing: [...facts.omitted, ...policies.omitted].map((o) => `${o.qid} needs ${o.need}`),
    ...(narratives.failed.length ? { not_written: narratives.failed.map((f) => `${f.qid}${f.family ? `[${f.family}]` : ""}: ${f.reason}`) } : {}),
    ...(reviewFile ? { review: reviewFile } : {}),
  });
}

main().catch((err) => {
  log(`answers failed: ${err.stack ?? err.message}`);
  emit({ status: "blocked", reason: err.message });
  process.exit(0);
});
