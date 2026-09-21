// Jev (TypeSafe System One) client: one pooled connection, token-budgeted parallel splits,
// and a hard validation pass over every answer. Jev only ever *selects* — it never writes text.
//
// Endpoint: POST https://api.typesafe.ai/v1/systemone  (docs.typesafe.ai/api.md)
// Answers:  choice {choice, confidence, probabilities} · noul {noul} · score {score, legend, probabilities}
//
// Invariant enforced here (AGENTS.md): every `choice` question carries an explicit `none_of_these`
// exit, so "nothing we saved answers this" is always reachable and never becomes a first-option
// fallback. Build criteria with `{ ...options, [NONE]: "…" }` or use `withNone()`.

// NOTE: do not import the standalone `undici` package here (or anywhere else in this process).
// Its module init overwrites globalThis[Symbol.for("undici.globalDispatcher.1")], the same slot
// Node's built-in fetch reads, and the two copies then disagree about content-encoding: every
// other module's `fetch` starts returning still-compressed bodies with the header stripped, so
// JSON.parse sees binary. The SDK's default transport is Node's global fetch, which already
// pools and reuses keep-alive connections — which is all the batched request pattern needs.
import {
  TypeSafeClient,
  APIError,
  AuthenticationError,
  BadRequestError,
  UnprocessableEntityError,
} from "@typesafe-ai/sdk";
import { JEV_MODEL, loadEnv } from "../config.mjs";

/** The escape hatch every Choice must offer. */
export const NONE = "none_of_these";

/** Question builders — plain request shapes, identical to the SDK's helpers. */
export const choice = (instructions, criteria) => ({ type: "choice", instructions, criteria });
export const noul = (instructions, criteria) => ({ type: "noul", instructions, ...(criteria && { criteria }) });
export const score = (instructions, levels) => ({ type: "score", instructions, criteria: levels });

/** `withNone(criteria, "No saved item answers this")` → criteria + the mandatory exit. */
export const withNone = (criteria, description = "No saved item answers this; ask the user") => ({
  ...criteria,
  [NONE]: description,
});

// ─── errors ───────────────────────────────────────────────────────────────────────────────────

export class JevError extends Error {
  constructor(message, { status, detail, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = new.target.name;
    if (status !== undefined) this.status = status;
    if (detail !== undefined) this.detail = detail;
  }
}

/** 401 — the key is missing, wrong, or revoked. */
export class JevAuthError extends JevError {
  constructor(detail, opts = {}) {
    super("Jev rejected the API key (401). Check TYPESAFE_API_KEY in ~/.config/jev-apply/env.", {
      status: 401,
      detail,
      ...opts,
    });
  }
}

/** 400/422 — malformed request: too many choices, oversize state (`max_tokens_exceeded`), bad shape. */
export class JevBadRequest extends JevError {
  constructor(detail, opts = {}) {
    const text = typeof detail === "string" ? detail : (detail?.message ?? detail?.error_type ?? JSON.stringify(detail));
    super(`Jev rejected the request: ${text}`, { status: opts.status ?? 400, detail, ...opts });
  }
}

/** An answer that does not satisfy the contract (out-of-set choice, skewed probabilities, …). */
export class JevValidationError extends JevError {
  constructor({ id, reason }) {
    super(`Jev answer for "${id}" is invalid: ${reason}`);
    this.id = id;
    this.reason = reason;
  }
}

// ─── token budget ─────────────────────────────────────────────────────────────────────────────

/** 64k is the hard per-request cap; 56k leaves headroom for the envelope and estimator error. */
export const MAX_REQUEST_TOKENS = 56_000;
const CHARS_PER_TOKEN = 3.5;
/** Measured ≈29 input tokens per one-line criterion (docs/research/03 §"Addition (08 §5)"). */
const TOKENS_PER_OPTION = 30;
/** ≤255 options per Choice; 256 → 400 "Too many choices." */
export const MAX_CHOICES = 255;

const chars = (v) => (typeof v === "string" ? v.length : v === undefined ? 0 : JSON.stringify(v).length);

/** Rough input-token estimate for any JSON-ish value. */
export function estimateTokens(value) {
  return Math.ceil(chars(value) / CHARS_PER_TOKEN);
}

/** Options a question bills for: choice labels, score levels, or the two noul descriptions. */
export function optionCount(q) {
  if (q?.type === "choice") return Object.keys(q.criteria ?? {}).length;
  if (q?.type === "score") return (q.criteria ?? []).length;
  if (q?.type === "noul") return Object.keys(q.criteria ?? {}).length;
  return 0;
}

/** Per-question cost: its serialized text plus the per-option overhead the API charges. */
export function estimateQuestionTokens(id, q) {
  return estimateTokens(id) + estimateTokens(q) + TOKENS_PER_OPTION * optionCount(q);
}

/**
 * Split `questions` into request-sized batches that each re-send the shared `state`.
 * Greedy and order-preserving; a single oversize question gets its own batch so the server,
 * not us, decides whether it really exceeds the context.
 * @returns {Array<Record<string, object>>} one question map per HTTP call
 */
export function planRequests(state, questions) {
  const entries = Object.entries(questions);
  if (!entries.length) throw new JevBadRequest({ error_type: "empty_questions", message: "no questions to ask" });
  const stateTokens = estimateTokens(state) + 64; // + envelope
  const batches = [];
  let current = null;
  let used = 0;
  for (const [id, q] of entries) {
    const cost = estimateQuestionTokens(id, q);
    if (current && stateTokens + used + cost > MAX_REQUEST_TOKENS) current = null;
    if (!current) {
      current = {};
      batches.push(current);
      used = 0;
    }
    current[id] = q;
    used += cost;
  }
  return batches;
}

// ─── transport ────────────────────────────────────────────────────────────────────────────────

let client = null;

/** Lazily built so importing this module never needs a key (offline planning, unit checks). */
function getClient() {
  if (client) return client;
  const { TYPESAFE_API_KEY } = loadEnv({ require: ["TYPESAFE_API_KEY"] });
  client = new TypeSafeClient({
    apiKey: TYPESAFE_API_KEY,
    defaultModel: JEV_MODEL,
    timeout: 60_000, // per attempt; batched requests are much slower than a single 400 ms question
  });
  return client;
}

/**
 * Drop the cached client. Sockets need no teardown: Node's global fetch pool unrefs them, so a
 * script exits as soon as its work is done. Kept so callers can reset after an env change.
 */
export async function closeJevClient() {
  client = null;
}

function toJevError(err) {
  if (err instanceof AuthenticationError) return new JevAuthError(err.body?.detail ?? err.body, { cause: err });
  if (err instanceof BadRequestError || err instanceof UnprocessableEntityError) {
    return new JevBadRequest(err.body?.detail ?? err.body, { status: err.status, cause: err });
  }
  if (err instanceof APIError) {
    return new JevError(`Jev request failed (${err.status}): ${err.message}`, {
      status: err.status,
      detail: err.body?.detail ?? err.body,
      cause: err,
    });
  }
  if (err instanceof JevError) return err;
  return new JevError(`Jev request failed: ${err?.message ?? err}`, { cause: err });
}

// ─── validation ───────────────────────────────────────────────────────────────────────────────

const SUM_TOLERANCE = 0.02;

function checkDistribution(id, probabilities, expectedKeys) {
  if (!probabilities || typeof probabilities !== "object") {
    throw new JevValidationError({ id, reason: "no probabilities returned" });
  }
  const got = Object.keys(probabilities);
  const want = new Set(expectedKeys);
  if (got.length !== want.size || got.some((k) => !want.has(k))) {
    throw new JevValidationError({ id, reason: `probability keys do not match criteria (got ${got.length}, want ${want.size})` });
  }
  let sum = 0;
  for (const k of got) {
    const p = probabilities[k];
    if (typeof p !== "number" || !Number.isFinite(p) || p < -1e-6 || p > 1 + 1e-6) {
      throw new JevValidationError({ id, reason: `probability for "${k}" is not in [0,1]` });
    }
    sum += p;
  }
  if (Math.abs(sum - 1) > SUM_TOLERANCE) {
    throw new JevValidationError({ id, reason: `probabilities sum to ${sum.toFixed(4)}, not 1` });
  }
  return sum;
}

function argmaxOk(probabilities, picked) {
  let max = -Infinity;
  for (const p of Object.values(probabilities)) if (p > max) max = p;
  return probabilities[picked] >= max - 1e-9;
}

/** Throws JevValidationError unless `answer` satisfies the contract for `question`. */
export function validateAnswer(id, question, answer) {
  if (!answer || typeof answer !== "object") throw new JevValidationError({ id, reason: "no answer returned" });
  if (answer.type !== question.type) {
    throw new JevValidationError({ id, reason: `answer type "${answer.type}" does not match question type "${question.type}"` });
  }
  if (question.type === "choice") {
    const labels = Object.keys(question.criteria ?? {});
    if (!labels.includes(answer.choice)) {
      throw new JevValidationError({ id, reason: `choice "${answer.choice}" is not one of the criteria` });
    }
    checkDistribution(id, answer.probabilities, labels);
    if (!argmaxOk(answer.probabilities, answer.choice)) {
      throw new JevValidationError({ id, reason: `choice "${answer.choice}" is not the most probable label` });
    }
    if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence)) {
      throw new JevValidationError({ id, reason: "confidence is not a number" });
    }
    return answer;
  }
  if (question.type === "score") {
    const levels = (question.criteria ?? []).length;
    checkDistribution(id, answer.probabilities, Array.from({ length: levels }, (_, i) => String(i)));
    if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > levels - 1) {
      throw new JevValidationError({ id, reason: `score ${answer.score} is outside 0..${levels - 1}` });
    }
    return answer;
  }
  if (question.type === "noul") {
    if (typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
      throw new JevValidationError({ id, reason: `noul ${answer.noul} is not a probability` });
    }
    return answer;
  }
  throw new JevValidationError({ id, reason: `unknown question type "${question.type}"` });
}

function checkQuestions(questions) {
  for (const [id, q] of Object.entries(questions)) {
    if (!q || typeof q !== "object" || !q.type) {
      throw new JevBadRequest({ error_type: "invalid_question", question: id, message: "question has no type" });
    }
    if (q.type === "choice") {
      const labels = Object.keys(q.criteria ?? {});
      if (labels.length < 2) {
        throw new JevBadRequest({ error_type: "invalid_question", question: id, message: "choice needs at least two options" });
      }
      if (labels.length > MAX_CHOICES) {
        throw new JevBadRequest({
          error_type: "too_many_choices",
          question: id,
          message: `Too many choices. Must have at most ${MAX_CHOICES} choices.`,
        });
      }
      if (!labels.includes(NONE)) {
        throw new JevBadRequest({
          error_type: "missing_none_exit",
          question: id,
          message: `choice "${id}" has no "${NONE}" option; add one (see NONE / withNone in src/jev/client.mjs)`,
        });
      }
    }
    if (q.type === "score") {
      const levels = (q.criteria ?? []).length;
      if (levels < 2 || levels > 10) {
        throw new JevBadRequest({ error_type: "invalid_question", question: id, message: `score needs 2–10 levels, got ${levels}` });
      }
    }
  }
}

// ─── the call ─────────────────────────────────────────────────────────────────────────────────

/**
 * Ask Jev a batch of independent questions about one shared `state`.
 * Splits over the token budget, runs the batches in parallel on the keep-alive connection,
 * merges the answers, and validates every one of them.
 *
 * @param {{state:any, questions:Record<string,object>, model?:string, signal?:AbortSignal}} req
 * @returns {Promise<{answers:Record<string,object>, usage:{input_tokens:number,output_tokens:number}, ms:number, requests:number, model:string}>}
 */
export async function systemOne({ state, questions, model = JEV_MODEL, signal }) {
  checkQuestions(questions);
  const batches = planRequests(state, questions);
  const api = getClient();
  const started = Date.now();

  const results = await Promise.all(
    batches.map((batch) =>
      api.systemOne({ state, questions: batch, model }, { signal }).catch((err) => {
        throw toJevError(err);
      }),
    ),
  );

  const answers = {};
  const usage = { input_tokens: 0, output_tokens: 0 };
  let answeredModel = model;
  for (const res of results) {
    answeredModel = res.model ?? answeredModel;
    usage.input_tokens += res.usage?.input_tokens ?? 0;
    usage.output_tokens += res.usage?.output_tokens ?? 0;
    for (const [id, answer] of Object.entries(res.answers ?? {})) answers[id] = answer;
  }
  for (const [id, q] of Object.entries(questions)) validateAnswer(id, q, answers[id]);

  return { answers, usage, ms: Date.now() - started, requests: batches.length, model: answeredModel };
}
