// The ATS-agnostic adapter: `src/browser/controls.mjs` plus the trace/screenshot contract every
// adapter owes its caller. Two jobs, both of them fallbacks.
//
//  1. Controls the tuned adapters do not know. Greenhouse and Ashby each handle the handful of
//     widgets their own board renders; a date picker, a number field, a checkbox group or a
//     geocoder that turns up on a form neither adapter anticipated is routed here by
//     `adapters/index.mjs` rather than being forced down the text path, where it would silently
//     write a string a masked input ignores.
//  2. Pages with no ATS at all — `eval/fixtures/controls.html`, the control-coverage fixture
//     `scripts/controls-smoke.mjs` drives.
//
// It never invents a vocabulary and never picks position 0; every rule it follows is the ladder's.

import path from "node:path";

import { detectControl, resolveInput, containerFor, setControl } from "../controls.mjs";
import { cadenceMs, norm, normLabel, pace, sleep, waitUntil } from "../readback.mjs";
import { captureFailure, fieldEvent, tracer } from "../trace.mjs";

export const id = "generic";

/** Everything the ladder implements — i.e. every control kind there is. */
export const HANDLES = new Set([
  "text",
  "textarea",
  "native_select",
  "react_select",
  "combobox",
  "listbox",
  "radio",
  "checkbox",
  "checkbox_group",
  "tel",
  "file",
  "date",
  "number",
  "location",
  "unknown",
]);

export const selectorFor = (question) => question?.selector ?? (question?.qid ? `#${question.qid}` : "");

export async function setField(page, question, value, opts = {}) {
  const { trace, detected: given, chooseOption } = opts;
  const log = tracer(trace);
  const selector = opts.selector ?? selectorFor(question);
  let result;
  let detected = given ?? null;
  try {
    detected = detected ?? (await detectControl(page, selector, { question }));
    if (detected.control === "file") throw new Error("file controls go through uploadFile()");
    result = await setControl(page, question, value, { selector, detected, chooseOption });
  } catch (err) {
    result = { ok: false, observed: "", attempts: 1, reason: `error: ${String(err.message).split("\n")[0].slice(0, 140)}` };
  }
  result.selector = selector;
  if (!result.ok) result.shot = await captureFailure(page, trace, question);
  await log(traceRow({ op: "set", question, value, result, detected }));
  return result;
}

/**
 * The trace row plus the two facts detection adds: what the plan expected (`planned`, only when it
 * was wrong) and which rung committed the value (`strategy`). `control` always carries what the
 * DOM turned out to be, so a reader counting failures by control counts real widgets.
 */
export function traceRow({ op, question, value, result, detected }) {
  const control = detected?.control ?? question?.control ?? null;
  const planned = detected && !detected.agreed ? detected.planned : null;
  return {
    ...fieldEvent({ op, question: { ...question, control }, value, result }),
    ...(planned ? { planned } : {}),
    ...(result?.strategy ? { strategy: result.strategy } : {}),
    ...(result?.country ? { country: result.country } : {}),
  };
}

export async function uploadFile(page, question, filePath, opts = {}) {
  const { trace } = opts;
  const log = tracer(trace);
  const selector = opts.selector ?? selectorFor(question);
  const base = path.basename(filePath);
  const input = await resolveInput(page, selector);
  const container = await containerFor(page, input);

  const shown = async () => {
    const held = norm(await input.evaluate((el) => el.files?.[0]?.name ?? "").catch(() => ""));
    if (held) return held;
    const chip = container.locator('[class*="file-name"], [class*="filename"], [class*="file-item-name"], [data-file-name]');
    if (await chip.count().catch(() => 0)) return norm(await chip.first().textContent().catch(() => ""));
    return "";
  };
  const matched = (observed) => normLabel(observed) === normLabel(base);

  let observed = await shown();
  let attempts = 0;
  let reason = null;
  if (!matched(observed)) {
    await pace(page, container);
    while (attempts < 2 && !matched(observed)) {
      attempts += 1;
      try {
        await input.setInputFiles(filePath, { timeout: 15000 });
        observed = await waitUntil({ read: shown, ok: matched, timeout: 10000 });
        reason = null;
      } catch (err) {
        reason = `error: ${String(err.message).split("\n")[0].slice(0, 120)}`;
      }
      if (!matched(observed) && attempts < 2) await sleep(cadenceMs());
    }
  }
  const result = {
    ok: matched(observed),
    observed,
    attempts: Math.max(attempts, 1),
    selector,
    ...(reason && !matched(observed) ? { reason } : {}),
    ...(matched(observed) && attempts === 0 ? { reason: "already_attached" } : {}),
  };
  if (!result.ok) result.shot = await captureFailure(page, trace, question);
  await log(traceRow({ op: "upload", question: { ...question, control: "file" }, value: base, result, detected: null }));
  return result;
}

/** Required controls and whether they are filled — PLAN §2.2 step 11's re-snapshot, ATS-agnostic. */
export async function snapshotRequired(page) {
  return page.evaluate(() => {
    const norm = (s) => String(s ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    const esc = (v) => (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(v) ? `#${v}` : `[id="${v}"]`);
    const labelOf = (el) => {
      const tied = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const legend = el.closest("fieldset")?.querySelector("legend");
      const text = norm(tied?.textContent ?? el.getAttribute("aria-label") ?? legend?.textContent ?? "");
      return text.replace(/\s*\*$/, "");
    };
    const rows = [];
    const seen = new Set();
    for (const el of document.querySelectorAll("input, textarea, select")) {
      if (el.type === "hidden" || el.name === "g-recaptcha-response") continue;
      if (String(el.className || "").includes("requiredInput")) continue;
      if (!(el.required || el.getAttribute("aria-required") === "true")) continue;
      const grouped = el.type === "checkbox" || el.type === "radio";
      const key = grouped ? el.name || el.id : el.id || el.name;
      if (grouped) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      let filled;
      let selector = el.id ? esc(el.id) : el.name ? `[name="${el.name}"]` : el.tagName.toLowerCase();
      if (grouped) {
        const group = el.name ? [...document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)] : [el];
        filled = group.some((b) => b.checked);
        if (el.name) selector = `input[name="${el.name}"]`;
      } else if (el.type === "file") {
        filled = (el.files?.length ?? 0) > 0;
      } else {
        filled = norm(el.value) !== "";
      }
      rows.push({ qid: key || null, selector, label: labelOf(el), filled });
    }
    return rows;
  });
}

/** Nothing ATS-specific to wait for: the first control on the page is the form. */
export async function waitForForm(page, { timeout = 30000 } = {}) {
  await page.locator("input, textarea, select, [role=combobox]").first().waitFor({ state: "attached", timeout });
  return true;
}
