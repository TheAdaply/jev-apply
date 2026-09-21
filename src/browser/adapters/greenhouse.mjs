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
  digits,
  guardNoSubmit,
  labelsOf,
  moveMouseTo,
  norm,
  normLabel,
  pace,
  pickOption,
  asYesNo,
  sleep,
  textOf,
  valueOf,
  waitUntil,
} from "../readback.mjs";
import { captureFailure, fieldEvent, tracer } from "../trace.mjs";

export const id = "greenhouse";

const OPTION_WAIT_MS = 3000;

const fieldSelector = (question) => question?.selector || byId(question?.qid ?? "");

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

async function setReactSelect(page, question, value, selector) {
  const input = page.locator(selector).first();
  await input.waitFor({ state: "attached", timeout: 10000 });
  const shell = await selectShell(input);
  const control = (await firstPresent(shell.locator(".select__control"))) ?? input;
  const inputId = (await input.getAttribute("id")) ?? question?.qid ?? "";
  // The listbox id is stable whether react-select renders inline or into the portal.
  const optionSelector = inputId
    ? `[id="react-select-${inputId}-listbox"] [role="option"], #react-portal-mount-point [role="option"]`
    : '#react-portal-mount-point [role="option"]';

  const want = wantedLabel(question, value);
  const searchKey = norm(want).slice(0, 24);
  const options = page.locator(optionSelector);
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

  const result = await attemptSet({
    settleMs: 350,
    set: async () => {
      reason = null;
      await control.click({ timeout: 5000 });
      // react-select resets its own filter text on blur, so there is nothing to clear here.
      if (searchKey) await input.pressSequentially(searchKey, { delay: 35 });
      await options.first().waitFor({ state: "visible", timeout: OPTION_WAIT_MS }).catch(() => {});
      const labels = (await options.allTextContents()).map(norm).filter(Boolean);
      if (!labels.length) {
        reason = "no_options_rendered";
        await dismiss();
        return;
      }
      const pick = pickOption(labels, want);
      if (!pick) {
        // Never index 0: an unmatched value leaves the control exactly as it was.
        reason = `no_matching_option (${labels.length} shown)`;
        await dismiss();
        return;
      }
      const target = options.nth(pick.index);
      await guardNoSubmit(target);
      await moveMouseTo(page, target);
      await target.click({ timeout: 5000 });
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

  return reason && !result.ok ? { ...result, reason } : result;
}

// ------------------------------------------------------------------------------ native select

async function setNativeSelect(page, question, value, selector) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: 10000 });
  await pace(page, loc);
  const want = wantedLabel(question, value);
  const labels = (await loc.locator("option").allTextContents()).map(norm);
  const pick = pickOption(labels, want);
  if (!pick) return { ok: false, observed: norm(await loc.inputValue().catch(() => "")), attempts: 1, reason: "no_matching_option" };
  return attemptSet({
    set: async () => {
      await loc.selectOption({ label: labels[pick.index] });
    },
    read: async () => norm(await loc.locator("option:checked").first().textContent().catch(() => "")),
    ok: (observed) => matchesWanted(observed, want),
  });
}

// --------------------------------------------------------------------------- radio / checkbox

/** Candidate ways to reach a radio group, most specific first. */
function radioSelectors(question, selector) {
  const name = String(question?.name ?? question?.qid ?? "").replace(/(["\\])/g, "\\$1");
  return [
    `${selector} input[type="radio"]`,
    name ? `input[type="radio"][name="${name}"]` : null,
    name ? `input[type="radio"][id^="${name}"]` : null,
  ].filter(Boolean);
}

async function setRadio(page, question, value, selector) {
  let radios = null;
  for (const sel of radioSelectors(question, selector)) {
    const loc = page.locator(sel);
    if (await loc.count()) {
      radios = loc;
      break;
    }
  }
  if (!radios) return { ok: false, observed: "", attempts: 1, reason: "radio_group_not_found" };

  const meta = await labelsOf(radios);
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

  const target = radios.nth(pick.index);
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

/**
 * One checkbox is a Boolean; several are a multi-select (Greenhouse renders those as a
 * `fieldset.checkbox` of `input[name="question_<id>[]"]`, so the FormPlan selector matches the
 * whole group). A group is answered by label — checking `.first()` would be an option-0 guess.
 */
async function setCheckbox(page, question, value, selector) {
  const boxes = page.locator(selector);
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

  const loc = boxes.first();
  await loc.waitFor({ state: "attached", timeout: 10000 });
  const yn = asYesNo(value);
  if (!yn) return { ok: false, observed: "", attempts: 1, reason: `not_boolean: ${norm(value).slice(0, 40)}` };
  await pace(page, loc);
  return attemptSet({
    set: async () => {
      if (yn === "yes") await loc.check({ timeout: 5000, force: true });
      else await loc.uncheck({ timeout: 5000, force: true });
    },
    read: async () => ((await loc.isChecked().catch(() => false)) ? "yes" : "no"),
    ok: (observed) => observed === yn,
  });
}

// --------------------------------------------------------------------------------------- tel

/**
 * Explicit country only (ISO-2 or the country's own name): a phone country is a personal fact.
 * Best effort by design — some Greenhouse forms hide intl-tel-input's picker entirely and drive
 * the country from a separate `#country` select, so this reports rather than throws.
 */
export async function setPhoneCountry(page, iti, country) {
  const button = iti.locator("button.iti__selected-country").first();
  if (!(await button.count())) return { ok: false, observed: "", attempts: 1, reason: "no_country_picker" };
  if (!(await button.isVisible().catch(() => false))) {
    return { ok: false, observed: "", attempts: 1, reason: "country_picker_hidden" };
  }
  try {
    await pace(page, button);
    await button.click({ timeout: 5000 });

    const iso = normLabel(country);
    let target = iti.locator(`.iti__country-list li[data-country-code="${iso}"]`);
    if (!(await target.count())) {
      const search = page.locator("input.iti__search-input").first();
      if (await search.count()) await search.pressSequentially(String(country), { delay: 30 });
      const items = iti.locator('.iti__country-list [role="option"]');
      await items.first().waitFor({ state: "visible", timeout: OPTION_WAIT_MS }).catch(() => {});
      const names = (await items.locator(".iti__country-name").allTextContents()).map(norm);
      const pick = pickOption(names, country);
      if (!pick) {
        await button.blur().catch(() => {});
        return { ok: false, observed: "", attempts: 1, reason: "no_matching_country" };
      }
      target = items.nth(pick.index);
    }
    const chosen = target.first();
    const code = normLabel((await chosen.getAttribute("data-country-code")) ?? "");
    const name = norm(await chosen.locator(".iti__country-name").first().textContent().catch(() => ""));
    await guardNoSubmit(chosen);
    await chosen.click({ timeout: 5000 });
    const title = norm((await button.getAttribute("title")) ?? "");
    const observed = title || name;
    // A phone country is a personal fact: the committed country must be the requested one.
    const iso2 = normLabel(country);
    const ok =
      (code !== "" && code === iso2) ||
      (name !== "" && (normLabel(name) === iso2 || pickOption([name], country) !== null)) ||
      (title !== "" && normLabel(title).startsWith(normLabel(name || country)));
    return { ok, observed, attempts: 1, ...(ok ? {} : { reason: `committed ${JSON.stringify(observed)}` }) };
  } catch (err) {
    return { ok: false, observed: "", attempts: 1, reason: `error: ${String(err.message).split("\n")[0].slice(0, 100)}` };
  }
}

async function setPhone(page, question, value, selector) {
  const input = page.locator(selector).first();
  await input.waitFor({ state: "visible", timeout: 10000 });
  const iti = await firstPresent(input.locator('xpath=ancestor::div[contains(@class,"iti")][1]'));
  // A country hint must never block the number itself.
  const country = iti && question?.country ? await setPhoneCountry(page, iti, question.country) : null;
  await pace(page, input);
  const want = String(value ?? "");
  const wantDigits = digits(want);
  const result = await attemptSet({
    set: async () => {
      await input.click({ timeout: 5000 }).catch(() => {});
      await input.fill(want);
      await input.blur().catch(() => {});
    },
    read: () => valueOf(input),
    // intl-tel-input reformats and may absorb the dial code (≤3 digits) into the flag; anything
    // shorter than that is a truncated write, not a reformat.
    ok: (observed) => {
      const seen = digits(observed);
      if (seen === "") return false;
      return seen === wantDigits || (wantDigits.endsWith(seen) && wantDigits.length - seen.length <= 3);
    },
  });
  if (country) result.country = country.ok ? country.observed : (country.reason ?? "unset");
  return result;
}

// ------------------------------------------------------------------------------------ public

export async function setField(page, question, value, { trace } = {}) {
  const log = tracer(trace);
  const selector = fieldSelector(question);
  const control = question?.control ?? "text";
  let result;
  try {
    if (control === "file") throw new Error("file controls go through uploadFile()");
    const fn =
      {
        react_select: setReactSelect,
        native_select: setNativeSelect,
        radio: setRadio,
        checkbox: setCheckbox,
        tel: setPhone,
      }[control] ?? setText;
    result = await fn(page, question, value, selector);
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
  await log(fieldEvent({ op: "upload", question, value: base, result }));
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
