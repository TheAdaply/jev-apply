// The module that generates text (PLAN §2.1, §2.2 step 10). Which model does the generating is
// `src/writer/backend.mjs`'s business — OpenAI, a local OpenAI-compatible server, or nobody at
// all, in which case `complete()` throws `HostWriterRequired` and the runner asks the host agent
// for the paragraph instead. Everything below is the same either way.
//
// It writes nothing that is not grounded in the facts/stories it is handed, and every draft is
// checked before it is returned: word/char caps, first person, no marketing vocabulary, every
// number and every organisation/product name present in the grounding. A draft that fails is sent
// back to the model once with the exact complaints; a draft that still fails throws — the runner
// turns that into an `ask`, never a guess.

import { OPENAI_MODEL, OPENAI_MODEL_FAST } from "../config.mjs";
import { HostWriterRequired, WriterError, complete, resetWriter, usageTotals, resetUsage } from "./backend.mjs";
import {
  EXPAND_WORDS,
  EXTRACT_SCHEMA,
  MARKETING_PHRASES,
  NAME_STOPWORDS,
  NARRATIVE_SCHEMA,
  TEXT_SCHEMA,
  VARIANT_WORDS,
  WHY_US_WORDS,
  expandInput,
  expandInstructions,
  extractInput,
  extractInstructions,
  jobBlock,
  narrativeInput,
  narrativeInstructions,
  repairNote,
  whyUsInput,
  whyUsInstructions,
} from "./prompts.mjs";

const ATTEMPTS = 2; // one draft + one repair round
const VARIANTS = ["short", "medium", "long"];

// The backend owns the transport, the usage counters and the three-way detection; re-exported
// here so every caller keeps importing the writer from one place.
export { HostWriterRequired, WriterError, usageTotals, resetUsage };

/** Test seam: drop the memoised client and backend detection (e.g. after changing the env). */
export const resetClient = resetWriter;

// ------------------------------------------------------------------ the call

/** One structured call, whichever backend is configured. Always returns a parsed JSON object. */
function askJson({ instructions, input, schema, name, model = OPENAI_MODEL, effort = "low", maxOutputTokens = 4000, signal }) {
  return complete({ system: instructions, input, schema, name, model, effort, maxTokens: maxOutputTokens, signal });
}

/** One draft, then one repair round carrying the exact complaints. Never returns a failing draft. */
async function drafted({ make, check }) {
  let problems = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const out = await make(attempt === 1 ? "" : repairNote(problems));
    problems = check(out);
    if (!problems.length) return out;
  }
  throw new WriterError(`draft still breaks the writing rules after ${ATTEMPTS} attempts: ${problems.join("; ")}`, {
    problems,
  });
}

// -------------------------------------------------------------------- checks

export function wordCount(text) {
  const t = String(text ?? "").trim();
  return t ? t.split(/\s+/).length : 0;
}

function numberTokens(text) {
  const out = new Set();
  for (const m of String(text ?? "").matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    let n = m[0].replace(/,/g, "");
    if (/^\d+$/.test(n)) n = n.replace(/^0+(?=\d)/, "");
    out.add(n);
  }
  return out;
}

function stripEdges(token) {
  return token.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
}

function sentenceInitial(text, index) {
  for (let i = index - 1; i >= 0; i--) {
    const c = text[i];
    if (/[\s"'“”‘’(\[]/.test(c)) continue;
    return /[.!?:;•\n]/.test(c);
  }
  return true;
}

/**
 * Capitalized tokens that look like an organisation, product or technology.
 * Sentence-initial words are only candidates when they are name-shaped (internal capital, digit or
 * dot: PostgreSQL, Node.js, S3, AWS) or when the same word also occurs mid-sentence — otherwise
 * every sentence opener would be flagged.
 */
function nameCandidates(text) {
  const src = String(text ?? "").replace(/[’‘]/g, "'");
  const hits = [];
  const midSentence = new Set();
  for (const m of src.matchAll(/[A-Za-z][A-Za-z0-9.+#&/'’-]*/g)) {
    if (!/^[A-Z]/.test(m[0])) continue;
    const token = stripEdges(m[0]).replace(/'s$/i, "");
    if (!token) continue;
    const initial = sentenceInitial(src, m.index);
    hits.push({ token, initial });
    if (!initial) midSentence.add(token.toLowerCase());
  }
  const out = new Set();
  for (const { token, initial } of hits) {
    const shaped = /[A-Z0-9.]/.test(token.slice(1));
    if (initial && !shaped && !midSentence.has(token.toLowerCase())) continue;
    for (const part of token.split(/[-/]/)) {
      if (part.length < 2 || !/^[A-Z]/.test(part)) continue;
      if (NAME_STOPWORDS.has(part)) continue;
      out.add(part);
    }
  }
  return [...out];
}

function joinTexts(grounding) {
  if (!grounding) return "";
  const list = Array.isArray(grounding) ? grounding : [grounding];
  return list
    .flatMap((g) => {
      if (g == null) return [];
      if (typeof g === "string") return [g];
      return [g.id, g.title, g.value, g.text, g.company, g.label].filter((x) => typeof x === "string");
    })
    .join("\n");
}

/**
 * Every number and every organisation/product name in `text` must appear in `groundingTexts`.
 * @returns {{ok: boolean, missing: string[]}} missing = the ungrounded tokens, numbers first.
 */
export function groundingCheck(text, groundingTexts) {
  const grounding = joinTexts(groundingTexts);
  const hay = grounding.toLowerCase();
  const numbers = numberTokens(grounding);
  const missing = new Set();
  for (const n of numberTokens(text)) if (!numbers.has(n)) missing.add(n);
  for (const name of nameCandidates(text)) if (!hay.includes(name.toLowerCase())) missing.add(name);
  return { ok: missing.size === 0, missing: [...missing] };
}

const LEGAL_SUFFIX = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "gmbh",
  "ag", "bv", "sa", "sas", "plc", "oy", "ab", "as", "group", "holdings", "technologies", "technology",
  "labs", "lab", "systems", "software", "solutions", "io", "ai", "the",
]);

function coreName(name) {
  const tokens = String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const significant = tokens.filter((t) => !LEGAL_SUFFIX.has(t));
  const first = (significant[0] ?? tokens[0] ?? "");
  return first.length >= 3 ? first : "";
}

/**
 * The substitution failure mode: a draft written for one company that names another.
 * @returns {{ok: boolean, found: string[]}}
 */
export function substitutionCheck(text, otherCompanies = []) {
  const hay = ` ${String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const found = [];
  for (const raw of otherCompanies) {
    const name = String(raw ?? "").trim();
    if (!name) continue;
    const full = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const core = coreName(name);
    if ((full && hay.includes(` ${full} `)) || (core && hay.includes(` ${core} `))) found.push(name);
  }
  return { ok: found.length === 0, found };
}

function marketingHits(text, voiceTexts) {
  const body = ` ${String(text ?? "").toLowerCase()} `;
  const voice = ` ${joinTexts(voiceTexts).toLowerCase()} `;
  const hits = [];
  for (const phrase of MARKETING_PHRASES) {
    const re = new RegExp(`(^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
    if (re.test(body) && !re.test(voice)) hits.push(phrase);
  }
  return hits;
}

function capFor(limits, houseWords) {
  return {
    words: Math.min(houseWords, limits?.words ?? Infinity),
    chars: limits?.chars ?? Infinity,
  };
}

function variantCaps(limits) {
  return {
    short: capFor(limits, VARIANT_WORDS.short),
    medium: capFor(limits, VARIANT_WORDS.medium),
    long: capFor(limits, VARIANT_WORDS.long),
  };
}

function textProblems(label, value, cap, { grounding, voice }) {
  const text = String(value ?? "").trim();
  if (!text) return [`${label}: empty`];
  const problems = [];
  const words = wordCount(text);
  if (words > cap.words) problems.push(`${label}: ${words} words, the cap is ${cap.words}`);
  if (cap.chars < Infinity && text.length > cap.chars) {
    problems.push(`${label}: ${text.length} characters, the cap is ${cap.chars}`);
  }
  if (!/\b(i|i'm|i've|my|me)\b/i.test(text)) problems.push(`${label}: write it in the first person`);
  if (/^\s*(dear\b|hi\b|hello\b|to whom)/i.test(text)) problems.push(`${label}: drop the greeting`);
  if (/^\s*[-*•]\s|^\s*#{1,6}\s/m.test(text)) problems.push(`${label}: prose only, no bullets or headings`);
  const g = groundingCheck(text, grounding);
  if (!g.ok) problems.push(`${label}: not in the grounding, remove or replace: ${g.missing.join(", ")}`);
  const m = marketingHits(text, voice);
  if (m.length) problems.push(`${label}: marketing words, rewrite plainly: ${m.join(", ")}`);
  return problems;
}

// ----------------------------------------------------------------- narrative

/**
 * Author the three length variants of a narrative answer (PLAN §2.4 `narrative` answers).
 * @returns {Promise<{short: string, medium: string, long: string}>}
 */
export async function narrative({ prompt, facts = [], stories = [], family, limits, job, avoid = [], model, signal } = {}) {
  if (!prompt) throw new TypeError("narrative({ prompt }) is required");
  if (!facts.length && !stories.length) {
    throw new WriterError("narrative needs at least one fact or story; a narrative is never invented");
  }
  const caps = variantCaps(limits);
  const ground = { grounding: [...facts, ...stories, jobBlock(job)], voice: [...facts, ...stories] };
  const out = await drafted({
    make: (note) =>
      askJson({
        instructions: narrativeInstructions({ caps, family }),
        input: narrativeInput({ prompt, facts, stories, family, job, avoid, note }),
        schema: NARRATIVE_SCHEMA,
        name: "narrative_variants",
        model,
        maxOutputTokens: 5000,
        signal,
      }),
    check: (o) => VARIANTS.flatMap((v) => textProblems(v, o[v], caps[v], ground)),
  });
  return { short: out.short.trim(), medium: out.medium.trim(), long: out.long.trim() };
}

// -------------------------------------------------------------------- expand

/**
 * Turn one matched bullet-length story into a full answer inside the field's limit.
 * @returns {Promise<{text: string, words: number}>}
 */
export async function expand({ story, question, limits, job, facts = [], avoid = [], model, signal } = {}) {
  if (!story?.text) throw new TypeError("expand({ story }) needs a story with text");
  if (!question) throw new TypeError("expand({ question }) is required");
  const cap = capFor(limits, EXPAND_WORDS);
  const ground = { grounding: [story, ...facts, jobBlock(job)], voice: [story, ...facts] };
  const out = await drafted({
    make: (note) =>
      askJson({
        instructions: expandInstructions({ cap }),
        input: expandInput({ story, question, facts, job, avoid, note }),
        schema: TEXT_SCHEMA,
        name: "expanded_answer",
        model,
        signal,
      }),
    check: (o) => textProblems("answer", o.text, cap, ground),
  });
  const text = out.text.trim();
  return { text, words: wordCount(text) };
}

// -------------------------------------------------------------------- why_us

/**
 * The user's one sentence is the thesis; one or two stories are the evidence (PLAN §2.2 step 10).
 *
 * `sentence` is optional. With `p.auto_draft` on, the runner drafts this row rather than handing
 * it back — the thesis then comes from the posting's own text and the candidate's saved material,
 * which are both in the grounding, and `groundingCheck` is what keeps it from becoming an opinion
 * about the company. Without at least one story or fact there is nothing to write from and this
 * throws, exactly as `narrative` does.
 *
 * @returns {Promise<{text: string, words: number}>}
 */
export async function whyUs({ sentence = null, stories = [], job, limits, facts = [], avoid = [], model, signal } = {}) {
  if (!job?.company) throw new TypeError("whyUs({ job }) needs job.company");
  const thesis = sentence ? String(sentence).trim() : "";
  if (!thesis && !stories.length && !facts.length) {
    throw new WriterError("why_us needs the applicant's sentence or at least one saved fact or story; it is never invented");
  }
  const cap = capFor(limits, WHY_US_WORDS);
  const picked = stories.slice(0, 2);
  const ground = {
    grounding: [...(thesis ? [thesis] : []), ...picked, ...facts, jobBlock(job)],
    voice: [...(thesis ? [thesis] : []), ...picked, ...facts],
  };
  const out = await drafted({
    make: (note) =>
      askJson({
        instructions: whyUsInstructions({ cap, company: job.company, sentence: Boolean(thesis) }),
        input: whyUsInput({ sentence: thesis || null, stories: picked, facts, job, avoid, note }),
        schema: TEXT_SCHEMA,
        name: "why_us_paragraph",
        model,
        signal,
      }),
    check: (o) => {
      const problems = textProblems("paragraph", o.text, cap, ground);
      if (!String(o.text ?? "").toLowerCase().includes(job.company.toLowerCase())) {
        problems.push(`paragraph: name ${job.company} once`);
      }
      return problems;
    },
  });
  const text = out.text.trim();
  return { text, words: wordCount(text) };
}

// ------------------------------------------------------------------- extract

/**
 * The identity namespace the rest of the store uses (references/memory-format.md,
 * private/profile/memory-seed/facts.yaml — link ids confirmed with Memory). The model is told to
 * mint these directly; this map is the belt to that braces, so a flat `f.name`, an `f.link.github`
 * or a plural `f.contact.email`/`f.links.github` can never land beside the seeded row for the same
 * fact. Every id the resolver reads is `f.identity.*`, so a row filed anywhere else is invisible to
 * the form-filling pass — a silent "no fact on file" ask on a CV that stated it.
 */
const FACT_ID_ALIASES = new Map(Object.entries({
  "f.name": "f.identity.full_name",
  "f.full_name": "f.identity.full_name",
  "f.fullname": "f.identity.full_name",
  "f.identity.name": "f.identity.full_name",
  "f.contact.name": "f.identity.full_name",
  "f.email": "f.identity.email",
  "f.identity.email_address": "f.identity.email",
  "f.contact.email": "f.identity.email",
  "f.phone": "f.identity.phone",
  "f.identity.phone_number": "f.identity.phone",
  "f.identity.mobile": "f.identity.phone",
  "f.contact.phone": "f.identity.phone",
  "f.contact.mobile": "f.identity.phone",
  "f.city": "f.identity.city",
  "f.identity.town": "f.identity.city",
  "f.contact.city": "f.identity.city",
  "f.location": "f.identity.location",
  "f.identity.address": "f.identity.location",
  "f.contact.location": "f.identity.location",
  "f.link.github": "f.identity.github_url",
  "f.links.github": "f.identity.github_url",
  "f.github": "f.identity.github_url",
  "f.link.linkedin": "f.identity.linkedin_url",
  "f.links.linkedin": "f.identity.linkedin_url",
  "f.linkedin": "f.identity.linkedin_url",
  "f.link.website": "f.identity.site_url",
  "f.link.site": "f.identity.site_url",
  "f.link.portfolio": "f.identity.site_url",
  "f.links.website": "f.identity.site_url",
  "f.links.site": "f.identity.site_url",
  "f.links.portfolio": "f.identity.site_url",
  "f.website": "f.identity.site_url",
  "f.link.x": "f.identity.x_twitter_url",
  "f.link.twitter": "f.identity.x_twitter_url",
  "f.links.x": "f.identity.x_twitter_url",
  "f.links.twitter": "f.identity.x_twitter_url",
  "f.twitter": "f.identity.x_twitter_url",
  "f.timezone": "f.identity.timezone",
  "f.identity.tz": "f.identity.timezone",
  "f.contact.timezone": "f.identity.timezone",
  "f.preferred_name": "f.identity.preferred_name",
  "f.identity.nickname": "f.identity.preferred_name",
  "f.identity.goes_by": "f.identity.preferred_name",
  "f.nickname": "f.identity.preferred_name",
  "f.publications": "f.identity.publications_url",
  "f.link.publications": "f.identity.publications_url",
  "f.links.publications": "f.identity.publications_url",
  "f.identity.publications": "f.identity.publications_url",
  "f.identity.google_scholar_url": "f.identity.publications_url",
  // The employer/title pair and the school/field pair are single-valued rows the resolver reads by
  // name (src/plan/resolve.mjs identityRow, src/canon/answers.mjs CONSTANTS); a CV lists several
  // employers and often two degrees, so the first claim wins and later ones are dropped, not
  // suffixed — a `-2` row would be invisible to the form-filling pass anyway.
  "f.employer.current": "f.employment.current",
  "f.employment.current_employer": "f.employment.current",
  "f.employment.current_company": "f.employment.current",
  "f.company.current": "f.employment.current",
  "f.current_employer": "f.employment.current",
  "f.current_company": "f.employment.current",
  "f.title.current": "f.employment.current_title",
  "f.employment.current_role": "f.employment.current_title",
  "f.role.current": "f.employment.current_title",
  "f.current_title": "f.employment.current_title",
  "f.education.university": "f.education.school",
  "f.education.institution": "f.education.school",
  "f.education.college": "f.education.school",
  "f.school": "f.education.school",
  "f.education.major": "f.education.field",
  "f.education.subject": "f.education.field",
  "f.education.field_of_study": "f.education.field",
  "f.education.qualification": "f.education.degree",
  "f.degree": "f.education.degree",
}));

/** One row per canonical fact: a second claim on one of these is dropped, never suffixed. */
const CANONICAL_FACT_IDS = new Set(FACT_ID_ALIASES.values());

/**
 * Which locality id a value belongs under. Memory's rule: `f.identity.city` whenever the document
 * names a place (the value may carry the country, "Berlin, Germany"); `f.identity.location` only
 * for a locality that is not a city — "Remote", a bare country, a region; `f.identity.timezone` for
 * a zone. The model is told this and still mis-keys "Berlin, Germany" about half the time, and
 * mis-keying silently closes `learn.mjs`'s g.identity.city gap (a timezone or a country cannot fill
 * a city field a form asks for), so the id is derived from the value rather than trusted.
 */
const NON_CITY = /^(remote|anywhere|worldwide|global|distributed|hybrid|eu|emea|apac|latam|europe|asia|africa|oceania|north america|south america|middle east|us|u\.s\.|usa|uk|u\.k\.|uae)$/i;
const TZ_OFFSET = /^(UTC|GMT)(\s*[+-]\s*\d{1,2}(:\d{2})?)?$/;
// An explicit list, not /^[A-Z]{2,5}T$/: that pattern swallows real all-caps city headers
// (SURAT, RABAT) and re-keying a city to a timezone silently reopens the g.identity.city gap.
const TZ_ABBREV = new Set([
  "UTC", "GMT", "CET", "CEST", "EET", "EEST", "WET", "WEST", "BST", "IST", "PST", "PDT", "EST",
  "EDT", "CST", "CDT", "MST", "MDT", "AKST", "AKDT", "HST", "JST", "KST", "AEST", "AEDT", "ACST",
  "AWST", "NZST", "NZDT", "SGT", "HKT", "MSK", "CAT", "EAT", "SAST", "BRT", "ART", "CLT",
]);
const TZ_IANA = /^(Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z_+-]+$/;
let _countries = null;
function countries() {
  if (!_countries) {
    _countries = new Set();
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        const name = names.of(code);
        if (name && name !== code) _countries.add(name.toLowerCase());
      }
    }
  }
  return _countries;
}
function isTimezone(s) {
  return TZ_OFFSET.test(s.toUpperCase()) || TZ_ABBREV.has(s.toUpperCase()) || TZ_IANA.test(s);
}

function segmentKind(s) {
  if (isTimezone(s)) return "timezone";
  if (NON_CITY.test(s) || /\b(remote|anywhere|worldwide|distributed)\b/i.test(s)) return "non_city";
  if (countries().has(s.toLowerCase())) return "non_city";
  return /[A-Za-z]/.test(s) ? "place" : "non_city";
}

/**
 * One locality value → the rows it actually contains. Values arrive compound ("Berlin, Germany",
 * "Remote · UTC+2", "US Remote"), and the anchored patterns match none of those as a whole, so the
 * value is split: a zone segment becomes its own timezone row, and what remains is a city when any
 * segment names a real place, otherwise a location. Keeping "Remote · UTC+2" as one city row would
 * close `learn.mjs`'s g.identity.city gap with a value no city field can accept.
 * @returns {Array<{id: string, value: string}>} at most one city-or-location row and one timezone row.
 */
function localityRows(value) {
  const v = String(value ?? "").trim().replace(/\s*\(.*\)\s*$/, "").replace(/[.,;]+$/, "").trim();
  if (!v) return [];
  if (isTimezone(v)) return [{ id: "f.identity.timezone", value: v }]; // "Europe/Berlin" is a zone
  const parts = v.split(/\s*[·•|;,/]\s*|\s+[–—-]\s+/).map((p) => p.trim()).filter(Boolean);
  const zones = parts.filter(isTimezone);
  const rest = parts.filter((p) => !isTimezone(p));
  const rows = [];
  if (rest.length) {
    const id = rest.some((p) => segmentKind(p) === "place") ? "f.identity.city" : "f.identity.location";
    rows.push({ id, value: rest.join(", ") });
  }
  if (zones.length) rows.push({ id: "f.identity.timezone", value: zones[0] });
  return rows;
}

/** @returns {string|null} the id to use, or null when a canonical row is already taken. */
function normalizeId(raw, prefix, seen, aliases, canonical) {
  let id = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (!id) id = "item";
  if (!id.startsWith(`${prefix}.`)) id = `${prefix}.${id}`;
  id = aliases?.get(id) ?? id;
  if (seen.has(id) && canonical?.has(id)) return null;
  let unique = id;
  for (let n = 2; seen.has(unique); n++) unique = `${id}-${n}`;
  seen.add(unique);
  return unique;
}

/**
 * Stories live in the `b.` namespace everywhere else in the store — the seed's blobs are
 * `b.story.*`/`b.answer.*` and `remember.mjs` mints `b.kept.<slug>` (references/memory-format.md).
 * Any prefix the model reaches for is stripped so a CV-topped-up store keeps one namespace.
 */
function storyId(raw, seen) {
  const slug = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^(b\.story\.|b\.answer\.|b\.kept\.|b\.|s\.|story\.)+/, "")
    .replace(/^[._-]+|[._-]+$/g, "");
  return normalizeId(slug || "item", "b.story", seen);
}

function paginate({ text, pages }) {
  const list = (Array.isArray(pages) && pages.length ? pages : String(text ?? "").split(/\f/))
    .map((p) => String(p ?? "").trim())
    .filter(Boolean);
  if (!list.length) throw new WriterError("extractResume: the document text is empty");
  return list;
}

/**
 * Résumé text → memory rows with page provenance (PLAN §2.4). Facts are copied, never guessed;
 * story titles are the interview question the story answers.
 * @returns {Promise<{facts: Array<{id,value,since?,source}>, stories: Array<{id,title,text,tags,source}>}>}
 */
export async function extractResume({ text, pages, doc = "resume", model = OPENAI_MODEL_FAST, signal } = {}) {
  const pageList = paginate({ text, pages });
  const marked = pageList.map((p, i) => `[[page ${i + 1}]]\n${p}`).join("\n\n");
  const raw = await drafted({
    make: (note) =>
      askJson({
        instructions: extractInstructions(),
        input: extractInput({ text: marked, doc, note }),
        schema: EXTRACT_SCHEMA,
        name: "resume_extraction",
        model,
        maxOutputTokens: 8000,
        signal,
      }),
    check: (o) => {
      const problems = [];
      for (const s of o.stories ?? []) {
        if (!/\?\s*$/.test(String(s.title ?? ""))) {
          problems.push(`story ${s.id}: the title must be the question it answers and end with "?" (got "${s.title}")`);
        }
        const g = groundingCheck(s.text, [marked]);
        if (!g.ok) problems.push(`story ${s.id}: not in the document: ${g.missing.join(", ")}`);
      }
      for (const f of o.facts ?? []) {
        const g = groundingCheck(f.value, [marked]);
        if (!g.ok) problems.push(`fact ${f.id}: not in the document: ${g.missing.join(", ")}`);
      }
      return problems;
    },
  });

  const page = (n) => Math.min(Math.max(1, Math.round(Number(n) || 1)), pageList.length);
  const source = (n) => `resume:${doc}#p${page(n)}`;
  const factIds = new Set();
  const storyIds = new Set();
  let facts = (raw.facts ?? [])
    .filter((f) => String(f.value ?? "").trim())
    .map((f) => {
      const id = normalizeId(f.id, "f", factIds, FACT_ID_ALIASES, CANONICAL_FACT_IDS);
      // null = a second claim on a canonical identity row; the first one wins, this one is dropped.
      return id === null
        ? null
        : {
            id,
            value: String(f.value).trim(),
            ...(/^\d{4}-(0[1-9]|1[0-2])$/.test(String(f.since ?? "")) ? { since: f.since } : {}),
            source: source(f.page),
          };
    })
    .filter(Boolean);
  // Rebuild every locality row from its value (see localityRows), keep one row per id, and let a
  // city row win over a location row: `learn.mjs`'s g.identity.city gap must stay open for a
  // Remote-only or country-only CV and close for one that names a place, whichever id the model
  // reached for. A timezone row is orthogonal — Memory keeps it and it never suppresses the ask.
  const LOCALITY = new Set(["f.identity.city", "f.identity.location", "f.identity.timezone"]);
  const seenLocality = new Set();
  facts = facts.flatMap((f) => {
    if (!LOCALITY.has(f.id)) return [f];
    return localityRows(f.value).flatMap(({ id, value }) => {
      if (seenLocality.has(id)) return [];
      seenLocality.add(id);
      return [{ ...f, id, value }];
    });
  });
  if (seenLocality.has("f.identity.city")) {
    facts = facts.filter((f) => f.id !== "f.identity.location");
  }
  const stories = (raw.stories ?? [])
    .filter((s) => String(s.text ?? "").trim())
    .map((s) => ({
      id: storyId(s.id, storyIds),
      title: String(s.title).trim(),
      text: String(s.text).trim(),
      tags: (s.tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean),
      source: source(s.page),
    }));
  if (!facts.length && !stories.length) throw new WriterError("extractResume: nothing extracted from the document");
  return { facts, stories };
}
