// A form's repeating Education / Employment section → one ordinary FormPlan row per box per entry.
//
// Both boards model the section as *one* field that grows: Greenhouse's hosted page renders an
// "Education" block of School · Degree · Discipline · dates with an "Add another" button (its
// `education_config`, which the public API does not carry), and Ashby's `EducationHistoryField` /
// `WorkHistoryField` is a card per entry with a "+ Add Education" button. `src/schema/*` reads that
// field as one `type: "repeater"` row carrying which parts the form shows and requires; this module
// expands it against the user's own history (`educationHistory()`/`employmentHistory()`,
// src/memory/derive.mjs) into rows like `education[1].school` — so the resolver, the option ladder,
// read-back, preflight and the summary treat every box exactly like any other field. The one thing
// the browser has to do differently is make entry N exist before its boxes are filled, which
// `src/browser/repeat.mjs` does at selector-resolution time.
//
// What each box gets is read off one entry and nothing else. A part the entry does not state is
// asked when the form requires it and left blank when it does not; a Greenhouse Degree list offers
// ten fixed buckets, so "B.Tech" is placed in "Bachelor's Degree" by a fixed table — never by a
// nearest match — and a degree the table cannot place is asked with the form's own list.

import { educationHistory, employmentHistory } from "../memory/derive.mjs";

export const MONTHS = Object.freeze([
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]);

/** The parts, in the order a form lays them out, per kind. `current` is the "still here" box. */
const ORDER = Object.freeze({
  education: ["school", "degree", "field", "start_month", "start_year", "end_month", "end_year", "current"],
  employment: ["employer", "title", "start_month", "start_year", "end_month", "end_year", "current"],
});

const PART_LABEL = Object.freeze({
  school: "School",
  degree: "Degree",
  field: "Field of study",
  employer: "Company",
  title: "Title",
  start_month: "Start month",
  start_year: "Start year",
  end_month: "End month",
  end_year: "End year",
  current: "Current",
});

/**
 * Greenhouse's Degree list, read live off five hosted boards on 2026-09-24 (it is the same list on
 * every board: the product's own, not the company's). The table below places a written degree in
 * one of these; the live menu is still what the option ladder commits against.
 */
export const GREENHOUSE_DEGREES = Object.freeze([
  "Associate's Degree",
  "Bachelor's Degree",
  "Doctor of Medicine (M.D.)",
  "Doctor of Philosophy (Ph.D.)",
  "Engineer's Degree",
  "High School",
  "Juris Doctor (J.D.)",
  "Master of Business Administration (M.B.A.)",
  "Master's Degree",
  "Other",
]);

// Most specific first: an MBA is a master's, and "Doctor of Medicine" is not a Ph.D.
const DEGREE_BUCKETS = [
  [/\b(ph\.?\s?d|d\.?\s?phil|doctor of philosophy|doctorate)\b/i, "Doctor of Philosophy (Ph.D.)"],
  [/\b(m\.?\s?b\.?\s?a|master of business administration)\b/i, "Master of Business Administration (M.B.A.)"],
  [/\b(j\.?\s?d|juris doctor)\b/i, "Juris Doctor (J.D.)"],
  [/\b(m\.?\s?d|doctor of medicine|m\.?\s?b\.?\s?b\.?\s?s)\b/i, "Doctor of Medicine (M.D.)"],
  [/\b(engineer'?s degree|diplom[- ]ingenieur|dipl\.?[- ]ing)\b/i, "Engineer's Degree"],
  [
    /\b(master'?s?|m\.?\s?s\.?c?|m\.?\s?tech|m\.?\s?eng|m\.?\s?e|m\.?\s?a|m\.?\s?phil|m\.?\s?com|mca|ll\.?\s?m|m\.?\s?res|m\.?\s?f\.?\s?a|m\.?\s?p\.?\s?h)(?=[\s,.()]|$)/i,
    "Master's Degree",
  ],
  [
    /\b(bachelor'?s?|b\.?\s?s\.?c?|b\.?\s?tech|b\.?\s?eng|b\.?\s?e|b\.?\s?a|a\.?\s?b|b\.?\s?com|bca|ll\.?\s?b|b\.?\s?b\.?\s?a|b\.?\s?f\.?\s?a|b\.?\s?arch)(?=[\s,.()]|$)/i,
    "Bachelor's Degree",
  ],
  [/\bassociate'?s?\b/i, "Associate's Degree"],
];

/** A written degree → Greenhouse's bucket for it, or null when the table cannot place it. */
export function degreeBucket(written) {
  const text = String(written ?? "").trim();
  if (!text) return null;
  for (const [re, bucket] of DEGREE_BUCKETS) if (re.test(text)) return bucket;
  return null;
}

/** "2016-08" · "2016" · "08/2016" · "Aug 2016" · "August 2016" → `{year, month|null}`, else null. */
export function parseWhen(text) {
  const s = String(text ?? "").trim();
  let m = /^((?:19|20)\d{2})(?:-(0?[1-9]|1[0-2]))?(?:-\d{1,2})?$/.exec(s);
  if (m) return { year: m[1], month: m[2] ? Number(m[2]) : null };
  m = /^(0?[1-9]|1[0-2])\s*[/.-]\s*((?:19|20)\d{2})$/.exec(s);
  if (m) return { year: m[2], month: Number(m[1]) };
  m = /^([A-Za-z]{3,9})\.?\s+((?:19|20)\d{2})$/.exec(s);
  if (m) {
    const month = MONTHS.findIndex((name) => name.slice(0, 3).toLowerCase() === m[1].slice(0, 3).toLowerCase()) + 1;
    return month > 0 ? { year: m[2], month } : null;
  }
  return null;
}

const historyOf = (kind, mem, now) => (kind === "education" ? educationHistory(mem, now) : employmentHistory(mem, now));

/** "Bachelor of Technology, IIT Patna" — how an entry is named in labels and questions. */
function entryName(kind, entry) {
  if (!entry) return kind === "education" ? "your most recent degree" : "your most recent role";
  const [a, b] = kind === "education" ? [entry.degree, entry.school] : [entry.title, entry.employer];
  return [a, b].filter(Boolean).join(", ") || entry.id;
}

/** The value one part of one entry carries, before any board-specific shaping; null when unstated. */
function partValue(part, entry) {
  if (!entry) return null;
  if (part === "current") return entry.current ? "Yes" : null;
  const date = /^start_/.test(part) ? entry.start : /^end_/.test(part) ? entry.end : undefined;
  if (date !== undefined) {
    const when = parseWhen(date);
    if (!when) return null;
    if (/_year$/.test(part)) return when.year;
    return when.month ? MONTHS[when.month - 1] : null;
  }
  return entry[part] ?? null;
}

/** Which of the entry's own words a part came from — the added part, or the résumé's row. */
const partSource = (part, entry) => {
  const base = /^(start|end)_/.test(part) ? part.split("_")[0] : part;
  return entry?.added?.includes(base) ? `${entry.id}.${base}` : entry?.id ?? null;
};

/** Where an answer to a missing part is kept: beside the entry, never over the résumé's row. */
function companionId(part, entry) {
  if (!entry || /^f\.(education|employment)\.(school|field|degree|current|current_title)$/.test(entry.id)) return null;
  const base = /^(start|end)_/.test(part) ? part.split("_")[0] : part;
  return part === "current" ? null : `${entry.id}.${base}`;
}

/** How a board renders one part: the planned `type`/`control` (detection corrects it live). */
function shapeOf(ats, part) {
  const dated = /_(month|year)$/.test(part);
  if (part === "current") return { type: "boolean", control: "checkbox" };
  if (ats === "greenhouse") {
    if (/_year$/.test(part)) return { type: "number", control: "number" };
    return { type: "single_select", control: "react_select" };
  }
  if (ats === "ashby") {
    if (dated) return { type: "single_select", control: "native_select" };
    if (part === "school") return { type: "single_select", control: "react_select" };
    return { type: "text", control: "text" };
  }
  return { type: "text", control: "text" };
}

/**
 * Replace every `type: "repeater"` row of a FormPlan with the rows its entries need. Mutates and
 * returns the plan. Idempotent: a plan that has been expanded carries no repeater rows to expand.
 *
 * An entry is added to the form only when every part the form *requires* can be answered — or when
 * the section itself is required, in which case the missing part is asked. An optional section
 * never grows a card the user then has to finish by hand: an entry it cannot complete is listed
 * under NOT FILLED instead, with the part that stopped it.
 */
export function expandRepeaters(formPlan, mem, { now = new Date() } = {}) {
  const questions = formPlan?.questions ?? [];
  if (!questions.some((q) => q?.type === "repeater" && !q.repeat?.of)) return formPlan;
  const ats = formPlan.ats ?? null;
  const out = [];
  for (const q of questions) {
    if (q?.type !== "repeater" || q.repeat?.of) {
      out.push(q);
      continue;
    }
    const { kind, parts = {} } = q.repeat ?? {};
    const shown = ORDER[kind]?.filter((part) => parts[part] && parts[part] !== "hidden") ?? [];
    const max = Number.isInteger(q.repeat?.max) && q.repeat.max > 0 ? q.repeat.max : Infinity;
    const min = Math.max(q.required ? 1 : 0, Number.isInteger(q.repeat?.min) ? q.repeat.min : 0);
    const entries = historyOf(kind, mem, now).slice(0, max);

    if (!entries.length && min === 0) {
      // Nothing on file for an optional section: the row stays, so the summary says so.
      out.push({ ...q, repeat: { ...q.repeat, of: q.qid, empty: true } });
      continue;
    }
    const list = [...entries, ...Array(Math.max(0, min - entries.length)).fill(null)];
    let index = 0;
    list.forEach((entry, n) => {
      const applicable = shown.filter((part) => !(entry?.current && shown.includes("current") && /^end_/.test(part)));
      const missing = applicable.filter((part) => parts[part] === "required" && partValue(part, entry) == null);
      if (entry && missing.length && n >= min) {
        out.push({
          ...q,
          qid: `${q.qid}[${n}]`,
          label: `${kind} ${n + 1} — ${q.label}: ${entryName(kind, entry)}`,
          required: false,
          repeat: { ...q.repeat, of: q.qid, entry: entry.id, dropped: missing.map((p) => PART_LABEL[p].toLowerCase()) },
        });
        return;
      }
      for (const part of applicable) {
        if (part === "current" && !entry?.current) continue; // the box stays unticked
        out.push(partRow(q, { ats, kind, part, index, entry, required: parts[part] === "required" || (!entry && n < min), optional: n >= min }));
      }
      index += 1;
    });
  }
  formPlan.questions = out;
  return formPlan;
}

function partRow(q, { ats, kind, part, index, entry, required, optional }) {
  const ids = q.repeat?.ids ?? null;
  const domId = ids?.[part] ? `${ids[part]}--${index}` : null;
  const options = ats === "greenhouse" && kind === "education" && part === "degree" ? GREENHOUSE_DEGREES : null;
  return {
    qid: `${q.qid}[${index}].${part}`,
    label: `${kind} ${index + 1} — ${PART_LABEL[part]}: ${entryName(kind, entry)}`,
    required,
    section: q.section ?? null,
    ...shapeOf(ats, part),
    // Greenhouse numbers each row's controls (`#school--1`), so a known part has a stable id. Any
    // other part is found by its label inside entry N at fill time, and tagged there.
    selector: domId ? `#${domId}` : null,
    ...(options ? { options: options.map((label) => ({ label, value: label })) } : {}),
    class: "identity",
    repeat: {
      of: q.qid,
      kind,
      index,
      part,
      entry: entry?.id ?? null,
      optional,
      required_parts: Object.keys(q.repeat.parts ?? {}).filter((part) => q.repeat.parts[part] === "required"),
      container: q.repeat?.container ?? q.selector ?? null,
      ...(domId ? { dom_id: domId } : {}),
      // Greenhouse's School list is a fixed catalogue with its own "Other" entry: a school the
      // catalogue does not carry is that entry, flagged for review — never a similar-looking name.
      ...(ats === "greenhouse" && part === "school" ? { fallback: "Other" } : {}),
    },
  };
}

/**
 * The Decision fields for one expanded row (called from `resolveQuestion`, src/plan/resolve.mjs).
 */
export function repeatRow(q, { mem, now = new Date(), ats = null } = {}) {
  const r = q.repeat ?? {};
  const noun = r.kind === "education" ? "education history" : "employment history";
  if (r.empty) return { source: "none", action: "skip", why: `optional — no ${noun} on file` };
  if (r.dropped) {
    return {
      source: "none",
      action: "skip",
      why: `optional section — not added: the form requires ${r.dropped.join(", ")} and ${r.entry} states none`,
    };
  }
  const entry = r.entry ? (historyOf(r.kind, mem, now).find((e) => e.id === r.entry) ?? null) : null;
  const name = entryName(r.kind, entry);
  const place = `${r.kind} ${r.index + 1}`;
  let value = partValue(r.part, entry);

  if (value != null && r.part === "degree" && (ats === "greenhouse" || q.options?.length)) {
    const bucket = degreeBucket(value);
    if (!bucket) {
      return missing(q, r, entry, `"${value}" is not one of this form's degree types — which one is it?`, name);
    }
    return {
      source: "fact",
      value: bucket,
      action: entry.prose ? "check" : "fill",
      why: `${partSource(r.part, entry)} (${place}: "${value}" is a ${bucket})`,
    };
  }
  if (value == null) {
    const what = /_(month|year)$/.test(r.part)
      ? `no ${r.part.startsWith("start") ? "start" : "end"} ${r.part.endsWith("month") ? "month" : "year"} is on file for ${name}`
      : `no ${PART_LABEL[r.part].toLowerCase()} is on file for ${name}`;
    return missing(q, r, entry, what, name);
  }
  const added = entry?.added?.includes(/^(start|end)_/.test(r.part) ? r.part.split("_")[0] : r.part);
  return {
    source: "fact",
    value,
    // A part read out of a résumé line's own words is shown before Submit, the way `fromFact()`
    // treats a qualified value; a structured part, or one the user answered, is filled.
    action: entry?.prose && !added ? "check" : "fill",
    why: `${partSource(r.part, entry)} (${place})`,
  };
}

/** A part the entry does not state: asked when the form requires it, else left blank. */
function missing(q, r, entry, what, name) {
  if (!q.required) return { source: "none", action: "skip", why: `optional — ${what}` };
  const id = companionId(r.part, entry);
  const dated = /^(start|end)_/.test(r.part);
  const edge = dated ? r.part.split("_")[0] : null;
  return {
    source: "none",
    action: "ask",
    // One question per missing *thing*: an entry's start month and start year are one date, so
    // both rows carry the same key and the answer ("2016-08") reaches both (`askKey`).
    ...(dated || id ? { canon: `history:${r.entry ?? r.of}:${dated ? edge : r.part}:${r.index}` } : {}),
    ...(dated
      ? { label: `${r.kind} ${r.index + 1} — When did ${name} ${edge === "start" ? "start" : "end"}? (YYYY-MM, or YYYY)` }
      : { label: `${r.kind} ${r.index + 1} — ${PART_LABEL[r.part]} for ${name}` }),
    why: what,
    ...(id ? { remember_as: { kind: "fact", id } } : {}),
  };
}

/**
 * An answer to an expanded row, shaped for that row's box: "2016-08" is "August" in a month box
 * and "2016" in a year box. Null when the answer does not say what the box needs ("2016" for a
 * month) — the caller leaves that box to the user rather than guess.
 */
export function shapeRepeatAnswer(q, value) {
  const part = q?.repeat?.part;
  if (!part || !/_(month|year)$/.test(part)) return String(value);
  const when = parseWhen(value);
  if (!when) return null;
  if (part.endsWith("_year")) return when.year;
  return when.month ? MONTHS[when.month - 1] : null;
}

/**
 * Repeater rows as they come out of an ATS field description. `parts` maps the board's own part
 * names onto ours; anything it does not name is not rendered by that board.
 */
export function repeaterRow({ qid, label, required, section, kind, parts, container, ids = null, min = 0, max = null }) {
  return {
    qid,
    label,
    required: Boolean(required),
    section,
    type: "repeater",
    control: "repeater",
    selector: container,
    class: "identity",
    repeat: { kind, parts, container, ...(ids ? { ids } : {}), min, ...(max ? { max } : {}) },
  };
}
