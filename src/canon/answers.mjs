// Pre-answering the canonical bank from the user's own memory (docs/PLAN.md §2.4 `answers[]`, §2.7).
//
// `scripts/answers.mjs` is the CLI; everything it decides lives here so the rules are one readable
// list instead of control flow. Four kinds are produced, and nothing else:
//
//   constant   a stated fact, copied. Identity, links, nationality, and the two derivations the
//              runner already treats as mechanical rather than invented — splitting a stated full
//              name (src/plan/resolve.mjs nameRow) and reading a country out of a stated location
//              (src/plan/resolve.mjs countryFromText).
//   rule       nothing stored but a `rule_ref`; the value is computed at fill time from memory plus
//              the posting. Only refs `src/jev/plan.mjs ruleAnswer()` can actually evaluate are
//              written — a row whose ref that function returns null for is strictly worse than no
//              row at all, because it turns "no saved answer" into "rule cannot be evaluated" while
//              still ending in `ask` (see RULES below).
//   policy     the user's standing stance on a gate (EEO, arbitration, consent, AI-usage). Written
//              only where a preference states one; otherwise the question stays an `ask`, which is
//              the AGENTS.md invariant for attestations and demographics.
//   narrative  the only model-written rows. Authored by `src/writer/openai.mjs narrative()` from
//              facts + usable stories (`use: never` excluded), three length variants, `reviewed:
//              false` until the user has read them.
//
// `company` answers need the posting (queue time) and `never` answers are never auto-filled, so
// neither is generated here. No row is ever invented: a canonical question whose backing fact or
// preference is missing is *omitted*, and the omission is reported with the id that would fix it.

import path from "node:path";

import { CONFIG_DIR } from "../config.mjs";
import { OPENAI_MODEL } from "../config.mjs";
import { loadSection, saveSection } from "../memory/store.mjs";
import { isUserSourced, rowKey, stamp, validateRow } from "../memory/schema.mjs";
import { getFact, resolvePreference, usableStories } from "../memory/resolve.mjs";
import { roleFamilyFor, workAuthCountries } from "../memory/derive.mjs";
import { countryFromText, factText } from "../plan/resolve.mjs";
import { narrative } from "../writer/openai.mjs";
import { FAMILIES } from "./families.mjs";
import { candidatesFor, corpusForms, indexByQid, instancesOf, qidOf } from "./index.mjs";

/** Where the one curation pass happens (PLAN §2.7: narratives are shown to the user once). */
export const REVIEW_DIR = path.join(CONFIG_DIR, "review");
export const REVIEW_FILE = path.join(REVIEW_DIR, "narratives.md");

/** Layers whose questions every candidate is asked, so they are pre-answered for everyone. */
export const UNIVERSAL_LAYERS = Object.freeze(["core", "auth", "legal", "comp", "narrative"]);

// ─── constants ────────────────────────────────────────────────────────────────────────────────

/**
 * Canonical question → the fact that answers it. `part` names a mechanical read of a stated value,
 * never an inference about the person:
 *   first/last  the split `src/plan/resolve.mjs nameRow()` already performs on a stated full name.
 *   country     `countryFromText()`, the same table that picks the work-authorization jurisdiction.
 *   degree      the degree level the education fact's own words state (DEGREE_LEVELS below).
 *
 * A qid is listed even when this user has no such fact: the omission list is how `answers.mjs`
 * reports "add `f.identity.address` and this question stops being an ask".
 */
export const CONSTANTS = Object.freeze([
  { qid: "q.core.full_name", facts: ["f.identity.full_name"] },
  { qid: "q.core.first_name", facts: ["f.identity.full_name"], part: "first" },
  { qid: "q.core.last_name", facts: ["f.identity.full_name"], part: "last" },
  { qid: "q.core.preferred_name", facts: ["f.identity.preferred_name"] },
  { qid: "q.core.email", facts: ["f.identity.email"] },
  { qid: "q.core.phone", facts: ["f.identity.phone"] },
  { qid: "q.core.location_current", facts: ["f.identity.location"] },
  { qid: "q.core.country_current", facts: ["f.identity.location"], part: "country" },
  { qid: "q.core.address_working", facts: ["f.identity.address"] },
  { qid: "q.core.linkedin", facts: ["f.identity.linkedin_url"] },
  { qid: "q.core.github", facts: ["f.identity.github_url"] },
  { qid: "q.core.twitter", facts: ["f.identity.x_twitter_url"] },
  { qid: "q.core.website", facts: ["f.identity.site_url"] },
  { qid: "q.core.portfolio", facts: ["f.identity.portfolio_url", "f.identity.site_url"] },
  { qid: "q.core.publications", facts: ["f.identity.publications_url", "f.identity.scholar_url"] },
  { qid: "q.core.current_company", facts: ["f.employment.current"] },
  { qid: "q.core.current_title", facts: ["f.employment.current_title"] },
  { qid: "q.core.education_school", facts: ["f.education.school"] },
  { qid: "q.core.education_field", facts: ["f.education.field"] },
  { qid: "q.core.education_degree", facts: ["f.education."], part: "degree" },
  { qid: "q.auth.nationality", facts: ["f.citizenship"] },
]);

/**
 * Degree levels, most senior first, read out of the words the education fact already uses — so
 * "B.Tech in Computer Science" answers "Bachelor's Degree" and nothing is inferred about a degree
 * the user never stated.
 *
 * Two rules keep this a *read* rather than a guess, and both are load-bearing:
 *   1. No bare two-letter alternation. `b\.?\s?e\.?` matches the ordinary word "be", which would
 *      hand a bachelor's degree to anyone whose education fact is prose — a defaulted personal
 *      fact, which AGENTS.md forbids outright. Two-letter abbreviations must carry their dots.
 *   2. Only the fact's headline is searched (DEGREE_HEAD). An education fact runs a few hundred
 *      characters and mentions other people's degrees ("supervised by a PhD advisor"); the degree
 *      the fact is *about* is the one it opens with.
 */
const DEGREE_LEVELS = Object.freeze([
  [/\b(?:ph\.?d\b|doctorate\b|doctoral\b|d\.phil)/i, "Doctorate (PhD)"],
  [/\b(?:master'?s?\b|m\.?tech\b|m\.?sc\b|mba\b|m\.eng|m\.s\.|m\.a\.)/i, "Master's Degree"],
  [/\b(?:bachelor'?s?\b|b\.?tech\b|b\.?sc\b|b\.eng|b\.s\.|b\.a\.|b\.e\.)/i, "Bachelor's Degree"],
  [/\b(?:associate'?s? degree|diploma)\b/i, "Associate Degree"],
  [/\b(?:high school|secondary school|senior secondary)\b/i, "High School"],
]);

/** The headline of an education fact: up to the first separator, and never past 80 characters. */
const DEGREE_HEAD = (text) => String(text).split(/[,;—\n(]/)[0].slice(0, 80);

let regionNames = null;
function countryName(code) {
  if (!code) return null;
  regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The stated value for one CONSTANTS entry, or null when memory does not state it. */
function constantValue(mem, spec) {
  if (spec.part === "degree") {
    const stated = (mem?.facts ?? [])
      .filter((row) => String(row?.id ?? "").startsWith(spec.facts[0]))
      .map((row) => DEGREE_HEAD(factText(row)?.text ?? ""));
    for (const [re, level] of DEGREE_LEVELS) if (stated.some((text) => re.test(text))) return { value: level, from: "f.education.*" };
    return null;
  }
  const row = spec.facts.map((id) => getFact(mem, id)).find((r) => r?.value != null);
  if (!row) return null;
  const stated = factText(row)?.text;
  if (!stated) return null;
  if (spec.part === "first" || spec.part === "last") {
    const parts = String(stated).split(/\s+/).filter(Boolean);
    if (parts.length < 2) return null; // one token: the split is not stated, so it is not answered
    return { value: spec.part === "first" ? parts[0] : parts.slice(1).join(" "), from: row.id };
  }
  if (spec.part === "country") {
    // The plain value first. A location fact often reads "Remote (Lisbon, Portugal — …)": the
    // runner fills "Remote" and flags it, but the country the user stated is in the note, so the
    // whole stated string is the fallback. Only ever the user's own words, never a neighbouring
    // country — `countryFromText` returns null rather than guess, and then so does this.
    const code = countryFromText(stated) ?? countryFromText(row.value);
    const name = countryName(code);
    return name ? { value: name, from: row.id } : null;
  }
  return { value: String(stated), from: row.id };
}

// ─── rules ────────────────────────────────────────────────────────────────────────────────────

/**
 * Canonical question → the derivation that answers it at fill time.
 *
 * `ref` is what lands in the row's `rule_ref`, and it is chosen so that `ruleAnswer()` in
 * src/jev/plan.mjs resolves it: that function dispatches on `/work_auth|authoriz/`, `/notice|start/`,
 * `/salary|compensation|pay/`, `/reloc/`, `/in[_ -]?office/` and `/applied/`, and treats a ref
 * containing `sponsor` as the sponsorship half of the two-valued work-authorization fact. `helper`
 * names the function the ref reaches — `src/memory/derive.mjs` for the first three, and the shared
 * derivations `src/plan/resolve.mjs` exports for the last three, so a rule row answers exactly what
 * the deterministic pass would have answered for the same posting.
 *
 * A row is only written when memory — or, for `applied_before`, the pipeline — carries what the
 * rule reads: a ref that resolves to null turns "no saved answer" into "rule cannot be evaluated"
 * while still ending in `ask`, which is strictly worse than no row at all.
 */
export const RULES = Object.freeze([
  { qid: "q.auth.authorized_in_country", ref: "work_auth.authorized_now", helper: "workAuth", needs: "work_auth" },
  { qid: "q.auth.sponsorship_now", ref: "work_auth.sponsorship_now", helper: "workAuth", needs: "work_auth" },
  { qid: "q.auth.sponsorship_future", ref: "work_auth.sponsorship_future", helper: "workAuth", needs: "work_auth" },
  { qid: "q.auth.require_visa_sponsorship_work_selected", ref: "work_auth.sponsorship_future", helper: "workAuth", needs: "work_auth" },
  { qid: "q.core.start_date", ref: "p.notice_rule", helper: "noticeRule", needs: "p.notice_rule" },
  { qid: "q.core.notice_period", ref: "p.notice_rule", helper: "noticeRule", needs: "p.notice_rule" },
  { qid: "q.comp.expected_salary", ref: "p.salary", helper: "salaryFor", needs: "p.salary" },
  { qid: "q.core.relocation", ref: "p.relocation", helper: "relocationFor", needs: "p.relocation" },
  { qid: "q.core.in_office", ref: "p.in_office", helper: "inOfficeFor", needs: "p.in_office" },
  { qid: "q.legal.previously_applied", ref: "applied_before", helper: "appliedBeforeFor", needs: "pipeline" },
]);

/**
 * What a rule reads, as the row's `source` token — or null when nothing backs it, in which case the
 * row is omitted and the id that would fix it is reported instead.
 */
function ruleBacking(mem, needs, pipeline) {
  if (needs === "work_auth") {
    const { countries, hasDefault } = workAuthCountries(mem) ?? {};
    return (countries?.length || hasDefault) ? "fact:f.work_auth" : null;
  }
  // The pipeline is the only backing that is not a memory row, and an empty one answers nothing:
  // `appliedBeforeFor` asks rather than reading "no record" as "never applied".
  if (needs === "pipeline") {
    return (Array.isArray(pipeline) ? pipeline : (pipeline?.jobs ?? [])).length ? "pipeline" : null;
  }
  return resolvePreference(mem, needs) ? `fact:${needs}` : null;
}

// ─── policies ─────────────────────────────────────────────────────────────────────────────────

/**
 * Gate questions and the preference that states the user's standing answer. Every one of these is
 * an `ask` until the user states a stance, and the stance is only ever theirs (AGENTS.md: the
 * runner never answers a policy or attestation on its own).
 *
 * No `q.eeo.*` question is listed, and none ever should be. A demographic row is not answered from
 * `answers.yaml` at all: `src/plan/resolve.mjs sensitiveRow()` reads `p.eeo_policy` directly and
 * skips the whole section when it is absent, which keeps demographic questions out of the selector
 * and out of this file.
 */
export const POLICIES = Object.freeze([
  { qid: "q.legal.arbitration", pref: "p.arbitration" },
  { qid: "q.legal.privacy_consent", pref: "p.privacy_consent" },
  { qid: "q.legal.ai_policy_attestation", pref: "p.ai_usage" },
  { qid: "q.legal.ai_tools_consent", pref: "p.ai_usage" },
  { qid: "q.legal.interview_recording_consent", pref: "p.recording_consent" },
  { qid: "q.legal.background_check", pref: "p.background_check" },
  { qid: "q.legal.application_truthful", pref: "p.application_truthful" },
  { qid: "q.legal.age_18", pref: "p.age_18" },
  { qid: "q.legal.export_control", pref: "p.export_control" },
  { qid: "q.legal.government_official", pref: "p.government_official" },
  { qid: "q.legal.conflict_of_interest", pref: "p.conflict_of_interest" },
  { qid: "q.legal.restrictive_agreements", pref: "p.restrictive_agreements" },
  { qid: "q.core.accommodation_request", pref: "p.accommodation" },
]);

const stanceOf = (value) => {
  if (value == null) return null;
  if (typeof value === "object") return value.answer ?? value.value ?? null;
  return String(value);
};

// ─── narratives ───────────────────────────────────────────────────────────────────────────────

/**
 * Prompts whose answer changes with the kind of work applied for, so they get one row per role
 * family. The rest are about the person, not the job, and one global row serves every posting.
 */
export const FAMILY_FLAVOURED = new Set([
  "q.narrative.why_role",
  "q.narrative.proudest_project",
  "q.narrative.exceptional_work",
  "q.narrative.hardest_problem",
  "q.narrative.looking_for",
]);

/** A file upload is answered from `documents[]`, never from stored text. */
const isFileShaped = (row) => row?.answer_shape === "file" || row?.type === "file";

/**
 * The role-family name *memory* uses for a canon family.
 *
 * `answersFor()` compares `answers[].family` with the posting's `roleFamilyFor(mem, job)`, which
 * reads `p.looking_for.role_families` — the user's own vocabulary, not `src/canon/families.mjs`.
 * Tagging a row `research_engineer` when the user calls that work `ml_researcher` produces a row
 * that never resolves, so the canon family is translated through the user's own phrase lists here:
 * each of the canon family's title keywords is classified by memory, and the majority answer wins.
 * No match → the canon id, unchanged.
 */
export function memoryFamily(mem, canonFamily) {
  const votes = new Map();
  for (const keyword of FAMILIES[canonFamily]?.title_keywords ?? []) {
    const family = roleFamilyFor(mem, { title: keyword });
    if (family) votes.set(family, (votes.get(family) ?? 0) + 1);
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0];
  return best ? best[0] : canonFamily;
}

/**
 * Every narrative row to author, deduplicated by the key it will be stored under.
 * @returns {Array<{qid:string, prompt:string, family:string|null, canonFamily:string|null, frequency:number}>}
 */
export function narrativePrompts(canon, mem, families) {
  const wanted = families.map((f) => ({ canon: f, memory: memoryFamily(mem, f) }));
  const out = new Map();
  const add = (row, family, canonFamily) => {
    const key = `${qidOf(row)}|${family ?? ""}`;
    if (out.has(key)) return;
    out.set(key, { qid: qidOf(row), prompt: row.text ?? qidOf(row), family, canonFamily, frequency: instancesOf(row) });
  };

  for (const row of candidatesFor(canon, { families })) {
    if (row.kind_default !== "narrative" || isFileShaped(row)) continue;
    if (row.layer === "screening") {
      const match = wanted.find((w) => w.canon === row.family);
      add(row, match?.memory ?? row.family, row.family);
    } else if (FAMILY_FLAVOURED.has(qidOf(row))) {
      for (const w of wanted) add(row, w.memory, w.canon);
    } else {
      add(row, null, null);
    }
  }
  return [...out.values()].sort((a, b) => b.frequency - a.frequency || a.qid.localeCompare(b.qid) || String(a.family).localeCompare(String(b.family)));
}

// ─── row builders ─────────────────────────────────────────────────────────────────────────────

const baseRow = (qid, kind, source, { family = null, date } = {}) => ({
  qid,
  kind,
  scope: "global",
  ...(family ? { family } : {}),
  source,
  reviewed: false,
  updated: date,
});

/**
 * Constant and rule rows, plus the questions that were left out and the memory id that would fix
 * each one. `source: fact:<id>` is PLAN §2.4's own token for "this answer came from memory row id";
 * the one rule the pipeline backs (`applied_before`) carries PLAN §2.4's `pipeline` token instead.
 * @param {{date?:string, pipeline?:object|null}} opts `pipeline` is `loadPipeline()`'s record.
 * @returns {{rows: object[], omitted: Array<{qid:string, need:string}>}}
 */
export function factRows(canon, mem, { date = stamp(), pipeline = null } = {}) {
  const bank = indexByQid(canon);
  const rows = [];
  const omitted = [];

  for (const spec of CONSTANTS) {
    if (!bank.has(spec.qid)) continue;
    const found = constantValue(mem, spec);
    if (!found) {
      omitted.push({ qid: spec.qid, need: spec.facts[0] });
      continue;
    }
    rows.push({ ...baseRow(spec.qid, "constant", `fact:${found.from}`, { date }), value: found.value });
  }

  for (const rule of RULES) {
    if (!bank.has(rule.qid)) continue;
    const backing = ruleBacking(mem, rule.needs, pipeline);
    if (!backing) {
      omitted.push({ qid: rule.qid, need: rule.needs });
      continue;
    }
    rows.push({ ...baseRow(rule.qid, "rule", backing, { date }), rule_ref: rule.ref });
  }
  return { rows, omitted };
}

/** Policy rows — one per gate the user has stated a standing answer for. */
export function policyRows(canon, mem, { date = stamp() } = {}) {
  const bank = indexByQid(canon);
  const rows = [];
  const omitted = [];
  for (const spec of POLICIES) {
    if (!bank.has(spec.qid)) continue;
    const pref = resolvePreference(mem, spec.pref);
    const stance = stanceOf(pref?.value);
    if (stance == null || stance === "") {
      omitted.push({ qid: spec.qid, need: spec.pref });
      continue;
    }
    rows.push({ ...baseRow(spec.qid, "policy", `fact:${spec.pref}`, { date }), value: String(stance) });
  }
  return { rows, omitted };
}

/**
 * Author every narrative row. One `writer.narrative()` call per prompt, grounded on the user's facts
 * and their usable stories only (`use: never` rows are filtered out by `usableStories`). A prompt
 * whose draft cannot pass the writer's own grounding checks yields **no row** — never a placeholder.
 *
 * @returns {Promise<{rows: object[], failed: Array<{qid:string, family:string|null, reason:string}>}>}
 */
export async function narrativeRows(
  prompts,
  { mem, model = OPENAI_MODEL, date = stamp(), concurrency = 4, signal, onProgress } = {},
) {
  const facts = mem?.facts ?? [];
  const stories = usableStories(mem);
  if (!facts.length && !stories.length) {
    return { rows: [], failed: prompts.map((p) => ({ qid: p.qid, family: p.family, reason: "memory holds no facts or usable stories" })) };
  }

  const rows = [];
  const failed = [];
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(concurrency, prompts.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= prompts.length) return;
      const spec = prompts[i];
      try {
        const variants = await narrative({ prompt: spec.prompt, facts, stories, family: spec.family ?? undefined, model, signal });
        rows.push({ ...baseRow(spec.qid, "narrative", `authored:${model}@${date}`, { family: spec.family, date }), variants });
      } catch (err) {
        failed.push({ qid: spec.qid, family: spec.family, reason: err?.message ?? String(err) });
      }
      onProgress?.({ done: ++done, total: prompts.length, qid: spec.qid, family: spec.family });
    }
  });
  await Promise.all(workers);
  rows.sort((a, b) => a.qid.localeCompare(b.qid) || String(a.family ?? "").localeCompare(String(b.family ?? "")));
  return { rows, failed };
}

// ─── store ────────────────────────────────────────────────────────────────────────────────────

/**
 * Merge generated rows into `memory/answers.yaml`. A row the user has already read (`reviewed:
 * true`) or written (`source: user`) is never overwritten — re-running `answers.mjs` after a
 * curation pass must not silently undo it.
 * @returns {Promise<{added:number, updated:number, kept:number, rejected:string[], rows:number}>}
 */
export async function mergeAnswers(incoming) {
  const existing = await loadSection("answers");
  const index = new Map(existing.map((row, i) => [rowKey("answers", row), i]));
  const result = { added: 0, updated: 0, kept: 0, rejected: [] };

  for (const row of incoming ?? []) {
    const problems = validateRow("answers", row);
    if (problems.length) {
      result.rejected.push(`${row?.qid ?? "?"}: ${problems[0]}`);
      continue;
    }
    const key = rowKey("answers", row);
    const at = index.get(key);
    if (at === undefined) {
      existing.push(row);
      index.set(key, existing.length - 1);
      result.added += 1;
      continue;
    }
    const current = existing[at];
    if (current?.reviewed === true || isUserSourced(current)) {
      result.kept += 1;
      continue;
    }
    existing[at] = { ...current, ...row };
    result.updated += 1;
  }
  await saveSection("answers", existing);
  return { ...result, rows: existing.length };
}

/**
 * "answers ready for X% of questions seen in N real forms; M narratives to review".
 *
 * X weights every canonical question by the instances the corpus actually recorded for it, so a
 * question five hundred forms ask counts five hundred times and a one-off counts once. The
 * denominator is the whole bank — every question the 500 recorded forms asked, including the
 * nineteen families this user did not pre-answer and the EEO rows that are never auto-filled.
 */
export function coverageLine(canon, rows, meta) {
  const answered = new Set((rows ?? []).filter((r) => r?.kind !== "never").map((r) => r.qid));
  let covered = 0;
  let total = 0;
  for (const row of canon?.questions ?? []) {
    const n = instancesOf(row);
    total += n;
    if (answered.has(qidOf(row))) covered += n;
  }
  const pct = total ? Math.round((covered / total) * 100) : 0;
  const toReview = (rows ?? []).filter((r) => r?.kind === "narrative" && r?.reviewed !== true).length;
  return `answers ready for ${pct}% of questions seen in ${corpusForms(meta)} real forms; ${toReview} narratives to review`;
}

// ─── curation ─────────────────────────────────────────────────────────────────────────────────

const MARKER = /^<!-- answer: ([^|\s]+)(?: \| ([^->]*?))? -->$/;

const words = (text) => String(text ?? "").trim().split(/\s+/).filter(Boolean).length;

/** Stable key for one narrative row: the qid plus the role family it was written for. */
export const reviewKey = (row) => `${row?.qid}|${row?.family ?? ""}`;

/**
 * The one curation pass (PLAN §2.4: narrative answers are shown to the user **once**). Every
 * narrative row is listed with its prompt and its medium variant, which is the one PLAN §2.7 caps
 * at 150 words and the one `--accept` reads back.
 */
export function renderReview(rows, canon, { date = stamp() } = {}) {
  const bank = indexByQid(canon);
  const narratives = (rows ?? []).filter((r) => r?.kind === "narrative");
  const head = [
    "# Narrative answers — one review pass",
    "",
    `Written ${date} from your own facts and stories. Edit any paragraph below, keep the`,
    "`<!-- answer: … -->` lines exactly as they are, then run:",
    "",
    "    node scripts/answers.mjs --accept ~/.config/jev-apply/review/narratives.md",
    "",
    "A paragraph you change is stored as yours (`source: user`); one you leave alone is stored as",
    "reviewed. Nothing here is on a form yet — these are the answers the runner reaches for when a",
    "posting asks the question above it.",
    "",
    `${narratives.length} answer${narratives.length === 1 ? "" : "s"} to read.`,
    "",
  ];
  const body = narratives.map((row) => {
    const prompt = bank.get(row.qid)?.text ?? row.qid;
    const text = row.variants?.medium ?? row.variants?.long ?? row.variants?.short ?? row.value ?? "";
    return [
      `<!-- answer: ${row.qid}${row.family ? ` | ${row.family}` : ""} -->`,
      `## ${prompt}`,
      `*${row.family ? `${row.family} · ` : ""}${words(text)} words · ${row.qid}*`,
      "",
      String(text).trim(),
      "",
    ].join("\n");
  });
  return `${head.join("\n")}\n${body.join("\n---\n\n")}`;
}

/**
 * Read an edited review file back.
 * @returns {Map<string, string>} `qid|family` → the paragraph as the user left it.
 */
export function parseReview(text) {
  const out = new Map();
  let key = null;
  let buffer = [];
  const flush = () => {
    if (!key) return;
    const body = buffer
      .join("\n")
      .replace(/^\s*##[^\n]*\n/, "")
      .replace(/^\s*\*[^\n]*\*\s*\n/m, "")
      .replace(/\n\s*---\s*$/, "")
      .trim();
    if (body) out.set(key, body);
    buffer = [];
  };
  for (const line of String(text ?? "").split("\n")) {
    const marker = MARKER.exec(line.trim());
    if (marker) {
      flush();
      key = `${marker[1]}|${(marker[2] ?? "").trim()}`;
      continue;
    }
    if (key) buffer.push(line);
  }
  flush();
  return out;
}

/**
 * Apply an edited review file to the stored answers.
 * A paragraph the user changed becomes theirs (`source: user`, medium variant replaced); one they
 * left alone is simply marked `reviewed: true`. Both are then immune to the next generation run.
 * @returns {Promise<{reviewed:number, edited:number, unknown:string[]}>}
 */
export async function acceptReview(text, { date = stamp() } = {}) {
  const edits = parseReview(text);
  const rows = await loadSection("answers");
  const byKey = new Map(rows.filter((r) => r?.kind === "narrative").map((r) => [reviewKey(r), r]));
  const result = { reviewed: 0, edited: 0, unknown: [] };

  for (const [key, body] of edits) {
    const row = byKey.get(key);
    if (!row) {
      result.unknown.push(key);
      continue;
    }
    const current = String(row.variants?.medium ?? row.value ?? "").trim();
    if (body !== current) {
      row.variants = { ...(row.variants ?? {}), medium: body };
      row.source = "user";
      result.edited += 1;
    }
    row.reviewed = true;
    row.updated = date;
    result.reviewed += 1;
  }
  await saveSection("answers", rows);
  return result;
}
