// Fit scoring for newly discovered postings (PLAN §2.5 "Fit"): one Jev request per ≤50 new
// postings, carrying — per posting — a `score` (5 levels), a `noul` dealbreaker check, and a
// `choice` over the user's own story titles. The choice is what makes the reason line the user's
// own material instead of model prose: Jev selects a saved story, code copies its title.
//
//   state = { candidate: <p.looking_for>, jobs: { j0: {title, location, description ≤2k}, … } }
//
// Jev never writes text here and never decides anything about the user: a posting Jev flags against
// a dealbreaker keeps its status and is shown to the user marked, never silently dropped.

import {
  choice,
  estimateQuestionTokens,
  estimateTokens,
  JevAuthError,
  JevBadRequest,
  JevValidationError,
  noul,
  score,
  systemOne,
  withNone,
} from "../jev/client.mjs";
import { gate } from "../jev/gates.mjs";
import { resolvePreference, usableStories } from "../memory/resolve.mjs";

/** PLAN §2.5: a `score` with five levels. `fit` is the returned 0–4 float, never rounded to a level. */
export const FIT_LEVELS = [
  "Not this candidate's field at all",
  "Adjacent field; most of what the posting asks for is missing",
  "Partly overlapping; some of the candidate's target work appears in the posting",
  "Clearly one of the candidate's target roles",
  "Squarely the role the candidate is looking for, at the right level and focus",
];

/** Max postings in one request (PLAN §2.5). Token budgets below usually bind first. */
export const MAX_JOBS_PER_REQUEST = 50;
/** Client splits at 56k; staying under this keeps one group = one HTTP request. */
const REQUEST_BUDGET = 48_000;
/** The API budgets `state` + the longest question separately (32k); leave headroom. */
const STATE_BUDGET = 24_000;
/** PLAN §2.5: `description ≤2k`. */
const DESCRIPTION_CHARS = 2_000;

const round2 = (n) => Math.round(n * 100) / 100;

const clip = (text, n) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** Stable key for a posting inside one request; short because every question repeats it. */
const jobKey = (i) => `j${i}`;

/**
 * The selector pool: `kind: story` rows the user has not hidden (`use: never`). Titles are the
 * labels, so duplicates are dropped — a Choice label must map back to exactly one story.
 */
export function storyPool(mem) {
  const seen = new Set();
  const pool = [];
  for (const row of usableStories(mem)) {
    if (row?.kind !== "story") continue;
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (!title || seen.has(title)) continue;
    seen.add(title);
    pool.push({ id: row.id, title, tags: Array.isArray(row.tags) ? row.tags : [] });
  }
  return pool;
}

const storyCriteria = (stories) =>
  withNone(
    Object.fromEntries(
      stories.map((s) => [s.title, s.tags.length > 0 ? `tags: ${s.tags.join(", ")}` : null]),
    ),
    "None of the candidate's saved stories is relevant evidence for this posting",
  );

/** `{title, location, description ≤2k}` — everything a question may read has to be in `state`. */
export function jobState(job) {
  return {
    title: job?.title ?? null,
    location: job?.location ?? (job?.remote ? "remote" : null),
    description: clip(job?.description, DESCRIPTION_CHARS) || null,
  };
}

/** The three questions asked about one posting; `story_*` is omitted when memory holds no stories. */
export function jobQuestions(key, criteria) {
  const questions = {
    [`fit_${key}`]: score(
      `How well does the posting in \`jobs.${key}\` match the roles the candidate is looking for, described in \`candidate\`? Judge the role itself — its title, level and the work described — not the company's reputation.`,
      FIT_LEVELS,
    ),
    [`deal_${key}`]: noul(
      `Does the posting in \`jobs.${key}\` require or impose something the candidate lists in \`candidate.dealbreakers\`?`,
      {
        true: "The posting states or clearly implies something on the dealbreaker list",
        false: "Nothing in the posting matches the dealbreaker list",
      },
    ),
  };
  if (criteria) {
    questions[`story_${key}`] = choice(
      `Which of the candidate's saved stories is the strongest evidence that they can do the job in \`jobs.${key}\`?`,
      criteria,
    );
  }
  return questions;
}

/**
 * Split postings into request-sized groups: ≤50 postings, and under both the per-request and the
 * state-plus-longest-question budgets, so each group is exactly one HTTP call.
 */
export function planGroups(jobs, stories, candidate) {
  const criteria = stories.length > 0 ? storyCriteria(stories) : null;
  const probe = jobQuestions(jobKey(0), criteria);
  const questionCost = Object.entries(probe).reduce((n, [id, q]) => n + estimateQuestionTokens(id, q), 0);
  const longest = Object.entries(probe).reduce((n, [id, q]) => Math.max(n, estimateQuestionTokens(id, q)), 0);
  const base = estimateTokens({ candidate });

  const groups = [];
  let current = [];
  let stateTokens = 0;
  for (const job of jobs) {
    const cost = estimateTokens(jobState(job));
    const overRequest = base + stateTokens + cost + (current.length + 1) * questionCost > REQUEST_BUDGET;
    const overState = base + stateTokens + cost + longest > STATE_BUDGET;
    if (current.length > 0 && (current.length >= MAX_JOBS_PER_REQUEST || overRequest || overState)) {
      groups.push(current);
      current = [];
      stateTokens = 0;
    }
    current.push(job);
    stateTokens += cost;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function buildRequest(group, stories, candidate) {
  const criteria = stories.length > 0 ? storyCriteria(stories) : null;
  const jobs = {};
  let questions = {};
  group.forEach((job, i) => {
    const key = jobKey(i);
    jobs[key] = jobState(job);
    questions = { ...questions, ...jobQuestions(key, criteria) };
  });
  return { state: { candidate, jobs }, questions };
}

function readAnswers(group, answers, stories) {
  const byTitle = new Map(stories.map((s) => [s.title, s]));
  return group.map((job, i) => {
    const key = jobKey(i);
    const fit = answers[`fit_${key}`];
    const deal = answers[`deal_${key}`];
    const story = answers[`story_${key}`];
    const decision = story ? gate(story) : "ask";
    const picked = decision === "ask" ? null : byTitle.get(story.choice);
    return {
      id: job.id,
      fit: round2(fit.score),
      reason: picked ? picked.title : "no matching story",
      story: picked ? picked.id : null,
      confidence: story ? round2(story.confidence) : null,
      gate: decision,
      dealbreaker: deal ? round2(deal.noul) : null,
    };
  });
}

async function pool(items, size, worker) {
  const queue = items.map((item, i) => [item, i]);
  const out = new Array(items.length);
  const run = async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const [item, i] = next;
      out[i] = await worker(item, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, run));
  return out;
}

/**
 * Score, dealbreaker-check and story-match a batch of postings.
 *
 * @param {object[]} jobs discover Jobs carrying an `id`.
 * @param {{mem:object, candidate?:object, concurrency?:number, signal?:AbortSignal,
 *          onError?:(err:Error, group:object[])=>void}} opts
 * @returns {Promise<{results:object[], requests:number, groups:number, failed:number,
 *                    ms:number, usage:{input_tokens:number,output_tokens:number}, skipped?:string}>}
 *   `results[]` = `{id, fit 0–4, reason, story, confidence, gate, dealbreaker}`. Jev occasionally
 *   returns an answer that fails the client's contract check (seen live: `choice: none_of_these`
 *   while another label holds the probability mass), and `systemOne` rejects the whole batch for
 *   it. Rather than lose every posting in that request, the group is bisected until the bad answer
 *   is alone: only that posting stays unscored, and a scan is never failed by a fit pass.
 */
export async function fitJobs(jobs, { mem, candidate, concurrency = 4, signal, onError } = {}) {
  const started = Date.now();
  const empty = { results: [], requests: 0, groups: 0, failed: 0, ms: 0, usage: { input_tokens: 0, output_tokens: 0 } };
  if (!jobs || jobs.length === 0) return empty;

  const cand = candidate ?? resolvePreference(mem, "p.looking_for")?.value;
  // No stated target roles: there is nothing to judge fit against, and a guessed candidate profile
  // would be exactly the defaulting of a personal fact the plan forbids (PLAN §2.4).
  if (!cand) return { ...empty, skipped: "no p.looking_for preference in memory" };

  const stories = storyPool(mem);
  const groups = planGroups(jobs, stories, cand);
  let requests = 0;
  let failed = 0;
  const usage = { input_tokens: 0, output_tokens: 0 };

  const runGroup = async (group) => {
    const { state, questions } = buildRequest(group, stories, cand);
    try {
      const res = await systemOne({ state, questions, signal });
      requests += res.requests;
      usage.input_tokens += res.usage?.input_tokens ?? 0;
      usage.output_tokens += res.usage?.output_tokens ?? 0;
      return readAnswers(group, res.answers, stories);
    } catch (err) {
      // A bad key or an unparseable request will not get better by asking again in halves.
      if (err instanceof JevAuthError || err instanceof JevBadRequest) throw err;
      if (!(err instanceof JevValidationError) || group.length === 1) {
        failed += group.length;
        onError?.(err, group);
        return [];
      }
      const mid = Math.ceil(group.length / 2);
      const halves = await Promise.all([runGroup(group.slice(0, mid)), runGroup(group.slice(mid))]);
      return halves.flat();
    }
  };

  const perGroup = await pool(groups, concurrency, runGroup);

  return {
    results: perGroup.flat(),
    requests,
    groups: groups.length,
    failed,
    ms: Date.now() - started,
    usage,
  };
}
