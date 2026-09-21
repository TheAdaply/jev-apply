#!/usr/bin/env node
// Discovery → pipeline (PLAN §2.5, step C1/C2).
//
//   node scripts/scan.mjs                                   tracked companies → pipeline.yaml
//   node scripts/scan.mjs --companies private/companies-seed.yml
//   node scripts/scan.mjs --filters my-rules.yml --no-fit   filter overrides, no Jev pass
//   node scripts/scan.mjs --per-board 100                   keep at most N postings per board
//
// Order: read companies.yml → fetch every enabled board (4 at a time, Ashby ≤3) → filter chain
// (rules derived from the user's own `p.looking_for`) → per-board cap → dedupe within the batch and
// against `pipeline/scan-history.tsv` → Jev fit pass over the new postings → upsert as `found`.
//
// `--per-board` caps how many postings one board contributes *after* filtering: a board answers in a
// single HTTP call regardless, so capping the raw response would only discard matching roles further
// down a large board. Filtering first keeps the cap a bound on pipeline size, not on relevance.
//
// One JSON object on stdout: {scanned, kept, rejected:{reason:n}, new, fitted, ms}. Human progress,
// per-board failures and Jev usage go to stderr. Exit 0 (including `blocked`), 1 for a bug.

import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

import { REPO_ROOT, loadEnv, paths } from "../src/config.mjs";
import { providerFor } from "../src/discover/providers/index.mjs";
import { applyFilters } from "../src/discover/filters.mjs";
import { dedupeJobs } from "../src/discover/dedupe.mjs";
import { fitJobs } from "../src/discover/fit.mjs";
import { loadMemory } from "../src/memory/store.mjs";
import { resolvePreference } from "../src/memory/resolve.mjs";
import { jobId, seenKeys, upsertJobs } from "../src/pipeline/store.mjs";
import { closeJevClient } from "../src/jev/client.mjs";

const SEED_COMPANIES = path.join(REPO_ROOT, "private", "companies-seed.yml");
const BOARD_CONCURRENCY = 4;
const ASHBY_CONCURRENCY = 3; // the Ashby schema endpoint 429s above ~6 concurrent requests (PLAN §2.5)
const PER_BOARD = 100;
/** A board that times out under load usually answers on a quieter attempt; 3 covers the flakiness. */
const BOARD_ATTEMPTS = 3;

const log = (line) => process.stderr.write(`${line}\n`);

function parseArgs(argv) {
  const args = { companies: null, filters: null, fit: true, perBoard: PER_BOARD };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--companies") args.companies = path.resolve(next());
    else if (a === "--filters") args.filters = path.resolve(next());
    else if (a === "--no-fit") args.fit = false;
    else if (a === "--per-board") args.perBoard = Number(next());
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!Number.isFinite(args.perBoard) || args.perBoard <= 0) throw new Error("--per-board needs a positive number");
  return args;
}

// ─── companies.yml ────────────────────────────────────────────────────────────────────────────

/**
 * `paths.companies` is the tracked list. On a fresh install it does not exist yet, so the repo's
 * seed is copied there once — after that the user's copy is the only thing scan reads, and the seed
 * never overwrites their edits. An explicit `--companies F` reads F and copies nothing.
 */
async function companiesFile(explicit) {
  if (explicit) return { file: explicit, seeded: false };
  const text = await readFile(paths.companies, "utf8").catch((err) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (text !== null) return { file: paths.companies, seeded: false };
  // A fresh install has no CONFIG_DIR yet (`install.mjs` has not run), so make it — 0700, because
  // everything that lands there is private.
  await mkdir(path.dirname(paths.companies), { recursive: true, mode: 0o700 });
  await copyFile(SEED_COMPANIES, paths.companies).catch((err) => {
    throw new Error(
      err.code === "ENOENT"
        ? `no ${paths.companies} and no seed at ${SEED_COMPANIES} — write one (see references/companies-format.md)`
        : `cannot seed ${paths.companies}: ${err.message}`,
    );
  });
  await chmod(paths.companies, 0o600);
  return { file: paths.companies, seeded: true };
}

async function loadCompanies(file) {
  const doc = YAML.parse(await readFile(file, "utf8"));
  const rows = [...(doc?.companies ?? []), ...(doc?.boards ?? [])];
  if (!Array.isArray(doc?.companies) && !Array.isArray(doc?.boards)) {
    throw new Error(`${file} has no \`companies:\` or \`boards:\` list (see references/companies-format.md)`);
  }
  return rows.filter((row) => row && typeof row === "object" && row.enabled !== false);
}

// ─── filter rules from memory ─────────────────────────────────────────────────────────────────

/**
 * The filter chain is model-free, so it may only use the *structured* parts of `p.looking_for`:
 * `role_families` → title keywords, `acceptable_locations` → the country rule, and each free-text
 * dealbreaker as a literal content exclusion. Anything a dealbreaker means beyond its own words is
 * judged later by the Jev `noul`, never guessed here.
 */
export function rulesFromMemory(mem) {
  const value = resolvePreference(mem, "p.looking_for")?.value ?? {};
  const rules = {};

  const families = value.role_families && typeof value.role_families === "object" ? value.role_families : {};
  const targets =
    Array.isArray(value.target_roles) && value.target_roles.length > 0 ? value.target_roles : Object.keys(families);
  const include = [];
  for (const family of targets) {
    for (const phrase of families[family] ?? []) {
      const term = String(phrase).trim().toLowerCase();
      if (term) include.push(term);
    }
  }
  if (include.length > 0) rules.title_keywords = { include: [...new Set(include)] };

  const locations = value.acceptable_locations;
  if (locations?.rule === "any_country_except" && Array.isArray(locations.except) && locations.except.length > 0) {
    rules.location = { any_country_except: locations.except.map((c) => String(c).toUpperCase()) };
  }

  const dealbreakers = (Array.isArray(value.dealbreakers) ? value.dealbreakers : [])
    .map((d) => String(d).trim().toLowerCase())
    .filter(Boolean);
  if (dealbreakers.length > 0) rules.content_keywords = { exclude: dealbreakers.map((d) => `stem:${d}`) };

  return rules;
}

/**
 * One board's rules: the memory-derived title keywords OR'd with that entry's own `keywords`
 * (PLAN §2.5 lists `keywords` as a companies.yml field). A tracked company is tracked on purpose,
 * so its list widens the net for *that board only* — "machine learning" catches
 * "Software Engineer, Machine Learning Platform", which no role-family phrase matches. Nothing
 * else in the chain changes: location, age and content rules stay global.
 */
export function boardRules(rules, entry) {
  const extra = (Array.isArray(entry?.keywords) ? entry.keywords : [])
    .map((k) => String(k).trim().toLowerCase())
    .filter(Boolean);
  if (extra.length === 0) return rules;
  return {
    ...rules,
    title_keywords: {
      ...rules.title_keywords,
      include: [...new Set([...(rules.title_keywords?.include ?? []), ...extra])],
    },
  };
}

// ─── board fetch ──────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `concurrency` boards in flight, of which at most `ashbyMax` may be Ashby. A worker that finds only
 * Ashby work left while the Ashby slots are full waits for one to free instead of queue-jumping.
 */
async function fetchBoards(entries, onBoard, { concurrency = BOARD_CONCURRENCY, ashbyMax = ASHBY_CONCURRENCY } = {}) {
  const queue = entries.map((entry, i) => ({ entry, i }));
  let ashbyInFlight = 0;

  const worker = async () => {
    for (;;) {
      const at = queue.findIndex(({ entry }) => entry.provider !== "ashby" || ashbyInFlight < ashbyMax);
      if (at === -1) {
        if (queue.length === 0) return;
        await sleep(25);
        continue;
      }
      const [{ entry }] = queue.splice(at, 1);
      const isAshby = entry.provider === "ashby";
      if (isAshby) ashbyInFlight++;
      try {
        await onBoard(entry);
      } finally {
        if (isAshby) ashbyInFlight--;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, entries.length)) }, worker));
}

const addCounts = (into, from) => {
  for (const [key, n] of Object.entries(from ?? {})) into[key] = (into[key] ?? 0) + n;
  return into;
};

// ─── the scan ─────────────────────────────────────────────────────────────────────────────────

async function scan(args) {
  const started = Date.now();
  const { file, seeded } = await companiesFile(args.companies);
  if (seeded) log(`seeded ${paths.companies} from ${path.relative(REPO_ROOT, SEED_COMPANIES)}`);

  const entries = await loadCompanies(file);
  const mem = await loadMemory();
  const rules = {
    ...rulesFromMemory(mem),
    ...(args.filters ? YAML.parse(await readFile(args.filters, "utf8")) ?? {} : {}),
  };
  log(
    `${entries.length} enabled boards from ${file}; rules: ` +
      `${rules.title_keywords?.include?.length ?? 0} title keywords, ` +
      `location ${rules.location ? `not ${rules.location.any_country_except.join("/")}` : "any"}, ` +
      `${rules.content_keywords?.exclude?.length ?? 0} content exclusions`,
  );

  let scanned = 0;
  let trimmed = 0;
  const rejected = {};
  const unresolved = [];
  const failures = [];
  const kept = [];

  await fetchBoards(entries, async (entry) => {
    const provider = await providerFor(entry);
    if (!provider) {
      unresolved.push(entry.name ?? entry.careers_url ?? "(unnamed)");
      return;
    }
    // A board that times out under load (large Ashby boards throttle, and parsing a multi-MB
    // response blocks every other in-flight timer) usually answers on a second, quieter attempt.
    let jobs;
    let lastError;
    for (let attempt = 0; attempt < BOARD_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(1_500 * attempt);
      try {
        jobs = await provider.fetch(entry, { limit: args.perBoard });
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) {
      failures.push(`${entry.name ?? provider.id}: ${lastError.message}`);
      return;
    }
    scanned += jobs.length;
    const result = applyFilters(jobs, boardRules(rules, entry));
    addCounts(rejected, result.rejected);
    if (result.kept.length > args.perBoard) trimmed += result.kept.length - args.perBoard;
    kept.push(...result.kept.slice(0, args.perBoard));
  });

  log(
    `fetched ${scanned} postings from ${entries.length - unresolved.length - failures.length} boards` +
      `${failures.length ? `, ${failures.length} failed` : ""}${unresolved.length ? `, ${unresolved.length} unresolved` : ""}`,
  );
  for (const failure of failures) log(`  board failed: ${failure}`);
  if (unresolved.length > 0) log(`  unresolved providers (skipped): ${unresolved.join(", ")}`);
  if (trimmed > 0) log(`  --per-board ${args.perBoard} trimmed ${trimmed} matching postings`);

  const fresh = dedupeJobs(kept, await seenKeys()).map((job) => ({ ...job, id: jobId(job) }));
  log(`kept ${kept.length} after filters; ${fresh.length} are new`);

  let fitted = 0;
  if (args.fit && fresh.length > 0) {
    const { results, requests, groups, failed, ms, usage, skipped } = await fitJobs(fresh, {
      mem,
      onError: (err, group) => log(`  fit failed for ${group.length} postings: ${err.message}`),
    });
    if (skipped) log(`  fit skipped: ${skipped}`);
    const byId = new Map(results.map((r) => [r.id, r]));
    for (const job of fresh) {
      const result = byId.get(job.id);
      if (!result) continue;
      job.fit = result.fit;
      job.reason = result.reason;
      job.dealbreaker = result.dealbreaker;
    }
    fitted = results.length;
    log(
      `fit: ${fitted} scored in ${groups} groups / ${requests} requests, ${ms} ms, ` +
        `${usage.input_tokens} input tokens${failed ? `, ${failed} unscored` : ""}`,
    );
  }

  const { added, updated } = await upsertJobs(fresh);
  log(`pipeline: +${added} found, ${updated} refreshed`);

  return {
    scanned,
    kept: kept.length,
    rejected,
    new: added,
    fitted,
    ms: Date.now() - started,
  };
}

// ─── entry point ──────────────────────────────────────────────────────────────────────────────

const USAGE = "usage: scan.mjs [--companies F] [--filters F] [--no-fit] [--per-board N]";

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  log(`${err.message}\n${USAGE}`);
  process.exit(1);
}
if (args.help) {
  log(USAGE);
  process.exit(0);
}

try {
  // Fail before fetching 60+ boards if the key the fit pass needs is not there.
  if (args.fit) loadEnv({ require: ["TYPESAFE_API_KEY"] });
  process.stdout.write(`${JSON.stringify(await scan(args))}\n`);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ status: "blocked", reason: err.message })}\n`);
  log(err.stack ?? String(err));
} finally {
  await closeJevClient();
}
