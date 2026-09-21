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
  labelsOf,
  moveMouseTo,
  norm,
  normLabel,
  pace,
  pickOption,
  sleep,
  textOf,
  valueOf,
  waitUntil,
} from "../readback.mjs";
import { captureFailure, fieldEvent, tracer } from "../trace.mjs";

export const id = "ashby";

const OPTION_WAIT_MS = 3000;
const ENTRY = "div.ashby-application-form-field-entry";

const fieldPath = (question) => String(question?.path ?? question?.qid ?? "");
const fieldSelector = (question) => question?.selector || byId(fieldPath(question));

function entryLocator(page, question) {
  const p = fieldPath(question).replace(/(["\\])/g, "\\$1");
  return p ? page.locator(`${ENTRY}[data-field-path="${p}"]`).first() : null;
}

/** The field's container: by data-field-path, else the input's own entry ancestor. */
async function scopeFor(page, question, selector) {
  const entry = entryLocator(page, question);
  if (entry && (await entry.count())) return entry;
  const input = page.locator(selector).first();
  const ancestor = input.locator('xpath=ancestor::*[contains(@class,"ashby-application-form-field-entry")][1]');
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

/**
 * One checkbox is a Boolean; an Ashby MultiValueSelect is n checkboxes in the same field entry,
 * answered by label — checking `.first()` would be an option-0 guess.
 */
async function setCheckbox(page, question, value, scope, selector) {
  const inScope = scope.locator('input[type="checkbox"]');
  const boxes = (await inScope.count()) ? inScope : page.locator(selector);
  const count = await boxes.count();
  if (count === 0) return { ok: false, observed: "", attempts: 1, reason: "checkbox_not_found" };

  if (count > 1) {
    const meta = await labelsOf(boxes);
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
    const target = boxes.nth(pick.index);
    const chosen = meta[pick.index];
    const label = chosen.id ? page.locator(`label[for="${chosen.id}"]`).first() : target;
    const clickable = (await label.count()) ? label : target;
    await pace(page, clickable);
    return attemptSet({
      set: async () => {
        await guardNoSubmit(clickable);
        await clickable.click({ timeout: 5000 }).catch(async () => {
          await target.check({ timeout: 5000, force: true });
        });
      },
      read: async () => ((await target.isChecked().catch(() => false)) ? chosen.label : ""),
      ok: (observed) => matchesWanted(observed, want),
    });
  }

  const box = boxes.first();
  const yn = asYesNo(value);
  if (!yn) return { ok: false, observed: "", attempts: 1, reason: `not_boolean: ${norm(value).slice(0, 40)}` };
  await pace(page, box);
  return attemptSet({
    set: async () => {
      if (yn === "yes") await box.check({ timeout: 5000, force: true });
      else await box.uncheck({ timeout: 5000, force: true });
    },
    read: async () => ((await box.isChecked().catch(() => false)) ? "yes" : "no"),
    ok: (observed) => observed === yn,
  });
}

// ------------------------------------------------------------------- combobox / dropdown

async function setCombobox(page, question, value, scope, selector) {
  const input = (await scope.locator('input[role="combobox"], input[aria-autocomplete]').count())
    ? scope.locator('input[role="combobox"], input[aria-autocomplete]').first()
    : page.locator(selector).first();
  const want = wantedLabel(question, value);
  // Options first from the listbox this input owns (aria-controls, set while open), then inside
  // the field entry, then page-wide. Only real `[role=option]` nodes are ever clicked: a value
  // that renders no option must fail loudly rather than commit a guess on a live application.
  const optionsNow = async () => {
    const owned = (await input.getAttribute("aria-controls")) || (await input.getAttribute("aria-owns"));
    if (owned) {
      const byOwner = page.locator(`[id="${owned.replace(/(["\\])/g, "\\$1")}"] [role="option"]`);
      if (await byOwner.count()) return byOwner;
    }
    const inScope = scope.locator('[role="option"]');
    if (await inScope.count()) return inScope;
    return page.locator('[role="option"]');
  };
  // Neither Escape nor `fill("")`: on a react-select-style combobox both clear the committed
  // value, and a failed match must never destroy an existing answer. Blur closes the menu and
  // drops the typed filter.
  const dismiss = async () => {
    await input.blur().catch(() => {});
  };
  await pace(page, input);
  let reason = null;

  const result = await attemptSet({
    settleMs: 350,
    set: async () => {
      reason = null;
      await input.click({ timeout: 5000 });
      // The widget resets its own filter text on blur, so there is nothing to clear here.
      const key = norm(want).slice(0, 24);
      if (key) await input.pressSequentially(key, { delay: 35 });
      const probe = page.locator('[role="option"]');
      await probe.first().waitFor({ state: "visible", timeout: OPTION_WAIT_MS }).catch(() => {});
      const options = await optionsNow();
      const labels = (await options.allTextContents()).map(norm).filter(Boolean);
      if (!labels.length) {
        reason = "no_options_rendered";
        await dismiss();
        return;
      }
      const pick = pickOption(labels, want);
      if (!pick) {
        reason = `no_matching_option (${labels.length} shown)`;
        await dismiss();
        return;
      }
      const target = options.nth(pick.index);
      await guardNoSubmit(target);
      await moveMouseTo(page, target);
      await target.click({ timeout: 5000 });
    },
    read: async () => {
      const shown = await valueOf(input);
      return shown || (await textOf(scope.locator('[class*="selected"], [class*="chip"]')));
    },
    // Committed means: the input carries the chosen option's text *and* the listbox is closed.
    ok: async (observed) => {
      if (reason || !matchesWanted(observed, want)) return false;
      const expanded = await input.getAttribute("aria-expanded").catch(() => null);
      return expanded !== "true";
    },
    onFail: dismiss,
  });
  return reason && !result.ok ? { ...result, reason } : result;
}

// ------------------------------------------------------------------------------------ public

export async function setField(page, question, value, { trace } = {}) {
  const log = tracer(trace);
  const selector = fieldSelector(question);
  const control = question?.control ?? "text";
  let result;
  try {
    if (control === "file") throw new Error("file controls go through uploadFile()");
    const scope = await scopeFor(page, question, selector);
    // A Boolean is a Yes/No button pair whatever the FormPlan calls it (`radio`, `checkbox`, or
    // a selector pointing straight at `button[data-option]`); everything else goes by control.
    const hasYesNo = Boolean(await scope.locator("button[data-option]").count());
    if (hasYesNo && control !== "text" && control !== "textarea" && control !== "date") {
      result = await setYesNo(page, question, value, scope);
    } else if (control === "radio") {
      result = await setRadio(page, question, value, scope);
    } else if (control === "checkbox") {
      result = await setCheckbox(page, question, value, scope, selector);
    } else if (control === "react_select" || control === "native_select") {
      result = await setCombobox(page, question, value, scope, selector);
    } else {
      result = await setText(page, question, value, selector);
    }
  } catch (err) {
    result = { ok: false, observed: "", attempts: 1, reason: `error: ${String(err.message).split("\n")[0].slice(0, 140)}` };
  }
  result.selector = selector;
  if (!result.ok) result.shot = await captureFailure(page, trace, question);
  await log(fieldEvent({ op: "set", question, value, result }));
  return result;
}

export async function uploadFile(page, question, filePath, { trace } = {}) {
  const log = tracer(trace);
  const q = { ...question, qid: question?.qid ?? "_systemfield_resume" };
  const selector = fieldSelector(q);
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
  await log(fieldEvent({ op: "upload", question: q, value: base, result }));
  return result;
}

/**
 * jobs.ashbyhq.com renders the form from a client-side fetch, well after `load`. Wait for the
 * first field entry before touching anything, or the first set races the render.
 */
export async function waitForForm(page, { timeout = 30000 } = {}) {
  await page.locator(`${ENTRY}[data-field-path]`).first().waitFor({ state: "visible", timeout });
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
