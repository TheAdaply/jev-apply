// PLAN §2.2 step 6½ — the evidence tier. Stage order in the resolve pipeline is
//
//     exact  →  derived rule  →  **infer**  →  ask
//
// and this module is the third stage. It runs only over rows every earlier stage left as an `ask`,
// and it answers the one class of row the five graded rounds kept losing: a question the runner
// *understood* — it knew the topic, it wrote "no p.how_heard on file" — beside memory that holds
// the evidence for the answer without holding the answer itself. 54 such rows across 12 unseen
// postings (how_heard ×6, in_office ×5, years_experience ×2, previously_employed ×3, preferred_name
// ×5, standard acknowledgements ×5, work_location ×2). Memory was a lookup table; here it is
// evidence to reason over.
//
// Three judgements, in this order, and each one can only *lose*:
//
//   1. evidence   code pre-filters ≤12 candidate items out of every memory kind (facts with their
//                 `since:`, preferences, saved answers, stories, this posting's pipeline
//                 provenance, the posting's own title/location) by tag overlap and kind; one
//                 batched Jev Noul per item — "does this item bear on this question for this
//                 candidate?" — keeps at most 6.
//   2. proposal   the candidate values are the form's *own* options for an option or boolean
//                 control, a computed number/date for those controls, and ≤5 templates rendered
//                 from the evidence for a short text box. One Jev Choice over them plus
//                 `none_of_these`. Jev selects; it never writes a value (AGENTS.md).
//   3. justification  one Noul whose state carries the proposed answer and the evidence **text** —
//                 never a reference to an item id the model cannot see, which is how the earlier
//                 model-judged framework talked itself into answers (docs/POSTMORTEM.md §3). Below
//                 `GATES.inferBelow` the row goes back to being an `ask`.
//
// What it never touches, because an inference there is a guess about a person and not a reading of
// evidence: any `sensitive` row — pronouns included, since a pronoun derived from a saved gender is
// a heuristic over a neighbouring demographic field and the one thing `p.eeo` may answer is the
// field the user filled in (AGENTS.md, and `PRONOUN_FACT_RE` in `src/plan/preflight.mjs` admits a
// *stated* pronoun fact and nothing else); a question about a third party's employment; a `why_us`
// or essay row (the writer's, behind its own two gates); a file row; an arbitration clause or any
// other gate that commits the candidate to something; and every policy gate outside the three
// standard notices the user signed off in one sentence.
//
// Output: `action:"check"`, `source:"inferred"`, `why:"inferred — <justification> (evidence: …)"`,
// plus a public `inference` block so `decisions.json` shows what was read and how sure the
// justification was. Never `fill`: an inferred answer is shown to the user before Submit, always.
//
// Budget: ≤2 Jev requests per posting (evidence + proposal batched into one, justification the
// other), and `--no-infer` turns the whole stage off. Both requests — state *and* questions, with
// the evidence text inlined in each question — are appended to `applications/<slug>/trace.jsonl`
// like every other Jev call: the evidence is the whole warrant for the answer, so an audit that
// omitted it would not be one. Nothing sensitive is in there to redact, because no `sensitive`
// memory row ever enters the pool (`sensitiveRow`, src/memory/enrich.mjs).

import { appendTrace } from "../browser/trace.mjs";
import { normalizeOption } from "../canon/normalize.mjs";
import { NONE, choice, noul, systemOne, withNone } from "../jev/client.mjs";
import { GATES } from "../jev/gates.mjs";
import { itemText, questionTags, sensitiveRow as sensitiveMemoryRow } from "../memory/enrich.mjs";
import { fullTimeYears, noticeRule, startDate } from "../memory/derive.mjs";
import { applicableCorrections, getFact, resolvePreference, usableStories } from "../memory/resolve.mjs";
import { STANDARD_ACKS_ID, isUserSourced, parseSince, stamp } from "../memory/schema.mjs";
import { upsertRow } from "../memory/store.mjs";
// A pronoun row (`sensitive`, and never inferred — see the header) is spelled once, in the classifier.
import { PRONOUN_ROW_RE } from "../schema/classes.mjs";
import { asksAboutThisEmployer, employersNamed, factText, nameSplit, policySlug, yesNoOf } from "./resolve.mjs";

/** The classes an evidence-based answer may reach. `sensitive`, `why_us` and `essay` are absent. */
export const INFER_CLASSES = Object.freeze(new Set(["identity", "circumstance", "company_specific", "optional_text", "policy_gate"]));

/**
 * The acknowledgements one sentence at onboarding covers: "accept standard application
 * acknowledgements — truthfulness, interview recording, privacy — automatically?"
 * (`p.legal.standard_acks`, `scripts/learn.mjs`). Three slugs, and they are reached *only* after
 * `policyGateRow()` has already failed to find this gate's own `p.legal.<slug>` — so the blanket
 * stance never outranks a specific one, and it is never a neighbouring preference standing in for
 * a missing one: it is a stance whose own wording names this class of notice.
 *
 * Two exclusions, both deliberate:
 *   * `arbitration_ack`. An arbitration clause is a right being given up, not a notice being read.
 *     A blanket yes cannot sign one — the postmortem's A1 is one preference answering several
 *     different attestations, and arbitration is the one where that is not recoverable. It keeps
 *     the existing rule: `p.legal.arbitration_ack` or an `ask`.
 *   * `ai_usage_ack`, and every slug not listed. An AI-usage attestation states what the candidate
 *     did while applying; nobody can sign that on their behalf.
 */
export const STANDARD_ACK_SLUGS = Object.freeze(new Set(["application_truthful_ack", "interview_recording_consent", "privacy_policy_ack"]));

/**
 * A gate whose wording names a specific obligation, whatever slug it landed on: an agreement to
 * arbitrate or to waive something, a fee, a contract, a check to be run on the candidate, a
 * relocation or start-date commitment. The blanket stance does not reach these even when their
 * slug is one of the three — the slug is derived from the gate's subject, and a sentence that
 * *also* commits the candidate to something is not a standard notice.
 */
const SPECIFIC_OBLIGATION_RE =
  /\barbitrat\w*|\bwaiv\w*|\bclass action\b|\bjury trial\b|\bindemnif\w*|\bnon-?compete\b|\bnon-?disclosure\b|\bnda\b|\bfee\b|\bdeposit\b|\bbackground (?:check|screening)\b|\bdrug (?:test|screen)\w*\b|\bcredit check\b|\bpolygraph\b|\brelocat\w*|\bat-?will\b|\bterminat\w*/i;

/** Evidence items the pre-filter may offer per row, and how many the Noul pass may keep. */
export const MAX_EVIDENCE = 12;
export const KEEP_EVIDENCE = 6;
/** Rendered text candidates per row. An option control's candidates are the form's own labels. */
export const MAX_TEXT_CANDIDATES = 5;
/**
 * The longest option list an answer may be *inferred* from. A 197-option country select and a
 * 282-option one are lookups, not inferences: the value is either stated on file (the exact stage
 * matched it, or it did not) and picking one of 282 from evidence is a guess wearing a citation.
 */
export const MAX_OPTIONS = 12;
/** Rows one posting may infer. Keeps both requests inside the vendor's token cap without a split. */
export const MAX_ROWS = 12;
/** One evidence item's text, clipped. The state carries text, so this is what bounds the request. */
const EVIDENCE_CHARS = 220;

const text = (v) => (v == null ? "" : String(v));
const clip = (s, n) => (text(s).length > n ? `${text(s).slice(0, n - 1)}…` : text(s));
const oneLine = (s) => text(s).replace(/\s+/g, " ").trim();

const optionLabelsOf = (q) => (q?.options ?? []).map((o) => text(o?.label ?? o)).filter(Boolean);

// ─── which rows the tier may reach ────────────────────────────────────────────────────────────

/** An employment-history or prior-application question: whose history it is about decides. */
const EMPLOYMENT_HISTORY_RE =
  /\b(?:previously|ever|formerly|in the past|before)\b[^?]{0,60}\b(?:employ|work|contract|intern|appl(?:y|ied)|interview)\w*|\b(?:employ|work|contract|intern|appl(?:y|ied)|interview)\w*[^?]{0,40}\b(?:before|previously|in the past)\b/i;
/** A question about somebody who is not the candidate: a reference, a relative, a referrer. */
const THIRD_PARTY_RE =
  /\b(?:reference'?s?|referee'?s?|referrer'?s?|emergency contact'?s?|next of kin|spouse'?s?|partner'?s?|relative'?s?|family member'?s?|friend'?s?|colleague'?s?|manager'?s?|supervisor'?s?)\b[^?]{0,40}\b(?:name|email|phone|title|company|employer|number|contact)/i;

/**
 * An attestation by its wording, whatever class it landed in. `classify()` splits two
 * near-identical one-box "Acknowledge" controls on one real form into `policy_gate` and
 * `company_specific` (Twilio, `bench/fresh-postings.yml`), so reading the class alone would let
 * the tier tick the half that missed the gate rule. Signing is the user's, and which branch of a
 * classifier a checkbox fell down does not change that.
 */
const ATTESTATION_RE =
  /\bi (?:agree|acknowledge|certify|confirm|consent|understand|attest|declare)\b|\b(?:acknowledg|consent|attest)\w*\b|\bi have read\b|\bby (?:checking|clicking|submitting|signing)\b|\bterms\b|\bpolicy\b|\bnotice\b/i;
/** A one-box control whose only option *is* the signature ("Acknowledge", "I agree"). */
const SIGNATURE_OPTION_RE = /^(?:i\s+)?(?:acknowledge|agree|confirm|consent|understand|accept)\b/i;

/** Is this row a signature the user gives, whatever class it carries? */
function attestationRow(label, options) {
  return ATTESTATION_RE.test(label) || (options.length <= 2 && options.some((option) => SIGNATURE_OPTION_RE.test(option)));
}

/**
 * May this row be inferred? `null` means yes; a string is the reason it may not, which is kept on
 * the row's own `why` so a refusal is legible in `decisions.json` rather than silent.
 *
 * Two actions reach here. An `ask` is the obvious one. A `skip` does too, but only the kind that
 * says `optional — no <something> on file`: that is the same sentence as an `ask`'s, wearing an
 * optional field, and 5 of the 54 rows this tier exists for were exactly that (an optional
 * preferred-name box beside the stated full name). A row skipped for any other reason — a
 * dependency its parent closed, a preference that says don't — is left alone.
 */
export function inferBlocked(d, q, { context = {}, mem = null } = {}) {
  if (!d) return "no row";
  if (d.action === "skip" && (d._dep_saved || !/^optional — no\b/.test(text(d.why)))) return "skipped for a reason of its own";
  if (d.action !== "ask" && d.action !== "skip") return "not an open ask";
  const label = text(d.label ?? q?.label);
  const klass = text(d.class ?? q?.class);
  if (klass === "sensitive") return PRONOUN_ROW_RE.test(label) ? "a pronoun is stated, never inferred" : "a protected characteristic is never inferred";
  if (!INFER_CLASSES.has(klass)) return `class ${klass || "(none)"} is not inferable`;
  if (q?.repeat) return "a history entry's part is read from that entry or asked, never inferred";
  if (d.parts || d.autofill_conflicts || d.topic === "work_location") return "missing stated details cannot be supplied by inference";
  if (q?.type === "file" || q?.control === "file" || d.source === "document") return "a file row is attached, never inferred";
  if (THIRD_PARTY_RE.test(label)) return "this asks about somebody other than you";
  if (EMPLOYMENT_HISTORY_RE.test(label) && !asksAboutThisEmployer(label, context.company) && !employersNamed(label, context.company)) {
    return "this asks about another organisation, not about this company";
  }
  const options = optionLabelsOf(q);
  if (klass === "policy_gate" || attestationRow(label, options)) {
    const slug = policySlug(label);
    if (!STANDARD_ACK_SLUGS.has(slug)) return `${slug} is not a standard acknowledgement — only you can sign it`;
    if (SPECIFIC_OBLIGATION_RE.test(label)) return `${slug} commits you to something specific — only you can sign it`;
    if (standardAcks(mem, context) !== "Yes") return `no ${STANDARD_ACKS_ID} stance on file`;
  }
  if (options.length > MAX_OPTIONS) return `${options.length} options — too long a list to infer an answer from`;
  // The premise of the tier is a question the runner *understood*: it knew what was being asked
  // and had no key for it. A row whose subject the tier cannot name is the other case, and three
  // of them were reached on the real bench before this line existed — a "have you ever been hired
  // through us as a third party?", a "please double-check the information above" confirmation and
  // a "which technical domain do you prefer?" — each proposed out of whatever saved rows happened
  // to share a word with the label, under the neutral justification. Ranking noise is not
  // evidence, so a nameless row stays the user's question.
  if (!inferTopic(d, q)) return "the tier cannot name what this row asks about";
  return null;
}

/** The user's blanket acknowledgement stance, scope-resolved: `"Yes"`, `"No"` or null. */
function standardAcks(mem, context = {}) {
  const pref = mem ? resolvePreference(mem, STANDARD_ACKS_ID, { company: context.company, role_family: context.role_family }) : null;
  return pref ? yesNoOf(pref.value) : null;
}

// ─── topics ───────────────────────────────────────────────────────────────────────────────────
// The deterministic pass already names what it failed to answer (`d.topic`: how_heard, in_office,
// previously_employed, …), so the tier reads that first and only falls back to its own label rules
// for the topics no earlier rule claims. A row with no topic is still inferable — the evidence
// pre-filter is generic — but a *rendered text* candidate needs to know what it is rendering.

const TOPIC_RULES = [
  [/preferred\s+(?:first\s+)?name|^nick\s*name/i, "preferred_name"],
  [/(?:how|where) did you (?:hear|find|learn)|how were you referred|referral source|hear about/i, "how_heard"],
  [/\byears\b[^?]{0,30}\b(?:experience|working|worked)\b|\bhow many years\b|\byears of\b/i, "years_experience"],
  [/in[- ]?office|in[- ]?person|on[- ]?site|onsite|hybrid|days? (?:a|per) week|commut|anchor days/i, "in_office"],
  [/relocat|willing to move|where (?:would|will) you (?:be )?work|work location|based in|location preference/i, "work_location"],
  [/previously (?:been )?employed|ever (?:been )?employed|worked (?:at|for)|applied (?:to|for)/i, "previously_employed"],
  [/start date|available to start|notice period|earliest (?:start|availability)/i, "start_date"],
];

/** The topic this row is about, for the candidate templates. `null` = option list only. */
export function inferTopic(d, q) {
  const label = text(d?.label ?? q?.label);
  if (text(d?.class ?? q?.class) === "policy_gate") return "policy_ack";
  const known = text(d?.topic);
  if (known && known !== "policy") return known === "applied_before" ? "previously_employed" : known;
  return TOPIC_RULES.find(([re]) => re.test(label))?.[1] ?? null;
}

// ─── evidence ─────────────────────────────────────────────────────────────────────────────────

/**
 * The memory ids each topic's answer is *actually* read out of, boosted so they survive the
 * pre-filter even when the row's wording shares no words with them ("Are you comfortable with our
 * anchor days?" shares nothing with `p.relocation`). This is ranking, never answering: a boosted
 * item is still judged by the Noul pass, still has to carry the proposal, and still has to hold up
 * under the justification.
 */
const TOPIC_EVIDENCE = Object.freeze({
  how_heard: [/^pipeline\./, /^posting$/, /^p\.how_heard$/],
  in_office: [/^p\.in_office$/, /^p\.relocation$/, /^p\.looking_for$/, /^f\.identity\.(?:city|location)$/, /^posting$/],
  work_location: [/^p\.relocation$/, /^p\.looking_for$/, /^f\.identity\.(?:city|location)$/, /^posting$/],
  years_experience: [/^f\.employment\./, /^f\.education\./, /^f\.skill\./],
  previously_employed: [/^f\.employment\./, /^pipeline\./, /^posting$/],
  preferred_name: [/^f\.identity\.(?:full_name|first_name|preferred_name)$/],
  start_date: [/^p\.notice_rule$/, /^f\.identity\.start_date$/, /^f\.availability$/],
  policy_ack: [new RegExp(`^${STANDARD_ACKS_ID.replace(/\./g, "\\.")}$`), /^p\.legal\./],
});

const STOP_WORDS = new Set([
  "about", "above", "after", "again", "all", "also", "and", "any", "applicant", "application", "apply", "are", "been",
  "being", "below", "between", "both", "but", "can", "candidate", "company", "did", "does", "doing", "each", "following",
  "for", "from", "have", "how", "into", "just", "like", "many", "may", "more", "most", "not", "now", "one", "only",
  "other", "our", "out", "over", "own", "please", "position", "role", "same", "select", "should", "some", "such", "than",
  "that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "through", "under", "until", "use",
  "very", "was", "were", "what", "when", "where", "which", "while", "who", "why", "will", "with", "would", "you", "your",
]);

const tokens = (s) =>
  new Set(
    text(s)
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );

const overlap = (a, b) => {
  let n = 0;
  for (const w of a) if (b.has(w)) n += 1;
  return n;
};

/** One memory row → an evidence item, with its `since:`/`until:` stated rather than implied. */
function memoryItem(row, kind) {
  const id = text(row?.id ?? row?.qid);
  if (!id) return null;
  const dates = [row?.since ? `since ${row.since}` : "", row?.until ? `until ${row.until}` : ""].filter(Boolean).join(", ");
  const body = oneLine(row?.title ? `${row.title} — ${itemText(row)}` : itemText(row));
  if (!body) return null;
  return { id, kind, text: clip(dates ? `${body} (${dates})` : body, EVIDENCE_CHARS), tags: questionTags(row) };
}

/**
 * How this application reached this posting's form, as evidence. Two readings, both of them facts
 * about the run rather than claims about the user: the pipeline's own record of the posting when
 * the scan found it, and — always — the board the form is being filled on, which for a hosted
 * Greenhouse/Ashby board *is* the company's own jobs listing. That is what answers "how did you
 * hear about us?" with the company's own careers page instead of an ask.
 */
function provenanceItem(formPlan, pipeline, context) {
  const url = text(formPlan?.url);
  const company = text(context?.company) || "this company";
  const board = text(formPlan?.ats) || "the company's board";
  const entry = (pipeline?.jobs ?? []).find((job) => {
    const known = text(job?.url).replace(/\/application\/?$/, "").replace(/\/$/, "");
    return known && url.replace(/\/application\/?$/, "").replace(/\/$/, "").startsWith(known);
  });
  const found = entry ? ` The pipeline recorded this exact posting as found on ${entry.found ?? "an earlier scan"} from ${company}'s own ${entry.provider ?? board} board, status ${entry.status ?? "found"}.` : "";
  return {
    id: entry ? `pipeline.${entry.id}` : "posting.source",
    kind: "provenance",
    text: clip(
      `This application is being filled on ${company}'s own hosted ${board} job board (${url || "the posting's application page"}) —` +
        ` the posting was reached on the company's own careers/jobs listing, not through a recruiter, an aggregator, an advertisement or a referral.${found}`,
      EVIDENCE_CHARS + 120,
    ),
    tags: ["How did the candidate find this posting?", "Where did the candidate hear about this company?"],
  };
}

/** The posting itself: title, location and company, which is evidence about the *role*. */
function postingItem(formPlan, context) {
  const job = formPlan?.job ?? {};
  const bits = [job.title, job.location, job.office, context?.country ? `country ${context.country}` : ""].filter(Boolean);
  return {
    id: "posting",
    kind: "posting",
    text: clip(`The posting: ${text(job.company ?? context?.company)} — ${bits.join(" · ")}${job.remote ? " · listed as remote" : ""}.`, EVIDENCE_CHARS),
    tags: ["What role is this posting for?", "Where is this posting located?"],
  };
}

/** Topics whose evidence may *only* be the ids named for them — no wording overlap admitted. */
const CLOSED_EVIDENCE = new Set(["policy_ack"]);

/**
 * Every item the tier may ever cite for this posting, built once: the posting's rows do not change
 * between questions, and each item's tokens are what the ranking compares against, so building the
 * pool per row would re-tokenise the whole store once per open question.
 *
 * Demographic rows are dropped outright — nothing in `p.eeo` is evidence for a non-demographic
 * answer, and the tier never answers a demographic one.
 */
export function evidencePool({ mem, pipeline = null, formPlan = null, context = {} }) {
  const items = [];
  const push = (item) => {
    if (item && !items.some((seen) => seen.id === item.id)) items.push(item);
  };
  for (const row of mem?.facts ?? []) if (!sensitiveMemoryRow(row)) push(memoryItem(row, "fact"));
  for (const row of mem?.preferences ?? []) if (!sensitiveMemoryRow(row)) push(memoryItem(row, "preference"));
  for (const row of mem?.answers ?? []) {
    if (sensitiveMemoryRow(row) || row?.kind === "never") continue;
    const kind = /^q\.core\.(first_name|last_name|full_name|preferred_name)$/.exec(row.qid ?? "")?.[1];
    const stated = kind && getFact(mem, `f.identity.${kind}`);
    // Stated identity outranks an old derived answer, regardless of its source-id spelling.
    if (stated && row.source !== "user" && String(row.value) !== String(stated.value)) continue;
    push(memoryItem(row, "answer"));
  }
  for (const row of usableStories(mem)) if (!sensitiveMemoryRow(row)) push(memoryItem(row, String(row?.kind ?? "story")));
  if (formPlan) {
    push(provenanceItem(formPlan, pipeline, context));
    push(postingItem(formPlan, context));
  }
  // `index` is the tie-break, so a pool built from the same store always ranks the same way.
  return items.map((item, index) => ({ ...item, index, words: tokens(`${item.tags.join(" ")} ${item.text}`), tagWords: tokens(item.tags.join(" ")) }));
}

/**
 * ≤`MAX_EVIDENCE` candidate items for one row, deterministically ordered: the topic's own ids
 * first, then whatever the row's wording overlaps with. A standard acknowledgement takes the
 * closed list and nothing else: the whole point of `policy_gate_source` is that a signature has
 * exactly one warrant.
 */
export function evidenceFor({ q, d, topic = null, mem, pipeline = null, formPlan = null, context = {}, pool = null }) {
  const label = text(d?.label ?? q?.label);
  const asked = tokens(`${label} ${text(q?.help)}`);
  const boosts = TOPIC_EVIDENCE[topic] ?? [];
  const closed = CLOSED_EVIDENCE.has(topic);
  const items = pool ?? evidencePool({ mem, pipeline, formPlan, context });

  return items
    .map((item) => {
      const at = boosts.findIndex((re) => re.test(item.id));
      const boost = at >= 0 ? 100 - at : 0;
      const score = closed ? boost : boost + overlap(asked, item.tagWords) * 3 + overlap(asked, item.words);
      return { item, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.item.index - b.item.index)
    .slice(0, MAX_EVIDENCE)
    .map((row) => ({ id: row.item.id, kind: row.item.kind, text: row.item.text }));
}

// ─── candidate values ─────────────────────────────────────────────────────────────────────────

/** Years between the earliest `since:` among `rows` and now, floored — never rounded up. */
function yearsFrom(rows, now) {
  const stamps = rows.map((row) => parseSince(row?.since)).filter(Boolean);
  if (!stamps.length) return null;
  const earliest = stamps.reduce((a, b) => (a < b ? a : b));
  const years = (now.getTime() - earliest.getTime()) / (365.2425 * 24 * 60 * 60 * 1000);
  return years < 0 ? null : Math.floor(years);
}

/**
 * Words that qualify *experience* rather than naming a subject. "How many years of professional
 * experience?" asks about every role on file; "how many years of Rust?" asks about the Rust ones,
 * and with none on file the row has no candidate and stays the user's question.
 */
const GENERIC_EXPERIENCE_RE =
  /^(?:year|years|experience|experiences|working|worked|work|professional|total|overall|relevant|full|part|time|industry|paid|commercial|post|graduation|career|engineering|software|technical|do|does|much|least|minimum)$/i;

/**
 * The `since:`-carrying facts a "years of X" row is about: the ones whose own words name the X it
 * asks about, and every employment row when the label names no X at all ("years of professional
 * experience"). Nothing is inferred here — the dates are the user's own.
 */
function experienceRows(mem, label) {
  const dated = (mem?.facts ?? []).filter((row) => row?.since && /^f\.(?:employment|education|skill)\./.test(text(row.id)));
  const asked = [...tokens(label)].filter((w) => !GENERIC_EXPERIENCE_RE.test(w));
  if (!asked.length) return dated.filter((row) => text(row.id).startsWith("f.employment."));
  const hits = dated.filter((row) => {
    const hay = `${text(row.id)} ${itemText(row)} ${(row.topics ?? []).join(" ")}`.toLowerCase();
    return asked.some((w) => hay.includes(w));
  });
  return hits.length ? hits : [];
}

/**
 * The year counts a "how many years" row may take, most authoritative first.
 *
 * `fullTimeYears()` is the repo's existing derivation and the one `CANON_RULES`'
 * `experience.years_total` reads, so where it can answer it answers here too — one rule, not a
 * second convention beside it. It only counts a fact that *says* it is full-time, and a store
 * written from a real CV says no such thing about any row, which is exactly why that canonical
 * question never fires on the real profile. The second candidate is the span the user's own
 * `since:` dates describe — from their earliest saved role to today, floored — which is a reading
 * of the evidence rather than a stored number, and the selector picks between the two.
 */
function experienceCandidates(mem, label, now) {
  const rows = experienceRows(mem, label);
  const out = [];
  const add = (n) => {
    if (n != null && n > 0 && !out.some((c) => c.value === String(n))) out.push({ value: String(n) });
  };
  const stated = Math.floor(fullTimeYears(mem, now));
  if (stated > 0) add(stated);
  add(yearsFrom(rows, now));
  return out;
}

/** The pronouns/name/text values a short box can take for this topic, rendered from evidence. */
function textCandidates({ topic, mem, context, formPlan, now }) {
  const out = [];
  const add = (value) => {
    const v = oneLine(value);
    if (v && !out.includes(v)) out.push(v);
  };
  if (topic === "preferred_name") {
    const stated = getFact(mem, "f.identity.preferred_name") ?? getFact(mem, "f.identity.first_name");
    if (stated) {
      add(factText(stated)?.text);
      return out;
    }
    const full = getFact(mem, "f.identity.full_name");
    const parts = text(factText(full)?.text).split(/\s+/).filter(Boolean);
    if (parts.length >= 2) add(nameSplit(parts).first);
    else if (parts.length === 1) add(parts[0]);
  } else if (topic === "how_heard") {
    const company = text(context?.company);
    if (company) add(`${company} careers page`);
    add("Company website / careers page");
  } else if (topic === "years_experience") {
    // The same two readings a number control gets, plus the "<n> years" wording a text box wants.
    for (const { value } of experienceCandidates(mem, "", now)) {
      add(value);
      add(`${value} years`);
    }
  } else if (topic === "work_location") {
    const job = formPlan?.job ?? {};
    if (job.location) add(text(job.location));
    const place = getFact(mem, "f.identity.city") ?? getFact(mem, "f.identity.location");
    if (place) add(text(factText(place)?.text));
  } else if (topic === "start_date") {
    const rule = noticeRule(mem, { company: context?.company, role_family: context?.role_family });
    if (rule?.text) add(text(rule.text));
  }
  return out.slice(0, MAX_TEXT_CANDIDATES);
}

/**
 * What Jev may pick between for this row. Options come from the form; a number, a date and a short
 * text box get values computed or rendered from the evidence. An empty list leaves the row an ask:
 * there is nothing to select, and Jev never writes one.
 */
export function candidatesFor({ q, d, topic = null, mem, context = {}, formPlan = null, now = new Date() }) {
  const options = optionLabelsOf(q);
  if (options.length) return options.slice(0, MAX_OPTIONS).map((label) => ({ value: label, option: label }));
  const control = text(q?.control ?? d?.control);
  const type = text(q?.type);
  if (control === "date" || type === "date") {
    const date = startDate(mem, { company: context.company, role_family: context.role_family }, now);
    return date ? [{ value: date.value }] : [];
  }
  if (type === "number" && topic === "years_experience") return experienceCandidates(mem, text(d?.label ?? q?.label), now);
  if (type === "number") return [];
  return textCandidates({ topic, mem, context, formPlan, now }).map((value) => ({ value }));
}

// ─── the justification sentence ───────────────────────────────────────────────────────────────
// Jev selects; nobody writes prose about the user. The one line the user reads next to a `check`
// is composed here from the topic, the chosen value and the evidence ids — it states which reading
// was made, so a wrong inference is legible at a glance rather than plausible.
//
// Every sentence is a function of the *chosen value*, because a reading that holds for one answer
// does not hold for its opposite: "your history names no role at this company" is the account of a
// No and a falsehood beside a Yes. Where the chosen value does not fit the reading, the neutral
// sentence is used — an inference is allowed to be unexplained, never misexplained.

const NEUTRAL = "your own saved material states what this row asks for";

const JUSTIFICATIONS = {
  how_heard: () => "this application was reached on the company's own job board, so the company's own careers listing is how it was found",
  in_office: (v) =>
    yesNoOf(v) === "No" ? NEUTRAL : "your stated relocation and location preferences accept this posting's place, so working from its office is covered by them",
  work_location: () => "your stated location preferences accept this posting's place",
  years_experience: () => "counted from the `since:` dates of your own saved roles",
  previously_employed: (v) =>
    yesNoOf(v) === "Yes"
      ? "your saved employment history names a role at this company"
      : yesNoOf(v) === "No"
        ? "your saved employment history names other employers and no role at this company"
        : NEUTRAL,
  preferred_name: () => "the given name of the full name you stated",
  start_date: () => "your stated notice rule",
  policy_ack: (v) =>
    yesNoOf(v) === "No" ? NEUTRAL : `you accept the standard application acknowledgements automatically (${STANDARD_ACKS_ID})`,
};

const justificationFor = (topic, value) => JUSTIFICATIONS[topic]?.(value) ?? NEUTRAL;

/** `inferred — <justification> (evidence: a, b)` — what ► INFERRED and ► CHECK both print. */
export function inferredWhy(topic, evidence, value) {
  const ids = evidence.map((e) => e.id).join(", ");
  return `inferred — ${justificationFor(topic, value)}${ids ? ` (evidence: ${ids})` : ""}`;
}

// ─── stage 0: an inference this store already made ────────────────────────────────────────────

/** The `answers` qid an inferred answer is filed under, so the next form reads it back. */
export const inferredQid = (topic) => `q.inferred.${topic}`;

/** Topics whose answer is about one company and must not be reused on another board. */
const COMPANY_SCOPED = new Set(["previously_employed", "policy_ack", "how_heard"]);

const scopeFor = (topic, context) =>
  COMPANY_SCOPED.has(topic) && context?.company_slug ? `company:${context.company_slug}` : "global";

/** Does a saved correction forbid reusing this inference? A correction outranks every inference. */
function corrected(mem, context, topic) {
  const qid = inferredQid(topic);
  return applicableCorrections(mem, { company: context?.company, role_family: context?.role_family }).some((row) => {
    const rule = text(row?.rule).toLowerCase();
    return rule.includes(qid) || rule.includes(`inferred ${topic}`) || rule.includes(topic.replace(/_/g, " "));
  });
}

/**
 * An inference this store already made and persisted, replayed without a model. This is what makes
 * the tier cheap on the second form: the answer was justified once, it is filed under its topic
 * with the questions it answers, and a matching row on the next board fills from it directly.
 *
 * Still a `check`, never a `fill` — an inferred answer is shown before Submit on every form it
 * reaches, not only the one it was inferred on. A row the user has since corrected
 * (`scripts/remember.mjs` writes `source: user` over the same qid, or a `corrections` row naming
 * it) answers from their own statement instead.
 */
export function storedInference(mem, { q, d, topic, context = {} }) {
  if (!topic || corrected(mem, context, topic)) return null;
  const qid = inferredQid(topic);
  const rows = (mem?.answers ?? []).filter((row) => row?.qid === qid);
  const wanted = scopeFor(topic, context);
  const row = rows.find((r) => text(r.scope) === wanted) ?? rows.find((r) => text(r.scope || "global") === "global");
  if (!row || row.value == null) return null;

  const options = optionLabelsOf(q);
  let option = null;
  if (options.length) {
    const want = normalizeOption(text(row.value));
    option = options.find((label) => normalizeOption(label) === want) ?? null;
    if (!option) return null; // this board spells it differently — infer it again rather than guess
  }
  const user = isUserSourced(row);
  const evidence = Array.isArray(row.inference?.evidence) ? row.inference.evidence : [];
  return {
    source: user ? "answer" : "inferred",
    value: option ?? text(row.value),
    ...(option ? { option } : {}),
    action: "check",
    topic: d?.topic ?? topic,
    why: user
      ? `you answered this before (${qid})`
      : `inferred — ${justificationFor(topic, option ?? text(row.value))}; saved from an earlier application (evidence: ${evidence.join(", ") || qid})`,
    inference: {
      topic,
      evidence,
      justified: typeof row.inference?.justified === "number" ? row.inference.justified : 1,
      replayed: true,
      ...(user ? { corrected_by_user: true } : {}),
    },
  };
}

// ─── the two requests ─────────────────────────────────────────────────────────────────────────

const evidenceId = (qid, index) => `bears_${qid}__${index}`;
const proposalId = (qid) => `pick_${qid}`;
const justifyId = (qid) => `just_${qid}`;

/**
 * Request 1 — every row's evidence Nouls and its proposal Choice in one call.
 *
 * Both judgements are self-contained: each Noul quotes the item it judges and the question it
 * judges it against *inside its own instructions*, so no question refers to something only the
 * shared state could resolve. That is the postmortem's lesson about the earlier model-judged
 * framework, and it is also what makes a trace row readable on its own.
 */
export function proposeRequest(rows, { formPlan = null } = {}) {
  const state = { job: jobState(formPlan), rows: {} };
  const questions = {};
  for (const row of rows) {
    const { d, q, evidence, candidates } = row;
    state.rows[d.qid] = {
      question: text(d.label ?? q?.label),
      ...(q?.help ? { help: clip(oneLine(q.help), 300) } : {}),
      control: text(q?.control ?? q?.type),
      evidence: evidence.map((e) => ({ id: e.id, text: e.text })),
    };
    evidence.forEach((item, index) => {
      questions[evidenceId(d.qid, index)] = noul(
        `The form asks this candidate: "${oneLine(text(d.label ?? q?.label))}". One saved item reads: "${item.text}". ` +
          "Does that item bear on that question for this candidate — is it something a careful reader would cite when working out the answer?",
        { true: "The item bears on the question", false: "The item is about something else" },
      );
    });
    const criteria = {};
    for (const candidate of candidates) criteria[clip(candidate.value, 180)] = candidateCriterion(candidate, d, q);
    if (Object.keys(criteria).length < 1) continue;
    questions[proposalId(d.qid)] = choice(
      `Using only the evidence listed under \`rows.${d.qid}.evidence\`, which of these is this candidate's answer to "${oneLine(text(d.label ?? q?.label))}"? ` +
        "Pick a value only if the evidence states it or directly entails it; otherwise pick none_of_these.",
      withNone(criteria, "The evidence does not settle this question; ask the user"),
    );
  }
  return { state, questions };
}

const candidateCriterion = (candidate, d, q) =>
  candidate.option
    ? `The form's own option "${clip(candidate.option, 140)}" is the answer.`
    : `The answer to state in this ${text(q?.control ?? q?.type) || "field"} is "${clip(candidate.value, 140)}".`;

const jobState = (formPlan) => ({
  company: text(formPlan?.job?.company),
  title: text(formPlan?.job?.title),
  location: text(formPlan?.job?.location),
  ats: text(formPlan?.ats),
});

/**
 * Request 1's answers → each row's kept evidence and proposed value. Nothing is committed here:
 * the row carries a proposal and goes to the justification, or it stays an `ask`.
 */
export function applyProposals(rows, answers) {
  for (const row of rows) {
    const { d, evidence } = row;
    const kept = evidence
      .map((item, index) => ({ item, noul: answers[evidenceId(d.qid, index)]?.noul }))
      .filter((e) => typeof e.noul === "number" && e.noul >= GATES.noulSelect)
      .sort((a, b) => b.noul - a.noul)
      .slice(0, KEEP_EVIDENCE);
    row.kept = kept.map((e) => e.item);
    if (!row.kept.length) {
      row.refused = "nothing on file bears on this question";
      continue;
    }
    const answer = answers[proposalId(d.qid)];
    if (!answer) {
      row.refused = "no proposal came back for this row";
      continue;
    }
    if (answer.choice === NONE) {
      row.refused = "your saved material does not settle this question";
      continue;
    }
    if (typeof answer.confidence !== "number" || answer.confidence < GATES.askBelow) {
      row.refused = `the proposal was too uncertain (${round(answer.confidence)})`;
      continue;
    }
    const picked = row.candidates.find((candidate) => clip(candidate.value, 180) === answer.choice);
    if (!picked) {
      row.refused = "the proposed value is not one of this form's own values";
      continue;
    }
    row.proposal = picked;
    row.confidence = round(answer.confidence);
  }
}

/**
 * Request 2 — one Noul per proposed row: "do these evidence items, taken together, justify this
 * exact answer for this candidate?" The evidence **text** is in the state and in the instructions;
 * the model is never asked to judge a reference it cannot read.
 */
export function justifyRequest(rows) {
  const state = { rows: {} };
  const questions = {};
  for (const row of rows) {
    if (!row.proposal) continue;
    const { d, q, kept, proposal } = row;
    const question = oneLine(text(d.label ?? q?.label));
    state.rows[d.qid] = {
      question,
      proposed_answer: proposal.option ?? proposal.value,
      evidence: kept.map((e) => ({ id: e.id, text: e.text })),
    };
    questions[justifyId(d.qid)] = noul(
      `A form asks this candidate: "${question}". The proposed answer is "${clip(proposal.option ?? proposal.value, 160)}". ` +
        `The evidence is exactly this: ${kept.map((e, i) => `(${i + 1}) ${e.text}`).join(" ")} ` +
        "Do those evidence items, taken together, justify that exact answer for this candidate? Say no if the answer needs anything they do not state.",
      { true: "The evidence justifies that exact answer", false: "The evidence does not justify it; the candidate must answer" },
    );
  }
  return { state, questions };
}

/**
 * Request 2's answers → the Decision. At or above `GATES.inferBelow` the row becomes a `check`
 * sourced `inferred`; below it the row is an `ask` again, carrying the reason.
 */
export function applyJustifications(rows, answers) {
  for (const row of rows) {
    if (!row.proposal) continue;
    const verdict = answers[justifyId(row.d.qid)]?.noul;
    if (typeof verdict !== "number") {
      row.refused = "the justification check could not be reached";
      continue;
    }
    if (verdict < GATES.inferBelow) {
      row.refused = `the evidence did not justify the answer (${round(verdict)})`;
      continue;
    }
    row.justified = round(verdict);
    commit(row);
  }
}

/** The one place an inferred row is written onto the Decision. Always `check`, never `fill`. */
function commit(row) {
  const { d, proposal, kept, topic } = row;
  d.source = "inferred";
  d.action = "check";
  d.value = proposal.option ?? proposal.value;
  if (proposal.option) d.option = proposal.option;
  if (topic && !d.topic) d.topic = topic;
  d.why = inferredWhy(topic, kept, d.value);
  d.inference = {
    topic: topic ?? null,
    evidence: kept.map((e) => e.id),
    candidates: row.candidates.length,
    confidence: row.confidence ?? null,
    justified: row.justified,
  };
  delete d.remember_as;
  delete d._open;
}

const round = (n) => (typeof n === "number" ? Number(n.toFixed(3)) : null);

// ─── the pass ─────────────────────────────────────────────────────────────────────────────────

/** One Jev call, with its request and its response appended to `applications/<slug>/trace.jsonl`. */
async function askJev({ stage, state, questions, slug, signal, totals }) {
  await appendTrace(slug, { op: "jev_request", stage, state, questions });
  const result = await systemOne({ state, questions, signal });
  await appendTrace(slug, {
    op: "jev_response",
    stage,
    model: result.model,
    ms: result.ms,
    requests: result.requests,
    usage: result.usage,
    answers: result.answers,
  });
  totals.requests += result.requests;
  totals.ms += result.ms;
  totals.usage.input_tokens += result.usage?.input_tokens ?? 0;
  totals.usage.output_tokens += result.usage?.output_tokens ?? 0;
  totals.stages.push(stage);
  return result.answers;
}

/**
 * The evidence tier over one posting's plan. Mutates nothing: a new decision list comes back.
 *
 * @param {{formPlan:object, decisions:object[], mem:object, context:object, slug?:string,
 *          pipeline?:object|null, now?:Date, signal?:AbortSignal,
 *          ask?:Function}} args `ask` is the transport seam — the default is the real Jev call.
 * @returns {Promise<{decisions:object[], requests:number, ms:number, usage:object, stages:string[],
 *                    inferred:object[], refused:object[]}>}
 */
export async function inferRows({ formPlan, decisions, mem, context = {}, slug = null, pipeline = null, now = new Date(), signal, ask = askJev }) {
  const byQid = new Map((formPlan?.questions ?? []).map((q) => [q.qid, q]));
  const out = decisions.map((d) => ({ ...d }));
  const totals = { requests: 0, ms: 0, usage: { input_tokens: 0, output_tokens: 0 }, stages: [] };
  const rows = [];
  const refused = [];
  // One pool for the posting: the store does not change between its questions.
  const pool = evidencePool({ mem, pipeline, formPlan, context });

  for (const d of out) {
    const q = byQid.get(d.qid) ?? null;
    const blocked = inferBlocked(d, q, { context, mem });
    if (blocked) {
      if (d.action === "ask" || d.action === "skip") refused.push({ qid: d.qid, why: blocked });
      continue;
    }
    const topic = inferTopic(d, q);

    // Stage 0 — an inference this store already made, replayed with no model at all.
    const stored = storedInference(mem, { q, d, topic, context });
    if (stored) {
      Object.assign(d, stored);
      delete d.remember_as;
      delete d._open;
      continue;
    }

    const evidence = evidenceFor({ q, d, topic, context, pool });
    if (!evidence.length) {
      refused.push({ qid: d.qid, why: "nothing on file bears on this question" });
      continue;
    }
    const candidates = candidatesFor({ q, d, topic, mem, context, formPlan, now });
    if (!candidates.length) {
      refused.push({ qid: d.qid, why: "no candidate value could be built from the evidence" });
      continue;
    }
    rows.push({ d, q, topic, evidence, candidates });
    if (rows.length >= MAX_ROWS) break;
  }

  if (!rows.length) return { decisions: out, ...totals, inferred: [], refused };

  const propose = proposeRequest(rows, { formPlan });
  applyProposals(rows, await ask({ stage: "infer_propose", ...propose, slug, signal, totals }));

  const toJustify = rows.filter((row) => row.proposal);
  if (toJustify.length) {
    const justify = justifyRequest(toJustify);
    applyJustifications(toJustify, await ask({ stage: "infer_justify", ...justify, slug, signal, totals }));
  }

  for (const row of rows) {
    if (row.d.source === "inferred") continue;
    refused.push({ qid: row.d.qid, why: row.refused ?? "the tier reached no answer" });
    row.d.why = `${row.d.why} — ${row.refused ?? "nothing inferable"}`;
  }

  return {
    decisions: out,
    ...totals,
    inferred: rows.filter((row) => row.d.source === "inferred").map((row) => ({ qid: row.d.qid, topic: row.topic, evidence: row.d.inference.evidence, justified: row.d.inference.justified })),
    refused,
  };
}

// ─── persistence ──────────────────────────────────────────────────────────────────────────────

/**
 * The `answers` rows an inferred plan leaves behind, so the next form answers the same question
 * from the store instead of paying for two more requests. `source: "inferred"` is what keeps them
 * subordinate: `mergeSection` lets a `source: user` row overwrite one and never the other way
 * round, which is how `scripts/remember.mjs` corrects an inference permanently.
 *
 * Only a row that *was* inferred on this run is written; a replayed one is already on file.
 */
export function inferredMemoryRows(decisions, context = {}) {
  const rows = [];
  for (const d of decisions ?? []) {
    if (d?.source !== "inferred" || !d.inference || d.inference.replayed) continue;
    const topic = d.inference.topic;
    if (!topic) continue;
    const qid = inferredQid(topic);
    if (rows.some((row) => row.qid === qid)) continue;
    rows.push({
      qid,
      kind: "company",
      scope: scopeFor(topic, context),
      value: text(d.option ?? d.value),
      source: "inferred",
      updated: stamp(),
      answers_questions: [oneLine(text(d.label))],
      topics: [topic.replace(/_/g, " ")],
      inference: { evidence: d.inference.evidence ?? [], justified: d.inference.justified ?? null, label: clip(oneLine(text(d.label)), 120) },
    });
  }
  return rows;
}

/** Write those rows. Never called on a dry run — a dry run touches no user data. */
export async function persistInferred(decisions, context = {}) {
  const rows = inferredMemoryRows(decisions, context);
  const saved = [];
  for (const row of rows) {
    await upsertRow("answers", row);
    saved.push(row.qid);
  }
  return { saved };
}

/** Every inferred row on a plan, for the summary and the preflight. */
export const inferredRows = (decisions) => (decisions ?? []).filter((d) => d?.source === "inferred");
