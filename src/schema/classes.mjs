// Mechanical schema hints only; semantic class is supplied by understandForm.
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

export function classify(_label, _help = "", type = "text", required = false) {
  if (type === "file") return "identity";
  return !required && type === "textarea" ? "optional_text" : "company_specific";
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
