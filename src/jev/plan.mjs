// PLAN §2.2 steps 5–7 — the two Jev passes over the rows the deterministic resolver left open.
//
//   request 1  "which canonical question is this field an instance of?" over the candidate canon
//              ids (`canon/questions.yaml`: universal core + the posting's family + narrative +
//              any recorded company template). While that bank is still being built, the documented
//              fallback runs instead: "which saved item answers this field?" over saved story/answer
//              titles, kind-filtered by the field's shape (PLAN §2.2 step 5, last sentence).
//   request 2  select / radio / boolean / multi-select rows that now carry an answer: a Choice over
//              the form's *own* option labels (+ none_of_these), state = {question, answer_text};
//              multi-select gets one Noul per option.
//
// Rules this module keeps (AGENTS.md): Jev only selects — it never writes a value; every Choice
// carries `none_of_these`; every answer is gated through `src/jev/gates.mjs`; every request and
// response is appended to `applications/<slug>/trace.jsonl`.
//
// Two judgments are never merged into one question: "which canonical question is this?" and
// "which saved item answers this?" are separate passes, so a canon miss that falls back to story
// titles costs one extra request (and only for free-text rows, where a story is usable at all).

import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { paths } from "../config.mjs";
import { classifyTitle } from "../canon/families.mjs";
import { answersFor, resolvePreference, usableStories } from "../memory/resolve.mjs";
import { noticeRule, salaryFor, workAuth } from "../memory/derive.mjs";
import { appliedBeforeFor, inOfficeFor, relocationFor } from "../plan/resolve.mjs";
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
// belong to the posting-independent pool alongside `core`. `eeo` is deliberately absent: an EEO row
// is never answered from a canonical mapping — it is skipped unless `p.eeo_policy` says otherwise
// (AGENTS.md), and admitting it here would put demographic questions in front of the selector.
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

/** Saved items Jev may pick from: `use: never` hidden, and never a story naming an excluded org. */
export function storyPool(mem, q) {
  const { kinds, mode } = poolFor(q);
  const never = (resolvePreference(mem, "p.exclusions")?.value?.never_mention ?? []).map((n) => String(n).toLowerCase());
  const rows = usableStories(mem)
    .filter((row) => kinds.includes(String(row?.kind ?? "story")))
    .filter((row) => {
      const hay = `${row?.title ?? ""} ${row?.id ?? ""}`.toLowerCase();
      return !never.some((n) => n && hay.includes(n));
    })
    .slice(0, MAX_CANDIDATES);
  return { rows, mode };
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

  const open = out.filter((d) => d._open && d.action === "ask");
  if (open.length && canon) await canonStage(open, { formPlan, byQid, mem, context, canon, baselines, pipeline, slug, signal, totals });
  const stillOpen = out.filter((d) => d._open && d.action === "ask" && !d.canon);
  const textRows = stillOpen.filter((d) => FREE_TEXT_TYPES.has(byQid.get(d.qid)?.type ?? "text"));
  if (textRows.length) await storyStage(textRows, { formPlan, byQid, mem, slug, signal, totals });

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
    Object.assign(d, canonAnswer(answer.choice, canon, { mem, context, baselines, pipeline, action, limits: byQid.get(d.qid)?.limits }));
  }
}

/** The chosen canonical id → a typed answer from `answers.yaml` (PLAN §2.2 step 5). */
function canonAnswer(qid, canon, { mem, context, baselines, pipeline, action, limits }) {
  const saved = answersFor(mem, qid, { company: context.company, role_family: context.role_family })[0];
  const definition = (canon.questions ?? []).find((row) => (row.qid ?? row.id) === qid);
  const kind = saved?.kind ?? definition?.kind_default ?? "never";
  const why = `canon ${qid}`;

  if (!saved) {
    if (kind === "rule") {
      const ruled = ruleAnswer(definition?.rule_ref ?? qid, { mem, context, baselines, pipeline });
      if (ruled) return ruledRow(ruled, { why, action });
    }
    return { action: "ask", why: `${why} has no saved answer` };
  }
  if (kind === "never") return { action: "ask", why: `${why} is marked never-answer` };
  if (kind === "rule") {
    const ruled = ruleAnswer(saved.rule_ref ?? qid, { mem, context, baselines, pipeline });
    if (!ruled) return { action: "ask", why: `${why}: rule ${saved.rule_ref ?? qid} cannot be evaluated` };
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

/** Length variant by the field's parsed limit (PLAN §2.2 step 5). */
function pickVariant(variants, limits) {
  if (!variants) return null;
  const words = limits?.words ?? (limits?.chars ? Math.round(limits.chars / 6) : null);
  if (words != null && words <= 60) return variants.short ?? variants.medium ?? variants.long ?? null;
  if (words != null && words >= 200) return variants.long ?? variants.medium ?? variants.short ?? null;
  return variants.medium ?? variants.long ?? variants.short ?? null;
}

/**
 * `rule` answers are evaluated here, from the same derivations the deterministic pass uses —
 * `src/plan/resolve.mjs` exports each one, so a canonical row backed by a rule answers exactly what
 * that pass would have answered for the same posting. A ref this cannot evaluate returns null and
 * the caller asks; nothing here defaults or guesses (AGENTS.md).
 */
function ruleAnswer(ruleRef, { mem, context, baselines, pipeline = null }) {
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
  return null;
}

/** A shared derivation's `{value, why, text}` → a rule answer, or null when it had to ask. */
const answered = ({ value, why, text }) => (value == null ? null : { value, why, text });

/** Request 1 fallback — saved-item selection by title, for free-text rows only. */
async function storyStage(rows, { formPlan, byQid, mem, slug, signal, totals }) {
  const state = { job: jobState(formPlan), questions: {} };
  const questions = {};
  const pools = new Map();

  for (const d of rows) {
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

  const answers = await ask({ stage: "saved_items", state, questions, slug, signal, totals });
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

/** Request 2 — the form's own options. Exact (normalised) label equality never needs a model. */
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
