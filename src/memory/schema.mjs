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
