// The browser half of a repeating Education / Employment section (src/plan/repeat.mjs plans it).
//
// Two jobs, both done when the fill loop asks for a row's selector:
//
//   1. Make entry N exist. Each board renders one empty entry and an add button — Greenhouse's
//      "Add another", Ashby's "+ Add Education" — and entry N's boxes are not in the DOM until the
//      button has been clicked N times. The button is found inside the section and by its own
//      words; Ashby renders it `type="submit"`, so `guardNoSubmit` cannot be the check here, and
//      the text test below is stricter than it: only a button that says "add" is ever clicked.
//   2. Find the box. Greenhouse numbers its ids (`#school--1`) and those are used as they are.
//      Ashby repeats the *same* ids on every card, and an Employment section has not been seen
//      live on either board, so everywhere else a box is found by its label inside entry N and
//      tagged `data-jev-repeat` — a selector the rest of the pipeline can use like any other.
//
// Nothing here decides a value. A section or a box that is not on the page resolves to a selector
// that matches nothing, which the fill loop already turns into an `ask` with a screenshot.

import { pace, sleep } from "./readback.mjs";

const ADD_RE = /^\s*\+?\s*add\b/i;
const NOT_ADD_RE = /submit|apply|delete|remove/i;
const ENTRY_WAIT_MS = 5000;

/** The label a history entry is anchored by: one per entry, in every layout seen. */
const ANCHOR = {
  education: "\\b(school|university|institution|college)\\b",
  employment: "\\b(company|employer|organi[sz]ation)\\b",
};

/** Label words per part. Dates are matched by edge here and split into month/year in the page. */
const PART_WORDS = {
  school: "\\b(school|university|institution|college)\\b",
  degree: "\\b(degree|qualification)\\b",
  field: "\\b(discipline|field of study|major|subject|area of study|field)\\b",
  employer: "\\b(company|employer|organi[sz]ation)\\b",
  title: "\\b(title|position|role)\\b",
  start: "\\b(start|from|began)\\b",
  end: "\\b(end|until|to|finish)\\b",
  current: "\\b(current|currently|still|present|ongoing)\\b",
};

const missingSelector = (question) => `[data-jev-repeat="missing:${cssSafe(question.qid)}"]`;
const cssSafe = (s) => String(s).replace(/[^A-Za-z0-9_.[\]-]/g, "_");

/**
 * The selector for one box of entry `question.repeat.index`, after making that entry exist.
 * @returns {Promise<string>}
 */
export async function resolveHistorySelector(page, question) {
  const r = question.repeat;
  const container = r.container;
  if (!container || !(await page.locator(container).count().catch(() => 0))) return missingSelector(question);

  const ready = await ensureEntries(page, container, r.kind, r.index + 1);
  if (!ready) return missingSelector(question);

  if (r.dom_id && (await page.locator(`#${r.dom_id}`).count().catch(() => 0))) return `#${r.dom_id}`;

  const tag = cssSafe(question.qid);
  const found = await page
    .evaluate(locatePart, { container, anchor: ANCHOR[r.kind], index: r.index, part: r.part, words: PART_WORDS, tag })
    .catch(() => false);
  return found ? `[data-jev-repeat="${tag}"]` : missingSelector(question);
}

/** How many entries the section shows now: one anchor label per entry. */
async function entryCount(page, container, kind) {
  return page
    .evaluate(
      ({ container, anchor }) => {
        const root = document.querySelector(container);
        if (!root) return 0;
        const re = new RegExp(anchor, "i");
        return [...root.querySelectorAll("label")].filter((l) => re.test(l.textContent ?? "")).length;
      },
      { container, anchor: ANCHOR[kind] },
    )
    .catch(() => 0);
}

/**
 * Click the section's add button until it shows `want` entries. One click per missing entry, each
 * waited on: a click that does not produce an entry stops the loop rather than being repeated.
 */
async function ensureEntries(page, container, kind, want) {
  let have = await entryCount(page, container, kind);
  while (have < want) {
    const buttons = page.locator(`${container} button`);
    const n = await buttons.count().catch(() => 0);
    let button = null;
    for (let i = 0; i < n; i++) {
      const text = String((await buttons.nth(i).innerText().catch(() => "")) ?? "");
      if (ADD_RE.test(text) && !NOT_ADD_RE.test(text)) button = buttons.nth(i);
    }
    // Greenhouse puts "Add another" beside the container on some layouts: one level up, same test.
    if (!button) {
      const outer = page.locator(`${container} >> xpath=..`).locator("button");
      const m = await outer.count().catch(() => 0);
      for (let i = 0; i < m; i++) {
        const text = String((await outer.nth(i).innerText().catch(() => "")) ?? "");
        if (ADD_RE.test(text) && !NOT_ADD_RE.test(text)) button = outer.nth(i);
      }
    }
    if (!button) return false;
    await pace(page, button);
    await button.click({ timeout: 5000 }).catch(() => {});
    const started = Date.now();
    let now = have;
    while (now <= have && Date.now() - started < ENTRY_WAIT_MS) {
      await sleep(150);
      now = await entryCount(page, container, kind);
    }
    if (now <= have) return false;
    have = now;
  }
  return true;
}

/**
 * In-page: find `part` inside entry `index` of the section and tag it. Entry N is the largest
 * subtree around the N-th anchor label that holds no other anchor — true of Greenhouse's row
 * `div`s and Ashby's cards alike, and of any layout that keeps an entry's boxes together.
 */
function locatePart({ container, anchor, index, part, words, tag }) {
  const root = document.querySelector(container);
  if (!root) return false;
  const anchorRe = new RegExp(anchor, "i");
  const anchors = [...root.querySelectorAll("label")].filter((l) => anchorRe.test(l.textContent ?? ""));
  const start = anchors[index];
  if (!start) return false;
  const holds = (el) => anchors.filter((a) => el.contains(a)).length;
  let entry = start;
  while (entry.parentElement && entry.parentElement !== root && holds(entry.parentElement) === 1) entry = entry.parentElement;

  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const labels = [...entry.querySelectorAll("label")].filter((l) => clean(l.textContent));
  const labelOf = (el) => {
    if (el.id) {
      const tied = entry.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (tied && clean(tied.textContent)) return clean(tied.textContent);
    }
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => entry.querySelector(`#${CSS.escape(id)}`)?.textContent ?? "")
        .join(" ");
      if (clean(text)) return clean(text);
    }
    const wrap = el.closest("label");
    if (wrap && entry.contains(wrap) && clean(wrap.textContent)) return clean(wrap.textContent);
    let before = null;
    for (const l of labels) if (l.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) before = l;
    return clean(before?.textContent);
  };
  const controls = [...entry.querySelectorAll("input, select, textarea")]
    .filter((el) => !["hidden", "file", "submit", "button"].includes(String(el.type).toLowerCase()))
    .map((el) => ({ el, label: labelOf(el) }));

  const re = (key) => new RegExp(words[key], "i");
  const dated = /^(start|end)_(month|year)$/.exec(part);
  let pick = null;
  if (part === "current") {
    pick = controls.find((c) => c.el.type === "checkbox" && re("current").test(c.label));
  } else if (dated) {
    const [, edge, unit] = dated;
    const other = edge === "start" ? "end" : "start";
    const pool = controls.filter((c) => c.el.type !== "checkbox" && re(edge).test(c.label) && !re(other).test(c.label));
    const unitOf = (c) => {
      if (/\bmonth\b/i.test(c.label)) return "month";
      if (/\byear\b/i.test(c.label)) return "year";
      if (c.el.tagName === "SELECT") {
        const first = clean(c.el.options?.[0]?.textContent);
        if (/month/i.test(first)) return "month";
        if (/year/i.test(first)) return "year";
      }
      if (c.el.type === "number") return "year";
      return null;
    };
    pick = pool.find((c) => unitOf(c) === unit) ?? (pool.length === 2 && pool.every((c) => unitOf(c) === null) ? pool[unit === "month" ? 0 : 1] : null);
  } else {
    // A date box is never a name box, whatever else its label says ("Start date of this role").
    const fits = controls.filter((c) => c.el.type !== "checkbox" && re(part).test(c.label) && !re("start").test(c.label) && !re("end").test(c.label));
    pick = fits.length === 1 ? fits[0] : null;
  }
  if (!pick) return false;
  for (const old of document.querySelectorAll(`[data-jev-repeat="${CSS.escape(tag)}"]`)) old.removeAttribute("data-jev-repeat");
  pick.el.setAttribute("data-jev-repeat", tag);
  return true;
}
