#!/usr/bin/env node
// Tag every saved memory row with the questions it answers (src/memory/enrich.mjs).
//
//   node scripts/memory-enrich.mjs
//
// Prints exactly one JSON object — `{status, sections}` on success, `{status:"blocked", reason,
// detail}` when the writer model is unavailable or a batch came back mis-indexed — and exits 0
// either way, like every other script here.
//
// Idempotent: a row that already carries `answers_questions`/`topics` costs nothing, so this is
// safe to re-run after `learn.mjs` adds material. The tags only rank the candidate pool a selector
// sees (`storyPool`, src/jev/plan.mjs); they never answer a form field.
//
// Nothing personal is printed: the output is per-section counts.

import { enrichMemory } from "../src/memory/enrich.mjs";

try {
  console.log(JSON.stringify(await enrichMemory()));
} catch (error) {
  console.log(JSON.stringify({ status: "blocked", reason: "memory_enrichment", detail: error?.name ?? "error" }));
}
