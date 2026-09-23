// Ashby hosted applications (jobs.ashbyhq.com/<org>/<uuid>/application) — PLAN §2.2 step 8.
//
// Every control sits in `div.ashby-application-form-field-entry[data-field-path="<path>"]`, and
// the path is also the input's `id` (`_systemfield_name`, `_systemfield_resume`, or a question
// UUID — which is why ids must be escaped, `#79112628-…` is not a valid CSS selector).
//
// Controls on the live form: `input.ashby-application-form-input` text fields, Boolean fields
// rendered as a Yes/No button pair (`button[data-option]`, committed via `aria-pressed="true"`,
// with a hidden checkbox that is only checked for "yes"), radio groups whose labels are
// `label[for$="-radio-N"]`, and `input#_systemfield_resume` for the résumé, which keeps the input
// in place and shows a chip named after the file.

import path from "node:path";

import {
  asYesNo,
  attemptSet,
  byId,
  cadenceMs,
  guardNoSubmit,
  norm,
  normLabel,
  pace,
  pickOption,
  sleep,
  valueOf,
  waitUntil,
} from "../readback.mjs";
import { detectControl, setControl } from "../controls.mjs";
import { captureFailure, tracer } from "../trace.mjs";
import * as generic from "./generic.mjs";

export const id = "ashby";

/**
 * The controls this form renders and tunes itself — the Yes/No button pair and the radio groups
 * whose labels are `-radio-N` suffixed are Ashby inventions with no generic equivalent. `unknown`
 * stays here because a button pair carries no `<input>` for detection to find, and the Yes/No
 * probe below is what recognises it. Selects, geocoders, dates and numbers belong to the shared
 * ladder in `adapters/generic.mjs`.
 */
export const HANDLES = new Set(["text", "textarea", "radio", "checkbox", "file", "unknown"]);

// The field container. `data-field-path` is the handle, **not** the class: the plain text rows
// carry `.ashby-application-form-field-entry`, but the choice widgets do not — a 24-option
// ValueSelect and a one-option MultiValueSelect both render in a bare `div[data-field-path]`
// (read off the live 1Password form on 2026-09-23). Keying on the class is what made that
// ValueSelect resolve to nothing and score `control_not_on_the_page`.
const ENTRY = "div[data-field-path]";
const entryFor = (path) => `div[data-field-path="${String(path).replace(/(["\\])/g, "\\$1")}"]`;

const fieldPath = (question) => String(question?.path ?? question?.qid ?? "");
export const selectorFor = (question) => question?.selector || byId(fieldPath(question));

/**
 * The element detection should look at. Ashby's `data-field-path` doubles as the input's `id` for
 * text fields — but a radio group, a Yes/No button pair and a MultiValueSelect carry that path
 * only on the field entry, and their inputs are `<path>-labeled-radio-N`. Asking for `#<path>`
 * there finds nothing at all, which reads like a missing control rather than a different DOM.
 */
export async function resolveSelector(page, question) {
  const own = selectorFor(question);
  if (own && (await page.locator(own).count().catch(() => 0))) return own;
  const entry = entryLocator(page, question);
  if (entry && (await entry.count().catch(() => 0))) return entryFor(fieldPath(question));
  return own;
}

function entryLocator(page, question) {
  const p = fieldPath(question);
  return p ? page.locator(entryFor(p)).first() : null;
}

/** The field's container: by data-field-path, else the input's own entry ancestor. */
async function scopeFor(page, question, selector) {
  const entry = entryLocator(page, question);
  if (entry && (await entry.count())) return entry;
  const input = page.locator(selector).first();
  const ancestor = input.locator("xpath=ancestor::*[@data-field-path][1]");
  if (await ancestor.count()) return ancestor.first();
  return input;
}

function wantedLabel(question, value) {
  const raw = String(value ?? "");
  const options = Array.isArray(question?.options) ? question.options : [];
  const hit = options.find((o) => o && norm(o.value) !== "" && norm(o.value) === norm(raw));
  return hit ? String(hit.label ?? raw) : raw;
}

const matchesWanted = (observed, want) => Boolean(observed) && pickOption([observed], want) !== null;

// --------------------------------------------------------------------------- text / textarea

async function setText(page, question, value, selector) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: 10000 });
  await pace(page, loc);
  const want = String(value ?? "");
  return attemptSet({
    set: async () => {
      await loc.click({ timeout: 5000 }).catch(() => {});
      await loc.fill(want);
      await loc.blur().catch(() => {});
    },
    read: () => valueOf(loc),
    ok: (observed) => norm(observed) === norm(want),
  });
}

// ------------------------------------------------------------------------- Yes/No button pair

async function setYesNo(page, question, value, scope) {
  const yn = asYesNo(wantedLabel(question, value));
  if (!yn) {
    // No default and no first-option fallback: an unmapped value leaves the field untouched.
    return { ok: false, observed: await pressedOption(scope), attempts: 1, reason: `not_boolean: ${norm(value).slice(0, 40)}` };
  }
  const button = scope.locator(`button[data-option="${yn}"]`).first();
  if (!(await button.count())) return { ok: false, observed: "", attempts: 1, reason: "yesno_buttons_not_found" };
  await pace(page, button);
  return attemptSet({
    set: async () => {
      await guardNoSubmit(button);
      await button.click({ timeout: 5000 });
    },
    read: () => pressedOption(scope),
    ok: (observed) => observed === yn,
  });
}

async function pressedOption(scope) {
  const pressed = scope.locator('button[data-option][aria-pressed="true"]').first();
  if (!(await pressed.count())) return "";
  return norm((await pressed.getAttribute("data-option")) ?? "");
}

// ---------------------------------------------------------------------------------- radios

async function setRadio(page, question, value, scope) {
  // Ashby regenerates the form id (and therefore the radio `name`) on every render; the stable
  // handles are the field entry's data-field-path and the `-labeled-radio-N` label suffix.
  let labels = scope.locator('label[for*="-radio-"]');
  let meta = await labels.evaluateAll((els) =>
    els.map((el) => ({ for: el.getAttribute("for") || "", label: (el.textContent || "").trim() })),
  );
  if (!meta.length) {
    labels = scope.locator("label[for]");
    meta = await labels.evaluateAll((els) =>
      els
        .filter((el) => {
          const target = document.getElementById(el.getAttribute("for") || "");
          return target && target.type === "radio";
        })
        .map((el) => ({ for: el.getAttribute("for") || "", label: (el.textContent || "").trim() })),
    );
  }
  if (!meta.length) return { ok: false, observed: "", attempts: 1, reason: "radio_labels_not_found" };

  const want = wantedLabel(question, value);
  const pick = pickOption(meta.map((m) => m.label), want);
  if (!pick) {
    return {
      ok: false,
      observed: meta.map((m) => m.label).join(" | ").slice(0, 140),
      attempts: 1,
      reason: "no_matching_option",
    };
  }
  const chosen = meta[pick.index];
  // Address the label by its `for`, not by position: the fallback list above is filtered.
  const label = page.locator(`label[for="${chosen.for.replace(/(["\\])/g, "\\$1")}"]`).first();
  const radio = page.locator(byId(chosen.for)).first();
  await pace(page, label);
  return attemptSet({
    set: async () => {
      await guardNoSubmit(label);
      await label.click({ timeout: 5000 });
    },
    read: async () => ((await radio.isChecked().catch(() => false)) ? chosen.label : ""),
    ok: (observed) => matchesWanted(observed, want),
  });
}

// -------------------------------------------------------------------------------- checkbox
//
// One checkbox is the ladder's (`setSingleCheckbox` in src/browser/controls.mjs): it reads a
// Boolean yes/no *and* the one-option MultiValueSelect Ashby renders with the same DOM, whose
// answer is the option's own sentence. This file kept a second, yes/no-only copy, which is what
// scored 1Password's background-check acknowledgement as `set_failed:not_boolean`.
//
// An Ashby MultiValueSelect with several values is n boxes in one field entry and is the
// ladder's too — but it took a second fix to actually get there. Ashby names each box after its
// *own* option label (`name="Veteran"`, `name="United Kingdom"`), so counting the members by
// shared `name` answered 1 for a seven-box question, `detectControl` said `checkbox`, and four
// live groups across two postings met the Boolean rung and lost every answer
// (docs/research/13-eval-judge-round2.md §3 N2). `readShape` now counts the field's own boxes
// as well, `classifyShape` also accepts a published option list as the witness, and
// `setControl` re-asks both questions before it reaches for `setSingleCheckbox`. A group
// detected as `checkbox_group` is not in `HANDLES`, so it routes to `generic` like any other
// control this adapter does not tune.

// ------------------------------------------------------- combobox / dropdown / geocoder
//
// Ashby's dropdowns and its location autocomplete go through the shared ladder
// (src/browser/controls.mjs): same `aria-controls` listbox, same never-index-0 matching, same
// blur-to-dismiss rule, plus the filter-string rungs and the async polling a geocoder needs.

// ------------------------------------------------------------------------------------ public

export async function setField(page, question, value, opts = {}) {
  const { trace, chooseOption } = opts;
  const log = tracer(trace);
  const selector = opts.selector ?? (await resolveSelector(page, question));
  let result;
  let detected = opts.detected ?? null;
  try {
    // The DOM decides what this is; the FormPlan's `control` was a guess made offline.
    detected = detected ?? (await detectControl(page, selector, { question }));
    if (detected.control === "file") throw new Error("file controls go through uploadFile()");
    if (!HANDLES.has(detected.control) || !detected.evidence) {
      return generic.setField(page, question, value, { ...opts, selector, detected });
    }
    const scope = await scopeFor(page, question, selector);
    // A Boolean is a Yes/No button pair whatever anything else calls it (`radio`, `checkbox`, or
    // a selector pointing straight at `button[data-option]`); everything else goes by control.
    const hasYesNo = Boolean(await scope.locator("button[data-option]").count());
    if (hasYesNo && !["text", "textarea", "date"].includes(detected.control)) {
      result = await setYesNo(page, question, value, scope);
    } else if (detected.control === "radio") {
      // Ashby's `-radio-N` label trick only exists where Ashby rendered real radio inputs; a
      // segmented/button group on the same form is the ladder's, not ours.
      if (!(await scope.locator('input[type="radio"]').count())) {
        return generic.setField(page, question, value, { ...opts, selector, detected });
      }
      result = await setRadio(page, question, value, scope);
    } else if (detected.control === "checkbox") {
      result = await setControl(page, question, value, { selector, detected, chooseOption });
    } else if (detected.control === "unknown") {
      return generic.setField(page, question, value, { ...opts, selector, detected });
    } else {
      result = await setText(page, question, value, selector);
    }
  } catch (err) {
    result = { ok: false, observed: "", attempts: 1, reason: `error: ${String(err.message).split("\n")[0].slice(0, 140)}` };
  }
  result.selector = selector;
  if (!result.ok) result.shot = await captureFailure(page, trace, question);
  await log(generic.traceRow({ op: "set", question, value, result, detected }));
  return result;
}

export async function uploadFile(page, question, filePath, { trace } = {}) {
  const log = tracer(trace);
  const q = { ...question, qid: question?.qid ?? "_systemfield_resume" };
  const selector = selectorFor(q);
  const base = path.basename(filePath);
  const input = page.locator(selector).first();
  const scope = await scopeFor(page, q, selector);

  const shown = async () => {
    const chip = scope.locator('[class*="ashby-application-form-input-file-item-name"], [class*="file-item-name"]');
    if (await chip.count()) {
      const text = norm(await chip.first().textContent().catch(() => ""));
      if (text) return text;
    }
    const held = norm(await input.evaluate((el) => el.files?.[0]?.name ?? "").catch(() => ""));
    if (held) return held;
    const text = norm(await scope.textContent().catch(() => ""));
    return text.includes(base) ? base : "";
  };

  const anchor = (await scope.locator('[class*="ashby-application-form-input-file"]').count())
    ? scope.locator('[class*="ashby-application-form-input-file"]').first()
    : scope;
  await pace(page, anchor);

  const matched = (observed) => normLabel(observed) === normLabel(base);
  let observed = await shown();
  let attempts = 0;
  let reason = null;
  while (attempts < 2 && !matched(observed)) {
    attempts += 1;
    try {
      await input.setInputFiles(filePath, { timeout: 15000 });
      // Ashby renders the chip a beat after the file is accepted.
      observed = await waitUntil({ read: shown, ok: matched, timeout: 15000 });
      reason = null;
    } catch (err) {
      reason = `error: ${String(err.message).split("\n")[0].slice(0, 120)}`;
    }
    if (!matched(observed) && attempts < 2) await sleep(cadenceMs());
  }
  const result = {
    ok: matched(observed),
    observed,
    attempts: Math.max(attempts, 1),
    ...(reason && !matched(observed) ? { reason } : {}),
  };
  result.selector = selector;
  if (!result.ok) result.shot = await captureFailure(page, trace, q);
  await log(generic.traceRow({ op: "upload", question: { ...q, control: "file" }, value: base, result, detected: null }));
  return result;
}

/**
 * jobs.ashbyhq.com renders the form from a client-side fetch, well after `load`. Wait for the
 * first field entry before touching anything, or the first set races the render.
 */
export async function waitForForm(page, { timeout = 30000 } = {}) {
  await page.locator(ENTRY).first().waitFor({ state: "visible", timeout });
  return true;
}

/** Required controls and whether they are filled — PLAN §2.2 step 11's re-snapshot. */
export async function snapshotRequired(page) {
  return page.evaluate((entrySelector) => {
    const norm = (s) => String(s ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    const rows = [];
    for (const entry of document.querySelectorAll(entrySelector)) {
      const heading = entry.querySelector("label");
      const required =
        (heading && /_required_/.test(String(heading.className || ""))) ||
        Boolean(entry.querySelector("input[required], textarea[required], select[required]"));
      if (!required) continue;
      const fieldPath = entry.getAttribute("data-field-path") || null;
      const file = entry.querySelector('input[type="file"]');
      const radio = entry.querySelector('input[type="radio"]');
      const checkbox = entry.querySelector('input[type="checkbox"]');
      const yesno = entry.querySelector("button[data-option]");
      const text = entry.querySelector("input:not([type=file]):not([type=radio]):not([type=checkbox]), textarea");
      let filled = false;
      if (file) {
        filled =
          (file.files?.length ?? 0) > 0 ||
          Boolean(entry.querySelector('[class*="file-item-name"]'));
      } else if (yesno) {
        filled = Boolean(entry.querySelector('button[data-option][aria-pressed="true"]'));
      } else if (radio) {
        filled = Boolean(entry.querySelector('input[type="radio"]:checked'));
      } else if (checkbox) {
        filled = Boolean(entry.querySelector('input[type="checkbox"]:checked'));
      } else if (text) {
        filled = norm(text.value) !== "";
      }
      rows.push({
        qid: fieldPath,
        selector: fieldPath ? `[data-field-path="${fieldPath}"]` : entrySelector,
        label: norm(heading?.textContent ?? "").replace(/\s*\*$/, ""),
        filled,
      });
    }
    return rows;
  }, ENTRY);
}

// ─── EEO / demographics ───────────────────────────────────────────────────────────────────────
//
// Ashby renders its demographic survey from `surveyForms`, a second form beside `applicationForm`
// that `src/schema/ashby.mjs` now requests, so unlike Greenhouse the block *is* in the FormPlan.
// This reader exists for the other half of the problem: the survey mounts from its own fetch, so
// a control can still be missing from the DOM at the moment the fill loop reaches it, and the row
// becomes an `ask` saying "control_not_found" while the page shows an empty radio group. The
// step-8½ pass (`fillLiveSensitive`, src/plan/execute.mjs) re-reads the page after the first fill
// round and drives whatever appeared, using the plan's own `p.eeo`-sourced answer.
//
// Read off the live fireworks/fc3845e6 form on 2026-09-23: the survey's fields are ordinary
// `div[data-field-path="_systemfield_eeoc_<name>"]` entries holding
// `input[type=radio].ashby-application-form-input-radio-group-option-radio`. Nothing here opens a
// menu, writes, or decides an answer — it reports what is on the page.

/** Field paths Ashby gives its own self-identification questions. */
const EEO_PATH_RE = /(^|_)eeoc?($|_)|_systemfield_(gender|race|ethnicity|veteran|disability)/i;
/** A survey form's own wording, for an org that asks demographics through custom questions. */
const EEO_LABEL_RE = /\b(gender|race|ethnicit|hispanic|latino|veteran|disabilit|self[- ]identif|demographic|transgender|sexual orientation|pronouns?)\b/i;

/**
 * The demographic controls as the page renders them, in DOM order.
 * @returns {Promise<Array<{qid:string, label:string, section:string, selector:string,
 *                          multiple:boolean, control:string, value:string}>>}
 */
export async function eeoControls(page) {
  return page.evaluate(
    ({ entrySelector, pathSrc, labelSrc }) => {
      const pathRe = new RegExp(pathSrc, "i");
      const labelRe = new RegExp(labelSrc, "i");
      const norm = (s) => String(s ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
      const rows = [];
      for (const entry of document.querySelectorAll(entrySelector)) {
        const fieldPath = entry.getAttribute("data-field-path") || "";
        const label = norm(entry.querySelector("label")?.textContent ?? "").replace(/\s*\*$/, "");
        if (!pathRe.test(fieldPath) && !labelRe.test(label)) continue;
        const radios = entry.querySelectorAll('input[type="radio"]');
        const boxes = entry.querySelectorAll('input[type="checkbox"]');
        const select = entry.querySelector("select");
        const text = entry.querySelector("input:not([type=file]):not([type=radio]):not([type=checkbox]), textarea");
        let control = "unknown";
        let value = "";
        if (radios.length) {
          control = "radio";
          const on = entry.querySelector('input[type="radio"]:checked');
          value = on ? norm(entry.querySelector(`label[for="${CSS.escape(on.id)}"]`)?.textContent ?? "") : "";
        } else if (boxes.length) {
          control = boxes.length > 1 ? "checkbox_group" : "checkbox";
          value = [...boxes]
            .filter((b) => b.checked)
            .map((b) => norm(entry.querySelector(`label[for="${CSS.escape(b.id)}"]`)?.textContent ?? ""))
            .join(" | ");
        } else if (select) {
          control = "native_select";
          value = norm(select.selectedOptions?.[0]?.textContent ?? "");
        } else if (text) {
          control = text.tagName === "TEXTAREA" ? "textarea" : "text";
          value = norm(text.value);
        } else {
          continue; // a heading or a description block, not a control
        }
        rows.push({
          qid: fieldPath || label,
          label,
          section: "Demographic Survey",
          selector: fieldPath ? `[data-field-path="${fieldPath}"]` : "",
          multiple: boxes.length > 1,
          control,
          value,
        });
      }
      return rows.filter((r) => r.selector);
    },
    { entrySelector: ENTRY, pathSrc: EEO_PATH_RE.source, labelSrc: EEO_LABEL_RE.source },
  );
}

// ─── submit ───────────────────────────────────────────────────────────────────────────────────
//
// Ashby's Submit is a `button[type=submit]` reading "Submit Application" inside the application
// form; the org can restyle it, so the class is tried first and the *text* is the rule — with no
// matching text this adapter returns null rather than clicking whatever submit control it found
// (a posting page carries a job-alert form of its own, and "click the last submit button" would
// subscribe the user to a newsletter instead of applying).
//
// A confirmed application replaces the form in place: the field entries disappear and a success
// banner/toast says so, with no navigation, which is why `formGone` is on.

export const CONFIRMATION = {
  strategy: "form replaced + success text/toast",
  text: /application submitted|thanks for applying|thank you for applying|we'?(?:ve| have) received your application|your application (?:has been|was) (?:submitted|received)/i,
  selectors: ["[class*='ashby-application-form-success']", "[class*='ApplicationFormSuccess']"],
  toast: ["[class*='ashby-toast']", "[role='status']", "[class*='Toast']", "[class*='success' i]"],
  formGone: true,
};

/** Unambiguous: Ashby's own class for the application form's submit button, whatever it reads. */
const SUBMIT_SELECTORS = ["button.ashby-application-form-submit-button", "[class*='ashby-application-form-submit'] button[type=submit]"];
const SUBMIT_TEXT = /submit application/i;
/** Containers the fallback scan searches; the one holding the most fields wins. */
const FORM_SCOPES = ["form", "[class*='ashby-application-form']"];

/**
 * The application form's Submit control, or null. Outside Ashby's own class the *text* is the
 * rule (`textRequired`): a button that does not say "Submit application" is never handed back,
 * because the posting page carries a job-alert form whose submit control would otherwise win.
 */
export async function findSubmit(page) {
  return generic.findSubmit(page, {
    selectors: SUBMIT_SELECTORS,
    text: SUBMIT_TEXT,
    textRequired: true,
    scopes: FORM_SCOPES,
  });
}

export async function confirmSubmitted(page, opts = {}) {
  const signals = opts.signals ?? (await generic.readSignals(page, { selectors: CONFIRMATION.selectors, toast: CONFIRMATION.toast }));
  const verdict = generic.matchConfirmation(signals, CONFIRMATION);
  if (verdict.detected) return { ...verdict, signals };
  // The second half of Ashby's own contract: the form is gone and a toast says it worked. A toast
  // alone is not a receipt (Ashby toasts autosave and upload errors the same way).
  const gone = signals.fields === 0 && signals.submits === 0;
  if (gone && signals.toast && CONFIRMATION.text.test(signals.toast)) {
    return { detected: true, strategy: "form gone + success toast", url: signals.url, text: signals.toast, signals };
  }
  return { ...verdict, signals };
}
