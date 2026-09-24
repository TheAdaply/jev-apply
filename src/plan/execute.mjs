// PLAN §2.2 steps 8–11 — the browser half of the runner. Everything here drives the DOM through
// the ATS adapters; no judgment is made in this file.
//
//   openPosting()   one tab per posting. An already-open tab is **reloaded** first: a tab left
//                   over from an earlier run still shows that run's values, and a read-back that
//                   passes against a stale value is the one failure mode that looks like success.
//   executeRows()   every `fill`/`check` Decision through its adapter, one field at a time, each
//                   isolated — the adapter's two attempts are the whole retry budget, and a field
//                   that will not take its value becomes `action:"ask"` with a screenshot while
//                   the rest of the form keeps filling (step 8, D13). Cadence (150–400 ms + a real
//                   mouse move) is the adapters' `pace()`; doubling it here would only slow the run.
//   inspect()       the snapshot diff: which required controls are still empty, and which of them
//                   the plan has never heard of — conditional follow-ups that only exist once the
//                   form is half-filled. Those go back out through `replan`, max 2 rounds (step 9).
//   verify()        step 11's re-snapshot: every required control non-empty, nothing new.
//
// One judgment this module refuses to make itself: what a question the offline plan never saw
// should be answered with. Conditional follow-ups leave through `replan`, so the gates and the
// `none_of_these` exit stay in `src/jev/*`. A select whose vocabulary only the live page knows is
// the one case that never reaches a model at all — see resolveVocabulary for why.
//
// `blocked` is reserved for: no page, no form, CDP lost, three consecutive fields that would not
// take a value (`no_progress`), and the per-posting budget (>40 Jev requests or >120 s). Every
// other failure is one `ask` row on an otherwise-filled form.

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import nodePath from "node:path";

import { adapters, atsFromUrl, handles, resolveSelector, setField, snapshotRequired, uploadFile, waitForForm } from "../browser/adapters/index.mjs";
import { detectControl, isPlaceholderLabel, waitForOptions } from "../browser/controls.mjs";
import { findTab, openTab, pagesOf } from "../browser/chrome.mjs";
import { norm, normLabel, pace, pickOption, sleep, waitUntil } from "../browser/readback.mjs";
import { appendTrace, captureFailure, maskSelectors, traceDir, tracePath } from "../browser/trace.mjs";
import { classify } from "../schema/classes.mjs";
import { choice, systemOne, withNone, NONE } from "../jev/client.mjs";
import { gate, runnerUpGap } from "../jev/gates.mjs";
import { normalizeOption } from "../jev/plan.mjs";
import { LOCATION_RE } from "./resolve.mjs";
import { countryFromText } from "../schema/normalize.mjs";
import { isWorkMode } from "../memory/derive.mjs";

/** Stop rules and round caps (PLAN §2.2 steps 9 and 11). */
export const LIMITS = { jevRequests: 40, wallMs: 120000, noChange: 3, deltaRounds: 2 };

const OPTION_WAIT_MS = 3500;
/**
 * Controls whose answer must come from the form's own vocabulary (never free text).
 * `location` is deliberately absent: a geocoder's list is not a vocabulary to choose from, it is
 * a search result, and the adapters' location ladder types the city and matches the entry that
 * contains it. Routing it through `resolveVocabulary` is what turned the Greenhouse Pelias field
 * into an `ask` on both recorded runs.
 */
const OPTION_CONTROLS = new Set(["react_select", "native_select", "radio", "checkbox", "checkbox_group", "combobox", "listbox"]);
/** A live menu wider than this is a country list, not a question's options; never put it to Jev. */
const MAX_LIVE_OPTIONS = 120;

const round2 = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

export class Blocked extends Error {
  constructor(reason, detail, extra = {}) {
    super(detail || reason);
    this.name = "Blocked";
    this.reason = reason;
    Object.assign(this, extra);
  }
}

/**
 * The per-posting stop rules, as one object the caller threads through planning and filling.
 * `requests` starts at whatever the planner already spent, because the cap is per posting.
 */
export function newBudget({ requests = 0, started = Date.now(), limits = LIMITS } = {}) {
  return {
    requests,
    started,
    limits,
    noChange: 0,
    elapsed() {
      return Date.now() - this.started;
    },
    spend(n = 0) {
      this.requests += n;
      this.check();
      return this.requests;
    },
    check() {
      if (this.requests > this.limits.jevRequests) {
        throw new Blocked("budget", `${this.requests} Jev requests for one posting (cap ${this.limits.jevRequests})`);
      }
      if (this.elapsed() > this.limits.wallMs) {
        throw new Blocked("budget", `${Math.round(this.elapsed() / 1000)}s on one posting (cap ${Math.round(this.limits.wallMs / 1000)}s)`);
      }
    },
    /** A field that took its value resets the counter; `noChange` in a row means the page is dead. */
    progress(changed) {
      this.noChange = changed ? 0 : this.noChange + 1;
      if (this.noChange >= this.limits.noChange) {
        throw new Blocked("no_progress", `${this.noChange} consecutive fields would not take a value`);
      }
    },
  };
}

// ─── tabs ─────────────────────────────────────────────────────────────────────────────────────

/** A tab showing this posting, reloaded so nothing from an earlier run survives (D12). */
export async function openPosting(context, url, { reload = true, timeout = 45000 } = {}) {
  const existing = await findTab(context, url);
  if (!existing) return { page: await openTab(context, url, { reuse: false, timeout }), reused: false, reloaded: false };
  await existing.bringToFront().catch(() => {});
  if (reload) await existing.reload({ waitUntil: "domcontentloaded", timeout }).catch(() => {});
  await existing.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
  return { page: existing, reused: true, reloaded: reload };
}

/** Re-attach to the tab a previous run left open — `--answers` / `--resume` (D12). */
export async function attachPosting(context, url) {
  const page = await findTab(context, url);
  if (page) await page.bringToFront().catch(() => {});
  return { page, reused: Boolean(page), reloaded: false };
}

/** `--tab`: the ATS tab the user is looking at, else the last ATS tab in the profile. */
export async function activeAtsTab(context) {
  const tabs = pagesOf(context).filter((p) => !p.isClosed?.() && atsFromUrl(p.url()));
  for (const page of tabs) {
    const visible = await page.evaluate(() => document.visibilityState === "visible").catch(() => false);
    if (visible) return page;
  }
  return tabs[tabs.length - 1] ?? null;
}

// ─── filling ──────────────────────────────────────────────────────────────────────────────────

/**
 * Rows the executor still has work for: planned to be set, not yet set successfully. A `draft`
 * row counts once the writer has put text on it (step 10) — it is typed into the control and read
 * back like any other value, and stays a `draft` so the summary still shows it under ► DRAFTED.
 */
export const runnable = (d) =>
  (d.action === "fill" || d.action === "check" || (d.action === "draft" && (d.value != null || d.option != null))) &&
  d.readback?.ok !== true;

function markAsk(d, why, { shot = null, options = null } = {}) {
  // What the row was before the form refused it. A demographic control that is simply not in the
  // DOM yet is retried by step 8½, and a retry that *commits* has to undo this `ask` completely —
  // the `why` included, or the summary tells the user "the form would not take it" about a value
  // the trace and the screenshot both show set (judged on scale-ai/4534631005, 2026-09-23).
  if (d.action !== "ask") d._was = { action: d.action, why: d.why };
  d.action = "ask";
  d.why = why;
  d.confidence = undefined;
  d.gap = undefined;
  if (shot) d.shot = shot;
  if (options?.length) d.options = options;
  return d;
}

/**
 * Was this value committed, as far as the page is concerned? Used for the one class whose
 * read-back is redacted: a `sensitive` row records this verdict instead of the value, so a
 * reviewer without the browser can still tell a demographic block that landed from one that did
 * not (B3). Comparison is the same normalised label match the option ladder commits on.
 */
export function observedMatches(observed, wanted) {
  const seen = String(observed ?? "").trim();
  const want = String(wanted ?? "").trim();
  if (!seen || !want) return false;
  return normLabel(seen) === normLabel(want) || pickOption([seen], want) !== null;
}

/**
 * The order the fill loop drives rows in: the form's own order, except that a control which only
 * *mounts* once another row is answered is driven after that row (B8). Greenhouse's `#race` is
 * the case — the API publishes it as a top-level compliance field, the page renders it only once
 * `#hispanic_ethnicity` has an answer — and a parent the plan does not carry at all (that
 * ethnicity control is published by no schema row) ranks it last, which is the best this pass
 * can do before step 8½ reads the block off the page.
 */
export function rowOrder(questions = []) {
  const base = new Map(questions.map((q, i) => [q.qid, i]));
  const rank = new Map(base);
  for (const q of questions) {
    if (!q?.mounts_after) continue;
    const parent = base.get(q.mounts_after);
    rank.set(q.qid, parent == null ? questions.length + (base.get(q.qid) ?? 0) : parent + 0.5);
  }
  return rank;
}

/**
 * A control that is simply not in the DOM *yet*, because the row it mounts under has not been
 * answered. That is not a form refusing a value — it is a conditional the page has not grown —
 * so it is never counted as a failed write. The row is left as an `ask` carrying its reason, and
 * step 8½'s retry pass is what fills it once the parent is answered.
 */
export function deferredMount(question, result) {
  return Boolean(question?.mounts_after) && String(result?.reason ?? "") === "control_not_found";
}

/**
 * Set every row through its adapter. Mutates the Decision objects it is given: `readback` lands on
 * the row, and a row the form would not take becomes an `ask` carrying its screenshot.
 * @returns {Promise<{filled:number, failed:number, executed:number, deferred:number}>}
 */
export async function executeRows({ page, ats, formPlan, decisions, slug, budget, rows = null }) {
  const questions = formPlan?.questions ?? [];
  const byQid = new Map(questions.map((q) => [q.qid, q]));
  const order = rowOrder(questions);
  const todo = (rows ?? decisions.filter(runnable))
    .slice()
    .sort((a, b) => (order.get(a.qid) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.qid) ?? Number.MAX_SAFE_INTEGER));

  // A Jev-resolved option whose margin over the runner-up is thin is filled but flagged, the same
  // way `gate` treats a thin margin in the offline plan (PLAN §2.2 step 7).
  const thin = new Set();
  const chooseOption = optionChooser({ slug, budget, onCheck: (q) => thin.add(q?.qid) });
  let filled = 0;
  let failed = 0;
  let deferred = 0;
  for (const d of todo) {
    budget.check();
    const question = byQid.get(d.qid);
    if (!question) {
      markAsk(d, `${d.why} — the form has no control for this question`);
      failed += 1;
      continue;
    }
    const result = await setRow({ page, ats, formPlan, question, decision: d, slug, chooseOption });
    if (!result) continue; // turned into an `ask` before anything was written
    d.readback = {
      ok: result.ok === true,
      observed: question.class === "sensitive" ? "" : String(result.observed ?? ""),
      attempts: result.attempts ?? 0,
      // The redacted half of the record, replaced by a verdict rather than left blank (B3).
      ...(question.class === "sensitive" ? { observed_matches: observedMatches(result.observed, d.option ?? d.value) } : {}),
    };
    if (result.ok) {
      filled += 1;
      delete d.shot;
      // A `draft` stays a draft: it is already listed for the user under ► DRAFTED, and a thin
      // option margin on a drafted row is not a different kind of "look at this".
      if (thin.has(d.qid) && d.action !== "ask" && d.action !== "draft") {
        d.action = "check";
        d.why = `${d.why} — matched to the form's own wording, worth a look`;
      }
    } else if (deferredMount(question, result)) {
      deferred += 1;
      markAsk(d, `the form only shows this once "${String(question.mounts_after)}" is answered — it is filled on the retry pass`);
      // Deliberately outside `budget.progress`: a control the page has not grown yet is not a
      // field refusing a value, and three of them in a row must not read as `no_progress`.
      continue;
    } else {
      failed += 1;
      markAsk(d, `the form would not take it (${result.reason ?? "read-back mismatch"}) — intended: ${clipValue(d, question)}`, { shot: result.shot, options: result.options });
    }
    budget.progress(result.ok === true);
  }
  return { filled, failed, executed: todo.length, deferred };
}

/**
 * The Jev rung of the adapters' option ladder (`src/browser/controls.mjs`): when a control's own
 * rendered vocabulary has no exact, prefix or substring match for the answer, one Choice over the
 * labels the widget is showing *plus* `none_of_these` decides. The verdict is `gates.mjs`'s own
 * `gate()`, not a bare confidence test: a 0.55/0.54 near-tie between two rendered options is a
 * `check`, not a silent fill, and `onCheck` is how that reaches the user's summary.
 *
 * Never for a `sensitive` row (EEO option text is not sent anywhere) and never for `location`,
 * which the ladder refuses by construction. The request is charged to the posting's budget; a cap
 * reached here stops the run at the next row boundary, not inside a field that is mid-write.
 */
export function optionChooser({ slug = null, budget = null, signal = null, onCheck = null } = {}) {
  return async ({ question, value, labels, control }) => {
    if (!labels?.length || labels.length > MAX_LIVE_OPTIONS) return null;
    if (question?.class === "sensitive") return null;
    if ((budget?.requests ?? 0) >= (budget?.limits?.jevRequests ?? Infinity)) return null;
    const criteria = {};
    labels.forEach((label, i) => {
      criteria[`o${i}`] = String(label).slice(0, 180);
    });
    let answer = null;
    let requests = 1;
    try {
      const res = await systemOne({
        state: { field: { label: question?.label ?? "", control, answer_text: String(value) } },
        questions: {
          pick: choice(
            "Which option in `criteria` states the same thing as `field.answer_text`?",
            withNone(criteria, "No option offered by the form states that answer"),
          ),
        },
        signal,
      });
      requests = res.requests ?? 1;
      answer = res.answers?.pick ?? null;
    } catch {
      return null; // a model that cannot answer must not stop the fill; the row becomes an `ask`
    } finally {
      try {
        budget?.spend(requests);
      } catch {
        /* the cap is enforced at the next row boundary, never mid-write */
      }
    }
    const picked = answer?.choice;
    const index = picked && picked !== NONE ? Number(String(picked).slice(1)) : -1;
    const label = Number.isInteger(index) && index >= 0 ? labels[index] : undefined;
    const action = answer ? gate({ choice: picked, confidence: answer.confidence, probabilities: answer.probabilities }) : "ask";
    await appendTrace(slug, {
      op: "vocab",
      qid: question?.qid ?? null,
      control,
      options: labels.length,
      picked: label === undefined ? null : index,
      action,
      confidence: typeof answer?.confidence === "number" ? Math.round(answer.confidence * 100) / 100 : null,
      gap: round2(runnerUpGap(answer?.probabilities, picked)),
    });
    if (action === "ask" || label === undefined) return null;
    if (action === "check") onCheck?.(question, { label, confidence: answer.confidence });
    return { label, confidence: answer.confidence, check: action === "check" };
  };
}

/** One row → one adapter call. Returns null when the row became an `ask` without a DOM write. */
async function setRow({ page, ats, formPlan, question, decision, slug, chooseOption = null }) {
  // `mask` paints the EEO controls out of any failure screenshot; a sensitive row is never
  // photographed at all (src/browser/trace.mjs).
  const opts = { trace: { slug, mask: formPlan }, ats, chooseOption };

  // File first: Greenhouse removes the input once a file is attached, so there is nothing left
  // for detection to look at on a re-attach — `uploadFile` reads the chip instead.
  if (question.control === "file" || question.type === "file") {
    const file = decision.path;
    if (!file || !existsSync(file)) {
      markAsk(decision, `${decision.value ?? "the document"} is not on disk — which file should I attach?`);
      return null;
    }
    return uploadFile(page, question, file, opts);
  }

  if (decision.option == null && (decision.value == null || decision.value === "")) {
    markAsk(decision, `${decision.why} — no value to set`);
    return null;
  }

  // What the control *is*, before anything is typed into it. The FormPlan's `control` was a guess
  // made offline from the ATS schema; where the two disagree the DOM wins, both are written to the
  // trace, and the plan row is corrected so the frozen decisions describe the form that exists.
  //
  // `question.type` is *not* corrected: it is the ATS's own field type, and for a date control
  // rendered as a bare text input it is the only thing that still says "date" after this line —
  // which is what `adapters/index.setField` routes on.
  const selector = await resolveSelector(page, ats, question);
  const detected = await detectControl(page, selector, { question });
  if (!detected.agreed) {
    await appendTrace(slug, {
      op: "detect",
      qid: question.qid,
      planned: detected.planned,
      control: detected.control,
      why: detected.why,
      // The same rule `adapters/index.setField` applies, so the trace names the module that ran.
      route: question.type !== "date" && handles(ats, detected.control) ? ats : "generic",
    });
    question.control = detected.control;
  }

  // A select whose vocabulary the schema did not carry (an autocomplete): the form's own list
  // only exists once you type into it, so it is read off the DOM — and only an exact match may
  // be committed from it. See resolveVocabulary.
  //
  // A history entry's box is the exception (`question.repeat`, src/plan/repeat.mjs): its lists are
  // catalogues — a School list of every university, a Discipline list of 72 subjects — not a
  // question's answers filtered by what was typed, so they take the adapters' ordinary ladder.
  if (OPTION_CONTROLS.has(detected.control) && decision.option == null && !(question.options ?? []).length && !question.repeat) {
    const picked = await resolveVocabulary({ page, question, decision, slug, selector });
    if (!picked.ok) return null;
  }

  // `setField` routes a control this ATS adapter does not tune to `adapters/generic.mjs`.
  if (!question.repeat) return setField(page, question, decision.option ?? decision.value, { ...opts, detected, selector });
  return setHistoryPart({ page, question, decision, slug, opts: { ...opts, detected, selector } });
}

/**
 * One box of a history entry. A school is matched by the ladder's literal rungs only — a school
 * list is thousands of similar names, and "a university like yours" is a false statement about
 * where the user studied — and on a board whose catalogue carries a catch-all ("Other" on
 * Greenhouse) a school the catalogue does not list is that entry, committed as a `check`.
 */
async function setHistoryPart({ page, question, decision, slug, opts }) {
  const school = question.repeat.part === "school";
  const want = decision.option ?? decision.value;
  const result = await setField(page, question, want, { ...opts, ...(school ? { chooseOption: null } : {}) });
  const unmatched = /no_matching_option|no_options_rendered|read-back mismatch/.test(String(result.reason ?? ""));
  const fallback = question.repeat.fallback;
  if (result.ok || !unmatched) return result;
  // A closed list the saved words did not match (a Discipline list of 72 subjects): the question
  // that goes back to the user carries that list, so the answer is one of its entries. A School
  // catalogue is a search over thousands and is not listed.
  const listed = async () => {
    if (school || !OPTION_CONTROLS.has(opts.detected?.control)) return result;
    const options = (await probeVocabulary(page, { ...question, selector: opts.selector, control: opts.detected.control }, "")).filter((l) => !isPlaceholderLabel(l));
    return options.length && options.length <= MAX_LIVE_OPTIONS ? { ...result, options } : result;
  };
  if (!fallback) return listed();
  const other = await setField(page, question, fallback, { ...opts, chooseOption: null });
  await appendTrace(slug, { op: "fallback", qid: question.qid, wanted: String(want).slice(0, 80), used: fallback, ok: other.ok === true });
  if (!other.ok) return listed();
  decision.option = fallback;
  if (decision.action === "fill") decision.action = "check";
  // The reason first: the summary's ► CHECK line keeps only what precedes the first " (".
  decision.why = `not in this form's ${question.repeat.part} list, so "${fallback}" (wanted "${String(want).slice(0, 60)}" — ${decision.why})`;
  return other;
}

const clipValue = (d, q) => (q?.class === "sensitive" ? "••••" : String(d.option ?? d.value ?? "").slice(0, 60));

/**
 * The form owns this vocabulary and only renders it live. Read the labels; commit only an exact
 * (normalised) match; otherwise ask, with the labels the form actually offered attached so the
 * host shows the user the same list the runner saw.
 *
 * This list is deliberately **not** put to Jev, unlike the schema's own options in step 6. It is
 * the widget's *filtered* result for the text we typed, so every entry already contains our
 * answer as a substring and `none_of_these` has to out-argue a set of literal partial matches.
 * Measured on the live Together AI form: answer_text "Remote" over the location picker's two
 * entries ("Modesto Remote Encoding Ctr, California" · "Remote, Oregon, United States") returns
 * Oregon at 0.95 — a real place, a confident model, and a US address for a candidate whose memory
 * states neither. "Remote" is a work arrangement with no correct rendering in a geographic picker;
 * the only honest answer is to ask, on a form that is otherwise already filled (D13).
 */
async function resolveVocabulary({ page, question, decision, slug, selector = null }) {
  const labels = await probeVocabulary(page, { ...question, selector: selector ?? question.selector }, decision.value);
  await appendTrace(slug, { op: "probe", qid: question.qid, control: question.control, options: labels.length });
  if (!labels.length) {
    markAsk(decision, `the form's "${question.label}" list showed nothing for ${clipValue(decision, question)} — what should I enter?`);
    return { ok: false };
  }
  const exact = labels.find((label) => normalizeOption(label) === normalizeOption(decision.value));
  if (exact) {
    decision.option = exact;
    return { ok: true };
  }
  // A *location* picker writes a place with more of its hierarchy than the user did, and the
  // probe already typed the saved string into it, so its entries are that string's continuations.
  // Comparing the two as whole strings is what refused a required row whose list carried the
  // stated location verbatim (docs/research/21-eval-judge-final.md §4 M1). Only location rows:
  // everywhere else this widget's list is a closed vocabulary and only equality may commit.
  const near = LOCATION_RE.test(String(question?.label ?? "")) ? samePlace(labels, decision.value) : null;
  if (near) {
    decision.option = near.label;
    if (decision.action === "fill") decision.action = "check";
    decision.why = `${decision.why} — ${near.why}`;
    return { ok: true };
  }
  markAsk(decision, `${decision.why} — the form's own list has no entry for "${clipValue(decision, question)}"; which one should I pick?`, { options: labels });
  return { ok: false };
}

// A place string, folded for comparison. Commas are not the only separator a picker writes — an
// en dash, a slash or a pipe splits one too — so the two readings are taken from one folding:
// `segments` are the hierarchy levels, `tokens` are every word in order.
const foldPlace = (text) =>
  normalizeOption(text)
    .replace(/[\u2010-\u2015|/]/g, ",")
    .split(",")
    .map((part) => part.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);

const placeTokens = (segments) => segments.join(" ").split(" ").filter(Boolean);

/**
 * The one entry that names the place the user stated, or null. Two rungs past equality, each of
 * which must be unambiguous — two candidates is the same as none — and neither of which is fuzzy:
 *
 *   1. **typed prefix.** The probe typed the saved string, so an entry whose leading words are
 *      exactly the saved words is that same place with more of its hierarchy spelled out
 *      ("Bengaluru" → "Bengaluru, Karnataka, India"), and separator or case differences fold away
 *      ("Bengaluru – India" ≡ "Bengaluru, India"). Word-aligned, so "Cork" never matches "Corker".
 *   2. **country suffix.** The last hierarchy level dropped from both sides, but only when the two
 *      whole strings name the same country ("Dublin, Ireland" ≡ "Dublin, IE").
 *   3. **inserted hierarchy.** The saved segments are an ordered subsequence of the entry's, the
 *      first segment is the same city and both name the same country ("Bengaluru, India" ⊂
 *      "Bengaluru, Karnataka, India"). Rung 1 misses this because the region sits between.
 *
 * A work mode is refused outright, before either rung. "Remote" is not a place, and a picker
 * filtered on it returns real addresses that contain the word — "Remote, Oregon, United States"
 * is the measured case, and committing it is a US address for somebody whose memory states
 * neither (D13). `locationFact()` keeps a work mode out of a location row upstream; this is the
 * same refusal at the one point where the form's own list could re-introduce it.
 *
 * Never position 0: a picker's first entry is its best guess at what was typed, not a statement
 * about where the user lives. The caller commits the result as a `check`, never a silent fill.
 */
export function samePlace(labels, value) {
  if (isWorkMode(value)) return null;
  const wantSegments = foldPlace(value);
  const want = placeTokens(wantSegments);
  if (!want.length) return null;
  const rows = labels
    .map((label) => ({ label, segments: foldPlace(label) }))
    .filter((row) => row.segments.length && !isWorkMode(row.label));

  const prefix = rows.filter((row) => {
    const theirs = placeTokens(row.segments);
    return theirs.length >= want.length && want.every((word, i) => theirs[i] === word);
  });
  if (prefix.length === 1) return { label: prefix[0].label, why: "the list spells the same place with more of its hierarchy" };

  const country = countryFromText(value);
  if (!country || wantSegments.length < 2) return null;
  const core = wantSegments.slice(0, -1).join(" ");
  const folded = rows.filter(
    (row) => row.segments.length >= 2 && row.segments.slice(0, -1).join(" ") === core && countryFromText(row.label) === country,
  );
  if (folded.length === 1) return { label: folded[0].label, why: "the list writes the same place's country suffix differently" };

  const inserted = rows.filter((row) => {
    if (row.segments.length <= wantSegments.length || row.segments[0] !== wantSegments[0]) return false;
    if (countryFromText(row.label) !== country) return false;
    let i = 0;
    for (const seg of row.segments) if (seg === wantSegments[i]) i += 1;
    return i === wantSegments.length;
  });
  return inserted.length === 1 ? { label: inserted[0].label, why: "the list spells the same place with its region inserted" } : null;
}

/**
 * The option labels a control is offering right now. Reading a combobox means typing into it —
 * the menu does not exist otherwise — so the probe blurs afterwards, which drops the typed filter
 * and commits nothing (the same reason both adapters dismiss with `blur`, never Escape).
 */
export async function probeVocabulary(page, question, value, { timeout = OPTION_WAIT_MS } = {}) {
  const selector = question?.selector;
  if (!selector) return [];
  const control = question?.control ?? "text";

  if (control === "native_select") {
    return uniq(await page.$$eval(`${selector} option`, (els) => els.map((el) => el.textContent ?? "")).catch(() => []));
  }
  if (control === "radio" || control === "checkbox" || control === "checkbox_group") {
    // The selector may name the group's members or the field that contains them; try both, and
    // include the button groups a segmented control renders instead of inputs.
    const members = ["input[type=radio]", "input[type=checkbox]", "button[data-option]", '[role="radio"]']
      .map((m) => `${selector} ${m}`)
      .join(", ");
    const inner = uniq(await page.$$eval(members, groupLabels).catch(() => []));
    if (inner.length) return inner;
    return uniq(await page.$$eval(selector, groupLabels).catch(() => []));
  }

  const input = page.locator(selector).first();
  if (!(await input.count().catch(() => 0))) return [];
  try {
    await pace(page, input);
    await input.click({ timeout: 5000 });
    const key = norm(value).slice(0, 24);
    if (key) await input.pressSequentially(key, { delay: 35 });
    const { labels } = await waitForOptions(page, input, null, timeout);
    return uniq(labels);
  } catch {
    return [];
  } finally {
    await input.blur().catch(() => {});
  }
}


/** In-page: the visible label of each control in a radio/checkbox/button group. */
function groupLabels(els) {
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  return els.map((el) => {
    if (el.tagName === "BUTTON") return clean(el.getAttribute("data-option") || el.textContent);
    const tied = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    return clean(tied?.textContent ?? el.closest("label")?.textContent ?? el.value ?? "");
  });
}

const uniq = (labels) => [...new Set(labels.map((l) => norm(l)).filter(Boolean))];

// ─── snapshot diff, delta re-plan, verification ───────────────────────────────────────────────

/**
 * The live required-control snapshot, split three ways.
 * `unknown` rows are the conditional follow-ups: required, empty, and not in the plan.
 */
export async function inspect({ page, ats, formPlan, decisions }) {
  const rows = await snapshotRequired(page, { ats });
  const filled = [];
  const unfilled = [];
  const unknown = [];
  for (const row of rows) {
    const decision = decisionFor(row, formPlan, decisions);
    if (row.filled) {
      filled.push(row);
      continue;
    }
    if (decision) unfilled.push({ row, decision });
    else unknown.push(row);
  }
  return { rows, filled, unfilled, unknown };
}

/** DOM row → the Decision that owns it: by qid, by the plan's selector, then by label. */
function decisionFor(row, formPlan, decisions) {
  const keys = new Set([row.qid, row.selector].filter(Boolean).map(String));
  const label = normLabel(row.label ?? "");
  for (const q of formPlan?.questions ?? []) {
    // A repeating section is one control to the page's snapshot (Ashby reports the whole history
    // field by its path) and many rows to the plan; its first row speaks for it.
    if (keys.has(q.qid) || keys.has(q.selector) || (q.repeat?.of && keys.has(q.repeat.of)) || (label && normLabel(q.label) === label)) {
      const owner = decisions.find((d) => d.qid === q.qid);
      if (owner) return owner;
    }
  }
  return decisions.find((d) => keys.has(d.qid) || (label && normLabel(d.label ?? "") === label)) ?? null;
}

/**
 * A DOM-discovered required control → a FormPlan question, so the deterministic resolver and Jev
 * see exactly the shape they see for a question that came from the schema.
 */
export async function describeControl(page, row) {
  const shape = await page.evaluate(readShape, row.selector).catch(() => null);
  const type = shape?.type ?? "text";
  const options = uniq(shape?.options ?? []);
  const label = row.label || row.selector;
  return {
    qid: row.qid || `dom_${slugish(label)}`,
    label,
    required: true,
    section: "conditional",
    type,
    control: shape?.control ?? "text",
    selector: row.selector,
    ...(options.length ? { options: options.map((o) => ({ label: o, value: o })) } : {}),
    class: classify(label, "", type, true),
  };
}

/** In-page shape probe: tag/type/vocabulary of whatever the selector points at. */
function readShape(selector) {
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const host = document.querySelector(selector);
  if (!host) return null;
  const el = host.matches("input, textarea, select")
    ? host
    : host.querySelector("input, textarea, select") ?? host;
  const scope = el.closest("fieldset, [data-field-path], .field, .select-shell") ?? host.parentElement ?? document;
  const labelsOf = (nodes) =>
    nodes.map((n) => {
      if (n.tagName === "BUTTON") return clean(n.getAttribute("data-option") || n.textContent);
      const tied = n.id ? document.querySelector(`label[for="${CSS.escape(n.id)}"]`) : null;
      return clean(tied?.textContent ?? n.closest("label")?.textContent ?? n.value ?? "");
    });
  const tag = el.tagName.toLowerCase();
  if (tag === "select") return { type: "single_select", control: "native_select", options: [...el.options].map((o) => clean(o.textContent)) };
  if (tag === "textarea") return { type: "textarea", control: "textarea", options: [] };
  if (el.type === "file") return { type: "file", control: "file", options: [] };
  if (el.type === "radio") {
    const group = el.name ? [...scope.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)] : [el];
    return { type: "single_select", control: "radio", options: labelsOf(group) };
  }
  if (el.type === "checkbox") {
    const group = [...scope.querySelectorAll('input[type="checkbox"]')];
    return { type: group.length > 1 ? "multi_select" : "boolean", control: "checkbox", options: labelsOf(group) };
  }
  const buttons = [...scope.querySelectorAll("button[data-option]")];
  if (buttons.length) return { type: "boolean", control: "radio", options: labelsOf(buttons) };
  if (String(el.className || "").includes("select__input") || el.getAttribute("role") === "combobox") {
    return { type: "single_select", control: "react_select", options: [] };
  }
  if (el.type === "tel") return { type: "phone", control: "tel", options: [] };
  return { type: "text", control: "text", options: [] };
}

const slugish = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "field";

/**
 * Step 11's verification pass. Every required control that is still empty and was *planned* to be
 * filled becomes an `ask`: the user's form is half-filled, so the question explains itself (D13).
 */
export async function verify({ page, ats, formPlan, decisions, slug }) {
  const state = await inspect({ page, ats, formPlan, decisions });
  for (const { row, decision } of state.unfilled) {
    if (decision.action === "ask") continue;
    markAsk(decision, `"${row.label || decision.label}" is required and still empty on the form`, { shot: decision.shot });
  }
  await appendTrace(slug, {
    op: "snapshot",
    stage: "verify",
    required: state.rows.length,
    filled: state.filled.length,
    unfilled: state.unfilled.length,
    unknown: state.unknown.length,
  });
  return state;
}

// ─── the browser half, end to end ─────────────────────────────────────────────────────────────

/**
 * Steps 8–11 for one posting. Mutates `decisions` (read-backs, failed rows → `ask`) and returns
 * the conditional questions it discovered, so the caller can freeze them with the plan.
 *
 * `draft` is step 10's writer, injected the same way `replan` is and for the same reason: this
 * module drives the DOM and decides nothing. It is handed the rows the planner marked `draft`,
 * puts text on the ones it can ground and turns the rest into `ask` — then the fill loop below
 * types the result into the control and reads it back like any other value.
 *
 * @param {{context:object, formPlan:object, decisions:object[], slug:string, budget:object,
 *          replan?:{questions?:Function}, draft?:{rows?:Function}, attach?:boolean,
 *          rows?:object[]|null}} args
 * @returns {Promise<{page:object, added:object[], filled:number, failed:number, appeared:object[],
 *                    baseline:object[], state:object}>}
 */
export async function runBrowser({ context, formPlan, decisions, slug, budget, replan = null, draft = null, attach = false, rows = null }) {
  const ats = formPlan?.ats ?? atsFromUrl(formPlan?.url) ?? null;
  const url = formPlan?.url;
  if (!url) throw new Blocked("no_page", "the plan carries no posting URL");

  const { page, reused, reloaded } = attach ? await attachPosting(context, url) : await openPosting(context, url);
  if (!page) throw new Blocked("no_page", `no open tab for ${url} — run \`apply.mjs --url ${url}\` first`);
  await appendTrace(slug, { op: "open", url, attach, reused, reloaded });

  try {
    try {
      await waitForForm(page, { ats, timeout: 30000 });
    } catch {
      throw new Blocked("no_form", `the application form did not render at ${url}`);
    }

    const baseline = await snapshotRequired(page, { ats });
    await appendTrace(slug, { op: "snapshot", stage: "baseline", required: baseline.length, filled: baseline.filter((r) => r.filled).length });

    // Step 10 — the writer, before the fill loop so a drafted answer is set, read back and traced
    // exactly like a value that came out of memory.
    if (draft?.rows) await draft.rows(rows ?? decisions);

    const first = await executeRows({ page, ats, formPlan, decisions, slug, budget, rows });
    let filled = first.filled;
    let failed = first.failed;

    // Step 8½ — the demographic block as the *page* renders it. The Greenhouse schema does not
    // describe that block field for field (`#hispanic_ethnicity` is published by no schema row,
    // and `#race` is not in the DOM until the ethnicity question is answered), so this is the
    // only pass that can reach it. It answers nothing itself: every row goes through `replan`,
    // i.e. the same resolver and `p.eeo` preference a schema row would.
    const added = [];
    const live = await fillLiveSensitive({ page, ats, formPlan, decisions, slug, budget, replan, added });
    filled += live.filled;
    failed += live.failed;

    // Conditional follow-ups: re-plan only what the form grew, at most twice (step 9).
    const appeared = [];
    for (let round = 1; replan?.questions && round <= LIMITS.deltaRounds; round += 1) {
      budget.check();
      const { unknown } = await inspect({ page, ats, formPlan, decisions });
      if (!unknown.length) break;
      const fresh = [];
      for (const row of unknown) fresh.push(await describeControl(page, row));
      const known = new Set(formPlan.questions.map((q) => q.qid));
      const novel = fresh.filter((q) => !known.has(q.qid));
      if (!novel.length) break;
      await appendTrace(slug, { op: "delta", round, questions: novel.map((q) => ({ qid: q.qid, label: q.label, control: q.control })) });
      appeared.push(...unknown);
      added.push(...novel);
      formPlan.questions.push(...novel);
      const planned = await replan.questions(novel);
      decisions.push(...planned);
      // A conditional essay only exists once the form is half-filled; it gets the writer too.
      if (draft?.rows) await draft.rows(planned);
      const next = await executeRows({ page, ats, formPlan, decisions, slug, budget, rows: planned.filter(runnable) });
      filled += next.filled;
      failed += next.failed;
    }

    const state = await verify({ page, ats, formPlan, decisions, slug });
    await appendTrace(slug, { op: "execute", filled, failed, added: added.length, ms: budget.elapsed() });
    return { page, added, appeared, filled, failed, baseline, state };
  } catch (err) {
    if (err instanceof Blocked && !err.shot) err.shot = await captureFailure(page, { slug, mask: formPlan }, { qid: `blocked_${err.reason}` });
    throw err;
  }
}

// ─── the demographic block the schema does not describe ───────────────────────────────────────
//
// Measured on togetherai/5179372007: the board renders `#hispanic_ethnicity`, which the
// Greenhouse API publishes no question for, and it does not render `#race` at all until that
// ethnicity question is answered (the EEO-1 flow asks ethnicity first). A runner driving only the
// schema's rows therefore misses one control entirely and reports the other as "not on the page".
//
// So the block is read off the page (`adapters/greenhouse.eeoControls`, which opens no menu and
// writes nothing), matched against the rows the plan already has, and filled in two rounds — the
// second round is what catches a control that mounts in response to the first answer. Nothing
// here decides an answer: a control the plan has no row for goes through `replan`, so `p.eeo` and
// the gates decide exactly as they do for a schema row. An adapter with no `eeoControls` (Ashby,
// generic) skips the whole pass.

const indexKey = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Both sides' spellings of one control: the normalizer files `demographic_<id>`, the DOM says `<id>`. */
const keysFor = (row) => {
  const qid = indexKey(row?.qid);
  return [qid, qid.replace(/^demographic/, ""), `demographic${qid}`, indexKey(row?.label)].filter(Boolean);
};

/**
 * Live controls → what to do with each. Pure, so the rule is testable without a browser.
 *
 * `retry` is a control the plan already has an answer for that has not been committed yet — the
 * `#race` case, where the row was marked `ask` only because the control was not in the DOM when
 * the fill loop reached it. `novel` is a control no plan row describes. A row that is already
 * read back ok, and a row the plan has no value for, are both left exactly alone: the first is
 * done, the second is the user's to answer.
 *
 * @returns {{retry:Array<{live:object, question:object, decision:object}>, novel:object[]}}
 */
export function matchLiveControls(live, { questions = [], decisions = [] } = {}) {
  const byKey = new Map();
  for (const q of questions) for (const key of keysFor(q)) if (key && !byKey.has(key)) byKey.set(key, q);
  const byQid = new Map(decisions.map((d) => [d.qid, d]));

  const retry = [];
  const novel = [];
  for (const row of live) {
    if (!row?.selector) continue;
    const question = keysFor(row).map((key) => byKey.get(key)).find(Boolean) ?? null;
    if (!question) {
      novel.push({
        qid: row.qid,
        label: row.label || row.qid,
        section: row.section || null,
        required: false,
        type: row.multiple ? "multi_select" : "single_select",
        control: row.control,
        selector: row.selector,
        // A board that renders its options in the DOM (Lever's radio surveys) hands them over so
        // `p.eeo` is mapped onto the form's own wording; Greenhouse's closed menus send none.
        ...(row.options?.length ? { options: row.options } : {}),
        class: "sensitive",
      });
      continue;
    }
    const decision = byQid.get(question.qid);
    if (!decision || decision.readback?.ok === true) continue;
    // Only a row that already carries the answer `p.eeo` resolved may be driven again; a row with
    // no value is an open question, and reviving it would be this file deciding one.
    if (decision.value == null && decision.option == null) continue;
    retry.push({ live: row, question, decision });
  }
  return { retry, novel };
}

async function fillLiveSensitive({ page, ats, formPlan, decisions, slug, budget, replan = null, added = [] }) {
  const out = { filled: 0, failed: 0 };
  const adapter = boardAdapter(ats);
  if (typeof adapter.eeoControls !== "function") return out;

  const seen = new Set();
  for (let round = 1; round <= LIMITS.deltaRounds; round += 1) {
    budget.check();
    const live = (await adapter.eeoControls(page).catch(() => [])).filter((r) => r?.selector && !seen.has(r.qid));
    if (!live.length) break;
    for (const row of live) seen.add(row.qid);

    const { retry, novel } = matchLiveControls(live, { questions: formPlan.questions, decisions });
    const rows = [];
    const retried = [];
    for (const { live: row, question, decision } of retry) {
      // The page is the authority on where the control is and what kind it is.
      question.selector = row.selector;
      question.control = row.control;
      question.type = row.multiple ? "multi_select" : "single_select";
      if (decision.action === "ask") decision.action = "check";
      retried.push(decision);
      rows.push(decision);
    }
    if (novel.length && replan?.questions) {
      // qid and control only: a demographic question's own wording stays out of the trace.
      await appendTrace(slug, { op: "delta", stage: "sensitive", round, questions: novel.map((q) => ({ qid: q.qid, control: q.control })) });
      formPlan.questions.push(...novel);
      const planned = await replan.questions(novel);
      decisions.push(...planned);
      added.push(...novel);
      rows.push(...planned.filter(runnable));
    }
    if (!rows.length) continue;

    try {
      const result = await executeRows({ page, ats, formPlan, decisions, slug, budget, rows });
      out.filled += result.filled;
      out.failed += result.failed;
      for (const d of retried) restoreRetried(d);
    } catch (err) {
      // A demographic block the adapter cannot drive must not cost the user the application: the
      // rows are already `ask` with their screenshots, and `no_progress` here means "this block
      // would not take a value", not "the page is dead". Every other stop rule still throws.
      if (!(err instanceof Blocked && err.reason === "no_progress")) throw err;
      await appendTrace(slug, { op: "delta", stage: "sensitive", round, blocked: "no_progress", detail: err.message });
      for (const d of retried) restoreRetried(d);
      budget.noChange = 0;
      break;
    }
  }
  return out;
}

/** A `why` left behind by an attempt that did not reach the control, or that the form refused. */
const FAILED_WHY_RE = /control_not_found|the form would not take it|no control for this question|only shows this once/i;

/**
 * The retry's verdict, written back over the first attempt's. A control that was only missing
 * from the DOM is now set: the row goes back to what it was before `markAsk` touched it, so the
 * summary reports the `p.eeo` source it was filled from, not "the form would not take it" about
 * a value the read-back shows committed. A row the retry did not reach is still an open question
 * and is put back the way it came in.
 *
 * A11: the restore is not conditional on `_was` being there. A row whose first attempt happened
 * in an *earlier* run carries the complaint without the memory of what it was before, and a
 * `readback.ok === true` beside "the form would not take it" is the sentence the user reads —
 * so a committed row never keeps a failure `why`, whatever the retry knows about its past.
 */
export function restoreRetried(d) {
  const was = d._was;
  delete d._was;
  if (d.readback?.ok === true) {
    if (was) {
      d.action = was.action === "ask" ? "check" : was.action;
      d.why = was.why;
    } else if (d.action === "ask" || FAILED_WHY_RE.test(String(d.why ?? ""))) {
      d.action = d.action === "ask" ? "check" : d.action;
      d.why = "set on the retry pass, once the control was on the page";
    }
    delete d.shot;
    return;
  }
  if (d.action !== "ask") {
    markAsk(d, was?.why ?? d.why);
    delete d._was;
  }
}

// ─── submit ───────────────────────────────────────────────────────────────────────────────────
//
// The runner clicks Submit only when the user's own `p.auto_submit` preference says so *and* the
// form has nothing left to ask (`submitReadiness`). `scripts/apply.mjs` owns that decision; this
// module owns the mechanics, identically for every board:
//
//   findSubmit   the adapter's control, or nothing — never a guess at which button applies
//   captcha wait Greenhouse injects its reCAPTCHA script after the form renders, and a click
//                before `window.grecaptcha` exists posts a form with no token: the board answers
//                that with an error banner, which from outside is indistinguishable from a
//                rejected application
//   click        scrolled into view, real mouse move, the fill loop's own 150–400 ms cadence
//   confirm      poll the adapter's confirmation rules for ≤45 s, stopping early the moment the
//                page says it failed (a visible captcha *challenge* or an error banner)
//
// A submit that is not confirmed is never reported as success and never retried: it becomes
// `blocked{reason:"submit_failed"}` with a screenshot, and the tab is left exactly as it is so
// the user can finish by hand.

export const SUBMIT = { timeoutMs: 45000, captchaWaitMs: 5000, pollMs: 500, clickTimeoutMs: 15000 };

/** What a visible banner has to say for the page to count as "not submitted". */
const FAILURE_RE = /error|try again|captcha/i;

/**
 * The adapter module for a board, with `generic` as the answer for a page that has no ATS at all
 * (a fixture, an unrecognised careers page). Unlike `adapters/index.mjs`'s `adapterFor`, this one
 * never throws: the passes that use it — the live demographic block, submit detection, submit —
 * all have a working generic implementation.
 */
export const boardAdapter = (ats) => adapters[String(ats ?? "").toLowerCase()] ?? adapters.generic;

/** The confirmation rules an adapter would apply, as printable strings (`--detect-submit`). */
export function describeConfirmation(ats) {
  const c = boardAdapter(ats).CONFIRMATION ?? {};
  return {
    strategy: c.strategy ?? null,
    ...(c.url ? { url: c.url.source } : {}),
    ...(c.text ? { text: c.text.source } : {}),
    ...(c.selectors?.length ? { selectors: c.selectors } : {}),
    ...(c.toast?.length ? { toast: c.toast } : {}),
    form_gone_required: c.formGone === true,
  };
}

/**
 * May this application be submitted? Zero questions left for the user and zero required controls
 * still empty — including the ones the plan never knew about (a conditional follow-up the form
 * grew while it was being filled). Anything else, and the user looks at the form first.
 *
 * `sensitive` is reported, never subtracted: a demographic row the resolver could not map (a
 * multi-select where the saved answer matches three of the form's options) is an open question
 * about the user even though the control itself is optional, and auto-submitting past it would
 * answer it by omission. The count exists so the caller can say *which* question is holding the
 * click, not so it can ignore it.
 */
export function submitReadiness({ decisions = [], state = null } = {}) {
  const asks = decisions.filter((d) => d.action === "ask");
  const required_empty = state ? (state.unfilled?.length ?? 0) + (state.unknown?.length ?? 0) : 0;
  const sensitive = asks.filter((d) => d.class === "sensitive").length;
  return { ready: asks.length === 0 && required_empty === 0, asks: asks.length, sensitive, required_empty };
}

/**
 * Has Submit already been clicked for this application? The one question that must never be
 * answered optimistically: a second click sends a second application, which no user can take back.
 *
 * Two sources, because each alone has a hole:
 *  - `decisions.json` (`frozen`) carries `submitted` / `submit_attempted`, but it is written by
 *    `settle()` **after** the confirmation wait — kill the process during those 45 s and the click
 *    that already posted leaves no record there at all;
 *  - `trace.jsonl` carries the `stage:"attempt"` row appended *before* the click, and it is
 *    append-only across runs, so it survives exactly that crash. It is also the file a user may
 *    delete, which is why the frozen record is still read.
 *
 * A failure that never reached the button (`submit_not_found`) writes neither an attempt row nor
 * `clicked:true`, so it stays retryable.
 *
 * @returns {Promise<{attempted:boolean, confirmed:boolean, sources:string[]}>}
 */
export async function priorSubmit(slug, frozen = null) {
  const out = { attempted: false, confirmed: false, sources: [] };
  if (!slug) return out;

  if (frozen?.submitted === true || frozen?.submit_attempted === true) {
    out.attempted = true;
    out.confirmed = frozen.submitted === true;
    out.sources.push("decisions.json");
  }

  const raw = await readFile(tracePath(slug), "utf8").catch(() => null);
  if (raw) {
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let row = null;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // a truncated last line is not a reason to forget a click
      }
      if (row?.op !== "submit") continue;
      if (row.stage !== "attempt" && row.clicked !== true && row.ok !== true) continue;
      out.attempted = true;
      if (row.ok === true) out.confirmed = true;
      if (!out.sources.includes("trace.jsonl")) out.sources.push("trace.jsonl");
    }
  }
  return out;
}

/**
 * `p.auto_submit`'s stored value → may the runner click Submit at all? Pure, so the scope
 * resolution (company > role_family > global) stays with the caller and only the reading of the
 * value lives here.
 *
 * Everything that is not an explicit yes is a **no**: absent, null, an empty string, "maybe",
 * an object with no answer. Auto-submit is the one preference where a wrong default sends an
 * application nobody approved, so it is never inferred (AGENTS.md: no personal decision is
 * defaulted).
 */
export function autoSubmitOn(value) {
  const raw = value && typeof value === "object" ? value.answer ?? value.value : value;
  if (raw === true) return true;
  return ["yes", "true", "on", "1"].includes(String(raw ?? "").trim().toLowerCase());
}

/** ≤5 s for a lazily injected captcha script, and only on a page that references one at all. */
async function waitForCaptcha(page, timeout = SUBMIT.captchaWaitMs) {
  const referenced = await page
    .evaluate(() => Boolean(document.querySelector('script[src*="recaptcha"], script[src*="hcaptcha"], .grecaptcha-badge, [data-sitekey]')))
    .catch(() => false);
  if (!referenced) return { referenced: false, ready: null, waited_ms: 0 };
  const started = Date.now();
  const ready = await waitUntil({
    read: () =>
      page
        .evaluate(() => Boolean(window.grecaptcha || window.hcaptcha || document.querySelector(".grecaptcha-badge")))
        .catch(() => false),
    ok: (v) => v === true,
    timeout,
    every: 250,
  });
  return { referenced: true, ready: ready === true, waited_ms: Date.now() - started };
}

/**
 * The page saying "not submitted": a captcha *challenge* on screen, or a visible banner that
 * reads like a failure. Two things this must never do, because both would fail every real
 * Greenhouse submission:
 *  - scan the whole page: every board carries "This site is protected by reCAPTCHA …" in its
 *    footer, which the `captcha` half of FAILURE_RE matches. Only the banner elements
 *    (`ALERT_SELECTORS`) are read, and the captcha boilerplate is dropped even when it turns up
 *    inside one;
 *  - treat the invisible reCAPTCHA badge as a challenge — `CAPTCHA_SELECTORS` names the bframe
 *    popup only, and `readSignals` requires it to be visible and larger than 40×40.
 */
const CAPTCHA_BOILERPLATE = /protected by recaptcha|privacy policy and terms of service apply/i;

function submitFailure(signals) {
  if (signals?.captcha) {
    return { cause: "captcha_challenge", detail: "a captcha challenge is on screen — the runner never solves one" };
  }
  const banner = (signals?.alerts ?? []).find((line) => FAILURE_RE.test(line) && !CAPTCHA_BOILERPLATE.test(line));
  return banner ? { cause: "error_banner", detail: banner } : null;
}

/**
 * What is on top of the Submit control (B12). The runner scrolls the button into view and
 * clicks it; a board's own cookie card sits above the form in z-order, so a click on a covered
 * button lands on the card and the board never sees a submit — a failure that looks, from the
 * outside, exactly like a rejected application.
 *
 * Five sample points (the centre and four inset corners) are hit-tested against the button's own
 * subtree. Anything else that answers is described by tag and by the shortest handle it has —
 * never by the form's contents. Returns null when this page has no submit control at all: that
 * is `submit_not_found`'s business, not this rule's.
 *
 * @returns {Promise<{selector:string, label:string, overlaps:Array<{tag:string, name:string}>}|null>}
 */
export async function submitObstruction({ page, ats = null, formPlan = null }) {
  const board = ats ?? formPlan?.ats ?? atsFromUrl(page?.url?.() ?? "") ?? null;
  const control = await boardAdapter(board).findSubmit(page);
  if (!control) return null;
  // The same scroll the click does, first: a button below the fold is not "clear", it is
  // unreadable, and the hit test only means anything over the box the click will land on.
  await page.locator(control.selector).first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  const overlaps = await page.evaluate(readCover, control.selector).catch(() => []);
  return { selector: control.selector, label: control.text || "Submit", overlaps };
}

/** In-page: which elements answer `elementFromPoint` over the submit control's own box. */
function readCover(selector) {
  const el = document.querySelector(selector);
  if (!el) return [];
  const box = el.getBoundingClientRect();
  if (!box.width || !box.height) return [];
  const inset = 2;
  const points = [
    [box.left + box.width / 2, box.top + box.height / 2],
    [box.left + inset, box.top + inset],
    [box.right - inset, box.top + inset],
    [box.left + inset, box.bottom - inset],
    [box.right - inset, box.bottom - inset],
  ];
  const seen = new Map();
  for (const [x, y] of points) {
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
    const tag = hit.tagName.toLowerCase();
    const name = (hit.id && `#${hit.id}`) || (hit.getAttribute("data-testid") && `[${hit.getAttribute("data-testid")}]`) ||
      (typeof hit.className === "string" && hit.className.trim() ? `.${hit.className.trim().split(/\s+/)[0]}` : tag);
    if (!seen.has(name)) seen.set(name, { tag, name });
  }
  return [...seen.values()];
}

/**
 * Click Submit and wait for the board to confirm it.
 *
 * @param {{page:object, ats?:string|null, formPlan?:object|null, slug?:string|null,
 *          timeout?:number}} args
 * @returns {Promise<{ok:boolean, selector:string|null, button?:string,
 *   confirmation:{detected:boolean, strategy?:string, url?:string, text?:string, screenshot?:string},
 *   reason?:string, cause?:string, detail?:string, shot?:string, ms:number}>}
 *   `ok:false` is always `reason:"submit_failed"` — the caller turns it into `blocked` and leaves
 *   the tab open. The per-posting budget is deliberately not charged here: submission happens
 *   after step 11, and a board that takes 40 s to answer is not a runaway fill loop.
 */
export async function submitApplication({ page, ats = null, formPlan = null, slug = null, timeout = SUBMIT.timeoutMs }) {
  const board = ats ?? formPlan?.ats ?? atsFromUrl(page?.url?.() ?? "") ?? null;
  const adapter = boardAdapter(board);
  const started = Date.now();

  const control = await adapter.findSubmit(page);
  if (!control) {
    return failSubmit({
      page,
      slug,
      formPlan,
      control: null,
      cause: "submit_not_found",
      detail: `no submit control on this form (${board ?? "generic"} rules)`,
      ms: Date.now() - started,
    });
  }

  const captcha = await waitForCaptcha(page);
  const button = page.locator(control.selector).first();

  // The attempt is recorded **before** the click, not after the verdict. A click that lands and
  // whose confirmation is then missed (a slow board, a lost tab) is the one state that can send
  // an application twice: the next run reads this row — and the `submit_attempted` flag the
  // caller freezes from it — and refuses to click again.
  await appendTrace(slug, { op: "submit", stage: "attempt", selector: control.selector, button: control.text, found_by: control.strategy, captcha, url: page.url?.() ?? null });

  let clickError = null;
  let clicked = false;
  try {
    await button.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await pace(page, button);
    await button.click({ timeout: SUBMIT.clickTimeoutMs });
    clicked = true;
  } catch (err) {
    // A click that races the confirmation navigation throws *after* the page is already gone, so
    // the verdict still comes from the wait below; this is only reported if nothing lands. The
    // attempt counts as made either way — the throw does not prove the click did not register.
    clickError = String(err?.message ?? err).split("\n")[0].slice(0, 160);
  }

  const selectors = adapter.CONFIRMATION?.selectors ?? [];
  const toast = adapter.CONFIRMATION?.toast ?? [];
  const deadline = Date.now() + timeout;
  let confirmation = { detected: false };
  let failure = null;
  for (;;) {
    const signals = await adapters.generic.readSignals(page, { selectors, toast });
    confirmation = await adapter.confirmSubmitted(page, { signals });
    if (confirmation.detected) break;
    // Confirmation first, failure second: a receipt page that happens to carry the word "error"
    // somewhere in its footer is still a receipt.
    failure = submitFailure(signals);
    if (failure) break;
    if (Date.now() >= deadline) break;
    await sleep(SUBMIT.pollMs);
  }

  const ms = Date.now() - started;
  if (!confirmation.detected) {
    return failSubmit({
      page,
      slug,
      formPlan,
      control,
      captcha,
      clicked: true,
      cause: failure?.cause ?? (clickError ? "click_failed" : "no_confirmation"),
      detail: failure?.detail ?? clickError ?? confirmation.reason ?? `no confirmation within ${Math.round(timeout / 1000)}s`,
      ms,
    });
  }

  const screenshot = await submittedShot(page, slug, formPlan);
  const record = {
    detected: true,
    strategy: confirmation.strategy ?? adapter.CONFIRMATION?.strategy ?? null,
    ...(confirmation.url ? { url: confirmation.url } : {}),
    ...(confirmation.text ? { text: confirmation.text } : {}),
    ...(screenshot ? { screenshot } : {}),
  };
  await appendTrace(slug, { op: "submit", ok: true, clicked, selector: control.selector, button: control.text, found_by: control.strategy, captcha, confirmation: record, ms });
  return { ok: true, clicked: true, selector: control.selector, button: control.text, confirmation: record, captcha, ms };
}

/**
 * One shape for every way a submit can fail: a screenshot, a trace row, `reason:"submit_failed"`.
 * `clicked` is the fact the next run needs — a failure *before* the click (no control on the
 * form) may be retried freely; a failure after one may not, because the board may have taken it.
 */
async function failSubmit({ page, slug, formPlan, control, cause, detail, captcha = null, clicked = false, ms }) {
  const shot = await captureFailure(page, { slug, mask: formPlan }, { qid: "submit" });
  const row = {
    op: "submit",
    ok: false,
    clicked,
    selector: control?.selector ?? null,
    button: control?.text ?? null,
    reason: "submit_failed",
    cause,
    detail,
    ...(captcha ? { captcha } : {}),
    confirmation: { detected: false },
    ...(shot ? { shot } : {}),
    ms,
  };
  await appendTrace(slug, row);
  return {
    ok: false,
    clicked,
    reason: "submit_failed",
    cause,
    detail,
    ...(shot ? { shot } : {}),
    selector: control?.selector ?? null,
    ...(control?.text ? { button: control.text } : {}),
    confirmation: { detected: false },
    ms,
  };
}

/**
 * The receipt: `applications/<slug>/submitted.png`, with every `sensitive` control painted over
 * first. An in-place confirmation still has the filled form under it, and a filled demographic
 * block is never photographed (AGENTS.md).
 */
async function submittedShot(page, slug, formPlan) {
  if (!slug || !page || page.isClosed?.()) return null;
  const file = nodePath.join(traceDir(slug), "submitted.png");
  try {
    await mkdir(nodePath.dirname(file), { recursive: true, mode: 0o700 });
    const mask = maskSelectors(formPlan).map((selector) => page.locator(selector));
    await page.screenshot({ path: file, timeout: 10000, ...(mask.length ? { mask } : {}) });
    return file;
  } catch {
    return null;
  }
}

/** One submit result → the status the host reads (`apply.mjs`, `scripts/submit-smoke.mjs`). */
export function submitOutcome(result) {
  if (!result) return null;
  return result.ok
    ? { status: "submitted", confirmation: result.confirmation }
    : {
        status: "blocked",
        reason: "submit_failed",
        ...(result.shot ? { screenshot: result.shot } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
        ...(result.cause ? { cause: result.cause } : {}),
      };
}

/**
 * `--dry-run --detect-submit`: which control *would* be clicked and how the confirmation would be
 * recognised, read off the live page. Nothing is filled, nothing is clicked, nothing is written
 * to the page — this is the only submit path that is safe against a real posting.
 */
export async function detectSubmit({ context, formPlan, slug = null, timeout = 30000 }) {
  const ats = formPlan?.ats ?? atsFromUrl(formPlan?.url) ?? null;
  const url = formPlan?.url;
  if (!url) throw new Blocked("no_page", "the plan carries no posting URL");
  const { page } = await openPosting(context, url, { reload: false });
  if (!page) throw new Blocked("no_page", `no tab could be opened for ${url}`);
  const adapter = boardAdapter(ats);
  await adapter.waitForForm(page, { timeout }).catch(() => {});
  const control = await adapter.findSubmit(page);
  const out = {
    ats,
    url: page.url(),
    would_click: control ? { selector: control.selector, text: control.text, found_by: control.strategy } : null,
    confirmation: describeConfirmation(ats),
    clicked: false,
  };
  if (slug) await appendTrace(slug, { op: "submit_detect", ...out });
  return out;
}
