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

// ─── submit ───────────────────────────────────────────────────────────────────────────────────
//
// Finding the button and recognising the confirmation are the only two DOM questions
// `submitApplication` (src/plan/execute.mjs) asks an adapter. The click, the 45 s wait and the
// failure rules are the executor's, so every board fails the same way — and the two tuned
// adapters below are a selector list and a regex each, not a second implementation.
//
// The runner clicks Submit only when the user's `p.auto_submit` says so; nothing here decides
// that, and nothing here writes to the page (`findSubmit` is pure detection, which is what
// `apply.mjs --dry-run --detect-submit` prints against a real posting without clicking).

/**
 * The generic confirmation: the form is gone *and* the page says thank you. Both halves are
 * required — a thank-you banner rendered above a still-present form is a marketing block, not a
 * receipt. `url`/`selectors` are the tuned adapters' stronger signals; here there are none.
 */
export const CONFIRMATION = {
  strategy: "form gone + thank-you text",
  text: /thank you for applying|thanks for applying|application (?:has been )?(?:submitted|received)|received your application|submission (?:was )?successful/i,
  selectors: [],
  formGone: true,
};

/** Elements whose visible text is read as a banner; the executor decides what counts as failure. */
export const ALERT_SELECTORS = ['[role="alert"]', '[aria-live="assertive"]', '[aria-invalid="true"]', '[class*="error" i]', '[class*="danger" i]', '[class*="alert" i]'];

/** A reCAPTCHA/hCaptcha *challenge* (the popup), never the always-present invisible badge. */
export const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha/api2/bframe"]',
  'iframe[title*="recaptcha challenge" i]',
  'iframe[src*="hcaptcha"][title*="challenge" i]',
];

/**
 * The submit control, or null. Never clicks, never writes: a returned `selector` is a CSS path
 * the caller re-resolves, so the same function serves the dry `--detect-submit` check and the
 * real click.
 *
 * @param {object} page
 * @param {{selectors?:string[], text?:RegExp, textRequired?:boolean, scopes?:string[]}} [opts]
 *   `selectors` are tried in order first (an ATS's own id); `text` filters the fallback scan and,
 *   with `textRequired`, is the only thing that may be clicked.
 * @returns {Promise<{selector:string, text:string, strategy:string}|null>}
 */
export async function findSubmit(page, opts = {}) {
  const arg = {
    selectors: opts.selectors ?? [],
    text: opts.text ? opts.text.source : null,
    flags: opts.text ? opts.text.flags.replace(/[gy]/g, "") : "i",
    textRequired: opts.textRequired === true,
    scopes: opts.scopes ?? ["form"],
  };
  return page.evaluate(scanSubmit, arg).catch(() => null);
}

/** In-page: the submit control and a CSS path that re-resolves to exactly it. */
function scanSubmit({ selectors, text, flags, textRequired, scopes }) {
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const re = text ? new RegExp(text, flags) : null;
  const shown = (el) => {
    if (!el || el.disabled) return false;
    const box = el.getBoundingClientRect();
    const css = getComputedStyle(el);
    return box.width > 1 && box.height > 1 && css.visibility !== "hidden" && css.display !== "none";
  };
  const label = (el) => norm(el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || "");
  const cssPath = (el) => {
    const ident = (id) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(id);
    if (el.id && ident(el.id)) return `#${el.id}`;
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 8; node = node.parentElement) {
      if (node.id && ident(node.id)) {
        parts.unshift(`#${node.id}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const twins = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [];
      parts.unshift(twins.length > 1 ? `${tag}:nth-of-type(${twins.indexOf(node) + 1})` : tag);
    }
    return parts.join(" > ");
  };

  for (const selector of selectors) {
    let hit = null;
    try {
      hit = [...document.querySelectorAll(selector)].find(shown) ?? null;
    } catch {
      hit = null;
    }
    if (hit) return { selector: cssPath(hit), text: label(hit), strategy: `selector ${selector}` };
  }

  // The form the fields are in, not the newsletter box in the footer.
  let scope = document;
  let best = -1;
  for (const sel of scopes) {
    let nodes = [];
    try {
      nodes = [...document.querySelectorAll(sel)];
    } catch {
      nodes = [];
    }
    for (const node of nodes) {
      const fields = node.querySelectorAll("input:not([type=hidden]), textarea, select").length;
      if (fields > best) {
        best = fields;
        scope = node;
      }
    }
  }

  const candidates = (root) => [...root.querySelectorAll('button[type="submit"], input[type="submit"]')].filter(shown);
  let buttons = candidates(scope);
  let named = re ? buttons.filter((el) => re.test(label(el))) : [];

  // The winning scope can be the wrong box: Ashby renders no `<form>` at all and its
  // `ashby-application-form-*` classes sit on individual *field entries*, so "the node with the
  // most inputs" can be a radio group that contains no button. Widening to the whole document is
  // only safe where the text is the rule — with `textRequired` the only thing that can be picked
  // up is a button that says "Submit application", which no newsletter box does.
  if (textRequired && !named.length && scope !== document) {
    buttons = candidates(document);
    named = re ? buttons.filter((el) => re.test(label(el))) : [];
  }
  if (textRequired && !named.length) return null;

  const byText = named.length > 0;
  const pick = (byText ? named : buttons).at(-1) ?? null;
  if (!pick) return null;
  return {
    selector: cssPath(pick),
    text: label(pick),
    strategy: byText ? `text /${re.source}/` : "last submit control in the form",
  };
}

/**
 * One page read for every confirmation rule there is, so a poll costs one round trip:
 * the URL, the visible text, how much form is left, the visible banners, a captcha challenge,
 * and whether any of `selectors` is showing.
 */
export async function readSignals(page, { selectors = [], toast = [] } = {}) {
  const arg = { selectors, toast, alerts: ALERT_SELECTORS, captcha: CAPTCHA_SELECTORS };
  return page.evaluate(readPageSignals, arg).catch((err) => ({
    url: null,
    text: "",
    forms: null,
    fields: null,
    submits: null,
    hits: [],
    alerts: [],
    toast: null,
    captcha: false,
    unreadable: String(err?.message ?? err).split("\n")[0].slice(0, 120),
  }));
}

function readPageSignals({ selectors, toast, alerts, captcha }) {
  const norm = (s) => String(s ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const shown = (el) => {
    const box = el.getBoundingClientRect();
    const css = getComputedStyle(el);
    return box.width > 1 && box.height > 1 && css.visibility !== "hidden" && css.display !== "none" && Number(css.opacity || "1") > 0.05;
  };
  const all = (sel) => {
    try {
      return [...document.querySelectorAll(sel)];
    } catch {
      return [];
    }
  };
  const text = norm(document.body?.innerText ?? "").slice(0, 8000);
  const banners = [];
  for (const sel of alerts) {
    for (const el of all(sel)) {
      if (!shown(el)) continue;
      const line = norm(el.innerText || el.textContent).slice(0, 240);
      if (line) banners.push(line);
    }
  }
  let toastText = null;
  for (const sel of toast) {
    const el = all(sel).find(shown);
    if (el) {
      toastText = norm(el.innerText || el.textContent).slice(0, 240) || null;
      if (toastText) break;
    }
  }
  return {
    url: location.href,
    text,
    forms: all("form").filter(shown).length,
    fields: all("form input:not([type=hidden]), form textarea, form select, [data-field-path] input, [data-field-path] textarea").filter(shown).length,
    submits: all('button[type="submit"], input[type="submit"]').filter(shown).length,
    hits: selectors.filter((sel) => all(sel).some(shown)),
    alerts: [...new Set(banners)].slice(0, 5),
    toast: toastText,
    captcha: captcha.some((sel) => all(sel).some((el) => shown(el) && el.getBoundingClientRect().width > 40 && el.getBoundingClientRect().height > 40)),
  };
}

/** The sentence a confirmation regex matched, for the summary line and the trace. */
export function excerpt(text, re, width = 120) {
  const hit = re?.exec?.(String(text ?? ""));
  if (!hit) return null;
  const from = Math.max(0, hit.index - 20);
  return norm(String(text).slice(from, from + width));
}

/**
 * `signals` → a confirmation verdict against one adapter's `CONFIRMATION`. URL first (the only
 * signal a half-rendered page cannot fake), then the ATS's own confirmation node, then the text —
 * and for an adapter with `formGone`, the text only counts once the form is actually gone.
 */
export function matchConfirmation(signals, conf = CONFIRMATION) {
  if (conf.url && signals.url && conf.url.test(signals.url)) {
    return { detected: true, strategy: "url", url: signals.url, text: excerpt(signals.text, conf.text) };
  }
  if (signals.hits?.length) {
    return { detected: true, strategy: `selector ${signals.hits[0]}`, url: signals.url, text: excerpt(signals.text, conf.text) };
  }
  const said = conf.text?.test(signals.text ?? "");
  const gone = signals.fields === 0 || signals.submits === 0;
  if (said && (!conf.formGone || gone)) {
    return { detected: true, strategy: conf.formGone ? "form gone + text" : "text", url: signals.url, text: excerpt(signals.text, conf.text) };
  }
  return { detected: false, ...(said ? { reason: "thank-you text but the form is still on the page" } : {}) };
}

/**
 * Has this page become a confirmation? Polled by `submitApplication` until it says yes, the page
 * says it failed, or the 45 s budget runs out.
 */
export async function confirmSubmitted(page, opts = {}) {
  const signals = opts.signals ?? (await readSignals(page, { selectors: CONFIRMATION.selectors }));
  return { ...matchConfirmation(signals, CONFIRMATION), signals };
}
