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

import { atsFromUrl, handles, resolveSelector, setField, snapshotRequired, uploadFile, waitForForm } from "../browser/adapters/index.mjs";
import { detectControl, waitForOptions } from "../browser/controls.mjs";
import { findTab, openTab, pagesOf } from "../browser/chrome.mjs";
import { norm, normLabel, pace } from "../browser/readback.mjs";
import { appendTrace, captureFailure } from "../browser/trace.mjs";
import { classify } from "../schema/classes.mjs";
import { choice, systemOne, withNone, NONE } from "../jev/client.mjs";
import { gate, runnerUpGap } from "../jev/gates.mjs";
import { normalizeOption } from "../jev/plan.mjs";

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

/** Rows the executor still has work for: planned to be set, not yet set successfully. */
export const runnable = (d) => (d.action === "fill" || d.action === "check") && d.readback?.ok !== true;

function markAsk(d, why, { shot = null, options = null } = {}) {
  d.action = "ask";
  d.why = why;
  d.confidence = undefined;
  d.gap = undefined;
  if (shot) d.shot = shot;
  if (options?.length) d.options = options;
  return d;
}

/**
 * Set every row through its adapter. Mutates the Decision objects it is given: `readback` lands on
 * the row, and a row the form would not take becomes an `ask` carrying its screenshot.
 * @returns {Promise<{filled:number, failed:number, executed:number}>}
 */
export async function executeRows({ page, ats, formPlan, decisions, slug, budget, rows = null }) {
  const questions = formPlan?.questions ?? [];
  const byQid = new Map(questions.map((q) => [q.qid, q]));
  const order = new Map(questions.map((q, i) => [q.qid, i]));
  const todo = (rows ?? decisions.filter(runnable))
    .slice()
    .sort((a, b) => (order.get(a.qid) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.qid) ?? Number.MAX_SAFE_INTEGER));

  // A Jev-resolved option whose margin over the runner-up is thin is filled but flagged, the same
  // way `gate` treats a thin margin in the offline plan (PLAN §2.2 step 7).
  const thin = new Set();
  const chooseOption = optionChooser({ slug, budget, onCheck: (q) => thin.add(q?.qid) });
  let filled = 0;
  let failed = 0;
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
    d.readback = { ok: result.ok === true, observed: question.class === "sensitive" ? "" : String(result.observed ?? ""), attempts: result.attempts ?? 0 };
    if (result.ok) {
      filled += 1;
      delete d.shot;
      if (thin.has(d.qid) && d.action !== "ask") {
        d.action = "check";
        d.why = `${d.why} — matched to the form's own wording, worth a look`;
      }
    } else {
      failed += 1;
      markAsk(d, `the form would not take it (${result.reason ?? "read-back mismatch"}) — intended: ${clipValue(d, question)}`, { shot: result.shot });
    }
    budget.progress(result.ok === true);
  }
  return { filled, failed, executed: todo.length };
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
  const selector = await resolveSelector(page, ats, question);
  const detected = await detectControl(page, selector, { question });
  if (!detected.agreed) {
    await appendTrace(slug, {
      op: "detect",
      qid: question.qid,
      planned: detected.planned,
      control: detected.control,
      why: detected.why,
      route: handles(ats, detected.control) ? ats : "generic",
    });
    question.control = detected.control;
  }

  // A select whose vocabulary the schema did not carry (an autocomplete): the form's own list
  // only exists once you type into it, so it is read off the DOM — and only an exact match may
  // be committed from it. See resolveVocabulary.
  if (OPTION_CONTROLS.has(detected.control) && decision.option == null && !(question.options ?? []).length) {
    const picked = await resolveVocabulary({ page, question, decision, slug, selector });
    if (!picked.ok) return null;
  }

  // `setField` routes a control this ATS adapter does not tune to `adapters/generic.mjs`.
  return setField(page, question, decision.option ?? decision.value, { ...opts, detected, selector });
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
  markAsk(decision, `${decision.why} — the form's own list has no entry for "${clipValue(decision, question)}"; which one should I pick?`, { options: labels });
  return { ok: false };
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
    if (keys.has(q.qid) || keys.has(q.selector) || (label && normLabel(q.label) === label)) {
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
 * @param {{context:object, formPlan:object, decisions:object[], slug:string, budget:object,
 *          replan?:{questions?:Function}, attach?:boolean, rows?:object[]|null}} args
 * @returns {Promise<{page:object, added:object[], filled:number, failed:number, appeared:object[],
 *                    baseline:object[], state:object}>}
 */
export async function runBrowser({ context, formPlan, decisions, slug, budget, replan = null, attach = false, rows = null }) {
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

    const first = await executeRows({ page, ats, formPlan, decisions, slug, budget, rows });
    let filled = first.filled;
    let failed = first.failed;

    // Conditional follow-ups: re-plan only what the form grew, at most twice (step 9).
    const added = [];
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
