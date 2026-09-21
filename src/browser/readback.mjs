// Shared DOM primitives for the ATS adapters: label normalisation, option picking that can
// never land on option 0 (PLAN risk 6), human cadence (PLAN risk 1: 150–400 ms with a real
// mouse move before each field), and the set → read-back → retry loop every write goes through.

/** Collapse NBSP / zero-width / runs of whitespace. */
export function norm(s) {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Comparison form for option labels and field labels: no required marker, case-folded. */
export function normLabel(s) {
  return norm(s).replace(/\s*\*$/, "").toLowerCase();
}

export function sameLabel(a, b) {
  return normLabel(a) === normLabel(b) && normLabel(a) !== "";
}

/** `#id` when the id is a valid CSS identifier, `[id="…"]` otherwise (Ashby ids start with a digit). */
export function byId(id) {
  const s = String(id ?? "");
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(s) ? `#${s}` : `[id="${s.replace(/(["\\])/g, "\\$1")}"]`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PLAN risk 1: 150–400 ms between fields, never a fixed interval. */
export function cadenceMs(min = 150, max = 400) {
  return Math.round(min + Math.random() * (max - min));
}

/** Real pointer movement to the element (score-based captcha looks at this), best effort. */
export async function moveMouseTo(page, locator, { steps = 6 } = {}) {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    const box = await locator.boundingBox({ timeout: 2000 });
    if (!box || box.width < 1 || box.height < 1) return false;
    const x = box.x + box.width * (0.25 + Math.random() * 0.5);
    const y = box.y + box.height * (0.25 + Math.random() * 0.5);
    await page.mouse.move(x, y, { steps });
    return true;
  } catch {
    return false;
  }
}

/** Mouse move + human pause; call once per field before touching it. */
export async function pace(page, locator) {
  const moved = locator ? await moveMouseTo(page, locator) : false;
  await sleep(cadenceMs());
  return moved;
}

/**
 * Pick the option matching `value` among rendered labels.
 * Exact → unique prefix (either direction, so "No" finds "No, I do not …") → unique substring.
 * Ambiguous or absent returns null: the caller must fail, never fall back to index 0.
 */
export function pickOption(labels, value) {
  const want = normLabel(value);
  if (!want) return null;
  const n = labels.map(normLabel);

  // Ashby's location autocomplete can return the same text under two option ids, so "ambiguous"
  // means *different* labels; identical ones collapse to the first.
  const one = (candidates, match) => {
    if (!candidates.length) return null;
    const [label, index] = candidates[0];
    if (!candidates.every(([l]) => l === label)) return null;
    return { index, label: labels[index], match };
  };

  const exact = n.indexOf(want);
  if (exact >= 0) return { index: exact, label: labels[exact], match: "exact" };

  const indexed = n.map((l, i) => [l, i]);
  // Substring is the last resort and must land on a word boundary: "no" occurs inside
  // "sponsorship now" in the *Yes* option of the live visa question (PLAN risk 6).
  const bounded = new RegExp(`(^|\\W)${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\W|$)`);
  return (
    one(indexed.filter(([l]) => l && (l.startsWith(want) || want.startsWith(l))), "prefix") ??
    one(indexed.filter(([l]) => l && bounded.test(l)), "substring")
  );
}

/** Map a boolean-ish answer onto yes/no. Anything else is unknown — never guessed. */
export function asYesNo(value) {
  const v = normLabel(value);
  if (["yes", "y", "true", "1", "agree", "i agree", "checked"].includes(v)) return "yes";
  if (["no", "n", "false", "0", "disagree", "unchecked"].includes(v)) return "no";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return null;
}

/** The runner never clicks Submit (AGENTS invariant); this is the last line of defence. */
export async function guardNoSubmit(locator) {
  const info = await locator.evaluate((el) => ({
    tag: el.tagName,
    type: (el.getAttribute("type") || "").toLowerCase(),
    text: (el.textContent || "").trim().slice(0, 60),
  }));
  const submitish = /^(submit|submit application|apply now|send application)$/i.test(info.text.trim());
  if ((info.tag === "BUTTON" || info.tag === "INPUT") && (info.type === "submit" || submitish)) {
    throw new Error(`refusing to click a submit control: <${info.tag.toLowerCase()}> "${info.text}"`);
  }
}

/**
 * Run `set`, wait for the page to settle, `read` the control back, decide with `ok`.
 * Two attempts (PLAN §2.2 step 11 stop rule); returns the last observation either way.
 */
export async function attemptSet({ attempts = 2, set, read, ok, settleMs = 250, onFail }) {
  let observed = "";
  let n = 0;
  let lastError = null;
  while (n < attempts) {
    n += 1;
    try {
      await set(n);
      await sleep(settleMs);
      observed = await read();
      if (await ok(observed)) return { ok: true, observed, attempts: n };
      lastError = null;
    } catch (err) {
      lastError = err;
      observed = observed || "";
    }
    if (onFail) await onFail(n).catch(() => {});
    if (n < attempts) await sleep(cadenceMs());
  }
  return {
    ok: false,
    observed,
    attempts: n,
    ...(lastError ? { reason: `error: ${lastError.message.split("\n")[0].slice(0, 120)}` } : {}),
  };
}

/**
 * Poll `read` until `ok` or the deadline; returns the last observation either way.
 * Uploads need this: the ATS accepts the file first and renders its name a beat later.
 */
export async function waitUntil({ read, ok, timeout = 10000, every = 250 }) {
  const deadline = Date.now() + timeout;
  let observed = await read();
  while (!(await ok(observed))) {
    if (Date.now() >= deadline) break;
    await sleep(every);
    observed = await read();
  }
  return observed;
}

/** Text content of the first match, normalised; "" when absent. */
export async function textOf(locator, { timeout = 2000 } = {}) {
  try {
    return norm(await locator.first().textContent({ timeout }));
  } catch {
    return "";
  }
}

/** `input.value` of the first match; "" when absent. */
export async function valueOf(locator, { timeout = 2000 } = {}) {
  try {
    return norm(await locator.first().inputValue({ timeout }));
  } catch {
    return "";
  }
}

/**
 * Ids + visible labels for a group of radios/checkboxes, in DOM order, so a group is answered by
 * label and never by position. Ashby regenerates the group's `name` prefix per render, so the
 * label is the only stable key.
 */
export async function labelsOf(locator) {
  return locator.evaluateAll((els) =>
    els.map((el) => ({
      id: el.id || "",
      value: el.getAttribute("value") || "",
      label: (
        (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : "") ||
        el.closest("label")?.textContent ||
        el.getAttribute("aria-label") ||
        ""
      ).trim(),
    })),
  );
}

/** Digits only — phone widgets reformat what you type ("+1 415-555-0123"). */
export const digits = (s) => String(s ?? "").replace(/\D+/g, "");
