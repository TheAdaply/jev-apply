// `--exercise-controls`: drive the widgets the runner never reached, on purpose.
//
// The benchmark's per-control table only reports widgets the *fill loop* actually drove. A row
// that resolved to `ask` or `skip` before the adapter ran leaves its control untested — which is
// why round one reported `attempts 0` for `date`, `number`, `checkbox_group`, `multi_select`,
// `hear_about` and `yesno_buttons` even though eleven postings render them. Zero attempts is not
// a pass; it is a hole in the measurement, and the adapter branch behind it is unproven.
//
// This pass closes that hole and nothing else. After the child has finished and the normal
// numbers have been taken, it re-attaches to the posting's tab and drives every *remaining* row
// with a value the **bench** chose, purely so the widget mechanics are exercised:
//
//   option control   one Choice over the options the widget is showing live, asking Jev for the
//                    most generic, non-committal one — with `none_of_these` (AGENTS.md) and the
//                    SDK's own validation. A placeholder pick is refused, as everywhere else.
//   multi-select     the first two non-placeholder live options.
//   date/number/text a fixed bench value (`2026-12-01` / `5` / `bench`).
//
// Four rules keep this from contaminating anything:
//   1. **Never a fill.** Every result is recorded as `exercised`, with its own ok/fail counts per
//      control type. The `filled` number in the report is taken before this pass runs and is
//      never touched by it; the trace rows it writes carry `bench_exercise: true` and
//      `src/bench/metrics.mjs` drops them.
//   2. **Never sensitive, never a gate.** `class: "sensitive"` (EEO/demographics) and
//      `class: "policy_gate"` (attestations, consents) rows are skipped outright. The invariant is
//      that those are never written without an explicit human stance — a benchmark is not one.
//   3. **Never the user's home.** `assertExerciseHome` refuses to run unless `JEV_APPLY_HOME` is
//      set to a home that is not `~/.config/jev-apply`. This pass types junk into a real
//      employer's form; it must be provably impossible with the user's own store loaded.
//   4. **Never Submit.** Nothing here clicks anything but an option inside the control it is
//      setting, and the tab is closed afterwards.
//
// The confidence gate (`src/jev/gates.mjs`) deliberately does *not* apply: a gate decides whether
// an answer is good enough to put in front of the user, and nothing here is. The pick is still
// one of the form's own rendered labels, and its confidence is recorded.

import { homedir } from "node:os";
import path from "node:path";

import { setField, resolveSelector } from "../browser/adapters/index.mjs";
import { connect, disconnect, findTab } from "../browser/chrome.mjs";
import { detectControl, isPlaceholderLabel } from "../browser/controls.mjs";
import { appendTrace } from "../browser/trace.mjs";
import { NONE, choice, systemOne, usageTotals, withNone } from "../jev/client.mjs";
import { probeVocabulary } from "../plan/execute.mjs";
import { loadFormPlan } from "../schema/index.mjs";

/** The values the bench chooses. Fixed, so two runs of the same posting are comparable. */
export const BENCH_VALUES = Object.freeze({ text: "bench", number: "5", date: "2026-12-01" });

/**
 * A geocoder renders nothing until something is typed, so its "live options" need a seed. Tried in
 * order until one renders: the synthetic candidate's own city first (which is what the runner
 * typed), then two other large cities — a picker that answers for none of the three is not
 * answering at all, which is itself the measurement.
 *
 * The difference from the fill loop is what happens next: this pass commits one of the entries the
 * widget offered back, where the runner insists on an exact match for the candidate's own answer
 * and asks the user when there is none.
 */
export const LOCATION_SEEDS = Object.freeze(["Lisbon", "London", "Berlin"]);

/** Rows that are the user's alone. Skipped before anything is detected, let alone written. */
export const NEVER_EXERCISED = Object.freeze(["sensitive", "policy_gate"]);

/** Actions that already have an answer: leave them exactly as the runner left them. */
const ANSWERED = new Set(["fill", "check", "draft"]);

/** Controls the bench has no honest value for — see `skipReason` in the README table. */
const NO_BENCH_VALUE = { file: "file_upload_is_the_runners_own", tel: "tel_needs_a_real_number" };

const OPTION_CONTROLS = new Set(["native_select", "react_select", "combobox", "listbox", "radio", "checkbox_group", "location"]);

/** Same cap as the planner's live-vocabulary rung: wider than this is a country list. */
const MAX_OPTIONS = 120;
const MULTI_PICKS = 2;

/**
 * Refuse to exercise controls against the user's own store.
 *
 * This pass writes to `applications/<slug>/trace.jsonl` under `CONFIG_DIR`, which
 * `src/config.mjs` resolves from `JEV_APPLY_HOME` at import time — so the environment variable is
 * not a hint here, it is the thing that decides which home gets written to. Both the variable and
 * `--home` must name the same non-default directory.
 *
 * @param {string} home the `--home` the run was started with
 * @returns {{home:string}}
 */
export function assertExerciseHome(home, { env = process.env.JEV_APPLY_HOME, userHome = path.join(homedir(), ".config", "jev-apply") } = {}) {
  if (!env) {
    throw new Error(
      "--exercise-controls needs JEV_APPLY_HOME set to the synthetic bench home " +
        `(e.g. JEV_APPLY_HOME=${home} node scripts/bench.mjs …). It writes bench-chosen values into real forms ` +
        "and must never run with the user's own store loaded.",
    );
  }
  const resolved = path.resolve(env);
  if (resolved === path.resolve(userHome)) {
    throw new Error(`--exercise-controls refuses to run against ${userHome}: that is the user's own store, not a bench home.`);
  }
  if (resolved !== path.resolve(home)) {
    throw new Error(`--exercise-controls needs JEV_APPLY_HOME (${resolved}) and --home (${path.resolve(home)}) to name the same directory.`);
  }
  return { home: resolved };
}

const skip = (why, extra = {}) => ({ exercised: false, why, ...extra });

/**
 * In-page: the visible label of each member of a radio / checkbox / button group. A bench-local
 * twin of `groupLabels` in `src/plan/execute.mjs`, which is not exported.
 */
function groupMemberLabels(els) {
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  return els.map((el) => {
    if (el.tagName === "BUTTON") return clean(el.getAttribute("data-option") || el.textContent);
    const tied = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    return clean(tied?.textContent ?? el.closest("label")?.textContent ?? el.value ?? "");
  });
}

const MEMBERS = ['input[type="radio"]', 'input[type="checkbox"]', "button[data-option]"];

/** A group's member labels, whether the resolved selector names the container or the members. */
async function groupOptions(page, selector) {
  const inside = await page.$$eval(MEMBERS.map((m) => `${selector} ${m}`).join(", "), groupMemberLabels).catch(() => []);
  if (inside.length) return inside;
  return page.$$eval(selector, groupMemberLabels).catch(() => []);
}

/**
 * The options this control offers, and where they came from.
 *
 * A group is read from the schema first on purpose. `probeVocabulary` reads a combobox by *typing
 * into it*, which for a checkbox group means clicking a box — it would tick an answer before the
 * bench has chosen one. The schema's labels are exactly what the adapters match a group member by
 * (an Ashby ValueSelect, a Greenhouse `multi_value_multi_select`), and the DOM read is the
 * fallback for a group the offline plan never saw. Everything else is probed live first, because
 * live is the only authority on a widget whose vocabulary the schema got wrong (Figma's
 * `multi_value_multi_select` that renders as a react-select).
 */
async function liveOptions(page, question, control, selector) {
  const schema = (question.options ?? []).map((o) => (typeof o === "string" ? o : o?.label)).filter(Boolean);
  if (control === "radio" || control === "checkbox_group") {
    if (schema.length) return { labels: schema, from: "schema" };
    const group = await groupOptions(page, selector);
    return { labels: group, from: group.length ? "live" : "none" };
  }
  if (control === "location") {
    for (const seed of LOCATION_SEEDS) {
      const hits = await probeVocabulary(page, { ...question, selector, control }, seed).catch(() => []);
      if (hits.length) return { labels: hits, from: `live:${seed}` };
    }
    return { labels: schema, from: schema.length ? "schema" : "none" };
  }
  const live = await probeVocabulary(page, { ...question, selector, control }, "").catch(() => []);
  if (live.length) return { labels: live, from: "live" };
  return { labels: schema, from: schema.length ? "schema" : "none" };
}

/**
 * The bench's own pick when Jev ranked nothing.
 *
 * Deliberately the **middle** non-placeholder entry, never the first. "Never position 0" is the
 * ladder's rule (`src/browser/controls.mjs`) because an option must be committed for matching, not
 * for being first, and a bench row that happened to take entry 0 would read exactly like that bug.
 * A median entry cannot be mistaken for it — and on a type-to-filter react-select it is the better
 * test anyway, because reaching it proves the filter and the scroll, not just the highlighted row.
 */
const medianLabel = (labels) => labels[Math.floor(labels.length / 2)];

/**
 * One Choice over the labels the widget is showing: which of them is the most generic thing a test
 * user would pick? `withNone` is the mandatory exit (AGENTS.md) and `systemOne` validates the
 * answer (`choice ∈ criteria`, probabilities sum ≈ 1, argmax == choice) before it returns.
 *
 * Jev exits on plenty of real lists, and correctly so: asked for the most generic entry in
 * ["Alabama" … "Wyoming"] or ["Infrastructure", "Research Engineer", "Product Engineer"] the honest
 * answer is that none of them is generic (measured over the bench's own option lists — every
 * wording of the exit returned `none_of_these` at 0.6–0.9). It answers where a neutral option
 * really exists: "Either" out of Weekdays/Weekends/Either, "A friend" out of a referral-source
 * list. So the exit is not a skip here — it means *this list has no generic member*, and the bench
 * then picks one itself and says so in `strategy`. Only a placeholder is ever refused outright.
 */
async function pickGeneric({ question, control, labels, slug }) {
  const fallback = (why) => ({ exercised: true, value: medianLabel(labels), strategy: "bench_median", options: labels.length, fallback_why: why });
  if (labels.length === 1) return { exercised: true, value: labels[0], strategy: "only_option", options: 1 };
  // Above the cap the list is a country/state vocabulary, not a question's options; the planner
  // refuses to put one to Jev (`MAX_LIVE_OPTIONS`) and so does this.
  if (labels.length > MAX_OPTIONS) return fallback("too_many_options");

  const criteria = {};
  labels.forEach((label, i) => {
    criteria[`o${i}`] = String(label).slice(0, 180);
  });

  let answer = null;
  try {
    const res = await systemOne({
      state: { field: { label: question?.label ?? "", control, options: labels.length } },
      questions: {
        pick: choice(
          "pick the most generic, non-committal option a test user would choose",
          withNone(criteria, "No option here is generic enough for a test user to pick"),
        ),
      },
    });
    answer = res.answers?.pick ?? null;
  } catch {
    return fallback("jev_unavailable");
  }

  const picked = answer?.choice;
  const index = picked && picked !== NONE ? Number(String(picked).slice(1)) : -1;
  const label = Number.isInteger(index) && index >= 0 ? labels[index] : undefined;
  const confidence = typeof answer?.confidence === "number" ? Math.round(answer.confidence * 100) / 100 : null;
  await appendTrace(slug, {
    op: "bench_vocab",
    bench_exercise: true,
    qid: question?.qid ?? null,
    control,
    options: labels.length,
    picked: label === undefined ? null : index,
    confidence,
  });
  if (picked === NONE) return fallback("none_of_these");
  if (label === undefined) return fallback("choice_out_of_range");
  // `labels` is already placeholder-filtered, so this cannot fire from the bench's own list; it is
  // the contract the task states, kept as an assertion rather than an assumption.
  if (isPlaceholderLabel(label)) return skip("placeholder_option", { options: labels.length });
  return { exercised: true, value: label, strategy: "jev_generic", options: labels.length, confidence };
}

/**
 * The value this control is exercised with, by what the DOM turned out to be.
 * @returns {Promise<{exercised:boolean, value?:string, why?:string, strategy?:string}>}
 */
export async function benchValue({ page, question, detected, slug, selector }) {
  const control = detected.control;
  if (NO_BENCH_VALUE[control]) return skip(NO_BENCH_VALUE[control]);
  // The schema and the DOM disagree on exactly the rows this mode exists for. Ashby's `Date` field
  // is a bare `input` with no `type=date`, no placeholder and no pattern, so `classifyShape` calls
  // it `text` — and a generic "bench" would sail straight through and prove nothing. Where the
  // plan says date or number, the bench writes a date or a number: that is the value that tests
  // whether the field is what the schema claims it is.
  const planned = String(question?.control ?? question?.type ?? "").toLowerCase();
  if (control === "text" && planned === "date") return { exercised: true, value: BENCH_VALUES.date, strategy: "fixed_date_as_planned" };
  if (control === "text" && planned === "number") return { exercised: true, value: BENCH_VALUES.number, strategy: "fixed_number_as_planned" };
  if (control === "text" || control === "textarea") return { exercised: true, value: BENCH_VALUES.text, strategy: "fixed_text" };
  if (control === "number") return { exercised: true, value: BENCH_VALUES.number, strategy: "fixed_number" };
  if (control === "date") return { exercised: true, value: BENCH_VALUES.date, strategy: "fixed_date" };
  // A lone checkbox is a boolean, not a menu: there is nothing to choose between.
  if (control === "checkbox") return { exercised: true, value: "Yes", strategy: "boolean" };
  if (control === "unknown") return skip(detected.evidence === null ? "control_not_on_the_page" : "unknown_control");
  if (!OPTION_CONTROLS.has(control)) return skip(`no_bench_value_for_${control}`);

  const { labels, from } = await liveOptions(page, question, control, selector ?? question.selector);
  const usable = labels.filter((label) => !isPlaceholderLabel(label));
  if (!usable.length) return skip(from === "none" ? "no_options_rendered" : "only_placeholder_options");

  // Multi-valued controls take two values, so the bench can see the second commit land beside the
  // first rather than replace it — the failure mode a single pick would never show.
  const multi = control === "checkbox_group" || detected.multiple || question?.type === "multi_select";
  if (multi) {
    return { exercised: true, value: usable.slice(0, MULTI_PICKS).join(" | "), strategy: "first_two", options: usable.length, from };
  }
  const picked = await pickGeneric({ question, control, labels: usable, slug });
  return picked.exercised ? { ...picked, from } : { ...picked, from };
}

/** Which FormPlan rows this pass owns: everything the runner left without an answer. */
export function remainingRows(formPlan, decisions, { stale = false } = {}) {
  const byQid = stale ? new Map() : new Map((decisions ?? []).map((d) => [d.qid, d]));
  return (formPlan?.questions ?? [])
    .filter((q) => !NEVER_EXERCISED.includes(q.class))
    .filter((q) => {
      const d = byQid.get(q.qid);
      if (d && NEVER_EXERCISED.includes(d.class)) return false;
      return !ANSWERED.has(d?.action ?? "ask");
    })
    .map((q) => ({ question: q, was: byQid.get(q.qid)?.action ?? null }));
}

/** One row: detect, choose a bench value, set it, read it back. Never throws. */
async function exerciseRow({ page, ats, formPlan, question, was, slug, sink }) {
  const started = Date.now();
  const base = { qid: question.qid, label: question.label ?? null, was, planned: question.control ?? null };
  let selector = null;
  let detected = null;
  try {
    selector = await resolveSelector(page, ats, question);
    detected = await detectControl(page, selector, { question });
  } catch (err) {
    return { ...base, control: null, exercised: false, why: `detect_failed: ${String(err.message).split("\n")[0].slice(0, 60)}` };
  }

  const control = detected.control;
  const chosen = await benchValue({ page, question, detected, slug, selector });
  if (!chosen.exercised) return { ...base, control, exercised: false, why: chosen.why, ...(chosen.options ? { options: chosen.options } : {}) };

  const shaped = { ...question, control, selector };
  const result = await setField(page, shaped, chosen.value, { ats, detected, selector, trace: sink });
  return {
    ...base,
    control,
    exercised: true,
    ok: Boolean(result?.ok),
    strategy: chosen.strategy,
    ms: Date.now() - started,
    ...(chosen.options ? { options: chosen.options } : {}),
    ...(chosen.confidence != null ? { confidence: chosen.confidence } : {}),
    ...(chosen.fallback_why ? { fallback_why: chosen.fallback_why } : {}),
    // The adapters' reasons embed the value they were given; only the clause before it is kept,
    // the same masking `src/bench/metrics.mjs reasonKey` applies to a runner failure.
    ...(result?.ok ? {} : { reason: String(result?.reason ?? "readback_mismatch").split(/[:(]/)[0].trim() || "readback_mismatch" }),
  };
}

/**
 * Drive every remaining row of one posting, on the tab the child left open.
 *
 * `budgetMs` is the same 120 s the runner gives itself per posting (`LIMITS.wallMs`). A widget
 * that will not answer can hold a row for the adapters' whole retry budget, and twenty-eight of
 * those on one form would cost more wall clock than the benchmark it is instrumenting; the budget
 * is checked between rows, never inside one that is mid-write.
 *
 * @param {{url:string, home:string, port:number, slug:string|null, decisions:object[],
 *          status:string, budgetMs?:number, onLog?:(line:string)=>void}} args
 * @returns {Promise<{ran:boolean, why?:string, rows:object[], jev:object, ms:number}>}
 */
export async function exerciseControls({ url, home, port, slug, decisions = [], status = null, budgetMs = 120_000, onLog = null }) {
  const started = Date.now();
  const before = usageTotals();
  const spent = () => {
    const now = usageTotals();
    return {
      requests: now.requests - before.requests,
      input_tokens: now.input_tokens - before.input_tokens,
      output_tokens: now.output_tokens - before.output_tokens,
    };
  };
  const nothing = (why) => ({ ran: false, why, rows: [], jev: spent(), ms: Date.now() - started });

  let formPlan = null;
  try {
    formPlan = await loadFormPlan(url);
  } catch (err) {
    return nothing(`no form plan: ${err.message.split("\n")[0].slice(0, 80)}`);
  }

  // A posting that ended `blocked` never froze a plan, so `decisions.json` still describes an
  // earlier run: trusting it would skip rows on the strength of a fill that did not happen here.
  const stale = status === "blocked";
  const rows = remainingRows(formPlan, decisions, { stale });
  if (!rows.length) return nothing("nothing left to exercise");

  const profileDir = path.join(home, "profile");
  let conn = null;
  const out = [];
  try {
    conn = await connect({ profileDir, port, spawnIfMissing: false });
    const page = await findTab(conn.context, url);
    if (!page) return nothing("no tab for this posting");

    await appendTrace(slug, { op: "bench_exercise", bench_exercise: true, phase: "start", rows: rows.length });
    // A function sink keeps the writes in the trace *and* stamps them `bench_exercise: true`, so
    // `summarize()` can drop them and no reader can mistake a bench write for a runner fill. It
    // also means `captureFailure` finds no slug and photographs nothing: a form full of bench
    // values is not evidence about anything.
    const sink = (event) => appendTrace(slug, { ...event, bench_exercise: true });

    let stopped = null;
    for (const { question, was } of rows) {
      if (Date.now() - started > budgetMs) {
        stopped = `budget: ${Math.round(budgetMs / 1000)}s spent with ${rows.length - out.length} row(s) left`;
        break;
      }
      const row = await exerciseRow({ page, ats: formPlan.ats, formPlan, question, was, slug, sink });
      out.push(row);
      if (onLog) {
        onLog(
          `exercise ${row.control ?? "?"} ${row.exercised ? (row.ok ? "ok" : `FAIL ${row.reason ?? ""}`) : `skip ${row.why}`}` +
            ` · ${String(row.label ?? row.qid).slice(0, 40)}`,
        );
      }
    }
    if (stopped) {
      await appendTrace(slug, { op: "bench_exercise", bench_exercise: true, phase: "stopped", why: stopped });
      out.push({ qid: null, label: null, control: null, exercised: false, why: "exercise_budget_reached" });
    }
    await appendTrace(slug, {
      op: "bench_exercise",
      bench_exercise: true,
      phase: "end",
      attempted: out.filter((r) => r.exercised).length,
      ok: out.filter((r) => r.ok).length,
    });
  } catch (err) {
    return { ran: out.length > 0, why: `exercise failed: ${err.message.split("\n")[0].slice(0, 80)}`, rows: out, jev: spent(), ms: Date.now() - started };
  } finally {
    if (conn) await disconnect(conn.browser, { port, verify: false }).catch(() => {});
  }

  return { ran: true, rows: out, jev: spent(), ms: Date.now() - started };
}
