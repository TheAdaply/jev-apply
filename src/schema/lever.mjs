// Lever: public posting + hosted apply page → FormPlan rows.
//
// Sources (both public, no auth):
//   GET api.lever.co/v0/postings/{site}/{id}   posting metadata, JSON (title, country, lists…)
//   GET jobs.lever.co/{site}/{id}/apply         the application form, server-rendered HTML
// EU-hosted boards use `api.eu.lever.co` / `jobs.eu.lever.co` with the same paths.
//
// Lever publishes no form schema as JSON: the form *is* the HTML. Every control is a native
// input keyed by its `name` (verified against spotify/2193db3f and palantir/ac978161 on
// 2026-09-24), so the name is both the row's qid and its selector:
//   standard fields    `name`, `email`, `phone`, `org`, `location`, `urls[<Site>]`, `resume`,
//                      `comments`, `pronouns` (checkbox group)
//   custom questions   `cards[<cardId>][field<n>]` — the card's JSON template sits in a hidden
//                      `cards[<cardId>][baseTemplate]` input and states each field's type,
//                      text, description and required flag
//   legacy US EEO      `eeo[gender|race|veteran|disability]` native selects
//   demographic survey `surveysResponses[<id>][responses][field<n>]` radios — deliberately NOT
//                      planned here: a board ships one survey per country and its own script
//                      reveals the one matching the unnamed "What is your location?" select, so
//                      the schema cannot know which survey the candidate will see. The survey is
//                      read off the live page instead (`adapters/lever.eeoControls`).
//   captcha            `h-captcha-response` — never a row; the runner never solves one.

import { classify, cleanLabel, decodeEntities, dependencyOn, htmlToText, parseLimits } from "./classes.mjs";

const UA = "jev-apply/0.1 (+https://github.com/theadaply/jev-apply)";
const TIMEOUT_MS = 20_000;

export const hostsFor = (region) =>
  region === "eu" ? { jobs: "jobs.eu.lever.co", api: "api.eu.lever.co" } : { jobs: "jobs.lever.co", api: "api.lever.co" };

export const applyUrlFor = ({ site, id, region = null }) => `https://${hostsFor(region).jobs}/${site}/${id}/apply`;

/** Card field types (the template's own vocabulary) → FormPlan `type` and `control`. */
const CARD_TYPES = {
  text: { type: "text", control: "text" },
  textarea: { type: "textarea", control: "textarea" },
  "multiple-choice": { type: "single_select", control: "radio" },
  "multiple-select": { type: "multi_select", control: "checkbox_group" },
  dropdown: { type: "single_select", control: "native_select" },
  date: { type: "date", control: "text" },
  "file-upload": { type: "file", control: "file" },
  file: { type: "file", control: "file" },
  url: { type: "url", control: "text" },
  email: { type: "text", control: "text" },
  number: { type: "number", control: "number" },
};

/** Names that are plumbing, not questions. */
const PLUMBING_RE = /^(?:h-captcha-response|selectedLocation|accountId|linkedInData|origin|referer|timezone|socialReferralKey|socialSource|resumeStorageId|source)$|\[baseTemplate\]$|^surveysResponses\[/;

const EEO_NAME_RE = /^eeo\[/;
const URL_LABEL_RE = /linked-?in|git-?hub|\bwebsite\b|\bportfolio\b|\btwitter\b|\bblog\b|\burl\b/i;
const PHONE_LABEL_RE = /\bphone\b|mobile number|contact number/i;

async function get(url, accept) {
  const res = await fetch(url, {
    headers: { accept, "user-agent": UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`lever ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/**
 * Fetch the raw schema for one posting. Only the `<form id="application-form">` slice of the page
 * is kept (plus its `<title>`, which names the company): the rest is the job description, which
 * the posting JSON already carries as plain text.
 * → {_lever:{site,id,region}, title, posting, html}
 */
export async function fetchLever({ site, id, region = null }) {
  if (!site || !id) throw new Error("fetchLever needs { site, id }");
  const hosts = hostsFor(region);
  const posting = await (await get(`https://${hosts.api}/v0/postings/${encodeURIComponent(site)}/${encodeURIComponent(id)}`, "application/json")).json();
  const page = await (await get(applyUrlFor({ site, id, region }), "text/html")).text();
  return { _lever: { site, id, region }, title: pageTitle(page), posting, html: formSlice(page) };
}

export function formSlice(page) {
  const at = page.indexOf('id="application-form"');
  if (at < 0) return "";
  const start = page.lastIndexOf("<form", at);
  const end = page.indexOf("</form>", at);
  return end < 0 ? page.slice(start) : page.slice(start, end + "</form>".length);
}

function pageTitle(page) {
  return decodeEntities(/<title>([\s\S]*?)<\/title>/i.exec(page)?.[1] ?? "").trim();
}

// ─── HTML reading ─────────────────────────────────────────────────────────────────────────────

/** Every attribute of one opening tag, entity-decoded. Boolean attributes map to "". */
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const key = m[1].toLowerCase();
    if (key === "input" || key === "select" || key === "textarea") continue;
    out[key] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** `<h4>` headings and `.application-question` blocks, in document order, each with its section. */
function blocks(form) {
  const marks = [];
  for (const m of form.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>/g)) marks.push({ at: m.index, heading: cleanLabel(htmlToText(m[1])) });
  for (const m of form.matchAll(/<(?:li|div)\s+class="application-question[^"]*"[^>]*>/g)) marks.push({ at: m.index });
  // "Additional information" is a bare textarea whose only label is the section heading above it.
  for (const m of form.matchAll(/<div\s+class="application-additional[^"]*"[^>]*>/g)) marks.push({ at: m.index, additional: true });
  marks.sort((a, b) => a.at - b.at);
  const out = [];
  let section = "Application";
  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i];
    if (mark.heading !== undefined) {
      section = /^submit your application$/i.test(mark.heading) ? "Application" : mark.heading || section;
      continue;
    }
    out.push({ section, additional: Boolean(mark.additional), html: form.slice(mark.at, marks[i + 1]?.at ?? form.length) });
  }
  return out;
}

/** cards[<id>][baseTemplate] → Map(`cards[<id>][field<n>]` → the field's own template entry). */
function cardFields(form) {
  const byName = new Map();
  for (const m of form.matchAll(/<input[^>]*name="cards\[([^\]]+)\]\[baseTemplate\]"[^>]*>/g)) {
    const { value } = attrs(m[0]);
    if (!value) continue;
    let card;
    try {
      card = JSON.parse(value);
    } catch {
      continue;
    }
    (card.fields ?? []).forEach((field, idx) => byName.set(`cards[${m[1]}][field${idx}]`, { ...field, card: cleanLabel(card.text) }));
  }
  return byName;
}

function controlsIn(html) {
  return [...html.matchAll(/<(input|select|textarea)\b[^>]*>/g)].map((m) => ({ tag: m[1], ...attrs(m[0]), raw: m[0], at: m.index }));
}

/** The visible question text of a block: the card's own text, else `.application-label`. */
function labelOf(html, card) {
  if (card?.text) return cleanLabel(card.text);
  const labelled = /<div[^>]*class="application-label[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1];
  const text = labelled ?? /<label[^>]*>([\s\S]*?)<\/label>/.exec(html)?.[1] ?? "";
  return cleanLabel(htmlToText(text.replace(/<span[^>]*class="required"[^>]*>[\s\S]*?<\/span>/gi, " "))).replace(/\s*[✱*]\s*$/, "");
}

/** Radio / checkbox options: the input's `value` is what the board posts, the span beside it is what it shows. */
function choiceOptions(html, name) {
  const out = [];
  for (const m of html.matchAll(/<input\b[^>]*>(?:\s*<span[^>]*class="application-answer-alternative"[^>]*>([\s\S]*?)<\/span>)?/g)) {
    const a = attrs(m[0]);
    if (a.name !== name || !["radio", "checkbox"].includes(a.type)) continue;
    const label = cleanLabel(htmlToText(m[1] ?? "")) || cleanLabel(a.value);
    if (a.value !== undefined && !out.some((o) => o.value === a.value)) out.push({ label, value: a.value });
  }
  return out;
}

function selectOptions(html) {
  const out = [];
  for (const m of html.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)) {
    const value = attrs(`<option ${m[1]}>`).value ?? "";
    const label = cleanLabel(htmlToText(m[2]));
    if (value === "" || !label) continue;
    out.push({ label, value });
  }
  return out;
}

const quoted = (name) => String(name).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// A row that never reaches the FormPlan is invisible to every plan-level assertion (POSTMORTEM A4),
// so the two places this normalizer drops one say so on stderr. Field names are the board's own
// input names, never an answer.
export function warnDropped(what, names) {
  if (names.length) process.stderr.write(`[lever] warning: ${what}: ${names.join(", ")}\n`);
}

/** One block → a FormPlan row, or null when the block holds only plumbing. */
function blockRow({ section, additional, html }, cards) {
  const controls = controlsIn(html).filter((c) => c.type !== "hidden");
  // The survey's country select carries no name: it is identified by its `data-qa` alone.
  const country = controls.find((c) => c.tag === "select" && c["data-qa"] === "candidate-location-select");
  if (country) {
    const label = labelOf(html) || "What is your location?";
    return {
      qid: "candidate_location",
      label,
      required: false,
      section,
      type: "single_select",
      control: "native_select",
      selector: 'select[data-qa="candidate-location-select"]',
      options: selectOptions(html),
      class: "identity",
      country_gate: true,
    };
  }
  const primary = controls.find((c) => c.name && !PLUMBING_RE.test(c.name));
  if (!primary) return null;
  const name = primary.name;
  const card = cards.get(name) ?? null;
  const label = labelOf(html, card) || (additional ? section : "");
  if (!label) return null;
  // One block, one row: a block with a second named input loses it. Correct for every board read so
  // far, and the warning is how the next board's gap becomes visible instead of invisible.
  warnDropped(`block "${label}" has more than one input; only ${name} is planned`, [...new Set(controls.filter((c) => c.name && c.name !== name && !PLUMBING_RE.test(c.name)).map((c) => c.name))]);

  const sameName = controls.filter((c) => c.name === name);
  const boxes = sameName.filter((c) => c.type === "checkbox").length;
  let type;
  let control;
  let options = [];
  if (primary.tag === "select") {
    type = "single_select";
    control = "native_select";
    options = selectOptions(html);
  } else if (primary.tag === "textarea") {
    type = "textarea";
    control = "textarea";
  } else if (primary.type === "file") {
    type = "file";
    control = "file";
  } else if (primary.type === "radio") {
    type = "single_select";
    control = "radio";
    options = choiceOptions(html, name);
  } else if (primary.type === "checkbox") {
    options = choiceOptions(html, name);
    [type, control] = boxes > 1 ? ["multi_select", "checkbox_group"] : ["boolean", "checkbox"];
  } else if (PHONE_LABEL_RE.test(label) || name === "phone") {
    type = "phone";
    control = "text";
  } else if (URL_LABEL_RE.test(label) || name.startsWith("urls[")) {
    type = "url";
    control = "text";
  } else {
    type = "text";
    control = "text";
  }
  // The card template is the board's own statement of the field; the DOM reading above is the
  // fallback for standard fields, which have no template.
  if (card && CARD_TYPES[card.type]) ({ type, control } = CARD_TYPES[card.type]);

  const help = htmlToText(card?.description ?? /<p[^>]*class="description"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? (additional ? primary.placeholder : "") ?? "");
  const required = card ? Boolean(card.required) : sameName.some((c) => c.required !== undefined) || /class="required"/.test(html);
  const limits = parseLimits(label, help, Number(primary.maxlength) || undefined);
  const selector = ["radio", "checkbox_group", "checkbox"].includes(control) ? `input[name="${quoted(name)}"]` : `[name="${quoted(name)}"]`;
  const companion = name === "eeo[disabilitySignature]" ? "name" : name === "eeo[disabilitySignatureDate]" ? "date" : null;
  const sensitive = EEO_NAME_RE.test(name) && !companion;

  return {
    qid: name,
    label,
    ...(help && { help }),
    required,
    section: sensitive ? "EEO" : card?.card || section,
    type,
    control,
    selector,
    ...(options.length && { options }),
    ...(limits && { limits }),
    class: companion ? "identity" : sensitive ? "sensitive" : classify(label, help, type, required),
    ...(companion ? { eeo_companion: companion } : {}),
  };
}

/** Raw Lever schema (`fetchLever` output) → FormPlan (PLAN §2.3). */
export function normalizeLever(raw, url) {
  const form = raw?.html ?? "";
  const cards = cardFields(form);
  const questions = [];
  const seen = new Set();
  let previous = null;
  for (const block of blocks(form)) {
    const row = blockRow(block, cards);
    if (!row) continue;
    if (seen.has(row.qid)) {
      warnDropped("a second block writes an input already planned; the later one is dropped", [row.qid]);
      continue;
    }
    seen.add(row.qid);
    const dependency = dependencyOn(row, previous);
    if (dependency) row.dependency = dependency;
    previous = row;
    questions.push(row);
  }

  const posting = raw?.posting ?? {};
  const where = raw?._lever ?? {};
  return {
    ats: "lever",
    // Always the form, never the posting page a user may have pasted.
    url: where.site && where.id ? applyUrlFor(where) : posting.applyUrl || url || "",
    job: {
      title: cleanLabel(posting.text),
      company: companyOf(raw),
      description: descriptionOf(posting),
      location: cleanLabel(posting.categories?.location || (posting.categories?.allLocations ?? []).join(", ")),
      ...(/^[A-Za-z]{2}$/.test(posting.country ?? "") && { country: posting.country.toUpperCase() }),
      ...(posting.workplaceType === "remote" && { remote: true }),
      ...(payRange(posting) && { payRange: payRange(posting) }),
    },
    questions,
  };
}

/** The page title is "<Company> - <posting title>"; the posting JSON names no company at all. */
function companyOf(raw) {
  const title = String(raw?.title ?? "");
  const text = cleanLabel(raw?.posting?.text);
  const stripped = text && title.endsWith(text) ? title.slice(0, -text.length).replace(/\s*[-–|]\s*$/, "") : title.split(/\s+-\s+/)[0];
  return cleanLabel(stripped) || cleanLabel(raw?._lever?.site);
}

function descriptionOf(posting) {
  const lists = (posting.lists ?? []).map((l) => `${cleanLabel(l.text)}\n${htmlToText(l.content)}`);
  return [posting.descriptionPlain, ...lists, posting.additionalPlain].filter((s) => typeof s === "string" && s.trim()).join("\n\n");
}

function payRange(posting) {
  const r = posting.salaryRange;
  if (!r) return undefined;
  const min = Number.isFinite(r.min) ? r.min : undefined;
  const max = Number.isFinite(r.max) ? r.max : undefined;
  if (min === undefined && max === undefined) return undefined;
  const currency = r.currency || undefined;
  const text = [min, max].filter((n) => n !== undefined).map((n) => n.toLocaleString("en-US")).join(" – ");
  return {
    ...(min !== undefined && { min }),
    ...(max !== undefined && { max }),
    ...(currency && { currency }),
    ...(r.interval && { interval: r.interval }),
    text: currency ? `${text} ${currency}` : text,
  };
}
