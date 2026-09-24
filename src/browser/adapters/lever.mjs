// Lever hosted applications (jobs.lever.co/<site>/<id>/apply).
//
// The form is server-rendered, native HTML: text inputs, radio and checkbox groups and <select>s,
// each keyed by its `name` and not by an id. The shared ladder in `src/browser/controls.mjs`
// drives all of them, so this adapter only adds what the board does differently:
//
//   location    `input[name=location]` is an autocomplete over `jobs.lever.co/searchLocations`;
//               the suggestion must be picked for `selectedLocation` to be set, and a pick is made
//               only when exactly one suggestion states the saved city and every qualifier saved
//               with it — "London" alone matches London GB, London ON and London OH, and asks.
//   résumé      uploading it starts an in-browser parse that can pre-fill name/email/phone/company;
//               the upload waits for that parse to end so it cannot overwrite a later write.
//   surveys     the demographic survey shown depends on the country picked in the survey's own
//               location select, so it is read off the live page (`eeoControls`), not the schema.
//   submit      `#btn-submit` is `type="button"`, and clicking it runs an hCaptcha challenge.
//               The runner never solves a captcha, so `HUMAN_SUBMIT` holds every Lever
//               application at `ready_to_submit` for the user to click.
//
// Selectors verified against spotify/2193db3f and palantir/ac978161 on 2026-09-24.

import { norm, normLabel, waitUntil } from "../readback.mjs";
import { captureFailure, tracer } from "../trace.mjs";
import * as generic from "./generic.mjs";
import { samePlace } from "../../plan/execute.mjs";

export const id = "lever";

/** Why this board is never auto-submitted; read by `maybeSubmit` in scripts/apply.mjs. */
export const HUMAN_SUBMIT = "Lever runs an hCaptcha challenge on Submit, which the runner never solves — review the form, click Submit and complete the challenge yourself";

/**
 * Routed here so the location field gets the strict suggestion pick whichever of the two its
 * input is detected as, and so a survey control the page is not showing is deferred; every other
 * field is passed straight to generic.
 */
export const HANDLES = new Set(["text", "location", "radio", "checkbox_group"]);

const LOCATION_QID = "location";
const LOCATION_BOX = '[data-qa="structured-contact-location-question"]';
const SUGGESTION = ".dropdown-location";
const SURVEY_QID_RE = /^surveysResponses\[/;
/** The survey's own location select: the page reveals the matching survey once it is answered. */
const SURVEY_GATE = "candidate_location";

export const selectorFor = (question) => question?.selector || (question?.qid ? `[name="${question.qid}"]` : "");

export async function setField(page, question, value, opts = {}) {
  if (question?.qid === LOCATION_QID) return setLocation(page, question, value, opts);
  if (SURVEY_QID_RE.test(question?.qid ?? "")) {
    const selector = opts.selector ?? selectorFor(question);
    const shown = await page.locator(selector).first().isVisible().catch(() => false);
    // A survey stored from an earlier run is only on screen once its country is picked. Until
    // then it has not mounted: deferred like any conditional control, never a refused write.
    if (!shown) {
      question.mounts_after = question.mounts_after ?? SURVEY_GATE;
      return { ok: false, observed: "", attempts: 0, selector, reason: "control_not_found" };
    }
  }
  return generic.setField(page, question, value, opts);
}

// ─── location ─────────────────────────────────────────────────────────────────────────────────

const parts = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\./g, "")
    .split(",")
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

/**
 * The one suggestion that states the saved location, or why there is none. Pure.
 * A suggestion qualifies when its first segment is the saved city and every further segment the
 * user saved (a state, a country) appears among its segments; more than one qualifying suggestion
 * is ambiguous and never resolved by position.
 *
 * `index` is where that suggestion sits in the list as read, because the click has to be by index:
 * Playwright's string `hasText` is a *substring* match, and "San Francisco, CA, USA" is a substring
 * of nothing while "South San Francisco, CA, USA" contains it — filtering by text and taking
 * `.first()` is the positional read this function exists to refuse.
 * @returns {{pick:string|null, index:number, reason?:string}}
 */
export function pickSuggestion(suggestions, want) {
  const wanted = parts(want);
  if (!wanted.length) return { pick: null, index: -1, reason: "no location value to type" };
  const unique = [...new Set(suggestions.map((s) => norm(s)).filter(Boolean))];
  const exact = unique.filter((s) => normLabel(s) === normLabel(want));
  const match = exact.length === 1 ? { label: exact[0] } : samePlace(unique, want);
  if (match) return { pick: match.label, index: suggestions.findIndex((s) => norm(s) === match.label) };
  const hits = unique.filter((s) => parts(s)[0] === wanted[0]);
  return {
    pick: null,
    index: -1,
    reason: hits.length ? `ambiguous_location: ${hits.length} suggestions match "${norm(want)}"` : `no suggestion matches "${norm(want)}"`,
  };
}

async function setLocation(page, question, value, opts) {
  const log = tracer(opts.trace);
  const selector = opts.selector ?? selectorFor(question);
  const want = norm(value);
  const input = page.locator(selector).first();
  const box = page.locator(LOCATION_BOX);
  const queries = [...new Set([want, parts(want)[0] ?? ""].filter(Boolean))];

  let picked = null;
  let reason = null;
  let attempts = 0;
  try {
    for (const query of queries) {
      attempts += 1;
      await input.fill("");
      await input.pressSequentially(query, { delay: 80 });
      const shown = await waitUntil({
        read: () => box.locator(SUGGESTION).allTextContents().catch(() => []),
        ok: (rows) => rows.length > 0,
        timeout: 8000,
      });
      const choice = pickSuggestion(shown ?? [], want);
      if (choice.pick && choice.index >= 0) {
        await box.locator(SUGGESTION).nth(choice.index).click();
        picked = choice.pick;
        reason = null;
        break;
      }
      reason = choice.reason;
    }
  } catch (err) {
    reason = `error: ${String(err.message).split("\n")[0].slice(0, 140)}`;
  }

  let observed = norm(await input.inputValue().catch(() => ""));
  const ok = Boolean(picked) && normLabel(observed) === normLabel(picked);
  // An unpicked, half-typed location is not an answer: leave the field empty so the page agrees
  // with the row, which is now the user's to answer.
  if (!ok) {
    await input.fill("").catch(() => {});
    observed = "";
  }
  const result = {
    ok,
    observed,
    attempts: Math.max(attempts, 1),
    selector,
    strategy: "lever location suggestion",
    ...(ok ? {} : { reason: reason ?? "suggestion_not_committed" }),
  };
  if (!ok) result.shot = await captureFailure(page, opts.trace, question);
  await log(generic.traceRow({ op: "set", question: { ...question, control: "location" }, value, result, detected: null }));
  return result;
}

// ─── résumé ───────────────────────────────────────────────────────────────────────────────────

export async function uploadFile(page, question, filePath, opts = {}) {
  const result = await generic.uploadFile(page, question, filePath, opts);
  if (result.ok && result.reason !== "already_attached") {
    const working = page.locator(".resume-upload-working").first();
    await working.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    await working.waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
  }
  return result;
}

// ─── page state ───────────────────────────────────────────────────────────────────────────────

export async function waitForForm(page, { timeout = 30000 } = {}) {
  await page.locator("form#application-form input:not([type=hidden])").first().waitFor({ state: "attached", timeout });
  return true;
}

/**
 * Required controls and whether each is filled, keyed by `name` — the key the FormPlan uses —
 * because Lever gives most inputs no id, and `#location-input` is the one id that would not
 * match its row.
 */
export async function snapshotRequired(page) {
  return page.evaluate(() => {
    const norm = (s) => String(s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
    const rows = [];
    const seen = new Set();
    for (const el of document.querySelectorAll("form#application-form input, form#application-form textarea, form#application-form select")) {
      if (el.type === "hidden") continue;
      if (!(el.required || el.getAttribute("aria-required") === "true")) continue;
      const key = el.name || el.id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const grouped = el.type === "checkbox" || el.type === "radio";
      const group = el.name ? [...document.querySelectorAll(`[name="${CSS.escape(el.name)}"]`)] : [el];
      const filled = grouped ? group.some((b) => b.checked) : el.type === "file" ? (el.files?.length ?? 0) > 0 : norm(el.value) !== "";
      const selector = el.name ? `${grouped ? "input" : ""}[name="${el.name}"]` : `#${el.id}`;
      const label = norm(el.closest(".application-question")?.querySelector(".application-label")?.textContent ?? el.getAttribute("aria-label") ?? "").replace(/\s*[✱*]\s*$/, "");
      rows.push({ qid: key, selector, label, filled });
    }
    return rows;
  });
}

/**
 * The demographic survey the page is showing now, one row per question, in DOM order. Opens
 * nothing and writes nothing; `fillLiveSensitive` (src/plan/execute.mjs) decides every answer
 * through the resolver and `p.eeo`.
 * @returns {Promise<Array<{qid:string, label:string, section:string, selector:string,
 *   multiple:boolean, control:string, options:Array<{label:string,value:string}>, value:string}>>}
 */
export async function eeoControls(page) {
  return page.evaluate(() => {
    const norm = (s) => String(s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
    const shown = (el) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const groups = new Map();
    for (const el of document.querySelectorAll('input[name^="surveysResponses["][name*="[responses]"]')) {
      if (!["radio", "checkbox"].includes(el.type) || !shown(el)) continue;
      const question = el.closest(".application-question");
      if (!question) continue;
      let group = groups.get(el.name);
      if (!group) {
        group = { el, question, multiple: el.type === "checkbox", options: [], checked: [] };
        groups.set(el.name, group);
      }
      const label = norm(el.closest("label")?.textContent ?? el.value);
      group.options.push({ label, value: el.value });
      if (el.checked) group.checked.push(label);
    }
    return [...groups].map(([name, g]) => ({
      qid: name,
      label: norm(g.question.querySelector(".application-label")?.textContent ?? "").replace(/\s*[✱*:]\s*$/, ""),
      section: norm(g.el.closest(".section")?.querySelector("h4")?.textContent ?? "") || "Demographic Survey",
      selector: `input[name="${name}"]`,
      multiple: g.multiple,
      control: g.multiple ? "checkbox_group" : "radio",
      options: g.options,
      value: g.checked.join(" | "),
    }));
  });
}

// ─── submit ───────────────────────────────────────────────────────────────────────────────────
//
// The runner does not click on this board (`HUMAN_SUBMIT`); these rules serve
// `apply.mjs --detect-submit` and the confirmation read after the user has submitted by hand.
// UNVERIFIED: no Lever submission has been observed. The rules below assume the `/thanks`
// receipt URL and wording Lever boards are known to use; confirm them on the first real submit.

export const CONFIRMATION = {
  strategy: "url /thanks · thank-you text",
  url: /\/thanks(?:[/?#]|$)/i,
  text: /application submitted|thank you for applying|thanks for applying/i,
  selectors: [],
  formGone: false,
};

const SUBMIT_SELECTORS = ["#btn-submit", 'form#application-form [data-qa="btn-submit"]'];
const SUBMIT_TEXT = /submit application/i;

export async function findSubmit(page) {
  return generic.findSubmit(page, { selectors: SUBMIT_SELECTORS, text: SUBMIT_TEXT, scopes: ["form#application-form", "form"] });
}

export async function confirmSubmitted(page, opts = {}) {
  const signals = opts.signals ?? (await generic.readSignals(page, { selectors: CONFIRMATION.selectors }));
  return { ...generic.matchConfirmation(signals, CONFIRMATION), signals };
}
