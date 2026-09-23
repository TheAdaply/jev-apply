// PLAN §2.2 step 4 — the deterministic pass: FormPlan question → Decision, with no model involved.
//
// Everything memory can answer by itself is answered here, so Jev only ever sees the rows that are
// genuinely open. Two invariants shape every rule below (AGENTS.md):
//
//   * No personal fact is guessed. A missing fact is an `ask`, never a default and never a
//     neighbouring value. That is why identity rows are *not* forwarded to Jev when their fact is
//     missing: no saved story can supply somebody's phone number, and a selector asked for one
//     would have to invent it.
//   * A fact whose stated value carries a trailing parenthetical note ("Remote (no specific city
//     stated on CV …)") is filled but flagged `check`: the note is the user's own hedge, so the
//     value is usable but must be shown before Submit.
//
// Decision (docs/CONTRACTS.md) plus three additions this slice needs downstream:
//   `class`/`section` (the summary groups EEO rows and masks sensitive values),
//   `topic`           (which derivation produced the row: salary / work_auth / … — drives the
//                      §2.6 MONEY line and the suggested `remember_as` id), and
//   `_open`/`_answerText`/`_onNone` — internal, stripped before `decisions.json` is frozen.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { paths, slugify } from "../config.mjs";
import { documentFor, getFact, resolvePreference } from "../memory/resolve.mjs";
import { EEO_VALUES } from "../memory/schema.mjs";
import { appliedBefore, locationFact, noticeRule, roleFamilyFor, salaryFor, startDate, workAuth } from "../memory/derive.mjs";
import { isAccommodationRequest } from "../schema/classes.mjs";
import { countryFromText, countryInQuestion } from "../schema/normalize.mjs";

// ─── posting country ──────────────────────────────────────────────────────────────────────────
// The table itself lives in `src/schema/normalize.mjs`, which stamps every FormPlan with
// `job.country` and `job.remote` while it still has the raw payload (Cloudflare's `location.name`
// is "In-Office"; only `offices[]` names the country). Work authorization is two-valued *per
// country*, so a wrong country here is a wrong answer on the form: unrecognised stays null → ask.

/** The posting's country: what the plan already read, else what the job strings say; null → ask. */
export function countryFor(job = {}) {
  return job.country ?? countryFromText([job.location, job.office, job.market].filter(Boolean).join(" ; "));
}

// ─── label rules ──────────────────────────────────────────────────────────────────────────────
// Ordered: the first match wins, so qualifiers ("Preferred First Name") are listed before the
// plain form ("First Name") and the named link fields before the generic "Website".

// The name qualifiers stack the way `IDENTITY_RE` does, so "Full Legal Name" (SpaceXAI, required,
// and empty in round 1 while the fact sat on file) reads as the plain name question it is. A name
// asked for in another script is a *different* fact, not a re-spelling of the stated one, so it is
// matched first and answered from its own id.
const NAME_RULES = [
  [/native language|native script|local (?:language|script)|in your own script|kanji|katakana|hiragana|romaji|cyrillic|chinese characters/i, "native"],
  [/preferred\s+(?:first\s+)?name|^nick\s*name/i, "preferred"],
  [/^(?:(?:your|full|legal|complete|entire)\s+)*first\s+name|^given\s+name/i, "first"],
  [/^(?:(?:your|full|legal|complete|entire)\s+)*last\s+name|^family\s+name|^surname/i, "last"],
  [/^(?:(?:your|full|legal|complete|entire)\s+)*names?\b/i, "full"],
];

const LINK_RULES = [
  [/linked-?in/i, ["f.identity.linkedin_url"]],
  [/git-?hub/i, ["f.identity.github_url"]],
  [/google scholar|scholar profile/i, ["f.identity.scholar_url"]],
  [/publication/i, ["f.identity.publications_url", "f.identity.scholar_url"]],
  [/\b(?:x|twitter)\b(?:\s*\/\s*x)?/i, ["f.identity.x_twitter_url"]],
  [/portfolio/i, ["f.identity.portfolio_url", "f.identity.site_url"]],
  [/personal (?:web)?site|\bwebsite\b|\bweb ?page\b|\bblog\b|personal url/i, ["f.identity.site_url"]],
];

const EMAIL_RE = /e-?mail/i;
const PHONE_RE = /\bphone\b|\bmobile\b|\bcell\b/i;
const RESUME_RE = /resum[ée]|\bcv\b/i;
const COVER_RE = /cover letter/i;
const LOCATION_RE = /^(?:your |current |candidate )*(?:location|city|country)\b|where are you (?:currently )?(?:located|based)|current location|where do you (?:currently )?(?:intend|plan|expect|want|wish) to (?:work|be based|live)|(?:city|town) and (?:country|state)/i;
const ADDRESS_RE = /\b(?:legal|home|mailing|street|postal)?\s*address\b/i;
const CURRENT_COMPANY_RE = /^current (?:company|employer)|(?:your|the) current(?: or (?:most|more) recent)?\s+(?:employer|company)/i;
const CURRENT_TITLE_RE = /^current (?:job ?title|title|role|position)|(?:your|the) current(?: or (?:most|more) recent)?\s+(?:job ?title|title|role|position)/i;

// circumstance topics
const AUTHORIZED_RE = /legally authoriz|authoriz(?:ed|ation) to work|right to work|work authoriz|authorized to work/i;
const SPONSOR_RE = /sponsor|visa|h-?1b|immigration/i;
const RELOCATE_RE = /relocat|willing to move/i;
const IN_OFFICE_RE = /in[- ]?office|in[- ]?person|on[- ]?site|onsite|hybrid|days? (?:a|per) week|commut/i;
const START_RE = /start date|available to start|when (?:can|could) you start|notice period|earliest (?:start|availability)/i;
const SALARY_RE = /salary|compensation|expected pay|pay expectation|desired (?:pay|compensation)|rate expectation/i;
const APPLIED_BEFORE_RE = /previously (?:applied|interviewed|worked|been employed)|ever (?:applied|interviewed|worked|been employed)|applied (?:to|for)[^?]{0,40}before|interviewed (?:at|with)|worked (?:at|for)[^?]{0,40}before/i;
const HOW_HEARD_RE = /(?:how|where) did you (?:hear|find|learn)|how were you referred|referral source/i;

// "Please select the office(s) you are closest to and/or would be able to commute to" (DeepL) and
// "Which office location(s) are you interested in?" (Fireworks) ask about **geography**, not about
// a schedule. `p.in_office` states how many days a week the user will be in an office and says
// nothing about which one, which is how DeepL's row came back "p.in_office (global) → no option
// states it" (docs/research/13-eval-judge-round2.md §3 N6b). Tested before `IN_OFFICE_RE`, which
// claims the same label through "commut" — and `officeRow()` hands the row back when the options
// turn out to be a schedule after all, so a work-mode question still reaches the preference.
const OFFICE_LOCATION_RE = /(?:which|what|select|choose|pick)\b[^?]{0,40}\boffices?\b|\boffices?\b[^?]{0,50}\b(?:closest|nearest|commut|near you)/i;

/** The list's own "nothing here applies" entry — never a decline, never position 0. */
const NONE_OF_ABOVE_RE = /^(?:none\b|not applicable\b|n\/?a\b)/i;

// A free-text box that asks the user to *state* a protected characteristic. Only these take the
// canonical self-identification wording as their value (judge §3 N1).
const SELF_ID_RE = /self[- ]identif|what is your (?:gender|race|ethnicity|gender identity|disability status)|please (?:state|specify|describe) your/i;

// Standing legal stances the user states once and every form afterwards is answered from
// (PLAN §2.4). Not `policy_gate`s: an attestation is about *this* company's terms and is always
// the user's to answer, while "are you under a non-compete?" is a fact about the user that does
// not change between forms. `PREVIOUSLY_EMPLOYED_RE` is tested before `APPLIED_BEFORE_RE`, which
// also matches "previously been employed", and only answers when the preference exists — with
// none on file the row falls through to the pipeline derivation exactly as it did before.
const RESTRICTIVE_RE = /bound by any agreement|bound by an? (?:agreement|contract)|non-?compete|non-?solicit|restrictive (?:covenant|agreement)|confidentiality agreement[^?]{0,40}restrict/i;
const PREVIOUSLY_EMPLOYED_RE = /previously (?:been )?employed|ever (?:been )?employed|former(?:ly)? (?:an )?employee|worked (?:at|for)[^?]{0,40}(?:before|previously)/i;

// ─── policy gates ─────────────────────────────────────────────────────────────────────────────
// An acknowledgement ("I understand that offers are conditional on a background check") is a
// statement the *user* signs, so it is answered from one explicit standing preference and from
// nothing else — never from the canonical answer bank, which is what ticked two of them in round 1
// (docs/research/12-eval-judge-round1.md §3.1). The preference id is `p.legal.<slug>`, and the slug
// comes from the gate's subject rather than from the company's wording, so "Please review and
// acknowledge Cloudflare's Candidate Privacy Policy" and "Do you consent to our privacy notice?"
// are one stored answer instead of two. A gate no rule names keeps a slug derived from its own
// words: it still asks, and the id it asks to be remembered under is stable across boards.
const POLICY_SLUGS = [
  [/privacy (?:policy|notice|statement)|candidate privacy|data (?:privacy|protection)|gdpr|personal data/i, "privacy_policy_ack"],
  [/background (?:check|screening)|criminal record check|reference check/i, "background_check_consent"],
  [/record(?:ing|ed)?\b[^?]{0,40}\b(?:interview|call|session|conversation)|interview[^?]{0,20}record/i, "interview_recording_consent"],
  [/arbitrat/i, "arbitration_ack"],
  [/\bAI\b|artificial intelligence|AI-generated/i, "ai_usage_ack"],
  [/keep (?:your|my) (?:application|details|data|profile)|on file for|talent (?:community|network|pool)|future (?:roles|openings|opportunities|contact)|contact (?:you|me) (?:about|regarding) future|stay in touch/i, "retention_consent"],
  [/terms of (?:use|service)|code of conduct/i, "terms_ack"],
  [/(?:true|truthful|accurate|complete)[^?]{0,40}(?:to the best|information|statements)|falsif/i, "application_truthful_ack"],
  [/export control|itar|sanction/i, "export_control_ack"],
];

const SLUG_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "at", "by", "with", "that", "this",
  "my", "your", "our", "their", "its", "you", "i", "we", "please", "review", "read", "confirm",
  "check", "box", "below", "above", "here", "have", "has", "am", "is", "are", "be", "been", "do",
  "does", "did", "will", "would", "can", "could", "if", "as", "it", "all", "any", "hereby",
]);

/** The gate's subject as a memory slug: `privacy_policy_ack`, `background_check_consent`, … */
export function policySlug(label) {
  const text = String(label ?? "");
  const named = POLICY_SLUGS.find(([re]) => re.test(text));
  if (named) return named[1];
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !SLUG_STOPWORDS.has(w))
    .slice(0, 4);
  return words.length ? `${words.join("_")}_ack` : "attestation_ack";
}

// ─── small helpers ────────────────────────────────────────────────────────────────────────────

/**
 * The value a fact states, without the trailing provenance note `learn.mjs` may have appended
 * ("Remote (per GitHub profile; no city stated …)" → "Remote"). Returns `{text, qualified}`;
 * `qualified` means a note was stripped, which downgrades the row from `fill` to `check`.
 */
export function factText(row) {
  const raw = row?.value;
  if (typeof raw !== "string") return raw == null ? null : { text: String(raw), qualified: false };
  const value = raw.trim();
  if (!value) return null;
  const head = value.replace(/\s*\((?:[^()]|\([^()]*\))*\)\s*$/, "").trim();
  return head && head !== value ? { text: head, qualified: true } : { text: value, qualified: false };
}

const firstFact = (mem, ids) => ids.map((id) => getFact(mem, id)).find((row) => row?.value != null);

/** Where the user says they are a citizen — the country ids `f.citizenship` is filed under. */
const CITIZENSHIP_FACTS = ["f.citizenship", "f.identity.citizenship", "f.identity.nationality"];

/**
 * The country the user states citizenship of, as an ISO-2 code, or null.
 * Only ever read for a remote posting that names no country at all: it is the user's own stated
 * fact, not an inference about where they may work (the two-valued authorization fact still
 * decides the answer, and such a row is filled as `check`, never silently).
 */
function citizenshipCountry(mem) {
  const row = firstFact(mem, CITIZENSHIP_FACTS);
  const country = row ? countryFromText(factText(row)?.text ?? row.value) : null;
  return country ? { country, fact: row.id } : null;
}

/** Fill from a fact row: `check` instead of `fill` when the fact's own text hedges the value. */
function fromFact(row, extra = {}) {
  const parsed = factText(row);
  if (!parsed) return null;
  return {
    source: "fact",
    value: parsed.text,
    action: parsed.qualified ? "check" : "fill",
    why: parsed.qualified ? `${row.id} (value is qualified — verify)` : row.id,
    ...extra,
  };
}

const YES = "Yes";
const NO = "No";

// ─── the pass ─────────────────────────────────────────────────────────────────────────────────

/**
 * Posting context every rule shares: company slug, role family (memory's), country, job row.
 * `role_family` stays the user's *own* vocabulary (`p.looking_for.role_families`) because it keys
 * their scoped preferences and answers; the canon taxonomy's name for the same posting is a
 * separate thing and is only used where a table is keyed by it (`derive.mjs tableFamily`).
 */
export function jobContext(formPlan, mem) {
  const job = formPlan?.job ?? {};
  const role_family = roleFamilyFor(mem, job) ?? null;
  return {
    company: job.company ?? "",
    company_slug: slugify(job.company ?? ""),
    title: job.title ?? "",
    location: job.location ?? "",
    country: countryFor(job),
    remote: job.remote === true,
    role_family,
    job: { ...job, role_family },
  };
}

/**
 * Resolve every question deterministically.
 * @returns {{decisions:object[], context:object}} rows with `_open:true` are what Jev is asked about.
 */
export function resolveForm(formPlan, { mem, pipeline = null, baselines = null, now = new Date() } = {}) {
  const context = jobContext(formPlan, mem);
  const decisions = (formPlan?.questions ?? []).map((q) => {
    const base = {
      qid: q.qid,
      label: q.label,
      section: q.section ?? null,
      class: q.class,
      source: "none",
      action: "ask",
      why: "no rule matched",
      _open: false,
      // The form's own stated length cap (`parseLimits`, src/schema/classes.mjs). Internal: it is
      // not part of the frozen Decision, but `finalize()` refuses to commit a longer answer than
      // the field asks for and the draft request carries it to the writer (PLAN §2.2 step 10).
      _limits: q.limits ?? null,
      // The field's own helper text ("3-4 sentences, please"), for the writer's draft request.
      _help: q.help ?? "",
      // What an open row becomes when nothing answers it. An *optional* question the user's
      // memory cannot answer is left blank and listed under NOT FILLED (PLAN §2.1, §2.6) — that
      // is already the rule for optional free text, and a company's optional extra ("Check this
      // box to join our talent community") is the same case wearing a checkbox. Required rows,
      // and every question about the user's circumstances, are still handed back as an `ask`.
      _onNone: !q.required && (q.class === "optional_text" || q.class === "company_specific") ? "skip" : "ask",
    };
    const resolved = resolveQuestion(q, { mem, pipeline, baselines, now, context });
    const decision = { ...base, ...resolved };
    if (decision.action === "ask" && !decision.remember_as) decision.remember_as = rememberAs(q, decision, context);
    return decision;
  });
  applyDependencies(decisions, formPlan?.questions ?? []);
  return { decisions, context };
}

/**
 * A conditional follow-up is left blank unless its parent's answer opens it (PLAN §2.2 step 9).
 * "If yes, please explain" under a restrictive-agreements row answered No has nothing to say, and
 * an `ask` for it would put a question to the user that their own answer already closed. A child is
 * only ever *blanked* here — never filled.
 *
 * Three ways a child stays blank, all three seen in round 1
 * (docs/research/12-eval-judge-round1.md §3.3):
 *   * the parent states the other polarity ("If yes…" under a No);
 *   * the parent names a different option ("If you responded \"other\" above…" under `LinkedIn`);
 *   * **the parent is not answered at all** — an `ask` is not a Yes, and a child filled under one
 *     is an answer to a question the user never gave. That is how 1Password's how-heard follow-up
 *     came to say "I don't have additional detail to add here" under an empty parent.
 *
 * The last case is re-openable: what the child was is kept in `_dep_saved`, so when the parent is
 * answered (`applyAnswers` re-runs this pass) the row comes back exactly as it was planned.
 *
 * The polarity is read from the child's own label first and from `dependency.condition` second.
 */
export function applyDependencies(decisions, questions) {
  const byQid = new Map(decisions.map((d) => [d.qid, d]));
  for (const q of questions ?? []) {
    const dep = q?.dependency;
    if (!dep?.parent) continue;
    const child = byQid.get(q.qid);
    const parent = byQid.get(dep.parent);
    if (!child || !parent) continue;
    const closed = dependencyClosed(child, parent, q, dep);
    if (closed && !child._dep_saved) closeChild(child, closed);
    else if (closed) child.why = closed; // still closed, but the parent's answer changed the reason
    else if (child._dep_saved) reopenChild(child);
  }
}

/** Why this child must stay blank, or null when the parent's answer opens it. */
function dependencyClosed(child, parent, q, dep) {
  if (child.action === "skip" && !child._dep_saved) return null;
  const name = `"${clipLabel(parent.label)}"`;
  if (parent.action !== "fill" && parent.action !== "check") {
    return `only asked once ${name} is answered — that row is still open`;
  }
  const stated = parent.option ?? parent.value;
  const wanted = conditionPolarity(q.label, dep.condition);
  if (wanted) {
    const answered = yesNoOf(stated);
    if (answered === wanted) return null;
    return answered
      ? `only asked when ${name} is ${wanted} — you answered ${answered}`
      : `only asked when ${name} is ${wanted}, and that row does not state a Yes or No`;
  }
  // A condition naming one of the parent's options ("If you responded \"other\" above…"). A bare
  // verb ("If you selected a response other than …") states no value and is left alone.
  const token = String(dep.condition ?? "").toLowerCase();
  if (!token || DEP_VERBS.has(token) || token === "applicable" || token === "any" || token === "above") return null;
  const said = String(stated ?? "").toLowerCase();
  if (said.includes(token)) return null;
  return `only asked when ${name} is "${token}" — you answered ${clipLabel(stated ?? "nothing", 24)}`;
}

/** Condition tokens that are verbs, not answers: they say a row is conditional, not on what. */
const DEP_VERBS = new Set(["answered", "responded", "replied", "indicated", "selected", "chose", "chosen", "checked", "said", "marked", "stated"]);

function closeChild(child, why) {
  child._dep_saved = { ...child };
  child.action = "skip";
  child.source = "none";
  child.why = why;
  child._open = false;
  delete child.value;
  delete child.option;
  delete child.remember_as;
  delete child.draft_request;
}

function reopenChild(child) {
  const saved = child._dep_saved;
  for (const key of Object.keys(child)) delete child[key];
  Object.assign(child, saved);
}

/**
 * "If yes, …" → `Yes`; "If you answered no, …" → `No`; anything vaguer → null (the caller then
 * compares the condition token against the parent's own option). `dependencyOn()`
 * (src/schema/classes.mjs) normalises "so" and a bare "Please explain." child to `yes` and leaves
 * every other token literal, so both halves of the condition can be trusted here.
 */
export function conditionPolarity(label, condition = null) {
  const text = String(label ?? "");
  const lead = /^\s*if\s+(?:you\s+(?:have\s+|are\s+|had\s+)?(?:answered|responded|replied|indicated|selected|chose|chosen|checked|said|marked|stated)?\s*)?["'\u201c\u2018]?/i;
  if (new RegExp(`${lead.source}no\\b`, "i").test(text)) return NO;
  if (new RegExp(`${lead.source}(?:yes|so)\\b`, "i").test(text)) return YES;
  if (condition === "no") return NO;
  return condition === "yes" ? YES : null;
}

const clipLabel = (text, n = 40) => (String(text ?? "").length > n ? `${String(text).slice(0, n - 1)}…` : String(text ?? ""));

function resolveQuestion(q, ctx) {
  switch (q.class) {
    case "sensitive":
      return sensitiveRow(q, ctx);
    case "policy_gate":
      return policyGateRow(q, ctx);
    case "identity":
      return identityRow(q, ctx);
    case "circumstance":
      return circumstanceRow(q, ctx);
    case "why_us":
      return whyUsRow(q, ctx);
    case "company_specific":
      // "Only this company asks this" is a statement about the *label*, not about the answer.
      // Measured on the 14-posting bench, most such rows are a company's own phrasing of a
      // question the canonical bank already holds ("What brought you to this job posting" is
      // `q.core.how_heard`; "What is your current city and country of residence?" is
      // `q.core.location_current`), so the row is offered to the canonical pass before it is
      // handed to the user. Nothing is defaulted: a row the pass cannot map stays this `ask`.
      return { _open: true, source: "none", action: "ask", why: "only this company asks this" };
    default:
      // essay · optional_text — nothing deterministic to say; Jev step 5 looks for saved material.
      return { _open: true, source: "none", action: "ask", why: "open prompt — no saved answer yet" };
  }
}

/**
 * An attestation, acknowledgement or consent. The user signs these, so exactly one thing answers
 * one: an explicit `p.legal.<slug>` they stated themselves. There is no derivation, no canonical
 * answer and no neighbouring preference — with nothing on file the row is an `ask` carrying the id
 * that would close it on every board afterwards (AGENTS.md; judge §3.1).
 */
function policyGateRow(q, { mem, context }) {
  const slug = policySlug(q.label);
  const id = `p.legal.${slug}`;
  const pref = resolvePreference(mem, id, scopeCtx(context));
  const stance = pref ? yesNoOf(pref.value) : null;
  if (!stance) {
    return {
      source: "none",
      action: "ask",
      topic: "policy",
      why: pref ? `${id} states no Yes/No` : `attestation — no ${id} on file`,
      remember_as: { kind: "preference", id, scope: "global" },
    };
  }
  // A gate is usually a single checkbox ("I agree"): its own label is the only wording it takes.
  const labels = optionLabelsOf(q);
  const affirm = stance === YES ? labels.find((l) => yesNoOf(l) === YES) : labels.find((l) => yesNoOf(l) === NO);
  return {
    source: "preference",
    value: affirm ?? stance,
    ...(affirm ? { option: affirm } : {}),
    action: "fill",
    topic: "policy",
    why: `${id} (${pref.scope})`,
    _answerText: stance,
  };
}

// ─── EEO / demographics ───────────────────────────────────────────────────────────────────────
// PLAN D10: a demographic control is a real form field, and leaving a required one blank blocks
// Submit — so these rows are *filled* from `p.eeo` whenever the user has stated one, and asked
// once (never skipped) when they have not. Nothing about them is inferred: the answer comes from
// the user's own saved value, the form's wording for that value comes from `canon/vocab/eeo-*.yaml`,
// and a question those five fields do not cover is an `ask` unless the user stated the standing
// `other_demographics: decline`. Trace/summary redaction is unchanged (src/browser/trace.mjs):
// a sensitive row is never photographed and its text never leaves the process except to Jev.

/** The map files, in the order a label is tested against them. */
const EEO_FIELD_ORDER = ["hispanic_latino", "disability_status", "veteran_status", "gender", "race"];

/**
 * `canon/vocab/eeo-*.yaml`, parsed once. Read synchronously and lazily: the files are repo
 * content a few kB in size, and `resolveForm` is synchronous by contract.
 * @returns {Array<{field:string, asks:RegExp[], values:object, aliases:Map<string,string|null>,
 *                  match:Array<[RegExp,string|null]>}>}
 */
let eeoMaps = null;
function eeoVocabularies() {
  if (eeoMaps) return eeoMaps;
  const dir = path.join(paths.canon, "vocab");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^eeo-.+\.yaml$/.test(f)) : [];
  const loaded = [];
  for (const file of files) {
    const doc = YAML.parse(readFileSync(path.join(dir, file), "utf8")) ?? {};
    if (!doc.field) continue;
    // The store decides what may be saved (`EEO_VALUES`); a map file only decides how a form
    // spells it. A token memory cannot hold — in `values`, in an alias or in a `match` rule —
    // would quietly resolve to nothing and degrade the row to "this form's list has no entry for
    // your saved race", so every target is checked here and a stray one is a build error.
    const allowed = EEO_VALUES[doc.field];
    if (!allowed) throw new Error(`canon/vocab/${file}: unknown p.eeo field "${doc.field}"`);
    const values = doc.values ?? {};
    const aliases = new Map();
    for (const [label, value] of Object.entries(doc.aliases ?? {})) aliases.set(optionKey(label), value ?? null);
    for (const label of doc.unmapped ?? []) aliases.set(optionKey(label), null);
    const match = (doc.match ?? []).map(([src, value]) => [new RegExp(src, "i"), value ?? null]);
    const stray = [
      ...Object.keys(values),
      ...[...aliases.values()].filter(Boolean),
      ...match.map(([, value]) => value).filter(Boolean),
    ].filter((token) => !allowed.includes(token));
    if (stray.length) {
      throw new Error(`canon/vocab/${file}: ${[...new Set(stray)].join(", ")} not in p.eeo.${doc.field} (${allowed.join(" | ")})`);
    }
    loaded.push({ field: String(doc.field), asks: (doc.asks ?? []).map((src) => new RegExp(src, "i")), values, aliases, match });
  }
  const rank = (m) => (EEO_FIELD_ORDER.indexOf(m.field) + 1 || EEO_FIELD_ORDER.length + 1);
  eeoMaps = loaded.sort((a, b) => rank(a) - rank(b) || a.field.localeCompare(b.field));
  return eeoMaps;
}

/** One option label, comparable: case, quote style, dashes and trailing punctuation folded away. */
function optionKey(label) {
  return String(label ?? "")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.*:;]+$/, "")
    .toLowerCase();
}

const optionLabelsOf = (q) => (q?.options ?? []).map((o) => String(o?.label ?? o ?? "")).filter(Boolean);

/** The `p.eeo` field this question asks about, with its map; null when none of the five covers it. */
export function eeoMapFor(label) {
  const text = String(label ?? "");
  if (!text) return null;
  return eeoVocabularies().find((map) => map.asks.some((re) => re.test(text))) ?? null;
}

/** One of the form's option labels → the canonical value it states, or null. */
function eeoValueOf(map, label) {
  const key = optionKey(label);
  if (map.aliases.has(key)) return map.aliases.get(key);
  for (const [re, value] of map.match) if (re.test(key)) return value;
  return null;
}

// "Decline to self-identify" in every wording seen, for the demographic questions no map covers.
const DECLINE_RE = /^(decline|prefer not|choose not|i prefer not|i (?:do not|don't) (?:wish|want)|not disclos)/i;

/** Every key `p.eeo` may carry, and the id a single-field row is filed under. */
const EEO_FIELDS = Object.freeze([...Object.keys(EEO_VALUES), "pronouns"]);

const eeoMapForField = (field) => eeoVocabularies().find((m) => m.field === field) ?? null;

/**
 * The saved demographic block: the `p.eeo` mapping, plus any `p.eeo.<field>` row on its own.
 * Both exist because both get written — onboarding stores the whole block (`learn.mjs` gap
 * `g.eeo`), while a row the user answers on a form is remembered under the id its `remember_as`
 * named (`p.eeo.gender`, `src/plan/decisions.mjs memoryRow()`). The single-field row wins: it is
 * the more specific, later statement.
 * @returns {{block:object, scope:string}|null} null when the user has stated nothing at all
 */
function eeoBlock(mem, ctx) {
  const whole = resolvePreference(mem, "p.eeo", ctx);
  const block = whole && typeof whole.value === "object" && !Array.isArray(whole.value) ? { ...whole.value } : {};
  let scope = whole && Object.keys(block).length ? whole.scope : null;
  for (const field of EEO_FIELDS) {
    const row = resolvePreference(mem, `p.eeo.${field}`, ctx);
    const stated = row && typeof row.value === "object" && row.value ? row.value.answer ?? row.value.value : row?.value;
    if (stated == null || stated === "") continue;
    block[field] = stated;
    scope = row.scope;
  }
  return scope ? { block, scope } : null;
}

/**
 * One saved value as a canonical token. `p.eeo` holds tokens, but a `p.eeo.<field>` row written
 * from a form answer holds *that form's* wording ("Male", "I am not a protected veteran") — both
 * are the user's own statement, so both are read through the same map.
 */
function eeoToken(map, value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!map || !text) return null;
  const lower = text.toLowerCase();
  if (map.values[lower]) return lower;
  return eeoValueOf(map, text);
}

/**
 * `eeoCanonical("gender", "Man")` → `"male"`. The one place a demographic answer in a form's own
 * words becomes the token memory stores, so `scripts/learn.mjs --answers` can write canonical
 * values (and reject wording no map reads) instead of leaving prose in the store for the resolver
 * to fail on later. `pronouns` is free text and passes through unchanged.
 * @returns {string|null} null when nothing in the field's vocabulary states this
 */
export function eeoCanonical(field, value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (field === "pronouns") return text;
  if (field === "other_demographics") return /^(decline|ask)$/i.test(text) ? text.toLowerCase() : null;
  return eeoToken(eeoMapForField(field), text);
}

/**
 * What the user saved for this field, most specific first. The EEO-1 form asks ethnicity before
 * race and a "yes" there is the answer to the race question too (that is what Greenhouse's single
 * "Race" select with a `Hispanic or Latino` option means), so a stated ethnicity is tried first
 * and the saved race is the fallback when the form's list has no ethnicity entry at all.
 */
function eeoStated(block, map) {
  const saved = eeoToken(map, block?.[map.field]);
  if (map.field !== "race") return saved ? [saved] : [];
  const ethnicity = eeoToken(eeoMapForField("hispanic_latino"), block?.hispanic_latino);
  return [...(ethnicity === "yes" ? ["hispanic_latino"] : []), ...(saved ? [saved] : [])];
}

function sensitiveRow(q, { mem, context }) {
  const map = eeoMapFor(q.label);
  const labels = optionLabelsOf(q);
  const ask = (why, id) => ({
    source: "none",
    action: "ask",
    topic: "eeo",
    why,
    remember_as: { kind: "preference", id, scope: "global" },
  });
  // Pronouns are not a protected class: they are the phrase the user volunteered, and
  // `f.identity.pronouns` states it whether or not a demographic block was ever filled in. Tested
  // before `p.eeo` for exactly that reason — three postings left a pronouns field empty in round 1
  // while the fact was on file (docs/research/12-eval-judge-round1.md §3.7).
  if (/\bpronoun/i.test(q.label ?? "")) return pronounRow(mem, scopeCtx(context), labels, ask);
  // An accommodation request is not a demographic question, whichever protected characteristic
  // its wording happens to mention: it is answered from one standing `p.accommodation` the user
  // stated, or it is asked (judge §3 N1).
  if (isAccommodationRequest(q.label ?? "")) return accommodationRow(q, { mem, context });
  const saved = eeoBlock(mem, scopeCtx(context));
  if (!saved) return ask("no p.eeo on file", map ? `p.eeo.${map.field}` : "p.eeo");
  const { block, scope } = saved;

  if (!map) {
    // Sexual orientation, transgender status, age band, caregiver status …: real questions the
    // five saved fields do not answer. Only a standing "decline" stance answers them; anything
    // else is the user's to say, once, and is remembered as that stance.
    const stance = String(block.other_demographics ?? "").trim().toLowerCase();
    if (stance !== "decline") {
      return ask("p.eeo states no stance for demographic questions outside its five fields", "p.eeo.other_demographics");
    }
    const declined = labels.find((label) => DECLINE_RE.test(optionKey(label)));
    if (!declined) return ask("p.eeo.other_demographics is decline, and this question offers no decline option", "p.eeo.other_demographics");
    return { source: "preference", value: declined, option: declined, action: "fill", topic: "eeo", why: `p.eeo.other_demographics (${scope})` };
  }

  const wanted = eeoStated(block, map);
  if (!wanted.length) {
    const stated = block[map.field];
    return ask(
      stated ? `p.eeo.${map.field} is not one of ${Object.keys(map.values).join(" | ")}` : `p.eeo.${map.field} states no answer`,
      `p.eeo.${map.field}`,
    );
  }

  if (!labels.length) {
    // No option list. That means one of two very different things, and only the control says
    // which: a genuinely free-text self-identification box, or a select whose list the ATS
    // publishes nowhere but the live page (Greenhouse's `hispanic_ethnicity` is exactly this —
    // 0 options in the API, a real select on the form, matched by `resolveVocabulary`). Only the
    // first is gated: 1Password's textarea asks for anything **other than** the survey's
    // protected characteristics and round 2 typed the canonical disability sentence into it
    // (docs/research/13-eval-judge-round2.md §3 N1). A select still gets the canonical wording,
    // which is what its live list is matched against.
    const freeText = /^(?:text|textarea)$/.test(String(q.control ?? q.type ?? ""));
    if (freeText && !SELF_ID_RE.test(q.label ?? "")) {
      return {
        source: "none",
        action: "ask",
        topic: "eeo",
        why: `free-text box — it does not ask you to state your ${map.field.replace(/_/g, " ")}`,
      };
    }
    return { source: "preference", value: String(map.values[wanted[0]]), action: "fill", topic: "eeo", why: `p.eeo.${map.field} (${scope})` };
  }
  // The form's own wording for each saved value, ethnicity first.
  //
  // A label that *contains* another candidate's wording is a qualification of it — "Man" and
  // "Transgender man, male, or masculine" both state `male`, and committing the second would
  // assert something the user never said. Those are dropped, which resolves that pair to the
  // plain label deterministically. What survives are genuinely different categories ("East
  // Asian" / "South Asian" / "Southeast Asian" against a saved `asian`), i.e. the form asking
  // finer than the user stated, and that splits two ways:
  //   * a *single*-select goes to Jev over the form's options plus `none_of_these`, and the gate
  //     decides — the same ladder every other select climbs, never a pick by position;
  //   * a *multi*-select must not: request 3 asks one Noul per option with no `none_of_these`
  //     (src/jev/plan.mjs optionStage), so "Asian" can select East *and* South *and* Southeast —
  //     three claims about the user's ancestry they never made. That row is an `ask`.
  for (const candidate of wanted) {
    const canonical = String(map.values[candidate]);
    const matching = labels.filter((label) => eeoValueOf(map, label) === candidate);
    const words = matching.map((label) => optionKey(label).split(/[^a-z0-9]+/).filter(Boolean));
    // Keep only the least-qualified wording of each claim: a label whose words *contain another
    // candidate's words in order* is that candidate plus a qualifier ("Man" inside "Transgender
    // man, male, or masculine"). Word sequences, not substrings — "East Asian" is a substring of
    // "Southeast Asian" and a different people.
    const hits = matching.filter((_, i) => !words.some((other, j) => j !== i && other.length < words[i].length && contains(words[i], other)));
    const plain = hits.filter((label) => optionKey(label) === optionKey(canonical));
    const pick = plain.length === 1 ? plain[0] : hits.length === 1 ? hits[0] : null;
    if (pick) {
      return { source: "preference", value: pick, option: pick, action: "fill", topic: "eeo", why: `p.eeo.${map.field} (${scope})` };
    }
    if (hits.length > 1) {
      if (q.type === "multi_select") {
        // A multi-select gets one Noul per option and no `none_of_these` (src/jev/plan.mjs
        // optionStage), so a saved `asian` against East / South / Southeast Asian would tick all
        // three — claims about the user's ancestry they never made. Where they have stated a
        // standing decline for questions their saved block cannot answer exactly, that is the
        // answer, and it is their own words. Otherwise the row is theirs to settle.
        const declined = declineOption(block, labels);
        if (declined) {
          return {
            source: "preference",
            value: declined,
            option: declined,
            action: "fill",
            topic: "eeo",
            why: `this form splits your saved ${map.field} ${hits.length} ways — p.eeo.other_demographics (${scope})`,
          };
        }
        return {
          source: "none",
          action: "ask",
          topic: "eeo",
          why: `this form splits your saved ${map.field} into ${hits.length} answers — which one is yours?`,
          remember_as: { kind: "preference", id: `p.eeo.${map.field}`, scope: "global" },
        };
      }
      return {
        source: "preference",
        value: canonical,
        action: "fill",
        topic: "eeo",
        why: `p.eeo.${map.field} (${scope}) — ${hits.length} options state it`,
        _answerText: canonical,
      };
    }
  }
  const declined = declineOption(block, labels);
  if (declined) {
    return {
      source: "preference",
      value: declined,
      option: declined,
      action: "fill",
      topic: "eeo",
      why: `this form's list has no entry for your saved ${map.field} — p.eeo.other_demographics (${scope})`,
    };
  }
  return {
    source: "none",
    action: "ask",
    topic: "eeo",
    why: `this form's list has no entry for your saved ${map.field}`,
    remember_as: { kind: "preference", id: `p.eeo.${map.field}`, scope: "global" },
  };
}

/**
 * The list's own decline entry, but only where the user stated the standing `decline` stance.
 * This is the one thing that answers a demographic question their saved block cannot answer
 * exactly — a form asking finer than they stated, or offering no entry for what they stated —
 * and it is still their own words, never an inference about the characteristic itself.
 */
function declineOption(block, labels) {
  const stance = String(block?.other_demographics ?? "").trim().toLowerCase();
  if (stance !== "decline") return null;
  return labels.find((label) => DECLINE_RE.test(optionKey(label))) ?? null;
}

/** Do `words` contain `needle` as a contiguous run of whole words? */
function contains(words, needle) {
  if (!needle.length || needle.length > words.length) return false;
  for (let i = 0; i + needle.length <= words.length; i += 1) {
    if (needle.every((word, k) => words[i + k] === word)) return true;
  }
  return false;
}

/**
 * The pronouns the user stated: `p.eeo.pronouns` when a demographic block carries one, else the
 * `f.identity.pronouns` fact on its own. Never a guess from a name, and never gated on the rest of
 * `p.eeo` — a volunteered phrase is not a protected characteristic.
 */
function pronounRow(mem, scope, labels, ask) {
  const saved = eeoBlock(mem, scope);
  const block = saved?.block ?? {};
  const stated = typeof block.pronouns === "string" && block.pronouns.trim() ? block.pronouns.trim() : null;
  const fact = stated ? null : getFact(mem, "f.identity.pronouns");
  const value = stated ?? (fact ? factText(fact)?.text : null);
  if (!value) return ask("no pronouns on file", "p.eeo.pronouns");
  const why = stated ? `p.eeo.pronouns (${saved.scope})` : "f.identity.pronouns";
  const hit = labels.find((label) => optionKey(label) === optionKey(value));
  return { source: stated ? "preference" : "fact", value: hit ?? value, ...(hit ? { option: hit } : {}), action: "fill", topic: "eeo", why, _answerText: value };
}

function identityRow(q, { mem, context }) {
  const label = q.label ?? "";
  const optional = !q.required;
  const miss = (what, remember) => ({
    source: "none",
    action: optional ? "skip" : "ask",
    why: optional ? `optional — no ${what} on file` : `no ${what} on file`,
    ...(remember ? { remember_as: remember } : {}),
  });

  // résumé / cover letter (file rows) — documents, via p.resume_by_role_family
  if (q.type === "file" || q.control === "file") {
    if (COVER_RE.test(label)) {
      const cover = (mem?.documents ?? []).find((d) => /cover/i.test(String(d?.id ?? "")));
      if (!cover) return miss("cover-letter document", { kind: "document", scope: "global" });
      return fileRow(cover, "cover letter on file");
    }
    if (RESUME_RE.test(label)) {
      const doc = documentFor(mem, { role_family: context.role_family, company: context.company });
      if (!doc) return miss("résumé document", { kind: "document", id: "doc.resume.main", scope: "global" });
      return fileRow(doc, `p.resume_by_role_family → ${doc.id}`);
    }
  }

  const nameKind = NAME_RULES.find(([re]) => re.test(label))?.[1];
  if (nameKind) return nameRow(nameKind, mem, miss);

  if (EMAIL_RE.test(label)) {
    const row = getFact(mem, "f.identity.email");
    return row ? fromFact(row) : miss("email fact", { kind: "fact", id: "f.identity.email", scope: "global" });
  }
  if (PHONE_RE.test(label)) {
    const row = getFact(mem, "f.identity.phone");
    return row ? fromFact(row) : miss("phone fact", { kind: "fact", id: "f.identity.phone", scope: "global" });
  }

  const link = LINK_RULES.find(([re]) => re.test(label));
  if (link) {
    const row = firstFact(mem, link[1]);
    return row ? fromFact(row) : miss(`${link[1][0]} fact`, { kind: "fact", id: link[1][0], scope: "global" });
  }

  if (CURRENT_COMPANY_RE.test(label)) {
    const row = getFact(mem, "f.employment.current") ?? (mem?.facts ?? []).find((r) => r?.value?.current === true);
    return row ? fromFact(row) : miss("current employer fact", { kind: "fact", id: "f.employment.current", scope: "global" });
  }
  if (CURRENT_TITLE_RE.test(label)) {
    const row = getFact(mem, "f.employment.current_title");
    return row ? fromFact(row) : miss("current job title fact", { kind: "fact", id: "f.employment.current_title", scope: "global" });
  }
  if (LOCATION_RE.test(label)) {
    // A work mode is not a place. `f.identity.location` may hold "Remote" (or "Hybrid", or
    // "Anywhere") because that is all a CV stated, and typing it into a geocoder is how round 1
    // committed a US city the candidate has no connection to, two fields under "not authorized to
    // work in the US" (docs/research/12-eval-judge-round1.md §3.2). `locationFact()` rejects those
    // tokens and falls back to the city fact; with neither on file the row asks for the city.
    const row = locationFact(mem);
    if (row) return fromFact(row);
    const stated = getFact(mem, "f.identity.location");
    const why = stated ? `${stated.id} states a work mode, not a place` : "no city or location fact on file";
    return {
      source: "none",
      action: optional ? "skip" : "ask",
      why: optional ? `optional — ${why}` : why,
      remember_as: { kind: "fact", id: "f.identity.city", scope: "global" },
    };
  }
  if (ADDRESS_RE.test(label)) {
    const row = getFact(mem, "f.identity.address");
    return row ? fromFact(row) : miss("address fact", { kind: "fact", id: "f.identity.address", scope: "global" });
  }
  return miss("matching identity fact", { kind: "fact", scope: "global" });
}

function fileRow(doc, why) {
  if (!doc?.path || !existsSync(doc.path)) {
    return { source: "none", action: "ask", why: `${doc?.id ?? "document"} is not on disk` };
  }
  return { source: "document", value: path.basename(doc.path), path: doc.path, action: "fill", why };
}

/**
 * Name fields. A split of the stated full name is mechanical, not a guess about the person — but
 * only while the two tokens are a given name and a family name. `<Initial> <Name>` ("R Sanchez")
 * is written both ways round on real forms, and splitting it at the space puts the given name in
 * the Last Name box on every Greenhouse form (judge §3.12). The user's own statement settles it:
 * `f.identity.first_name` / `f.identity.last_name` are read first, and `scripts/learn.mjs` reports
 * the `g.identity.name_split` gap that writes them.
 */
function nameRow(kind, mem, miss) {
  if (kind === "preferred") {
    const row = getFact(mem, "f.identity.preferred_name");
    return row ? fromFact(row) : miss("preferred name fact", { kind: "fact", id: "f.identity.preferred_name", scope: "global" });
  }
  if (kind === "native") {
    const row = getFact(mem, "f.identity.full_name_native");
    return row ? fromFact(row) : miss("name in that script", { kind: "fact", id: "f.identity.full_name_native", scope: "global" });
  }
  if (kind !== "full") {
    const stated = getFact(mem, `f.identity.${kind}_name`);
    if (stated) return fromFact(stated);
  }
  const full = getFact(mem, "f.identity.full_name");
  if (!full) return miss("name fact", { kind: "fact", id: "f.identity.full_name", scope: "global" });
  if (kind === "full") return fromFact(full);
  const parts = String(factText(full)?.text ?? "").split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return { source: "none", action: "ask", why: `${full.id} is one token — first/last split is not stated` };
  }
  const split = nameSplit(parts);
  return {
    source: "fact",
    value: kind === "first" ? split.first : split.last,
    action: "fill",
    why: `${kind} name split from ${full.id}${split.initialFirst ? " (the single-letter token reads as the family name)" : ""}`,
  };
}

/** A token that is an initial rather than a name: one or two letters, dot optional ("S", "S."). */
const INITIAL_RE = /^[\p{L}]{1,2}\.?$/u;

/**
 * `["Robin","Sanchez"]` → `{first:"Robin", last:"Sanchez"}`; `["R","Sanchez"]` → `{first:"Sanchez",
 * last:"R"}`. Two tokens, exactly one of them an initial: the word is the given name and the
 * initial is the family name, whichever order the user wrote them in. Anything longer splits at
 * the first space, as before.
 */
export function nameSplit(parts) {
  if (parts.length === 2 && INITIAL_RE.test(parts[0]) !== INITIAL_RE.test(parts[1])) {
    const initial = INITIAL_RE.test(parts[0]) ? parts[0] : parts[1];
    const name = initial === parts[0] ? parts[1] : parts[0];
    return { first: name, last: initial, initialFirst: true };
  }
  return { first: parts[0], last: parts.slice(1).join(" "), initialFirst: false };
}

function circumstanceRow(q, ctx) {
  const { mem, pipeline, baselines, context, now = new Date() } = ctx;
  const label = q.label ?? "";
  const open = (why) => ({ _open: true, source: "none", action: "ask", why });

  // An accommodation request, wherever it lands: `classify()` routes one here and `sensitiveRow()`
  // forwards the ones whose wording mentions a protected characteristic.
  if (isAccommodationRequest(label)) return accommodationRow(q, ctx);

  // Work authorization is two-valued per country, and the jurisdiction is read in one fixed order:
  //   1. the question's own wording ("authorized to work in the United States") — always wins,
  //      because a form may ask about a country the posting is not in. Read as *prose*
  //      (`countryInQuestion`), not as a location string: the location table's ", XX" state rule
  //      turns "…the country you are currently in, or your target relocation country?" into
  //      ", OR" → Oregon → US, which is how a London posting reached for `f.work_auth.US` while
  //      the rest of the same plan derived `uk_london` (judge §2 item 9);
  //   2. the posting — `context.country`, derived **once** per plan by `jobContext()` and shared
  //      unchanged by every rule below;
  //   3. for a remote listing that names no country at all, the country the user is a citizen of —
  //      their own stated fact, and the only jurisdiction such a posting can mean for them.
  // Still nothing → ask. Never answer for the wrong jurisdiction.
  if (SPONSOR_RE.test(label) || AUTHORIZED_RE.test(label)) {
    const asked = countryInQuestion(label);
    const fromCitizenship = !asked && !context.country && context.remote ? citizenshipCountry(mem) : null;
    const country = asked ?? context.country ?? fromCitizenship?.country ?? null;
    if (!country) return { source: "none", action: "ask", topic: "work_auth", why: "the posting names no country" };
    const auth = workAuth(mem, country);
    if (!auth) {
      return {
        source: "none",
        action: "ask",
        topic: "work_auth",
        why: `no work-authorization fact for ${country}`,
        remember_as: { kind: "fact", id: `f.work_auth.${country}`, scope: "global" },
      };
    }
    const { value, answerText, kind } = workAuthAnswer(workAuthKind(label), auth, country);
    // A country the user never named is answered from their blanket default rule, and a country
    // the *posting* never named is answered from their citizenship. Both values are usable — they
    // are the user's own stated facts — but the two most legally consequential rows on the form
    // are never filled silently from either: `check` is still filled and shows up under ► CHECK.
    // The inferred-jurisdiction phrase leads the `why` because `summary.mjs` clips it at " (".
    const exact = auth.exact && !fromCitizenship;
    return {
      source: "derived",
      value,
      action: exact ? "fill" : "check",
      topic: "work_auth",
      why: exact
        ? `${auth.fact} for ${country} (${kind})`
        : fromCitizenship
          ? `remote posting names no country — answered for ${country} from ${fromCitizenship.fact} (${kind})`
          : `from your default rule (no ${country}-specific fact) — ${auth.fact} for ${country} (${kind})`,
      _answerText: answerText,
    };
  }

  if (RELOCATE_RE.test(label)) {
    const country = countryInQuestion(label) ?? context.country;
    const answered = relocationFor(mem, { ...scopeCtx(context), country });
    if (answered.value == null) return { source: "none", action: "ask", topic: "relocation", why: answered.why };
    // "Are you willing to relocate? If so, to which entity?" lists countries, not Yes/No (DeepL,
    // judge §3.8): a willing candidate answers it by naming the one the posting is in. The country
    // has to be *on the list* — nothing is picked by position, and a No answers the list's own
    // "I am not willing to relocate" option instead.
    const option = relocationOption(q, answered.value, country);
    return {
      source: "preference",
      value: option ?? answered.value,
      ...(option ? { option } : {}),
      action: "fill",
      topic: "relocation",
      why: answered.why,
      _answerText: answered.text,
    };
  }

  // Which office, not how often: answered from the user's own stated city, or asked.
  if (OFFICE_LOCATION_RE.test(label)) {
    const office = officeRow(q, mem);
    if (office) return office;
  }

  if (IN_OFFICE_RE.test(label)) {
    const answered = inOfficeFor(mem, scopeCtx(context));
    if (answered.value == null) {
      return {
        _open: true,
        source: "none",
        action: "ask",
        topic: "in_office",
        why: answered.why,
        remember_as: { kind: "preference", id: "p.in_office", scope: `company:${context.company_slug}` },
      };
    }
    return { source: "preference", value: answered.value, action: "fill", topic: "in_office", why: answered.why, _answerText: answered.text };
  }

  if (START_RE.test(label)) {
    // A date control takes a date. The notice rule states prose ("Available immediately"), which is
    // what round 1 typed into Fireworks' date picker — read back as text, left open over the next
    // field, committed as nothing (judge §3.5). Where the form asks for a date, the stated
    // `f.identity.start_date` answers it, and otherwise today plus the notice period does.
    if (q.control === "date" || q.type === "date") {
      const date = startDate(mem, scopeCtx(context), now);
      if (!date) {
        return {
          source: "none",
          action: "ask",
          topic: "notice",
          why: "no start-date fact and no p.notice_rule to count from",
          remember_as: { kind: "fact", id: "f.identity.start_date", scope: "global" },
        };
      }
      return { source: "derived", value: date.value, action: "fill", topic: "notice", why: date.why, _answerText: date.value };
    }
    const rule = noticeRule(mem, scopeCtx(context));
    if (!rule) return { source: "none", action: "ask", topic: "notice", why: "no p.notice_rule on file" };
    const value = rule.text ?? (rule.days === 0 ? "Immediately" : rule.days != null ? `${rule.days} days` : null);
    if (!value) return { source: "none", action: "ask", topic: "notice", why: "p.notice_rule states no answer" };
    return { source: "derived", value: String(value), action: "fill", topic: "notice", why: `p.notice_rule (${rule.kind})`, _answerText: String(value) };
  }

  if (SALARY_RE.test(label)) {
    const salary = salaryFor(mem, context.job, baselines);
    if (salary.action !== "fill") {
      return {
        source: "none",
        action: "ask",
        topic: "salary",
        why: salary.why,
        remember_as: { kind: "preference", id: "p.salary", scope: "global" },
      };
    }
    const value = q.type === "number" ? String(salary.amount) : salary.formatted ?? String(salary.amount);
    return { source: "derived", value, action: "fill", topic: "salary", why: salary.why, _answerText: value };
  }

  // Restrictive agreements: the user's own standing "Yes"/"No", stated once at onboarding and
  // answered from memory on every form after (PLAN §2.4). Never defaulted — a missing preference
  // is an `ask` carrying the id that would fix it — and the "If yes, please explain" row it drags
  // along is blanked by `applyDependencies()` when the answer is No.
  if (RESTRICTIVE_RE.test(label)) {
    return statedStance(mem, context, { id: "p.legal.restrictive_agreements", topic: "restrictive_agreements" });
  }
  // "Have you ever been employed **by this company**?" is a different question at every employer,
  // so only a company-scoped statement answers it (`p.legal.previously_employed` with an
  // `overrides[]` entry for this company). A global Yes/No pasted into a company-named question
  // would be a wrong answer rather than a missing one, so a global-only row falls through to the
  // pipeline derivation below, which answers per company or asks.
  if (PREVIOUSLY_EMPLOYED_RE.test(label)) {
    const pref = resolvePreference(mem, "p.legal.previously_employed", scopeCtx(context));
    if (pref && pref.scope !== "global") {
      return statedStance(mem, context, { id: "p.legal.previously_employed", topic: "previously_employed" });
    }
  }

  if (APPLIED_BEFORE_RE.test(label)) {
    const answered = appliedBeforeFor(pipeline, context.company);
    if (answered.value == null) return { source: "none", action: "ask", topic: "applied_before", why: answered.why };
    return {
      source: "derived",
      value: answered.value,
      action: "fill",
      topic: "applied_before",
      why: answered.why,
      _answerText: answered.text,
    };
  }

  if (HOW_HEARD_RE.test(label)) {
    const pref = resolvePreference(mem, "p.how_heard", scopeCtx(context));
    // Never an invented channel: a preference that states no usable text is an `ask`, carrying the
    // id the host should save the user's own answer under (AGENTS.md: unknown → ask, never a default).
    const askHowHeard = (why) => ({
      source: "none",
      action: "ask",
      topic: "how_heard",
      why,
      remember_as: { kind: "preference", id: "p.how_heard", scope: "global" },
    });
    if (!pref) return askHowHeard("no p.how_heard on file");
    if (typeof pref.value !== "string" || !pref.value.trim()) return askHowHeard("p.how_heard states no answer");
    const value = pref.value.trim();
    return { source: "preference", value, action: "fill", topic: "how_heard", why: `p.how_heard (${pref.scope})`, _answerText: value };
  }

  return open("circumstance with no matching rule");
}

/**
 * An accommodation / adjustment request. Exactly one thing answers one: the standing
 * `p.accommodation` the user stated. Round 2 typed the canonical **disability self-identification**
 * into 1Password's accommodation textarea, sourced from `p.eeo.disability_status`, under a label
 * that asked for anything *other than* the survey's protected characteristics and while
 * `p.accommodation` sat on file unconsulted (docs/research/13-eval-judge-round2.md §3 N1). A
 * demographic value is never an accommodation, so with no preference on file this asks.
 */
function accommodationRow(q, { mem, context }) {
  const pref = resolvePreference(mem, "p.accommodation", scopeCtx(context));
  const ask = (why) => ({
    source: "none",
    action: "ask",
    topic: "accommodation",
    why,
    remember_as: { kind: "preference", id: "p.accommodation", scope: "global" },
  });
  if (!pref) return ask("no p.accommodation on file — a demographic value is never an accommodation");
  const stance = yesNoOf(pref.value);
  const stated = typeof pref.value === "string" ? pref.value.trim() : null;
  const value = stated || stance;
  if (!value) return ask("p.accommodation states no answer");
  const labels = optionLabelsOf(q);
  if (!labels.length) {
    return { source: "preference", value, action: "fill", topic: "accommodation", why: `p.accommodation (${pref.scope})`, _answerText: value };
  }
  const hit =
    labels.find((label) => optionKey(label) === optionKey(value)) ??
    (stance ? labels.find((label) => yesNoOf(label) === stance) : null);
  if (!hit) return ask(`p.accommodation (${pref.scope}) — no option states it`);
  return { source: "preference", value: hit, option: hit, action: "fill", topic: "accommodation", why: `p.accommodation (${pref.scope})` };
}

/**
 * "Which of our offices are you closest to?" — geography, and nothing in memory states how far
 * one place is from another. So the only honest answers are an option that *names* the city or
 * the country the user stated, and the list's own "None of the above" when their place is not on
 * it (a `check`: it is derived by elimination, not stated). Anything else asks.
 *
 * @returns {object|null} null when the options are not places after all, so the caller falls
 *   through to `p.in_office` — "Which best describes your office preference?" is a schedule
 *   question wearing the word "office".
 */
function officeRow(q, mem) {
  const labels = optionLabelsOf(q);
  const row = locationFact(mem);
  const stated = row ? (factText(row)?.text ?? "") : "";
  const parts = stated.split(",").map((part) => part.trim()).filter(Boolean);
  if (labels.length && !labels.some((label) => countryFromText(label))) return null;
  const ask = (why) => ({
    source: "none",
    action: "ask",
    topic: "office_location",
    why,
    remember_as: { kind: "fact", id: "f.identity.city", scope: "global" },
  });
  if (!parts.length) return ask("no city on file, and which office is nearest is not something memory states");
  if (!labels.length) return ask(`${row.id} states where you are, not which of their offices is nearest`);
  const named = labels.find((label) => parts.some((part) => optionKey(label) === optionKey(part)));
  if (named) return { source: "fact", value: named, option: named, action: "fill", topic: "office_location", why: `${row.id} names this office` };
  const none = labels.find((label) => NONE_OF_ABOVE_RE.test(optionKey(label)));
  if (none) {
    return { source: "fact", value: none, option: none, action: "check", topic: "office_location", why: `${row.id} is not on this list — distance is not something memory states` };
  }
  return ask(`no office on this list is where ${row.id} says you are`);
}

/**
 * A preference that states a plain Yes / No — `true`, `"no"`, `{answer: "No"}` are all how one
 * gets written. Anything else (a sentence, a mapping with no answer) is not a stance.
 *
 * An attestation states its Yes in words ("I agree", "I acknowledge and consent"), and those are
 * the option labels a gate offers as well as the wording a stored stance may be written in, so
 * they read as the Yes and the No they are.
 * @returns {"Yes"|"No"|null}
 */
export function yesNoOf(value) {
  if (value === true) return YES;
  if (value === false) return NO;
  if (value && typeof value === "object" && !Array.isArray(value)) return yesNoOf(value.answer ?? value.value ?? null);
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^(n|no|false|i (?:do not|don't|am not|have not|haven't|was not|wasn't|disagree|decline|object))\b/i.test(text)) return NO;
  if (/^(y|yes|true|i (?:do|am|have|was|agree|accept|consent|acknowledge|understand|certify|confirm))\b/i.test(text)) return YES;
  return null;
}

/** A standing Yes/No preference → the row, or the `ask` that carries the id which would fix it. */
function statedStance(mem, context, { id, topic }) {
  const pref = resolvePreference(mem, id, scopeCtx(context));
  const stance = pref ? yesNoOf(pref.value) : null;
  if (!stance) {
    return {
      source: "none",
      action: "ask",
      topic,
      why: pref ? `${id} states no Yes/No` : `no ${id} on file`,
      remember_as: { kind: "preference", id, scope: "global" },
    };
  }
  return { source: "preference", value: stance, action: "fill", topic, why: `${id} (${pref.scope})`, _answerText: stance };
}

// A sponsorship question nearly always names work authorization too ("… require company
// sponsorship to retain or extend your work authorization …"), so the two cannot be told apart by
// asking which vocabulary appears. What separates them is what the sentence *asks for*:
//   "… require / need sponsorship …"             → the sponsorship question
//   "… authorized to work … without sponsorship" → one compound question, true only when both hold
//   otherwise                                    → the authorization question
const ASKS_SPONSORSHIP_RE = /\b(?:requir\w*|need\w*|request\w*|seek\w*|rely\w*|depend\w*)\b[^?]{0,60}\b(?:sponsor\w*|visa|h-?1b|immigration)\b|\b(?:sponsor\w*|visa|immigration)\b[^?]{0,40}\b(?:requir\w*|need\w*)\b/i;
const WITHOUT_SPONSORSHIP_RE = /\bwithout\b[^?]{0,40}\bsponsor|\bno\b[^?]{0,20}\bsponsorship (?:required|needed)/i;

/** @returns {"sponsorship"|"authorized_without_sponsorship"|"authorized"} */
export function workAuthKind(label) {
  const text = String(label ?? "");
  if (WITHOUT_SPONSORSHIP_RE.test(text) && AUTHORIZED_RE.test(text)) return "authorized_without_sponsorship";
  if (ASKS_SPONSORSHIP_RE.test(text)) return "sponsorship";
  return "authorized";
}

/**
 * The two-valued fact → this question's answer. `answerText` is what request 2 matches against the
 * form's own options, so it names *when* sponsorship starts: the three-way vocabulary (now / in the
 * future / never) has no option for "now and in the future", and a blended phrase matches two
 * options equally well and therefore matches neither.
 */
export function workAuthAnswer(kind, auth, country) {
  if (kind === "sponsorship") {
    if (!auth.needs_sponsorship_future) {
      return { kind, value: NO, answerText: `No — will not require employer immigration sponsorship to work in ${country}` };
    }
    return {
      kind,
      value: YES,
      answerText: auth.authorized_now
        ? `Yes — authorized to work in ${country} today, but will require employer immigration sponsorship in the future to keep working there`
        : `Yes — requires employer immigration sponsorship starting now to legally work in ${country}`,
    };
  }
  if (kind === "authorized_without_sponsorship") {
    const yes = auth.authorized_now && !auth.needs_sponsorship_future;
    return {
      kind,
      value: yes ? YES : NO,
      answerText: yes
        ? `Yes — legally authorized to work in ${country} and needs no employer sponsorship`
        : `No — ${auth.authorized_now ? `authorized in ${country} today but will need employer sponsorship` : `not currently authorized to work in ${country} without employer sponsorship`}`,
    };
  }
  return {
    kind,
    value: auth.authorized_now ? YES : NO,
    answerText: auth.authorized_now
      ? `Yes — currently legally authorized to work in ${country}`
      : `No — not currently legally authorized to work in ${country}`,
  };
}

// "Why us" is one sentence from the user per company; the writer expands it later (PLAN step 10).
function whyUsRow(_q, { mem, context }) {
  const company = (mem?.answers ?? []).filter(
    (row) => row?.kind === "company" && slugify(String(row?.scope ?? "").replace(/^company:/, "")) === context.company_slug,
  );
  if (!company.length) {
    return {
      source: "none",
      action: "ask",
      topic: "why_us",
      why: `no company answer saved for ${context.company}`,
      remember_as: { kind: "answer", scope: `company:${context.company_slug}` },
    };
  }
  const row = company[0];
  const value = row.value ?? row.variants?.medium ?? row.variants?.short ?? null;
  if (!value) return { source: "none", action: "ask", topic: "why_us", why: `${row.qid} has no text`, remember_as: { kind: "answer", scope: `company:${context.company_slug}` } };
  return { source: "answer", value: String(value), canon: row.qid ?? null, action: "fill", topic: "why_us", why: `saved company answer ${row.qid ?? ""}`.trim() };
}

function scopeCtx(context) {
  return { company: context.company, role_family: context.role_family };
}

/** `{willing, anywhere_except[], to[]}` + the posting's country → Yes / No / null (= ask). */
export function relocationAnswer(value, country) {
  if (value == null) return null;
  if (typeof value === "boolean") return value ? YES : NO;
  if (typeof value === "string") return /^(yes|true|willing)/i.test(value) ? YES : /^(no|false)/i.test(value) ? NO : null;
  if (typeof value !== "object") return null;
  const except = (value.anywhere_except ?? value.except ?? []).map((c) => String(c).toUpperCase());
  const only = (value.to ?? value.only ?? []).map((c) => String(c).toUpperCase());
  if (value.willing === false) return NO;
  if (country && except.includes(country)) return NO;
  if (only.length) return country ? (only.includes(country) ? YES : NO) : null;
  if (value.willing === true) return except.length && !country ? null : YES;
  return null;
}

/** A "not willing to relocate" / "I would not move" option, in the wordings boards write it in. */
const NO_RELOCATION_RE = /\b(?:not willing|unwilling|would not|won'?t|no,? i|not able|prefer not)\b[^.]{0,30}\b(?:relocat|move)|^no\b/i;

/**
 * A relocation question whose options are places rather than Yes/No (DeepL lists `United Kingdom`
 * and `I am not willing to relocate.`): the answer the preference already produced, expressed in
 * this form's own vocabulary. `Yes` picks the option naming the posting's country — and only that
 * option, never one by position — and `No` picks the list's own refusal.
 * @returns {string|null} the option label, or null when the list does not state the answer
 */
function relocationOption(q, answer, country) {
  const labels = optionLabelsOf(q);
  if (!labels.length) return null;
  // A list that offers an affirmative ("Yes", "I am willing to relocate") takes the answer as it
  // stands. A refusal-only list ("United Kingdom" / "I am not willing to relocate.") does not.
  if (labels.some((label) => yesNoOf(label) === YES)) return null;
  if (answer === NO) return labels.find((label) => NO_RELOCATION_RE.test(label)) ?? null;
  if (!country) return null;
  const named = labels.filter((label) => !NO_RELOCATION_RE.test(label) && countryFromText(label) === country);
  return named.length === 1 ? named[0] : null;
}

// The three derivations below are shared with `src/jev/plan.mjs ruleAnswer()`: a canonical question
// whose `rule_ref` names one of them must answer exactly what this pass would have answered, so the
// value, the `why` and the sentence request 2 matches against are minted once, here. `value: null`
// carries the reason the row has to be an `ask` — "no preference on file" and "the preference does
// not cover this posting" are different things to tell the user.

/** `p.relocation` + the posting's country → `{value, why, text?}`; `value: null` → ask. */
export function relocationFor(mem, { company, role_family, country = null } = {}) {
  const pref = resolvePreference(mem, "p.relocation", { company, role_family });
  if (!pref) return { value: null, why: "no p.relocation on file" };
  const value = relocationAnswer(pref.value, country);
  if (value == null) return { value: null, why: "p.relocation does not cover this location" };
  return {
    value,
    why: `p.relocation (${pref.scope})${country ? ` for ${country}` : ""}`,
    text: `${value} — ${value === YES ? "willing to relocate for this role" : "not relocating to this location"}`,
  };
}

/** `p.in_office` → the days/answer the user stated, verbatim. An empty statement is an ask. */
export function inOfficeFor(mem, { company, role_family } = {}) {
  const pref = resolvePreference(mem, "p.in_office", { company, role_family });
  if (!pref) return { value: null, why: "no in-office preference on file" };
  const raw = pref.value;
  const stated =
    raw && typeof raw === "object" ? (raw.answer ?? (raw.days != null ? raw.days : "")) : (raw ?? "");
  const value = String(stated).trim();
  if (!value) return { value: null, why: "p.in_office states no answer" };
  return { value, why: `p.in_office (${pref.scope})`, text: value };
}

/**
 * Pipeline history → "have you applied here before?". An empty pipeline is **not** evidence of
 * "never applied" — the user may have applied by hand — so it asks instead of answering No.
 */
export function appliedBeforeFor(pipeline, company) {
  const tracked = (Array.isArray(pipeline) ? pipeline : (pipeline?.jobs ?? [])).length;
  if (!tracked) return { value: null, why: "no pipeline history to answer from" };
  const seen = appliedBefore(pipeline, company);
  return {
    value: seen.applied ? YES : NO,
    why: seen.applied ? `pipeline: ${seen.count} prior application(s)` : `pipeline has no record for ${company}`,
    text: seen.applied
      ? `Yes — applied before (${seen.last?.title ?? "prior application"})`
      : `No — first application to ${company}`,
  };
}

/** What the runner suggests the host remember this answer as (PLAN §2.4 scopes). */
function rememberAs(q, decision, context) {
  const companyScope = `company:${context.company_slug}`;
  // A gate's answer is a standing stance, not a per-company sentence: it is stored where
  // `policyGateRow()` reads it back from, so answering it once closes the same gate everywhere.
  if (q.class === "policy_gate") return { kind: "preference", id: `p.legal.${policySlug(q.label)}`, scope: "global" };
  if (q.class === "why_us" || q.class === "company_specific") return { kind: "answer", scope: companyScope };
  if (q.class === "essay" || q.class === "optional_text") return { kind: "story", scope: "global" };
  if (q.class === "identity") return { kind: "fact", scope: "global" };
  if (decision.topic === "in_office" || decision.topic === "relocation") return { kind: "preference", scope: companyScope };
  if (decision.topic === "work_auth") return { kind: "fact", scope: "global" };
  if (decision.topic) return { kind: "preference", scope: "global" };
  return { kind: "answer", scope: companyScope };
}
