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
import { expand, groundingCheck, narrative, substitutionCheck, whyUs, wordCount } from "../writer/openai.mjs";
import { jobBlock } from "../writer/prompts.mjs";
import { slugify } from "../config.mjs";

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

/**
 * Write every `draft` row that has no text yet. Mutates the Decisions it is given.
 *
 * @param {{formPlan:object, decisions:object[], mem:object, context:object, pipeline?:object,
 *          dry?:boolean, signal?:AbortSignal, onLog?:(line:string)=>void}} args
 * @returns {Promise<object[]>} the rows that now carry a draft
 */
export async function draftRows({ formPlan, decisions, mem, context = {}, pipeline = null, dry = false, signal = null, onLog = null }) {
  const pending = (decisions ?? []).filter((d) => d.action === "draft" && d.value == null);
  if (!pending.length) return [];

  const job = { ...(formPlan?.job ?? {}), role_family: context.role_family ?? null };
  const byQid = new Map((formPlan?.questions ?? []).map((q) => [q.qid, q]));
  const ctx = { company: context.company, role_family: context.role_family };
  const pool = usableStories(mem);
  const forbidden = otherCompanies(pipeline, job.company);
  const written = [];
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

    try {
      let text = "";
      let how = "";
      // The stories this row actually told, for the next row on the page.
      let told = stories;
      // The exact set the writer was given. Reconstructing a *similar* set here is how this pass
      // refused a perfectly grounded paragraph for the number 62: the writer's `joinTexts` reads
      // a story's title as well as its body, and a flattened copy dropped the titles. Same
      // objects, same order, same verdict.
      let grounding = [];
      if (kind === "why_us") {
        const sentence = request.sentence ?? null;
        const out = await whyUs({ sentence, stories, facts, job, limits, avoid: avoid_repeating, signal });
        text = out.text;
        grounding = [...(sentence ? [sentence] : []), ...stories.slice(0, MAX_STORIES), ...facts, jobBlock(job)];
        how = sentence ? "your sentence + the posting" : "the posting + your saved material";
      } else if (kind === "expand") {
        // The story Jev matched to this field, by id. It is the reason the row is an `expand` at
        // all, so it is looked up in memory rather than hoped for in the ranked shortlist.
        const matched = d.story ? pool.find((s) => s.id === d.story) : null;
        const story = matched
          ? { id: matched.id, title: matched.title ?? matched.id, text: matched.text ?? "" }
          : (named.stories[0] ?? stories[0] ?? null);
        if (!story?.text) throw new Error("no saved story to expand");
        told = [story];
        // An `expand` has no choice of story — the matched one is the reason the row is an
        // `expand` at all — so when an earlier box on this page already told it, the dedupe
        // cannot help and the writer is told instead.
        const repeated = used.has(story.id) ? [toldBy.get(story.id) ?? String(story.title ?? story.id)] : [];
        const out = await expand({ story, question: asked, facts, job, limits, avoid: [...avoid_repeating, ...repeated], signal });
        text = out.text;
        grounding = [story, ...facts, jobBlock(job)];
        how = `your story "${String(story.title ?? story.id).slice(0, 40)}"`;
      } else {
        const variants = await narrative({ prompt: asked, facts, stories, family: context.role_family ?? undefined, job, limits, avoid: avoid_repeating, signal });
        // The longest variant the field's own limit allows — a 300-word box does not want the
        // 60-word answer, and a 100-word box must never get the 300-word one. Same rule, same
        // helper, as a stored `narrative` answer gets in the deterministic pass.
        text = pickVariant(variants, limits);
        grounding = [...facts, ...stories, jobBlock(job)];
        how = "your saved facts and stories";
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
