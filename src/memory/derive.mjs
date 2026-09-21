// Values computed from memory at fill time instead of stored (PLAN §2.4): years-of-X from `since:`,
// two-valued work authorization per target country, the notice rule, the salary answer, prior applications.
// Nothing here invents a personal fact: when memory cannot answer, the return says so and the caller asks.

import { parseSince, stamp } from "./schema.mjs";
import { getFact, listFacts, resolvePreference } from "./resolve.mjs";
import { slugify } from "../config.mjs";
import { LEVEL_YEARS } from "../jev/gates.mjs";

const YEAR_MS = 365.2425 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Years elapsed since a fact's `since:` — "years of Python" is computed, never stored.
 * @returns {number|null} null when the fact or its `since:` is missing (→ the caller asks).
 */
export function yearsSince(mem, factId, now = new Date()) {
  const from = parseSince(getFact(mem, factId)?.since);
  if (!from) return null;
  return round1(Math.max(0, (new Date(now).getTime() - from.getTime()) / YEAR_MS));
}

/**
 * Work authorization for one target country, two-valued (PLAN §2.4).
 * Reads `f.work_auth.<CC>` and falls back to `f.work_auth.default` — the fallback is a *stated*
 * user fact ("everywhere else I need sponsorship"), not a guess.
 * @returns {{authorized_now:boolean, needs_sponsorship_future:boolean, status:any, expiry?:any,
 *           country:string, exact:boolean, fact:string, source:any}|null} null → ask.
 */
export function workAuth(mem, countryCode) {
  const cc = String(countryCode ?? "").trim();
  if (!cc) return null;
  let row = null;
  let exact = false;
  for (const id of [`f.work_auth.${cc}`, `f.work_auth.${cc.toUpperCase()}`, `f.work_auth.${cc.toLowerCase()}`]) {
    row = getFact(mem, id);
    if (row) { exact = true; break; }
  }
  if (!row) row = getFact(mem, "f.work_auth.default");
  const value = row?.value;
  if (!value || typeof value !== "object") return null;
  if (typeof value.authorized_now !== "boolean" || typeof value.needs_sponsorship_future !== "boolean") return null;
  return {
    authorized_now: value.authorized_now,
    needs_sponsorship_future: value.needs_sponsorship_future,
    status: value.status ?? null,
    ...(value.expiry ? { expiry: value.expiry } : {}),
    country: cc.toUpperCase(),
    exact,
    fact: row.id,
    source: row.source ?? null,
  };
}

/** Every country memory can answer for, plus whether a stated default covers the rest. */
export function workAuthCountries(mem) {
  const ids = listFacts(mem, "f.work_auth.").map((row) => row.id.slice("f.work_auth.".length));
  return { countries: ids.filter((id) => id !== "default").map((id) => id.toUpperCase()), hasDefault: ids.includes("default") };
}

/**
 * The notice period to state, from `p.notice_rule` (scope-resolved).
 * @returns {{kind:string, days:number|null, text:any, scope:string, source:any}|null} null → ask.
 */
export function noticeRule(mem, ctx = {}) {
  const pref = resolvePreference(mem, "p.notice_rule", ctx);
  const value = pref?.value;
  if (!value) return null;
  const rule = typeof value === "object" ? value : { kind: String(value) };
  const days = rule.kind === "immediate"
    ? 0
    : rule.days ?? (rule.weeks != null ? rule.weeks * 7 : rule.months != null ? rule.months * 30 : null);
  return { kind: rule.kind ?? null, days, text: rule.text ?? null, scope: pref.scope, source: pref.source ?? null };
}

/** Which saved role family this posting belongs to, by title phrase (`p.looking_for.role_families`). */
export function roleFamilyFor(mem, job = {}) {
  if (job.role_family) return job.role_family;
  const families = resolvePreference(mem, "p.looking_for", { company: job.company })?.value?.role_families ?? {};
  const title = String(job.title ?? "").toLowerCase();
  if (!title) return null;
  let best = null;
  for (const [family, phrases] of Object.entries(families)) {
    for (const phrase of Array.isArray(phrases) ? phrases : []) {
      const needle = String(phrase).toLowerCase();
      if (needle && title.includes(needle) && (!best || needle.length > best.phrase.length)) best = { family, phrase: needle };
    }
  }
  return best?.family ?? null;
}

// Location → salary-table market. Order matters: the two priced US metros beat the generic US row.
const MARKET_RULES = [
  [/\b(san francisco|sf bay|bay area|palo alto|mountain view|menlo park|sunnyvale|santa clara|cupertino|san jose|redwood city|oakland|berkeley)\b/, "us_sf_bay"],
  [/\b(new york|nyc|manhattan|brooklyn)\b/, "us_nyc"],
  [/\b(london)\b/, "uk_london"],
  [/\b(canada|toronto|vancouver|montreal|ottawa|waterloo)\b/, "canada"],
  [/\b(germany|berlin|munich|münchen|hamburg|frankfurt|cologne|stuttgart)\b/, "germany"],
  [/\b(france|paris|lyon|toulouse|grenoble)\b/, "france"],
  [/\b(netherlands|amsterdam|utrecht|eindhoven|rotterdam|the hague|delft)\b/, "netherlands"],
  [/\b(switzerland|zurich|zürich|geneva|genève|lausanne|basel)\b/, "switzerland"],
  [/\b(singapore)\b/, "singapore"],
  [/\b(japan|tokyo|osaka|kyoto|yokohama)\b/, "japan"],
  [/\b(uae|dubai|abu dhabi|united arab emirates)\b/, "uae"],
  [/\b(australia|sydney|melbourne|brisbane|perth|canberra|adelaide)\b/, "australia"],
  [/\b(united states|usa|u\.s\.a?\.?|us|seattle|bellevue|redmond|austin|boston|cambridge, ma|chicago|denver|boulder|los angeles|san diego|atlanta|miami|portland|pittsburgh|washington, d\.?c\.?|new jersey|california|texas|colorado|illinois)\b/, "us_other"],
];

/**
 * Posting location → a market key **that exists in the salary table**. The table owns its own
 * vocabulary: an optional `markets: {<market>: [alias, …]}` block in `salary-baselines.yaml` is
 * matched first, so adding a market row is enough to make it reachable. The built-in list below is
 * only the default reading of the table's own market-selection rule. An unrecognised location
 * returns `null` so the caller asks — a country is never interpolated into a neighbouring market.
 * @returns {string|null}
 */
export function marketFor(job = {}, baselines = null) {
  const where = [job.market, job.location, job.office, job.remote === true ? "remote" : ""].filter(Boolean).join(" ; ").toLowerCase();
  if (!where.trim()) return null;
  for (const [market, aliases] of Object.entries(baselines?.markets ?? {})) {
    for (const alias of Array.isArray(aliases) ? aliases : [aliases]) {
      const needle = String(alias).toLowerCase().trim();
      if (needle && where.includes(needle)) return market;
    }
  }
  for (const [re, market] of MARKET_RULES) if (re.test(where)) return market;
  if (/\b(remote|anywhere|worldwide|global|distributed)\b/.test(where)) return "remote_global";
  return null;
}

/**
 * Full-time years on file. Only a fact that *says* it is full-time counts
 * (`value.employment_type: full_time` or `value.full_time: true`); free-text internship and
 * open-source rows are not silently promoted into seniority.
 */
export function fullTimeYears(mem, now = new Date()) {
  let years = 0;
  for (const row of listFacts(mem, "f.employment.")) {
    const value = row.value;
    const isFullTime = value && typeof value === "object" && (value.employment_type === "full_time" || value.full_time === true);
    if (!isFullTime) continue;
    const from = parseSince(row.since);
    if (!from) continue;
    const to = parseSince(value.until ?? row.until) ?? new Date(now);
    years += Math.max(0, (to.getTime() - from.getTime()) / YEAR_MS);
  }
  return round1(years);
}

/**
 * The level boundaries in full-time years. The salary table may state its own
 * (`rule: {levels: {early: 1, senior: 3}}` in `salary-baselines.yaml`, the same way its `markets:`
 * block owns the market vocabulary); otherwise `LEVEL_YEARS` from `jev/gates.mjs` decides, because
 * these two numbers pick the salary-table row and thresholds live in exactly one file (AGENTS.md).
 */
export function levelCutoffs(baselines = null) {
  const stated = baselines?.rule?.levels ?? null;
  const years = (value, fallback) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback);
  return {
    early: years(stated?.early, LEVEL_YEARS.early),
    senior: years(stated?.senior, LEVEL_YEARS.senior),
  };
}

/** Salary-table level: `p.salary.level` if the user stated one, else from full-time years. */
export function experienceLevel(mem, now = new Date(), baselines = null) {
  const stated = resolvePreference(mem, "p.salary")?.value?.level;
  if (stated) return { level: stated, full_time_years: null, why: "level stated in p.salary" };
  const years = fullTimeYears(mem, now);
  const cut = levelCutoffs(baselines);
  const level = years < cut.early ? "entry" : years < cut.senior ? "early" : "senior";
  return { level, full_time_years: years, why: `${years} yr full-time on file` };
}

function postingRange(job = {}) {
  const raw = job.payRange ?? job.pay_range ?? job.salary ?? null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v.replace(/[^0-9.]/g, ""))) ? Number(v.replace(/[^0-9.]/g, "")) : null);
  if (Array.isArray(raw)) {
    const [min, max] = [num(raw[0]), num(raw[1])];
    return min == null && max == null ? null : { min, max, currency: job.currency ?? null };
  }
  if (!raw || typeof raw !== "object") return null;
  const min = num(raw.min ?? raw.low ?? raw.minValue ?? raw.min_value ?? raw.from);
  const max = num(raw.max ?? raw.high ?? raw.maxValue ?? raw.max_value ?? raw.to);
  if (min == null && max == null) return null;
  return { min, max, currency: raw.currency ?? raw.currencyCode ?? raw.currency_code ?? job.currency ?? null };
}

const money = (amount, currency) => (currency ? `${currency} ${amount.toLocaleString("en-US")}` : String(amount));

/**
 * The salary answer for one posting, per the user's stated rule (`p.salary` + the salary table):
 * a published posting range wins (state its midpoint); otherwise the table row matching
 * {role_family, level, market} supplies the end the user chose to state. A personal number is
 * never invented and an unknown market is never interpolated — both return `action: "ask"`.
 * @param {object} baselines parsed `memory/salary-baselines.yaml` (`{rule, rows}`) or its rows.
 */
export function salaryFor(mem, job = {}, baselines = null) {
  const ctx = { company: job.company, role_family: job.role_family };
  const pref = resolvePreference(mem, "p.salary", ctx);
  if (!pref) return { action: "ask", missing: "p.salary", why: "no salary rule on file" };
  const rule = typeof pref.value === "object" && pref.value ? pref.value : {};

  const posted = postingRange(job);
  if (posted && rule.prefer_posting_range !== "none") {
    const amount = posted.min != null && posted.max != null ? Math.round((posted.min + posted.max) / 2) : posted.min ?? posted.max;
    return {
      action: "fill",
      amount,
      currency: posted.currency,
      range: { low: posted.min, high: posted.max },
      source: "posting_range",
      text: String(amount),
      formatted: money(amount, posted.currency),
      why: posted.min != null && posted.max != null ? "midpoint of the range this posting publishes" : "the only bound this posting publishes",
    };
  }

  const rows = Array.isArray(baselines) ? baselines : baselines?.rows ?? [];
  if (!rows.length) return { action: "ask", missing: "salary-baselines", why: "no salary table installed" };
  const role_family = roleFamilyFor(mem, job);
  const market = marketFor(job, baselines);
  const { level } = experienceLevel(mem, undefined, baselines);
  if (!role_family) return { action: "ask", missing: "role_family", level, market, why: "the posting title matches no saved role family" };
  if (!market) return { action: "ask", missing: "market", level, role_family, why: "the posting location is not a market in the salary table" };
  const row = rows.find((r) => r?.role_family === role_family && r?.level === level && r?.market === market);
  if (!row) return { action: "ask", missing: "baseline_row", role_family, level, market, why: `no ${role_family}/${level}/${market} row in the salary table` };

  const end = rule.state_end ?? baselines?.rule?.state ?? "mid";
  const amount = row[end] ?? row.mid;
  return {
    action: "fill",
    amount,
    currency: row.currency ?? null,
    range: { low: row.low ?? null, high: row.high ?? null },
    basis: row.basis ?? baselines?.rule?.basis ?? null,
    source: `baseline:${role_family}/${level}/${market}`,
    role_family,
    level,
    market,
    text: String(amount),
    formatted: money(amount, row.currency ?? null),
    why: `market ${end} for ${role_family}/${level} in ${market}`,
  };
}

const APPLIED_STATUSES = new Set(["applied", "interview", "offer", "rejected"]);

/**
 * Has this company seen an application already? Drives "have you applied before?" and re-apply guards.
 * @param {object|Array} pipeline `loadPipeline()` result (`{jobs:[…]}`) or a job list.
 */
export function appliedBefore(pipeline, company) {
  const jobs = Array.isArray(pipeline) ? pipeline : pipeline?.jobs ?? [];
  const want = slugify(String(company ?? ""));
  if (!want) return { applied: false, count: 0, last: null };
  const hits = jobs
    .filter((job) => slugify(String(job?.company ?? "")) === want && APPLIED_STATUSES.has(job?.status))
    .sort((a, b) => String(b?.applied_at ?? b?.updated ?? "").localeCompare(String(a?.applied_at ?? a?.updated ?? "")));
  const last = hits[0];
  return {
    applied: hits.length > 0,
    count: hits.length,
    last: last ? { id: last.id ?? null, title: last.title ?? null, status: last.status, when: last.applied_at ?? last.updated ?? null } : null,
  };
}

/**
 * Time-based facts older than `days` — re-confirmed inside the next `needs_user` batch,
 * never as a separate prompt (PLAN §2.4).
 */
export function staleFacts(mem, { days = 90, now = new Date() } = {}) {
  const cutoff = new Date(now).getTime() - days * DAY_MS;
  return (mem?.facts ?? []).filter((row) => {
    const timeBased = row?.since != null || /^f\.(work_auth|availability|employment)\b/.test(String(row?.id ?? ""));
    if (!timeBased) return false;
    const updated = Date.parse(String(row.updated ?? ""));
    return Number.isFinite(updated) && updated < cutoff;
  });
}

export { stamp };
