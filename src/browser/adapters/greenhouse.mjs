// Greenhouse hosted boards (job-boards.greenhouse.io) — PLAN §2.2 step 8, risk 6.
//
// Controls seen on the live board: `#first_name` / `#email` / `#question_<id>` text inputs,
// react-select comboboxes (`input.select__input` inside `.select-shell`), an intl-tel-input
// phone field, and `input#resume` (visually hidden) for the résumé.
//
// react-select commit semantics (risk 6): typing filters the menu, so the visible options are a
// *substring* match of what was typed — "No" leaves both "No, I do not …" and "Yes, I will …"
// (it contains "now"). Clicking index 0 would therefore answer the opposite of the intent. We
// always match the option label, never a position, and assert two things afterwards: the
// `.select__single-value` text and the disappearance of the `input[class*=requiredInput]` marker
// react-select renders while a required select is still empty.

import path from "node:path";

import {
  attemptSet,
  byId,
  cadenceMs,
  guardNoSubmit,
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
import { chooseLabel, detectControl, isPlaceholderLabel, searchKeys, setControl, waitForOptions } from "../controls.mjs";
import { captureFailure, tracer } from "../trace.mjs";
import * as generic from "./generic.mjs";

export const id = "greenhouse";

/**
 * The controls this board renders and tunes itself. Everything else — a date picker, a number
 * field, a checkbox group answered with several values, a geocoder, or a widget nothing
 * recognises — belongs to the shared ladder in `adapters/generic.mjs`. `checkbox` is the ladder's
 * too: a Greenhouse `multi_value_multi_select` with exactly one value (Cloudflare's privacy-policy
 * acknowledgement) renders as one box whose answer is that value's own sentence, and the yes/no
 * copy this file used to carry scored it `set_failed:not_boolean`.
 */
export const HANDLES = new Set(["text", "textarea", "react_select", "native_select", "file"]);

const OPTION_WAIT_MS = 3000;

export const selectorFor = (question) => question?.selector || byId(question?.qid ?? "");
const fieldSelector = selectorFor;

/** Jev may answer with an option's `value`; the DOM only knows labels. */
function wantedLabel(question, value) {
  const raw = String(value ?? "");
  const options = Array.isArray(question?.options) ? question.options : [];
  const hit = options.find((o) => o && norm(o.value) !== "" && norm(o.value) === norm(raw));
  return hit ? String(hit.label ?? raw) : raw;
}

/** One rendered label vs. the wanted value, using the same rule as the option picker. */
const matchesWanted = (observed, want) => Boolean(observed) && pickOption([observed], want) !== null;

async function firstPresent(...locators) {
  for (const loc of locators) {
    if (!loc) continue;
    if (await loc.count()) return loc.first();
  }
  return null;
}

async function selectShell(input) {
  return (
    (await firstPresent(
      input.locator('xpath=ancestor::*[contains(@class,"select-shell")][1]'),
      input.locator('xpath=ancestor::*[contains(@class,"select__control")][1]/..'),
    )) ?? input.locator("xpath=ancestor::div[1]").first()
  );
}

// ---------------------------------------------------------------------------- text / textarea

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

// ------------------------------------------------------------------------------- react-select

async function setReactSelect(page, question, value, selector, { chooseOption = null } = {}) {
  const input = page.locator(selector).first();
  await input.waitFor({ state: "attached", timeout: 10000 });
  const shell = await selectShell(input);
  const control = (await firstPresent(shell.locator(".select__control"))) ?? input;

  const want = wantedLabel(question, value);
  // Three filter strings, tried in order: the answer itself (short answers filter fine), its most
  // distinctive word (a saved sentence matches no option verbatim), then nothing at all — the
  // unfiltered menu is the only thing a paraphrase can be matched against.
  const keys = searchKeys(want);
  // Neither Escape nor `fill("")`: both clear the committed value (react-select's
  // `backspaceRemovesValue`, measured on the live form). Blur closes the menu, drops the typed
  // filter and restores whatever was already chosen.
  const dismiss = async () => {
    await input.blur().catch(() => {});
  };
  // Read the *committed* label, never the half-typed filter state: react-select swaps
  // `.select__single-value` out while the input holds text, so settle first, then wait for it.
  const committed = async () => {
    if (norm(await input.inputValue().catch(() => "")) !== "") await dismiss();
    const read = () => textOf(shell.locator(".select__single-value"));
    return waitUntil({ read, ok: (t) => t !== "", timeout: 1500, every: 150 });
  };

  await pace(page, control);
  let reason = null;
  let strategy = null;

  const result = await attemptSet({
    settleMs: 350,
    // One `set` climbs every filter string but clicks at most one option; the loop's two attempts
    // stay the read-back budget PLAN §2.2 step 11 allows. The model rung is offered only on the
    // last, unfiltered key — a filtered react-select menu is a substring match for what we typed,
    // so every entry already contains the answer and `none_of_these` cannot compete (measured on
    // the live location picker; see resolveVocabulary in src/plan/execute.mjs).
    //
    // The menu is resolved by the ladder's `waitForOptions` rather than by a hand-built
    // `#react-select-<input id>-listbox` selector, for two reasons measured on this board's EEO
    // block (2026-09-23): the demographic selects key their listbox off react-select's own
    // generated id, which is `aria-controls` and not always the input's id; and a filter that
    // matches nothing makes react-select render a "No options" notice, which the old blind
    // 3 s-per-key wait could not see — nine demographic rows cost ~20 s each on the way to
    // `no_matching_option`, which is what let the no-progress rule end a posting inside the EEO
    // block before one application question was reached.
    set: async () => {
      reason = null;
      strategy = null;
      for (const key of keys) {
        await control.click({ timeout: 5000 });
        // react-select resets its own filter text on blur, so there is nothing to clear here.
        if (key) await input.pressSequentially(key, { delay: 35 });
        const { options, labels } = await waitForOptions(page, input, shell, OPTION_WAIT_MS);
        const real = labels.filter((l) => !isPlaceholderLabel(l));
        if (!real.length) {
          // "the widget showed nothing at all" and "your text filtered everything away" are
          // different failures with different fixes, and only the second one is ours.
          reason = key ? "filtered_to_nothing" : "no_options_rendered";
          await dismiss();
          continue;
        }
        const pick = await chooseLabel({ labels, want, question, control: "react_select", chooseOption, allowModel: key === "" });
        if (!pick || isPlaceholderLabel(pick.label)) {
          // Never index 0: an unmatched value leaves the control exactly as it was.
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
    read: committed,
    ok: async (observed) => {
      if (reason) return false;
      if (!matchesWanted(observed, want)) return false;
      const markers = shell.locator('input[class*="requiredInput"]');
      const n = await markers.count();
      if (n > 0) {
        const marked = norm(await markers.first().inputValue().catch(() => ""));
        if (!marked) return false; // still flagged empty → the pick did not commit
      }
      return true;
    },
    onFail: dismiss,
  });

  if (result.ok) return { ...result, strategy };
  return reason ? { ...result, reason } : result;
}

// ------------------------------------------------------------------------------ native select

/** Plain `<select>`: the ladder's three rungs (label → value → Jev over the live option list). */
const setNativeSelect = (page, question, value, selector, opts = {}) =>
  setControl(page, question, value, { ...opts, selector, detected: { control: "native_select" } });

// --------------------------------------------------------------------------- radio / checkbox
//
// Radio groups, checkbox groups and the single Boolean checkbox are all the ladder's
// (src/browser/controls.mjs): same answer-by-label rule, plus the three things this file never
// had — a group rendered as buttons rather than inputs, a group answered with several values,
// and a one-option multi-select whose answer is that option's own sentence rather than "yes".

// --------------------------------------------------------------------------------------- tel
//
// intl-tel-input is handled by the ladder's `setCountry`/`setTel` (src/browser/controls.mjs):
// it knows this board's `.iti__flag-container` / `button.iti__selected-country` as well as the
// plain `#country` select some Greenhouse forms use instead, so there is one implementation of
// "commit the requested country, then the number", not two.

// ------------------------------------------------------------------------------------ public

export async function setField(page, question, value, opts = {}) {
  const { trace, chooseOption } = opts;
  const log = tracer(trace);
  const selector = opts.selector ?? fieldSelector(question);
  let result;
  let detected = opts.detected ?? null;
  try {
    // The DOM decides what this is; the FormPlan's `control` was a guess made offline.
    detected = detected ?? (await detectControl(page, selector, { question }));
    if (detected.control === "file") throw new Error("file controls go through uploadFile()");
    // A react-select holding several values commits into `.select__multi-value__label` chips and
    // never renders the `.select__single-value` this board's own path reads back, so it goes to
    // the ladder's chip-verified multi pass. Figma renders two 9-option `multi_value_multi_select`
    // rows exactly this way.
    const multi = detected.control === "react_select" && (detected.multiple || question?.type === "multi_select");
    const fn = multi
      ? null
      : {
          react_select: setReactSelect,
          native_select: setNativeSelect,
          text: setText,
          textarea: setText,
        }[detected.control];
    if (!fn) return generic.setField(page, question, value, { ...opts, selector, detected });
    result = await fn(page, question, value, selector, { detected, chooseOption });
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
  const selector = fieldSelector({ ...question, qid: question?.qid ?? "resume" });
  const base = path.basename(filePath);
  const input = page.locator(selector).first();

  // The field is `div.file-upload` (heading + `.file-upload__wrapper`). Greenhouse removes the
  // file input once a file is attached and renders `.file-upload__filename` in its place, so the
  // read-back is that chip — scoped to *this* field, because the cover letter has one too.
  //
  // On a re-attach the input is therefore already gone before the first read, and a block found
  // only through `selector` would be null: the chip would be unreadable and a résumé that is
  // already correct would report `file_input_not_found`. So when the input is absent the block is
  // located by its own heading instead — "Resume/CV" and "Cover Letter" are distinct fields.
  const wanted = normLabel(question?.label ?? (/cover/i.test(String(question?.qid ?? "")) ? "cover letter" : "resume"));
  const blockIndex = await page.evaluate(
    ({ sel, label }) => {
      const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const blocks = [...document.querySelectorAll(".file-upload")];
      const own = sel ? document.querySelector(sel)?.closest(".file-upload") : null;
      if (own) return blocks.indexOf(own);
      const title = (b) =>
        flat(b.querySelector(".file-upload__label, label, legend, h1, h2, h3, h4, h5")?.textContent ?? b.textContent);
      if (label) {
        const exact = blocks.findIndex((b) => title(b).startsWith(label));
        if (exact >= 0) return exact;
        const loose = blocks.findIndex((b) => title(b).includes(label));
        if (loose >= 0) return loose;
      }
      // Last resort: the field's kind. A heading the schema and the DOM word differently must not
      // cost us the read-back, but résumé and cover letter must never be confused for each other.
      const kind = label.includes("cover") ? /cover\s*letter/ : /resum|\bcv\b/;
      return blocks.findIndex((b) => kind.test(title(b)));
    },
    { sel: selector, label: wanted },
  );
  const block = blockIndex >= 0 ? page.locator(".file-upload").nth(blockIndex) : null;

  const shown = async () => {
    if (block) {
      const chip = block.locator(".file-upload__filename");
      if (await chip.count()) return norm(await chip.first().textContent().catch(() => ""));
    }
    if (await input.count()) {
      const held = norm(await input.evaluate((el) => el.files?.[0]?.name ?? "").catch(() => ""));
      if (held) return held;
    }
    return "";
  };

  const matched = (observed) => normLabel(observed) === normLabel(base);
  const before = await shown();
  const hasInput = Boolean(await input.count());
  let result;

  if (matched(before)) {
    result = { ok: true, observed: before, attempts: 1, reason: "already_attached" };
  } else if (before && !hasInput) {
    // A different file is attached; removing a user's attachment is not ours to do silently.
    result = { ok: false, observed: before, attempts: 1, reason: "different_file_attached" };
  } else if (!hasInput) {
    result = { ok: false, observed: "", attempts: 1, reason: "file_input_not_found" };
  } else {
    const anchor = await firstPresent(
      input.locator('xpath=ancestor::*[contains(@class,"secondary-button")][1]//button'),
      page.locator("button", { hasText: /^attach$/i }),
    );
    await pace(page, anchor);
    let observed = before;
    let attempts = 0;
    let reason = null;
    while (attempts < 2) {
      attempts += 1;
      try {
        if (await input.count()) await input.setInputFiles(filePath, { timeout: 15000 });
        else break; // the input is gone: the first attempt was accepted, keep the observation
        // Short first wait: a change event lost to an un-hydrated widget is cheaper to retry
        // than to wait out. The chip appears in ~1 s when the upload registers.
        observed = await waitUntil({ read: shown, ok: matched, timeout: 8000 });
        reason = null;
      } catch (err) {
        reason = `error: ${String(err.message).split("\n")[0].slice(0, 120)}`;
      }
      if (matched(observed)) break;
      if (attempts < 2) await sleep(cadenceMs());
    }
    if (matched(observed)) {
      // Greenhouse re-mounts the field block once the file finishes uploading, which briefly
      // takes the chip out of the DOM; settle, then re-confirm before calling it done.
      await sleep(400);
      observed = await waitUntil({ read: shown, ok: matched, timeout: 5000 });
    }
    result = { ok: matched(observed), observed, attempts, ...(reason && !matched(observed) ? { reason } : {}) };
  }
  result.selector = selector;
  if (!result.ok) result.shot = await captureFailure(page, trace, question);
  await log(generic.traceRow({ op: "upload", question: { ...question, control: "file" }, value: base, result, detected: null }));
  return result;
}

/**
 * The board is a React app: `load` fires before the application form exists. Every caller must
 * wait for the form root before touching a field, or the first set races the render.
 */
export async function waitForForm(page, { timeout = 30000 } = {}) {
  const root = page.locator('#first_name, input[id^="question_"], .select-shell').first();
  await root.waitFor({ state: "visible", timeout });
  return true;
}

/** Required controls and whether they are filled — PLAN §2.2 step 11's re-snapshot. */
export async function snapshotRequired(page) {
  return page.evaluate(() => {
    const norm = (s) => String(s ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    const esc = (id) => (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id) ? `#${id}` : `[id="${id}"]`);
    const labelOf = (el) => {
      const lab = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const text = norm(lab?.textContent ?? el.getAttribute("aria-label") ?? "");
      return text.replace(/\s*\*$/, "");
    };
    const rows = [];
    const seenGroups = new Set();
    for (const el of document.querySelectorAll("input, textarea, select")) {
      if (el.name === "g-recaptcha-response") continue;
      if (String(el.className || "").includes("requiredInput")) continue; // react-select's empty marker
      const required = el.required || el.getAttribute("aria-required") === "true";
      if (!required) continue;
      const shell = el.closest(".select-shell") || el.closest(".select__control")?.parentElement;
      let filled;
      let selector = el.id ? esc(el.id) : el.tagName.toLowerCase();
      let label = labelOf(el);
      const grouped = el.type === "checkbox" || el.type === "radio";
      if (grouped) {
        // One row per group (Greenhouse multi-selects are `input[name="question_<id>[]"]` sets).
        const key = el.name || el.id;
        if (seenGroups.has(key)) continue;
        seenGroups.add(key);
        const group = el.name ? [...document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)] : [el];
        filled = group.some((b) => b.checked);
        if (el.name) selector = `input[name="${el.name}"]`;
        const legend = norm(el.closest("fieldset")?.querySelector("legend")?.textContent ?? "").replace(/\s*\*$/, "");
        label = legend || label;
      } else if (String(el.className || "").includes("select__input") && shell) {
        filled = Boolean(shell.querySelector(".select__single-value, .select__multi-value"));
      } else if (el.type === "file") {
        continue; // file fields are reported once per `.file-upload` block below
      } else {
        filled = norm(el.value) !== "";
      }
      rows.push({ qid: (grouped ? el.name || el.id : el.id || el.name) || null, selector, label, filled });
    }
    // File fields carry no `required` attribute — the heading's `*` is the marker — and the
    // input is REMOVED once a file is attached. One row per `div.file-upload` block keeps the
    // shape identical before and after an upload (step 11 checks for *new* required controls).
    for (const block of document.querySelectorAll(".file-upload")) {
      const wrapper = block.querySelector(".file-upload__wrapper");
      const heading = norm(block.textContent).replace(norm(wrapper?.textContent ?? ""), "").trim();
      if (!/\*$/.test(heading)) continue; // optional attachment (e.g. Cover Letter)
      const input = block.querySelector('input[type="file"]');
      const label = heading.replace(/\s*\*$/, "");
      const qid = input?.id || (/resume|cv/i.test(label) ? "resume" : /cover/i.test(label) ? "cover_letter" : null);
      const chip = norm(block.querySelector(".file-upload__filename")?.textContent ?? "");
      rows.push({
        qid,
        selector: qid ? esc(qid) : ".file-upload",
        label,
        filled: Boolean(chip) || (input?.files?.length ?? 0) > 0,
      });
    }
    return rows;
  });
}

// ─── EEO / demographics ───────────────────────────────────────────────────────────────────────
//
// The board renders a self-identification block the API schema does not describe field for field
// (measured on togetherai/5179372007, 2026-09-23):
//
//   * `#hispanic_ethnicity` ("Are you Hispanic/Latino?") exists on the page and in **no** schema
//     row — the API still publishes the older combined `race` select instead;
//   * `#race` is **not in the DOM at all** until that ethnicity question is answered, because the
//     board walks the EEO-1 flow (ethnicity first; race only when the answer is No). A runner that
//     drives the schema's row order alone finds no `#race` control and reports the row as missing.
//
// So the live block is read off the page, in the order the page asks it, and the plan's values are
// matched onto it. Nothing here decides *what* to answer (that is `p.eeo` via
// `src/plan/resolve.mjs`), and nothing here opens a menu: the options of a react-select do not
// exist in the DOM until it is opened, and opening nine of them to look would be nine writes.

/** Self-identification controls the board names outright, whatever heading they sit under. */
const EEO_IDS = new Set(["gender", "race", "hispanic_ethnicity", "veteran_status", "disability_status", "disability"]);
// Headings the board puts above the block. Matched only *inside* the application form: this
// posting also carries an "Equal Opportunity" heading in the job description, and the nearest
// preceding heading of the form's own first inputs would otherwise be that one.
const EEO_SECTION_RE = /demographic|self[- ]identif|equal (?:employment )?opportunity|voluntary/i;

/**
 * The demographic block as the page renders it, in DOM order.
 * @returns {Promise<Array<{qid:string, label:string, section:string, selector:string,
 *                          multiple:boolean, control:string, value:string}>>}
 */
export async function eeoControls(page) {
  return page.evaluate(
    ({ ids, sectionSrc }) => {
      const sectionRe = new RegExp(sectionSrc, "i");
      const norm = (s) => String(s ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
      const esc = (id) => (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id) ? `#${id}` : `[id="${id}"]`);
      const form = document.querySelector("form#application-form") ?? document.querySelector("form") ?? document;
      // Headings from inside the form only: the job description above it has its own
      // "Equal Opportunity" block, and the nearest-preceding-heading rule would hand that title
      // to the form's first inputs.
      const inForm = [...form.querySelectorAll("h1, h2, h3, h4, legend")];
      const headings = (inForm.length ? inForm : [...document.querySelectorAll("h1, h2, h3, h4, legend")]).map((h) => ({
        node: h,
        text: norm(h.textContent),
      }));
      const sectionOf = (el) => {
        let best = "";
        for (const h of headings) {
          if (h.node.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = h.text;
        }
        return best;
      };
      const rows = [];
      for (const el of form.querySelectorAll("input.select__input, select")) {
        const id = el.id || "";
        const section = sectionOf(el);
        if (!ids.includes(id) && !sectionRe.test(section)) continue;
        const shell = el.closest(".select-shell") ?? el.closest(".select__control")?.parentElement ?? el.parentElement;
        const label = norm(
          (id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : null) ??
            shell?.querySelector("label")?.textContent ??
            el.getAttribute("aria-label") ??
            "",
        ).replace(/\s*\*$/, "");
        const chips = [...(shell?.querySelectorAll(".select__multi-value__label") ?? [])].map((c) => norm(c.textContent));
        rows.push({
          qid: id || label,
          label,
          section,
          selector: id ? esc(id) : "",
          multiple: Boolean(el.closest("[class*='--is-multi']")) || chips.length > 0,
          control: el.tagName === "SELECT" ? "native_select" : "react_select",
          value: chips.length ? chips.join(" | ") : norm(shell?.querySelector(".select__single-value")?.textContent ?? el.value ?? ""),
        });
      }
      return rows.filter((r) => r.selector);
    },
    { ids: [...EEO_IDS], sectionSrc: EEO_SECTION_RE.source },
  );
}

// ─── submit ───────────────────────────────────────────────────────────────────────────────────
//
// The hosted board's button is `#submit_app` inside `form#application-form`, and a confirmed
// application lands on `…/jobs/<id>/confirmation` with an `#application_confirmation` block that
// reads "Thank you for applying". All three are checked, strongest signal first, because the
// board has shipped each of them alone: an in-place confirmation (no navigation) on some tokens,
// a redirect on others.
//
// The click itself, the waiting and the failure rules belong to `submitApplication`
// (src/plan/execute.mjs); this file contributes a selector list and two regexes.

export const CONFIRMATION = {
  strategy: "url /confirmation · #application_confirmation · thank-you text",
  url: /\/confirmation(?:[/?#]|$)/i,
  text: /thank you for applying|application has been submitted|received your application/i,
  selectors: ["#application_confirmation", "[data-react-class*='ApplicationConfirmation']"],
  formGone: false,
};

const SUBMIT_SELECTORS = ["#submit_app", "form#application-form button[type=submit]", "form#application-form input[type=submit]"];
const SUBMIT_TEXT = /submit application/i;

/** The board's Submit control, or null. Never clicks — `--detect-submit` calls exactly this. */
export async function findSubmit(page) {
  return generic.findSubmit(page, {
    selectors: SUBMIT_SELECTORS,
    text: SUBMIT_TEXT,
    scopes: ["form#application-form", "form"],
  });
}

export async function confirmSubmitted(page, opts = {}) {
  const signals = opts.signals ?? (await generic.readSignals(page, { selectors: CONFIRMATION.selectors }));
  return { ...generic.matchConfirmation(signals, CONFIRMATION), signals };
}
