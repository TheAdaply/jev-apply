// PLAN §2.2 step 10 — the writer, as the runner calls it.
//
// Jev selects; it never writes. Everything a form asks that no saved item answers used to leave
// as an `ask`, which on eleven measured postings meant zero OpenAI calls and four required
// "why this company" / essay boxes handed back to the user
// (docs/research/12-eval-judge-round1.md §4.1). With `p.auto_draft` on, those rows arrive here as
// `action:"draft"` and leave with text on them.
//
// What this module will and will not do:
//   * It writes only from the posting's own text and the candidate's own saved material. Every
//     number and every organisation/product name in the draft must appear in that grounding
//     (`groundingCheck`), and no other company from the pipeline may appear (`substitutionCheck`).
//   * It enforces the field's printed limit. The spacexai essay in round 1 was 140 words against
//     a printed "100 words or less"; a cap the form states is not advisory.
//   * It never guesses a fact. A row it cannot ground goes back to `ask` carrying the reason, so
//     the user answers it — the no-defaults invariant is not suspended because a model is available.
//
// The row keeps `action:"draft"` once it has text: `runnable()` (src/plan/execute.mjs) types it
// into the control and reads it back like any other value, and the summary still lists it under
// ► DRAFTED with its word count so the user sees what was written on their behalf before Submit.

import { resolvePreference, usableStories } from "../memory/resolve.mjs";
import { fitsLimits, pickVariant } from "../schema/classes.mjs";
import { HostWriterRequired } from "../writer/backend.mjs";
import { expand, groundingCheck, narrative, substitutionCheck, whyUs, wordCount } from "../writer/openai.mjs";
import { jobBlock } from "../writer/prompts.mjs";
import { slugify } from "../config.mjs";
import { appendTrace } from "../browser/trace.mjs";
import { noul, systemOne } from "../jev/client.mjs";
import { GATES } from "../jev/gates.mjs";
import { applicationSlug } from "./decisions.mjs";

/** Stories offered to the writer as evidence for one answer. Two is the writer's own cap. */
const MAX_STORIES = 2;
/** Facts offered as grounding. Enough for a paragraph; not the whole store. */
const MAX_FACTS = 12;
/** Tokens too common to mean anything when a story and a posting share them. */
const STOPWORDS = new Set(
  ("about above after again against because been before being below between both cannot could does doing during each from further have having here into itself more most other over same should some such than that their theirs them then there these they this those through under until very were what when where which while will with would your yours team teams work working role roles company companies candidate candidates experience experiences year years".split(
    " "
  ))
);

/** Which writer mode a row wants, when the planner did not say. */
function kindOf(decision, question) {
  const stated = decision?.draft_request?.kind;
  if (stated) return stated;
  if (decision?.story) return "expand";
  return (question?.class ?? decision?.class) === "why_us" ? "why_us" : "narrative";
}

/** A preference or fact value as one readable line the writer can quote from. */
function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(", ");
  return Object.entries(value)
    .map(([k, v]) => {
      const text = asText(v);
      return text ? `${k}: ${text}` : "";
    })
    .filter(Boolean)
    .join("; ");
}

const factRow = (row) => ({ id: row.id, value: asText(row.value), ...(row.since ? { since: row.since } : {}) });

/**
 * Memory ids → the two blocks the writer's prompts render (`groundingBlock`). `f.*`/`p.*` become
 * facts, `b.*` story ids and `q.*` curated answers become stories. An id memory does not hold is
 * silently absent rather than an empty row: a `- f.skill.cuda:` line with nothing after it reads
 * to the model as "this is blank", which is worse than not mentioning it.
 */
export function groundFrom(mem, ids = [], ctx = {}) {
  const facts = [];
  const stories = [];
  for (const id of ids) {
    if (!id) continue;
    const fact = (mem?.facts ?? []).find((r) => r?.id === id);
    if (fact) {
      facts.push(factRow(fact));
      continue;
    }
    if (id.startsWith("p.")) {
      const pref = resolvePreference(mem, id, ctx);
      if (pref && asText(pref.value)) facts.push({ id, value: asText(pref.value) });
      continue;
    }
    const story = (mem?.stories ?? []).find((r) => r?.id === id && r?.use !== "never");
    if (story) {
      stories.push({ id: story.id, title: story.title ?? story.id, text: story.text ?? "" });
      continue;
    }
    const answer = (mem?.answers ?? []).find((r) => r?.qid === id);
    const text = answer?.value ?? answer?.variants?.long ?? answer?.variants?.medium ?? answer?.variants?.short ?? null;
    if (text) stories.push({ id, title: answer.qid, text: String(text) });
  }
  return { facts, stories };
}

const tokens = (s) =>
  String(s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));

const jobTokens = (job) => new Set(tokens(`${job?.title ?? ""} ${job?.description ?? ""}`));

/** How much of a story's distinctive vocabulary the posting also uses. */
function overlap(story, want) {
  if (!want.size) return 0;
  const mine = new Set(tokens(`${story?.title ?? ""} ${(story?.tags ?? []).join(" ")} ${story?.text ?? ""}`));
  let hits = 0;
  for (const t of mine) if (want.has(t)) hits += 1;
  return hits;
}

const flatStory = (s) => ({ id: s.id, title: s.title ?? s.id, text: s.text ?? "" });

/**
 * The stories this posting is most likely to want, by shared distinctive vocabulary with the job
 * text. Deterministic on purpose: which of the candidate's own stories to ground a draft in is a
 * ranking, and a ranking that two runs disagree on makes a draft unreproducible.
 */
export function rankStories(stories, job, limit = MAX_STORIES) {
  const want = jobTokens(job);
  if (!want.size) return stories.slice(0, limit);
  return stories
    .map((s, i) => ({ s, i, hits: overlap(s, want) }))
    .sort((a, b) => b.hits - a.hits || a.i - b.i)
    .filter((r) => r.hits > 0)
    .slice(0, limit)
    .map((r) => flatStory(r.s));
}

/**
 * The saved rows that state what the candidate *wants* rather than what they did — `b.answer.*`
 * material tagged `motivation`. A "why this company" answer is a motivation question, and the one
 * row on file that is actually a why-us thesis was absent from every planner id list, which is
 * why three why-us drafts for three different companies were grounded in the same three
 * engineering anecdotes (docs/research/13-eval-judge-round2.md §3 N4).
 */
const MOTIVATION_TAG = /^(motivation|why|values|looking[_ -]?for)$/i;

export function motivationStories(pool = []) {
  return pool.filter((s) => (s?.tags ?? []).some((t) => MOTIVATION_TAG.test(String(t)))).map(flatStory);
}

/**
 * The stories one draft is grounded in.
 *
 * The planner names ids; this decides which of them *this* posting gets and in what order. Three
 * rules, in order of precedence:
 *   1. a why-us row leads with the candidate's own motivation row, when they have one;
 *   2. everything else is ranked by overlap with the posting's own text, never by list position —
 *      taking the first N is what made three postings' grounding lists byte-identical;
 *   3. a story another draft on the same page already told is skipped, so a reader does not meet
 *      the same anecdote twice three paragraphs apart.
 * Rule 3 yields when it would leave the draft with nothing: repeating beats refusing, and the
 * writer is told what has already been used (`avoid_repeating`) either way.
 *
 * @param {{named?:object[], pool?:object[], job?:object, kind?:string, used?:Set<string>, limit?:number}} args
 */
export function chooseStories({ named = [], pool = [], job = null, kind = "narrative", used = new Set(), limit = MAX_STORIES } = {}) {
  const want = jobTokens(job);
  const tagged = new Map((pool ?? []).map((s) => [s?.id, s]));
  const rank = (list) =>
    list
      .map((s, i) => ({ s, i, hits: overlap(tagged.get(s?.id) ?? s, want) }))
      .sort((a, b) => b.hits - a.hits || a.i - b.i)
      .map((r) => r.s);

  // Named ids are ranked, never dropped: the planner chose them, and a story that shares no
  // vocabulary with the posting is still the candidate's own material.
  const body = rank(named.length ? named.map(flatStory) : rankStories(pool, job, limit + used.size));
  const head = kind === "why_us" ? rank(motivationStories(pool)).slice(0, 1) : [];

  const out = [];
  const take = (list, allowUsed) => {
    for (const s of list) {
      if (out.length >= limit) return;
      if (!s?.id || out.some((o) => o.id === s.id)) continue;
      if (!allowUsed && used.has(s.id)) continue;
      out.push(s);
    }
  };
  for (const allowUsed of [false, true]) {
    take(head, allowUsed);
    take(body, allowUsed);
  }
  return out;
}

/** `p.looking_for` and the skills, which is what a "why this company" answer is actually made of. */
function defaultGrounding(mem, ctx) {
  const ids = ["p.looking_for", ...(mem?.facts ?? []).map((f) => f.id).filter((id) => /^f\.(skill|employment|education)\./.test(id))];
  const { facts } = groundFrom(mem, ids.slice(0, MAX_FACTS), ctx);
  return facts;
}

/** Every other company in the pipeline — the names a draft for this posting must never contain. */
export function otherCompanies(pipeline, company) {
  const jobs = Array.isArray(pipeline) ? pipeline : (pipeline?.jobs ?? []);
  const mine = slugify(String(company ?? ""));
  const names = new Set();
  for (const job of jobs) {
    const name = String(job?.company ?? "").trim();
    if (name && slugify(name) !== mine) names.add(name);
  }
  return [...names];
}

/**
 * The form's printed cap, measured against the text that was written — the same `fitsLimits` the
 * deterministic pass uses on a *stored* answer, so "fits this field" means one thing everywhere.
 * @returns {string|null} the complaint, or null when it fits
 */
function overLimit(text, limits) {
  const fit = fitsLimits(text, limits);
  return fit.ok ? null : `${fit.count} ${fit.over} against the form's ${fit.limit}`;
}

function ask(decision, why) {
  decision.action = "ask";
  decision.value = undefined;
  decision.words = undefined;
  decision.confidence = undefined;
  decision.gap = undefined;
  decision.why = why;
  return decision;
}

// ─── the relevance gates ──────────────────────────────────────────────────────────────────────
//
// A draft that is fluent, inside the limit, grounded in the candidate's own material and naming
// no other company can still be an answer to a *different question*. That is exactly what the
// ten-posting round produced on Mistral's required "What spoken languages are you fluent in?":
// 20 words composed out of a GPU-inference story, typed into a live employer's form and read
// back as filled (private/eval-shots/ten/findings.md). Every check this module had passed,
// because none of them asks the one question a reader would: *does this answer what was asked?*
//
// So the writer is bracketed by two Jev judgments — the only thing Jev does here, as everywhere
// else, is select between "yes" and "no" about text it is shown:
//
//   1. before the writer is called: does the saved material named in `grounding_titles` answer
//      what `prompt` asks? Below `GATES.askBelow` the row never reaches the writer at all and
//      goes back as an `ask` (`grounding_does_not_answer`).
//   2. after the text exists: does `draft` answer `prompt`? Below the gate the text is dropped
//      and the row goes back as an `ask` (`draft_does_not_answer`).
//
// Both are appended to `applications/<slug>/trace.jsonl` like every other Jev call, so a refusal
// is auditable after the fact. A gate that cannot be reached (no key, no network) refuses too:
// an unverifiable draft is not a draft.
//
// `why_us` skips the first gate for the same reason it is exempt from `FACT_SEEKING_RE`: it asks
// for a motivation, its grounding is the posting itself plus what the user says they are looking
// for, and "does this saved material answer 'why us'?" is not a judgment about relevance. It
// faces the second gate like every other row.

/** Story titles and fact ids — what the material *is*, never the personal values it holds. */
function groundingTitles(stories = [], facts = []) {
  const out = [];
  for (const s of stories) {
    const title = String(s?.title ?? s?.id ?? "").trim();
    if (title && !out.includes(title)) out.push(title);
  }
  for (const f of facts) {
    const id = String(f?.id ?? "").trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out.slice(0, 24);
}

/**
 * One Noul, traced like `src/jev/plan.mjs` does, and billed to the same per-posting totals — a
 * request the runner makes is a request the runner reports.
 * @returns {Promise<number>} the probability.
 */
async function relevance({ stage, id, instructions, state, slug, signal, totals = null }) {
  const questions = { [id]: noul(instructions) };
  await appendTrace(slug, { op: "jev_request", stage, state, questions });
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
  if (totals) {
    totals.requests += result.requests ?? 1;
    totals.ms += result.ms ?? 0;
    totals.usage.input_tokens += result.usage?.input_tokens ?? 0;
    totals.usage.output_tokens += result.usage?.output_tokens ?? 0;
    totals.stages?.push(stage);
  }
  const p = result.answers?.[id]?.noul;
  if (typeof p !== "number") throw new Error("the relevance gate returned no probability");
  return p;
}

const pct = (p) => p.toFixed(2);

/**
 * Write every `draft` row that has no text yet. Mutates the Decisions it is given.
 *
 * @param {{formPlan:object, decisions:object[], mem:object, context:object, pipeline?:object,
 *          slug?:string, jev?:object, dry?:boolean, signal?:AbortSignal,
 *          onLog?:(line:string)=>void}} args
 * @returns {Promise<object[]>} the rows that now carry a draft
 */
export async function draftRows({ formPlan, decisions, mem, context = {}, pipeline = null, slug = null, jev = null, dry = false, signal = null, onLog = null }) {
  const pending = (decisions ?? []).filter((d) => d.action === "draft" && d.value == null);
  if (!pending.length) return [];

  const job = { ...(formPlan?.job ?? {}), role_family: context.role_family ?? null };
  const byQid = new Map((formPlan?.questions ?? []).map((q) => [q.qid, q]));
  const ctx = { company: context.company, role_family: context.role_family };
  const pool = usableStories(mem);
  const forbidden = otherCompanies(pipeline, job.company);
  const written = [];
  // The relevance gates are traced under this posting like any other Jev call; the caller may
  // pass the slug it already computed, and a dry run that has none derives the same one.
  const traceSlug = slug ?? applicationSlug(formPlan);
  // Story ids an earlier draft on *this* page has already told. Two boxes three paragraphs apart
  // carrying the same anecdote is one application, one reader, one repetition
  // (docs/research/13-eval-judge-round2.md §3 N4).
  const used = new Set();
  const toldBy = new Map();

  for (const d of pending) {
    const question = byQid.get(d.qid) ?? null;
    const request = d.draft_request ?? {};
    const kind = kindOf(d, question);
    const limits = request.limits ?? question?.limits ?? null;
    const prompt = request.prompt || question?.label || d.label || "";
    const help = request.help || question?.help || "";
    const asked = help ? `${prompt}\n${help}` : prompt;

    const named = groundFrom(mem, request.grounding_ids ?? [], ctx);
    const stories = chooseStories({ named: named.stories, pool, job, kind, used, limit: MAX_STORIES });
    const facts = named.facts.length ? named.facts : defaultGrounding(mem, ctx);
    // What the reader has already met on this page, named so the writer can steer around it. The
    // list is only non-empty when the dedupe above had to yield, i.e. there was nothing else on
    // file to ground this row in.
    const avoid_repeating = stories.filter((s) => used.has(s.id)).map((s) => toldBy.get(s.id) ?? s.title ?? s.id);

    let text = "";
    let how = "";
    // The stories this row actually told, for the next row on the page.
    let told = stories;
    // The exact set the writer was given. Reconstructing a *similar* set here is how this pass
    // refused a perfectly grounded paragraph for the number 62: the writer's `joinTexts` reads
    // a story's title as well as its body, and a flattened copy dropped the titles. Same
    // objects, same order, same verdict. It is built *before* the call, because the `host`
    // backend throws instead of answering and the host agent needs exactly this grounding.
    let grounding = [];
    try {
      // Gate 1 — is the material this row would be written from even about what is being asked?
      // Cheaper than the writer and, more to the point, the refusal is honest: "nothing on file
      // answers this" is the correct outcome for a prompt no saved material covers.
      if (kind !== "why_us") {
        const offered = [...(d.story ? [pool.find((s) => s.id === d.story)] : []), ...named.stories, ...stories].filter(Boolean);
        const p = await relevance({
          stage: "draft_grounding",
          id: `grounds_${d.qid}`,
          instructions:
            "Does the saved material listed in `grounding_titles` directly answer what `prompt` asks for? Answer yes only if that material states what the prompt asks about.",
          state: { prompt: asked, grounding_titles: groundingTitles(offered, facts) },
          slug: traceSlug,
          signal,
          totals: jev,
        });
        d._gate_grounding = Number(p.toFixed(3));
        if (p < GATES.askBelow) throw new Error(`grounding_does_not_answer — nothing you have on file is about this (${pct(p)})`);
      }
      if (kind === "why_us") {
        const sentence = request.sentence ?? null;
        grounding = [...(sentence ? [sentence] : []), ...stories.slice(0, MAX_STORIES), ...facts, jobBlock(job)];
        how = sentence ? "your sentence + the posting" : "the posting + your saved material";
        const out = await whyUs({ sentence, stories, facts, job, limits, avoid: avoid_repeating, signal });
        text = out.text;
      } else if (kind === "expand") {
        // The story Jev matched to this field, by id. It is the reason the row is an `expand` at
        // all, so it is looked up in memory rather than hoped for in the ranked shortlist.
        const matched = d.story ? pool.find((s) => s.id === d.story) : null;
        const story = matched
          ? { id: matched.id, title: matched.title ?? matched.id, text: matched.text ?? "" }
          : (named.stories[0] ?? stories[0] ?? null);
        if (!story?.text) throw new Error("no saved story to expand");
        told = [story];
        grounding = [story, ...facts, jobBlock(job)];
        how = `your story "${String(story.title ?? story.id).slice(0, 40)}"`;
        // An `expand` has no choice of story — the matched one is the reason the row is an
        // `expand` at all — so when an earlier box on this page already told it, the dedupe
        // cannot help and the writer is told instead.
        const repeated = used.has(story.id) ? [toldBy.get(story.id) ?? String(story.title ?? story.id)] : [];
        const out = await expand({ story, question: asked, facts, job, limits, avoid: [...avoid_repeating, ...repeated], signal });
        text = out.text;
      } else {
        grounding = [...facts, ...stories, jobBlock(job)];
        how = "your saved facts and stories";
        const variants = await narrative({ prompt: asked, facts, stories, family: context.role_family ?? undefined, job, limits, avoid: avoid_repeating, signal });
        // The longest variant the field's own limit allows — a 300-word box does not want the
        // 60-word answer, and a 100-word box must never get the 300-word one. Same rule, same
        // helper, as a stored `narrative` answer gets in the deterministic pass.
        text = pickVariant(variants, limits);
      }

      // A writer that returned nothing must never reach the form as an empty answer: an empty
      // required box is an `ask`, which is what the catch below turns this into.
      if (!String(text ?? "").trim()) throw new Error("the writer returned no text");
      const tooLong = overLimit(text, limits);
      if (tooLong) throw new Error(`over the stated limit: ${tooLong}`);

      const ground = groundingCheck(text, grounding);
      if (!ground.ok) throw new Error(`not in your saved material: ${ground.missing.slice(0, 4).join(", ")}`);
      const swap = substitutionCheck(text, forbidden);
      if (!swap.ok) throw new Error(`names another company you are applying to: ${swap.found.join(", ")}`);

      // Gate 2 — the text exists, it fits, it is grounded and it names nobody else. The one
      // question left is the one a reader asks first, and the round that produced a paragraph
      // about GPU inference under "what languages are you fluent in?" failed exactly here.
      const answersIt = await relevance({
        stage: "draft_answers",
        id: `answers_${d.qid}`,
        instructions: "Does the text in `draft` answer what `prompt` asks for?",
        state: { prompt: asked, draft: text },
        slug: traceSlug,
        signal,
        totals: jev,
      });
      d._gate_draft = Number(answersIt.toFixed(3));
      if (answersIt < GATES.askBelow) throw new Error(`draft_does_not_answer — the text does not answer this prompt (${pct(answersIt)})`);

      d.source = "writer";
      d.value = text;
      d.words = wordCount(text);
      // Only a draft that was accepted consumes its stories: a refused row is handed back as an
      // `ask` and told nothing, so the next box must still be allowed to use them.
      for (const s of told) {
        if (!s?.id) continue;
        used.add(s.id);
        if (!toldBy.has(s.id)) toldBy.set(s.id, String(s.title ?? s.id));
      }
      d.why = `drafted from ${how}${dry ? " (dry run — not typed into the form)" : ""}`;
      if (dry) d.dry = true;
      delete d.shot;
      d.grounding_used = told.map((s) => s.id).filter(Boolean);
      written.push(d);
      onLog?.(`drafted ${d.qid}: ${d.words} words (${kind})`);
    } catch (err) {
      // No writer model at all: the host agent is the writer. The row is handed back with the
      // prompt, the grounding and the field's limit, and comes home through `--answers` — where
      // it faces the same grounding and substitution checks a model's draft does.
      if (err instanceof HostWriterRequired) {
        hostDraft(d, { kind, prompt: asked, grounding, limits });
        onLog?.(`draft handed to the host ${d.qid} (${kind})`);
        continue;
      }
      const reason = String(err?.message ?? err).slice(0, 120);
      ask(d, `could not draft this one — ${reason}`);
      onLog?.(`draft refused ${d.qid}: ${reason}`);
    }
  }
  return written;
}

/** The `draft` hook `runBrowser` calls, bound to one posting's plan (mirrors `replanFor`). */
export function draftFor({ plan, stores, dry = false, onLog = null }) {
  return {
    async rows(decisions) {
      return draftRows({
        formPlan: plan.formPlan,
        slug: plan.slug ?? null,
        jev: plan.jev ?? null,
        decisions,
        mem: stores.mem,
        context: plan.context,
        pipeline: stores.pipeline,
        dry,
        onLog,
      });
    },
  };
}

// ─── the host as the writer ───────────────────────────────────────────────────────────────────
//
// With no writer model configured (src/writer/backend.mjs `host`), the runner does not stop
// drafting — it hands the drafting out. The row leaves as a `needs_user` question of kind
// `draft` carrying the prompt, the grounding and the field's limit; the host agent writes the
// paragraph and passes it back through `--answers`. Nothing is relaxed on the way back in: the
// text faces the same limit, grounding and substitution checks a model's draft faces, and a
// paragraph that fails them is refused exactly as a model's would be.

/** The writer's grounding objects as the plain lines a host agent can read. */
export function groundingTexts(grounding = []) {
  const out = [];
  for (const g of grounding) {
    if (g == null) continue;
    if (typeof g === "string") {
      if (g.trim()) out.push(g.trim());
      continue;
    }
    const title = String(g.title ?? g.id ?? "").trim();
    const body = String(g.text ?? g.value ?? "").trim();
    const line = title && body ? `${title} — ${body}` : title || body;
    if (line) out.push(line);
  }
  return out;
}

/** Turn one undraftable row into the `draft` question the host answers. */
export function hostDraft(d, { kind, prompt, grounding, limits }) {
  ask(d, "no writer model is configured — write this one and pass it back with --answers");
  d.host_draft = {
    kind: "draft",
    writes: kind,
    prompt,
    grounding: groundingTexts(grounding),
    limits: limits ?? null,
    label: d.label ?? prompt,
  };
  return d;
}

/** The `needs_user` questions, with the drafting rows carrying what it takes to write them. */
export function hostDraftAsks(questions = [], decisions = []) {
  const byQid = new Map((decisions ?? []).map((d) => [d.qid, d]));
  return questions.map((q) => {
    const host = byQid.get(q.qid)?.host_draft;
    if (!host) return q;
    const { label, ...rest } = host;
    return { ...q, ...rest };
  });
}

/** @returns {string|null} why this text cannot be used, or null when it can. */
export function checkHostDraft(text, host, forbidden = []) {
  const tooLong = overLimit(text, host?.limits ?? null);
  if (tooLong) return `over the stated limit: ${tooLong}`;
  const ground = groundingCheck(text, host?.grounding ?? []);
  if (!ground.ok) return `not in your saved material or the posting: ${ground.missing.slice(0, 4).join(", ")}`;
  const swap = substitutionCheck(text, forbidden);
  if (!swap.ok) return `names another company you are applying to: ${swap.found.join(", ")}`;
  return null;
}

/**
 * `--answers` for the rows the host was asked to write. Mutates the Decisions it accepts and
 * returns the answers that are *not* host drafts, for the ordinary `applyAnswers` pass.
 * @returns {{answers:object, accepted:string[], refused:Array<{qid:string, reason:string}>}}
 */
export function acceptHostDrafts({ decisions = [], answers = {}, pipeline = null, company = null, dry = false, onLog = null } = {}) {
  const rest = { ...answers };
  const accepted = [];
  const refused = [];
  const forbidden = otherCompanies(pipeline, company);
  for (const d of decisions) {
    const host = d.host_draft;
    if (answers[d.qid] === undefined || answers[d.qid] === null) continue;
    if (!host) {
      // A row the draft pass has not reached yet (a fresh plan drafts *after* `--answers` is
      // read). Its answer is held back rather than handed to `applyAnswers`, which would only
      // report it as ignored; this function is called again once the pass has run.
      if (d.action === "draft" && d.value == null) delete rest[d.qid];
      continue;
    }
    const answer = answers[d.qid];
    const text = String((typeof answer === "string" ? answer : answer?.value) ?? "").trim();
    delete rest[d.qid];
    const problem = text ? checkHostDraft(text, host, forbidden) : "it is empty";
    if (problem) {
      // Refused, not corrected: the row stays an `ask` carrying the complaint, so the next
      // `--answers` can fix exactly what was wrong.
      d.why = `your draft was not used — ${problem}`;
      refused.push({ qid: d.qid, reason: problem });
      onLog?.(`draft refused ${d.qid}: ${problem}`);
      continue;
    }
    d.action = "draft";
    d.source = "host";
    d.value = text;
    d.words = wordCount(text);
    // Every row that ends up with text records what it was actually handed (CONTRACTS §Decision
    // record): the host was given the whole offered set, undeduped, so that is what it used.
    d.grounding_used = [...(d.draft_request?.grounding_ids ?? [])];
    d.why = `written by your agent from your saved material${dry ? " (dry run — not typed into the form)" : ""}`;
    if (dry) d.dry = true;
    delete d.confidence;
    delete d.gap;
    delete d.shot;
    delete d.host_draft;
    accepted.push(d.qid);
    onLog?.(`drafted ${d.qid}: ${d.words} words (host)`);
  }
  return { answers: rest, accepted, refused };
}
