#!/usr/bin/env node
// canon-scan — build the public corpus of real application forms (docs/PLAN.md §2.7, step Q1).
//
//   node scripts/canon-scan.mjs --companies private/companies-seed.yml [--per-family 20]
//                               [--families backend,mobile] [--refresh] [--out corpus]
//
// Collects, per job family, real postings from the three ATSes whose application form is public:
//   greenhouse  GET  boards-api.greenhouse.io/v1/boards/<token>/jobs          (board list)
//               GET  …/jobs/<id>?questions=true&pay_transparency=true         (the form)
//   ashby       GET  api.ashbyhq.com/posting-api/job-board/<org>              (board list)
//               POST jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting   (the form)
//   lever       GET  api.lever.co/v0/postings/<site>?mode=json                (board list)
//               GET  jobs.lever.co/<site>/<id>/apply                          (the form, HTML)
// plus the 127 Greenhouse + 3 Ashby schemas already recorded under private/o1/ (same public data,
// re-used instead of re-fetched).
//
// Written per posting: corpus/<ats>/<family>/<company>-<id>.json — question *labels* only. No
// description text over 300 characters, no personal data, nothing user-specific. Re-running is
// idempotent: a posting already in corpus/ is counted, not re-fetched (--refresh overrides).
//
// Self-contained on purpose: the only local import is the family taxonomy, so Q1 does not wait on
// the schema/config slices.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { classifyTitle, FAMILY_IDS } from "../src/canon/families.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/128.0.0.0 Safari/537.36";
const ATS_ORDER = ["greenhouse", "ashby", "lever"];
const HOST_CONCURRENCY = 3; // per ATS host; Ashby's GraphQL endpoint is the one that rate-limits
const HOLDOUT_FRACTION = 0.2;
const HOLDOUT_SEED = 0x5ca7f00d;
const HELP_MAX = 300;

// ───────────────────────────────────────── cli ─────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    companies: path.join(REPO, "private/companies-seed.yml"),
    extras: path.join(REPO, "corpus/companies-extra.yml"),
    recorded: path.join(REPO, "private/o1"),
    out: path.join(REPO, "corpus"),
    perFamily: 20,
    families: null,
    refresh: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--companies") args.companies = path.resolve(next());
    else if (a === "--extras") args.extras = path.resolve(next());
    else if (a === "--recorded") args.recorded = path.resolve(next());
    else if (a === "--out") args.out = path.resolve(next());
    else if (a === "--per-family") args.perFamily = Number(next());
    else if (a === "--families") args.families = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--refresh") args.refresh = true;
    else if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!Number.isFinite(args.perFamily) || args.perFamily < 1) throw new Error("--per-family must be ≥ 1");
  if (args.families) {
    const bad = args.families.filter((f) => !FAMILY_IDS.includes(f));
    if (bad.length) throw new Error(`unknown families: ${bad.join(", ")}`);
  }
  return args;
}

function usage() {
  process.stderr.write(
    "usage: canon-scan.mjs [--companies F] [--extras F] [--per-family N] [--families a,b] [--refresh] [--out DIR]\n",
  );
}

const log = (...m) => process.stderr.write(`${m.join(" ")}\n`);

// ──────────────────────────────────── small utilities ────────────────────────────────────

export function slugify(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const ENTITIES = { quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", amp: "&" };
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&(quot|apos|lt|gt|nbsp);/g, (_, n) => ENTITIES[n])
    .replace(/&amp;/g, "&");
}

function stripHtml(s) {
  if (s == null) return "";
  return decodeEntities(
    String(s)
      .replace(/<\s*(br|\/p|\/div|\/li)\s*\/?\s*>/gi, " ")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function clip(s, max = HELP_MAX) {
  const t = stripHtml(s);
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** deterministic PRNG so holdout.txt is reproducible */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** a status we will not retry (403, 422, …) — worth reporting, not worth hammering */
class HttpStatusError extends Error {}

/**
 * fetch with 429/5xx + transport backoff; returns null when the posting is simply gone (404/410).
 * The body read is inside the retry: Ashby's board list for a 350-posting org is megabytes of
 * description HTML and times out mid-stream often enough to matter.
 */
async function httpGet(url, { json = true, headers = {}, attempts = 4, body = null, timeout = 45000 } = {}) {
  let wait = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: { "user-agent": UA, accept: json ? "application/json" : "text/html", ...headers },
        body,
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 404 || res.status === 410) return null;
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= attempts) throw new HttpStatusError(`${res.status} ${url}`);
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : wait);
        wait *= 2;
        continue;
      }
      if (!res.ok) throw new HttpStatusError(`${res.status} ${url}`);
      return json ? await res.json() : await res.text();
    } catch (err) {
      if (err instanceof HttpStatusError || attempt >= attempts) throw err;
      await sleep(wait);
      wait *= 2;
    }
  }
}

/** run `fn` over `items` with at most `n` in flight */
async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift());
    }),
  );
}

// ──────────────────────────────────── company sources ────────────────────────────────────

function companiesFromYaml(file, source) {
  if (!fs.existsSync(file)) return [];
  const doc = parseYaml(fs.readFileSync(file, "utf8"));
  const out = [];
  for (const c of doc?.companies ?? []) {
    if (c.enabled === false) continue;
    const key = c.provider === "greenhouse" ? c.token : c.provider === "ashby" ? c.org : c.site;
    if (!ATS_ORDER.includes(c.provider) || !key) continue;
    out.push({ name: c.name, slug: slugify(c.name), ats: c.provider, key: String(key), source });
  }
  return out;
}

function loadCompanies(args) {
  const seed = companiesFromYaml(args.companies, "seed");
  const extra = companiesFromYaml(args.extras, "extra");
  const byId = new Map();
  for (const c of [...seed, ...extra]) byId.set(`${c.ats}:${c.key}`, c);
  return [...byId.values()];
}

// ───────────────────────────────────── board listings ─────────────────────────────────────

const BOARD_URL = {
  greenhouse: (k) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(k)}/jobs`,
  ashby: (k) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(k)}`,
  lever: (k) => `https://api.lever.co/v0/postings/${encodeURIComponent(k)}?mode=json`,
};

async function fetchBoard(company) {
  // Ashby serves every posting's full description in its board list — an 800-posting org is tens of
  // megabytes and sometimes stalls mid-stream, so give it room but bound the retries.
  const raw = await httpGet(BOARD_URL[company.ats](company.key), { timeout: 90000, attempts: 3 });
  if (!raw) return [];
  if (company.ats === "lever") {
    return (Array.isArray(raw) ? raw : []).map((j) => ({
      id: String(j.id),
      title: j.text ?? "",
      location: j.categories?.location ?? "",
      url: j.hostedUrl ?? `https://jobs.lever.co/${company.key}/${j.id}`,
    }));
  }
  if (company.ats === "ashby") {
    return (raw.jobs ?? [])
      .filter((j) => j.isListed !== false)
      .map((j) => ({
        id: String(j.id),
        title: j.title ?? "",
        location: j.location ?? "",
        url: j.jobUrl ?? `https://jobs.ashbyhq.com/${company.key}/${j.id}`,
      }));
  }
  return (raw.jobs ?? []).map((j) => ({
    id: String(j.id),
    title: j.title ?? "",
    location: j.location?.name?.trim() ?? "",
    url: j.absolute_url ?? `https://job-boards.greenhouse.io/${company.key}/jobs/${j.id}`,
  }));
}

// ─────────────────────────────── per-ATS form normalisation ───────────────────────────────

const GH_TYPE = {
  input_text: "text",
  input_file: "file",
  textarea: "textarea",
  multi_value_single_select: "single_select",
  multi_value_multi_select: "multi_select",
};

/** a plain text box is a phone/url box when its label or field name says so — same rule for every ATS */
function refineTextType(label, name = "") {
  const l = String(label ?? "").toLowerCase();
  const n = String(name ?? "");
  if (/phone/i.test(n) || /\bphone\b|mobile number/.test(l)) return "phone";
  if (
    /url|website|linkedin|github/i.test(n) ||
    /\b(url|link|links|website|linkedin|github|gitlab|portfolio|twitter|x com)\b/.test(l)
  ) {
    return "url";
  }
  return "text";
}

function ghFieldType(field, label) {
  const mapped = GH_TYPE[field.type];
  if (mapped !== "text") return mapped;
  return refineTextType(label, field.name);
}

function ghQuestion(q, section) {
  const fields = (q.fields ?? []).filter((f) => f.type !== "input_hidden");
  if (!fields.length) return null;
  const file = fields.find((f) => f.type === "input_file");
  const field = file ?? fields[0];
  const label = stripHtml(q.label);
  if (!label) return null;
  const options = [];
  for (const f of fields) for (const v of f.values ?? []) {
    const l = stripHtml(v.label);
    if (l && !options.includes(l)) options.push(l);
  }
  return {
    label,
    help: clip(q.description),
    type: ghFieldType(field, label),
    required: Boolean(q.required),
    section,
    options,
  };
}

/** greenhouse `?questions=true` payload → corpus questions + section list */
function normalizeGreenhouse(raw) {
  const questions = [];
  for (const q of raw.questions ?? []) {
    const n = ghQuestion(q, "Application");
    if (n) questions.push(n);
  }
  for (const q of raw.location_questions ?? []) {
    const n = ghQuestion(q, "Location");
    if (n) questions.push(n);
  }
  for (const block of raw.compliance ?? []) {
    const section = `Compliance: ${block.type ?? "unknown"}`;
    for (const q of block.questions ?? []) {
      const n = ghQuestion(q, section);
      if (n) questions.push(n);
    }
  }
  const demo = raw.demographic_questions;
  if (demo) {
    const section = stripHtml(demo.header) || "Demographic Questions";
    for (const q of demo.questions ?? []) {
      const label = stripHtml(q.label);
      if (!label) continue;
      questions.push({
        label,
        help: clip(q.description),
        type: q.type === "multi_value_multi_select" ? "multi_select" : "single_select",
        required: Boolean(q.required),
        section,
        options: (q.answer_options ?? []).map((o) => stripHtml(o.label)).filter(Boolean),
      });
    }
  }
  return questions;
}

const ASHBY_TYPE = {
  StringField: "text",
  LongTextField: "textarea",
  BooleanField: "boolean",
  ValueSelectField: "single_select",
  MultiValueSelectField: "multi_select",
  FileField: "file",
  EmailField: "text",
  PhoneField: "phone",
  UrlField: "url",
  NumberField: "number",
  DateField: "date",
  LocationField: "text",
  SocialLinksField: "url",
  YesNoField: "boolean",
  // a repeating sub-form (school · degree · field · dates) — one field entry, many inputs.
  // Greenhouse spells the same thing out as separate selects, so the corpus keeps it distinct.
  EducationHistoryField: "composite",
  WorkHistoryField: "composite",
};

const unknownTypes = new Set();

/** ashby ApiJobPosting payload → corpus questions (entries repeat across sections; dedupe by id) */
function normalizeAshby(posting) {
  const form = posting?.applicationForm;
  if (!form) return [];
  const seen = new Set();
  const questions = [];
  const push = (entry, section) => {
    if (!entry || seen.has(entry.id)) return;
    seen.add(entry.id);
    if (entry.isHidden === true) return;
    const field = entry.field ?? {};
    const label = stripHtml(field.title) || stripHtml(field.humanReadablePath);
    if (!label) return;
    const kind = field.__autoSerializationID ?? `${field.type}Field`;
    let type = ASHBY_TYPE[kind];
    if (!type) unknownTypes.add(`ashby:${kind}`);
    if (!type) type = "text";
    if (type === "text") type = refineTextType(label, field.path);
    questions.push({
      label,
      help: clip(entry.descriptionHtml),
      type,
      required: Boolean(entry.isRequired),
      section,
      options: (field.selectableValues ?? []).map((v) => stripHtml(v.label ?? v.value)).filter(Boolean),
    });
  };
  for (const section of form.sections ?? []) {
    const title = stripHtml(section.title) || "Application";
    for (const entry of section.fieldEntries ?? []) push(entry, title);
  }
  for (const entry of form.fieldEntries ?? []) push(entry, "Application");
  return questions;
}

const LEVER_TYPE = {
  text: "text",
  textarea: "textarea",
  "multiple-choice": "single_select",
  "multiple-select": "multi_select",
  dropdown: "single_select",
  date: "date",
  file: "file",
  "file-upload": "file",
  url: "url",
  email: "text",
  number: "number",
  yes_no: "boolean",
};

/** `<h4>` headings and `.application-question` blocks of a Lever apply page, in document order */
function leverBlocks(html) {
  const form = html.slice(Math.max(0, html.indexOf('data-qa="application-form"')));
  const marks = [];
  for (const m of form.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>/g)) marks.push({ at: m.index, heading: stripHtml(m[1]) });
  for (const m of form.matchAll(/<(li|div)\s+class="application-question[^"]*"[^>]*>/g)) {
    marks.push({ at: m.index, open: m[0], tag: m[1] });
  }
  marks.sort((a, b) => a.at - b.at);
  const blocks = [];
  let heading = "Application";
  const rename = (h) => (/^submit your application$/i.test(h) ? "Application" : h);
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (mark.heading !== undefined) {
      heading = rename(mark.heading) || heading;
      continue;
    }
    const end = marks[i + 1]?.at ?? form.length;
    blocks.push({ heading, html: form.slice(mark.at, end) });
  }
  return blocks;
}

/** cards[<id>][baseTemplate] hidden inputs → per-field description/required/type */
function leverCardFields(html) {
  const byName = new Map();
  for (const m of html.matchAll(/<input[^>]*name="cards\[([^\]]+)\]\[baseTemplate\]"[^>]*>/g)) {
    const cardId = m[1];
    const value = /value="([^"]*)"/.exec(m[0]);
    if (!value) continue;
    let card;
    try {
      card = JSON.parse(decodeEntities(value[1]));
    } catch {
      continue;
    }
    (card.fields ?? []).forEach((f, idx) => {
      byName.set(`cards[${cardId}][field${idx}]`, { ...f, card: stripHtml(card.text) });
    });
  }
  return byName;
}

function normalizeLever(html) {
  const cardFields = leverCardFields(html);
  const questions = [];
  const seen = new Set();
  for (const block of leverBlocks(html)) {
    const nameMatch = /<(?:input|textarea|select)[^>]*\bname="([^"]+)"/.exec(block.html);
    if (!nameMatch) continue;
    const name = decodeEntities(nameMatch[1]);
    if (name.endsWith("[baseTemplate]") || name === "selectedLocation" || /^(hcaptcha|lever)/i.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const labelMatch = /<div[^>]*class="application-label[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>)?/.exec(block.html);
    const card = cardFields.get(name);
    const labelHtml = String(labelMatch?.[1] ?? "").replace(
      /<span[^>]*class="required"[^>]*>[\s\S]*?<\/span>/gi,
      " ",
    );
    const label = (card ? stripHtml(card.text) : stripHtml(labelHtml)).replace(/[✱*]\s*$/, "").trim();
    if (!label) continue;
    const options = [];
    for (const m of block.html.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g)) {
      const text = stripHtml(m[2]);
      if (text && m[1] !== "" && !options.includes(text)) options.push(text);
    }
    for (const m of block.html.matchAll(/<input[^>]*type="(radio|checkbox)"[^>]*value="([^"]*)"/g)) {
      const text = decodeEntities(m[2]);
      if (text && !options.includes(text)) options.push(text);
    }
    let type;
    if (card) type = LEVER_TYPE[card.type] ?? "text";
    else if (/<textarea/.test(block.html)) type = "textarea";
    else if (/<select/.test(block.html)) type = "single_select";
    else if (/type="checkbox"/.test(block.html)) type = options.length > 1 ? "multi_select" : "boolean";
    else if (/type="radio"/.test(block.html)) type = "single_select";
    else if (/type="file"/.test(block.html)) type = "file";
    else if (name.startsWith("urls[")) type = "url";
    else if (name === "phone") type = "phone";
    else type = "text";
    if (card && !LEVER_TYPE[card.type]) unknownTypes.add(`lever:${card.type}`);
    const required = card ? Boolean(card.required) : /class="required"/.test(block.html);
    questions.push({
      label,
      help: clip(card?.description ?? ""),
      type,
      required,
      section: name.startsWith("eeo[") ? "EEO" : card?.card || block.heading || "Application",
      options,
    });
  }
  return questions;
}

// ───────────────────────────────────── posting fetchers ─────────────────────────────────────

/**
 * The ApiJobPosting document. Loaded on first Ashby fetch, not at import: a checkout without
 * private/ must still be able to run `--families …` over Greenhouse and Lever.
 */
let ashbyQuery = null;
function ashbyDocument() {
  if (ashbyQuery) return ashbyQuery;
  for (const rel of ["eval/fixtures/ashby-query.graphql", "private/o1/ashby-query.graphql"]) {
    const file = path.join(REPO, rel);
    if (fs.existsSync(file)) {
      ashbyQuery = fs.readFileSync(file, "utf8");
      return ashbyQuery;
    }
  }
  throw new Error("no ApiJobPosting document at eval/fixtures/ or private/o1/ashby-query.graphql");
}

async function fetchPosting(company, job) {
  if (company.ats === "greenhouse") {
    const url = `https://boards-api.greenhouse.io/v1/boards/${company.key}/jobs/${job.id}?questions=true&pay_transparency=true`;
    const raw = await httpGet(url);
    if (!raw) return null;
    return {
      title: raw.title ?? job.title,
      location: raw.location?.name?.trim() ?? job.location,
      url: raw.absolute_url ?? job.url,
      questions: normalizeGreenhouse(raw),
    };
  }
  if (company.ats === "ashby") {
    const body = JSON.stringify({
      operationName: "ApiJobPosting",
      variables: { organizationHostedJobsPageName: company.key, jobPostingId: job.id },
      query: ashbyDocument(),
    });
    const raw = await httpGet("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting", {
      body,
      headers: { "content-type": "application/json" },
    });
    const posting = raw?.data?.jobPosting;
    if (!posting) return null;
    return {
      title: posting.title ?? job.title,
      location: posting.locationName ?? job.location,
      url: job.url,
      questions: normalizeAshby(posting),
    };
  }
  const applyUrl = `${job.url.replace(/\/$/, "")}/apply`;
  const html = await httpGet(applyUrl, { json: false, timeout: 90000 });
  if (!html) return null;
  return { title: job.title, location: job.location, url: applyUrl, questions: normalizeLever(html) };
}

// ────────────────────────────── already-recorded schemas (private/o1) ──────────────────────────────

/** "anyscale-1cf38233-8aa0-47f8-9d85-65ce27bc3047" → company "anyscale", id the uuid */
const UUID_SUFFIX = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export function splitCompanyId(base) {
  const uuid = UUID_SUFFIX.exec(base);
  if (uuid) return { company: base.slice(0, uuid.index), id: uuid[1] };
  const dash = base.lastIndexOf("-");
  return dash < 0 ? { company: base, id: "" } : { company: base.slice(0, dash), id: base.slice(dash + 1) };
}

function recordedPostings(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const { company } = splitCompanyId(file.slice(0, -5));
    if (raw.questions) {
      out.push({
        ats: "greenhouse",
        company,
        id: String(raw.id),
        title: raw.title ?? "",
        location: raw.location?.name?.trim() ?? "",
        url: raw.absolute_url ?? "",
        questions: normalizeGreenhouse(raw),
      });
    } else if (raw?.data?.jobPosting) {
      const posting = raw.data.jobPosting;
      out.push({
        ats: "ashby",
        company,
        id: String(posting.id),
        title: posting.title ?? "",
        location: posting.locationName ?? "",
        url: `https://jobs.ashbyhq.com/${company}/${posting.id}`,
        questions: normalizeAshby(posting),
      });
    }
  }
  return out;
}

// ─────────────────────────────────────── corpus writing ───────────────────────────────────────

function recordPath(out, rec) {
  return path.join(out, rec.ats, rec.family, `${rec.company}-${rec.id}.json`);
}

async function writeRecord(out, rec) {
  const file = recordPath(out, rec);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const body = {
    ats: rec.ats,
    company: rec.company,
    family: rec.family,
    title: rec.title,
    location: rec.location,
    url: rec.url,
    questions: rec.questions.map((q) => ({
      label: q.label,
      help: q.help,
      type: q.type,
      required: q.required,
      section: q.section,
      options: q.options,
    })),
    sections: [...new Set(rec.questions.map((q) => q.section))],
    captured: rec.captured,
  };
  await fsp.writeFile(file, `${JSON.stringify(body, null, 2)}\n`);
  return file;
}

/** every corpus record on disk, keyed by "<ats>:<company>:<id>" */
function indexCorpus(out) {
  const index = new Map();
  for (const ats of ATS_ORDER) {
    const atsDir = path.join(out, ats);
    if (!fs.existsSync(atsDir)) continue;
    for (const family of fs.readdirSync(atsDir).sort()) {
      const famDir = path.join(atsDir, family);
      if (!fs.statSync(famDir).isDirectory()) continue;
      for (const file of fs.readdirSync(famDir).sort()) {
        if (!file.endsWith(".json")) continue;
        const { company, id } = splitCompanyId(file.slice(0, -5));
        index.set(`${ats}:${company}:${id}`, { ats, family, company, id, file: path.join(famDir, file) });
      }
    }
  }
  return index;
}

// ────────────────────────────────────────── report ──────────────────────────────────────────

function countsFromIndex(index) {
  const counts = new Map();
  for (const rec of index.values()) {
    const key = `${rec.family}|${rec.ats}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function renderTable(counts, families, target) {
  const width = Math.max(...families.map((f) => f.length), 6) + 1;
  const lines = [];
  lines.push(
    `${"family".padEnd(width)}${ATS_ORDER.map((a) => a.padStart(11)).join("")}${"total".padStart(8)}  status`,
  );
  lines.push("-".repeat(width + 11 * ATS_ORDER.length + 8 + 9));
  const totals = { greenhouse: 0, ashby: 0, lever: 0, all: 0 };
  for (const family of families) {
    const row = ATS_ORDER.map((a) => counts.get(`${family}|${a}`) ?? 0);
    const sum = row.reduce((a, b) => a + b, 0);
    row.forEach((n, i) => { totals[ATS_ORDER[i]] += n; });
    totals.all += sum;
    const status = sum >= target ? "ok" : sum >= Math.ceil(target / 2) ? "thin" : "SHORT";
    lines.push(
      `${family.padEnd(width)}${row.map((n) => String(n).padStart(11)).join("")}${String(sum).padStart(8)}  ${status}`,
    );
  }
  lines.push("-".repeat(width + 11 * ATS_ORDER.length + 8 + 9));
  lines.push(
    `${"TOTAL".padEnd(width)}${ATS_ORDER.map((a) => String(totals[a]).padStart(11)).join("")}${String(totals.all).padStart(8)}`,
  );
  return { text: lines.join("\n"), totals };
}

async function writeHoldout(out, index) {
  const files = [...index.values()].map((r) => path.relative(REPO, r.file)).sort();
  const rng = mulberry32(HOLDOUT_SEED);
  const shuffled = files.map((f) => ({ f, k: rng() })).sort((a, b) => a.k - b.k || a.f.localeCompare(b.f));
  const n = Math.round(files.length * HOLDOUT_FRACTION);
  const holdout = shuffled.slice(0, n).map((x) => x.f).sort();
  await fsp.writeFile(path.join(out, "holdout.txt"), `${holdout.join("\n")}\n`);
  return holdout.length;
}

async function writeReadme(out, index, counts, families, target, companies) {
  const total = index.size;
  const questionTotal = [...index.values()].reduce((sum, rec) => {
    const body = JSON.parse(fs.readFileSync(rec.file, "utf8"));
    return sum + body.questions.length;
  }, 0);
  const rows = families.map((family) => {
    const row = ATS_ORDER.map((a) => counts.get(`${family}|${a}`) ?? 0);
    return `| ${family} | ${row.join(" | ")} | ${row.reduce((a, b) => a + b, 0)} |`;
  });
  const atsTotals = ATS_ORDER.map((a) => [...index.values()].filter((r) => r.ats === a).length);
  const byCompany = new Map();
  for (const rec of index.values()) byCompany.set(rec.company, (byCompany.get(rec.company) ?? 0) + 1);
  const companyNames = new Map(companies.map((c) => [c.slug, c.name]));
  const companyRows = [...byCompany.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([slug, n]) => `${companyNames.get(slug) ?? slug} ${n}`);
  const companyBlock = Array.from({ length: Math.ceil(companyRows.length / 6) }, (_, i) =>
    companyRows.slice(i * 6, i * 6 + 6).join(" · "),
  ).join("\n");
  const text = `# corpus — real application forms, question text only

Input to \`scripts/canon-cluster.mjs\` (docs/PLAN.md §2.7). ${total} public job postings from
${byCompany.size} companies across Greenhouse, Ashby and Lever, carrying ${questionTotal} question
instances. The canonical question bank is derived from these: labels are clustered, the recurring
ones become canonical questions with \`surface_forms\` and \`options_seen\`, and the user pre-answers
those once instead of re-answering every form.

Regenerate with:

    node scripts/canon-scan.mjs --companies private/companies-seed.yml --per-family ${target}

Re-running is idempotent — postings already here are counted, not re-fetched (\`--refresh\` forces).

## What is in a file

\`corpus/<ats>/<family>/<company>-<id>.json\`:

    { ats, company, family, title, location, url,
      questions: [{ label, help, type, required, section, options: [label…] }],
      sections: [title…], captured }

\`family\` comes from \`src/canon/families.mjs\` (deterministic title keywords, no model call).
\`section\` is the form's own grouping (Ashby section, Lever card title, Greenhouse compliance
block), which the clusterer needs as context for an otherwise ambiguous label.
\`type\` uses the FormPlan vocabulary — text · textarea · file · single_select · multi_select ·
boolean · number · date · phone · url — plus \`composite\` for a repeating sub-form that one ATS
models as a single field (Ashby's education/work history; Greenhouse spells the same thing out as
separate selects).

## What is deliberately not in a file

No job description (only per-question \`help\`, truncated to ${HELP_MAX} characters), no applicant
data, no answers, no cookies or tokens, no company-private fields. Everything here is served
publicly and anonymously by the three board APIs to anyone opening the posting.

## Counts

Target: ≥ ${target} postings per family (collection stops at ${Math.ceil(target * 1.25)}).

| family | ${ATS_ORDER.join(" | ")} | total |
|---|---|---|---|---|
${rows.join("\n")}
| **total** | ${atsTotals.join(" | ")} | **${total}** |

Postings per company (${byCompany.size} companies; no single board is more than
${((Math.max(...byCompany.values()) / total) * 100).toFixed(0)}% of the corpus):

${companyBlock}

## Hold-out

\`holdout.txt\` lists a seeded-random ${Math.round(HOLDOUT_FRACTION * 100)}% of the files (seed
0x${HOLDOUT_SEED.toString(16)}, same split every run). \`canon-eval.mjs\` measures coverage on those
files only, so the bank is never evaluated on the postings it was clustered from.

## Licence and provenance

Question labels are factual form field text published by the employer's public job board
(\`boards-api.greenhouse.io\`, \`api.ashbyhq.com\`, \`api.lever.co\`, \`jobs.lever.co/…/apply\`).
They are collected here as short factual excerpts for interoperability research — mapping the
questions an applicant is asked to answers the applicant has already written. Each file keeps the
posting \`url\` so any entry can be traced to its source. Trademarks and role descriptions belong to
their respective companies; no employer endorses this project. Code in this repository is MIT;
this directory is data *about* public forms, not a work of the companies listed.
`;
  await fsp.writeFile(path.join(out, "README.md"), text);
}

// ──────────────────────────────────────────── main ────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const families = args.families ?? FAMILY_IDS;
  const target = args.perFamily;
  const cap = Math.ceil(target * 1.25);
  // No single board API may supply more than half of a family before the others have had their
  // turn: a family that is 25 Greenhouse forms teaches the clusterer one ATS's idea of a form.
  const atsShare = Math.ceil(cap * 0.5);
  const captured = new Date().toISOString().slice(0, 10);
  await fsp.mkdir(args.out, { recursive: true });

  const index = indexCorpus(args.out);
  log(`corpus: ${index.size} postings already on disk`);

  // 0. keep what is on disk consistent with the current taxonomy: when a keyword list changes, a
  //    posting filed under the old family is moved, and one that no longer classifies is dropped.
  let moved = 0;
  let dropped = 0;
  for (const [key, rec] of index) {
    const body = JSON.parse(fs.readFileSync(rec.file, "utf8"));
    const family = classifyTitle(body.title);
    if (family === rec.family) continue;
    await fsp.rm(rec.file, { force: true });
    if (!family) {
      index.delete(key);
      dropped++;
      continue;
    }
    const dest = recordPath(args.out, { ...rec, family });
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, `${JSON.stringify({ ...body, family }, null, 2)}\n`);
    index.set(key, { ...rec, family, file: dest });
    moved++;
  }
  if (moved || dropped) log(`reclassified: ${moved} moved, ${dropped} dropped`);

  // 1. the schemas already recorded under private/o1 — public data, no network
  // One company's 28 near-identical forms teach the clusterer less than 5 companies' 5 — so the
  // recorded schemas go in round-robin by company, under the same family cap and per-ATS share.
  let reused = 0;
  const recorded = [];
  const rankSeen = new Map();
  for (const rec of recordedPostings(args.recorded)) {
    const family = classifyTitle(rec.title);
    if (!family || !families.includes(family) || !rec.questions.length) continue;
    const rankKey = `${family}|${rec.company}`;
    const rank = rankSeen.get(rankKey) ?? 0;
    rankSeen.set(rankKey, rank + 1);
    recorded.push({ ...rec, family, rank });
  }
  recorded.sort((a, b) => a.rank - b.rank || a.family.localeCompare(b.family) || a.company.localeCompare(b.company));
  // The caps are global, not per-phase: a family already holding 25 postings from an earlier run
  // takes no more, whether the next one would come from private/o1 or from a board API.
  const counts = countsFromIndex(index);
  const familyTotal = (family) => ATS_ORDER.reduce((n, a) => n + (counts.get(`${family}|${a}`) ?? 0), 0);
  for (const rec of recorded) {
    const key = `${rec.ats}:${rec.company}:${rec.id}`;
    const existing = index.get(key);
    if (existing && existing.family === rec.family && !args.refresh) continue;
    if (familyTotal(rec.family) >= cap) continue;
    if ((counts.get(`${rec.family}|${rec.ats}`) ?? 0) >= atsShare) continue;
    if (existing && existing.family !== rec.family) await fsp.rm(existing.file, { force: true });
    counts.set(`${rec.family}|${rec.ats}`, (counts.get(`${rec.family}|${rec.ats}`) ?? 0) + 1);
    const file = await writeRecord(args.out, { ...rec, captured });
    index.set(key, { ats: rec.ats, family: rec.family, company: rec.company, id: rec.id, file });
    reused++;
  }
  log(`recorded schemas: ${reused} written from ${path.relative(REPO, args.recorded)}`);

  // 2. board listings
  const companies = loadCompanies(args);
  log(`companies: ${companies.length} boards (${companies.filter((c) => c.source === "seed").length} seed, ${companies.filter((c) => c.source === "extra").length} extra)`);
  const boards = new Map();
  await pool(companies, 6, async (company) => {
    try {
      const jobs = await fetchBoard(company);
      boards.set(company, jobs);
    } catch (err) {
      log(`board FAIL ${company.ats}:${company.key} ${err.message}`);
      boards.set(company, []);
    }
  });

  // 3. candidates per family, round-robin over companies (ATS-interleaved) so no board dominates
  const perFamily = new Map(families.map((f) => [f, []]));
  const ordered = [];
  const byAts = ATS_ORDER.map((a) => companies.filter((c) => c.ats === a).sort((x, y) => x.slug.localeCompare(y.slug)));
  for (let i = 0; ordered.length < companies.length; i++) {
    for (const group of byAts) if (group[i]) ordered.push(group[i]);
  }
  const candidates = [];
  for (const company of ordered) {
    const jobs = (boards.get(company) ?? [])
      .slice()
      .sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }));
    const seenFamily = new Map();
    for (const job of jobs) {
      const family = classifyTitle(job.title);
      if (!family || !perFamily.has(family)) continue;
      const key = `${company.ats}:${company.slug}:${job.id}`;
      if (index.has(key) && !args.refresh) continue;
      const rank = seenFamily.get(family) ?? 0;
      seenFamily.set(family, rank + 1);
      perFamily.get(family).push({ company, job, family, rank });
    }
  }
  for (const [family, found] of perFamily) {
    found.sort((a, b) => a.rank - b.rank);
    const need = Math.max(0, cap - familyTotal(family));
    candidates.push(...found.slice(0, need * 3));
  }
  log(`candidates: ${candidates.length} postings queued`);

  // 4. fetch, ≤3 concurrent per ATS host. Pass 1 gives every ATS an equal share of each family so
  //    the fast board (Greenhouse) cannot fill a family alone; pass 2 tops up whatever is still short.
  let written = 0;
  let failed = 0;
  const attempted = new Set();
  const candidateKey = (c) => `${c.company.ats}:${c.company.slug}:${c.job.id}`;

  async function runPass(atsQuota) {
    const lanes = new Map(ATS_ORDER.map((a) => [a, []]));
    for (const candidate of candidates) {
      if (!attempted.has(candidateKey(candidate))) lanes.get(candidate.company.ats).push(candidate);
    }
    await Promise.all(
      ATS_ORDER.map((ats) =>
        pool(lanes.get(ats), HOST_CONCURRENCY, async (candidate) => {
          const { company, job, family } = candidate;
          if (familyTotal(family) >= cap) return;
          if ((counts.get(`${family}|${ats}`) ?? 0) >= atsQuota) return;
          counts.set(`${family}|${ats}`, (counts.get(`${family}|${ats}`) ?? 0) + 1); // reserve
          attempted.add(candidateKey(candidate));
          try {
            const posting = await fetchPosting(company, job);
            if (!posting || posting.questions.length === 0) throw new Error("no application form");
            const rec = {
              ats,
              company: company.slug,
              family,
              id: job.id,
              title: posting.title,
              location: posting.location,
              url: posting.url,
              questions: posting.questions,
              captured,
            };
            const file = await writeRecord(args.out, rec);
            index.set(candidateKey(candidate), { ats, family, company: company.slug, id: job.id, file });
            written++;
            if (written % 25 === 0) log(`fetched ${written} postings…`);
          } catch (err) {
            counts.set(`${family}|${ats}`, counts.get(`${family}|${ats}`) - 1); // release
            failed++;
            if (failed <= 20) log(`posting FAIL ${ats}:${company.slug}:${job.id} ${err.message}`);
          }
        }),
      ),
    );
  }

  await runPass(atsShare);
  log(`pass 1: ${written} written, ${failed} failed`);
  await runPass(cap);
  log(`fetched: ${written} written, ${failed} failed`);
  if (unknownTypes.size) log(`unmapped field types: ${[...unknownTypes].join(", ")}`);

  // 5. report
  const finalIndex = indexCorpus(args.out);
  const finalCounts = countsFromIndex(finalIndex);
  const holdout = await writeHoldout(args.out, finalIndex);
  await writeReadme(args.out, finalIndex, finalCounts, FAMILY_IDS, target, companies);
  const { text, totals } = renderTable(finalCounts, FAMILY_IDS, target);
  const short = FAMILY_IDS.filter(
    (f) => ATS_ORDER.reduce((n, a) => n + (finalCounts.get(`${f}|${a}`) ?? 0), 0) < target,
  );
  process.stdout.write(`${text}\n\n`);
  process.stdout.write(
    `${totals.all} postings · ${FAMILY_IDS.length - short.length}/${FAMILY_IDS.length} families at ≥ ${target}` +
      `${short.length ? ` · under target: ${short.join(", ")}` : ""}\n`,
  );
  process.stdout.write(`holdout.txt: ${holdout} files (${((holdout / totals.all) * 100).toFixed(1)}%)\n`);
}

main().catch((err) => {
  log(`canon-scan failed: ${err.stack ?? err.message}`);
  process.exit(1);
});
