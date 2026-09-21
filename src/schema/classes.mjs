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
// policy_gate list is fixed by PLAN §2.2 step 3 / the O1 scan (private/o1-candidates.md §Method).
export const POLICY_GATE_RE =
  /AI Policy|use of AI|AI tools|AI-generated|artificial intelligence|refrain from using any AI|attest|arbitrat|consent/i;

// EEO / demographic vocabulary. Matched against the label only: EEO boilerplate turns up in
// unrelated help text, and Greenhouse's own EEO blocks are forced to `sensitive` by section.
export const SENSITIVE_RE =
  /\b(gender|racial|race|ethnic(?:ity)?|hispanic|latin[oax]|veteran|disabilit|sexual orientation|transgender|pronouns?|lgbtq|eeo|equal (?:employment )?opportunity|demographic|protected (?:veteran|class)|self[- ]identif|date of birth|marital status|religio)/i;

// Name qualifiers stack ("Preferred First Name"), so the prefix group repeats. "current … employer"
// needs a possessive ("your current or most recent employer") so that "bound by agreements with a
// current or former employer" stays a circumstance question rather than an identity fact.
export const IDENTITY_RE =
  /^(?:(?:first|last|legal|preferred|full|middle|given|family|nick)\s+)*names?\b|\be-?mail\b|\bphone\b|\bresum[ée]\b|\bcv\b|cover letter|linked-?in|git-?hub|google scholar|\btwitter\b|\bportfolio\b|personal (?:web)?site|\bwebsite\b|\bweb page\b|\bblog\b|^(?:(?:your|current|candidate)\s+)*(?:location|city|address|country)\b|\b(?:legal|home|mailing|street) address\b|^where are you (?:currently )?(?:located|based)|^current (?:company|employer|job ?title|title|role|position)\b|(?:your|the) current(?: or (?:most|more) recent)?\s+(?:employer|company|job ?title|title|role|position)|^pronunciation/i;

export const WHY_US_RE =
  /^\s*why\b(?!.*\b(?:did|leave|left|should we)\b)|\bwhy (?:do|would) you want to (?:work|join)\b|\bwhat (?:interests|excites|draws|attracts) you\b/i;

// Situation questions: everything the memory answers from facts/preferences rather than writing.
// `\breferr` is anchored: without the boundary it fires inside "Preferred First Name".
export const CIRCUMSTANCE_RE =
  /legally authorized|authoriz(?:ed|ation) to work|work authoriz|right to work|sponsor|visa|h-?1b|immigration|citizen|relocat|willing to (?:work|travel|commute|move)|open to (?:working|work|relocat|travel|commut|mov)|in[- ]?office|in[- ]?person|on[- ]?site|onsite|hybrid|\bremote\b|office locations?|prefer to be based|days? (?:a|per) week|times? (?:a|per) week|time ?zone|commut|start date|available to start|when (?:can|could) you start|notice period|salary|compensation|pay expectation|expected (?:pay|salary)|currently (?:reside|live|located|based)|based in|previously (?:applied|worked|interviewed|employed)|ever (?:applied|interviewed|worked|been employed)|interviewed (?:at|with)|applied (?:to|for)[^?]{0,40}before|worked (?:at|for)[^?]{0,40}before|(?:how|where) did you (?:hear|find|learn)|\breferr|graduat|18 years|security clearance|\bclearance\b|non-?compete|restrictive|bound by any agreement|government employee|post-government|years of experience|how many years/i;

/**
 * classify(label, help, type, required) → FormPlan `class`.
 * Order matters: EEO first (never answered), then attestations, then the identity/narrative
 * split, then situation questions; anything unrecognised is `company_specific` → ask.
 */
export function classify(label, help = "", type = "text", required = false) {
  const name = cleanLabel(label);
  const body = `${name} ${htmlToText(help)}`;
  if (SENSITIVE_RE.test(name)) return "sensitive";
  if (POLICY_GATE_RE.test(body)) return "policy_gate";
  if (IDENTITY_RE.test(name)) return "identity";
  if (WHY_US_RE.test(name)) return "why_us";
  if (CIRCUMSTANCE_RE.test(body)) return "circumstance";
  if (type === "textarea") return required ? "essay" : "optional_text";
  if (!required && (type === "text" || type === "url")) return "optional_text";
  return "company_specific";
}

// —— conditional follow-ups ————————————————————————————————————————
// "If yes, please provide further explanation below." / "If you selected a response to the prior
// question other than …" — both ATSs express a conditional child as a plain row right after its
// parent select, with no machine-readable link (PLAN §2.2 step 9).
const DEPENDENCY_RE = /^\s*if\s+(?:you\s+)?(yes|no|so|selected|answered|applicable)\b/i;
const PARENT_TYPES = new Set(["single_select", "multi_select", "boolean"]);

/** dependencyOn(row, previous) → {parent, condition} | null. `previous` is the row just emitted. */
export function dependencyOn(row, previous) {
  const m = DEPENDENCY_RE.exec(row.label);
  if (!m || !previous || !PARENT_TYPES.has(previous.type)) return null;
  return { parent: previous.qid, condition: m[1].toLowerCase() === "no" ? "no" : "yes" };
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
