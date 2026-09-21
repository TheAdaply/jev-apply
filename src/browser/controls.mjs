// Live control detection and the strategy ladder every adapter climbs.
//
// A FormPlan's `control` is a guess made offline from the ATS schema (`src/schema/*.mjs`); the DOM
// is the only authority on what a field actually is. Greenhouse's own API calls its Pelias
// autocomplete `location` and the normalizer rewrites that to `react_select` — but a Pelias field
// is not a react-select: its options arrive from the network hundreds of milliseconds after the
// keystroke, so the react-select path reads an empty menu and the row becomes an `ask` (observed
// twice in the recorded runs, with two rendered options each time). `detectControl` looks at the
// element before anything is typed and says what it is; disagreements are logged, never silently
// trusted in either direction.
//
// Two rules hold on every rung of every ladder:
//   * never position 0 — an option is committed because its *label* matched, never because it was
//     first. A placeholder row ("Select…") is refused even when it does match.
//   * never clear a committed value to recover — a failed match dismisses with `blur`, which drops
//     the typed filter and restores whatever the field already held. Escape and `fill("")` both
//     erase the committed answer on react-select-style widgets.
//
// The Jev rung (`chooseOption`) is injected by the caller, not imported: the browser layer must
// stay runnable offline, the confidence gate belongs to `src/jev/gates.mjs`, and the per-posting
// request budget belongs to `src/plan/execute.mjs`. It is deliberately **not** offered for
// `location`: an async geographic picker returns entries that all contain the typed text, so a
// model is asked to choose between real places the user never named (see `resolveVocabulary` in
// execute.mjs for the measurement). A location with no unambiguous hit is an `ask`.

import {
  asYesNo,
  attemptSet,
  cadenceMs,
  digits,
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
} from "./readback.mjs";

/** Every kind `detectControl` can return. `unknown` is a real answer: it becomes an `ask`. */
export const CONTROL_KINDS = Object.freeze([
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

const OPTION_WAIT_MS = 3000;
/** Pelias and Ashby's geocoder answer over the network; 4 s is the observed worst case. */
const ASYNC_WAIT_MS = 4000;

const LOCATION_RE = /(^|[^a-z])(location|locality|city|town|address|geo(code)?|place|pelias|where[_ -]?based)/i;
// "None" and "N/A" are deliberately absent: they are the real answer to plenty of clearance and
// years-of-experience questions. An unanswerable first row is caught by the empty-value test in
// setNativeSelect, not by its wording.
const PLACEHOLDER_RE = /^(|-+|\u2014+|select(\s|$).*|choose(\s|$).*|please\s+select.*|pick\s+one.*)$/i;
// "Loading…" means keep polling; "No results" is the geocoder's final answer — polling past it
// only burns the four-second budget a slow network round trip is reserved for.
const LOADING_RE = /^(loading|searching|fetching|\u2026|\.\.\.)/i;
const EMPTY_RE = /^(no\s+(results|options|matches|matching)|nothing\s+found|type\s+to\s+search|start\s+typing)/i;
const DATE_HINT_RE = /(^|[^a-z])(mm|dd|yy(yy)?|jj|aaaa|month|day|year)([^a-z]|$)/i;

// ─── detection ────────────────────────────────────────────────────────────────────────────────

/**
 * What the control at `selector` really is, read off the live element.
 * @returns {Promise<{control:string, planned:string|null, agreed:boolean, multiple:boolean,
 *                    format:string|null, hasCountry:boolean, why:string, evidence:object|null}>}
 */
export async function detectControl(page, selector, { question = null } = {}) {
  const planned = question?.control ?? null;
  if (!selector) return verdict("unknown", planned, "no selector", null);
  const shape = await page.evaluate(readShape, selector).catch(() => null);
  if (!shape) return verdict("unknown", planned, "no element at the selector", null);
  // The schema's own option list is evidence about the widget, not just about the answer: a field
  // whose vocabulary the ATS already published cannot be a geocoder, however its label reads.
  const { control, why } = classifyShape(shape, { options: (question?.options ?? []).length });
  return verdict(control, planned, why, shape);
}

function verdict(control, planned, why, shape) {
  return {
    control,
    planned,
    agreed: planned == null || planned === control,
    multiple: Boolean(shape?.multiple),
    format: shape?.format || null,
    hasCountry: Boolean(shape?.hasCountry),
    why,
    evidence: shape
      ? { tag: shape.tag, type: shape.type, role: shape.role, group: shape.group, format: shape.format || null }
      : null,
  };
}

/**
 * Tag/role/aria/class facts about one control, in page context. Pure observation — every decision
 * is made by `classifyShape` so the rules stay readable and testable outside a browser.
 */
function readShape(selector) {
  const clean = (s) => String(s ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const host = document.querySelector(selector);
  if (!host) return null;
  const inner = "input:not([type=hidden]), textarea, select";
  const el = host.matches(inner) ? host : (host.querySelector(inner) ?? host);
  const scope =
    el.closest(
      "fieldset, [data-field-path], .select-shell, .file-upload, .ashby-application-form-field-entry, .field, [class*='field-entry']",
    ) ??
    el.parentElement ??
    document.body;
  const at = (n, a) => (n && n.getAttribute ? n.getAttribute(a) || "" : "");
  const classChain = [];
  for (let n = el, i = 0; n && i < 6; n = n.parentElement, i += 1) classChain.push(String(n.className || ""));
  const ancestry = classChain.join(" ").toLowerCase();
  const tag = el.tagName.toLowerCase();
  const type = String(el.type || at(el, "type") || "").toLowerCase();
  const name = at(el, "name");
  // The field's question title, in the order the two boards write it: `label[for=<id>]`, the
  // element's own `aria-label`, a wrapping `<label>`, and last the label the *field* carries.
  // That last source is what makes an Ashby geocoder recognisable — its input has neither id nor
  // name and its `<label for="<data-field-path>">` is a sibling, so on the first three sources
  // alone the widget is an anonymous combobox and takes the vocabulary path instead of the
  // location one (measured on the live ElevenLabs and DeepL forms, 2026-09-23).
  const labelFor = (id) => (id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null);
  const fieldLabel =
    scope === document.body ? null : (labelFor(at(scope, "data-field-path")) ?? scope.querySelector("label, legend"));
  const label =
    [labelFor(el.id), at(el, "aria-label"), el.closest("label"), fieldLabel]
      .map((n) => clean(typeof n === "string" ? n : n?.textContent))
      .find(Boolean) ?? "";
  const group =
    type === "radio" || type === "checkbox"
      ? (name ? scope.querySelectorAll(`input[type="${type}"][name="${CSS.escape(name)}"]`).length : 0) ||
        scope.querySelectorAll(`input[type="${type}"]`).length
      : 0;
  return {
    tag,
    type,
    role: String(at(el, "role") || at(host, "role")).toLowerCase(),
    haspopup: String(at(el, "aria-haspopup") || at(host, "aria-haspopup")).toLowerCase(),
    autocomplete: String(at(el, "aria-autocomplete")).toLowerCase(),
    controls: at(el, "controls") || at(el, "aria-controls") || at(el, "aria-owns"),
    id: el.id || "",
    name,
    testid: [at(el, "data-testid"), at(host, "data-testid"), at(scope, "data-testid")].filter(Boolean).join(" "),
    className: String(el.className || ""),
    ancestry,
    label,
    placeholder: clean(at(el, "placeholder") || at(el, "aria-placeholder")),
    pattern: at(el, "pattern"),
    format: clean(at(el, "placeholder") || at(el, "data-format") || at(el, "pattern")),
    inputmode: String(at(el, "inputmode")).toLowerCase(),
    group,
    options: tag === "select" ? el.options.length : 0,
    multiple:
      el.multiple === true ||
      at(el, "aria-multiselectable") === "true" ||
      /--is-multi|multi-?value|multiselect/i.test(ancestry) ||
      Boolean(scope.querySelector('.select__multi-value, [class*="multi-value"], [class*="multiValue"]')),
    hasCountry: Boolean(
      el.closest(".iti") ||
        scope.querySelector(
          '.iti__flag-container, .iti__selected-country, [role="combobox"][aria-label*="ountry"], select[name*="ountry"], select[id*="ountry"]',
        ),
    ),
    pelias: /pelias/i.test(ancestry) || Boolean(scope.querySelector('[class*="pelias"], [id*="pelias"]')),
    // Ashby renders a Boolean as a Yes/No `button[data-option]` pair with no input at all.
    buttons: scope.querySelectorAll('button[data-option], [role="radio"], [role="radiogroup"] button').length,
    isHost: el === host,
  };
}

/**
 * The ordered rules turning one `readShape` result into a control kind. `options` is how many
 * choices the ATS schema published for the field: a widget with a published vocabulary is a
 * select even when its label names a place, which is the only thing that tells Ashby's
 * `ValueSelect`-as-autocomplete apart from Ashby's geocoder — they are the same DOM.
 */
export function classifyShape(shape, { options = 0 } = {}) {
  const s = shape ?? {};
  const hint = `${s.id} ${s.name} ${s.testid} ${s.label} ${s.placeholder}`;
  const placeNamed = s.pelias || LOCATION_RE.test(hint);
  const located = placeNamed && options === 0;
  const comboish =
    s.role === "combobox" ||
    ["list", "both", "inline"].includes(s.autocomplete) ||
    ["listbox", "menu", "true"].includes(s.haspopup) ||
    /select__input/.test(s.className) ||
    /select__control|select-shell|react-select/.test(s.ancestry) ||
    /-listbox$/.test(s.controls || "");

  if (s.tag === "select") return { control: "native_select", why: `<select> with ${s.options} options` };
  if (s.tag === "textarea") return { control: "textarea", why: "<textarea>" };
  if (s.type === "file") return { control: "file", why: 'input[type="file"]' };
  if (s.type === "radio") return { control: "radio", why: `radio group of ${Math.max(s.group, 1)}` };
  if (s.type === "checkbox") {
    return s.group > 1
      ? { control: "checkbox_group", why: `${s.group} checkboxes in one field` }
      : { control: "checkbox", why: "single checkbox" };
  }
  if (["date", "month", "week", "datetime-local"].includes(s.type)) return { control: "date", why: `input[type="${s.type}"]` };
  if (s.type === "number") return { control: "number", why: 'input[type="number"]' };
  if (s.type === "tel" || (s.hasCountry && /phone|tel/i.test(hint))) {
    return { control: "tel", why: s.hasCountry ? "tel input with a country picker" : 'input[type="tel"]' };
  }
  if (comboish) {
    if (located) return { control: "location", why: "async location autocomplete" };
    if (/select__input/.test(s.className) || /select__control|select-shell/.test(s.ancestry)) {
      return { control: "react_select", why: `react-select${s.multiple ? " (multi)" : ""}` };
    }
    return { control: "combobox", why: `aria combobox (autocomplete=${s.autocomplete || "none"})` };
  }
  if (s.role === "listbox") return { control: "listbox", why: "role=listbox" };
  // No form element anywhere in the field, but a group of mutually exclusive buttons: that is a
  // radio group with a different DOM, not an unknown control.
  if (!["input", "textarea", "select"].includes(s.tag) && s.buttons > 1) {
    return { control: "radio", why: `${s.buttons}-button group` };
  }
  if (["text", "search", "email", "url", ""].includes(s.type) && s.tag === "input") {
    if (DATE_HINT_RE.test(s.format || "") && /[/.\-]/.test(s.format || "")) {
      return { control: "date", why: `text input formatted "${s.format}"` };
    }
    if (s.inputmode === "numeric" || s.inputmode === "decimal") return { control: "number", why: `inputmode=${s.inputmode}` };
    if (placeNamed) return { control: "text", why: "location-named plain text input" };
    return { control: "text", why: `input[type="${s.type || "text"}"]` };
  }
  if (s.tag === "input") return { control: "text", why: `input[type="${s.type}"] treated as text` };
  return { control: "unknown", why: `<${s.tag}> with no recognisable control inside` };
}

// ─── shared helpers (also used by the ATS adapters) ───────────────────────────────────────────

/** Jev may answer with an option's `value`; the DOM only knows labels. */
export function wantedLabel(question, value) {
  const raw = String(value ?? "");
  const options = Array.isArray(question?.options) ? question.options : [];
  const hit = options.find((o) => o && norm(o.value) !== "" && norm(o.value) === norm(raw));
  return hit ? String(hit.label ?? raw) : raw;
}

/** A multi-select answer is `"A | B"` (src/jev/plan.mjs); newline and `;` are accepted too. */
export function splitValues(value) {
  return String(value ?? "")
    .split(/\s*\|\s*|\s*;\s*|\n+/)
    .map((v) => norm(v))
    .filter(Boolean);
}

const flatten = (s) =>
  normLabel(s)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const STOPWORDS = new Set(
  ("a an the i of to in for and or will do does not am is are my me you your at on with need that this be have has it as by" +
    " from would require yes no if we us our their they he she but so than then when which who what")
    .split(" "),
);

/** The words in an answer that actually filter a menu — "Yes, I will require sponsorship" → "sponsorship". */
export function distinctiveTokens(value, limit = 3) {
  return norm(value)
    .split(/[^\p{L}\p{N}+]+/u)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t.toLowerCase()))
    .slice(0, limit);
}

/**
 * Filter strings to try, in order: the answer itself (short answers filter fine), then its most
 * distinctive word (a long sentence matches no option verbatim), then nothing at all — an empty
 * filter renders the widget's whole vocabulary, which is what a paraphrase needs.
 */
export function searchKeys(value) {
  const full = norm(value);
  const keys = [];
  if (full) keys.push(full.slice(0, 24));
  const longest = distinctiveTokens(full).sort((a, b) => b.length - a.length)[0];
  if (longest) keys.push(longest);
  keys.push("");
  return [...new Set(keys)];
}

/**
 * One rendered label out of `labels`, or null. Exact → prefix → word-boundary substring
 * (`pickOption`) → punctuation-insensitive equality → the injected Jev rung. Never an index.
 * @param {{labels:string[], want:string, question?:object, control?:string,
 *          chooseOption?:Function, allowModel?:boolean}} args
 */
export async function chooseLabel({ labels, want, question = null, control = "combobox", chooseOption = null, allowModel = true }) {
  const direct = pickOption(labels, want);
  if (direct) return { ...direct, strategy: direct.match };
  const target = flatten(want);
  if (target) {
    const flat = labels.map((l, i) => [flatten(l), i]).filter(([l]) => l === target);
    if (flat.length === 1) return { index: flat[0][1], label: labels[flat[0][1]], strategy: "normalized" };
  }
  if (!allowModel || !chooseOption) return null;
  const chosen = await chooseOption({ question, value: want, labels, control }).catch(() => null);
  if (!chosen?.label) return null;
  const index = labels.findIndex((l) => normLabel(l) === normLabel(chosen.label));
  if (index < 0) return null;
  return { index, label: labels[index], strategy: "jev" };
}

/** A row that offers nothing to answer with: "Select…", "—", "Loading…". */
export const isPlaceholderLabel = (label) =>
  PLACEHOLDER_RE.test(normLabel(label)) || LOADING_RE.test(normLabel(label)) || EMPTY_RE.test(normLabel(label));

const esc = (s) => String(s ?? "").replace(/(["\\])/g, "\\$1");

/** The input a selector stands for; a selector may legitimately point at the field's container. */
export async function resolveInput(page, selector) {
  const host = page.locator(selector).first();
  const inner = host.locator("input:not([type=hidden]), textarea, select");
  if ((await host.evaluate((el) => el.matches("input, textarea, select")).catch(() => false)) === true) return host;
  if (await inner.count().catch(() => 0)) return inner.first();
  return host;
}

/** The field's box, for chips and options that render beside the input rather than in a portal. */
export async function containerFor(page, input) {
  for (const xp of [
    "xpath=ancestor-or-self::*[@data-field-path][1]",
    'xpath=ancestor-or-self::*[contains(@class,"select-shell")][1]',
    "xpath=ancestor-or-self::fieldset[1]",
    'xpath=ancestor-or-self::*[contains(@class,"field")][1]',
    "xpath=parent::*",
  ]) {
    const loc = input.locator(xp);
    if (await loc.count().catch(() => 0)) return loc.first();
  }
  return input;
}

/**
 * The menu this input just opened, narrowest scope first: the listbox it owns (`aria-controls`),
 * react-select's `<id>-listbox`, the portal, the field's own box, then any visible listbox.
 * `:visible` is load-bearing — intl-tel-input keeps 246 country rows in the DOM at all times, and
 * a page-wide `[role=option]` handed one recorded run that list instead of the field's three.
 */
export async function menuOptions(page, input, container = null) {
  const owned = (await input.getAttribute("aria-controls").catch(() => null)) || (await input.getAttribute("aria-owns").catch(() => null));
  const id = (await input.getAttribute("id").catch(() => null)) || "";
  const candidates = [];
  if (owned) candidates.push(page.locator(`[id="${esc(owned)}"] [role="option"]:visible`));
  if (id) candidates.push(page.locator(`[id="${esc(id)}-listbox"] [role="option"]:visible, [id="react-select-${esc(id)}-listbox"] [role="option"]:visible`));
  candidates.push(page.locator('[id$="-listbox"] [role="option"]:visible'));
  candidates.push(page.locator('#react-portal-mount-point [role="option"]:visible'));
  if (container) candidates.push(container.locator('[role="option"]:visible'));
  candidates.push(page.locator('[role="listbox"]:visible [role="option"]:visible'));
  candidates.push(page.locator('[role="option"]:visible'));
  for (const loc of candidates) {
    if (await loc.count().catch(() => 0)) return loc;
  }
  return page.locator('[role="option"]:visible');
}

/**
 * The open menu itself, for the status rows a widget renders instead of options — react-select's
 * "No options", a geocoder's "No results". Those are not `[role=option]` nodes, so without this
 * an empty-but-answered menu is indistinguishable from one still waiting on the network, and
 * every failed match pays the full timeout.
 */
export async function menuBox(page, input, container = null) {
  const owned = (await input.getAttribute("aria-controls").catch(() => null)) || (await input.getAttribute("aria-owns").catch(() => null));
  if (owned) {
    const byOwner = page.locator(`[id="${esc(owned)}"]:visible`);
    if (await byOwner.count().catch(() => 0)) return byOwner.first();
  }
  for (const loc of [
    page.locator('#react-portal-mount-point [role="listbox"]:visible'),
    page.locator('[role="listbox"]:visible'),
  ]) {
    if (await loc.count().catch(() => 0)) return loc.first();
  }
  return container;
}

/** Poll the menu until it holds something pickable (not "Loading…"), or the deadline passes. */
export async function waitForOptions(page, input, container, timeout = OPTION_WAIT_MS) {
  const deadline = Date.now() + timeout;
  let options = await menuOptions(page, input, container);
  let labels = [];
  for (;;) {
    labels = (await options.allTextContents().catch(() => [])).map(norm).filter(Boolean);
    if (labels.some((l) => !isPlaceholderLabel(l))) break;
    if (labels.some((l) => EMPTY_RE.test(normLabel(l)))) break; // the widget has answered: nothing
    if (!labels.length) {
      const box = await menuBox(page, input, container);
      if (box && EMPTY_RE.test(normLabel(await textOf(box, { timeout: 500 })))) break;
    }
    if (Date.now() >= deadline) break;
    await sleep(150);
    options = await menuOptions(page, input, container);
  }
  return { options, labels };
}

// ─── the ladders ──────────────────────────────────────────────────────────────────────────────

const fail = (reason, observed = "", attempts = 1) => ({ ok: false, observed, attempts, reason });
const matchesWanted = (observed, want) => Boolean(observed) && pickOption([observed], want) !== null;

/**
 * Set one control, whatever it is. The ATS adapters call this for every kind they do not tune
 * themselves; `adapters/generic.mjs` calls it for all of them.
 *
 * @param {object} page Playwright page
 * @param {object} question FormPlan row (`selector`, `options?`, `country?`, `limits?`)
 * @param {string} value the answer
 * @param {{selector?:string, detected?:object, chooseOption?:Function}} opts
 * @returns {Promise<{ok:boolean, observed:string, attempts:number, reason?:string, strategy?:string}>}
 */
export async function setControl(page, question, value, opts = {}) {
  const selector = opts.selector ?? question?.selector;
  if (!selector) return fail("no_selector");
  const detected = opts.detected ?? (await detectControl(page, selector, { question }));
  // The plan named a control the page does not have (a two-step question, a conditional that
  // never appeared). Saying so costs one evaluate; waiting for it to attach costs ten seconds.
  if (detected.control === "unknown" && detected.evidence === null) return fail("control_not_found");
  const input = await resolveInput(page, selector);
  const container = await containerFor(page, input);
  const ctx = { selector, detected, input, container, chooseOption: opts.chooseOption ?? null };

  switch (detected.control) {
    case "file":
      return fail("file controls go through uploadFile()");
    case "textarea":
    case "text":
      return setTextLike(page, question, value, ctx);
    case "number":
      return setNumber(page, question, value, ctx);
    case "date":
      return setDate(page, question, value, ctx);
    case "tel":
      return setTel(page, question, value, ctx);
    case "native_select":
      return setNativeSelect(page, question, value, ctx);
    case "radio":
      return setRadioGroup(page, question, value, ctx);
    case "checkbox":
      return setSingleCheckbox(page, question, value, ctx);
    case "checkbox_group":
      return setCheckboxGroup(page, question, value, ctx);
    case "location":
      return setLocation(page, question, value, ctx);
    case "react_select":
    case "combobox":
    case "listbox":
      return detected.multiple || question?.type === "multi_select"
        ? setMultiCombobox(page, question, value, ctx)
        : setCombobox(page, question, value, ctx);
    default:
      return setUnknown(page, question, value, ctx);
  }
}

// text / textarea ------------------------------------------------------------------------------

async function setTextLike(page, question, value, { input }) {
  await input.waitFor({ state: "visible", timeout: 10000 });
  await pace(page, input);
  const want = String(value ?? "");
  const result = await attemptSet({
    set: async () => {
      await input.click({ timeout: 5000 }).catch(() => {});
      await input.fill(want);
      await input.blur().catch(() => {});
    },
    read: () => valueOf(input),
    ok: (observed) => norm(observed) === norm(want),
  });
  if (result.ok) return { ...result, strategy: "fill" };
  // A field that silently truncates is a limit the plan did not parse, not a flaky write.
  const max = Number(await input.getAttribute("maxlength").catch(() => null));
  if (Number.isFinite(max) && max > 0 && norm(result.observed).length === max && norm(want).length > max) {
    return { ...result, reason: `truncated_to_${max}` };
  }
  return result;
}

// number ----------------------------------------------------------------------------------------

/** The first number in an answer, thousands separators and currency removed. */
export function numericOf(value) {
  const cleaned = String(value ?? "").replace(/(\d)[,\u202f\u00a0](\d{3})(?!\d)/g, "$1$2");
  const hit = cleaned.match(/-?\d+(?:\.\d+)?/);
  return hit ? hit[0] : null;
}

async function setNumber(page, question, value, { input }) {
  const want = numericOf(value);
  if (want === null) return fail(`not_a_number: ${norm(value).slice(0, 40)}`, await valueOf(input));
  await input.waitFor({ state: "visible", timeout: 10000 });
  await pace(page, input);
  const result = await attemptSet({
    set: async () => {
      await input.click({ timeout: 5000 }).catch(() => {});
      await input.fill(want);
      await input.blur().catch(() => {});
    },
    read: () => valueOf(input),
    ok: (observed) => norm(observed) === want || digits(observed) === digits(want),
  });
  return result.ok ? { ...result, strategy: "digits" } : result;
}

// date ------------------------------------------------------------------------------------------

const MONTHS = "january february march april may june july august september october november december".split(" ");

/** `{y, m, d}` from an ISO date, a month name, or a string already in `order` (the target format). */
export function parseDateParts(value, order = "YMD") {
  const raw = norm(value);
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (iso) return { y: +iso[1], m: +iso[2], d: iso[3] ? +iso[3] : 1 };
  const named = raw.match(/^(?:(\d{1,2})\s+)?([a-z]+)\.?\s*,?\s*(?:(\d{1,2})\s*,?\s*)?(\d{4})$/i);
  if (named) {
    const m = MONTHS.findIndex((n) => n.startsWith(named[2].toLowerCase().slice(0, 3)));
    if (m >= 0) return { y: +named[4], m: m + 1, d: +(named[1] ?? named[3] ?? 1) };
  }
  const parts = raw.match(/^(\d{1,4})[/.\-](\d{1,2})(?:[/.\-](\d{1,4}))?$/);
  if (parts) {
    const nums = [parts[1], parts[2], parts[3]].filter((p) => p != null).map(Number);
    if (String(parts[1]).length === 4) return { y: nums[0], m: nums[1], d: nums[2] ?? 1 };
    if (nums.length === 3) {
      const map = { MDY: [2, 0, 1], DMY: [2, 1, 0], YMD: [0, 1, 2] }[order] ?? [2, 0, 1];
      return { y: nums[map[0]], m: nums[map[1]], d: nums[map[2]] };
    }
    return { y: nums[1], m: nums[0], d: 1 };
  }
  return null;
}

/** The order and separator a widget wants, read from `type=date`, its placeholder, or its pattern. */
export function dateFormatOf({ type = "", format = "" } = {}) {
  if (["date", "datetime-local"].includes(type)) return { order: "YMD", sep: "-", pad: true, native: true };
  if (type === "month") return { order: "YM", sep: "-", pad: true, native: true };
  const hint = String(format || "").toUpperCase();
  const sep = (hint.match(/[/.\-]/) ?? ["/"])[0];
  const order = hint.replace(/[^YMDJA]/g, "").replace(/A{2,}/g, "Y").replace(/J{2,}/g, "D").replace(/(.)\1+/g, "$1");
  if (/^(YMD|MDY|DMY|YM|MY)$/.test(order)) return { order, sep, pad: true, native: false };
  return { order: "YMD", sep: "-", pad: true, native: false };
}

export function formatDate({ y, m, d }, { order, sep }) {
  const pad = (n) => String(n).padStart(2, "0");
  const piece = { Y: String(y), M: pad(m), D: pad(d) };
  return order.split("").map((k) => piece[k]).join(sep);
}

async function setDate(page, question, value, { input, detected }) {
  const shape = { type: detected?.evidence?.type ?? "", format: detected?.format ?? "" };
  const fmt = dateFormatOf(shape);
  const parts = parseDateParts(value, fmt.order);
  if (!parts) return fail(`unparsable_date: ${norm(value).slice(0, 40)}`, await valueOf(input));
  const want = formatDate(parts, fmt);
  await input.waitFor({ state: "visible", timeout: 10000 });
  await pace(page, input);
  const result = await attemptSet({
    // Attempt 1 writes the value; attempt 2 types it, for masked inputs that ignore a direct set.
    set: async (n) => {
      await input.click({ timeout: 5000 }).catch(() => {});
      if (n === 1) await input.fill(want);
      else {
        await input.fill("");
        await input.pressSequentially(fmt.native ? want : want.replace(/\D/g, ""), { delay: 40 });
      }
      await input.blur().catch(() => {});
    },
    read: () => valueOf(input),
    ok: (observed) => norm(observed) === want || digits(observed) === digits(want),
  });
  return result.ok ? { ...result, strategy: `date:${fmt.order}${fmt.sep}` } : { ...result, reason: result.reason ?? `expected ${want}` };
}

// native select ---------------------------------------------------------------------------------

async function setNativeSelect(page, question, value, { input, chooseOption }) {
  await input.waitFor({ state: "visible", timeout: 10000 });
  await pace(page, input);
  const want = wantedLabel(question, value);
  const meta = await input
    .locator("option")
    .evaluateAll((els) => els.map((o) => ({ label: (o.textContent || "").replace(/\s+/g, " ").trim(), value: o.value })));
  const labels = meta.map((m) => m.label);
  const shown = async () => norm(await input.locator("option:checked").first().textContent().catch(() => ""));
  const before = await shown();

  let pick = pickOption(labels, want);
  let strategy = pick ? `label:${pick.match}` : null;
  if (!pick) {
    const byValue = pickOption(meta.map((m) => m.value), want);
    if (byValue) {
      pick = { index: byValue.index, label: labels[byValue.index] };
      strategy = `value:${byValue.match}`;
    }
  }
  if (!pick) {
    const fuzzy = await chooseLabel({ labels, want, question, control: "native_select", chooseOption });
    if (fuzzy) {
      pick = fuzzy;
      strategy = fuzzy.strategy;
    }
  }
  if (!pick) return fail(`no_matching_option (${labels.length} shown)`, before);
  // A matched placeholder is still a placeholder: committing it answers nothing.
  if (isPlaceholderLabel(pick.label) || (meta[pick.index].value === "" && pick.index === 0)) {
    return fail("placeholder_option", before);
  }

  const chosen = meta[pick.index];
  const result = await attemptSet({
    set: async () => {
      if (chosen.value) await input.selectOption({ value: chosen.value });
      else await input.selectOption({ label: chosen.label });
      await input.blur().catch(() => {});
    },
    read: shown,
    ok: (observed) => normLabel(observed) === normLabel(chosen.label),
  });
  return result.ok ? { ...result, strategy } : result;
}

// radio / checkbox -------------------------------------------------------------------------------

async function clickGroupMember(page, boxes, meta, index) {
  const target = boxes.nth(index);
  const chosen = meta[index];
  const label = chosen.id ? page.locator(`label[for="${esc(chosen.id)}"]`).first() : target;
  const clickable = (await label.count().catch(() => 0)) ? label : target;
  await pace(page, clickable);
  return attemptSet({
    set: async () => {
      await guardNoSubmit(clickable);
      await clickable.click({ timeout: 5000 }).catch(async () => {
        await target.check({ timeout: 5000, force: true });
      });
    },
    read: async () => ((await target.isChecked().catch(() => false)) ? chosen.label : ""),
    ok: (observed) => normLabel(observed) === normLabel(chosen.label),
  });
}

/** The real `input[type=radio|checkbox]` members of a group, or null when the field has none. */
async function groupOf(page, { input, container, selector }, type, question = null) {
  const name = String(question?.name ?? question?.qid ?? "").replace(/(["\\])/g, "\\$1");
  const tries = [
    container.locator(`input[type="${type}"]`),
    page.locator(`${selector} input[type="${type}"]`),
    name ? page.locator(`input[type="${type}"][name="${name}"]`) : null,
    name ? page.locator(`input[type="${type}"][id^="${name}"]`) : null,
  ];
  for (const loc of tries) {
    if (loc && (await loc.count().catch(() => 0))) return loc;
  }
  // `input` itself only counts when it *is* one of them — a container locator matching some
  // unrelated div would otherwise be answered as if it were a one-option group.
  const own = input.locator(`xpath=self::input[@type="${type}"]`);
  return (await own.count().catch(() => 0)) ? input : null;
}

/** Segmented controls: Ashby's Yes/No `button[data-option]` pair, ARIA `role=radio` buttons. */
const BUTTON_GROUP = 'button[data-option], [role="radio"], [role="radiogroup"] button, [role="radiogroup"] [role="option"]';

const buttonMeta = (buttons) =>
  buttons.evaluateAll((els) =>
    els.map((el) => ({
      label: String(el.getAttribute("data-option") || el.getAttribute("aria-label") || el.textContent || "")
        .replace(/\s+/g, " ")
        .trim(),
      pressed:
        el.getAttribute("aria-pressed") === "true" ||
        el.getAttribute("aria-checked") === "true" ||
        el.getAttribute("data-state") === "checked",
    })),
  );

async function setButtonGroup(page, question, value, ctx) {
  const buttons = ctx.container.locator(BUTTON_GROUP);
  const meta = await buttonMeta(buttons).catch(() => []);
  if (meta.length < 2) return fail("radio_group_not_found");
  const want = wantedLabel(question, value);
  const pick = await chooseLabel({ labels: meta.map((m) => m.label), want, question, control: "radio", chooseOption: ctx.chooseOption });
  if (!pick) return fail(`no_matching_option (${meta.length} shown)`, meta.map((m) => m.label).join(" | ").slice(0, 140));
  const target = buttons.nth(pick.index);
  await pace(page, target);
  const result = await attemptSet({
    set: async () => {
      await guardNoSubmit(target);
      await target.click({ timeout: 5000 });
    },
    read: async () => {
      const now = await buttonMeta(buttons).catch(() => []);
      return now[pick.index]?.pressed ? now[pick.index].label : "";
    },
    ok: (observed) => normLabel(observed) === normLabel(meta[pick.index].label),
  });
  return result.ok ? { ...result, strategy: `button:${pick.strategy}` } : result;
}

async function setRadioGroup(page, question, value, ctx) {
  const boxes = await groupOf(page, ctx, "radio", question);
  // No inputs anywhere in the field: the group is rendered as buttons, not as radios.
  if (!boxes) return setButtonGroup(page, question, value, ctx);
  const meta = await labelsOf(boxes);
  const want = wantedLabel(question, value);
  const pick = await chooseLabel({ labels: meta.map((m) => m.label), want, question, control: "radio", chooseOption: ctx.chooseOption });
  if (!pick) return fail(`no_matching_option (${meta.length} shown)`, meta.map((m) => m.label).join(" | ").slice(0, 140));
  const result = await clickGroupMember(page, boxes, meta, pick.index);
  return result.ok ? { ...result, strategy: pick.strategy } : result;
}

/**
 * The one option a single-box row stands for, or null when the row is an ordinary Boolean.
 * A `multi_value_multi_select` with exactly one value renders as one checkbox, and its answer is
 * that value's own sentence, never a yes/no word.
 */
export function loneOption(question) {
  const options = Array.isArray(question?.options) ? question.options : [];
  if (options.length !== 1) return null;
  return String(options[0]?.label ?? options[0]?.value ?? "") || null;
}

/**
 * One checkbox, two questions wearing the same DOM. A Boolean ("I agree to the terms") is
 * answered yes/no. A one-option multi-select — Cloudflare's privacy-policy acknowledgement,
 * 1Password's background-check acknowledgement, both `multi_value_multi_select` rows with a
 * single value — is answered with the option itself, and "select it" is what a truthy answer
 * means. Both were scored `set_failed:not_boolean` while `asYesNo` was the only reading.
 *
 * The option still has to be *named*: matching is `pickOption` against that one label, the same
 * never-because-it-is-the-only-one rule the menus follow. Declining leaves the box alone rather
 * than unchecking it — for a pick-many row "not selected" is the answer, and clearing a box the
 * page may have arrived with would discard a value nobody asked us to discard.
 */
async function setSingleCheckbox(page, question, value, { input }) {
  const want = wantedLabel(question, value);
  const yn = asYesNo(want);
  const option = loneOption(question);
  const state = async () => ((await input.isChecked().catch(() => false)) ? "checked" : "unchecked");
  const names = option !== null && pickOption([option], want) !== null;
  const select = yn === "yes" || (yn === null && names);

  if (!select && yn !== "no") return fail(`not_boolean: ${norm(value).slice(0, 40)}`, await state());
  if (!select && option !== null) return { ok: true, observed: await state(), attempts: 1, strategy: "unselected" };

  await pace(page, input);
  const result = await attemptSet({
    set: async () => {
      if (select) await input.check({ timeout: 5000, force: true });
      else await input.uncheck({ timeout: 5000, force: true });
    },
    read: state,
    ok: (observed) => observed === (select ? "checked" : "unchecked"),
  });
  return result.ok ? { ...result, strategy: names && yn === null ? "option" : "check" } : result;
}

/** n checkboxes, one answer per value. Nothing is ever *un*checked: that would discard an answer. */
async function setCheckboxGroup(page, question, value, ctx) {
  const boxes = await groupOf(page, ctx, "checkbox", question);
  if (!boxes) return fail("checkbox_not_found");
  const meta = await labelsOf(boxes);
  const labels = meta.map((m) => m.label);
  const wants = splitValues(wantedLabel(question, value));
  if (!wants.length) return fail("no_value");

  const done = [];
  const missing = [];
  let attempts = 0;
  for (const want of wants) {
    const pick = await chooseLabel({ labels, want, question, control: "checkbox_group", chooseOption: ctx.chooseOption });
    if (!pick) {
      missing.push(want);
      continue;
    }
    const result = await clickGroupMember(page, boxes, meta, pick.index);
    attempts = Math.max(attempts, result.attempts);
    if (result.ok) done.push(pick.label);
    else missing.push(want);
    await sleep(cadenceMs(80, 180));
  }
  const observed = done.join(" | ");
  if (missing.length) return { ok: false, observed, attempts: Math.max(attempts, 1), reason: `unmatched: ${missing.join(", ").slice(0, 80)}` };
  return { ok: true, observed, attempts: Math.max(attempts, 1), strategy: `checked:${done.length}` };
}

// combobox family --------------------------------------------------------------------------------

/** What a combobox is showing as its committed answer, after the typed filter has been dropped. */
async function committedText(input, container) {
  if (norm(await input.inputValue().catch(() => "")) !== "") await input.blur().catch(() => {});
  const chip = container.locator('.select__single-value, [class*="single-value"], [class*="singleValue"], [class*="selected-value"]');
  if (await chip.count().catch(() => 0)) {
    const text = await textOf(chip);
    if (text) return text;
  }
  const held = await valueOf(input);
  if (held) return held;
  const aria = container.locator('[role="combobox"]');
  if (await aria.count().catch(() => 0)) return textOf(aria);
  return "";
}

async function setCombobox(page, question, value, ctx, { read = null, allowModel = true } = {}) {
  const { input, container, chooseOption } = ctx;
  await input.waitFor({ state: "attached", timeout: 10000 });
  const want = wantedLabel(question, value);
  const keys = searchKeys(want);
  // Blur, never Escape or fill(""): both clear the committed value on react-select widgets.
  const dismiss = async () => {
    await input.blur().catch(() => {});
  };
  await pace(page, input);

  let reason = null;
  let strategy = null;
  let seen = 0;
  const result = await attemptSet({
    settleMs: 350,
    // One set() climbs every filter string; the two attempts of the loop stay the read-back
    // budget PLAN §2.2 step 11 allows, not a licence to click three options. The model rung is
    // offered only on the LAST, unfiltered key: a filtered menu is the widget's substring match
    // for what we typed, so every entry already contains the answer and `none_of_these` has to
    // out-argue a set of literal partial matches (measured on the live Together AI location
    // picker — see resolveVocabulary in src/plan/execute.mjs). Unfiltered, the whole vocabulary
    // is on screen and the `none` exit competes fairly.
    set: async () => {
      reason = null;
      strategy = null;
      for (const key of keys) {
        await input.click({ timeout: 5000 }).catch(() => {});
        if (key) await input.pressSequentially(key, { delay: 35 });
        const { options, labels } = await waitForOptions(page, input, container, key === "" ? ASYNC_WAIT_MS : OPTION_WAIT_MS);
        const real = labels.filter((l) => !isPlaceholderLabel(l));
        seen = Math.max(seen, real.length);
        if (!real.length) {
          reason = "no_options_rendered";
          await dismiss();
          continue;
        }
        const pick = await chooseLabel({ labels, want, question, control: ctx.detected.control, chooseOption, allowModel: allowModel && key === "" });
        if (!pick || isPlaceholderLabel(pick.label)) {
          reason = `no_matching_option (${real.length} shown)`;
          await dismiss();
          continue;
        }
        const target = options.nth(pick.index);
        await guardNoSubmit(target);
        await moveMouseTo(page, target);
        await target.click({ timeout: 5000 });
        strategy = pick.strategy;
        reason = null;
        return;
      }
    },
    read: read ?? (() => committedText(input, container)),
    ok: async (observed) => {
      if (reason || !matchesWanted(observed, want)) return false;
      if ((await input.getAttribute("aria-expanded").catch(() => null)) === "true") return false;
      return true;
    },
    onFail: dismiss,
  });
  if (result.ok) return { ...result, strategy };
  return { ...result, reason: reason ?? result.reason ?? `read-back mismatch (${seen} options seen)` };
}

/** Multi-select: one pass per value, each verified by its own chip before the next is typed. */
async function setMultiCombobox(page, question, value, ctx) {
  const { input, container } = ctx;
  const wants = splitValues(wantedLabel(question, value));
  if (!wants.length) return fail("no_value");
  const chips = async () =>
    (await container
      .locator('.select__multi-value__label, [class*="multi-value"] [class*="label"], [class*="multiValue"] [class*="label"], [data-chip]')
      .allTextContents()
      .catch(() => []))
      .map(norm)
      .filter(Boolean);

  const missing = [];
  let attempts = 1;
  for (const want of wants) {
    // Read the chips, not the input: a multi-select clears its filter on every commit, so the
    // only evidence that a value took is the chip carrying its label.
    const one = await setCombobox(page, question, want, ctx, {
      read: async () => {
        const all = await chips();
        return all.find((c) => matchesWanted(c, want)) ?? all.join(" | ");
      },
    });
    attempts = Math.max(attempts, one.attempts ?? 1);
    if (!one.ok) missing.push(want);
    await sleep(cadenceMs(120, 260));
  }
  const observed = (await chips()).join(" | ");
  await input.blur().catch(() => {});
  if (missing.length) return { ok: false, observed, attempts, reason: `unmatched: ${missing.join(", ").slice(0, 80)}` };
  return { ok: true, observed, attempts, strategy: `chips:${wants.length}` };
}

// location ----------------------------------------------------------------------------------------

/** "Berlin, Germany" → ["Berlin", "Berlin, Germany"]; a bare city borrows `question.country`. */
export function locationQueries(value, question = null) {
  const full = norm(value);
  const city = norm(full.split(",")[0]);
  const country = norm(question?.country ?? "");
  const wide = full.includes(",") ? full : country ? `${city}, ${country}` : "";
  return [city, wide].filter(Boolean).filter((q, i, a) => a.indexOf(q) === i);
}

/**
 * The entry a geocoder offered for the place we asked about. One hit wins; several hits are
 * narrowed by the rest of the answer ("Berlin, Germany" vs "Berlin, Connecticut") and, failing
 * that, refused — picking a city the user never named is exactly the guess D-no-defaults forbids.
 *
 * A provider's index may also be *coarser* than the answer: Ashby's ElevenLabs field runs
 * `ApiAutocompleteGeoLocation` with `locationTypes:["Country"]`, so "Lisbon" returns "No results"
 * and "Lisbon, Portugal" returns the single entry "Portugal" (read off the live form on
 * 2026-09-23). Committing that is answering with a part of the answer, not with an invented
 * place, so it is allowed — but only for a part the answer itself writes, and only when exactly
 * one rendered entry *is* that part. A bare "Lisbon" against a country list still refuses.
 */
export function pickLocation(labels, value) {
  const want = normLabel(value);
  const parts = norm(value)
    .split(",")
    .map((p) => normLabel(p))
    .filter(Boolean);
  const city = parts[0] ?? "";
  const rest = parts.slice(1);
  const indexed = labels.map((l, i) => [normLabel(l), i]).filter(([l]) => l && !isPlaceholderLabel(l));
  const hit = ([, index], strategy) => ({ index, label: labels[index], strategy });

  const exact = indexed.filter(([l]) => l === want);
  if (exact.length) return hit(exact[0], "exact");
  const holding = indexed.filter(([l]) => l.includes(city));
  if (holding.length === 1) return hit(holding[0], "city");
  if (holding.length > 1) {
    const qualified = holding.filter(([l]) => l.startsWith(city) && rest.every((p) => l.includes(p)));
    return qualified.length === 1 ? hit(qualified[0], "city+qualifier") : null;
  }
  for (const part of rest) {
    const named = indexed.filter(([l]) => l === part);
    if (named.length === 1) return hit(named[0], "named_part");
  }
  return null;
}

async function setLocation(page, question, value, ctx) {
  const { input, container } = ctx;
  await input.waitFor({ state: "attached", timeout: 10000 });
  const want = norm(wantedLabel(question, value));
  const queries = locationQueries(want, question);
  if (!queries.length) return fail("no_value");
  // A geocoder commits into its own input, so searching means typing over whatever is there.
  // Anything already committed is put back if the search ends up committing nothing.
  const before = await committedText(input, container);
  if (before && pickLocation([before], want)) {
    return { ok: true, observed: before, attempts: 1, strategy: "location:already_set" };
  }
  const dismiss = async () => {
    await input.blur().catch(() => {});
  };
  await pace(page, input);

  let reason = null;
  let strategy = null;
  // The label actually clicked. The read-back is checked against *it*, not against the city: a
  // country-only geocoder commits "Portugal" for "Lisbon, Portugal", and a city test would call
  // that committed answer a failure and hand the row back as an ask.
  let committed = null;
  let seen = 0;
  const result = await attemptSet({
    settleMs: 350,
    // The geocoder answers over the network: type, then poll for up to 4 s; if it offered nothing
    // retry with the qualified form ("city, country"). That narrows most providers' index — and
    // on a country-only one it is the only form that returns anything at all, because the city
    // half of the answer is simply not in the vocabulary.
    set: async () => {
      reason = null;
      strategy = null;
      committed = null;
      for (const query of queries) {
        await input.click({ timeout: 5000 }).catch(() => {});
        await input.fill("").catch(() => {});
        await input.pressSequentially(query, { delay: 45 });
        const { options, labels } = await waitForOptions(page, input, container, ASYNC_WAIT_MS);
        const real = labels.filter((l) => !isPlaceholderLabel(l));
        seen = Math.max(seen, real.length);
        if (!real.length) {
          reason = "no_options_rendered";
          await dismiss();
          continue;
        }
        const pick = pickLocation(labels, want);
        if (!pick) {
          reason = real.length > 1 ? `ambiguous_location (${real.length} shown)` : `no_matching_option (${real.length} shown)`;
          await dismiss();
          continue;
        }
        const target = options.nth(pick.index);
        await guardNoSubmit(target);
        await moveMouseTo(page, target);
        await target.click({ timeout: 5000 });
        committed = pick.label;
        strategy = `location:${pick.strategy}`;
        reason = null;
        return;
      }
    },
    read: () => committedText(input, container),
    ok: async (observed) => {
      if (reason || committed === null) return false;
      return matchesWanted(observed, committed);
    },
    onFail: dismiss,
  });
  if (result.ok) return { ...result, strategy };
  // Blur is the restore, not `fill(before)`: rewriting the visible text would leave a Pelias or
  // react-select geocoder *looking* restored while its committed value and hidden lat/long stay
  // whatever the failed search left them. The widget puts its own committed text back.
  await dismiss();
  return {
    ...result,
    observed: before || (await committedText(input, container)),
    reason: reason ?? result.reason ?? `read-back mismatch (${seen} options seen)`,
  };
}

// tel ---------------------------------------------------------------------------------------------

/**
 * The phone country, by its own name, its ISO-2 code or its dial code — never by position.
 * Three widgets in the wild: intl-tel-input's flag button, an ARIA combobox, a plain `<select>`.
 * Returns `{ok:false, reason:"no_country_picker"}` when the field simply has none.
 */
export async function setCountry(page, container, country, { chooseOption = null } = {}) {
  const want = norm(country);
  if (!want) return fail("no_country");
  const iso = normLabel(want);
  const dial = want.startsWith("+") ? want : null;

  const flag = container.locator("button.iti__selected-country, .iti__flag-container, .iti__selected-flag").first();
  if (await flag.count().catch(() => 0)) {
    if (!(await flag.isVisible().catch(() => false))) return fail("country_picker_hidden");
    await pace(page, flag);
    await flag.click({ timeout: 5000 }).catch(() => {});
    const byCode = page.locator(`.iti__country-list li[data-country-code="${esc(iso)}"]`);
    let target = (await byCode.count().catch(() => 0)) ? byCode.first() : null;
    if (!target) {
      const search = page.locator("input.iti__search-input").first();
      if (await search.count().catch(() => 0)) await search.pressSequentially(want, { delay: 30 });
      const items = page.locator('.iti__country-list li, .iti__country-list [role="option"]');
      await items.first().waitFor({ state: "visible", timeout: OPTION_WAIT_MS }).catch(() => {});
      const names = (await items.locator(".iti__country-name").allTextContents().catch(() => [])).map(norm);
      const pick = names.length ? await chooseLabel({ labels: names, want, control: "tel", chooseOption }) : null;
      if (!pick) {
        await page.keyboard.press("Escape").catch(() => {});
        return fail("no_matching_country");
      }
      target = items.nth(pick.index);
    }
    const code = normLabel((await target.getAttribute("data-country-code").catch(() => "")) ?? "");
    const name = norm(await target.locator(".iti__country-name").first().textContent().catch(() => ""));
    await guardNoSubmit(target);
    await target.click({ timeout: 5000 });
    const ok = code === iso || (name !== "" && pickOption([name], want) !== null);
    return { ok, observed: name || code, attempts: 1, ...(ok ? { strategy: "iti" } : { reason: `committed ${JSON.stringify(name || code)}` }) };
  }

  const picker = container.locator('select[name*="ountry"], select[id*="ountry"], select[aria-label*="ountry"]').first();
  if (await picker.count().catch(() => 0)) {
    const result = await setNativeSelect(page, { options: [] }, want, { input: picker, chooseOption });
    if (result.ok || !dial) return result;
    // Dial-code answers ("+49") match a label like "Germany (+49)" only as a substring.
    const labels = (await picker.locator("option").allTextContents().catch(() => [])).map(norm);
    const hit = labels.filter((l) => l.includes(dial));
    if (hit.length !== 1) return result;
    return setNativeSelect(page, { options: [] }, hit[0], { input: picker, chooseOption });
  }

  const combo = container.locator('[role="combobox"][aria-label*="ountry"], [role="combobox"][aria-label*="Country"]').first();
  if (await combo.count().catch(() => 0)) {
    return setCombobox(page, { options: [] }, want, { input: combo, container, detected: { control: "combobox" }, chooseOption });
  }
  return fail("no_country_picker");
}

async function setTel(page, question, value, ctx) {
  const { input, container } = ctx;
  await input.waitFor({ state: "visible", timeout: 10000 });
  // The country goes first: intl-tel-input rewrites the number when the flag changes.
  const wantCountry = question?.country ?? null;
  const country = wantCountry ? await setCountry(page, container, wantCountry, { chooseOption: ctx.chooseOption }) : null;
  await pace(page, input);
  const want = String(value ?? "");
  const wantDigits = digits(want);
  if (!wantDigits) return fail(`not_a_number: ${norm(want).slice(0, 40)}`, await valueOf(input));
  const result = await attemptSet({
    set: async () => {
      await input.click({ timeout: 5000 }).catch(() => {});
      await input.fill(want);
      await input.blur().catch(() => {});
    },
    read: () => valueOf(input),
    // The widget reformats and may absorb the dial code (≤3 digits) into the flag; anything
    // shorter than that is a truncated write, not a reformat.
    ok: (observed) => {
      const seen = digits(observed);
      if (seen === "") return false;
      return seen === wantDigits || (wantDigits.endsWith(seen) && wantDigits.length - seen.length <= 3);
    },
  });
  if (!country) return result.ok ? { ...result, strategy: "fill" } : result;
  result.country = country.ok ? country.observed : (country.reason ?? "unset");
  // A number committed under the wrong dial code is the wrong number, so a picker that exists and
  // refused the requested country fails the row. A widget with no reachable picker has nothing to
  // get wrong: greenhouse.mjs's original rule — "a country hint must never block the number
  // itself" — is what keeps those a note instead of an ask.
  const unreachable = new Set(["no_country_picker", "country_picker_hidden", "no_country"]);
  if (!country.ok && !unreachable.has(country.reason)) {
    return { ...result, ok: false, reason: `country_not_set: ${norm(wantCountry).slice(0, 30)} (${country.reason})` };
  }
  return result.ok ? { ...result, strategy: country.ok ? "country+fill" : "fill" } : result;
}

// unknown -------------------------------------------------------------------------------------------

/** Last resort: write it, then type it, then say so — the row becomes an `ask` with a screenshot. */
async function setUnknown(page, question, value, { input }) {
  const want = String(value ?? "");
  // A control nothing recognises is still no excuse to click Submit (AGENTS invariant).
  const safe = await guardNoSubmit(input).then(() => true).catch(() => false);
  const read = async () => {
    const held = await valueOf(input);
    return held || (await textOf(input));
  };
  if (!safe) return { ok: false, observed: await read(), attempts: 1, reason: "unknown_control" };
  await pace(page, input);
  const result = await attemptSet({
    set: async (n) => {
      await input.click({ timeout: 5000 }).catch(() => {});
      if (n === 1) await input.fill(want).catch(() => {});
      else await input.pressSequentially(want, { delay: 35 }).catch(() => {});
    },
    read,
    ok: (observed) => norm(observed) === norm(want),
  });
  return result.ok ? { ...result, strategy: "unknown:fill" } : { ...result, reason: "unknown_control" };
}
