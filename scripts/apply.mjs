#!/usr/bin/env node
// The runner (PLAN §2.2), all eleven steps:
//
//   node scripts/apply.mjs --url <posting> [--json]              plan, fill what is resolved, ask the rest
//   node scripts/apply.mjs --url <posting> --answers a.json      re-attach to the tab and finish
//   node scripts/apply.mjs --tab                                 the ATS tab you are looking at
//   node scripts/apply.mjs --queue 3 [--answers a.json]          the pipeline's shortlist, one batch of questions
//   node scripts/apply.mjs --resume <slug>                       every field that is not on the form yet
//   node scripts/apply.mjs --schema <recorded.json> --dry-run    offline, no browser
//
// Steps 1–7 are HTTP + Jev; no browser is touched until the plan exists. Step 8 fills every
// resolved field *before* the questions are returned (D13), step 9 asks once, step 11 verifies and
// writes `applications/<slug>/{decisions.json, trace.jsonl, summary.md}`.
//
// One JSON object on stdout, the Decision table and every log line on stderr, exit 0 for all three
// statuses (`ready_to_submit` · `needs_user` · `blocked{reason}`); exit 1 only for a usage error.
// Submit is never clicked (D8) and the filled tab outlives this process — the runner disconnects
// from Chrome, it never closes it (D12).

import path from "node:path";

import { atsFromUrl, snapshotRequired, waitForForm } from "../src/browser/adapters/index.mjs";
import { connect, disconnect } from "../src/browser/chrome.mjs";
import { appendTrace } from "../src/browser/trace.mjs";
import { closeJevClient, usageTotals as jevSpend } from "../src/jev/client.mjs";
import { loadCanon, planWithJev } from "../src/jev/plan.mjs";
import { loadBaselines, loadMemory } from "../src/memory/store.mjs";
import { loadPipeline, nextQueued, setStatus } from "../src/pipeline/store.mjs";
import { loadFormPlan, recordSchema } from "../src/schema/index.mjs";
import {
  applicationSlug,
  applyAnswers,
  finalize,
  freeze,
  load as loadFrozen,
  matchesForm,
  mergedNeedsUser,
  needsUser,
  readAnswersFile,
  routeAnswers,
  tally,
  unfilled,
  withOptions,
  writeSummary,
} from "../src/plan/decisions.mjs";
import { Blocked, attachPosting, activeAtsTab, newBudget, runBrowser } from "../src/plan/execute.mjs";
import { resolveForm } from "../src/plan/resolve.mjs";
import { costLine, deltaUsage, newPhases, renderSummary, timed, usageReport } from "../src/plan/summary.mjs";
import { usageTotals as writerSpend } from "../src/writer/openai.mjs";

const USAGE = [
  "usage: apply.mjs --url <posting> | --tab | --queue <n> | --resume <slug> | --schema <file>",
  "       [--answers <file>] [--dry-run] [--record-schema] [--json]",
].join("\n");

// ─── args ─────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dryRun: false, recordSchema: false, json: false, tab: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--url") args.url = next();
    else if (arg === "--schema") args.schema = next();
    else if (arg === "--answers") args.answers = next();
    else if (arg === "--resume") args.resume = next();
    else if (arg === "--queue") args.queue = Number(next());
    else if (arg === "--tab") args.tab = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--record-schema") args.recordSchema = true;
    else if (arg === "--json") args.json = true;
    else throw new Error(`unknown flag ${arg}`);
  }
  const targets = ["url", "schema", "resume", "queue"].filter((k) => args[k] != null).concat(args.tab ? ["tab"] : []);
  if (!targets.length) throw new Error("need --url <posting>, --tab, --queue <n>, --resume <slug> or --schema <file>");
  if (targets.length > 1 && !(targets.length === 2 && args.resume && args.answers)) {
    throw new Error(`pick one target, not ${targets.map((t) => `--${t}`).join(" + ")}`);
  }
  if (args.queue != null && (!Number.isInteger(args.queue) || args.queue < 1)) throw new Error("--queue takes a positive integer");
  if (args.recordSchema && !args.url) throw new Error("--record-schema needs --url");
  return args;
}

// ─── steps 1–7: the plan (no browser) ─────────────────────────────────────────────────────────

const ZERO_JEV = { requests: 0, ms: 0, usage: { input_tokens: 0, output_tokens: 0 }, stages: [] };

async function loadStores() {
  const [mem, baselines, pipeline, canon] = await Promise.all([loadMemory(), loadBaselines(), loadPipeline(), loadCanon()]);
  return { mem, baselines, pipeline, canon };
}

/**
 * The URL whose tab the runner fills. An Ashby posting link and its application link name the
 * same posting — the schema fetch takes either — but the form only exists on `/application`, and
 * `formPlan.url` is what `openTab`/`findTab` navigate to. Pipeline entries carry the posting link.
 */
function applyUrl(source) {
  const m = /^(https?:\/\/jobs\.ashbyhq\.com\/[^/?#]+\/[0-9a-f-]{36})(?:\/application)?\/?$/i.exec(String(source ?? ""));
  return m ? `${m[1]}/application` : source;
}

/**
 * Steps 1–7 for one posting: schema → FormPlan → deterministic Decisions → Jev requests 1 and 2.
 * `reattach` reuses the frozen plan when it still describes this form, so `--answers` re-plans
 * only what the host just answered instead of paying for the whole form again.
 */
async function planPosting({ source, stores, budget, phases = newPhases(), reattach = false, quiet = false }) {
  const { mem, baselines, pipeline, canon } = stores;
  const formPlan = await timed(phases, "schema", () => loadFormPlan(source));
  const slug = applicationSlug(formPlan);
  const frozen = await loadFrozen(slug);

  // Conditional rows an earlier run discovered on the page are part of this form (step 9).
  const extra = Array.isArray(frozen?.extra) ? frozen.extra : [];
  const known = new Set(formPlan.questions.map((q) => q.qid));
  formPlan.questions.push(...extra.filter((q) => !known.has(q.qid)));

  if (!quiet) {
    log(`${formPlan.ats}: ${formPlan.job.company} — ${formPlan.job.title} · ${formPlan.questions.length} questions · slug ${slug}`);
    log(canon ? `canon: ${canon.questions.length} canonical questions` : "canon: canon/questions.yaml not built yet — saved-item fallback");
  }

  const { decisions: resolved, context } = resolveForm(formPlan, { mem, pipeline, baselines });
  const reuse = reattach && frozen && matchesForm(frozen, formPlan);
  if (reattach && !reuse && !quiet) log("no reusable frozen plan for this form — planning from scratch");

  let decisions = reuse ? mergeFrozen(resolved, frozen.decisions) : resolved;
  let jev = ZERO_JEV;
  if (!reuse) {
    jev = await timed(phases, "plan", () => planWithJev({ formPlan, decisions, mem, context, slug, canon, baselines, pipeline }));
    decisions = jev.decisions;
  }
  budget.spend(jev.requests);
  // `openaiBase` is the writer's counter as this posting starts; `fill()` re-takes it so a queue
  // run bills each posting for its own step-10 drafts and not for the posting filled before it.
  return { formPlan, slug, context, decisions: withOptions(finalize(decisions), formPlan), jev, extra, stored: [], applied: [], phases, openaiBase: writerSpend() };
}

/** Step 9's second half: the host's answers → memory + the `ask` rows, re-planning only those. */
async function applyToPlan(plan, answers, { stores, budget }) {
  const { mem, canon, baselines, pipeline } = stores;
  const out = await applyAnswers(plan.decisions, answers, { formPlan: plan.formPlan, context: plan.context });
  let decisions = out.decisions;
  if (out.reopen.length) {
    const second = await timed(plan.phases, "plan", () =>
      planWithJev({
        formPlan: plan.formPlan,
        decisions,
        mem,
        context: plan.context,
        slug: plan.slug,
        canon,
        baselines,
        pipeline,
      }),
    );
    decisions = second.decisions;
    plan.jev = sumJev(plan.jev, second);
    budget.spend(second.requests);
  }
  plan.decisions = withOptions(finalize(decisions), plan.formPlan);
  plan.stored = out.stored;
  plan.applied = out.applied;
  return { ...out, decisions: plan.decisions };
}

/** Re-attach: the frozen record is the plan; today's resolve pass only supplies the form shape. */
function mergeFrozen(resolved, frozen) {
  const byQid = new Map(frozen.map((d) => [d.qid, d]));
  return resolved.map((d) => ({ ...d, ...(byQid.get(d.qid) ?? {}) }));
}

const sumJev = (a, b) => ({
  requests: a.requests + b.requests,
  ms: a.ms + b.ms,
  usage: {
    input_tokens: a.usage.input_tokens + b.usage.input_tokens,
    output_tokens: a.usage.output_tokens + b.usage.output_tokens,
  },
  stages: [...a.stages, ...b.stages],
});

/**
 * The executor's way back into the planner: a conditional follow-up that only exists once the
 * form is half-filled gets the same deterministic + Jev pass as a question from the schema, so
 * this file never decides an answer itself (PLAN §2.2 step 9).
 */
function replanFor({ plan, stores, budget }) {
  const { mem, baselines, pipeline, canon } = stores;
  return {
    async questions(questions) {
      const synthetic = { ...plan.formPlan, questions };
      const { decisions: resolved } = resolveForm(synthetic, { mem, pipeline, baselines });
      const out = await timed(plan.phases, "plan", () => planWithJev({ formPlan: synthetic, decisions: resolved, mem, context: plan.context, slug: plan.slug, canon, baselines, pipeline }));
      budget.spend(out.requests);
      plan.jev = sumJev(plan.jev, out);
      return withOptions(finalize(out.decisions), synthetic);
    },
  };
}

// ─── steps 8–11: the browser ──────────────────────────────────────────────────────────────────

/**
 * Fill this posting's tab. `attach` re-uses the tab an earlier run left open (`--answers`); a
 * fresh run reloads it instead, so nothing from the previous run can be mistaken for a read-back.
 */
async function fill({ conn, plan, stores, budget, attach }) {
  // Step 10's drafts happen inside `runBrowser`; re-baselining here is what keeps a queue run's
  // per-posting OpenAI figures honest (planning is parallel, filling is sequential).
  plan.openaiBase = writerSpend();
  const replan = replanFor({ plan, stores, budget });
  const args = { context: conn.context, formPlan: plan.formPlan, decisions: plan.decisions, slug: plan.slug, budget, replan };
  return timed(plan.phases, "browser", async () => {
    try {
      return await runBrowser({ ...args, attach });
    } catch (err) {
      if (!(attach && err instanceof Blocked && err.reason === "no_page")) throw err;
      log("no open tab for this posting — opening a fresh one and filling the whole plan");
      return runBrowser({ ...args, attach: false });
    }
  });
}

// ─── the report ───────────────────────────────────────────────────────────────────────────────

/**
 * Freeze, write the summary, and build the one JSON object the host parses (§2.3, §2.6).
 *
 * A `--dry-run` writes neither: it never touched the browser, so its rows carry no read-backs,
 * and overwriting `decisions.json` with them would erase what a live run recorded about the tab
 * that is still open — which is exactly what `--answers` re-attaches against. The trace is still
 * appended: those Jev requests really happened.
 */
async function settle({ plan, started, browser = null, dryRun = false }) {
  const { formPlan, slug, decisions, jev } = plan;
  const counts = tally(decisions);
  const asked = needsUser(decisions, slug);
  const status = asked.questions.length ? "needs_user" : "ready_to_submit";
  const usage = usageFor({ plan, started });
  const summary = renderSummary({ formPlan, decisions, slug, status, usage });
  const extra = dedupeQuestions([...(plan.extra ?? []), ...(browser?.added ?? [])]);

  if (!dryRun) {
    await freeze(slug, decisions, {
      status,
      url: formPlan.url,
      job: formPlan.job.title,
      company: formPlan.job.company,
      requests: jev.requests,
      ...(extra.length ? { extra } : {}),
    });
    await writeSummary(slug, summary);
  }
  await appendTrace(slug, { op: "plan", status, ...counts, requests: jev.requests, ms: Date.now() - started, ...(dryRun ? { dry_run: true } : {}) });
  await appendTrace(slug, { op: "usage", ...usage });

  return {
    status,
    slug,
    url: formPlan.url,
    company: formPlan.job.company,
    title: formPlan.job.title,
    filled: counts.filled,
    ...(browser ? { set: browser.filled, failed: browser.failed, appeared: browser.added.length, tab: formPlan.url } : {}),
    asks: asked.questions,
    checks: decisions.filter((d) => d.action === "check").map((d, i) => ({ handle: `c${i + 1}`, qid: d.qid, label: d.label, value: d.class === "sensitive" ? "••••" : d.option ?? d.value ?? null })),
    drafted: decisions.filter((d) => d.action === "draft").map((d, i) => ({ handle: `d${i + 1}`, qid: d.qid, label: d.label, words: d.words ?? 0, story: d.story ?? null })),
    skipped: counts.skipped,
    remembered: (plan.stored ?? []).map(({ section, row }) => `${section}:${row.id ?? row.qid}`),
    requests: jev.requests,
    usage,
    ms: Date.now() - started,
    summary,
  };
}

const dedupeQuestions = (questions) => [...new Map(questions.map((q) => [q.qid, q])).values()];

/**
 * One posting's spend. Jev comes from the planner's own per-posting tally (exact even when a
 * queue plans four postings at once); OpenAI from the writer's process counter minus this
 * posting's baseline. `--dry-run`, `--resume` and a failure before the plan existed fall back to
 * the process totals, which in those paths *are* the run.
 */
function usageFor({ plan = null, started, phases = null }) {
  return usageReport({
    started,
    phases: plan?.phases ?? phases ?? {},
    jev: plan?.jev ?? jevSpend(),
    openai: deltaUsage(writerSpend(), plan?.openaiBase ?? null),
  });
}

/** Queue mode: the phases are *work* time summed over postings, while `ms_total` stays wall clock. */
function sumPhases(list) {
  const out = newPhases();
  for (const p of list) for (const key of Object.keys(out)) out[key] += p?.[key] ?? 0;
  return out;
}

/** §2.6: `blocked` prints the same header as the summary, plus the reason and the screenshot. */
function blockedReport(err, { plan = null, started = null, phases = null } = {}) {
  const job = plan?.formPlan?.job;
  const header = job ? `${job.company} — ${job.title} · ${plan.formPlan.url}   blocked` : "jev-apply   blocked";
  const reason = err?.reason ?? err?.message ?? String(err);
  const lines = [header, `reason: ${reason}`];
  if (err?.shot) lines.push(`screenshot: ${err.shot}`);
  if (plan?.slug) lines.push(`Run \`apply.mjs --resume ${plan.slug}\` — it lists every field with its intended value.`);
  return {
    status: "blocked",
    reason,
    ...(plan?.slug ? { slug: plan.slug } : {}),
    ...(plan?.formPlan?.url ? { url: plan.formPlan.url } : {}),
    ...(err?.shot ? { screenshot: err.shot } : {}),
    ...(started ? { ms: Date.now() - started } : {}),
    usage: usageFor({ plan, started: started ?? PROCESS_STARTED, phases }),
    detail: err?.message ?? reason,
    summary: lines.join("\n"),
  };
}

// ─── --url / --tab / --schema ─────────────────────────────────────────────────────────────────

async function singleRun(args, stores) {
  const started = Date.now();
  const phases = newPhases();
  const budget = newBudget({ started });
  let conn = null;
  let plan = null;
  let source = args.schema ?? applyUrl(args.url);
  let recorded = null;

  try {
    if (args.tab) {
      conn = await connect({});
      const page = await activeAtsTab(conn.context);
      if (!page) throw new Blocked("no_page", "no Greenhouse or Ashby tab is open in the jev-apply profile");
      source = applyUrl(page.url());
      log(`--tab: ${source}`);
    }
    if (args.recordSchema) {
      recorded = await recordSchema(args.url);
      source = recorded;
      log(`recorded schema → ${path.relative(process.cwd(), recorded)}`);
    }

    const answers = args.answers ? await readAnswersFile(args.answers) : null;
    plan = await planPosting({ source, stores, budget, phases, reattach: Boolean(answers) });
    if (answers) {
      const out = await applyToPlan(plan, answers, { stores, budget });
      log(`answers: applied ${out.applied.length}, ignored ${out.ignored.length}, remembered ${out.stored.length}`);
      for (const { section, row } of out.stored) log(`  remembered ${section}: ${row.id ?? row.qid} (${row.scope ?? "global"})`);
    }

    let browser = null;
    if (!args.dryRun) {
      conn ??= await connect({});
      browser = await fill({ conn, plan, stores, budget, attach: Boolean(answers) });
      log(`browser: set ${browser.filled}, failed ${browser.failed}, required still empty ${browser.state.unfilled.length + browser.state.unknown.length}`);
    }

    const out = await settle({ plan, started, browser, dryRun: args.dryRun });
    if (!args.json) printTable(plan.decisions);
    return { ...out, ...(recorded ? { recorded } : {}) };
  } catch (err) {
    // Every failure is a status the host can act on, with the §2.6 header, the reason and the
    // screenshot — a missing key, a 500 from the board and a dead tab all read the same way.
    log(err?.stack ?? String(err));
    if (plan) await appendTrace(plan.slug, { op: "blocked", reason: err.reason ?? err.message, detail: err.message, ...(err.shot ? { shot: err.shot } : {}) });
    return blockedReport(err, { plan, started, phases });
  } finally {
    if (conn) await disconnect(conn.browser, { port: conn.port });
  }
}

// ─── --queue N ────────────────────────────────────────────────────────────────────────────────

/** Plan all N first, fill all N, ask **once** (PLAN §2.2 last paragraph, §2.5). */
async function queueRun(args, stores) {
  const started = Date.now();
  const entries = await nextQueued(args.queue);
  if (!entries.length) {
    return { status: "blocked", reason: "queue_empty", detail: "nothing is queued — run `pipeline.mjs queue <id> …` first", queue: [], questions: [], usage: usageFor({ started }), ms: Date.now() - started };
  }
  log(`queue: ${entries.length} posting(s) — ${entries.map((e) => e.id).join(", ")}`);
  const answers = args.answers ? await readAnswersFile(args.answers) : null;

  // Steps 1–7 for every posting in parallel. Ashby's schema endpoint 429s above ~6 concurrent
  // requests (PLAN §2.5), so the fan-out is capped rather than unbounded.
  const jobs = await mapLimit(entries, 4, async (entry) => {
    const job = { entry, budget: newBudget({}), plan: null, browser: null, error: null };
    try {
      job.plan = await planPosting({ source: applyUrl(entry.url), stores, budget: job.budget, reattach: Boolean(answers), quiet: true });
      log(`planned ${entry.id}: ${job.plan.formPlan.questions.length} questions, ${job.plan.jev.requests} Jev request(s)`);
    } catch (err) {
      job.error = err;
      log(`planning ${entry.id} failed: ${err.message}`);
    }
    return job;
  });

  const live = () => jobs.filter((j) => j.plan && !j.error);

  // One merged answers file → the rows each posting asked (dedupe by canonical id / label).
  if (answers) {
    const routed = routeAnswers(answers, live().map(({ plan }) => ({ slug: plan.slug, company: plan.formPlan.job.company, decisions: plan.decisions })));
    for (const job of live()) {
      try {
        const out = await applyToPlan(job.plan, routed.get(job.plan.slug) ?? {}, { stores, budget: job.budget });
        log(`answers ${job.entry.id}: applied ${out.applied.length}, remembered ${out.stored.length}`);
      } catch (err) {
        job.error = err;
      }
    }
  }

  let conn = null;
  try {
    if (!args.dryRun && live().length) conn = await connect({});
    for (const job of live()) {
      if (args.dryRun) continue;
      // Per-posting isolation: a dead tab on posting 2 must not cost posting 1 its fill.
      try {
        job.browser = await fill({ conn, plan: job.plan, stores, budget: job.budget, attach: Boolean(answers) });
        log(`filled ${job.entry.id}: set ${job.browser.filled}, failed ${job.browser.failed}`);
      } catch (err) {
        job.error = err;
        log(`${job.entry.id} blocked: ${err.reason ?? err.message}`);
        if (job.plan) await appendTrace(job.plan.slug, { op: "blocked", reason: err.reason ?? err.message, detail: err.message });
      }
    }
  } finally {
    if (conn) await disconnect(conn.browser, { port: conn.port });
  }

  const rows = [];
  const postings = [];
  for (const job of jobs) {
    if (job.error || !job.plan) {
      rows.push({
        id: job.entry.id,
        company: job.entry.company,
        title: job.entry.title,
        url: job.entry.url,
        ...(job.plan ? { slug: job.plan.slug } : {}),
        ...blockedRow(job.error),
      });
      continue;
    }
    const out = await settle({ plan: job.plan, started, browser: job.browser, dryRun: args.dryRun });
    postings.push({ slug: job.plan.slug, company: out.company, decisions: job.plan.decisions });
    rows.push({ id: job.entry.id, slug: out.slug, company: out.company, title: out.title, url: out.url, status: out.status, filled: out.filled, set: out.set ?? 0, asks: out.asks.length, requests: out.requests, usage: out.usage, summary: out.summary });
    if (out.status === "ready_to_submit") {
      await setStatus(job.entry.id, "ready", `jev-apply: filled ${out.filled}/${out.filled + out.asks.length + out.skipped}`).catch((err) => log(`pipeline ${job.entry.id}: ${err.message}`));
    }
  }

  const questions = mergedNeedsUser(postings);
  const status = questions.length ? "needs_user" : rows.every((r) => r.status === "blocked") ? "blocked" : "ready_to_submit";
  // Run-level, from the process counters: the sum of the rows would double-count nothing but is
  // the wrong shape (each row's `ms_*` is that posting's, not the queue's wall clock).
  return {
    status,
    ...(status === "blocked" ? { reason: "every posting blocked" } : {}),
    queue: rows,
    questions,
    requests: jobs.reduce((n, j) => n + (j.plan?.jev.requests ?? 0), 0),
    usage: usageFor({ started, phases: sumPhases(jobs.map((j) => j.plan?.phases)) }),
    ms: Date.now() - started,
  };
}

const blockedRow = (err) => ({ status: "blocked", reason: err?.reason ?? err?.message ?? "unknown", ...(err?.shot ? { screenshot: err.shot } : {}) });

/** Bounded fan-out: the ATS schema endpoints are the constraint, not this process. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ─── --resume SLUG ────────────────────────────────────────────────────────────────────────────

/** What the summary's last line promises: every field that is not on the form, with its value. */
async function resumeRun(args, stores) {
  const started = Date.now();
  const phases = newPhases();
  const frozen = await loadFrozen(args.resume);
  if (!frozen) {
    return { status: "blocked", reason: `no application on file for "${args.resume}"`, detail: "run `apply.mjs --url <posting>` first", usage: usageFor({ started, phases }), ms: Date.now() - started };
  }
  if (args.answers) return singleRun({ ...args, url: frozen.url, resume: undefined }, stores);

  const url = frozen.url;
  const ats = atsFromUrl(url);
  let conn = null;
  let liveRows = null;
  let tab = null;
  await timed(phases, "browser", async () => {
    try {
      conn = await connect({});
      const { page } = await attachPosting(conn.context, url);
      if (page) {
        tab = page.url();
        await waitForForm(page, { ats, timeout: 20000 }).catch(() => {});
        liveRows = await snapshotRequired(page, { ats }).catch(() => null);
      }
    } catch (err) {
      log(`could not attach to the tab: ${err.message}`);
    } finally {
      if (conn) await disconnect(conn.browser, { port: conn.port });
    }
  });

  const rows = unfilled(frozen.decisions, { live: liveRows });
  const asked = needsUser(frozen.decisions, args.resume);
  const stillEmpty = (liveRows ?? []).filter((r) => !r.filled);
  const status = asked.questions.length || stillEmpty.length ? "needs_user" : "ready_to_submit";
  if (!args.json) {
    log("");
    for (const r of rows) log(`${pad(r.qid, 26)} | ${pad(r.label, 40)} | ${pad(r.action, 6)} | ${pad(r.value ?? "", 40)} | ${r.why ?? ""}`);
    log("");
  }
  return {
    status,
    slug: args.resume,
    url,
    company: frozen.company ?? null,
    title: frozen.job ?? null,
    tab,
    unfilled: rows,
    required_empty: stillEmpty.map((r) => ({ qid: r.qid, label: r.label })),
    asks: asked.questions,
    usage: usageFor({ started, phases }),
    ms: Date.now() - started,
  };
}

// ─── the Decision table (stderr) ──────────────────────────────────────────────────────────────

const COLUMNS = [
  ["qid", 26],
  ["label", 38],
  ["source", 8],
  ["value", 28],
  ["conf", 5],
  ["gap", 5],
  ["action", 6],
  ["set", 4],
  ["why", 42],
];

function printTable(decisions) {
  log("");
  log(COLUMNS.map(([name, width]) => pad(name, width)).join(" | "));
  log(COLUMNS.map(([, width]) => "-".repeat(width)).join("-+-"));
  for (const d of decisions) {
    const cells = [
      d.qid,
      d.label,
      d.source,
      // The observed text of an EEO answer *is* the answer: never printed, even to a terminal.
      d.class === "sensitive" ? (d.value || d.option ? "••••" : "") : d.option ?? d.value ?? "",
      fmt(d.confidence),
      fmt(d.gap),
      d.action,
      d.readback ? (d.readback.ok ? "ok" : "fail") : "",
      d.why,
    ];
    log(cells.map((cell, i) => pad(cell, COLUMNS[i][1])).join(" | "));
  }
  log("");
}

const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : "");

function pad(value, width) {
  const text = String(value ?? "").replace(/\s+/g, " ");
  return (text.length > width ? `${text.slice(0, width - 1)}…` : text).padEnd(width);
}

const log = (line) => process.stderr.write(`${line}\n`);

// ─── entry ────────────────────────────────────────────────────────────────────────────────────

/** Wall-clock zero for a failure that happens before any run owns a clock. */
const PROCESS_STARTED = Date.now();

const args = (() => {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (err) {
    log(`${err.message}\n${USAGE}`);
    process.exit(1);
  }
})();

try {
  const stores = await loadStores();
  const out = args.resume ? await resumeRun(args, stores) : args.queue ? await queueRun(args, stores) : await singleRun(args, stores);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.status === "blocked") log(out.summary ?? `blocked: ${out.reason}`);
  else if (out.queue) log(`${out.status}: ${out.queue.length} posting(s), ${out.questions.length} question(s), ${out.requests} Jev request(s), ${out.ms} ms`);
  else if (out.unfilled) log(`${out.status}: ${out.unfilled.length} field(s) not on the form · tab ${out.tab ?? "not open"}`);
  else log(`${out.status}: filled ${out.filled}, asks ${out.asks.length}, checks ${out.checks.length}, drafted ${out.drafted.length}, skipped ${out.skipped}, ${out.requests} Jev request(s), ${out.ms} ms`);
  if (out.usage) log(costLine(out.usage));
} catch (err) {
  // Every failure is a status the host can act on (AGENTS: exit 0 for all three statuses).
  const out = blockedReport(err);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  log(err?.stack ?? String(err));
  log(out.summary);
} finally {
  await closeJevClient().catch(() => {});
}
process.exit(0);
