// The canonical bank's read surface (docs/PLAN.md §2.7): the one place that knows how `canon/`
// is shaped. `scripts/canon-eval.mjs` and `scripts/answers.mjs` both read the bank through here.
//
// `loadCanon` and `canonCandidates` are **re-exported from `src/jev/plan.mjs` on purpose**. Fill
// time owns the candidate set, and a coverage eval that measured a different one would measure the
// wrong thing. `candidatesFor()` is the pre-answer selection — several families at once, no posting
// title — and it is built *on top of* `canonCandidates` rather than beside it, so the layer
// taxonomy keeps exactly one definition: `canonCandidates(canon, {title: "", company})` returns the
// posting-independent layers (core/auth/legal/comp + narrative + a company template) because
// `classifyTitle("")` is null, and the only thing added here is the family membership test — the
// same `row.family === family` test plan.mjs applies to a screening row.
//
// `canonCriterion` and `CRITERION_CHARS` come from there for the same reason: an eval whose
// criteria text differed from fill time's would not be measuring fill time, so there is one
// definition and this module only re-exports it.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { paths } from "../config.mjs";
import { CRITERION_CHARS, canonCandidates, canonCriterion, loadCanon } from "../jev/plan.mjs";
import { normalizeLabel } from "./normalize.mjs";

export { CRITERION_CHARS, canonCandidates, canonCriterion, loadCanon };

/**
 * The eight layers `canon-cluster.mjs` writes, folded into the three groups PLAN §2.7 states its
 * coverage targets for. `auth`/`legal`/`comp` are sub-layers of the universal core: every candidate
 * is asked them, and plan.mjs admits them to the same posting-independent pool as `core`.
 */
export const TARGET_GROUP = Object.freeze({
  core: "core",
  auth: "core",
  legal: "core",
  comp: "core",
  screening: "screening",
  narrative: "narrative",
  eeo: "eeo",
  company: "company",
});

/** PLAN §2.7 hold-out coverage targets, as fractions. */
export const TARGETS = Object.freeze({ core: 0.95, screening: 0.85, narrative: 0.8 });

/**
 * Answer kinds `scripts/answers.mjs` can pre-compute once, before any posting exists.
 * `company` needs the posting (queue time) and `never` is never auto-filled (AGENTS.md), so a
 * question with either kind is mapped-but-not-answerable in the coverage report.
 */
export const PRE_ANSWERABLE = Object.freeze(["constant", "rule", "policy", "narrative"]);

const PRE_ANSWERABLE_SET = new Set(PRE_ANSWERABLE);

export const qidOf = (row) => row?.qid ?? row?.id ?? null;

/** Which of the three target groups a canonical question counts toward. */
export function targetGroup(row) {
  return TARGET_GROUP[String(row?.layer ?? "core")] ?? "core";
}

/** Can this canonical question hold an answer written before the posting is known? */
export function isPreAnswerable(row) {
  return PRE_ANSWERABLE_SET.has(String(row?.kind_default ?? "never"));
}

/** Question instances the corpus recorded for one canonical question. */
export function instancesOf(row) {
  const total = row?.frequency?.total;
  return Number.isFinite(total) ? total : 0;
}

/** `{qid → row}` over the whole bank. */
export function indexByQid(canon) {
  return new Map((canon?.questions ?? []).map((row) => [qidOf(row), row]));
}

/**
 * The canonical questions to pre-answer for a user who works in `families`.
 *
 * Posting-independent layers + narrative come from `canonCandidates` (one definition of the layer
 * taxonomy); the named families' screening rows are added on top. `eeo` is absent for the same
 * reason it is absent at fill time — a demographic row is answered from `p.eeo` and the form's own
 * options (`src/plan/resolve.mjs sensitiveRow()`), never from a canonical mapping.
 *
 * @param {object} canon `loadCanon()` result
 * @param {{families?: string[], family?: string, company?: string|null}} [opts]
 * @returns {object[]} canonical question rows, bank order, no duplicates
 */
export function candidatesFor(canon, { families = [], family = null, company = null } = {}) {
  const wanted = new Set([...families, family].filter(Boolean).map(String));
  const base = canonCandidates(canon, { title: "", company: company ?? "" });
  const seen = new Set(base.map(qidOf));
  const screening = (canon?.questions ?? []).filter((row) => {
    const id = qidOf(row);
    return id != null && !seen.has(id) && wanted.has(String(row.family ?? ""));
  });
  const keep = new Set([...seen, ...screening.map(qidOf)]);
  return (canon?.questions ?? []).filter((row) => keep.has(qidOf(row)));
}

/**
 * Label → canonical question, from the labels the bank *recorded* for each question
 * (`surface_forms`), normalized by the same `normalizeLabel()` that produced them.
 *
 * This is ground truth about what a field **is**, independent of any model: it exists so a
 * coverage eval can say which layer an unmapped field belonged to. It is never a substitute for
 * the mapping itself — the exact-match pass it re-uses is the cheap first pass of
 * `canon-cluster.mjs`, and a hold-out label the corpus never saw simply misses here.
 *
 * Bank order decides collisions, so `core` wins over a family's near-duplicate.
 * @returns {Map<string, string>} normalized label → qid
 */
export function surfaceIndex(canon) {
  const index = new Map();
  for (const row of canon?.questions ?? []) {
    const qid = qidOf(row);
    if (!qid) continue;
    for (const form of row.surface_forms ?? []) {
      const label = typeof form === "string" ? form : (form?.label ?? form?.text);
      if (!label) continue;
      const key = normalizeLabel(label);
      if (key && !index.has(key)) index.set(key, qid);
    }
  }
  return index;
}

/**
 * The bank's header block (`version`, `generated`, `corpus`) — the provenance numbers the coverage
 * line quotes. Only the text before `questions:` is parsed, so this never re-parses the 500 KB body.
 * @returns {Promise<{version?:number, generated?:string, corpus?:{postings:number, instances:number, holdout:number, labels:number}}>}
 */
export async function canonMeta(dir = paths.canon) {
  const raw = await readFile(path.join(dir, "questions.yaml"), "utf8").catch(() => null);
  if (raw == null) return {};
  const head = raw.split(/^questions:/m)[0];
  const parsed = parseYaml(head);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

/** How many real forms the bank was derived from: the build split plus the untouched hold-out. */
export function corpusForms(meta) {
  const corpus = meta?.corpus ?? {};
  const postings = Number(corpus.postings) || 0;
  const holdout = Number(corpus.holdout) || 0;
  return postings + holdout;
}
