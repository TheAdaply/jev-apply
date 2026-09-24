#!/usr/bin/env node
// The runner (PLAN §2.2), all eleven steps and — when the user asked for it — the twelfth:
//
//   node scripts/apply.mjs --url <posting> [--json]              plan, fill what is resolved, ask the rest
//   node scripts/apply.mjs --url <posting> --answers a.json      re-attach to the tab and finish
//   node scripts/apply.mjs --tab                                 the ATS tab you are looking at
//   node scripts/apply.mjs --queue 3 [--answers a.json]          the pipeline's shortlist, one batch of questions
//   node scripts/apply.mjs --resume <slug>                       every field that is not on the form yet
//   node scripts/apply.mjs --schema <recorded.json> --dry-run    offline, no browser
//   node scripts/apply.mjs --url <posting> --dry-run --detect-submit
//                                                                which button Submit *would* click, no click
//
// Steps 1–7 are HTTP + Jev; no browser is touched until the plan exists. Step 8 fills every
// resolved field *before* the questions are returned (D13), step 9 asks once, step 11 verifies and
// writes `applications/<slug>/{decisions.json, trace.jsonl, summary.md}`.
//
// Step 12 is Submit, and it exists only because the user turned it on: with `p.auto_submit` true
// for this company (or `--submit` for one run), nothing left to ask and no required control still
// empty, the runner clicks Submit and waits for the board's own confirmation. Without that
// preference — and with `--no-submit` — the terminal state is still `ready_to_submit` and the
// user clicks it themselves.
//
// One JSON object on stdout, the Decision table and every log line on stderr, exit 0 for all four
// statuses (`submitted` · `ready_to_submit` · `needs_user` · `blocked{reason}`); exit 1 only for a
// usage error. A submit that the board never confirms is `blocked{reason:"submit_failed"}`, never
// a success. The filled tab outlives this process either way — the runner disconnects from
// Chrome, it never closes it (D12).

import path from "node:path";

import { atsFromUrl, snapshotRequired, waitForForm } from "../src/browser/adapters/index.mjs";
import { connect, disconnect } from "../src/browser/chrome.mjs";
import { appendTrace } from "../src/browser/trace.mjs";
import { closeJevClient, usageTotals as jevSpend } from "../src/jev/client.mjs";
import { loadCanon, planWithJev } from "../src/jev/plan.mjs";
import { loadBaselines, loadMemory } from "../src/memory/store.mjs";
import { canTransition, loadPipeline, nextQueued, setStatus } from "../src/pipeline/store.mjs";
import { loadFormPlan, recordSchema } from "../src/schema/index.mjs";
import {
  applicationSlug,
  applyAnswers,
  finalize,
  freeze,
  load as loadFrozen,
  formFingerprint,
  matchesForm,
  mergedNeedsUser,
  needsUser,
  readAnswersFile,
  routeAnswers,
  tally,
  unfilled,
  refillGuard,
  withFormFacts,
  writeSummary,
} from "../src/plan/decisions.mjs";
import { acceptHostDrafts, draftFor, draftRows, hostDraftAsks } from "../src/plan/draft.mjs";
import { inferRows, inferredRows, persistInferred } from "../src/plan/infer.mjs";
import {
  Blocked,
  attachPosting,
  activeAtsTab,
  autoSubmitOn,
  boardAdapter,
  detectSubmit,
  newBudget,
  priorSubmit,
  runBrowser,
  submitApplication,
  submitObstruction,
  submitOutcome,
  submitReadiness,
} from "../src/plan/execute.mjs";
import { preflight, preflightLines, submitGate } from "../src/plan/preflight.mjs";
import { resolveForm } from "../src/plan/resolve.mjs";
import { resolvePreference } from "../src/memory/resolve.mjs";
import { normalizeUrl } from "../src/discover/dedupe.mjs";
import { costLine, deltaUsage, newPhases, renderSummary, timed, usageReport } from "../src/plan/summary.mjs";
import { usageTotals as writerSpend } from "../src/writer/openai.mjs";

const USAGE = [
  "usage: apply.mjs --url <posting> | --tab | --queue <n> | --resume <slug> | --schema <file>",
  "       [--answers <file>] [--dry-run] [--record-schema] [--json]",
  "       [--submit | --no-submit] [--detect-submit] [--preflight] [--refill] [--no-infer]",
].join("\n");

// ─── args ─────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  // `submit: null` is "ask the user's `p.auto_submit`"; the two flags force it for one run.
  const args = { dryRun: false, recordSchema: false, json: false, tab: false, submit: null, detectSubmit: false, preflight: false, infer: true };
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
    else if (arg === "--refill") args.refill = true;
    else if (arg === "--submit") args.submit = true;
    else if (arg === "--no-submit") args.submit = false;
    else if (arg === "--detect-submit") args.detectSubmit = true;
    else if (arg === "--preflight") args.preflight = true;
    // The evidence tier (`src/plan/infer.mjs`) off for one run: every row it would have answered
    // from saved evidence goes back to being an `ask`, which is what this runner did before it.
    else if (arg === "--no-infer") args.infer = false;
    else throw new Error(`unknown flag ${arg}`);
  }
  const targets = ["url", "schema", "resume", "queue"].filter((k) => args[k] != null).concat(args.tab ? ["tab"] : []);
  if (!targets.length) throw new Error("need --url <posting>, --tab, --queue <n>, --resume <slug> or --schema <file>");
  if (targets.length > 1 && !(targets.length === 2 && args.resume && args.answers)) {
    throw new Error(`pick one target, not ${targets.map((t) => `--${t}`).join(" + ")}`);
  }
  if (args.queue != null && (!Number.isInteger(args.queue) || args.queue < 1)) throw new Error("--queue takes a positive integer");
  if (args.recordSchema && !args.url) throw new Error("--record-schema needs --url");
  if (args.detectSubmit && args.submit === true) throw new Error("--detect-submit never clicks; drop --submit");
  if (args.detectSubmit && (args.queue != null || args.resume)) throw new Error("--detect-submit takes one posting: use --url or --tab");
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
 * Steps 1–7 for one posting: schema → FormPlan → deterministic Decisions → Jev requests 1 and 2 →
 * the evidence tier over whatever is still an `ask` (step 6½, `src/plan/infer.mjs`).
 * `reattach` reuses the frozen plan when it still describes this form, so `--answers` re-plans
 * only what the host just answered instead of paying for the whole form again.
 */
async function planPosting({ source, stores, budget, phases = newPhases(), reattach = false, quiet = false, infer = true }) {
  const { mem, baselines, pipeline, canon } = stores;
  const formPlan = await timed(phases, "schema", () => loadFormPlan(source));
  // The form as the board publishes it (B1), taken before stored conditional rows are merged in
  // and before the fill loop corrects any row's control to what the page renders.
  const form = formFingerprint(formPlan);
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
    // Step 6½ — the rows every stage above left open, answered from saved evidence where the
    // evidence justifies one exact answer. Two requests at most, and `--no-infer` skips it.
    if (infer) {
      const tier = await timed(phases, "plan", () => inferRows({ formPlan, decisions, mem, context, slug, pipeline }));
      decisions = tier.decisions;
      jev = sumJev(jev, tier);
      if (!quiet && (tier.inferred.length || tier.requests)) {
        log(`infer: ${tier.inferred.length} row(s) answered from evidence in ${tier.requests} request(s)${tier.inferred.length ? ` — ${tier.inferred.map((r) => `${r.qid} (${r.topic ?? "no topic"}, justified ${r.justified})`).join(", ")}` : ""}`);
      }
    }
  }
  budget.spend(jev.requests);
  // `openaiBase` is the writer's counter as this posting starts; `fill()` re-takes it so a queue
  // run bills each posting for its own step-10 drafts and not for the posting filled before it.
  // `finalize` is handed memory and the posting's context: that is what turns a `why_us`/essay
  // row into `action:"draft"` when `p.auto_draft` is on, instead of handing it back to the user.
  const settled = finalize(decisions, { mem, context });
  return { formPlan, form, slug, context, decisions: withFormFacts(settled, formPlan), jev, extra, stored: [], applied: [], phases, openaiBase: writerSpend() };
}

/** Step 9's second half: the host's answers → memory + the `ask` rows, re-planning only those. */
async function applyToPlan(plan, answers, { stores, budget }) {
  const { mem, canon, baselines, pipeline } = stores;
  const out = await applyAnswers(plan.decisions, answers, { formPlan: plan.formPlan, context: plan.context, documents: mem.documents });
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
  plan.decisions = withFormFacts(finalize(decisions, { mem, context: plan.context }), plan.formPlan);
  plan.stored = out.stored;
  plan.applied = out.applied;
  return { ...out, decisions: plan.decisions };
}

/**
 * The half of `--answers` that is a draft the host agent wrote, because no writer model is
 * configured (src/writer/backend.mjs `host`). Checked against the grounding the row was handed —
 * the limit, `groundingCheck` and `substitutionCheck` — and filled as a `draft`, so the summary
 * still lists it under ► DRAFTED. What it returns is the rest of the answers, for `applyToPlan`.
 */
async function takeHostDrafts(plan, answers, { stores, args }) {
  const out = await acceptHostDrafts({
    decisions: plan.decisions,
    answers,
    pipeline: stores.pipeline,
    company: plan.formPlan?.job?.company ?? plan.context?.company ?? null,
    dry: Boolean(args.dryRun),
    slug: plan.slug,
    jev: plan.jev,
    onLog: log,
  });
  if (out.accepted.length) log(`drafts from you: ${out.accepted.length} accepted, ${out.refused.length} refused`);
  return out;
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
 *
 * The evidence tier deliberately does not run here. A row that mounts mid-fill is a conditional
 * child ("If yes, please explain"), which is the parent's answer to elaborate on rather than
 * anything saved evidence settles — and the tier's two-request budget is per posting, not per
 * re-plan.
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
      return withFormFacts(finalize(out.decisions, { mem, context: plan.context }), synthetic);
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
  const draft = draftFor({ plan, stores, onLog: log });
  const args = { context: conn.context, formPlan: plan.formPlan, decisions: plan.decisions, slug: plan.slug, budget, replan, draft };
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

// ─── step 12: submit, when the user turned it on ──────────────────────────────────────────────

/**
 * Does this posting get submitted? `--no-submit` / `--submit` force one run; otherwise it is the
 * user's own `p.auto_submit` preference, resolved company > role_family > global like every other
 * preference. Absent, unparseable or false means **no** — auto-submit is opt-in, and a missing
 * preference is never read as consent (AGENTS.md: no personal decision is ever defaulted).
 */
function submitWanted(args, plan, stores) {
  if (args.detectSubmit) return { on: false, why: "--detect-submit (never clicks)" };
  if (args.submit === false) return { on: false, why: "--no-submit" };
  if (args.submit === true) return { on: true, why: "--submit" };
  const pref = resolvePreference(stores.mem, "p.auto_submit", {
    company: plan.context?.company,
    role_family: plan.context?.role_family,
  });
  if (!pref) return { on: false, why: "no p.auto_submit on file" };
  const on = autoSubmitOn(pref.value);
  return { on, why: `p.auto_submit=${on ? "yes" : "no"} (${pref.scope})` };
}

/**
 * Click Submit for this posting, or say why not. Returns null when the run was never going to
 * submit — `settle` then reports `ready_to_submit` exactly as it did before this step existed.
 */
async function maybeSubmit({ plan, browser, stores, args }) {
  if (!browser?.page) return null;
  const want = submitWanted(args, plan, stores);
  if (!want.on) {
    log(`submit: not this run (${want.why})`);
    return null;
  }
  // A board whose Submit is gated by a challenge only a person may answer is never clicked,
  // whatever `p.auto_submit` or `--submit` say: it stops at ready_to_submit.
  const human = boardAdapter(plan.formPlan.ats).HUMAN_SUBMIT;
  if (human) {
    log(`submit: held (${want.why}) — ${human}`);
    return null;
  }
  const readiness = submitReadiness({ decisions: plan.decisions, state: browser.state });
  if (!readiness.ready) {
    log(
      `submit: held (${want.why}) — ${readiness.asks} question(s) for you` +
        `${readiness.sensitive ? ` (${readiness.sensitive} demographic)` : ""}, ${readiness.required_empty} required control(s) still empty`,
    );
    return null;
  }
  // Never twice. `priorSubmit` reads both the frozen record and the trace's pre-click `attempt`
  // row, because a run killed during the 45 s confirmation wait never reaches `settle()` — the
  // click landed, `decisions.json` says nothing, and only `trace.jsonl` remembers. Re-filling
  // that posting with `--answers` and clicking again would send a second application, which no
  // user can take back. A failure that never reached the button (`submit_not_found`) writes
  // neither marker and stays retryable.
  const prior = await priorSubmit(plan.slug, await loadFrozen(plan.slug));
  if (prior.attempted) {
    log(`submit: refused — ${plan.slug} already has a submit on record (${prior.confirmed ? "confirmed" : "clicked, never confirmed"}, per ${prior.sources.join(" + ")}); check the tab before trying again`);
    return null;
  }
  // The last gate (src/plan/preflight.mjs). `submitReadiness` above counts what is *open*; this
  // reads what is *on the form*: a demographic answered from something that is not the user's own
  // `p.eeo`, an attestation ticked from the answer bank, an unchecked draft, a work mode in a
  // geocoder, a conditional child answered under a No, a failed read-back. None of those is a
  // reason to stop filling — every one of them is a reason not to send. The live snapshot is
  // handed over too, so "required and empty" is the page's own reading and not the plan's hope,
  // and so is the submit control's own geometry: a button under the board's cookie card takes a
  // click that never reaches it (B12).
  const obstruction = await submitObstruction({ page: browser.page, ats: plan.formPlan.ats, formPlan: plan.formPlan }).catch(() => null);
  const gate = submitGate({
    decisions: plan.decisions,
    questions: plan.formPlan.questions,
    mem: stores.mem,
    live: browser.state,
    submit: obstruction,
  });
  if (!gate.ok) {
    for (const line of preflightLines(gate.report)) log(line);
    log(`submit: refused by the preflight — ${gate.report.failures.length} rule failure(s), nothing was clicked`);
    await appendTrace(plan.slug, { op: "submit", stage: "preflight", clicked: false, failures: gate.report.failures.map((f) => ({ rule: f.rule, qid: f.qid })) });
    return gate.refusal;
  }
  log(`submit: preflight clear (${gate.report.checked.length} rules${gate.report.unchecked.length ? `, ${gate.report.unchecked.length} not checkable` : ""})`);
  log(`submit: ${want.why} — clicking Submit and waiting for the board's confirmation`);
  const result = await timed(plan.phases, "browser", () =>
    submitApplication({ page: browser.page, ats: plan.formPlan.ats, formPlan: plan.formPlan, slug: plan.slug }),
  );
  log(
    result.ok
      ? `submit: confirmed (${result.confirmation.strategy}) in ${Math.round(result.ms / 1000)}s`
      : `submit: NOT confirmed (${result.cause}) — ${result.detail}`,
  );
  return result;
}

/**
 * The pipeline entry this posting is, if it is one. `--url` names a posting the pipeline may know
 * under its own (non-application) link, so both forms of both URLs are compared normalised.
 */
function pipelineIdFor(pipeline, url) {
  const want = new Set([normalizeUrl(url), normalizeUrl(applyUrl(url))].filter(Boolean));
  if (!want.size) return null;
  for (const job of pipeline?.jobs ?? []) {
    const mine = [normalizeUrl(job.url), normalizeUrl(applyUrl(job.url))].filter(Boolean);
    if (mine.some((u) => want.has(u))) return job.id;
  }
  return null;
}

/**
 * A submitted application is `applied` in the pipeline — the one status the user never types.
 * `found → applied` is not a legal move (src/pipeline/status.mjs), so a posting the user never
 * queued is stepped through `ready` first. A pipeline write never turns a confirmed submission
 * into a failure: every error is logged and swallowed.
 */
async function markApplied(stores, { id = null, url = null, note }) {
  const entry = id ?? pipelineIdFor(stores.pipeline, url);
  if (!entry) return null;
  const from = (stores.pipeline?.jobs ?? []).find((j) => j.id === entry)?.status ?? null;
  try {
    if (from && !canTransition(from, "applied")) await setStatus(entry, "ready", note);
    await setStatus(entry, "applied", note);
    log(`pipeline: ${entry} ${from ?? "?"} → applied`);
    return entry;
  } catch (err) {
    log(`pipeline ${entry}: ${err.message}`);
    return null;
  }
}

// ─── the report ───────────────────────────────────────────────────────────────────────────────

/**
 * Freeze, write the summary, and build the one JSON object the host parses (§2.3, §2.6).
 *
 * A `--dry-run` writes neither: it never touched the browser, so its rows carry no read-backs,
 * and overwriting `decisions.json` with them would erase what a live run recorded about the tab
 * that is still open — which is exactly what `--answers` re-attaches against. The trace is still
 * appended: those Jev requests really happened.
 *
 * `submit` is the step-12 result when there was one. A confirmed submit is the terminal
 * `submitted`; a submit the board never confirmed is `blocked{reason:"submit_failed"}` — frozen
 * and summarised like any other run, because the tab is still open and `--resume <slug>` is how
 * the user finishes it by hand.
 */
async function settle({ plan, started, browser = null, dryRun = false, submit = null }) {
  const { formPlan, slug, decisions, jev } = plan;
  const counts = tally(decisions);
  const asked = needsUser(decisions, slug);
  // A row nobody could write for the user carries what it takes to write it: the prompt, the
  // grounding and the field's limit (src/plan/draft.mjs `hostDraftAsks`).
  const questions = hostDraftAsks(asked.questions, decisions);
  // A submit the preflight refused never reached the button, so it is not a `submit_failed`:
  // it is `blocked{reason:"preflight"}` carrying the rules that refused it, and the record stays
  // retryable (`clicked:false` → `priorSubmit` still says "never attempted").
  const outcome =
    submit?.cause === "preflight"
      ? { status: "blocked", reason: "preflight", detail: submit.detail, failures: submit.preflight.failures }
      : submitOutcome(submit);
  const status = outcome?.status ?? (questions.length ? "needs_user" : "ready_to_submit");
  const usage = usageFor({ plan, started });
  const summary = renderSummary({ formPlan, decisions, slug, status, usage, submit });
  const extra = dedupeQuestions([...(plan.extra ?? []), ...(browser?.added ?? [])]);

  if (!dryRun) {
    await freeze(slug, decisions, {
      status,
      url: formPlan.url,
      job: formPlan.job.title,
      company: formPlan.job.company,
      requests: jev.requests,
      // The identity of the form these rows were filled against (B1). `refillGuard` reads it on
      // the next run and refuses to throw away a reviewed fill for a page that has changed.
      form: plan.form ?? formFingerprint(formPlan),
      // `submit_attempted` is the double-submit guard's memory: true once the button was
      // actually clicked, whatever the board then said (PLAN §2.2 step 12).
      ...(submit
        ? {
            submitted: submit.ok === true,
            submit_attempted: submit.clicked === true,
            ...(submit.ok
              ? { confirmation: submit.confirmation }
              : submit.cause === "preflight"
                ? { submit_refused: "preflight", preflight: submit.preflight.failures }
                : { submit_failed: submit.detail ?? submit.cause ?? true }),
          }
        : {}),
      ...(extra.length ? { extra } : {}),
    });
    await writeSummary(slug, summary);
    // An inference is worth paying for once. Each row the tier answered this run is filed as an
    // `answers` row keyed by its topic (`source: "inferred"`, so a later `remember.mjs` statement
    // overwrites it and never the other way round), and the next form that asks the same thing
    // replays it with no model at all (`storedInference`). A dry run writes none of this: it
    // touches no user data, here or anywhere else.
    const saved = await persistInferred(decisions, plan.context);
    for (const qid of saved.saved) log(`inferred → remembered answers:${qid}`);
  }
  await appendTrace(slug, { op: "plan", status, ...counts, requests: jev.requests, ms: Date.now() - started, ...(dryRun ? { dry_run: true } : {}) });
  await appendTrace(slug, { op: "usage", ...usage });

  return {
    status,
    ...(outcome && !submit.ok
      ? {
          reason: outcome.reason,
          ...(outcome.screenshot ? { screenshot: outcome.screenshot } : {}),
          ...(outcome.failures ? { failures: outcome.failures } : {}),
          detail: outcome.detail,
        }
      : {}),
    ...(submit?.ok ? { confirmation: submit.confirmation } : {}),
    slug,
    url: formPlan.url,
    company: formPlan.job.company,
    title: formPlan.job.title,
    filled: counts.filled,
    ...(browser ? { set: browser.filled, failed: browser.failed, appeared: browser.added.length, tab: formPlan.url } : {}),
    asks: questions,
    checks: decisions.filter((d) => d.action === "check").map((d, i) => ({ handle: `c${i + 1}`, qid: d.qid, label: d.label, value: d.class === "sensitive" ? "••••" : d.option ?? d.value ?? null })),
    // Every row the evidence tier answered, with the reading behind it — the value itself is
    // already in `checks` above (an inferred row is always a `check`), so this block is about
    // provenance: which topic, what shape of value, which saved items, how sure the
    // justification was.
    inferred: inferredRows(decisions).map((d, i) => ({
      handle: `i${i + 1}`,
      qid: d.qid,
      label: d.label,
      topic: d.inference?.topic ?? null,
      kind: d.option != null ? "option" : valueKind(d.value),
      evidence: d.inference?.evidence ?? [],
      justified: d.inference?.justified ?? null,
      ...(d.inference?.replayed ? { replayed: true } : {}),
    })),
    // The draft itself, clipped: it is the one value in this report the user did not write, so
    // "190 words" alone is not enough to decide whether to keep it, and a `--dry-run` says
    // outright that the text was never typed into the form.
    drafted: decisions
      .filter((d) => d.action === "draft")
      .map((d, i) => ({
        handle: `d${i + 1}`,
        qid: d.qid,
        label: d.label,
        words: d.words ?? 0,
        story: d.story ?? null,
        ...(d.dry ? { dry: true } : {}),
        text: typeof d.value === "string" ? d.value.slice(0, 600) : null,
      })),
    skipped: counts.skipped,
    remembered: (plan.stored ?? []).map(({ section, row }) => `${section}:${row.id ?? row.qid}`),
    requests: jev.requests,
    usage,
    ms: Date.now() - started,
    summary,
  };
}

/** The *shape* of an inferred value, for a report that must not transcribe personal values. */
function valueKind(value) {
  const v = String(value ?? "");
  if (!v) return "none";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return "date";
  if (/^\d+(?:\.\d+)?$/.test(v)) return "number";
  return v.includes(" ") ? "text" : "word";
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
    plan = await planPosting({ source, stores, budget, phases, reattach: Boolean(answers), infer: args.infer });
    if (answers) {
      // A row the host agent was asked to write comes back as text, not as an `ask`: it is
      // checked against its own grounding and filled as a `draft` (src/plan/draft.mjs).
      const host = await takeHostDrafts(plan, answers, { stores, args });
      const out = await applyToPlan(plan, host.answers, { stores, budget });
      log(`answers: applied ${out.applied.length}, ignored ${out.ignored.length}, remembered ${out.stored.length}`);
      for (const { section, row } of out.stored) log(`  remembered ${section}: ${row.id ?? row.qid} (${row.scope ?? "global"})`);
    }

    // `--detect-submit` is the dry check: the tab is opened read-only, nothing is filled and
    // nothing is clicked. It is the only submit path that is safe against a real posting.
    let detected = null;
    if (args.detectSubmit) {
      conn ??= await connect({});
      detected = await timed(plan.phases, "browser", () => detectSubmit({ context: conn.context, formPlan: plan.formPlan, slug: plan.slug }));
      log(
        detected.would_click
          ? `submit control: ${detected.would_click.selector} "${detected.would_click.text}" (${detected.would_click.found_by}) — not clicked`
          : "submit control: none found by this ATS's rules — not clicked",
      );
      log(`confirmation strategy: ${detected.confirmation.strategy}`);
    }

    let browser = null;
    let submit = null;
    if (args.dryRun) {
      // A dry run drafts too, and says so. Step 10 is the only part of the plan whose output the
      // user cannot predict from the Decision table, so a `--dry-run` that skipped it would show
      // a `draft` row with nothing in it — which reads as "the writer failed", not "not typed".
      plan.openaiBase = writerSpend();
      await draftRows({
        formPlan: plan.formPlan,
        decisions: plan.decisions,
        slug: plan.slug,
        jev: plan.jev,
        mem: stores.mem,
        context: plan.context,
        pipeline: stores.pipeline,
        dry: true,
        onLog: log,
      });
      // The dry pass is where a `host` backend hands a row over, so the host's own text for a
      // row *this* run just handed over is accepted right after it.
      if (answers) await takeHostDrafts(plan, answers, { stores, args });
    } else {
      // B1 — plan-vs-DOM identity. A `--url` run re-opens the tab, *reloads* it and re-fills
      // from scratch; when the board has changed the form since the fill that was reviewed, that
      // re-fill silently discards it. `--answers` re-attaches to the tab that already holds the
      // reviewed state instead, so it is the re-fill — and only the re-fill — that is gated.
      // `--refill` is the user saying to do it anyway.
      const guard = answers ? { ok: true, detail: null } : refillGuard({ frozen: await loadFrozen(plan.slug), formPlan: plan.formPlan, form: plan.form, refill: args.refill });
      if (!guard.ok) {
        log(`refill: refused — ${guard.detail}`);
        await appendTrace(plan.slug, { op: "blocked", reason: guard.reason, detail: guard.detail });
        return blockedReport({ reason: guard.reason, message: guard.detail }, { plan, started, phases });
      }
      if (guard.detail) log(`refill: ${guard.detail}`);
      conn ??= await connect({});
      browser = await fill({ conn, plan, stores, budget, attach: Boolean(answers) });
      log(`browser: set ${browser.filled}, failed ${browser.failed}, required still empty ${browser.state.unfilled.length + browser.state.unknown.length}`);
      submit = await maybeSubmit({ plan, browser, stores, args });
    }

    const out = await settle({ plan, started, browser, dryRun: args.dryRun, submit });
    if (out.status === "submitted") {
      await markApplied(stores, { url: plan.formPlan.url, note: `jev-apply: submitted, ${out.confirmation?.strategy ?? "confirmed"}` });
    }
    // `--preflight`: the same verdict the submit gate reaches, printed instead of acted on. On a
    // dry run there is no page, so the required-control rules read the plan rather than the DOM
    // and say so in `unchecked` — a dry preflight is a rehearsal, not a clearance.
    const checkedOut = args.preflight
      ? preflight({ decisions: plan.decisions, questions: plan.formPlan.questions, mem: stores.mem, live: browser?.state ?? null })
      : null;
    if (checkedOut) for (const line of preflightLines(checkedOut)) log(line);
    if (!args.json) printTable(plan.decisions);
    return {
      ...out,
      ...(checkedOut ? { preflight: checkedOut } : {}),
      ...(detected ? { submit: detected } : {}),
      ...(recorded ? { recorded } : {}),
    };
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
    const job = { entry, budget: newBudget({}), plan: null, browser: null, submit: null, error: null };
    try {
      job.plan = await planPosting({ source: applyUrl(entry.url), stores, budget: job.budget, reattach: Boolean(answers), quiet: true, infer: args.infer });
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
        const mine = routed.get(job.plan.slug) ?? {};
        const host = await takeHostDrafts(job.plan, mine, { stores, args });
        const out = await applyToPlan(job.plan, host.answers, { stores, budget: job.budget });
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
        // Same identity gate as `singleRun`: a queued posting whose form changed since the fill
        // that was reviewed is not re-filled from scratch without being asked (B1).
        const guard = answers
          ? { ok: true, detail: null }
          : refillGuard({ frozen: await loadFrozen(job.plan.slug), formPlan: job.plan.formPlan, form: job.plan.form, refill: args.refill });
        if (!guard.ok) {
          job.error = new Blocked(guard.reason, guard.detail);
          log(`${job.entry.id} blocked: ${guard.detail}`);
          await appendTrace(job.plan.slug, { op: "blocked", reason: guard.reason, detail: guard.detail });
          continue;
        }
        job.browser = await fill({ conn, plan: job.plan, stores, budget: job.budget, attach: Boolean(answers) });
        log(`filled ${job.entry.id}: set ${job.browser.filled}, failed ${job.browser.failed}`);
        // Submit as each posting completes, not after the whole queue: the merged `needs_user`
        // below is about the postings that still have questions, and a finished one should not
        // wait on them.
        job.submit = await maybeSubmit({ plan: job.plan, browser: job.browser, stores, args });
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
    const out = await settle({ plan: job.plan, started, browser: job.browser, dryRun: args.dryRun, submit: job.submit });
    postings.push({ slug: job.plan.slug, company: out.company, decisions: job.plan.decisions });
    rows.push({ id: job.entry.id, slug: out.slug, company: out.company, title: out.title, url: out.url, status: out.status, filled: out.filled, set: out.set ?? 0, asks: out.asks.length, requests: out.requests, usage: out.usage, summary: out.summary, ...(out.status === "submitted" ? { confirmation: out.confirmation } : {}), ...(out.status === "blocked" ? { reason: out.reason } : {}) });
    if (out.status === "submitted") {
      await markApplied(stores, { id: job.entry.id, note: `jev-apply: submitted, ${out.confirmation?.strategy ?? "confirmed"}` });
    } else if (out.status === "ready_to_submit") {
      await setStatus(job.entry.id, "ready", `jev-apply: filled ${out.filled}/${out.filled + out.asks.length + out.skipped}`).catch((err) => log(`pipeline ${job.entry.id}: ${err.message}`));
    }
  }

  // `mergedNeedsUser` ids a question `<slug>:<qid>`; the drafting rows are matched on that same
  // id so a queue's `draft` items carry their prompt and grounding too.
  const questions = hostDraftAsks(
    mergedNeedsUser(postings),
    postings.flatMap(({ slug, decisions }) => decisions.filter((d) => d.host_draft).map((d) => ({ qid: `${slug}:${d.qid}`, host_draft: d.host_draft }))),
  );
  const status = questions.length
    ? "needs_user"
    : rows.every((r) => r.status === "blocked")
      ? "blocked"
      : rows.every((r) => r.status === "submitted")
        ? "submitted"
        : "ready_to_submit";
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
