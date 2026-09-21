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

import { existsSync } from "node:fs";
import path from "node:path";

import { slugify } from "../config.mjs";
import { documentFor, getFact, resolvePreference } from "../memory/resolve.mjs";
import { appliedBefore, noticeRule, roleFamilyFor, salaryFor, workAuth } from "../memory/derive.mjs";
import { countryFromText } from "../schema/normalize.mjs";

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

const NAME_RULES = [
  [/preferred\s+(?:first\s+)?name|^nick\s*name/i, "preferred"],
  [/^(?:your\s+|legal\s+)*first\s+name|^given\s+name/i, "first"],
  [/^(?:your\s+|legal\s+)*last\s+name|^family\s+name|^surname/i, "last"],
  [/^(?:your\s+)?(?:full\s+|legal\s+)?name\b/i, "full"],
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
const LOCATION_RE = /^(?:your |current |candidate )*(?:location|city|country)\b|where are you (?:currently )?(?:located|based)|current location/i;
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
  return { decisions, context };
}

function resolveQuestion(q, ctx) {
  switch (q.class) {
    case "sensitive":
      return sensitiveRow(q, ctx);
    case "policy_gate":
      return {
        source: "none",
        action: "ask",
        topic: "policy",
        why: "attestation — answered by the user, never globally",
      };
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

// EEO / demographics: skipped unless the user stated one global policy (AGENTS.md).
function sensitiveRow(q, { mem }) {
  const pref = resolvePreference(mem, "p.eeo_policy");
  if (!pref) {
    return { source: "none", action: "skip", topic: "eeo", why: "EEO: no p.eeo_policy on file" };
  }
  const stance = typeof pref.value === "object" && pref.value ? pref.value.answer ?? pref.value.value : pref.value;
  if (stance == null || stance === "") {
    return { source: "none", action: "skip", topic: "eeo", why: "p.eeo_policy states no answer" };
  }
  return {
    source: "preference",
    value: String(stance),
    action: "fill",
    topic: "eeo",
    why: `p.eeo_policy (${pref.scope})`,
    ...(q.options?.length ? { _answerText: String(stance) } : {}),
  };
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
    const row = getFact(mem, "f.identity.location");
    return row ? fromFact(row) : miss("location fact", { kind: "fact", id: "f.identity.location", scope: "global" });
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

/** Name fields. A split of the stated full name is mechanical, not a guess about the person. */
function nameRow(kind, mem, miss) {
  const full = getFact(mem, "f.identity.full_name");
  if (kind === "preferred") {
    const row = getFact(mem, "f.identity.preferred_name");
    return row ? fromFact(row) : miss("preferred name fact", { kind: "fact", id: "f.identity.preferred_name", scope: "global" });
  }
  if (!full) return miss("name fact", { kind: "fact", id: "f.identity.full_name", scope: "global" });
  if (kind === "full") return fromFact(full);
  const parts = String(factText(full)?.text ?? "").split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return { source: "none", action: "ask", why: `${full.id} is one token — first/last split is not stated` };
  }
  const value = kind === "first" ? parts[0] : parts.slice(1).join(" ");
  return { source: "fact", value, action: "fill", why: `${kind} name split from ${full.id}` };
}

function circumstanceRow(q, ctx) {
  const { mem, pipeline, baselines, context } = ctx;
  const label = q.label ?? "";
  const open = (why) => ({ _open: true, source: "none", action: "ask", why });

  // Work authorization is two-valued per country, and the jurisdiction is read in one fixed order:
  //   1. the question's own wording ("authorized to work in the United States") — always wins,
  //      because a form may ask about a country the posting is not in;
  //   2. the posting (`job.country`, read from the raw schema by `src/schema/normalize.mjs`);
  //   3. for a remote listing that names no country at all, the country the user is a citizen of —
  //      their own stated fact, and the only jurisdiction such a posting can mean for them.
  // Still nothing → ask. Never answer for the wrong jurisdiction.
  if (SPONSOR_RE.test(label) || AUTHORIZED_RE.test(label)) {
    const fromCitizenship = !countryFromText(label) && !context.country && context.remote ? citizenshipCountry(mem) : null;
    const country = countryFromText(label) ?? context.country ?? fromCitizenship?.country ?? null;
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
    const country = countryFromText(label) ?? context.country;
    const answered = relocationFor(mem, { ...scopeCtx(context), country });
    if (answered.value == null) return { source: "none", action: "ask", topic: "relocation", why: answered.why };
    return {
      source: "preference",
      value: answered.value,
      action: "fill",
      topic: "relocation",
      why: answered.why,
      _answerText: answered.text,
    };
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
  if (q.class === "policy_gate") return { kind: "answer", scope: companyScope };
  if (q.class === "why_us" || q.class === "company_specific") return { kind: "answer", scope: companyScope };
  if (q.class === "essay" || q.class === "optional_text") return { kind: "story", scope: "global" };
  if (q.class === "identity") return { kind: "fact", scope: "global" };
  if (decision.topic === "in_office" || decision.topic === "relocation") return { kind: "preference", scope: companyScope };
  if (decision.topic === "work_auth") return { kind: "fact", scope: "global" };
  if (decision.topic) return { kind: "preference", scope: "global" };
  return { kind: "answer", scope: companyScope };
}
