#!/usr/bin/env node
// The form-filling benchmark: how well does the runner actually drive real ATS controls?
//
//   JEV_APPLY_HOME=/tmp/jev-bench node scripts/bench.mjs --postings bench/postings.yml
//   node scripts/bench.mjs --postings bench/smoke.txt --limit 2 --port 9224 --home /tmp/jev-bench
//
// For each posting it runs the real binary (`apply.mjs --url … --json`) against a **synthetic**
// home, waits for one of the three terminal statuses, reads that application's `decisions.json`
// and `trace.jsonl`, and records: status, field counts, per-control-type ok/fail and median ms,
// per-phase milliseconds, tokens and dollars, the ranked failure reasons, and any screenshots.
// Then it closes the tab it opened. Results land in `bench/results/<date>-<run>.{json,md}`.
//
// Safety rails, in order of how much they would hurt to get wrong:
//   1. The profile is invented (`src/bench/synthetic.mjs`) — no real name, email, phone or CV
//      ever reaches somebody's careers page.
//   2. The browser is the bench's own, on its own CDP port; `assertBenchPort` refuses to run if
//      anything else owns that port (that would be the user's Chrome).
//   3. Submit is never clicked — that is `apply.mjs`'s invariant (D8) and this script adds no
//      way around it.
//   4. Credentials come only from `~/.config/jev-apply/env`, travel in the child's environment,
//      and are never written under `/tmp` or printed.
//
// One JSON object on stdout; the table and progress on stderr; exit 0 unless the harness itself
// could not start.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { REPO_ROOT } from "../src/config.mjs";
import { loadCanon } from "../src/canon/index.mjs";
import { usageReport } from "../src/plan/summary.mjs";
import { buildReport } from "../src/bench/report.mjs";
import { exercisedControls, parseTrace, summarize } from "../src/bench/metrics.mjs";
import { assertExerciseHome, exerciseControls } from "../src/bench/exercise.mjs";
import { loadPostings } from "../src/bench/postings.mjs";
import { assertBenchPort, closeTab, loadSecrets, readArtifacts, runApply } from "../src/bench/run.mjs";
import { ensureSyntheticHome, seedAnswers } from "../src/bench/synthetic.mjs";

const USAGE = [
  "usage: bench.mjs --postings <bench/postings.yml | url-list.txt>",
  "       [--limit N] [--port 9224] [--home /tmp/jev-bench] [--run <name>] [--timeout 300] [--eeo]",
  "       [--exercise-controls] [--baseline bench/results/<run>.json | --no-baseline]",
  "",
  "  --exercise-controls  after each fill, drive every remaining ask/skip row (never `sensitive`,",
  "                       never `policy_gate`) with a bench-chosen value, so widgets the runner",
  "                       never reached are measured. Recorded as `exercised`, never as `filled`.",
  "                       Refuses to run unless JEV_APPLY_HOME names a non-default home.",
  "  --baseline FILE      the previous run's result JSON, for the round-over-round table.",
].join("\n");

const DEFAULTS = { port: 9224, home: "/tmp/jev-bench", timeout: 300, baseline: "bench/results/2026-09-22-final.json" };

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--postings": args.postings = next(); break;
      case "--limit": args.limit = Number(next()); break;
      case "--port": args.port = Number(next()); break;
      case "--home": args.home = next(); break;
      case "--run": args.run = next(); break;
      case "--timeout": args.timeout = Number(next()); break;
      case "--keep-tabs": args.keepTabs = true; break;
      case "--eeo": args.eeo = true; break;
      case "--exercise-controls": args.exercise = true; break;
      case "--baseline": args.baseline = next(); break;
      case "--no-baseline": args.baseline = null; break;
      default: throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  if (!args.postings) throw new Error("need --postings <file>");
  if (!Number.isInteger(args.port) || args.port < 1024) throw new Error("--port takes a TCP port above 1023");
  if (args.limit != null && (!Number.isInteger(args.limit) || args.limit < 1)) throw new Error("--limit takes a positive integer");
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) throw new Error("--timeout takes seconds");
  return args;
}

const log = (line) => process.stderr.write(`${line}\n`);
const stamp = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

/** `2026-09-23-1418` unless the caller named the run. Sortable, and unique per minute. */
function runName(explicit) {
  if (explicit) return `${today()}-${explicit.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
  const now = new Date();
  return `${today()}-${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}`;
}

const pad = (v, w) => String(v ?? "").padEnd(w).slice(0, w);
const padL = (v, w) => String(v ?? "").padStart(w);

/** One posting: run it, measure it, close its tab. Never throws — a failure is a row. */
async function benchOne(posting, ctx) {
  const since = Date.now();
  log(`\n[${posting.n}/${ctx.total}] ${posting.company} · ${posting.ats} · ${posting.url}`);

  const run = await runApply({
    url: posting.url,
    home: ctx.home,
    port: ctx.port,
    repoRoot: REPO_ROOT,
    secrets: ctx.secrets,
    timeoutMs: ctx.timeoutMs,
    onLog: ctx.verbose ? (line) => log(`    ${line}`) : null,
  });

  const result = run.result ?? {};
  const slug = result.slug ?? null;
  const { decisions, trace } = await readArtifacts(ctx.home, slug);
  const measured = summarize({ decisions, trace: parseTrace(trace), since, status: run.status });

  const row = {
    ...posting,
    slug,
    status: run.status,
    // The reason a child that printed no JSON gives is "exit 1" and nothing else; its last lines
    // of stderr are the only thing that names the real cause, so they ride along on the row.
    ...(run.status === "blocked"
      ? { reason: result.reason ?? run.reason ?? "unknown", stderr_tail: run.stderr.split("\n").filter(Boolean).slice(-8).join("\n") }
      : {}),
    title: result.title ?? null,
    ms: run.ms,
    usage: result.usage ?? null,
    ...measured,
    expected_controls: posting.controls,
  };

  // Widgets the fill loop never reached, driven on purpose — after `measured`, so nothing here can
  // ever become a `filled`, and before the tab is closed, because that tab *is* the fixture.
  if (ctx.exercise) {
    const drill = await exerciseControls({
      url: result.url ?? posting.url,
      home: ctx.home,
      port: ctx.port,
      slug,
      decisions,
      status: run.status,
      onLog: ctx.verbose ? (line) => log(`    ${line}`) : null,
    });
    const { controls, skipped, as_planned } = exercisedControls(drill.rows);
    row.exercised = {
      ran: drill.ran,
      ...(drill.why ? { why: drill.why } : {}),
      rows: drill.rows.length,
      attempted: drill.rows.filter((r) => r.exercised).length,
      ok: drill.rows.filter((r) => r.ok).length,
      fail: drill.rows.filter((r) => r.exercised && !r.ok).length,
      declined: drill.rows.filter((r) => !r.exercised).length,
      ms: drill.ms,
      jev: drill.jev,
      usd: usageReport({ ms_total: 0, jev: drill.jev }).jev.usd,
      controls,
      skipped,
      as_planned,
      // The rows themselves, so a reader can see *which* field each number came from. Labels and
      // qids are the form's own public text (`src/bench/metrics.mjs`); the value the bench chose
      // is not written, only how it was chosen.
      detail: drill.rows.map(({ qid, label, control, planned, was, exercised, ok, strategy, fallback_why, reason, why, options, ms }) => ({
        qid,
        label,
        control,
        ...(planned && planned !== control ? { planned } : {}),
        was,
        exercised,
        ...(exercised ? { ok, strategy, ms } : { why }),
        ...(fallback_why ? { fallback_why } : {}),
        ...(reason ? { reason } : {}),
        ...(options ? { options } : {}),
      })),
    };
  }

  if (!ctx.keepTabs) {
    const closed = await closeTab({ url: result.url ?? posting.url, home: ctx.home, port: ctx.port });
    row.tab_closed = closed.closed;
    if (!closed.closed) log(`    tab: ${closed.why}`);
  }

  log(
    `    ${row.status} · ${(row.fields.filled ?? 0) + (row.fields.check ?? 0)}/${row.fields.total} filled · ` +
      `${row.fields.ask} ask · ${row.fields.failed} failed · ${row.writes} write(s) · ${(run.ms / 1000).toFixed(1)}s` +
      (row.status === "blocked" ? ` · ${row.reason}` : ""),
  );
  for (const c of row.controls) log(`      ${pad(c.control, 15)} ${padL(c.ok, 3)}/${padL(c.attempts, 3)} ok · median ${padL(c.median_ms ?? "—", 5)} ms`);
  if (row.exercised) {
    const ex = row.exercised;
    log(
      `    exercised ${ex.ok}/${ex.attempted} ok · ${ex.declined} declined · ${ex.jev.requests} Jev req · ${(ex.ms / 1000).toFixed(1)}s` +
        (ex.ran ? "" : ` · not run: ${ex.why}`),
    );
    for (const c of ex.controls) log(`      ex ${pad(c.control, 12)} ${padL(c.ok, 3)}/${padL(c.attempts, 3)} ok · median ${padL(c.median_ms ?? "—", 5)} ms`);
  }
  return row;
}

/**
 * The previous run's result JSON, for the round-over-round table. An unreadable or absent file is
 * reported as such in the report rather than quietly compared against nothing.
 */
async function loadBaseline(file) {
  if (!file) return null;
  const abs = path.isAbsolute(file) ? file : path.join(REPO_ROOT, file);
  const rel = path.relative(REPO_ROOT, abs);
  const raw = await readFile(abs, "utf8").catch(() => null);
  if (raw == null) return { file: rel, missing: true };
  try {
    const parsed = JSON.parse(raw);
    return parsed?.totals ? { ...parsed, file: rel } : { file: rel, missing: true };
  } catch {
    return { file: rel, missing: true };
  }
}

// ─── entry ────────────────────────────────────────────────────────────────────────────────────

const args = (() => {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (err) {
    log(`${err.message}\n${USAGE}`);
    process.exit(1);
  }
})();

const started = stamp();
const t0 = Date.now();
const run = runName(args.run);

try {
  const list = await loadPostings(args.postings);
  const postings = args.limit ? list.postings.slice(0, args.limit) : list.postings;
  if (!postings.length) throw new Error(`${args.postings} lists no postings`);

  const home = path.resolve(args.home);
  // Before anything is written or opened: `--exercise-controls` types bench-chosen values into
  // real employers' forms, so it must be provably impossible with the user's own store loaded.
  if (args.exercise) assertExerciseHome(home);

  const { env: secrets, found, missing } = await loadSecrets();
  if (missing.length) log(`credentials: ${found.length} found, missing ${missing.join(", ")} — those postings will come back blocked`);
  else log(`credentials: both keys loaded from the private env file (never written to ${home})`);
  // `--exercise-controls` asks Jev from *this* process, not from a child. The children get the
  // keys through `spawn`'s env; the bench home deliberately has no `env` file, so without this
  // `loadEnv()` finds nothing, every Choice throws, and the ranking silently degrades to the
  // bench's own fallback. In-process only — nothing is written to disk and nothing is logged.
  if (args.exercise) Object.assign(process.env, secrets);

  await ensureSyntheticHome(home, { eeo: Boolean(args.eeo) });

  // What an *onboarded* user has: the six day-1 answers plus `scripts/answers.mjs` over the
  // canonical bank for every family this list covers. Without it the bench measures somebody who
  // stopped halfway through setup, and every narrative prompt comes back as an ask.
  const families = [...new Set(postings.map((p) => p.family).filter(Boolean))].sort();
  const seeded = await seedAnswers(home, {
    families,
    secrets,
    repoRoot: REPO_ROOT,
    onLog: process.env.JEV_BENCH_VERBOSE ? (line) => log(`    ${line}`) : null,
  });
  log(
    `answers: ${seeded.constants ?? 0} constants · ${seeded.rules ?? 0} rules · ${seeded.policies ?? 0} policies · ` +
      `${seeded.narratives ?? 0} narratives over ${families.length} famil${families.length === 1 ? "y" : "ies"}` +
      `${seeded.cached ? " (cached)" : seeded.ran ? "" : ` (not run: ${seeded.why ?? "unknown"})`}`,
  );

  await assertBenchPort({ port: args.port, home });

  const [canon, baseline] = await Promise.all([loadCanon(path.join(REPO_ROOT, "canon")), loadBaseline(args.baseline)]);
  if (baseline?.missing) log(`baseline: ${baseline.file} is not a readable bench result — the round-over-round table will say so`);

  log(
    `bench ${run}: ${postings.length} posting(s) · home ${home} · CDP ${args.port} · synthetic profile · ` +
      `${args.exercise ? "exercising leftover controls · " : ""}Submit is never clicked`,
  );

  const ctx = {
    home,
    port: args.port,
    secrets,
    timeoutMs: args.timeout * 1000,
    total: postings.length,
    keepTabs: Boolean(args.keepTabs),
    exercise: Boolean(args.exercise),
    verbose: Boolean(process.env.JEV_BENCH_VERBOSE),
  };

  const rows = [];
  for (const posting of postings) rows.push(await benchOne(posting, ctx));

  const { json, markdown } = buildReport({
    run,
    started,
    finished: stamp(),
    ms: Date.now() - t0,
    postings: rows,
    list,
    home,
    port: args.port,
    eeo: Boolean(args.eeo),
    exercise: Boolean(args.exercise),
    canon,
    baseline,
    seeded,
  });

  const dir = path.join(REPO_ROOT, "bench", "results");
  await mkdir(dir, { recursive: true });
  const jsonFile = path.join(dir, `${run}.json`);
  const mdFile = path.join(dir, `${run}.md`);
  await writeFile(jsonFile, `${JSON.stringify(json, null, 2)}\n`);
  await writeFile(mdFile, `${markdown}\n`);

  log(`\n${markdown}`);
  log(`\nwrote ${path.relative(REPO_ROOT, jsonFile)} and ${path.relative(REPO_ROOT, mdFile)}`);
  process.stdout.write(`${JSON.stringify({ status: "ready_to_submit", run, postings: rows.length, totals: json.totals, files: [jsonFile, mdFile] })}\n`);
} catch (err) {
  log(err?.stack ?? String(err));
  process.stdout.write(`${JSON.stringify({ status: "blocked", run, reason: err?.message ?? String(err), ms: Date.now() - t0 })}\n`);
  process.exit(1);
}
process.exit(0);
