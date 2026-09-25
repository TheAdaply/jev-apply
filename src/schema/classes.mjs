// Question classification + limit parsing + the HTML/label text helpers the two ATS
// normalizers share. Leaf module: imports nothing from the rest of src/schema.
//
// `class` decides how the planner treats a field (PLAN §2.2 step 4):
//   identity        name/email/phone/links/résumé/current location  → facts
//   circumstance    work auth, sponsorship, relocation, in-office, start date, salary, …
//   essay           required free-text prompt → writer/draft path
//   why_us          "why <company>" / "why do you want to work here" → writer, one user sentence
//   company_specific unknown question that only this company asks → ask
//   policy_gate     AI-usage / attestation / arbitration / consent → ask, never answered globally
//   sensitive       EEO / demographic → skip unless a global EEO preference exists
//   optional_text   optional free text with no prompt ("Additional information")

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "\u2013",
  mdash: "\u2014", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
  hellip: "\u2026", middot: "\u00b7", bull: "\u2022", deg: "\u00b0", eacute: "\u00e9",
};

const ENTITY_RE = /&(#x?[0-9a-f]+|[a-z]+);/gi;
const BLOCK_RE = /<\/(?:p|div|li|h[1-6]|tr|blockquote)>|<br\s*\/?>/gi;
const TAG_RE = /<[^>]*>/g;

/** Decode the named/numeric HTML entities Greenhouse and Ashby actually emit. */
export function decodeEntities(s) {
  if (!s || s.indexOf("&") === -1) return s || "";
  return s.replace(ENTITY_RE, (all, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    const hit = ENTITIES[body.toLowerCase()];
    return hit === undefined ? all : hit;
  });
}

/**
 * HTML (possibly entity-escaped twice, as Greenhouse `content` is) → plain text.
 * Block-level tags become newlines so a description keeps its paragraph structure.
 */
export function htmlToText(html) {
  if (!html) return "";
  const once = decodeEntities(String(html));
  const text = decodeEntities(once.replace(BLOCK_RE, "\n").replace(TAG_RE, " "));
  return text.replace(/[ \t\u00a0]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Label → single line: entities decoded, tags dropped, whitespace collapsed, trailing `*` removed. */
export function cleanLabel(s) {
  return htmlToText(s).replace(/\s+/g, " ").replace(/\s*\*$/, "").trim();
}

// —— class regexes ————————————————————————————————————————————————
// policy_gate list is fixed by PLAN §2.2 step 3 / the O1 scan (private/o1-candidates.md §Method),
// plus the acknowledgement vocabulary the round-1 judgement caught being answered from the answer
// bank (docs/research/12-eval-judge-round1.md §3.1): "Please review and acknowledge …Candidate
// Privacy Policy" and "I understand that …offers are conditional on …a background check" both
// classified `company_specific`, so `resolveQuestion`'s policy branch never saw them and a canonical
// `q.legal.*` row ticked a legal attestation on the user's behalf. A signed statement is answered
// from one explicit standing preference (`p.legal.<slug>`) or it is asked — never inferred.
export const POLICY_GATE_RE =
  /AI Policy|use of AI|AI tools|AI-generated|artificial intelligence|refrain from using any AI|attest|arbitrat|consent|acknowledg|\bi understand\b|\bi agree\b|\bi certify\b|privacy (?:policy|notice|statement)|background (?:check|screening)|terms of (?:use|service)/i;

// EEO / demographic vocabulary. Matched against the label only: EEO boilerplate turns up in
// unrelated help text, and Greenhouse's own EEO blocks are forced to `sensitive` by section.
//
// A pronouns row is spelled once, here: the EEO branch that routes it to `f.identity.pronouns`
// (`src/plan/resolve.mjs`) and the evidence tier that refuses to infer it (`src/plan/infer.mjs`)
// read this same constant, so the three cannot drift apart again.
export const PRONOUN_ROW_RE = /\bpronouns?\b/i;
export const SENSITIVE_RE = new RegExp(
  `\\b(gender|racial|race|ethnic(?:ity)?|hispanic|latin[oax]|veteran|disabilit|sexual orientation|transgender|${PRONOUN_ROW_RE.source}|lgbtq|eeo|equal (?:employment )?opportunity|demographic|protected (?:veteran|class)|self[- ]identif|date of birth|marital status|religio)`,
  "i",
);

// …and the labels that name those characteristics only to say they are **not** asking for them.
// 1Password's box reads "Other than your ethnicity, gender, and disability status (survey below),
// is there anything you would like to share with us, or information to help us accommodate you?"
// — `SENSITIVE_RE` claimed it on the word "disability", `eeoMapFor()` found the disability map and
// the canonical self-identification sentence was typed into the textarea, under a question that
// had explicitly asked for anything *other* than that (docs/research/13-eval-judge-round2.md §3
// N1). A label that defers the protected characteristics to another control is not a demographic
// field.
export const DEFERS_SENSITIVE_RE =
  /\b(?:other than|apart from|aside from|besides|excluding|not including|in addition to)\b[^?]{0,90}\b(?:survey|section|question|questions|below|above|form)\b/i;

// …and the labels that name a protected characteristic only to *offer* the candidate the right to
// take it off their own materials. Snowflake's required checkbox ("you may redact or remove
// age-identifying information … you will not be penalized") is not a demographic question at all:
// nothing is being asked about the user, there is an acknowledgement to sign, and `SENSITIVE_RE`
// claimed it on the word "age" and then refused it through the EEO decline stance — a right
// outcome reached for a wrong reason, and one that stayed unanswerable even after the user stated
// a preference (docs/research/17-eval-judge-ten2.md §3 F6). It is a `policy_gate`, answered from
// the explicit `p.legal.age_redaction_ack` the user states and from nothing else.
export const REDACTION_OFFER_RE =
  /\b(?:you may|feel free to|are (?:free|welcome|entitled) to)\b[^?]{0,90}\bredact\b|\bredact or remove\b|\bnot be penali[sz]ed\b[^?]{0,90}\bredact/i;

// An accommodation / adjustment **request**. Answered from one standing `p.accommodation` the user
// stated and from nothing else — a demographic value is never an accommodation — so it is routed
// to the resolver's circumstance pass rather than left as an unrecognised free-text prompt.
//
// Narrow on purpose, in two directions. The word alone is not enough: Lyft asks the required
// "Can you perform these essential functions of the job with reasonable accommodation?"
// (corpus/greenhouse/applied_scientist/lyft-8402813002.json), and answering *that* from a saved
// `p.accommodation: "No"` would tell the employer the candidate cannot do the job. So the label
// has to ask whether one is *needed*, or be about the hiring process itself, and a question about
// performing the role's essential functions is excluded outright — it is a screening question
// about the work, and it stays the user's to answer.
//
// Tested after `POLICY_GATE_RE`, because an AI-usage attestation may mention accommodations in
// passing ("unless you've made prior arrangements … for specific needs or accommodations") and is
// still an attestation.
export const ACCOMMODATION_RE =
  /\b(?:need|needs|needed|require|requires|required|request|requesting|any|special|describe)\b[^?]{0,40}\baccommodat\w*|\baccommodat\w*[^?]{0,40}\b(?:process|interview|hiring|recruit\w*|application|assessment|testing)\b|\b(?:reasonable )?adjustments?\b[^?]{0,40}\b(?:process|interview|hiring|recruit\w*|assessment)\b|\bhelp (?:us )?accommodate you\b/i;

/** Screening questions about doing the *job*, which merely mention the word. Never accommodation rows. */
export const ESSENTIAL_FUNCTIONS_RE = /\bperform\b[^?]{0,40}\bessential functions\b/i;

/** Does this label ask whether the user needs an accommodation for the hiring process? */
export function isAccommodationRequest(label) {
  const text = cleanLabel(label);
  return ACCOMMODATION_RE.test(text) && !ESSENTIAL_FUNCTIONS_RE.test(text);
}

// Name qualifiers stack ("Preferred First Name"), so the prefix group repeats. "current … employer"
// needs a possessive ("your current or most recent employer") so that "bound by agreements with a
// current or former employer" stays a circumstance question rather than an identity fact. The three
// location phrasings at the end are the ones real boards ask in (judge §3.6): Figma's "From where do
// you intend to work?" and DeepL's "What is your current city and country of residence?" both
// classified `company_specific` while the location fact sat on file.
//
// One box asking for *several* links ("Social Network and Web Links") is the same identity row
// wearing a textarea: the saved `f.identity.*` link facts are exactly what it asks for, and
// classing it `optional_text` is what let d-matrix's row be skipped as "no saved item answers it"
// while three of them sat on file (docs/research/17-eval-judge-ten2.md §3 F7).
export const IDENTITY_RE =
  /^(?:(?:first|last|legal|preferred|full|middle|given|family|nick)\s+)*names?\b|\be-?mail\b|\bphone\b|\bresum[ée]\b|\bcv\b|cover letter|linked-?in|git-?hub|google scholar|\btwitter\b|\bportfolio\b|personal (?:web)?site|\bwebsite\b|\bweb page\b|\bblog\b|\b(?:social(?: network| media)?|web|online|profile|relevant)\s+links?\b|^(?:(?:your|current|candidate)\s+)*(?:location|city|address|country)\b|\b(?:legal|home|mailing|street) address\b|where are you (?:currently )?(?:located|based)|where do you (?:currently )?(?:intend|plan|expect|want|wish) to (?:work|be based|live)|(?:city|town) and (?:country|state)|^current (?:company|employer|job ?title|title|role|position)\b|(?:your|the) current(?: or (?:(?:most|more) recent|previous|last|former|past))?\s+(?:employer|company|job ?title|title|role|position)|^pronunciation/i;

export const WHY_US_RE =
  /^\s*why\b(?!.*\b(?:did|leave|left|should we)\b)|\bwhy (?:do|would) you want to (?:work|join)\b|\bwhat (?:interests|excites|draws|attracts) you\b/i;

// Situation questions: everything the memory answers from facts/preferences rather than writing.
// `\breferr` is anchored: without the boundary it fires inside "Preferred First Name".
// `u.s. person` is here because an export-control status row is a question about the user's
// citizenship whether or not it spells the word out ("Which of the following best describes your
// U.S. person status?"), and it has to reach the resolver's circumstance pass to be answered from
// `f.citizenship` at all (docs/research/17-eval-judge-ten2.md §3 F2). The attestation beside it
// ("I have read and understand the Export Control statement") names no person category and is
// untouched by this: it stays the `ask` the policy-gate invariant puts it on.
export const CIRCUMSTANCE_RE =
  /legally (?:authoriz|eligib|permitt|entitl)\w*|authoriz(?:ed|ation) to work|eligible to work|work (?:authoriz|eligib)\w*|right to work|sponsor|visa|h-?1b|immigration|citizen|u\.?\s?s\.? person|relocat|willing to (?:work|travel|commute|move)|open to (?:working|work|relocat|travel|commut|mov)|in[- ]?office|in[- ]?person|on[- ]?site|onsite|hybrid|\bremote\b|office locations?|prefer to be based|days? (?:a|per) week|times? (?:a|per) week|time ?zone|commut|start date|available to start|when (?:can|could) you start|notice period|salary|compensation|pay expectation|expected (?:pay|salary)|currently (?:reside|live|located|based)|based in|previously (?:applied|worked|interviewed|employed)|ever (?:applied|interviewed|worked|been employed)|interviewed (?:at|with)|applied (?:to|for)[^?]{0,40}before|worked (?:at|for)[^?]{0,40}before|(?:how|where) did you (?:hear|find|learn)|\breferr|graduat|18 years|security clearance|\bclearance\b|non-?compete|restrictive|bound by any agreement|government employee|post-government|years of experience|how many years/i;

// A prompt whose answer is a **datum about the user** — which languages they speak, which tools
// they use, how many years of something, their salary, notice, start date, location, visa or
// citizenship status. It is a short answer they state, not prose anybody can compose, so it is a
// `circumstance` row wherever it lands and never an `essay`/`optional_text` the writer may fill.
//
// The ten-posting round (private/eval-shots/ten/findings.md) is why this exists: Mistral's
// required textarea "What spoken languages are you fluent in?" was classed `essay` — a textarea
// with a question mark — handed to the writer, and answered on the live form from a GPU-inference
// story that says nothing about languages. A fact is asked or it is not answered (AGENTS.md).
//
// Deliberately narrow on the generic openers: it matches "what is your", not "what's your", so
// the same form's genuine essay prompt ("What's your most complex project with LLM?") stays an
// essay, and `list`/`name` need the possessive/article that a request for an enumeration carries.
export const FACT_SEEKING_RE =
  /\b(?:spoken|programming|natural|foreign|human)\s+languages?\b|\blanguages?\b[^?]{0,30}\b(?:fluent|speak|proficien\w*)\b|\bfluent\b|\bproficien\w*\b|\bwhich\b[^?]{0,24}\b(?:tools?|frameworks?|languages?|libraries|technologies)\b|\bhow many\b|\byears of\b|\bwhat is your\b|\blist (?:the|your|all)\b|\bname (?:the|your)\b|\bsalary\b|\bnotice period\b|\bstart date\b|\bcitizenship\b|\bvisa\b/i;

/** The controls whose fallback class is prose (`essay`/`optional_text`) and must yield to a fact. */
const PROSE_TYPES = new Set(["text", "textarea"]);

/**
 * classify(label, help, type, required) → FormPlan `class`.
 * Order matters: EEO first (never answered), then attestations, then the identity/narrative
 * split, then situation questions, then the fact-seeking prompts wearing a prose control;
 * anything unrecognised is `company_specific` → ask.
 */
export function classify(label, help = "", type = "text", required = false) {
  const name = cleanLabel(label);
  const body = `${name} ${htmlToText(help)}`;
  if (REDACTION_OFFER_RE.test(name)) return "policy_gate";
  if (SENSITIVE_RE.test(name) && !DEFERS_SENSITIVE_RE.test(name)) return "sensitive";
  if (POLICY_GATE_RE.test(body)) return "policy_gate";
  if (isAccommodationRequest(name)) return "circumstance";
  if (IDENTITY_RE.test(name)) return "identity";
  if (WHY_US_RE.test(name)) return "why_us";
  if (CIRCUMSTANCE_RE.test(body)) return "circumstance";
  // A free-text box asking for a datum is a short-answer fact, never prose: it resolves from
  // memory or it is asked, and the writer is never offered it (findings.md, Mistral).
  if (PROSE_TYPES.has(type) && FACT_SEEKING_RE.test(name)) return "circumstance";
  if (type === "textarea") return required ? "essay" : "optional_text";
  if (!required && (type === "text" || type === "url")) return "optional_text";
  return "company_specific";
}

// —— conditional follow-ups ————————————————————————————————————————
// "If yes, please provide further explanation below." / "If you responded "yes" to the question
// above…" / a bare "Please explain." — both ATSs express a conditional child as a plain row right
// after its parent select, with no machine-readable link (PLAN §2.2 step 9).
//
// The verb list and the quoted token are what the round-1 judgement caught missing
// (docs/research/12-eval-judge-round1.md §3.3): 1Password writes `If you responded "yes" above…`
// and `If you responded "other" above…`, neither of which the old `yes|no|so|selected|answered|
// applicable` list matched, so both children were never linked to a parent and the answer bank
// filled them — one under a parent answered **No**, one under a parent nobody had answered at all.
//
// Three shapes are recognised, in order: a condition token (optionally quoted and behind a verb),
// a bare verb ("If you selected a response other than …", polarity unknown), and a label that *is*
// the follow-up ("Please explain."). The last one is deliberately narrow — it must be the whole
// label — so that an ordinary prompt ("Please describe your ideal team") is not swallowed.
const DEP_VERB = "(?:answered|responded|replied|indicated|selected|chose|chosen|checked|said|marked|stated)";
const DEP_TOKEN = "(?:yes|no|so|other|applicable|any|above)";
const DEP_LEAD = `^\\s*if\\s+(?:you\\s+(?:have\\s+|are\\s+|had\\s+)?)?`;
const DEPENDENCY_RE = new RegExp(
  `${DEP_LEAD}(?:${DEP_VERB}\\s*)?["'\u201c\u2018]?(${DEP_TOKEN})\\b` +
    `|${DEP_LEAD}(${DEP_VERB})\\b` +
    `|^\\s*(?:please\\s+)?(explain|elaborate|provide (?:further |additional |more )?(?:detail|details|explanation))\\b[^?.]{0,25}[?.]?\\s*$`,
  "i",
);
const PARENT_TYPES = new Set(["single_select", "multi_select", "boolean"]);

/**
 * dependencyOn(row, previous) → {parent, condition} | null. `previous` is the row just emitted.
 * `condition` is the token the child states, normalised: `yes` (also "so", and a bare "Please
 * explain." child, whose explanation is what an affirmative answer owes) · `no` · the literal token
 * for anything else (`other`, `applicable`, `selected`, …). `src/plan/resolve.mjs
 * conditionPolarity()` reads it back; a token it cannot turn into a polarity leaves the row alone
 * unless the parent is unanswered.
 */
export function dependencyOn(row, previous) {
  if (!previous || !PARENT_TYPES.has(previous.type)) return null;
  const label = String(row.label ?? "").replace(/^\s*\(?optional\)?\s*[:—-]?\s*/i, "");
  const lead = /^\s*if\b([^,?]+)/i.exec(label)?.[1]?.toLowerCase();
  const named = lead && !/\b(?:other than|not|except)\b/i.test(lead)
    ? (previous.options ?? []).map((o) => String(o.label ?? o).toLowerCase()).filter((option) => option && (` ${lead.replace(/["“”']/g, " ")} `).includes(` ${option} `))
    : [];
  if (named.length) return { parent: previous.qid, condition: named[0], ...(named.length > 1 ? { anyOf: named } : {}) };
  const m = DEPENDENCY_RE.exec(label);
  if (!m) return null;
  const token = (m[1] ?? m[2] ?? (m[3] ? "yes" : "")).toLowerCase();
  const condition = token === "no" ? "no" : token === "so" || token === "" ? "yes" : token;
  return { parent: previous.qid, condition };
}

// —— limit parsing ————————————————————————————————————————————————
// Phrasings observed across the 127-posting corpus (private/o1/):
//   "great answers are often 200-400 words."   "In 100 words or less, tell us about a…"
//   "one paragraph, 200 words max."            "Please answer in less than 200 words"
const LIMIT_RULES = { words: buildRules("words?"), chars: buildRules("(?:characters?|chars?)") };

function buildRules(unit) {
  return [
    [new RegExp(`(\\d{2,5})\\s*(?:-|\u2013|\u2014|to)\\s*(\\d{2,5})\\s*${unit}\\b`, "i"), 2],
    [new RegExp(`(?:in|under|within|less than|fewer than|no more than|at most|up to|max(?:imum)?(?:\\s+of)?|\u2264|<=?)\\s*(\\d{1,5})\\s*${unit}\\b`, "i"), 1],
    [new RegExp(`(\\d{1,5})\\s*${unit}\\b\\s*(?:or (?:less|fewer)|max(?:imum)?|limit)`, "i"), 1],
    [new RegExp(`(\\d{2,5})\\s*${unit}\\b`, "i"), 1],
  ];
}

function limitFor(text, unit) {
  for (const [re, group] of LIMIT_RULES[unit]) {
    const m = re.exec(text);
    if (m) return Number(m[group]);
  }
  return undefined;
}

/** parseLimits(label, help, maxlength) → {chars?, words?} | undefined (never an empty object). */
export function parseLimits(label, help = "", maxlength) {
  const text = `${cleanLabel(label)} ${htmlToText(help)}`;
  const words = limitFor(text, "words");
  let chars = limitFor(text, "chars");
  if (chars === undefined && Number.isFinite(maxlength) && maxlength > 0) chars = maxlength;
  if (words === undefined && chars === undefined) return undefined;
  const limits = {};
  if (chars !== undefined) limits.chars = chars;
  if (words !== undefined) limits.words = words;
  return limits;
}

/** Words in a piece of text, the way a recruiter counts them. */
export function wordCount(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Does this answer fit what the field asks for? `parseLimits` reads the limit off the form's own
 * words ("In 100 words or less"), and round 1 committed a 140-word answer into that field because
 * nothing ever compared the two (docs/research/12-eval-judge-round1.md §3.11). Over the limit is
 * never truncated — a half sentence is worse than a long one — so the caller picks a shorter
 * variant, asks the writer for a shorter draft, or surfaces the row before Submit.
 * @returns {{ok:boolean, over?:"words"|"chars", count?:number, limit?:number}}
 */
export function fitsLimits(text, limits) {
  const body = String(text ?? "");
  if (!limits || !body.trim()) return { ok: true };
  if (Number.isFinite(limits.words)) {
    const count = wordCount(body);
    if (count > limits.words) return { ok: false, over: "words", count, limit: limits.words };
  }
  if (Number.isFinite(limits.chars) && body.length > limits.chars) {
    return { ok: false, over: "chars", count: body.length, limit: limits.chars };
  }
  return { ok: true };
}

/**
 * The length variant to use for a field: the longest one that *fits* the stated limit, else the
 * shortest written (which the caller still checks — a field may be narrower than anything saved).
 * With no limit stated, the medium variant, which is what PLAN §2.7 caps at 150 words.
 */
export function pickVariant(variants, limits) {
  if (!variants) return null;
  const order = ["long", "medium", "short"].map((k) => variants[k]).filter((v) => typeof v === "string" && v.trim());
  if (!order.length) return null;
  if (!limits) return variants.medium ?? order[0];
  return order.find((text) => fitsLimits(text, limits).ok) ?? order[order.length - 1];
}

/** Keep the full prompt as well as its individual requests in every responsiveness judgment. */
export function promptClauses(prompt) {
  return String(prompt ?? "").split(/(?:[?;]\s*|\n+|\band\s+(?=(?:what|why|how|describe|explain|tell|which)\b))/i).map((s) => s.trim()).filter(Boolean);
}
