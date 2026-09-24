// Shapes of the private memory store (PLAN §2.4): section names, file names, the scope grammar,
// row identity and row validation. Pure — no I/O, no config import — so any slice can use it to
// build a row without touching the user's disk.

/** One YAML file per section, in the order a human reads them. */
export const SECTIONS = ["facts", "preferences", "documents", "answers", "stories", "drafts", "corrections"];

export const SECTION_FILE = Object.freeze(Object.fromEntries(SECTIONS.map((s) => [s, `${s}.yaml`])));

/** Id namespace per section. `drafts`/`corrections` use bare handles (`d1`, `c1`). */
export const ID_PREFIX = Object.freeze({
  facts: "f.",
  preferences: "p.",
  documents: "doc.",
  answers: "q.",
  stories: "b.",
  drafts: "d",
  corrections: "c",
});

/** `answers[].kind` (PLAN §2.4). `never` = saved, but never offered by the resolver. */
export const ANSWER_KINDS = Object.freeze(["constant", "rule", "policy", "narrative", "company", "never"]);

/** The only source value that model-written rows may never overwrite. */
export const SOURCE_USER = "user";

/** Scope precedence: company beats role_family beats global (PLAN §2.4). */
export const SCOPE_RANK = Object.freeze({ company: 3, role_family: 2, global: 1 });

/**
 * The canonical values `p.eeo` may hold, one list per field (docs/CONTRACTS.md, PLAN §2.4 D10).
 * This is the *store's* vocabulary: `canon/vocab/eeo-*.yaml` maps a form's own option wording onto
 * exactly these tokens, and `src/plan/resolve.mjs` refuses to load a map file that names one this
 * list does not carry, so the two can never drift apart. `pronouns` is free text (the user's own
 * phrase) and `other_demographics` is the standing stance for demographic questions none of the
 * five fields answers — `decline` fills the form's decline option, `ask` (the default when the key
 * is absent) leaves the question for the user.
 */
export const EEO_VALUES = Object.freeze({
  gender: Object.freeze(["male", "female", "non_binary", "decline"]),
  hispanic_latino: Object.freeze(["yes", "no", "decline"]),
  race: Object.freeze([
    "american_indian",
    "asian",
    "black",
    "hispanic_latino",
    "native_hawaiian",
    "white",
    "two_or_more",
    "decline",
  ]),
  veteran_status: Object.freeze(["not_veteran", "veteran", "decline"]),
  disability_status: Object.freeze(["yes", "no", "decline"]),
  other_demographics: Object.freeze(["decline", "ask"]),
});

/**
 * Preference ids whose value is a plain standing Yes/No the resolver fills forms from. The whole
 * `p.legal.*` namespace is Yes/No by construction: besides the two stances below it holds one row
 * per acknowledgement the user has agreed to stand behind (`p.legal.privacy_policy_ack`,
 * `p.legal.background_check_consent`, …), which is the only thing `policyGateRow()` in
 * `src/plan/resolve.mjs` will answer an attestation from.
 */
export const YES_NO_PREFERENCES = Object.freeze(["p.legal.restrictive_agreements", "p.legal.previously_employed"]);

/**
 * The one blanket legal stance: "accept the standard application acknowledgements — truthfulness,
 * interview recording, privacy — automatically?" (`scripts/learn.mjs` asks it once). It answers a
 * gate *only* when that gate has no `p.legal.<slug>` of its own, only for those three subjects,
 * only through the evidence tier's justification check, and never for an arbitration clause or any
 * other gate that commits the candidate to something (`src/plan/infer.mjs`).
 */
export const STANDARD_ACKS_ID = "p.legal.standard_acks";

/** Booleans the runner reads as behaviour switches; absent is *unanswered*, never "no". */
export const SWITCH_PREFERENCES = Object.freeze(["p.auto_submit", "p.auto_draft"]);

/**
 * The ids memory already has a meaning for, each with the one line a selector needs to tell them
 * apart, and the shape its value takes:
 *
 *   `text`    the user's own words, stored as stated.
 *   `yes_no`  a standing stance; anything that does not state a plain Yes or No is refused.
 *
 * `scripts/remember.mjs` offers these — plus whatever ids the store already holds — as the
 * criteria of one Jev choice, so "I currently live in <city>" lands on `f.identity.city` instead
 * of minting `f.user.i_currently_live_in_<city>`, a row no resolver rule ever reads. Ids whose
 * value is a *structure* (`p.eeo` as a whole block, `p.salary`, `p.notice_rule`,
 * `p.looking_for`, `f.work_auth.<CC>`) are deliberately absent: a spoken sentence cannot build
 * one, and a wrong shape under a right id is worse than an honest new row. Those are written by
 * `learn.mjs` and by a form answer's own `remember_as`.
 */
export const ID_CATALOGUE = Object.freeze({
  "f.identity.full_name": { shape: "text", what: "The user's full name, as they write it." },
  "f.identity.first_name": { shape: "text", what: "The user's given name on its own." },
  "f.identity.last_name": { shape: "text", what: "The user's family name on its own." },
  "f.identity.preferred_name": { shape: "text", what: "The name the user prefers to be called, when it differs from their legal one." },
  "f.identity.full_name_native": { shape: "text", what: "The user's name written in another script or language." },
  "f.identity.email": { shape: "text", what: "The user's email address." },
  "f.identity.phone": { shape: "text", what: "The user's phone number." },
  "f.identity.address": { shape: "text", what: "The user's street or mailing address." },
  "f.identity.city": { shape: "text", what: "The city (and country) the user lives in — where they currently reside or are based." },
  "f.identity.location": { shape: "text", what: "Where the user works from, in their own words: a place, or a work mode such as Remote." },
  "f.identity.citizenship": { shape: "text", what: "The country the user is a citizen or national of." },
  "f.identity.pronouns": { shape: "text", what: "The pronouns the user goes by." },
  "f.identity.start_date": { shape: "text", what: "The date the user could start work." },
  "f.identity.linkedin_url": { shape: "text", what: "The user's LinkedIn profile URL." },
  "f.identity.github_url": { shape: "text", what: "The user's GitHub profile URL." },
  "f.identity.site_url": { shape: "text", what: "The user's personal website or blog URL." },
  "f.identity.portfolio_url": { shape: "text", what: "The user's portfolio URL." },
  "f.identity.scholar_url": { shape: "text", what: "The user's Google Scholar or publications URL." },
  "f.identity.x_twitter_url": { shape: "text", what: "The user's X / Twitter profile URL." },
  "f.employment.current": { shape: "text", what: "Where the user works now — their current or most recent employer." },
  "f.employment.current_title": { shape: "text", what: "The user's current or most recent job title." },
  "p.how_heard": { shape: "text", what: "The channel the user wants named when a form asks how they heard about a company." },
  "p.in_office": { shape: "text", what: "How often the user will be in an office — days a week, remote, hybrid." },
  "p.accommodation": { shape: "text", what: "What the user wants said when a form asks whether they need an accommodation or adjustment for the hiring process." },
  "p.relocation": { shape: "yes_no", what: "Whether the user is willing to relocate for a role." },
  "p.legal.restrictive_agreements": { shape: "yes_no", what: "Whether the user is bound by a non-compete, non-solicit or similar restrictive agreement." },
  // `p.legal.previously_employed` is deliberately absent: "have you ever worked here?" is a
  // different question at every employer, so a row the user states once holds no answer to it
  // (`src/plan/resolve.mjs` ignores a global one on purpose and derives it from the pipeline).
  // Filing a spoken sentence there would store a stance nothing ever reads.
  "p.legal.privacy_policy_ack": { shape: "yes_no", what: "Whether the user agrees to a company's candidate privacy policy or notice." },
  "p.legal.background_check_consent": { shape: "yes_no", what: "Whether the user consents to a background or reference check." },
  "p.legal.interview_recording_consent": { shape: "yes_no", what: "Whether the user consents to interviews being recorded." },
  "p.legal.arbitration_ack": { shape: "yes_no", what: "Whether the user agrees to an arbitration clause." },
  "p.legal.ai_usage_ack": { shape: "yes_no", what: "Whether the user agrees to a company's rules about using AI tools during hiring." },
  "p.legal.retention_consent": { shape: "yes_no", what: "Whether the user agrees to their application being kept on file for future roles." },
  "p.legal.terms_ack": { shape: "yes_no", what: "Whether the user agrees to a company's terms of use or code of conduct." },
  "p.legal.application_truthful_ack": { shape: "yes_no", what: "Whether the user attests that their application is truthful and complete." },
  "p.legal.export_control_ack": { shape: "yes_no", what: "Whether the user agrees to an export-control or sanctions attestation." },
  "p.legal.standard_acks": {
    shape: "yes_no",
    what: "Whether the assistant may accept the standard application acknowledgements — truthfulness, interview recording, privacy — on the user's behalf, without asking each time.",
  },
  "p.eeo.gender": { shape: "text", what: "What the user answers when a form asks their gender." },
  "p.eeo.race": { shape: "text", what: "What the user answers when a form asks their race." },
  "p.eeo.hispanic_latino": { shape: "text", what: "What the user answers when a form asks whether they are Hispanic or Latino." },
  "p.eeo.veteran_status": { shape: "text", what: "What the user answers when a form asks about military or veteran status." },
  "p.eeo.disability_status": { shape: "text", what: "What the user answers when a form asks about disability status." },
  "p.eeo.other_demographics": { shape: "text", what: "The user's standing stance (decline, or ask me) for demographic questions outside the five EEO fields." },
  "p.eeo.pronouns": { shape: "text", what: "The pronouns the user wants given on a demographic survey." },
  "p.auto_submit": { shape: "yes_no", what: "Whether the runner may click Submit without asking first." },
  "p.auto_draft": { shape: "yes_no", what: "Whether the writer may draft a why-us or essay answer instead of handing it back." },
});

const YES_NO_RE = /^(yes|no)$/i;
const TRUTHY_RE = /^(yes|no|true|false|on|off)$/i;

const REQUIRED = Object.freeze({
  facts: ["id", "value", "source"],
  preferences: ["id", "source"], // `value` may be null when only `overrides[]` carry values
  documents: ["id", "path"],
  answers: ["qid", "kind", "source"],
  stories: ["id", "text"],
  drafts: ["id", "text"],
  corrections: ["id", "rule", "when"],
});

const SINCE_RE = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/;

/** `"2026-09-22"` — the store's only timestamp format. */
export function stamp(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

/** `since:`/`until:` accept `YYYY`, `YYYY-MM`, `YYYY-MM-DD`; anything else is a validation error. */
export function parseSince(value) {
  const m = SINCE_RE.exec(String(value ?? "").trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2] ?? 1) - 1, Number(m[3] ?? 1)));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `"global"` | `"company:acme"` | `"role_family:ml_engineer"` → `{kind, key, text}`; else `null`. */
export function parseScope(scope) {
  if (scope == null || scope === "" || scope === "global") return { kind: "global", key: null, text: "global" };
  if (typeof scope !== "string") return null;
  const cut = scope.indexOf(":");
  if (cut < 0) return null;
  const kind = scope.slice(0, cut).trim();
  const key = scope.slice(cut + 1).trim();
  if (!key || (kind !== "company" && kind !== "role_family")) return null;
  return { kind, key, text: `${kind}:${key}` };
}

export function scopeRank(scope) {
  const parsed = parseScope(scope);
  return parsed ? SCOPE_RANK[parsed.kind] : 0;
}

/**
 * Row identity for upsert/merge. Answers are keyed by canonical question **and** scope/family,
 * because the same question has a different answer per company or role family.
 */
export function rowKey(section, row) {
  if (!row || typeof row !== "object") return null;
  if (section === "answers") {
    const qid = typeof row.qid === "string" ? row.qid : null;
    return qid ? `${qid}|${parseScope(row.scope)?.text ?? "global"}|${row.family ?? ""}` : null;
  }
  return typeof row.id === "string" && row.id ? row.id : null;
}

/** A row the user stated themselves; model proposals never overwrite one (PLAN §2.4). */
export function isUserSourced(row) {
  return typeof row?.source === "string" && row.source.trim().toLowerCase() === SOURCE_USER;
}

export function emptyMemory() {
  return Object.fromEntries(SECTIONS.map((s) => [s, []]));
}

/** @returns {string[]} problems; empty means the row is storable. */
export function validateRow(section, row) {
  const problems = [];
  if (!SECTIONS.includes(section)) return [`unknown section ${section}`];
  if (!row || typeof row !== "object" || Array.isArray(row)) return [`${section} row is not a mapping`];

  for (const key of REQUIRED[section]) {
    const value = row[key];
    if (value === undefined || value === null || value === "") problems.push(`${section}: missing ${key}`);
  }
  if (!rowKey(section, row)) problems.push(`${section}: row has no usable id`);

  if (row.scope !== undefined && !parseScope(row.scope)) problems.push(`${section}: bad scope ${JSON.stringify(row.scope)}`);
  if (row.since !== undefined && !parseSince(row.since)) problems.push(`${section}: bad since ${JSON.stringify(row.since)}`);

  if (section === "preferences" && row.overrides !== undefined) {
    if (!Array.isArray(row.overrides)) problems.push("preferences: overrides is not a list");
    else {
      for (const ov of row.overrides) {
        if (!ov || typeof ov !== "object") problems.push("preferences: override is not a mapping");
        else if (!parseScope(ov.scope) || ov.scope === "global") problems.push(`preferences: bad override scope ${JSON.stringify(ov?.scope)}`);
      }
    }
  }
  if (section === "preferences") {
    for (const { value, where } of [{ value: row.value, where: "" }, ...(Array.isArray(row.overrides) ? row.overrides : []).map((ov) => ({ value: ov?.value, where: ` (${ov?.scope})` }))]) {
      if (value === undefined || value === null) continue;
      problems.push(...preferenceValueProblems(row.id, value).map((p) => `${p}${where}`));
    }
  }
  if (section === "documents" && row.role_families !== undefined && !Array.isArray(row.role_families)) {
    problems.push("documents: role_families is not a list");
  }
  if (section === "answers") {
    if (row.kind !== undefined && !ANSWER_KINDS.includes(row.kind)) problems.push(`answers: unknown kind ${JSON.stringify(row.kind)}`);
    if (row.value === undefined && row.rule_ref === undefined && row.variants === undefined && row.kind !== "never") {
      problems.push("answers: needs one of value, rule_ref, variants");
    }
  }
  if (section === "stories" && row.tags !== undefined && !Array.isArray(row.tags)) problems.push("stories: tags is not a list");
  return problems;
}

/**
 * The preference values other code *reads as a shape* rather than as free text, checked where they
 * are written instead of where they are used: a typo in `p.eeo.race` would otherwise surface half
 * an hour later as "this form's list has no entry for your saved race", a `p.auto_submit: "maybe"`
 * would read as "do not submit" without ever saying so, and a `p.legal.<slug>` that does not state
 * a plain Yes or No would leave an attestation asked on every form for no visible reason.
 * @returns {string[]}
 */
function preferenceValueProblems(id, value) {
  if (id === "p.eeo") {
    if (typeof value !== "object" || Array.isArray(value)) return ["preferences: p.eeo is not a mapping of fields"];
    const problems = [];
    for (const [field, stated] of Object.entries(value)) {
      if (stated === null || stated === undefined || stated === "") continue;
      if (field === "pronouns") {
        if (typeof stated !== "string") problems.push("preferences: p.eeo.pronouns is not text");
        continue;
      }
      const allowed = EEO_VALUES[field];
      if (!allowed) problems.push(`preferences: unknown p.eeo field ${JSON.stringify(field)}`);
      else if (!allowed.includes(String(stated).toLowerCase())) {
        problems.push(`preferences: p.eeo.${field} must be one of ${allowed.join(" | ")}`);
      }
    }
    return problems;
  }
  // One field on its own: the id `remember_as` hands the host when the user answers a demographic
  // row on a form (`src/plan/decisions.mjs memoryRow()`). Its value is whatever the *form* called
  // that answer ("Male", "I am not a protected veteran"), which only `canon/vocab/eeo-*.yaml` can
  // read — so the field name is checked here and the wording is left to the resolver.
  if (id?.startsWith?.("p.eeo.")) {
    const field = id.slice("p.eeo.".length);
    if (field !== "pronouns" && !EEO_VALUES[field]) return [`preferences: unknown p.eeo field ${JSON.stringify(field)}`];
    const stated = value && typeof value === "object" && !Array.isArray(value) ? value.answer ?? value.value : value;
    return typeof stated === "string" && stated.trim() ? [] : [`preferences: ${id} must state an answer`];
  }
  if (SWITCH_PREFERENCES.includes(id)) {
    const ok = typeof value === "boolean" || (typeof value === "string" && TRUTHY_RE.test(value.trim()));
    return ok ? [] : [`preferences: ${id} must be true or false`];
  }
  // Every standing legal stance, including the acknowledgements `policyGateRow()` answers from.
  if (YES_NO_PREFERENCES.includes(id) || id?.startsWith?.("p.legal.")) {
    const ok = typeof value === "boolean" || (typeof value === "string" && YES_NO_RE.test(value.trim()));
    return ok ? [] : [`preferences: ${id} must be "Yes" or "No"`];
  }
  return [];
}

/** A parsed YAML section must be a list of mappings; `null` (empty file) is an empty section. */
export function normalizeSection(section, parsed) {
  if (parsed == null) return [];
  if (!Array.isArray(parsed)) throw new Error(`memory/${SECTION_FILE[section] ?? section}: expected a YAML list, got ${typeof parsed}`);
  return parsed.filter((row) => row && typeof row === "object" && !Array.isArray(row));
}

/** Deterministic id from free text — `remember.mjs` mints ids without a model writing one. */
export function mintId(section, text, taken = new Set(), { namespace = "user" } = {}) {
  const prefix = ID_PREFIX[section] ?? "";
  const slug = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .split("_")
    .filter(Boolean)
    .slice(0, 8)
    .join("_")
    .slice(0, 48) || "note";
  const base = `${prefix}${namespace}.${slug}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

/** Next free `d1`/`c1`-style handle for drafts and corrections. */
export function nextHandle(section, rows) {
  const letter = ID_PREFIX[section] ?? "x";
  const re = new RegExp(`^${letter}(\\d+)$`);
  let max = 0;
  for (const row of rows ?? []) {
    const m = re.exec(String(row?.id ?? ""));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${letter}${max + 1}`;
}
