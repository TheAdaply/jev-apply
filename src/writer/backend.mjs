// Which model writes the few sentences jev-apply cannot look up — and whether there is one at all.
//
// Three backends, auto-detected from the environment (src/config.mjs writerFromEnv):
//   openai  OPENAI_API_KEY is set → the Responses API with a strict JSON schema.
//   local   JEV_APPLY_WRITER_URL points at an OpenAI-compatible server (Ollama, llama.cpp,
//           LM Studio). Chat completions, no key, and the schema is carried in the prompt rather
//           than in `response_format`: a local server may not implement structured output at all,
//           so the reply is parsed and one re-ask is spent on a reply that is not JSON.
//   host    no writer at all. `complete()` throws `HostWriterRequired`, `src/plan/draft.mjs`
//           turns that into a `needs_user` item of kind `draft`, and the host agent (Claude Code,
//           Codex) writes the text and hands it back through `--answers`. The runner still checks
//           it: a host-written draft goes through the same grounding and substitution checks.
//
// Everything that generates text goes through `complete()`, so the rest of the writer never knows
// which of the three answered. Usage is counted here, per model, and a locally hosted model is
// billed as what it costs: nothing (PRICING.openai.local, src/config.mjs).

import OpenAI from "openai";

import { OPENAI_MODEL, WRITER_MODEL_VAR, WRITER_URL_VAR, loadEnv, writerFromEnv } from "../config.mjs";

const TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3; // SDK retries 408/409/429/5xx + connection errors, honouring Retry-After
const LOCAL_ATTEMPTS = 2; // one reply + one "that was not JSON" re-ask
const REASONING_MODEL = /^(gpt-5|o\d)/;

/** The by_model key every locally hosted model is counted under; PRICING rates it at $0. */
export const LOCAL_USAGE_KEY = "local";

export class WriterError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "WriterError";
    Object.assign(this, extra);
  }
}

/**
 * No writer model is configured: this text has to be written by whoever is driving the runner.
 * Not a failure — `src/plan/draft.mjs` catches it and asks the host for the paragraph instead.
 */
export class HostWriterRequired extends WriterError {
  constructor(what = "this answer") {
    super(`no writer model is configured — ${what} must be written by the host agent`);
    this.name = "HostWriterRequired";
    this.what = what;
  }
}

// ------------------------------------------------------------------ detection

let _detected = null;

/**
 * Which backend this process writes with. Memoised: the answer is read once per run and printed
 * in logs, so it must not change under a caller mid-posting.
 * @param {{refresh?: boolean}} [opts] `refresh` re-reads the environment (tests, `--detect`).
 * @returns {{kind:"openai"|"local"|"host", model:string|null, baseURL:string|null}}
 */
export function detectWriter({ refresh = false } = {}) {
  if (_detected && !refresh) return _detected;
  // Read *before* the env file is loaded: a writer URL that was already in the environment is
  // this run's explicit choice, while one that arrives from the env file is ordinary config.
  const preferLocal = Boolean(String(process.env[WRITER_URL_VAR] ?? "").trim());
  // The env file is where the user's keys live, but a missing or unreadable one is not fatal
  // here: "no key" is a backend (`host`), not an error.
  try {
    loadEnv({ require: [] });
  } catch {
    /* ignore — detection falls back to the process environment */
  }
  _detected = writerFromEnv(process.env, { preferLocal });
  return _detected;
}

/** One line for a log or `--detect`. Never prints key material — only which backend answered. */
export function describeWriter(cfg = detectWriter()) {
  if (cfg.kind === "openai") return `openai · ${cfg.model}`;
  if (cfg.kind === "local") {
    return `local · ${cfg.baseURL} · ${cfg.model ?? `model not set (${WRITER_MODEL_VAR})`}`;
  }
  return "host · no writer model configured; drafts are handed back to the host agent";
}

let _client = null;
let _clientKey = "";

function client(cfg) {
  const key = `${cfg.kind}\u0000${cfg.baseURL ?? ""}`;
  if (_client && _clientKey === key) return _client;
  _client =
    cfg.kind === "local"
      ? // A local server authenticates nothing; the SDK still insists on a non-empty string.
        new OpenAI({ apiKey: "local", baseURL: cfg.baseURL, timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES })
      : new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES });
  _clientKey = key;
  return _client;
}

/** Test seam: drop the memoised client and detection (e.g. after changing JEV_APPLY_HOME). */
export function resetWriter() {
  _client = null;
  _clientKey = "";
  _detected = null;
}

// ---------------------------------------------------------------------- usage

/**
 * What this process has spent, split by model — `gpt-5.4` and `gpt-5.4-mini` differ by 3.3× on
 * input, so one lump sum could not be priced. Counted per *billed* call: a response that arrives
 * `incomplete` or fails a post-check was still paid for, so it is recorded before those checks
 * run. A call that never reached a server is not. Local calls are counted too — the tokens are
 * real even though the bill is zero.
 */
const spent = new Map();

function record(model, usage) {
  const row = spent.get(model) ?? { calls: 0, input_tokens: 0, output_tokens: 0 };
  row.calls += 1;
  row.input_tokens += usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  row.output_tokens += usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  spent.set(model, row);
}

/** @returns {{calls:number, input_tokens:number, output_tokens:number, by_model:Record<string,object>}} */
export function usageTotals() {
  const total = { calls: 0, input_tokens: 0, output_tokens: 0, by_model: {} };
  for (const [model, row] of spent) {
    total.calls += row.calls;
    total.input_tokens += row.input_tokens;
    total.output_tokens += row.output_tokens;
    total.by_model[model] = { ...row };
  }
  return total;
}

/** Test seam: zero the counters (a benchmark that runs several postings in one process). */
export function resetUsage() {
  spent.clear();
}

// ----------------------------------------------------------------- the call

/**
 * One completion, whichever backend is configured. Always returns a parsed JSON object.
 *
 * @param {{system:string, input:string, schema?:object, name?:string, model?:string,
 *          effort?:string, maxTokens?:number, signal?:AbortSignal}} args
 * @throws {HostWriterRequired} when there is no writer model at all.
 */
export async function complete({ system, input, schema = null, name = "answer", model, effort = "low", maxTokens = 4000, signal } = {}) {
  const cfg = detectWriter();
  if (cfg.kind === "host") throw new HostWriterRequired(name);
  if (cfg.kind === "local") return localComplete(cfg, { system, input, schema, maxTokens, signal });
  return openaiComplete({ system, input, schema, name, model: model ?? cfg.model ?? OPENAI_MODEL, effort, maxTokens, signal });
}

// ---------------------------------------------------------------- openai

async function openaiComplete({ system, input, schema, name, model, effort, maxTokens, signal }) {
  const body = {
    model,
    instructions: system,
    input,
    max_output_tokens: maxTokens,
    ...(schema ? { text: { format: { type: "json_schema", name, schema, strict: true } } } : {}),
  };
  if (REASONING_MODEL.test(model)) body.reasoning = { effort };

  let res;
  try {
    res = await client({ kind: "openai", baseURL: null }).responses.create(body, { signal, timeout: TIMEOUT_MS });
  } catch (err) {
    throw new WriterError(`OpenAI ${model}: ${err?.status ?? ""} ${err?.message ?? err}`.trim(), {
      status: err?.status,
      cause: err,
    });
  }
  // Billed the moment the response exists — before `error`/`incomplete`/post-check rejections,
  // all of which still cost the tokens the model produced. Keyed by the model we asked for:
  // that is what PRICING is keyed by, and `res.model` may be a dated snapshot of it.
  record(model, res.usage);
  if (res.error) throw new WriterError(`OpenAI ${model}: ${res.error.message ?? res.error}`);
  if (res.status === "incomplete") {
    throw new WriterError(
      `OpenAI ${model} stopped early (${res.incomplete_details?.reason ?? "unknown"}); raise max_output_tokens`,
    );
  }
  const text = outputText(res, model);
  if (!text) throw new WriterError(`OpenAI ${model} returned no text`);
  const parsed = parseJson(text);
  if (!parsed) throw new WriterError(`OpenAI ${model} returned text that is not JSON: ${text.slice(0, 200)}`);
  return parsed;
}

function outputText(res, model) {
  const parts = [];
  for (const item of res.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === "output_text") parts.push(part.text);
      else if (part.type === "refusal") throw new WriterError(`OpenAI ${model} refused: ${part.refusal}`);
    }
  }
  const joined = parts.join("").trim();
  return joined || String(res.output_text ?? "").trim();
}

// ----------------------------------------------------------------- local

/**
 * The schema, as an instruction. Ollama and llama.cpp accept `response_format:{type:"json_object"}`
 * in most builds and `json_schema` in few, so the shape is stated in words as well — that is what
 * the parse/re-ask loop below is checking against.
 */
function jsonRules(schema) {
  const shape = schema ? `\n\nIt must match this JSON Schema exactly:\n${JSON.stringify(schema)}` : "";
  return `Reply with one JSON object and nothing else: no prose, no explanation, no code fence.${shape}`;
}

async function localComplete(cfg, { system, input, schema, maxTokens, signal }) {
  if (!cfg.model) {
    throw new WriterError(`${WRITER_URL_VAR} is set but ${WRITER_MODEL_VAR} is not — name the model your server serves`);
  }
  const messages = [
    { role: "system", content: `${system}\n\n${jsonRules(schema)}` },
    { role: "user", content: input },
  ];
  let last = "";
  for (let attempt = 1; attempt <= LOCAL_ATTEMPTS; attempt++) {
    last = await localCall(cfg, { messages, maxTokens, signal });
    const parsed = parseJson(last);
    if (parsed) return parsed;
    messages.push({ role: "assistant", content: last.slice(0, 2000) });
    messages.push({ role: "user", content: `That reply was not a JSON object. ${jsonRules(schema)}` });
  }
  throw new WriterError(`${cfg.model} at ${cfg.baseURL} returned text that is not JSON: ${last.slice(0, 200)}`);
}

/** One chat-completions round trip. Retries once without `response_format` for a server that rejects it. */
async function localCall(cfg, { messages, maxTokens, signal }) {
  const base = { model: cfg.model, messages, max_tokens: maxTokens, temperature: 0.3 };
  let res;
  try {
    res = await client(cfg).chat.completions.create({ ...base, response_format: { type: "json_object" } }, { signal, timeout: TIMEOUT_MS });
  } catch (err) {
    const rejected = err?.status >= 400 && err?.status < 500;
    if (!rejected) {
      throw new WriterError(`${cfg.model} at ${cfg.baseURL}: ${err?.status ?? ""} ${err?.message ?? err}`.trim(), {
        status: err?.status,
        cause: err,
      });
    }
    try {
      res = await client(cfg).chat.completions.create(base, { signal, timeout: TIMEOUT_MS });
    } catch (err2) {
      throw new WriterError(`${cfg.model} at ${cfg.baseURL}: ${err2?.status ?? ""} ${err2?.message ?? err2}`.trim(), {
        status: err2?.status,
        cause: err2,
      });
    }
  }
  record(LOCAL_USAGE_KEY, res.usage);
  const text = String(res.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new WriterError(`${cfg.model} at ${cfg.baseURL} returned no text`);
  return text;
}

/**
 * The JSON object in a reply that may also carry a code fence or a sentence of preamble.
 * @returns {object|null} null when there is no parseable object — the caller re-asks or throws.
 */
function parseJson(text) {
  const body = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const attempts = [body];
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first !== -1 && last > first) attempts.push(body.slice(first, last + 1));
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}
