#!/usr/bin/env node
// Offline-ish acceptance check for the resolve+Jev+gate pipeline (PLAN §4 Phase D), run against the
// two recorded fixtures in eval/fixtures/. "Offline" for the form schema (`--schema` reads the
// recorded JSON, no HTTP to the ATS); the Jev canonical-question and option requests are still live —
// there is no mock decider (AGENTS.md: Jev never guesses, so there is nothing useful to stub).
//
//   node eval/plan.test.mjs
//
// Prints `ok - <assertion>` / `FAIL - <assertion>` per check and exits 1 if any assertion fails.
// Numbers below are what the two fixtures produce against the real memory store as recorded
// 2026-09-22 (docs/CHANGELOG.md v0.1.0); a memory edit that removes a fact used by these forms
// (work authorization, identity, links) is expected to move them and should update this file.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const APPLY = path.join(ROOT, "scripts", "apply.mjs");

/** Any phrasing of the four PLAN §2.7 work-authorization/sponsorship prompts. */
const WORK_AUTH_RE = /authorized to work|work authoriz|sponsor|legally authoriz|require.*visa/i;

let failures = 0;

function check(label, ok) {
  console.log(`${ok ? "ok" : "FAIL"} - ${label}`);
  if (!ok) failures += 1;
}

/** Runs `apply.mjs --dry-run --schema <fixture> --json` and returns the parsed stdout payload. */
function planFixture(fixture) {
  const schema = path.join(ROOT, "eval", "fixtures", fixture);
  const proc = spawnSync(process.execPath, [APPLY, "--dry-run", "--schema", schema, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (proc.error) throw proc.error;
  const line = proc.stdout.trim();
  if (!line) throw new Error(`apply.mjs printed nothing for ${fixture} (exit ${proc.status}): ${proc.stderr}`);
  return JSON.parse(line);
}

/** `tally()` folds fill+check into `filled`, so `filled + asks + drafted + skipped` is every row. */
function rowCount(plan) {
  return plan.filled + plan.asks.length + plan.drafted.length + plan.skipped;
}

// ─── Greenhouse — Together AI, Research Engineer (togetherai/5179372007) ───────────────────────
{
  const plan = planFixture("greenhouse-togetherai-5179372007.json");
  check("greenhouse: 22 rows", rowCount(plan) === 22);
  check(`greenhouse: skip >= 9 (got ${plan.skipped})`, plan.skipped >= 9);
  check(`greenhouse: ask <= 3 (got ${plan.asks.length})`, plan.asks.length <= 3);
  check(
    "greenhouse: work-auth rows resolved (not in the ask list)",
    !plan.asks.some((q) => WORK_AUTH_RE.test(q.label)),
  );
  // requests <= 2 holds while canon/questions.yaml is absent (saved-item request + options
  // request). Once the canon bank lands, a row whose label misses every canonical id adds a
  // third (story-fallback) request by design — bump this to <= 3 if that starts failing.
  check(`greenhouse: requests <= 2 (got ${plan.requests})`, plan.requests <= 2);
}

// ─── Ashby — Baseten, AI Inference Engineer (baseten/db6477fc) ─────────────────────────────────
{
  const plan = planFixture("ashby-baseten-db6477fc.json");
  check("ashby: 8 rows", rowCount(plan) === 8);
  check(`ashby: ask <= 1 (got ${plan.asks.length})`, plan.asks.length <= 1);
}

if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall assertions passed");
