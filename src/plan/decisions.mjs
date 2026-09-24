// The Decision record: gate, freeze, re-plan from the host's answers, and the `needs_user` payload.
// PLAN §2.2 steps 7 and 9, §2.3.
//
//   finalize()      one last pass through `src/jev/gates.mjs` — the only place a Decision's action
//                   is settled, so thresholds keep living in exactly one module.
//   freeze()/load() `applications/<slug>/decisions.json` (private, atomic).
//   applyAnswers()  `--answers answers.json` → `{ "<qid>": {value, remember_as:{kind,id}} }`:
//                   stores the answer as a memory row with `source: user` when the host asked for
//                   it, re-plans **only** the `ask` rows, and is idempotent — re-running with the
//                   same file changes nothing, because an answered row is no longer an `ask`.
//   needsUser()     the `{status:"needs_user", slug, questions:[…]}` payload, deduplicated so the
//                   same question asked twice on one form (or once per posting in a queue) is
//                   asked once.

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { slugify } from "../config.mjs";
import { asYesNo } from "../browser/readback.mjs";
import { traceDir } from "../browser/trace.mjs";
import { GATES } from "../jev/gates.mjs";
import { loadSection, saveSection } from "../memory/store.mjs";
import { mintId, stamp } from "../memory/schema.mjs";
import { resolvePreference, usableStories } from "../memory/resolve.mjs";
import { FACT_SEEKING_RE, fitsLimits } from "../schema/classes.mjs";
import { normalizeOption } from "../jev/plan.mjs";
import { applyDependencies, workAuthKind, yesNoOf } from "./resolve.mjs";
import { shapeRepeatAnswer } from "./repeat.mjs";

/** Internal planning fields never reach `decisions.json`. */
const INTERNAL = /^_/;

const isPlain = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// `applications/<slug>/` — "acme-123" style: the company plus the posting's own id. A Greenhouse id
// is a number the user can read back off the URL, so it is kept whole; only a 36-char Ashby UUID is
// shortened to its first group. The slug is user-facing: it is what `apply.mjs --resume <slug>` takes.
export function applicationSlug(formPlan) {
  const company = formPlan?.job?.company ?? formPlan?.ats ?? "job";
  const url = String(formPlan?.url ?? "");
  const uuid = url.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i);
  const numeric = url.match(/\/(\d{4,})(?:[/?#]|$)/);
  const id = uuid ? uuid[0].slice(0, 8) : (numeric?.[1] ?? Date.now().toString(36));
  return slugify(`${company}-${id}`);
}

export function decisionsPath(slug) {
  return path.join(traceDir(slug), "decisions.json");
}

export function summaryPath(slug) {
  return path.join(traceDir(slug), "summary.md");
}

/**
 * Settle every action against `src/jev/gates.mjs`. A Jev-scored row was gated when its answer came
 * back (`gate()` needs the whole distribution, which lives only there); a Decision keeps the two
 * numbers that survive the freeze — confidence and the runner-up gap — so this pass re-applies the
 * same two thresholds to rows that arrive from `decisions.json` and to rows a later stage rescored.
 * Nothing here invents a verdict for a row that was never scored.
 *
 * Given `{mem, context}` it also settles the two things that need the store rather than a score:
 * an answer longer than the field's stated limit is shown before Submit instead of committed, and
 * — when the user has turned `p.auto_draft` on — a "why us"/essay prompt nobody saved an answer for
 * becomes a `draft` for the writer rather than a question handed back (PLAN §2.2 step 10).
 */
export function finalize(decisions, { mem = null, context = null } = {}) {
  const out = decisions.map((d) => {
    const row = { ...d };
    // An evidence-based answer is never committed silently, whatever a later stage did to it:
    // `src/plan/infer.mjs` only ever writes `check`, and this is the one place that can be read
    // as the guarantee (`inferred_justified` refuses the submit if it is ever broken).
    if (row.source === "inferred" && row.action === "fill") row.action = "check";
    if (row.action !== "fill" || typeof row.confidence !== "number") return row;
    if (row.confidence < GATES.askBelow) row.action = "ask";
    else if (typeof row.gap === "number" && row.gap < GATES.checkGap) row.action = "check";
    return row;
  });
  enforceLimits(out);
  if (mem) autoDraft(out, { mem, context });
  return out;
}

/**
 * An answer longer than the field asks for is never truncated and never committed silently: the
 * row is downgraded to `check` so it is read before Submit. Round 1 put 140 words into a field
 * printed "In 100 words or less" and reported it as filled (judge §3.11).
 */
function enforceLimits(decisions) {
  for (const d of decisions) {
    if (d.action !== "fill" || typeof d.value !== "string" || !d._limits) continue;
    const fit = fitsLimits(d.value, d._limits);
    if (fit.ok) continue;
    d.action = "check";
    d.why = `${d.why} — ${fit.count} ${fit.over} against this field's ${fit.limit}-${fit.over.slice(0, -1)} limit; shorten before Submit`;
  }
}

/** The two classes the writer may draft from scratch (PLAN §2.2 step 10). */
const DRAFT_CLASSES = new Set(["why_us", "essay"]);

// A prompt that asks for a *fact* — which tool, how many, what languages you speak, what is your
// X — is answered by the user or it is not answered at all. Round 2 drafted "Python, PyTorch and
// CUDA" into 1Password's "As a PM which AI tool are you using on daily or weekly basis?", on a
// Senior PM posting (docs/research/13-eval-judge-round2.md §3 N3), and the ten-posting round then
// drafted an answer about spoken languages from a GPU-inference story
// (private/eval-shots/ten/findings.md). `classify()` now routes such a prompt to `circumstance`,
// which the `DRAFT_CLASSES` test already refuses; this is the belt behind that brace, and it
// covers `why_us` too — a "why us" that slips a fact into its wording is still a fact.

/**
 * `p.auto_draft` on: a required "Why us?" or essay prompt with nothing saved behind it is drafted
 * by the writer instead of handed back. Round 1 handed four of them to the user — two required, on
 * real postings — because Jev correctly answered `none_of_these`: no saved story *is* a "why this
 * company", so the draft path was unreachable (judge §4.1). Facts are untouched by this: a draft is
 * written from the posting plus material the user already wrote, never from a guessed fact, and it
 * is shown under ► DRAFTED before anything is submitted.
 *
 * The Decision carries `draft_request` for `src/plan/execute.mjs`: `{kind, limits, grounding_ids,
 * prompt, help}`. `value` stays empty until the writer fills it.
 */
export function autoDraft(decisions, { mem, context = {} } = {}) {
  const pref = resolvePreference(mem, "p.auto_draft", { company: context?.company, role_family: context?.role_family });
  if (!pref || yesNoOf(pref.value) !== "Yes") return decisions;
  for (const d of decisions) {
    if (d.action !== "ask" || !DRAFT_CLASSES.has(d.class)) continue;
    if (FACT_SEEKING_RE.test(d.label ?? "")) continue;
    // `why_us` is unconditional. An essay is drafted only where something on file grounds it —
    // a story Jev matched or a canonical question the bank holds, i.e. exactly the rows that
    // would have been `kind: "expand"`. `kind: "narrative"` was the "nothing on file answers
    // this" case wearing a draft request, and it goes back to being an `ask`.
    if (d.class !== "why_us" && !d.story && !d.canon) continue;
    const kind = d.class === "why_us" ? "why_us" : "expand";
    d.action = "draft";
    d.source = "writer";
    d.draft_request = {
      kind,
      limits: d._limits ?? null,
      grounding_ids: groundingIds(mem, kind, d),
      prompt: d.label ?? "",
      help: d._help ?? "",
    };
    d.why = `${kind === "why_us" ? "drafting from the posting" : "drafting from your saved material"} — p.auto_draft`;
    d._open = false;
    delete d.value;
    delete d.remember_as;
  }
  return decisions;
}

/**
 * The memory ids a draft is grounded on — ids, not text, so the writer reads the rows itself and
 * the frozen Decision stays small and auditable. Deterministic order, capped: what the user is
 * looking for, then the story Jev matched (if any), then their own material.
 */
function groundingIds(mem, kind, decision) {
  const ids = [];
  const take = (list, n) => {
    for (const id of list.slice(0, n)) if (id && !ids.includes(id)) ids.push(id);
  };
  const prefs = (mem?.preferences ?? []).map((r) => r?.id).filter((id) => typeof id === "string");
  take(prefs.filter((id) => id === "p.looking_for" || id.startsWith("p.looking_for.")), 6);
  if (decision.story) take([decision.story], 1);
  const stories = usableStories(mem).map((r) => r?.id).filter(Boolean);
  take(stories, kind === "why_us" ? 3 : 8);
  take((mem?.facts ?? []).map((r) => r?.id).filter((id) => typeof id === "string" && id.startsWith("f.skill.")), 4);
  if (kind !== "why_us") {
    take((mem?.answers ?? []).filter((r) => r?.kind === "narrative").map((r) => r?.qid).filter(Boolean), 3);
  }
  return ids.slice(0, 16);
}

/** Strip internals and empty keys so the frozen record is exactly the CONTRACTS shape (+class/section/topic). */
export function publicDecision(d) {
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (INTERNAL.test(k) || v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

export async function freeze(slug, decisions, meta = {}) {
  const file = decisionsPath(slug);
  await mkdir(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ slug, updated: new Date().toISOString(), ...meta, decisions: decisions.map(publicDecision) }, null, 1);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${body}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return file;
}

/** The frozen record, or null when this posting has never been planned. */
export async function load(slug) {
  const raw = await readFile(decisionsPath(slug), "utf8").catch(() => null);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.decisions) ? parsed : null;
  } catch {
    return null;
  }
}

/** A frozen plan is reusable only while it still describes this exact form. */
export function matchesForm(frozen, formPlan) {
  if (!frozen) return false;
  const want = (formPlan?.questions ?? []).map((q) => q.qid).sort();
  const have = (frozen.decisions ?? []).map((d) => d.qid).sort();
  return want.length === have.length && want.every((qid, i) => qid === have[i]);
}

/**
 * The identity of the form a plan was made against: the board, and every row's qid, control and
 * required flag, in the order the page publishes them. Deterministic and cheap — it is a
 * digest of the shape, never of an answer, so nothing personal is in it and two runs against an
 * unchanged posting produce the same string.
 */
export function formFingerprint(formPlan) {
  const rows = (formPlan?.questions ?? []).map((q) => `${q.qid}:${q.control ?? q.type ?? ""}:${q.required ? 1 : 0}`);
  const body = `${formPlan?.ats ?? ""}\n${rows.join("\n")}`;
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/**
 * B1 — plan-vs-schema identity. `apply.mjs --url` re-opens the tab, *reloads* it and re-fills from
 * scratch before it reaches the submit gate. While the posting is unchanged that is only wasted
 * work; when the board has changed the form underneath it, the re-fill silently discards the
 * state a human reviewed and Submit would send something nobody read.
 *
 * So a run that is about to re-fill compares the form **as the board publishes it** against the
 * fingerprint frozen beside the decisions. Both sides are the fetched schema, taken before stored
 * conditional rows are merged in and before the fill loop corrects a row's control to what the
 * page renders — otherwise the runner's own edits read as a changed board and every second run is
 * refused. The price is that a change only the live DOM shows (a conditional row that disappeared,
 * a control the board swapped) is no longer B1's to catch; `required_empty` and the read-backs are.
 * Different schema plus at least one row the page confirmed = refuse, and say what to do about it.
 * `--refill` is the user saying "re-fill it anyway", which is the only thing that may overrule this.
 *
 * A record frozen before fingerprints existed carries none; it is reported as unchecked rather
 * than refused, because refusing every pre-existing application would cost the user the runs it
 * is supposed to protect.
 *
 * @returns {{ok:boolean, checked:boolean, reason:string|null, detail:string|null}}
 */
export function refillGuard({ frozen = null, formPlan = null, form = null, refill = false } = {}) {
  const clear = (detail = null) => ({ ok: true, checked: true, reason: null, detail });
  if (!frozen) return clear();
  const reviewed = (frozen.decisions ?? []).filter((d) => d?.readback?.ok === true);
  if (!reviewed.length) return clear();
  if (!frozen.form) {
    return { ok: true, checked: false, reason: null, detail: "the frozen record predates the page fingerprint — its identity cannot be checked" };
  }
  const now = form ?? formFingerprint(formPlan);
  if (now === frozen.form) return clear();
  if (refill) return clear(`the form changed since the fill (${frozen.form} → ${now}) and --refill was given`);
  return {
    ok: false,
    checked: true,
    reason: "plan_identity",
    detail:
      `this posting's form does not match the one that was filled: ${reviewed.length} row(s) were written and read back against form ${frozen.form}, and it now digests as ${now}. ` +
      `Re-filling would discard what you reviewed — run \`apply.mjs --resume ${frozen.slug ?? "<slug>"}\` to see it, or re-run with --refill to plan the new form from scratch. ` +
      `A record frozen by an earlier version carries a fingerprint taken *after* the fill instead of before it, so its first run under this one is refused once although the board never changed.`,
  };
}

export async function writeSummary(slug, text) {
  const file = summaryPath(slug);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
  return file;
}

// ─── the host's answers ───────────────────────────────────────────────────────────────────────

export async function readAnswersFile(file) {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`answers file is not an object: ${file}`);
  return parsed;
}

/**
 * Apply `{qid:{value, remember_as}}` to the `ask` rows and store what the host asked us to store.
 * Rows that are not `ask` are left exactly as they are — that is what makes a second run with the
 * same file a no-op.
 *
 * `needsUser` folds rows that ask the same thing into one question, so the host can only ever
 * answer the qid that was emitted. The same key is rebuilt here and one answer settles every row
 * it folded — otherwise the folded rows stay `ask` and the status never leaves `needs_user`,
 * however many times the user answers.
 * @returns {Promise<{decisions:object[], applied:string[], ignored:string[], stored:object[], reopen:object[]}>}
 */
/**
 * A file question's answer → the file to attach: a saved document named by its id, its short name
 * or its file name, else a path to a regular file that exists. null when it names neither.
 *
 * A directory exists as happily as a file does, and attaching one fails in the browser, three
 * steps away from the answer that caused it — so the path has to be a file, here.
 */
export function answeredFile(value, documents = []) {
  const want = String(value ?? "").trim();
  if (!want) return null;
  const key = (s) => String(s ?? "").toLowerCase();
  const saved = documents.find(
    (d) =>
      d?.path &&
      [d.id, String(d.id ?? "").replace(/^doc\.resume\./, ""), path.basename(d.path), path.basename(d.path, path.extname(d.path))].some(
        (name) => key(name) === key(want),
      ),
  );
  if (saved) return saved.path;
  return statSync(want, { throwIfNoEntry: false })?.isFile() ? path.resolve(want) : null;
}

export async function applyAnswers(decisions, answers, { formPlan, context, persist = true, documents = [] } = {}) {
  const byQid = new Map((formPlan?.questions ?? []).map((q) => [q.qid, q]));
  const out = decisions.map((d) => ({ ...d }));
  const applied = [];
  const ignored = [];
  const rows = [];
  const reopen = [];

  const folded = new Map();
  for (const d of out) {
    if (d.action !== "ask" || answers[d.qid] === undefined) continue;
    const key = askKey(d);
    if (!folded.has(key)) folded.set(key, answers[d.qid]);
  }

  for (const d of out) {
    const answer = answers[d.qid] ?? (d.action === "ask" ? folded.get(askKey(d)) : undefined);
    if (answer === undefined || answer === null) continue;
    if (d.action !== "ask") {
      ignored.push(d.qid);
      continue;
    }
    const value = typeof answer === "string" ? answer : answer.value;
    if (value === undefined || value === null || value === "") {
      ignored.push(d.qid);
      continue;
    }
    const q = byQid.get(d.qid);
    if (q?.type === "file" || q?.control === "file") {
      const file = answeredFile(value, documents);
      if (!file) {
        d.why = `no saved document or file named "${value}" — answer with one of your saved résumés, or save a new one first (learn.mjs --resume <file>)`;
        ignored.push(d.qid);
        continue;
      }
      Object.assign(d, { source: "user", value: path.basename(file), path: file, action: "fill", confidence: undefined, gap: undefined, why: "you chose this file (this application only)" });
      delete d.remember_as;
      applied.push(d.qid);
      continue;
    }
    // One answer can reach two boxes of a history entry ("2016-08" → Start month + Start year):
    // each takes the half it needs, and a box the answer does not cover stays with the user.
    const shaped = q?.repeat ? shapeRepeatAnswer(q, value) : String(value);
    if (shaped == null) {
      ignored.push(d.qid);
      continue;
    }
    d.source = "user";
    d.value = shaped;
    d.action = "fill";
    d.confidence = undefined;
    d.gap = undefined;
    const remember = typeof answer === "object" ? answer.remember_as : null;
    d.why = remember ? "you answered — remembered" : "you answered (this application only)";
    applied.push(d.qid);

    // A select the user answered still needs its option: exact label first, Jev only if needed.
    const labels = (q?.options ?? []).map((o) => (typeof o === "string" ? o : o?.label)).filter(Boolean);
    if (labels.length) {
      const exact = labels.find((label) => normalizeOption(label) === normalizeOption(d.value));
      if (exact) d.option = exact;
      else {
        d._answerText = d.value;
        reopen.push(d);
      }
    }
    // Month and year rows share one memory home; the date is stored once, as the user wrote it.
    if (remember && !(q?.repeat && rows.some((r) => r?.row?.id === remember.id))) {
      rows.push(memoryRow({ decision: d, question: q, remember, value: String(value), context }));
    }
  }

  // The parent of a conditional follow-up may be one of the rows just answered, so the dependency
  // pass runs again: a child blanked because nobody had answered its parent yet comes back exactly
  // as it was planned, and one whose parent now says the other thing stays blank
  // (src/plan/resolve.mjs applyDependencies).
  applyDependencies(out, formPlan?.questions ?? []);

  const stored = rows.filter(Boolean);
  if (persist && stored.length) await persistRows(stored);
  return { decisions: out, applied, ignored, stored, reopen };
}

/**
 * The `remember_as` a question is asked with: the kind of row the answer becomes and the id it
 * belongs under, and nothing else. Where it is saved is this module's business, not a question
 * the user is ever shown or has to hand back (`memoryRow`).
 */
const askedAs = (remember) => ({ kind: remember.kind, ...(remember.id ? { id: remember.id } : {}) });

/** answers.json `remember_as` → the memory row to write, with `source: user` (PLAN §2.4). */
function memoryRow({ decision, question, remember, value, context }) {
  const kind = String(remember.kind ?? "").toLowerCase();
  const updated = stamp();

  if (kind === "fact") {
    const id = remember.id ?? mintId("facts", question?.label ?? decision.label, new Set(), { namespace: "user" });
    // Work authorization is two-valued per country (PLAN §2.4) and `derive.workAuth` reads nothing
    // else: a bare "Yes" is written, read back as unusable, and the question is re-asked on every
    // later application. One Yes/No settles one half; the other half arrives from the form's other
    // work-auth question (same answers file) or from what is already on file — `merge` below.
    if (/^f\.work_auth\./.test(id)) {
      const half = workAuthHalf(decision.label ?? question?.label ?? "", value);
      if (half) return { section: "facts", row: { id, value: half, source: "user", updated }, merge: "object" };
    }
    return { section: "facts", row: { id, value, source: "user", updated } };
  }
  if (kind === "preference") {
    const id = remember.id ?? mintId("preferences", question?.label ?? decision.label, new Set(), { namespace: "user" });
    return { section: "preferences", row: { id, value, source: "user", updated } };
  }
  if (kind === "story") {
    const id = remember.id ?? mintId("stories", decision.label, new Set(), { namespace: "user" });
    return { section: "stories", row: { id, kind: "answer", title: decision.label, text: value, source: "user", updated } };
  }
  if (kind === "answer" || kind === "") {
    const qid = remember.id ?? mintId("answers", decision.label, new Set(), { namespace: "user" });
    const answerKind = question?.class === "policy_gate" ? "policy" : question?.class === "why_us" ? "company" : "constant";
    // A question about *this* company is one answer per company (PLAN §2.4): saved globally, the
    // next employer's form would be filled with the sentence the user wrote about this one. The
    // home comes from the question's own class and the posting being applied to — never from
    // anything the host sent back, and never from a scope the user was asked to name.
    const home = PER_COMPANY.has(question?.class) && context?.company ? `company:${slugify(context.company)}` : "global";
    return {
      section: "answers",
      row: { qid, kind: answerKind, value, scope: home, source: "user", reviewed: true, updated, ...(context?.role_family ? { family: context.role_family } : {}) },
    };
  }
  return null;
}

/**
 * One Yes/No about work authorization → the half of `{authorized_now, needs_sponsorship_future}`
 * it actually states (PLAN §2.4). "Authorized to work without sponsorship?" states both halves
 * when the answer is Yes and neither when it is No — not authorized, or authorized but sponsored,
 * and the form does not say which — so that case returns null and nothing is invented.
 */
function workAuthHalf(label, value) {
  const text = String(value ?? "");
  const yn = asYesNo(text) ?? (/^\s*yes\b/i.test(text) ? "yes" : /^\s*no\b/i.test(text) ? "no" : null);
  if (!yn) return null;
  const yes = yn === "yes";
  const kind = workAuthKind(label);
  if (kind === "sponsorship") return { needs_sponsorship_future: yes };
  if (kind === "authorized") return { authorized_now: yes };
  return yes ? { authorized_now: true, needs_sponsorship_future: false } : null;
}

/**
 * Write the rows, one `saveSection` per touched section. Preferences are one row each: the user
 * states how they want applications answered, and it holds for every application.
 */
async function persistRows(rows) {
  const bySection = new Map();
  for (const { section, row, merge } of rows) {
    if (!bySection.has(section)) bySection.set(section, await loadSection(section));
    const list = bySection.get(section);
    const key = section === "answers" ? (r) => r?.qid === row.qid && (r?.scope ?? "global") === (row.scope ?? "global") : (r) => r?.id === row.id;
    const at = list.findIndex(key);
    const stored = section === "preferences" ? { id: row.id, value: row.value, source: "user", updated: row.updated } : row;
    if (at === -1) list.push(stored);
    // A two-valued fact is completed, never replaced: answering "do you need sponsorship?" must
    // not erase the `authorized_now` half a second question (or an earlier run) already settled.
    else if (merge === "object" && isPlain(list[at]?.value) && isPlain(row.value)) list[at] = { ...list[at], ...stored, value: { ...list[at].value, ...row.value } };
    else list[at] = { ...list[at], ...stored };
  }
  for (const [section, list] of bySection) await saveSection(section, list);
}

// ─── needs_user ───────────────────────────────────────────────────────────────────────────────

/** Questions that are about *this* company are never folded across postings (PLAN §2.4 scopes). */
const PER_COMPANY = new Set(["why_us", "company_specific", "policy_gate"]);

/**
 * The key a question is folded by: the canonical question when Jev matched one, the normalised
 * label otherwise. `applyAnswers` rebuilds it, so whatever folds here is answerable by one answer.
 * With a `slug`, company-scoped classes are kept apart — "why us?" is one sentence *per company*.
 */
export function askKey(d, slug = null) {
  const base = d.canon ?? normalizeOption(d.label ?? "");
  return slug && PER_COMPANY.has(d.class) ? `${slug}::${base}` : base;
}

/**
 * The host-facing payload. Deduplicated by canonical id when there is one and by normalised label
 * otherwise, so "visa sponsorship?" is asked once even when two forms (or two sections) ask it.
 */
export function needsUser(decisions, slug) {
  const seen = new Map();
  for (const d of decisions) {
    if (d.action !== "ask") continue;
    const key = askKey(d);
    if (seen.has(key)) {
      seen.get(key).also.push(d.qid);
      continue;
    }
    seen.set(key, {
      qid: d.qid,
      label: d.label,
      ...(d.options?.length ? { options: d.options } : {}),
      ...(d.remember_as ? { remember_as: askedAs(d.remember_as) } : {}),
      why: d.why,
      also: [],
    });
  }
  const questions = [...seen.values()].map(({ also, ...q }) => (also.length ? { ...q, same_as: also } : q));
  return { status: "needs_user", slug, questions };
}

/**
 * Queue mode (PLAN §2.5, last paragraph): **one** batch of questions for N postings. The same fold
 * as `needsUser`, widened across postings — "do you need sponsorship?" is asked once and stored as
 * a fact, while `why_us` stays one sentence per company. Each question carries `<slug>:<qid>` as
 * its id and the rows it settles, so `routeAnswers` can put one answer on every posting that asked.
 * @param {Array<{slug:string, decisions:object[]}>} postings
 */
export function mergedNeedsUser(postings) {
  const seen = new Map();
  for (const posting of postings) {
    for (const d of posting.decisions ?? []) {
      if (d.action !== "ask") continue;
      const key = askKey(d, posting.slug);
      if (!seen.has(key)) {
        seen.set(key, {
          qid: `${posting.slug}:${d.qid}`,
          label: d.label,
          ...(d.options?.length ? { options: d.options } : {}),
          ...(d.remember_as ? { remember_as: askedAs(d.remember_as) } : {}),
          why: d.why,
          asked_by: [],
          applies_to: [],
        });
      }
      const q = seen.get(key);
      q.applies_to.push({ slug: posting.slug, qid: d.qid });
      if (!q.asked_by.includes(posting.company ?? posting.slug)) q.asked_by.push(posting.company ?? posting.slug);
    }
  }
  return [...seen.values()].map(({ asked_by, ...q }) => (asked_by.length > 1 ? { ...q, asked_by } : q));
}

/**
 * One merged answers file → what each posting should be handed. Accepts the merged `<slug>:<qid>`
 * id, a bare qid, and the fold key, so an answer written against any of the three lands everywhere
 * that question was asked.
 * @returns {Map<string, Record<string, object>>} slug → the posting's own answers object
 */
export function routeAnswers(answers, postings) {
  const out = new Map(postings.map((p) => [p.slug, {}]));
  const merged = mergedNeedsUser(postings);
  const targets = new Map();
  for (const q of merged) {
    const rows = q.applies_to;
    targets.set(q.qid, rows);
    for (const row of rows) {
      if (!targets.has(row.qid)) targets.set(row.qid, rows);
      targets.set(`${row.slug}:${row.qid}`, [row]);
    }
  }
  for (const [key, answer] of Object.entries(answers ?? {})) {
    for (const row of targets.get(key) ?? []) {
      const bucket = out.get(row.slug);
      if (bucket && bucket[row.qid] === undefined) bucket[row.qid] = answer;
    }
  }
  return out;
}

/** `--resume <slug>`: every Decision that is not on the form yet, with the value it was going to get. */
export function unfilled(decisions, { live = null } = {}) {
  const stillEmpty = live ? new Set(live.filter((r) => !r.filled).map((r) => String(r.qid ?? r.selector))) : null;
  return decisions
    .filter((d) => d.action !== "skip")
    .filter((d) => (stillEmpty ? stillEmpty.has(String(d.qid)) || d.readback?.ok !== true : d.readback?.ok !== true))
    .map((d) => ({
      qid: d.qid,
      label: d.label,
      action: d.action,
      value: d.class === "sensitive" ? "••••" : d.option ?? d.value ?? null,
      why: d.why,
      ...(d.readback ? { readback: d.readback } : {}),
      ...(d.shot ? { screenshot: d.shot } : {}),
    }));
}

/**
 * The facts about a row that come from the form itself rather than from memory: the vocabulary a
 * `needs_user` question offers the host, and whether the board marks the control required.
 *
 * `required` is carried onto the Decision — and through `publicDecision` into `decisions.json` —
 * because "required and empty" was otherwise only countable live, off the page: every
 * required/optional judgement in five graded rounds was read off an asterisk in a screenshot
 * (docs/POSTMORTEM.md B2). A form that says nothing about a row leaves it `false`, which is what
 * a board not marking a control means; a row the plan has no question for keeps whatever it came
 * in with.
 */
export function withFormFacts(decisions, formPlan) {
  const byQid = new Map((formPlan?.questions ?? []).map((q) => [q.qid, q]));
  return decisions.map((d) => {
    const q = byQid.get(d.qid);
    if (!q) return d;
    const options = (q.options ?? []).map((o) => (typeof o === "string" ? o : o?.label)).filter(Boolean);
    return { ...d, required: Boolean(q.required), ...(options.length ? { options } : {}) };
  });
}

/** fill + check = filled; the denominator is every question on the form (PLAN §2.6). */
export function tally(decisions) {
  const count = (action) => decisions.filter((d) => d.action === action).length;
  return {
    total: decisions.length,
    filled: count("fill") + count("check"),
    checks: count("check"),
    asks: count("ask"),
    drafted: count("draft"),
    skipped: count("skip"),
  };
}
