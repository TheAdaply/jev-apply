// PLAN §2.2 steps 5–7 — the Jev passes over the rows the deterministic resolver left open.
// Three requests per posting at most, whatever the form looks like.
//
//   request 1  "which canonical question is this field an instance of?" over the candidate canon
//              ids (`canon/questions.yaml`: universal core + the posting's family + narrative +
//              any recorded company template).
//   request 2  one narrower question for each row request 1 could not answer. Two judgments, never
//              both for the same row: "is this asking for the same information as one of these
//              saved questions?" over narrative + family screening ids, for a field that mapped to
//              a canonical id with nothing saved behind it or is a `company_specific` label the
//              bank does not hold; and the documented fallback "which saved item answers this
//              field?" over saved story/answer titles for everything else free-text (PLAN §2.2
//              step 5, last sentence).
//   request 3  select / radio / boolean / multi-select rows that now carry an answer: a Choice over
//              the form's *own* option labels (+ none_of_these), state = {question, answer_text};
//              multi-select gets one Noul per option.
//
// Rules this module keeps (AGENTS.md): Jev only selects — it never writes a value; every Choice
// carries `none_of_these`; every answer is gated through `src/jev/gates.mjs`; every request and
// response is appended to `applications/<slug>/trace.jsonl`.
//
// Two judgments are never merged into one *question*: "which canonical question is this?" and
// "which saved item answers this?" stay separate asks with their own criteria. They do travel in
// one request when they apply to different rows, which is what keeps a posting inside three.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { paths } from "../config.mjs";
import { classifyTitle } from "../canon/families.mjs";
import { answersFor, getFact, resolvePreference, usableStories } from "../memory/resolve.mjs";
import { fullTimeYears, latestEducation, latestEmployment, locationFact, noticeRule, salaryFor, startDate, workAuth } from "../memory/derive.mjs";
import { acceptsMostRecent, appliedBeforeFor, factText, inOfficeFor, relocationFor } from "../plan/resolve.mjs";
import { optionStating, topicsIn, unmetTopics, vocabFor } from "../canon/normalize.mjs";
// The field's stated limit decides the length variant, and the same rule has to hold in the
// deterministic pass, here, and in the writer — one definition, in the leaf module both import.
import { pickVariant } from "../schema/classes.mjs";
import { appendTrace } from "../browser/trace.mjs";
import { NONE, choice, noul, systemOne, withNone } from "./client.mjs";
import { GATES, gate, runnerUpGap } from "./gates.mjs";

/** ≤255 options per Choice (client.mjs MAX_CHOICES); leave room for `none_of_these`. */
const MAX_CANDIDATES = 200;
/** Criteria are one-liners: a 400-char title is a paragraph, and the estimator bills for it. */
export const CRITERION_CHARS = 320;

const OPTION_TYPES = new Set(["single_select", "multi_select", "boolean"]);
const FREE_TEXT_TYPES = new Set(["text", "textarea", "url", "number", "date", "phone"]);

// ─── canonical bank (absent until Phase Q lands) ──────────────────────────────────────────────

/**
 * Load `canon/questions.yaml` if it exists. Liberal about shape — a top-level list or
 * `{questions: [...]}`, and `layer` matched loosely — so the bank can land without a code change.
 * @returns {Promise<{questions:object[], templates:Record<string,string[]>}|null>} null = not built yet.
 */
export async function loadCanon(dir = paths.canon) {
  const raw = await readFile(path.join(dir, "questions.yaml"), "utf8").catch(() => null);
  if (raw == null) return null;
  const parsed = parseYaml(raw);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.questions) ? parsed.questions : [];
  const questions = list.filter((row) => row && typeof row === "object" && (row.qid ?? row.id));
  return questions.length ? { questions, dir } : null;
}

// The canon bank's layers are core|auth|legal|comp|eeo|narrative|screening|company
// (`src/canon/seed.mjs` LAYERS). `auth`, `legal` and `comp` are asked of every candidate, so they
// belong to the posting-independent pool alongside `core`. `eeo` is deliberately absent: a
// demographic row is answered before any of this, straight from `p.eeo` plus the form's own
// options (`src/plan/resolve.mjs sensitiveRow()`), so it is never open by the time a canonical
// mapping would be asked for — and admitting the layer here would put demographic questions in
// front of the selector for a mapping nothing would use.
const LAYER = {
  core: /^(?:universal[_ -]?)?core$|^universal$|^(?:auth|legal|comp)$/i,
  family: /^(?:family|screening|family[_ -]?screening)$/i,
  narrative: /^narrative$/i,
  company: /^(?:company|template|company[_ -]?template)$/i,
};

/**
 * Candidate canonical ids for one posting: the posting-independent layers (core/auth/legal/comp) +
 * narrative + this family's screening rows + this company's template rows.
 */
export function canonCandidates(canon, { title, company }) {
  const family = classifyTitle(title ?? "");
  const companySlugs = new Set([String(company ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")]);
  return (canon?.questions ?? []).filter((row) => {
    const layer = String(row.layer ?? "core");
    if (LAYER.core.test(layer) || LAYER.narrative.test(layer)) return true;
    if (LAYER.family.test(layer)) return family != null && String(row.family ?? "") === family;
    if (LAYER.company.test(layer)) return companySlugs.has(String(row.company ?? "").toLowerCase());
    return false;
  });
}

const clip = (s, n = CRITERION_CHARS) => {
  const text = String(s ?? "").replace(/\s+/g, " ").trim();
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};

/**
 * Canonical question → its criterion line: the canonical text plus its commonest surface forms.
 * Fill time owns this text, and `src/canon/index.mjs` re-exports it so `scripts/canon-eval.mjs`
 * measures the criteria this pass actually sends — one definition, not two that can drift.
 */
export function canonCriterion(row) {
  const forms = (row?.surface_forms ?? [])
    .map((f) => (typeof f === "string" ? f : (f?.label ?? f?.text)))
    .filter(Boolean)
    .slice(0, 3);
  const text = row?.text ?? row?.qid ?? row?.id;
  return clip(forms.length ? `${text} (also: ${forms.map((f) => `"${f}"`).join(", ")})` : text);
}

// ─── saved-item fallback pool ─────────────────────────────────────────────────────────────────

/**
 * Which saved kinds can answer this field, and therefore which judgment to ask for.
 *
 *   long prompt  → `story|answer`, mode "material": the writer expands the chosen item into the
 *                  answer (PLAN step 10), so the question is which saved work the prompt is about.
 *   one-liner    → `answer` only, mode "stated": a project story pasted into a one-line input is
 *                  not an answer, it is a paragraph in the wrong box — so the item must already
 *                  state the answer.
 *
 * Asking "does this already state the answer?" about a story pool is the wrong judgment: no story
 * *is* a 200-word essay, so every candidate loses to `none_of_these` and a perfectly good match is
 * escalated to the user.
 */
function poolFor(q) {
  const long = q.type === "textarea" || (q.limits?.words ?? 0) >= 50 || (q.limits?.chars ?? 0) >= 400;
  return long ? { kinds: ["story", "answer"], mode: "material" } : { kinds: ["answer"], mode: "stated" };
}

/**
 * Saved items Jev may pick from: `use: never` hidden, and never a story naming an excluded org.
 *
 * A prompt that narrows itself to a topic ("your most complex project with LLM") offers only the
 * items that carry that topic. Titles and tags are the user's own index of their material, so
 * they are consulted first and the item's full text second; an empty pool leaves the row an ask,
 * which is the right answer when nothing on file is about what was asked
 * (docs/research/16-eval-judge-ten.md E3).
 */
export function storyPool(mem, q) {
  const { kinds, mode } = poolFor(q);
  const never = (resolvePreference(mem, "p.exclusions")?.value?.never_mention ?? []).map((n) => String(n).toLowerCase());
  const usable = usableStories(mem)
    .filter((row) => kinds.includes(String(row?.kind ?? "story")))
    .filter((row) => {
      const hay = `${row?.title ?? ""} ${row?.id ?? ""}`.toLowerCase();
      return !never.some((n) => n && hay.includes(n));
    });
  const rows = onTopic(usable, q?.label).slice(0, MAX_CANDIDATES);
  return { rows, mode };
}

/** The items that speak to every topic the label names — by title/tags first, by text second. */
function onTopic(rows, label) {
  if (!topicsIn(label).length) return rows;
  const index = (row) => `${row?.title ?? ""} ${(row?.tags ?? []).join(" ")} ${row?.id ?? ""}`;
  const titled = rows.filter((row) => !unmetTopics(label, index(row)).length);
  if (titled.length) return titled;
  return rows.filter((row) => !unmetTopics(label, `${index(row)} ${row?.text ?? ""}`).length);
}

// ─── option matching ──────────────────────────────────────────────────────────────────────────

/** Whitespace/case/trailing-punctuation normalised — Ashby radios carry `value="on"`, so labels win. */
export function normalizeOption(s) {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?*]+$/g, "")
    .trim()
    .toLowerCase();
}

const optionLabels = (q) => (q.options ?? []).map((o) => (typeof o === "string" ? o : o?.label)).filter(Boolean);

// ─── state builders ───────────────────────────────────────────────────────────────────────────

const fieldState = (q) => ({
  label: q.label,
  type: q.type,
  ...(q.section ? { section: q.section } : {}),
  ...(q.help ? { help: clip(q.help, 400) } : {}),
  ...(q.limits ? { limits: q.limits } : {}),
  ...(optionLabels(q).length ? { options: optionLabels(q).slice(0, 25) } : {}),
});

const jobState = (formPlan) => ({
  title: formPlan?.job?.title ?? "",
  company: formPlan?.job?.company ?? "",
  ...(formPlan?.job?.location ? { location: formPlan.job.location } : {}),
});

// ─── the pass ─────────────────────────────────────────────────────────────────────────────────

/**
 * Ask Jev about the open rows and the option rows, mutating nothing: a new decision list is returned.
 *
 * @param {{formPlan:object, decisions:object[], mem:object, context:object, slug:string,
 *          canon?:object|null, baselines?:object|null, pipeline?:object|null,
 *          signal?:AbortSignal}} args
 * @returns {Promise<{decisions:object[], requests:number, ms:number, usage:object, stages:string[]}>}
 */
export async function planWithJev({ formPlan, decisions, mem, context, slug, canon = null, baselines = null, pipeline = null, signal }) {
  const byQid = new Map((formPlan?.questions ?? []).map((q) => [q.qid, q]));
  const out = decisions.map((d) => ({ ...d }));
  const totals = { requests: 0, ms: 0, usage: { input_tokens: 0, output_tokens: 0 }, stages: [] };

  // Request 1 — the canonical question for the fields the schema describes as ordinary
  // application questions. `company_specific` rows are deliberately held back: they are the
  // widest rows on the form (nothing deterministic applies and the schema says nothing about
  // them), and a request repeats its criteria inside every question it carries, so sending all of
  // them here pushes request 1 past the vendor's token cap and the client splits it in two. They
  // ask the same question one request later instead, which costs no extra round trip and keeps
  // the criteria surface-form-rich — what makes near-duplicate labels resolvable (PLAN §5 risk 8).
  const open = out.filter((d) => d._open && d.action === "ask");
  const wide = new Set(open.filter((d) => byQid.get(d.qid)?.class === "company_specific").map((d) => d.qid));
  const first = open.filter((d) => !wide.has(d.qid));
  if (first.length && canon) await canonStage(first, { formPlan, byQid, mem, context, canon, baselines, pipeline, slug, signal, totals });
  // Request 2 — one more question for every row still open, and never more than one per row.
  await secondPass(out, { formPlan, byQid, mem, context, canon, baselines, pipeline, slug, signal, totals });

  // Rows that stayed open take their class's no-match action (`optional_text` → skip, else ask),
  // and no row is left open afterwards: a re-plan (`--answers`) asks Jev only about what the host
  // just answered, never about a question this run already put to the model.
  for (const d of out) {
    if (!d._open) continue;
    if (d.action === "ask" && d._onNone === "skip") {
      d.action = "skip";
      d.why = "optional — no saved item answers it";
    }
    d._open = false;
  }

  const optionRows = out.filter((d) => {
    const q = byQid.get(d.qid);
    return q && OPTION_TYPES.has(q.type) && optionLabels(q).length && d.value != null && !d.option && d.action !== "skip" && d.action !== "ask";
  });
  if (optionRows.length) await optionStage(optionRows, { formPlan, byQid, slug, signal, totals });

  return { decisions: out, ...totals };
}

/** Request 1 — canonical mapping, then the typed answer the chosen canonical id resolves to. */
async function canonStage(rows, { formPlan, byQid, mem, context, canon, baselines, pipeline, slug, signal, totals }) {
  const candidates = canonCandidates(canon, { title: formPlan?.job?.title, company: formPlan?.job?.company });
  if (!candidates.length) return;
  const criteria = {};
  for (const row of candidates.slice(0, MAX_CANDIDATES)) criteria[row.qid ?? row.id] = canonCriterion(row);

  const state = { job: jobState(formPlan), questions: {} };
  const questions = {};
  for (const d of rows) {
    const q = byQid.get(d.qid);
    state.questions[d.qid] = fieldState(q);
    questions[`canon_${d.qid}`] = choice(
      `Which canonical question is \`questions.${d.qid}\` an instance of? Pick the one asking for the same information.`,
      withNone(criteria, "This field matches none of the canonical questions"),
    );
  }

  const answers = await ask({ stage: "canon", state, questions, slug, signal, totals });
  applyCanonical(rows, answers, { canon, mem, context, baselines, pipeline, byQid });
}

/** A `canon_<qid>` answer → the canonical id and the typed answer it resolves to. */
function applyCanonical(rows, answers, { canon, mem, context, baselines, pipeline, byQid }) {
  for (const d of rows) {
    const answer = answers[`canon_${d.qid}`];
    if (!answer) continue;
    const action = gate(answer);
    d.confidence = round(answer.confidence);
    d.gap = round(runnerUpGap(answer.probabilities, answer.choice));
    if (answer.choice === NONE || action === "ask") {
      d.why = answer.choice === NONE ? "no canonical question matches" : `canonical match too uncertain (${d.confidence})`;
      continue;
    }
    d.canon = answer.choice;
    const q = byQid.get(d.qid);
    const resolved = dateSafe(
      canonAnswer(answer.choice, canon, { mem, context, baselines, pipeline, action, limits: q?.limits, label: q?.label }),
      q,
      { mem, context },
    );
    if (topicGap(d, resolved, { canon, qid: answer.choice, label: q?.label })) continue;
    Object.assign(d, resolved);
    // A canonical id with nothing saved behind it is not an answer. When that id belongs to a
    // layer whose questions are about the *work* — narrative, family screening, this company's own
    // template — the field is very often another phrasing of a prompt the user has answered under
    // a different id, so the rephrasing judgment asks exactly that. A core/auth/legal/comp id is
    // not: nobody's phone number or arbitration stance is hiding in a story. A row answered inside
    // request 2 has no second look left, which is the one-extra-question-per-row budget.
    if (resolved.action === "ask" && REPHRASABLE.test(String(layerOf(canon, answer.choice)))) d._rephrasing = answer.choice;
  }
}

/**
 * The E3 guard: a *qualified* prompt may not be answered out of a topic-free narrative.
 *
 * "What's your most complex project with LLM?" is not "describe your most exceptional work": the
 * qualifier is the question. When the matched canonical question's own text and whatever is saved
 * behind it both never mention the topic the label names, the match is dropped and the row is
 * left open with no canonical id — request 2's saved-item selector then offers only the items
 * that *do* carry the topic (`storyPool`), and with none of those the user is asked
 * (docs/research/16-eval-judge-ten.md E3).
 *
 * This fires whether or not the id had an answer behind it. An id with nothing saved would
 * otherwise go to the rephrasing judgment, whose criteria are other *topic-free* canonical
 * prompts — the same dead end one question later, and it spends the row's one remaining question
 * to get there.
 *
 * Only narrative-layer ids are guarded. A core/auth/comp id answers a fact, and a fact's wording
 * has no reason to repeat the label's topic ("years of GPU experience" → "4").
 *
 * @returns true when the id was dropped, so the caller leaves the row open.
 */
function topicGap(d, resolved, { canon, qid, label }) {
  if (!/^narrative/i.test(String(layerOf(canon, qid)))) return false;
  const definition = (canon?.questions ?? []).find((row) => (row.qid ?? row.id) === qid);
  // The canonical question's *own* text, never its `surface_forms`: those are the real labels the
  // corpus observed under this id, and this very Mistral field is one of them — reading them back
  // would let the label satisfy its own qualifier.
  const offered = `${definition?.text ?? qid} ${resolved._answerText ?? resolved.value ?? ""}`;
  const unmet = unmetTopics(label, offered);
  if (!unmet.length) return false;
  delete d.canon;
  d.action = "ask";
  d.source = "none";
  d.value = undefined;
  d.why = `asks about ${unmet.join("/")}; ${qid} does not answer that`;
  return true;
}

/** Layers whose questions are about the work, and can therefore be asked twice (see `canonStage`). */
const REPHRASABLE = /^(?:narrative|screening|family|company|template)/i;

/** The canon bank's own layer for one id, or "" when the bank does not hold it. */
function layerOf(canon, qid) {
  return (canon?.questions ?? []).find((row) => (row.qid ?? row.id) === qid)?.layer ?? "";
}

/**
 * A canonical answer is text, and a `date` control takes a date. `q.core.start_date` resolves
 * through the answer bank to the user's own prose ("Available immediately"), and round 2 handed
 * that straight to Fireworks' Ashby date input: `unparsable_date`, field empty, row downgraded to
 * `ask` — while `p.notice_rule` could have produced the date all along
 * (docs/research/13-eval-judge-round2.md §2 item 5). The deterministic pass already re-derives
 * this case (`src/plan/resolve.mjs` START_RE, `date` branch); the canonical path is the one that
 * still reached the control, so it gets the same rule.
 */
function dateSafe(resolved, q, { mem, context }) {
  if (resolved?.action !== "fill" && resolved?.action !== "check") return resolved;
  if (q?.control !== "date" && q?.type !== "date") return resolved;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(resolved.value ?? ""))) return resolved;
  const date = startDate(mem, { company: context?.company, role_family: context?.role_family });
  if (date) {
    return { ...resolved, source: "derived", value: date.value, action: "fill", topic: "notice", why: date.why, _answerText: date.value };
  }
  return {
    source: "none",
    value: undefined,
    action: "ask",
    topic: "notice",
    why: "this is a date control, and no start-date fact or p.notice_rule states one",
    remember_as: { kind: "fact", id: "f.identity.start_date", scope: "global" },
  };
}

/**
 * Request 2 — one more question for every row still open, in a single call. Three judgments,
 * each row in exactly one of them, so no field is ever put to the model twice in this request:
 *
 *   canonical   a `company_specific` label request 1 held back → the same question request 1
 *               asks, over the same candidate ids. Held back only to keep either request inside
 *               the vendor token cap (see `planWithJev`); the judgment is identical.
 *   rephrasing  a field request 1 mapped to a canonical question with nothing saved behind it →
 *               "is this asking for the same information as one of these?" over the narrative
 *               prompts and this posting's family screening set. Resolved through `canonAnswer`,
 *               so the value is the user's own saved text (length variant by the field's limit)
 *               or nothing at all.
 *   saved item  anything else still open and free-text → the documented title-selection fallback.
 */
async function secondPass(out, { formPlan, byQid, mem, context, canon, baselines, pipeline, slug, signal, totals }) {
  const open = out.filter((d) => d._open && d.action === "ask");
  if (!open.length) return;

  const held = canon ? open.filter((d) => !d.canon && byQid.get(d.qid)?.class === "company_specific") : [];
  // A row whose label narrows itself to a topic is *not* offered the rephrasing judgment: its
  // criteria are the other canonical prompts, which are topic-free by construction ("describe
  // your most exceptional work"), so the one question this row has left would be spent arriving
  // at an answer about the wrong subject. Mistral's "most complex project with LLM" mapped to a
  // screening id named after that very label with nothing saved behind it, then rephrased onto
  // `q.narrative.exceptional_work` and pasted a GPU-kernel story
  // (docs/research/16-eval-judge-ten.md E3). The saved-item selector — whose pool `storyPool()`
  // narrows to the items carrying that topic — is the judgment this row wants.
  const rephrasing = canon ? open.filter((d) => d._rephrasing && !topicsIn(byQid.get(d.qid)?.label).length) : [];
  const asked = new Set([...held, ...rephrasing].map((d) => d.qid));
  // A `circumstance` row asks for a *fact* about the user. Nothing in the saved-item pool can
  // answer one: a story is material to write prose from, and writing prose about a fact nobody
  // stated is how Mistral's "What spoken languages are you fluent in?" came to be answered from
  // a GPU-inference story (private/eval-shots/ten/findings.md). By the time a circumstance row
  // reaches here the deterministic pass and the canonical mapping have both already failed to
  // find the fact, so the row is the user's to answer.
  const factRows = open.filter((d) => !asked.has(d.qid) && !d.canon && byQid.get(d.qid)?.class === "circumstance");
  for (const d of factRows) {
    if (d.why === "circumstance with no matching rule" || d.why === "no rule matched") {
      d.why = "a fact about you that nothing on file states";
    }
  }
  const skip = new Set(factRows.map((d) => d.qid));
  const items = open.filter(
    (d) =>
      !asked.has(d.qid) &&
      !skip.has(d.qid) &&
      (!d.canon || d._rephrasing) &&
      FREE_TEXT_TYPES.has(byQid.get(d.qid)?.type ?? "text"),
  );
  if (!held.length && !rephrasing.length && !items.length) return;

  const state = { job: jobState(formPlan), questions: {} };
  const questions = {};
  const pools = new Map();
  const candidates = canon ? canonCandidates(canon, { title: formPlan?.job?.title, company: formPlan?.job?.company }) : [];

  if (held.length && candidates.length) {
    const criteria = {};
    for (const row of candidates.slice(0, MAX_CANDIDATES)) criteria[row.qid ?? row.id] = canonCriterion(row);
    for (const d of held) {
      state.questions[d.qid] = fieldState(byQid.get(d.qid));
      questions[`canon_${d.qid}`] = choice(
        `Which canonical question is \`questions.${d.qid}\` an instance of? Pick the one asking for the same information.`,
        withNone(criteria, "This field matches none of the canonical questions"),
      );
    }
  }

  const shared = {};
  for (const row of rephrasing.length ? candidates : []) {
    const layer = String(row.layer ?? "");
    if (REPHRASABLE.test(layer) && !LAYER.company.test(layer)) shared[row.qid ?? row.id] = canonCriterion(row);
  }
  for (const d of rephrasing) {
    const criteria = { ...shared };
    // The id this row already matched has no saved answer; offering it again is a dead end.
    delete criteria[d._rephrasing];
    if (!Object.keys(criteria).length) continue;
    state.questions[d.qid] = fieldState(byQid.get(d.qid));
    questions[`same_${d.qid}`] = choice(
      `Is \`questions.${d.qid}\` asking for the same information as one of these saved questions? Pick one only if answering that question would answer \`questions.${d.qid}\`.`,
      withNone(criteria, "This field asks for something none of these saved questions cover"),
    );
  }

  for (const d of items) {
    const q = byQid.get(d.qid);
    const { rows: pool, mode } = storyPool(mem, q);
    if (!pool.length) continue;
    pools.set(d.qid, new Map(pool.map((row) => [row.id, row])));
    const criteria = {};
    for (const row of pool) criteria[row.id] = clip(row.title ?? row.text);
    state.questions[d.qid] = fieldState(q);
    questions[`item_${d.qid}`] =
      mode === "material"
        ? choice(
            `Which saved item is the material for answering \`questions.${d.qid}\`? Pick the one describing the work this prompt asks about.`,
            withNone(criteria, "No saved item covers what this prompt asks about"),
          )
        : choice(
            `Which saved item already states the answer to \`questions.${d.qid}\`? Pick one only if it answers that exact question.`,
            withNone(criteria, "No saved item answers this; ask the user"),
          );
  }
  if (!Object.keys(questions).length) return;

  const answers = await ask({ stage: "second_look", state, questions, slug, signal, totals });
  applyCanonical(held, answers, { canon, mem, context, baselines, pipeline, byQid });
  applyRephrasing(rephrasing, answers, { canon, mem, context, baselines, pipeline, byQid });
  applySavedItems(items, answers, pools);
}

/**
 * A matched saved question → its own answer, under this field's `why`.
 *
 * Exported for the A21 guard: "the store answers this in other words" is only true when the
 * answer is about what the label asks, and `topicGap` is what makes that a rule rather than a
 * hope (eval/plan.test.mjs).
 */
export function applyRephrasing(rows, answers, { canon, mem, context, baselines, pipeline, byQid }) {
  for (const d of rows) {
    const answer = answers[`same_${d.qid}`];
    if (!answer) continue;
    const action = gate(answer);
    d.confidence = round(answer.confidence);
    d.gap = round(runnerUpGap(answer.probabilities, answer.choice));
    if (answer.choice === NONE || action === "ask") {
      d.why = answer.choice === NONE ? "no saved question asks for the same information" : `rephrasing match too uncertain (${d.confidence})`;
      continue;
    }
    const label = byQid.get(d.qid)?.label;
    const resolved = canonAnswer(answer.choice, canon, {
      mem,
      context,
      baselines,
      pipeline,
      action,
      limits: byQid.get(d.qid)?.limits,
      label,
    });
    if (resolved.action === "ask") {
      d.why = `company question matched ${answer.choice}, which has no saved answer either`;
      continue;
    }
    // Same guard as request 1: a rephrasing is only a rephrasing when it answers the topic the
    // label narrows itself to (E3).
    if (topicGap(d, resolved, { canon, qid: answer.choice, label })) continue;
    Object.assign(d, resolved, { canon: answer.choice, why: `company question matched ${answer.choice}` });
  }
}

/**
 * The chosen canonical id → a typed answer from `answers.yaml` (PLAN §2.2 step 5).
 *
 * A canonical id with no stored row is not automatically an ask: `CANON_RULES` lists the ids the
 * shared derivations answer from memory alone, and those are tried first. That is what makes a
 * store written before a derivation existed — or by a user who never ran `answers.mjs` — answer
 * the same way a freshly generated one does. Nothing is invented on this path: every derivation
 * returns null rather than guess, and the caller then asks.
 */
function canonAnswer(qid, canon, { mem, context, baselines, pipeline, action, limits, label = "" }) {
  const saved = answersFor(mem, qid, { company: context.company, role_family: context.role_family })[0];
  const definition = (canon.questions ?? []).find((row) => (row.qid ?? row.id) === qid);
  const kind = saved?.kind ?? definition?.kind_default ?? "never";
  const why = `canon ${qid}`;

  if (!saved) {
    const ref = definition?.rule_ref ?? CANON_RULES.get(qid) ?? (kind === "rule" ? qid : null);
    const ruled = ref ? ruleAnswer(ref, { mem, context, baselines, pipeline, label }) : null;
    if (ruled) return ruledRow(ruled, { why, action });
    return { action: "ask", why: `${why} has no saved answer` };
  }
  if (kind === "never") return { action: "ask", why: `${why} is marked never-answer` };
  if (kind === "rule") {
    const ref = saved.rule_ref ?? CANON_RULES.get(qid) ?? qid;
    const ruled = ruleAnswer(ref, { mem, context, baselines, pipeline, label });
    if (!ruled) return { action: "ask", why: `${why}: rule ${ref} cannot be evaluated` };
    return ruledRow(ruled, { why, action });
  }
  const value = saved.value ?? pickVariant(saved.variants, limits);
  if (value == null) return { action: "ask", why: `${why} has no text` };
  return { source: "answer", value: String(value), action, why: `${why} (${kind})`, _answerText: String(value) };
}

/**
 * A `rule` answer → decision fields. `exact === false` means the rule answered for a jurisdiction
 * the user never named (their `f.work_auth.default`), so the row is forced to `check` whatever the
 * canon-mapping question's own confidence said: that gate judged the *mapping*, not the country.
 * Same contract as the deterministic pass (`src/plan/resolve.mjs` work-auth rows).
 */
function ruledRow(ruled, { why, action }) {
  return {
    source: "derived",
    value: ruled.value,
    action: ruled.exact === false ? "check" : action,
    why: `${why} → ${ruled.why}`,
    _answerText: ruled.text ?? ruled.value,
  };
}

/**
 * Canonical question id → the derivation that answers it, for the ids whose answer is computed
 * rather than stored. This is the table `src/canon/answers.mjs` writes its `rule` rows from, so
 * the ref a stored row carries and the ref fill time evaluates are the same string by
 * construction — a `rule_ref` that `ruleAnswer()` returns null for is strictly worse than no row
 * at all, because it turns "no saved answer" into "rule cannot be evaluated" and still ends in
 * `ask`. Fill time owns it for the same reason it owns `canonCriterion()`: one definition, not
 * two that can drift.
 */
export const CANON_RULES = new Map([
  ["q.auth.authorized_in_country", "work_auth.authorized_now"],
  ["q.auth.sponsorship_now", "work_auth.sponsorship_now"],
  ["q.auth.sponsorship_future", "work_auth.sponsorship_future"],
  ["q.auth.require_visa_sponsorship_work_selected", "work_auth.sponsorship_future"],
  ["q.core.start_date", "p.notice_rule"],
  ["q.core.notice_period", "p.notice_rule"],
  ["q.comp.expected_salary", "p.salary"],
  ["q.core.relocation", "p.relocation"],
  ["q.core.in_office", "p.in_office"],
  ["q.legal.previously_applied", "applied_before"],
  ["q.core.location_current", "identity.location"],
  ["q.core.address_working", "identity.address"],
  ["q.core.years_experience", "experience.years_total"],
  ["q.core.years_experience_total", "experience.years_total"],
  // Who the user works for, what they are called there and where they studied are read from the
  // employment/education facts at fill time for the same reason the two rows above are: a store
  // written from a CV holds one dated row per role, the newest one changes without anybody
  // editing memory, and a constant copied out of it goes stale the day a job ends
  // (docs/research/16-eval-judge-ten.md E1).
  ["q.core.current_company", "employment.employer"],
  ["q.core.current_title", "employment.title"],
  ["q.core.education_school", "education.school"],
  ["q.core.education_field", "education.field"],
]);

/**
 * `rule` answers are evaluated here, from the same derivations the deterministic pass uses —
 * `src/plan/resolve.mjs` exports each one, so a canonical row backed by a rule answers exactly what
 * that pass would have answered for the same posting. A ref this cannot evaluate returns null and
 * the caller asks; nothing here defaults or guesses (AGENTS.md). Exported so `eval/plan.test.mjs`
 * can check a derivation the recorded fixtures do not happen to ask for (a school, an employer)
 * without a live request.
 */
export function ruleAnswer(ruleRef, { mem, context = {}, baselines = null, pipeline = null, label = "" }) {
  const ref = String(ruleRef ?? "");
  if (/work_auth|authoriz/.test(ref)) {
    const auth = context.country ? workAuth(mem, context.country) : null;
    if (!auth) return null;
    const sponsor = /sponsor/.test(ref);
    const yes = sponsor ? auth.needs_sponsorship_future : auth.authorized_now;
    return {
      value: yes ? "Yes" : "No",
      exact: auth.exact,
      why: auth.exact
        ? `${auth.fact} for ${auth.country}`
        : `from your default rule (no ${auth.country}-specific fact) — ${auth.fact}`,
      text: `${yes ? "Yes" : "No"} — ${sponsor ? "sponsorship" : "authorization"} for ${auth.country}`,
    };
  }
  if (/notice|start/.test(ref)) {
    const rule = noticeRule(mem, { company: context.company, role_family: context.role_family });
    if (!rule) return null;
    const value = rule.text ?? (rule.days === 0 ? "Immediately" : rule.days != null ? `${rule.days} days` : null);
    return value ? { value: String(value), why: `p.notice_rule (${rule.kind})` } : null;
  }
  if (/salary|compensation|pay/.test(ref)) {
    const salary = salaryFor(mem, context.job, baselines);
    return salary.action === "fill" ? { value: salary.formatted ?? String(salary.amount), why: salary.why } : null;
  }
  const scope = { company: context.company, role_family: context.role_family };
  if (/reloc/.test(ref)) return answered(relocationFor(mem, { ...scope, country: context.country }));
  if (/in[_ -]?office/.test(ref)) return answered(inOfficeFor(mem, scope));
  if (/applied/.test(ref)) return answered(appliedBeforeFor(pipeline, context.company));
  // Where the user lives, in their own words. `identity.address` prefers the street address a
  // form asking for one wants, and falls back to the location they stated — the same facts, and
  // the same `check`-when-qualified rule, `src/plan/resolve.mjs identityRow()` applies to a field
  // labelled "Current Location". Tested after `/reloc/`, which also contains "location".
  if (/identity\.address|address_working/.test(ref)) {
    return statedPlace(mem, ["f.identity.address", "f.identity.location", "f.identity.city"]);
  }
  if (/identity\.location|location_current/.test(ref)) {
    return statedPlace(mem, ["f.identity.location", "f.identity.city"]);
  }
  // Total professional experience, counted at fill time from the `since:` dates on the facts that
  // say they are full-time (PLAN §2.1: numbers are code's job, never the model's). Floored, never
  // rounded up: a form answer must not overstate the user's experience by half a year.
  if (/experience\.years_total|years_experience/.test(ref)) {
    const years = fullTimeYears(mem);
    if (!(years > 0)) return null;
    const whole = String(Math.floor(years));
    return { value: whole, why: `${years} yr full-time on file`, text: `${whole} years of full-time professional experience` };
  }
  // The newest dated role / degree the facts state. `employment.*` draws the same line the
  // deterministic pass does: a role whose own dates have closed answers a label that asks for the
  // most recent one and never a label that asks only for a current one, and a value read out of
  // a CV sentence comes back `exact: false`, which commits it as a `check`.
  if (/^employment\./.test(ref)) {
    const part = /title/.test(ref) ? "title" : "employer";
    const latest = latestEmployment(mem);
    const value = latest?.[part] ?? null;
    if (!value) return null;
    if (!latest.current && !acceptsMostRecent(label)) return null;
    const when = latest.current ? `current role since ${latest.since}` : `most recent role, since ${latest.since}`;
    return { value, exact: latest.current && !latest.prose, why: `${latest.id} (${when})` };
  }
  if (/^education\./.test(ref)) {
    const latest = latestEducation(mem);
    const value = latest?.[/field/.test(ref) ? "field" : "school"] ?? null;
    return value ? { value, exact: !latest.prose, why: `${latest.id} (most recent, since ${latest.since})` } : null;
  }
  return null;
}

/**
 * The first of `ids` memory states, as a rule answer. A hedged value comes back `exact: false`.
 *
 * A locality id is filtered through `locationFact()` first: "Remote" is a way of working, and the
 * canonical-answer route used to hand it to a form's geocoder exactly as the deterministic pass
 * once did (docs/research/12-eval-judge-round1.md §3.2). With no place on file this returns null,
 * which is the `ask` the user answers with their city.
 */
function statedPlace(mem, ids) {
  const place = locationFact(mem);
  for (const id of ids) {
    const row = getFact(mem, id);
    const parsed = row ? factText(row) : null;
    if (!parsed?.text) continue;
    // A street address is the answer to "address" whatever it looks like; the two locality ids
    // only answer when `locationFact` says they name somewhere.
    if (id !== "f.identity.address" && place?.id !== id) continue;
    return {
      value: parsed.text,
      text: parsed.text,
      exact: !parsed.qualified,
      why: parsed.qualified ? `${id} (value is qualified — verify)` : id,
    };
  }
  return null;
}

/** A shared derivation's `{value, why, text}` → a rule answer, or null when it had to ask. */
const answered = ({ value, why, text }) => (value == null ? null : { value, why, text });

/** A matched saved item → grounding for the writer, never raw story text in the form. */
function applySavedItems(rows, answers, pools) {
  for (const d of rows) {
    const answer = answers[`item_${d.qid}`];
    if (!answer) continue;
    const action = gate(answer);
    d.confidence = round(answer.confidence);
    d.gap = round(runnerUpGap(answer.probabilities, answer.choice));
    if (answer.choice === NONE) {
      d.why = "no saved item answers this";
      continue;
    }
    if (action === "ask") {
      d.why = `saved-item match too uncertain (${d.confidence})`;
      continue;
    }
    const story = pools.get(d.qid)?.get(answer.choice);
    // Jev selects; it never writes. A matched story is grounding for the writer (PLAN step 10),
    // so the row is a draft — not a fill of raw story text into the form.
    d.source = "story";
    d.action = "draft";
    d.story = answer.choice;
    d.value = undefined;
    d.words = wordCount(story?.text);
    d.why = `story ${clip(story?.title ?? answer.choice, 60)}`;
  }
}

/**
 * Request 3 — the form's own options. Two rungs never need a model: exact (normalised) label
 * equality, and the canonical vocabulary the question belongs to (`src/canon/normalize.mjs`),
 * which maps a saved answer onto a list that spells it differently or does not spell it at all.
 */
async function optionStage(rows, { byQid, slug, signal, totals }) {
  const pending = [];
  for (const d of rows) {
    const q = byQid.get(d.qid);
    const labels = optionLabels(q);
    const exact = labels.find((label) => normalizeOption(label) === normalizeOption(d.value));
    if (exact && q.type !== "multi_select") {
      d.option = exact;
      d.source = d.source === "none" ? "option" : d.source;
      d.why = `${d.why} → option "${clip(exact, 40)}"`;
      continue;
    }
    // The form's own vocabulary, mapped rather than matched. `p.how_heard` states "Company
    // careers page"; 1Password's required 24-entry list has no careers-page entry and does have
    // `Other`, so the row came back empty with "no option states it"
    // (docs/research/13-eval-judge-round2.md §2 item 8). A catch-all pick is committed as a
    // `check` the user sees, never as a silent fill, and an ambiguous list still goes to Jev.
    if (q.type !== "multi_select") {
      const stated = optionStating(vocabFor(d.canon ?? "", [labels]), d.value, labels);
      if (stated) {
        d.option = stated.label;
        d.source = d.source === "none" ? "option" : d.source;
        if (!stated.exact && d.action === "fill") d.action = "check";
        d.why = `${d.why} → ${stated.exact ? "option" : "closest option"} "${clip(stated.label, 40)}"`;
        continue;
      }
    }
    pending.push({ d, q, labels });
  }
  if (!pending.length) return;

  // One request for every option row: the shared state keys each row by qid and each question
  // names its own path, which is how request 1 isolates its questions too (PLAN §2.3).
  const state = { rows: {} };
  const questions = {};
  const traced = { rows: {} };
  for (const { d, q, labels } of pending) {
    const answerText = String(d._answerText ?? d.value);
    state.rows[d.qid] = { question: fieldState(q), answer_text: answerText };
    // The observed text of an EEO answer *is* the answer: the model needs it, the trace does not.
    traced.rows[d.qid] = { question: fieldState(q), answer_text: q.class === "sensitive" ? "<redacted:sensitive>" : answerText };
    if (q.type === "multi_select") {
      labels.forEach((label, i) => {
        questions[`opt_${d.qid}_${i}`] = noul(
          `Does \`rows.${d.qid}.answer_text\` support selecting the option "${label}"?`,
          { true: `The saved answer selects "${label}"`, false: `The saved answer does not select "${label}"` },
        );
      });
      continue;
    }
    const criteria = {};
    labels.forEach((label, i) => {
      criteria[`o${i}`] = clip(label);
    });
    questions[`opt_${d.qid}`] = choice(
      `Which option for \`rows.${d.qid}.question\` states the same answer as \`rows.${d.qid}.answer_text\`?`,
      withNone(criteria, "No option states this answer"),
    );
  }
  const answers = await ask({ stage: "options", state, questions, slug, signal, totals, traceState: traced });

  for (const { d, q, labels } of pending) {
    if (q.type === "multi_select") {
      const picked = [];
      let thin = false;
      labels.forEach((label, i) => {
        const p = answers[`opt_${d.qid}_${i}`]?.noul;
        if (typeof p !== "number") return;
        if (p >= GATES.noulSelect) picked.push(label);
        if (Math.abs(p - GATES.noulSelect) < GATES.checkGap) thin = true;
      });
      if (!picked.length) {
        d.action = "ask";
        d.why = `${d.why} → no option matches`;
        continue;
      }
      d.option = picked.join(" | ");
      if (thin) d.action = "check";
      d.why = `${d.why} → ${picked.length} option(s)`;
      continue;
    }
    const answer = answers[`opt_${d.qid}`];
    if (!answer) continue;
    const action = gate(answer);
    d.confidence = round(answer.confidence);
    d.gap = round(runnerUpGap(answer.probabilities, answer.choice));
    if (answer.choice === NONE || action === "ask") {
      d.action = "ask";
      d.why = `${d.why} → no option states it`;
      continue;
    }
    const index = Number(String(answer.choice).slice(1));
    const label = labels[index];
    if (label == null) {
      d.action = "ask";
      d.why = `${d.why} → option index out of range`;
      continue;
    }
    d.option = label;
    if (action === "check" && d.action === "fill") d.action = "check";
    d.why = `${d.why} → option "${clip(label, 40)}"`;
  }
}

// ─── transport + trace ────────────────────────────────────────────────────────────────────────

/** One Jev call, with its request and its response written to `applications/<slug>/trace.jsonl`. */
async function ask({ stage, state, questions, slug, signal, totals, traceState = null }) {
  await appendTrace(slug, { op: "jev_request", stage, state: traceState ?? state, questions });
  const result = await systemOne({ state, questions, signal });
  await appendTrace(slug, {
    op: "jev_response",
    stage,
    model: result.model,
    ms: result.ms,
    requests: result.requests,
    usage: result.usage,
    answers: result.answers,
  });
  totals.requests += result.requests;
  totals.ms += result.ms;
  totals.usage.input_tokens += result.usage?.input_tokens ?? 0;
  totals.usage.output_tokens += result.usage?.output_tokens ?? 0;
  totals.stages.push(stage);
  return result.answers;
}

const round = (n) => (typeof n === "number" ? Number(n.toFixed(3)) : undefined);
const wordCount = (text) => (text ? String(text).trim().split(/\s+/).filter(Boolean).length : 0);
