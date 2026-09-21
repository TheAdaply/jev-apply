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
  return res.json();
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
  // A multi-select in the application block is a `<fieldset class="checkbox" id="question_<id>[]">`
  // of `input[type=checkbox][name="question_<id>[]"]` (verified on anthropic/jobs/4610158008) — the
  // same API type is a react-select in the demographic block, so only this path is overridden.
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
    // A multi-select is a checkbox group whose DOM id carries the `[]` of the field name.
    selector: control === "checkbox" ? `input[type="checkbox"][name="${field.name}"]` : idSelector(SELECTOR_ALIASES[field.name] || field.name),
    ...(options.length && { options }),
    ...(limits && { limits }),
    class: classify(label, help, type, Boolean(q.required)),
  };
}

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
