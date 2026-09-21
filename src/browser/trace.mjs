// Append-only audit of every browser write.
// AGENTS invariant: "Every browser write is read back and logged to
// applications/<slug>/trace.jsonl" (PLAN §2.2 step 8).
//
// A row is exactly {ts, qid, selector, value_len, ok, observed, attempts} plus `op`/`control`
// so a later reader can tell a text fill from an upload, and `shot` when a failed set was
// photographed (PLAN §2.2 step 8: "a failed set after 2 attempts becomes action:'ask' with a
// screenshot"). The value itself is never written — only its length — and a `class:"sensitive"`
// question writes neither: its read-back text *is* the value, its length distinguishes the EEO
// options, and it is never photographed. Files land 0600 in a 0700 directory.

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { paths } from "../config.mjs";

/** `~/.config/jev-apply/applications/<slug>` — private, never under the repo. */
export function traceDir(slug) {
  return path.join(paths.applications, slug);
}

export function tracePath(slug) {
  return path.join(traceDir(slug), "trace.jsonl");
}

/**
 * Append one event; `ts` is stamped here so callers cannot forget it. Returns the row written.
 * The file is `0600` inside a `0700` directory: the trace carries saved-item ids, titles and job
 * state, and it is the file most likely to be copied out of the private tree for debugging.
 */
export async function appendTrace(slug, event) {
  if (!slug) return null;
  const row = { ts: new Date().toISOString(), ...event };
  const file = tracePath(slug);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
  return row;
}

/**
 * Normalise the `{ trace }` option the adapters take into an appender.
 * Accepts a slug string, a function (event) => void, `{ slug }`, or nothing (no-op).
 * The object form may also carry `{ mask }` — see `maskSelectors`.
 */
export function tracer(trace) {
  if (!trace) return async () => null;
  if (typeof trace === "function") return async (event) => trace({ ts: new Date().toISOString(), ...event });
  if (typeof trace === "string") return (event) => appendTrace(trace, event);
  if (typeof trace === "object" && trace.slug) return (event) => appendTrace(trace.slug, event);
  return async () => null;
}

/** The slug behind a `{ trace }` option, when there is one (a function sink has no directory). */
export function traceSlug(trace) {
  if (typeof trace === "string") return trace;
  if (trace && typeof trace === "object" && typeof trace.slug === "string") return trace.slug;
  return null;
}

/**
 * Every EEO/demographic control a failure screenshot must not photograph.
 * The caller passes its FormPlan (or a ready list of selectors) as `{ trace: { slug, mask } }`;
 * `mask` may be a FormPlan, its `questions` array, or selector strings. Only `class:"sensitive"`
 * questions contribute, and each contributes its own `selector` — the same field the adapters set.
 */
export function maskSelectors(mask) {
  const rows = Array.isArray(mask) ? mask : Array.isArray(mask?.questions) ? mask.questions : mask ? [mask] : [];
  const out = [];
  for (const row of rows) {
    if (typeof row === "string") {
      if (row.trim()) out.push(row.trim());
      continue;
    }
    if (row?.class === "sensitive" && typeof row.selector === "string" && row.selector.trim()) out.push(row.selector.trim());
  }
  return [...new Set(out)];
}

/**
 * Photograph a failed set so the `ask` row can show the user what the runner saw.
 * Never throws: a missing screenshot must not turn a field failure into a crash.
 *
 * A sensitive row is never photographed at all — the picture *is* the value `fieldEvent` redacts —
 * and for a failure anywhere else on the page every sensitive control named by `trace.mask` is
 * painted over by Playwright before the shutter, so one unrelated failure cannot photograph a
 * filled EEO block (AGENTS.md: EEO is never touched without an explicit preference).
 */
export async function captureFailure(page, trace, question) {
  const slug = traceSlug(trace);
  if (!slug || !page || page.isClosed?.()) return null;
  if (question?.class === "sensitive") return null;
  const qid = String(question?.qid ?? "field").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60);
  const file = path.join(traceDir(slug), "shots", `${qid}-${Date.now()}.png`);
  const selectors = typeof trace === "object" && trace ? maskSelectors(trace.mask) : [];
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const mask = selectors.map((selector) => page.locator(selector));
    await page.screenshot({ path: file, timeout: 10000, ...(mask.length ? { mask } : {}) });
    return file;
  } catch {
    return null;
  }
}

const REDACTED = "<redacted:sensitive>";

/** Count code points, not UTF-16 units, so emoji/accents do not inflate the length. */
export function valueLen(value) {
  return value == null ? 0 : [...String(value)].length;
}

/** Build the trace row for one set/upload. `question.class === "sensitive"` hides the observed text. */
export function fieldEvent({ op, question, value, result }) {
  const sensitive = question?.class === "sensitive";
  const observed = result?.observed == null ? "" : String(result.observed);
  return {
    op,
    qid: question?.qid ?? question?.id ?? null,
    control: question?.control ?? null,
    selector: result?.selector ?? question?.selector ?? null,
    // Redacted rows carry no length either: EEO option texts differ enough in length to identify.
    value_len: sensitive ? null : valueLen(value),
    ok: result?.ok === true,
    observed: sensitive ? REDACTED : observed,
    attempts: result?.attempts ?? 0,
    ...(result?.reason ? { reason: result.reason } : {}),
    ...(result?.shot ? { shot: result.shot } : {}),
  };
}
