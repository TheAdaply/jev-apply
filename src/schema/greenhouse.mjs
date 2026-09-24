// Greenhouse: public job schema → FormPlan rows.
//
// Source: GET boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}?questions=true&pay_transparency=true
// Blocks in that response (all optional): `questions` (the application form), `location_questions`
// (Pelias autocomplete + hidden lat/long), `compliance[].questions` (EEOC), `demographic_questions`
// (the U.S. standard demographic survey).
//
// Selectors are the hosted form's real ids, verified against
// https://job-boards.greenhouse.io/togetherai/jobs/5179372007 on 2026-09-22:
//   text/tel inputs   `#first_name`, `#phone` (type=tel), `#question_<id>`
//   react-select      `input#<name>[role=combobox]` inside `.select__control`; options render into
//                     `#react-portal-mount-point` — same id, so the selector is still `#<name>`
//   file              `input#resume[type=file]` (visually hidden; the label is the click target)
//   location          `#candidate-location` — the API calls the field `location`, the DOM does not;
//                     it is a Pelias autocomplete, i.e. a react-select with no fixed option list
//   EEO / demographic `#gender`, `#veteran_status`, `#<demographic question id>`. The API's `race`
//                     question renders as a two-step pair, so `#hispanic_ethnicity` is on the page
//                     first and `#race` only appears once it is answered; these rows are
//                     `sensitive` (skipped unless a global EEO preference exists), so the row keeps
//                     the API field name.

import { classify, cleanLabel, dependencyOn, htmlToText, parseLimits } from "./classes.mjs";
import { repeaterRow } from "../plan/repeat.mjs";

const API = "https://boards-api.greenhouse.io/v1/boards";
const UA = "jev-apply/0.1 (+https://github.com/theadaply/jev-apply)";
const TIMEOUT_MS = 20_000;

/** DOM facts the API response does not describe: ids and controls that differ from the field. */
const SELECTOR_ALIASES = { location: "candidate-location" };
const CONTROL_OVERRIDES = { location: "react_select" };

// A CSS id selector may not start with a digit, and the demographic questions' DOM ids are bare
// numbers ("4012865007") — `#4012865007` is a SyntaxError in querySelector, not a miss.
const SAFE_ID_RE = /^[A-Za-z_][\w-]*$/;
const idSelector = (id) => (SAFE_ID_RE.test(id) ? `#${id}` : `[id="${id}"]`);

const URL_LABEL_RE = /linked-?in|git-?hub|\bwebsite\b|web page|\bportfolio\b|\btwitter\b|\bblog\b|\burl\b|google scholar|personal (?:web)?site|profile link/i;
const PHONE_LABEL_RE = /\bphone\b|mobile number|contact number/i;

/** GET the public job schema. Throws an Error carrying `.status` on a non-200. */
export async function fetchGreenhouse({ token, id }) {
  if (!token || !id) throw new Error("fetchGreenhouse needs { token, id }");
  const url = `${API}/${encodeURIComponent(token)}/jobs/${encodeURIComponent(id)}?questions=true&pay_transparency=true`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`greenhouse ${res.status} for ${token}/${id}`);
    err.status = res.status;
    throw err;
  }
  const raw = await res.json();
  const hosted = await hostedSections({ token, id });
  return hosted ? { ...raw, _hosted: hosted } : raw;
}

const HOSTED = "https://job-boards.greenhouse.io";

/**
 * The Education and Employment sections of the hosted form. The board API does not publish them;
 * the hosted page's own render state does — `education_config` gives each part (`school_name`,
 * `degree`, `discipline`, `start_month`/`start_year`, `end_month`/`end_year`) as `hidden`,
 * `optional` or `required`, and `employment` is `"hidden"` or its own config. Read live on
 * 2026-09-24: 15 of 90 hosted postings across 50 boards show Education (5 require it); none showed
 * Employment. A page that cannot be read costs the section, never the posting: null.
 */
async function hostedSections({ token, id }) {
  try {
    const res = await fetch(`${HOSTED}/${encodeURIComponent(token)}/jobs/${encodeURIComponent(id)}`, {
      headers: { accept: "text/html", "user-agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return hostedConfig(await res.text());
  } catch {
    return null;
  }
}

/** The two section configs out of a hosted page's HTML (its render state is escaped JSON). */
export function hostedConfig(html) {
  const text = String(html ?? "").replace(/\\"/g, '"');
  const read = (re) => {
    const m = re.exec(text);
    if (!m) return undefined;
    try {
      return JSON.parse(m[1]);
    } catch {
      return undefined;
    }
  };
  const education_config = read(/"education_config":(null|\{[^{}]*\})/);
  const employment = read(/"employment":("[a-z_]+"|null|\{[^{}]*\})/);
  if (education_config === undefined && employment === undefined) return null;
  return { education_config: education_config ?? null, employment: employment ?? null };
}

/** Raw Greenhouse JSON → FormPlan (PLAN §2.3). `url` defaults to the posting's `absolute_url`. */
export function normalizeGreenhouse(raw, url) {
  const questions = [];
  let previous = null;
  for (const q of raw.questions || []) {
    const row = formRow(q, "Application");
    if (!row) continue;
    const dependency = dependencyOn(row, previous);
    if (dependency) row.dependency = dependency;
    previous = row;
    questions.push(row);
  }
  for (const q of raw.location_questions || []) {
    const row = formRow(q, "Location");
    if (row) questions.push(row);
  }
  for (const block of raw.compliance || []) {
    const section = String(block.type || "compliance").toUpperCase();
    for (const q of block.questions || []) {
      // The block's own `description` is the EEOC preamble, not per-question help: left out.
      for (const field of q.fields || []) {
        if (field.type === "input_hidden") continue;
        questions.push(sensitiveRow(humanize(q.label), field.name, field.name, field.type, q.required, field.values, section));
      }
    }
  }
  questions.push(...sectionRows(raw._hosted));
  const demographic = raw.demographic_questions;
  for (const q of demographic?.questions || []) {
    const options = (q.answer_options || []).map((o) => ({ label: cleanLabel(o.label), value: String(o.id) }));
    questions.push(sensitiveRow(q.label, `demographic_${q.id}`, String(q.id), q.type, q.required, options, cleanLabel(demographic.header) || "Demographic"));
  }

  return {
    ats: "greenhouse",
    url: url || raw.absolute_url || "",
    job: {
      title: cleanLabel(raw.title),
      company: cleanLabel(raw.company_name),
      description: htmlToText(raw.content),
      location: cleanLabel(raw.location?.name || raw.offices?.[0]?.name || ""),
      ...(payRange(raw) && { payRange: payRange(raw) }),
    },
    questions,
  };
}

/** One `questions[]` / `location_questions[]` entry → a FormPlan row (null when it is hidden). */
function formRow(q, section) {
  const fields = (q.fields || []).filter((f) => f.type !== "input_hidden");
  if (!fields.length) return null;
  // Résumé and cover letter carry an upload field plus a paste-text alternative: the upload wins.
  const field = fields.find((f) => f.type === "input_file") || fields[0];
  const label = cleanLabel(q.label);
  const help = htmlToText(q.description);
  // A `multi_value_multi_select` has two renderings and the API says nothing about which one a
  // board uses: a `<fieldset class="checkbox" id="question_<id>[]">` of
  // `input[type=checkbox][name="question_<id>[]"]` (cloudflare/8195695 with one box,
  // faire/8691459002 with eleven), or a multi-value react-select whose input carries that same id
  // (figma/5790627004 — zero checkboxes on the page). All three read live on 2026-09-23. The id
  // is on the page in both, so it is the selector, and `detectControl` decides which widget it
  // found; the `control` below stays the commoner rendering and is overridden where it is wrong.
  const { type, control: rendered } = controlFor(field.type, label);
  const control = field.type === "multi_value_multi_select" ? "checkbox" : CONTROL_OVERRIDES[field.name] || rendered;
  const limits = parseLimits(label, help);
  const options = (field.values || []).map((v) => ({ label: cleanLabel(v.label), value: String(v.value) }));

  return {
    qid: field.name,
    label,
    ...(help && { help }),
    required: Boolean(q.required),
    section,
    type,
    control,
    selector: idSelector(SELECTOR_ALIASES[field.name] || field.name),
    ...(options.length && { options }),
    ...(limits && { limits }),
    class: classify(label, help, type, Boolean(q.required)),
  };
}

// Greenhouse's part names → ours, and the DOM id stem each renders under (`#school--0`, then
// `#school--1` once "Add another" is clicked). Employment's ids have not been seen on a live form,
// so its parts carry none and are found by their labels inside the entry (src/browser/repeat.mjs).
const EDUCATION_PARTS = {
  school_name: ["school", "school"],
  degree: ["degree", "degree"],
  discipline: ["field", "discipline"],
  start_month: ["start_month", "start-month"],
  start_year: ["start_year", "start-year"],
  end_month: ["end_month", "end-month"],
  end_year: ["end_year", "end-year"],
};
const EMPLOYMENT_PARTS = {
  company_name: "employer",
  company: "employer",
  title: "title",
  start_month: "start_month",
  start_year: "start_year",
  end_month: "end_month",
  end_year: "end_year",
  current: "current",
};
const SHOWN = /^(optional|required)$/;

/** The hosted page's Education / Employment sections → repeater rows (src/plan/repeat.mjs). */
function sectionRows(hosted) {
  const rows = [];
  const education = hosted?.education_config;
  if (education && typeof education === "object") {
    const parts = {};
    const ids = {};
    for (const [key, [part, stem]] of Object.entries(EDUCATION_PARTS)) {
      if (!SHOWN.test(String(education[key] ?? ""))) continue;
      parts[part] = education[key];
      ids[part] = stem;
    }
    if (Object.keys(parts).length) {
      rows.push(
        repeaterRow({
          qid: "education",
          label: "Education",
          required: Object.values(parts).includes("required"),
          section: "Education",
          kind: "education",
          parts,
          container: ".education--container",
          ids,
        }),
      );
    }
  }
  const employment = hosted?.employment;
  if (employment && typeof employment === "object") {
    const parts = {};
    for (const [key, part] of Object.entries(EMPLOYMENT_PARTS)) {
      if (SHOWN.test(String(employment[key] ?? ""))) parts[part] = employment[key];
    }
    if (Object.keys(parts).length) {
      rows.push(
        repeaterRow({
          qid: "employment",
          label: "Employment",
          required: Object.values(parts).includes("required"),
          section: "Employment",
          kind: "employment",
          parts,
          container: ".employment--container",
        }),
      );
    }
  }
  return rows;
}

/**
 * The EEO-1 race question is a *two-step* control on the hosted form: `#hispanic_ethnicity`
 * renders first, and `#race` is not in the DOM at all until that one is answered. The API
 * publishes only the second half, as a top-level compliance field, so the fill loop drove a
 * control that did not exist yet and logged `failed: 1` for a complete fill
 * (docs/POSTMORTEM.md B8). `mounts_after` is that fact, on the row: the fill loop drives such a
 * row after its parent, and a control the page has not grown yet is deferred, never counted as a
 * form refusing a value (`src/plan/execute.mjs` `rowOrder`/`deferredMount`).
 *
 * It is deliberately *not* a `dependency`: a dependency blanks the child when the parent says No,
 * and race is asked whatever the ethnicity answer is. This is about when the control exists, not
 * about what may be put in it.
 */
const MOUNTS_AFTER = { race: "hispanic_ethnicity" };

function sensitiveRow(label, qid, domId, apiType, required, values, section) {
  const clean = cleanLabel(label);
  const { type, control } = controlFor(apiType, clean);
  const options = (values || []).map((v) => ({ label: cleanLabel(v.label), value: String(v.value) }));
  return {
    qid,
    label: clean,
    required: Boolean(required),
    section,
    type,
    control,
    selector: idSelector(domId),
    ...(options.length && { options }),
    ...(MOUNTS_AFTER[qid] ? { mounts_after: MOUNTS_AFTER[qid] } : {}),
    class: "sensitive",
  };
}

/** Greenhouse field type (+ label) → FormPlan `type` and `control`. */
function controlFor(apiType, label) {
  switch (apiType) {
    case "textarea":
      return { type: "textarea", control: "textarea" };
    case "input_file":
      return { type: "file", control: "file" };
    case "multi_value_single_select":
      return { type: "single_select", control: "react_select" };
    case "multi_value_multi_select":
      return { type: "multi_select", control: "react_select" };
    default:
      if (PHONE_LABEL_RE.test(label)) return { type: "phone", control: "tel" };
      if (URL_LABEL_RE.test(label)) return { type: "url", control: "text" };
      return { type: "text", control: "text" };
  }
}

function payRange(raw) {
  const range = (raw.pay_input_ranges || [])[0];
  if (!range) return undefined;
  const min = Number.isFinite(range.min_cents) ? range.min_cents / 100 : undefined;
  const max = Number.isFinite(range.max_cents) ? range.max_cents / 100 : undefined;
  if (min === undefined && max === undefined) return undefined;
  const currency = range.currency_type || undefined;
  const text = [min, max].filter((n) => n !== undefined).map((n) => n.toLocaleString("en-US")).join(" – ");
  return { ...(min !== undefined && { min }), ...(max !== undefined && { max }), ...(currency && { currency }), text: currency ? `${text} ${currency}` : text };
}

/** Compliance labels arrive as identifiers ("VeteranStatus"); the form shows a sentence. */
function humanize(label) {
  return cleanLabel(String(label || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
}
