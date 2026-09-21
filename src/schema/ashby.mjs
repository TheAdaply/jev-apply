// Ashby: public job posting + application form → FormPlan rows.
//
// Source: POST jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting with the document captured
// from DevTools (eval/fixtures/ashby-query.graphql). Introspection is disabled on that endpoint and
// `applicationForm.sections[].fieldEntries[].field` is a `JSON!` scalar — a typed sub-selection
// fails with GRAPHQL_VALIDATION_FAILED, so the document requests `field` bare. The endpoint 429s
// above ~6 concurrent requests, so this module never runs more than MAX_CONCURRENT at a time.
//
// Selector evidence — the rendered forms of baseten/db6477fc, anyscale/1cf38233 and
// fireworks/fc3845e6, read over CDP on 2026-09-22. Every field sits in a
// `div.ashby-application-form-field-entry[data-field-path="<field.path>"]` with `<label for=path>`,
// and every FormPlan selector is scoped by that attribute:
//   String/Email/Phone/Url/Number  `input.ashby-application-form-input-text`, `id === name === path`
//   Date / Location                `input.ashby-application-form-input-{date,autocomplete}` — these
//                                  two carry neither id nor name, hence the container scope
//   LongText          `textarea.ashby-application-form-input-textarea`
//   File              `input[type=file]` (no class of its own) plus a dropzone button
//   Boolean           two `button.ashby-application-form-input-yesno-option` (`data-option=yes|no`,
//                     `aria-pressed`) over a hidden checkbox — not a radio group
//   ValueSelect       n × `input[type=radio].ashby-application-form-input-radio-group-option-radio`,
//                     every `value="on"` — the adapter must pick by label text, never by value
//   MultiValueSelect  n × `input[type=checkbox]`
// EEO/consent questions (`_systemfield_eeoc_*`) are rendered from `surveyForms`, which this query
// does not request: they are on the page but never in the FormPlan, and they are never required.

import { readFile } from "node:fs/promises";
import { classify, cleanLabel, dependencyOn, htmlToText, parseLimits } from "./classes.mjs";

const ENDPOINT = "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting";
const QUERY_PATH = new URL("../../eval/fixtures/ashby-query.graphql", import.meta.url);
const UA = "jev-apply/0.1 (+https://github.com/theadaply/jev-apply)";
const TIMEOUT_MS = 20_000;
const MAX_CONCURRENT = 3;

const CURRENCY = { $: "USD", "€": "EUR", "£": "GBP" };
const URL_TITLE_RE = /linked-?in|git-?hub|\bwebsite\b|web page|\bportfolio\b|\btwitter\b|\bblog\b|\burl\b|google scholar|personal (?:web)?site|profile link/i;
const PHONE_TITLE_RE = /\bphone\b|mobile number|contact number/i;

let queryText = null;
let active = 0;
const waiting = [];

async function withSlot(run) {
  if (active >= MAX_CONCURRENT) await new Promise((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await run();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

async function document() {
  if (queryText === null) queryText = await readFile(QUERY_PATH, "utf8");
  return queryText;
}

/** POST the ApiJobPosting document. Returns the raw GraphQL envelope `{ data: { jobPosting } }`. */
export async function fetchAshby({ org, id }) {
  if (!org || !id) throw new Error("fetchAshby needs { org, id }");
  const query = await document();
  return withSlot(async () => {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": UA },
      body: JSON.stringify({
        operationName: "ApiJobPosting",
        variables: { organizationHostedJobsPageName: org, jobPostingId: id },
        query,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const err = new Error(`ashby ${res.status} for ${org}/${id}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    if (body.errors?.length) throw new Error(`ashby graphql: ${body.errors.map((e) => e.message).join("; ")}`);
    if (!body.data?.jobPosting) throw new Error(`ashby: no jobPosting for ${org}/${id}`);
    return body;
  });
}

/** Raw Ashby response (envelope or bare jobPosting) → FormPlan (PLAN §2.3). */
export function normalizeAshby(raw, url) {
  const posting = raw?.data?.jobPosting || raw?.jobPosting || raw;
  const form = posting.applicationForm || {};
  const sections = form.sections?.length
    ? form.sections
    : [{ title: null, fieldEntries: form.fieldEntries || [] }];

  const questions = [];
  let previous = null;
  for (const section of sections) {
    const name = cleanLabel(section.title) || "Application";
    for (const entry of section.fieldEntries || []) {
      const row = formRow(entry, name);
      if (!row) continue;
      const dependency = dependencyOn(row, previous);
      if (dependency) row.dependency = dependency;
      previous = row;
      questions.push(row);
    }
  }

  const org = orgFrom(url);
  return {
    ats: "ashby",
    url: url || (org ? `https://jobs.ashbyhq.com/${org}/${posting.id}/application` : ""),
    job: {
      title: cleanLabel(posting.title),
      // The posting payload carries no company name — the board slug is the only handle there is.
      company: companyFrom(org),
      description: htmlToText(posting.descriptionHtml),
      location: cleanLabel(posting.locationName || ""),
      ...(payRange(posting) && { payRange: payRange(posting) }),
    },
    questions,
  };
}

function formRow(entry, section) {
  const field = entry?.field;
  if (!field || entry.isHidden === true || field.isDeactivated === true) return null;
  const path = field.path;
  const label = cleanLabel(field.title || field.humanReadablePath || path);
  const help = htmlToText(entry.descriptionHtml);
  const required = Boolean(entry.isRequired);
  const { type, control } = controlFor(field, label);
  const options = optionsFor(field, type);
  const limits = parseLimits(label, help);

  return {
    qid: path,
    label,
    ...(help && { help }),
    required,
    section,
    type,
    control,
    selector: selectorFor(field.type, control, path),
    ...(options.length && { options }),
    ...(limits && { limits }),
    class: classify(label, help, type, required),
  };
}

/** Ashby field type (+ title) → FormPlan `type` and `control`. */
function controlFor(field, label) {
  switch (field.type) {
    case "Boolean":
      return { type: "boolean", control: "radio" };
    case "ValueSelect":
      return { type: "single_select", control: "radio" };
    case "MultiValueSelect":
      return { type: "multi_select", control: "checkbox" };
    case "LongText":
      return { type: "textarea", control: "textarea" };
    case "File":
      return { type: "file", control: "file" };
    case "Date":
      return { type: "date", control: "date" };
    case "Location":
      // `input.ashby-application-form-input-autocomplete` + a suggestion toggle: the value only
      // counts once a suggestion is committed, so it takes the same path as a Greenhouse
      // react-select rather than the plain-text one.
      return { type: "text", control: "react_select" };
    case "Number":
    case "Score":
      return { type: "number", control: "text" };
    case "Phone":
      return { type: "phone", control: "tel" };
    case "Url":
    case "SocialLink":
      return { type: "url", control: "text" };
    default:
      if (PHONE_TITLE_RE.test(label)) return { type: "phone", control: "tel" };
      if (URL_TITLE_RE.test(label)) return { type: "url", control: "text" };
      return { type: "text", control: "text" };
  }
}

function optionsFor(field, type) {
  if (Array.isArray(field.selectableValues)) {
    return field.selectableValues.map((v) => ({ label: cleanLabel(v.label ?? v.value), value: String(v.value ?? v.label) }));
  }
  // A Boolean is a Yes/No button pair; `value` matches the button's `data-option`, and the
  // adapter reads the choice back from `aria-pressed`.
  if (type === "boolean") return [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }];
  return [];
}

/**
 * Every row is addressed through its entry container's `data-field-path`, never through the
 * radio/checkbox `name` or the input `id`. The name is prefixed with `applicationForm.id`, which is
 * regenerated on every render (three different ids for the same Baseten posting on 2026-09-22), and
 * `id === path` holds for plain inputs but not for the Location autocomplete or the Date picker,
 * whose inputs carry neither id nor name. `data-field-path` is exactly `field.path` on all of them.
 */
function selectorFor(fieldType, control, path) {
  const entry = `[data-field-path="${path}"]`;
  // Yes/No pair: `data-option` equals the option `value` this row carries.
  if (fieldType === "Boolean") return `${entry} button[data-option]`;
  if (control === "radio") return `${entry} input[type="radio"]`;
  if (control === "checkbox") return `${entry} input[type="checkbox"]`;
  // The résumé input is the one control with no class of its own; the dropzone button has one.
  if (control === "file") return `${entry} input[type="file"]`;
  return `${entry} [class*="ashby-application-form-input"]`;
}

function payRange(posting) {
  const text = posting.compensationTierSummary || posting.compensationTiers?.[0]?.tierSummary;
  if (!text) return undefined;
  const m = /([$€£])?\s*([\d.,]+)\s*([KkMm])?\s*(?:[-–—]|to)\s*([$€£])?\s*([\d.,]+)\s*([KkMm])?/.exec(text);
  if (!m) return { text: cleanLabel(text) };
  const currency = CURRENCY[m[1] || m[4]];
  return {
    min: scale(m[2], m[3]),
    max: scale(m[5], m[6]),
    ...(currency && { currency }),
    text: cleanLabel(text),
  };
}

function scale(digits, suffix) {
  const n = Number(String(digits).replace(/,/g, ""));
  if (!Number.isFinite(n)) return undefined;
  const unit = suffix?.toLowerCase();
  return unit === "k" ? n * 1_000 : unit === "m" ? n * 1_000_000 : n;
}

function orgFrom(url) {
  return /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)/i.exec(url || "")?.[1] || "";
}

function companyFrom(org) {
  if (!org) return "";
  return org.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}
