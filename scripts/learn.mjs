#!/usr/bin/env node
// scripts/learn.mjs — fill the private memory store, then say what is still missing.
//
//   learn.mjs --seed DIR                     import a prepared seed (facts, preferences, blobs, docs)
//   learn.mjs --resume cv.pdf [--resume b.pdf] [--links url,url]
//                                            extract proposals from a résumé PDF and public links
//
// One JSON object on stdout: `{status, facts, preferences, documents, stories, echo[], gaps[]}`.
// Logs go to stderr. Exit 0 for every user-facing outcome; exit 1 only for a programmer error.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

import { CONFIG_DIR, paths, slugify } from "../src/config.mjs";
import { BASELINES, installDocument, loadMemory, mergeSection, saveAuxText, upsertRow } from "../src/memory/store.mjs";
import { listFacts, resolvePreference } from "../src/memory/resolve.mjs";
import { noticeRule, workAuthCountries } from "../src/memory/derive.mjs";
import { eeoCanonical, nameSplit } from "../src/plan/resolve.mjs";
import { EEO_VALUES, stamp, validateRow } from "../src/memory/schema.mjs";
import { describeWriter, detectWriter } from "../src/writer/backend.mjs";
import { enrichRows, enrichMemory } from "../src/memory/enrich.mjs";

class Blocked extends Error {}

/** Seed file → section. `documents.yaml` is handled separately: its files are installed first. */
const SEED_SECTIONS = [
  ["facts.yaml", "facts"],
  ["preferences.yaml", "preferences"],
  ["preferences-draft.yaml", "preferences"],
  ["answers.yaml", "answers"],
  ["blobs.yaml", "stories"],
  ["stories.yaml", "stories"],
  ["corrections.yaml", "corrections"],
];

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const log = (line) => process.stderr.write(`${line}\n`);
const short = (p) => (p && p.startsWith(CONFIG_DIR) ? path.relative(CONFIG_DIR, p) : p);

function parseArgs(argv) {
  const args = { seed: null, resumes: [], links: [], answers: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Blocked(`${flag} needs a value`);
      i += 1;
      return v;
    };
    if (flag === "--seed") args.seed = next();
    else if (flag === "--answers") args.answers = next();
    else if (flag === "--backfill") args.backfill = true;
    else if (flag === "--resume") args.resumes.push(next());
    else if (flag === "--links" || flag === "--link") args.links.push(...next().split(",").map((s) => s.trim()).filter(Boolean));
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Blocked(`unknown flag ${flag}`);
  }
  return args;
}

async function readYaml(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  try {
    return YAML.parse(text);
  } catch (err) {
    throw new Blocked(`${path.basename(file)} is not valid YAML: ${err.message}`);
  }
}

const exists = (file) => stat(file).then(() => true, () => false);

// ---------------------------------------------------------------- seed import

/** Copy each seed document into CONFIG_DIR/documents and point its row at the installed copy. */
async function installDocuments(rows, seedDir) {
  const installed = [];
  const missing = [];
  for (const row of rows ?? []) {
    if (!row || typeof row !== "object") continue;
    const base = path.basename(String(row.path ?? row.file ?? ""));
    if (!base) {
      missing.push({ id: row.id ?? "?", why: "row has no path" });
      continue;
    }
    const candidates = [
      row.local_path && path.resolve(seedDir, row.local_path),
      path.join(seedDir, base),
      path.join(path.dirname(seedDir), base), // seed lives beside the files it describes
    ].filter(Boolean);
    let source = null;
    for (const candidate of candidates) if (await exists(candidate)) { source = candidate; break; }
    if (!source) {
      missing.push({ id: row.id ?? base, why: `no local copy of ${base} beside the seed` });
      continue;
    }
    const copy = await installDocument(source);
    const declared = typeof row.sha256 === "string" ? row.sha256 : null;
    if (declared && declared !== copy.sha256) log(`warning: ${base} sha256 differs from the seed's declared digest`);
    installed.push({ ...row, path: copy.path, sha256: copy.sha256, updated: row.updated ?? stamp() });
    log(`installed ${short(copy.path)} (${copy.bytes} bytes)`);
  }
  return { installed, missing };
}

async function importSeed(dir) {
  const seedDir = path.resolve(dir);
  if (!(await exists(seedDir))) throw new Blocked(`seed directory not found: ${dir}`);

  const report = { sections: {}, rejected: [], missingDocuments: [] };

  const documents = await readYaml(path.join(seedDir, "documents.yaml"));
  if (Array.isArray(documents) && documents.length) {
    const { installed, missing } = await installDocuments(documents, seedDir);
    report.missingDocuments = missing;
    if (installed.length) report.sections.documents = await mergeSection("documents", installed);
  }

  for (const [file, section] of SEED_SECTIONS) {
    const rows = await readYaml(path.join(seedDir, file));
    if (!Array.isArray(rows) || !rows.length) continue;
    const result = await mergeSection(section, await enrichRows(section, rows));
    const prev = report.sections[section];
    report.sections[section] = prev
      ? { added: prev.added + result.added, updated: prev.updated + result.updated, kept_user: prev.kept_user + result.kept_user, rejected: [...prev.rejected, ...result.rejected], rows: result.rows }
      : result;
    if (result.rejected.length) report.rejected.push(...result.rejected.map((r) => `${file}: ${r}`));
    log(`${file} → ${section}: +${result.added} new, ${result.updated} updated, ${result.kept_user} kept (user), ${result.rejected.length} rejected`);
  }

  const baselinesFile = path.join(seedDir, BASELINES);
  if (await exists(baselinesFile)) {
    // Copied verbatim: the answering rule lives in this file's comments.
    await saveAuxText(BASELINES, await readFile(baselinesFile, "utf8"));
    log(`${BASELINES} → ${short(path.join(paths.memory, BASELINES))}`);
  }
  return report;
}

// ------------------------------------------------------------- résumé import

/**
 * The extractor this run reads a résumé with. With a writer model configured it is the LLM one
 * (`src/writer/openai.mjs`); with none — a host agent running us, no OpenAI key, no local server
 * — onboarding still has to work, so a deterministic reader takes the name off the top line and
 * the contacts, headings and bullets out of the rest (`src/writer/extract-basic.mjs`). It
 * proposes the same row shapes, the user's own words either way, and the host refines what it got
 * wrong with `remember.mjs`.
 */
async function resumeReader() {
  const backend = detectWriter();
  if (backend.kind === "host") {
    const { extractBasic } = await import("../src/writer/extract-basic.mjs");
    return { how: describeWriter(backend), read: ({ text, pages, doc }) => extractBasic(text, { doc, pages }) };
  }
  const { extractResume } = await importWriter();
  return { how: describeWriter(backend), read: (args) => extractResume(args) };
}

/** `src/writer/openai.mjs` is another slice's file; wait for it rather than duplicating it. */
async function importWriter({ timeoutMs = 5 * 60 * 1000 } = {}) {
  const spec = "../src/writer/openai.mjs";
  const started = Date.now();
  for (;;) {
    try {
      return await import(spec);
    } catch (err) {
      const missing = err?.code === "ERR_MODULE_NOT_FOUND" && String(err.message).includes("writer/openai.mjs");
      if (!missing) throw err;
      if (Date.now() - started > timeoutMs) throw new Blocked("src/writer/openai.mjs never appeared (waited 5 min)");
      log("waiting for src/writer/openai.mjs …");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function pdfText(file) {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: await readFile(file) });
  try {
    const parsed = await parser.getText();
    // Page texts, in order — `extractResume` turns them into `resume:<doc>#p<n>` provenance.
    const pages = (parsed.pages ?? []).map((page) => String(page?.text ?? page ?? ""));
    return { text: parsed.text ?? "", pages };
  } finally {
    await parser.destroy?.();
  }
}

async function linkText(url) {
  const res = await fetch(url, { redirect: "follow", headers: { accept: "text/html,text/plain" } });
  if (!res.ok) throw new Blocked(`${url} → HTTP ${res.status}`);
  const html = await res.text();
  const text = html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 40000);
}

/** The extractor stamps résumé provenance itself; links get theirs here (`link:<url>`). */
function stamped(rows, source) {
  return (rows ?? [])
    .filter((row) => row && typeof row === "object")
    .map((row) => ({ ...row, ...(source ? { source } : {}), updated: row.updated ?? stamp() }));
}

async function importResumes(files, links) {
  const reader = await resumeReader();
  log(`reading résumés with: ${reader.how}`);
  const report = { sections: {}, rejected: [], sources: [] };
  const proposals = { facts: [], stories: [], documents: [] };

  for (const file of files) {
    if (!(await exists(file))) throw new Blocked(`résumé not found: ${file}`);
    const doc = path.basename(file);
    const { text, pages } = await pdfText(file);
    if (!text.trim()) throw new Blocked(`${doc} has no extractable text`);
    const out = await reader.read({ text, pages, doc });
    proposals.facts.push(...stamped(out?.facts));
    proposals.stories.push(...stamped(out?.stories));
    // The file a form will upload, and the digest that makes the next run a diff (PLAN §2.4).
    const copy = await installDocument(file);
    proposals.documents.push({
      id: `doc.resume.${slugify(path.basename(file, path.extname(file)))}`,
      path: copy.path,
      sha256: copy.sha256,
      role_families: [], // which family this résumé is for is the user's call, never guessed
      source: `resume:${doc}`,
      updated: stamp(),
    });
    report.sources.push({ source: `resume:${doc}`, pages: pages.length, chars: text.length, facts: out?.facts?.length ?? 0, stories: out?.stories?.length ?? 0 });
    log(`${doc}: ${pages.length} page(s), ${out?.facts?.length ?? 0} fact + ${out?.stories?.length ?? 0} story proposals → ${short(copy.path)}`);
  }

  for (const url of links) {
    const text = await linkText(url);
    const out = await reader.read({ text, doc: url });
    const tag = `link:${url}`;
    proposals.facts.push(...stamped(out?.facts, tag));
    proposals.stories.push(...stamped(out?.stories, tag));
    report.sources.push({ source: tag, chars: text.length, facts: out?.facts?.length ?? 0, stories: out?.stories?.length ?? 0 });
    log(`${url}: ${out?.facts?.length ?? 0} fact + ${out?.stories?.length ?? 0} story proposals`);
  }

  // `overwriteUser` stays false: a proposal never replaces something the user stated themselves.
  for (const section of ["documents", "facts", "stories"]) {
    if (!proposals[section].length) continue;
    const result = await mergeSection(section, await enrichRows(section, proposals[section]));
    report.sections[section] = result;
    if (result.rejected.length) report.rejected.push(...result.rejected);
    log(`${section}: +${result.added} new, ${result.updated} updated, ${result.kept_user} kept (user), ${result.rejected.length} rejected`);
  }
  return report;
}

// --------------------------------------------------------------------- gaps

/**
 * What memory still cannot answer: the eight day-1 questions (PLAN §2.4), minus the ones already
 * answered, in the words a person would use. Two of the eight only exist when they have to — the
 * contact question when more than one email or phone is on file, the résumé question when more
 * than one document is. Never a guessed value, and nothing else is asked on day 1: everything a
 * form needs beyond this is asked the first time a form asks it.
 *
 * A gap carries `remember_as` wherever the answer has exactly one home, so the host hands answers
 * back to `learn.mjs --answers` keyed by that id. `g.work_auth` has none: its answer is one
 * `f.work_auth.<CC>` row per country the user names.
 */
function gapsFor(mem) {
  const gaps = [];
  const add = (id, ask, remember_as = null) => gaps.push({ id, ask, ...(remember_as ? { remember_as } : {}) });
  const preference = (id) => ({ kind: "preference", id });

  const auth = workAuthCountries(mem);
  if (!auth.countries.length && !auth.hasDefault) {
    add("g.work_auth", "Which countries can you work in right now without anyone sponsoring you, and where would you need sponsorship?");
  }
  if (!noticeRule(mem)) {
    add("g.notice_rule", "How soon could you start — right away, or after a notice period? Say how many weeks.", preference("p.notice_rule"));
  }
  if (!resolvePreference(mem, "p.salary")) {
    add("g.salary", "What pay are you looking for, and in what currency? A range is fine — tell me which end to put on forms.", preference("p.salary"));
  }

  // One id per fact: the seed and `extractResume` both mint the `f.identity.*` namespace.
  const emails = listFacts(mem, "f.identity.email").length;
  const phones = listFacts(mem, "f.identity.phone").length;
  if ((emails > 1 || phones > 1) && !resolvePreference(mem, "p.contact")) {
    add("g.contact", "I found more than one email or phone number. Which ones should applications use?", preference("p.contact"));
  }
  if ((mem.documents?.length ?? 0) > 1 && !resolvePreference(mem, "p.resume_by_role_family")) {
    add("g.resume_by_role_family", "You have more than one résumé. Which should I attach by default, and which for which kind of role?", preference("p.resume_by_role_family"));
  }
  if (!resolvePreference(mem, "p.looking_for")) {
    add("g.looking_for", "What are you looking for? Roles you want, anything you must have, anything you will not take, and where you would work.", preference("p.looking_for"));
  }

  // EEO (PLAN §2.4 item 7, D10). One block, because a form's demographic section is one block and
  // a half-answered `p.eeo` still stops the runner on the field it cannot fill. Asked once: every
  // field may be answered with "decline", which is a stated answer and fills the form's own
  // "decline to self-identify" option — not the same thing as leaving the question unanswered.
  const eeoMissing = missingEeoFields(mem);
  const eeoNamed = EEO_FIELD_ASKS.filter(([field, text]) => text && eeoMissing.includes(field)).map(([, text]) => text);
  if (eeoMissing.length) {
    add(
      "g.eeo",
      [
        eeoNamed.length
          ? `US forms ask about ${eeoNamed.join(", ")}. Answer each one, or say decline —` +
            " either way I fill the box in for you instead of leaving it blank."
          : "",
        eeoMissing.includes("other_demographics")
          ? "Some boards add their own survey questions (sexual orientation, transgender status, age band):" +
            " should I decline those, or ask you each time?"
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      preference("p.eeo"),
    );
  }

  // Auto-submit (PLAN §2.4 item 8). Absent is not "no": the runner stops at ready-to-submit while
  // this is unanswered, and the question is asked until the user says which behaviour they want.
  if (!resolvePreference(mem, "p.auto_submit")) {
    add(
      "g.auto_submit",
      "When nothing is left to ask, should I click Submit myself, or stop just before it so you can look and click? yes/no.",
      preference("p.auto_submit"),
    );
  }

  // Drafting (PLAN §2.2 step 10). Same rule as auto-submit: absent is unanswered, not "no", so a
  // "why us?" or essay prompt keeps coming back to the user until they say I may write it. Every
  // draft is shown under DRAFTED before anything is submitted, and no fact is ever invented.
  if (!resolvePreference(mem, "p.auto_draft")) {
    add(
      "g.auto_draft",
      "Should I write short answers to 'why us' / essay questions for you from your background? yes/no." +
        " You see every one of them before anything is submitted.",
      preference("p.auto_draft"),
    );
  }

  // Which half of a two-token name is the given name. Splitting "<Initial> <Name>" at the space
  // puts the given name in the Last Name box on every Greenhouse form
  // (docs/research/12-eval-judge-round1.md §3.12). `nameRow` fills that split without asking, so
  // unlike everything else cut from day 1 this one has no later ask to fall back on: the runner
  // states the reading it will use here, once, and only for a name it cannot read confidently.
  // Two ids, so no single `remember_as`: the host answers
  // `{"f.identity.first_name": …, "f.identity.last_name": …}`.
  const full = listFacts(mem, "f.identity.full_name")[0];
  const parts = String(full?.value ?? "").trim().split(/\s+/).filter(Boolean);
  const split = parts.length ? nameSplit(parts) : null;
  const statedSplit = listFacts(mem, "f.identity.first_name").length && listFacts(mem, "f.identity.last_name").length;
  if (split?.initialFirst && !statedSplit) {
    add(
      "g.identity.name_split",
      `Your name is on file as two words, one of them a single letter. I will read it as first name "${split.first}",` +
        ` last name "${split.last}" — tell me if that is the wrong way round.`,
    );
  }
  return gaps;
}

/**
 * The demographic fields the EEO block asks about, in the order it asks them, with the phrase each
 * is named by. `other_demographics` carries no phrase: it is a stance, not a value, and the block
 * asks for it in its own sentence.
 */
const EEO_FIELD_ASKS = Object.freeze([
  ["gender", "gender"],
  ["hispanic_latino", "Hispanic/Latino"],
  ["race", "race"],
  ["veteran_status", "veteran status"],
  ["disability_status", "disability status"],
  ["other_demographics", ""],
]);

function missingEeoFields(mem) {
  const stated = resolvePreference(mem, "p.eeo")?.value;
  const block = stated && typeof stated === "object" && !Array.isArray(stated) ? stated : {};
  return EEO_FIELD_ASKS.map(([field]) => field).filter((field) => {
    const value = block[field];
    if (typeof value !== "string" || !value.trim()) return true;
    return !EEO_VALUES[field].includes(value.trim().toLowerCase());
  });
}

/** ≤6 lines, counts and coverage only — never the user's own values. */
function echoFor(mem, baselinesRows) {
  const byArea = {};
  for (const fact of mem.facts ?? []) {
    const area = String(fact.id ?? "").split(".")[1] ?? "?";
    byArea[area] = (byArea[area] ?? 0) + 1;
  }
  const areas = Object.entries(byArea).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`).join(", ");
  const hidden = (mem.stories ?? []).filter((s) => s.use === "never").length;
  const lines = [
    `facts: ${mem.facts.length} (${areas})`,
    `preferences: ${mem.preferences.length}; answers: ${mem.answers.length}`,
    `stories: ${mem.stories.length}${hidden ? ` (${hidden} flagged use:never, kept but never offered)` : ""}`,
  ];
  if (mem.documents.length) lines.push(`documents: ${mem.documents.length} → ${mem.documents.map((d) => short(d.path)).join(", ")}`);
  if (baselinesRows) lines.push(`salary table: ${baselinesRows} rows`);
  return lines.slice(0, 6);
}

// ------------------------------------------------------------------ gap answers

/**
 * `p.eeo` (a mapping) or `p.eeo.<field>` (one answer) → the same value with every demographic
 * field turned into its canonical token, through the maps the resolver reads. Anything else
 * passes through untouched.
 * @returns {{value:any, problem?:string}}
 */
function canonicalEeo(id, value) {
  const field = id === "p.eeo" ? null : id.startsWith("p.eeo.") ? id.slice("p.eeo.".length) : undefined;
  if (field === undefined) return { value };
  if (field) {
    const token = eeoCanonical(field, typeof value === "string" ? value : String(value?.answer ?? value?.value ?? ""));
    return token ? { value: token } : { problem: `no ${field} vocabulary states ${JSON.stringify(String(value).slice(0, 40))}` };
  }
  if (typeof value !== "object" || Array.isArray(value)) return { problem: "p.eeo must be a mapping of fields" };
  const out = {};
  for (const [name, stated] of Object.entries(value)) {
    if (stated === null || stated === undefined || stated === "") continue;
    const token = eeoCanonical(name, typeof stated === "string" ? stated : String(stated));
    if (!token) return { problem: `no ${name} vocabulary states ${JSON.stringify(String(stated).slice(0, 40))}` };
    out[name] = token;
  }
  return { value: out };
}

/**
 * `--answers FILE` — the other half of `gaps[]`. Every gap carries the id its answer belongs
 * under (`remember_as: {kind, id}`), so the host hands the answers back keyed by that id
 * and this writes them: `{"p.eeo": {...}, "p.auto_submit": true, "p.legal.restrictive_agreements":
 * "No", "f.identity.city": "Lisbon"}`. The section comes from the id's own namespace, the row is
 * `source: user`, and `validateRow` decides whether it is storable — a demographic value no
 * vocabulary states is *rejected and reported*, never written and never silently dropped.
 *
 * `remember.mjs` is the free-text verb ("remember I need 4 weeks' notice"); this is the typed one,
 * and the day-1 questionnaire needs typed: `p.eeo` is a mapping of canonical values, not a
 * sentence, and nothing can mint one from prose without guessing.
 */
async function writeAnswers(file) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new Blocked(`--answers: ${file} is not readable JSON (${String(err.message).split("\n")[0].slice(0, 80)})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Blocked("--answers: expected a JSON object of {id: value}");
  const stored = [];
  const rejected = [];
  for (const [id, value] of Object.entries(parsed)) {
    const section = id.startsWith("p.") ? "preferences" : id.startsWith("f.") ? "facts" : null;
    if (!section) {
      rejected.push(`${id}: only p.* (preference) and f.* (fact) ids are written here`);
      continue;
    }
    if (value === null || value === undefined || value === "") {
      rejected.push(`${id}: states no answer`);
      continue;
    }
    // A demographic answer may arrive in the words the user (or a form) used — "Man", "I'm a
    // man" — and memory stores canonical tokens, so it is translated here through the same maps
    // the resolver reads. Wording no map states is rejected and reported, never stored as prose
    // that would make the row ask on every future form.
    const canonical = canonicalEeo(id, value);
    if (canonical.problem) {
      rejected.push(`${id}: ${canonical.problem}`);
      continue;
    }
    const row = { id, value: canonical.value, source: "user", updated: stamp() };
    const problems = validateRow(section, row);
    if (problems.length) {
      rejected.push(`${id}: ${problems[0]}`);
      continue;
    }
    await upsertRow(section, (await enrichRows(section, [row]))[0], { overwriteUser: true });
    stored.push(id);
  }
  return { stored, rejected };
}

// --------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.backfill) { emit(await enrichMemory()); return; }
  if (args.help || (!args.seed && !args.resumes.length && !args.links.length && !args.answers)) {
    throw new Blocked(
      "usage: learn.mjs --seed DIR | learn.mjs --resume cv.pdf [--resume b.pdf] [--links url,url] | learn.mjs --answers answers.json",
    );
  }

  const answered = args.answers ? await writeAnswers(args.answers) : null;
  const report = args.seed
    ? await importSeed(args.seed)
    : args.resumes.length || args.links.length
      ? await importResumes(args.resumes, args.links)
      : { rejected: [], missingDocuments: [] };

  const mem = await loadMemory();
  const baselines = await readYaml(path.join(paths.memory, BASELINES));
  const gaps = gapsFor(mem);
  for (const miss of report.missingDocuments ?? []) {
    gaps.push({ id: `g.document.${miss.id}`, ask: `Where is ${miss.id}? ${miss.why}.` });
  }
  emit({
    // The three statuses every script is bound to (AGENTS.md); the host agent branches on this.
    status: gaps.length ? "needs_user" : "ready_to_submit",
    facts: mem.facts.length,
    preferences: mem.preferences.length,
    documents: mem.documents.length,
    stories: mem.stories.length,
    answers: mem.answers.length,
    ...(answered?.stored.length ? { stored: answered.stored } : {}),
    ...(report.rejected?.length || answered?.rejected.length
      ? { rejected: [...(report.rejected ?? []), ...(answered?.rejected ?? [])].slice(0, 5) }
      : {}),
    echo: echoFor(mem, Array.isArray(baselines?.rows) ? baselines.rows.length : null),
    gaps,
  });
}

main().catch((err) => {
  if (err instanceof Blocked) {
    emit({ status: "blocked", reason: err.message });
    process.exit(0);
  }
  log(err?.stack ?? String(err));
  process.exit(1);
});
