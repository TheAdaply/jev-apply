// What a saved résumé actually says, for choosing between several of them per posting
// (`resumeStage`, src/jev/plan.mjs). Read from the PDF itself, not from the stories onboarding kept:
// those skip the summary and the skills section, which are exactly where tailored résumés differ.
//
// Nothing here is written by a model. Lines are the user's own text, and this is the one place in
// the tree where a *document's* own words leave the machine without the user having saved them as
// an answer — so the filter is the strict one: contact lines go, and so does every line that reads
// as a personal detail rather than as career content. A CV written outside the US puts a postal
// address, a date of birth, a marital status and a nationality in its header as a matter of course,
// and none of them says anything about which résumé fits a posting. The file's own name never
// leaves either: `resumeStage` labels each criterion `r0`, `r1`, … (docs/research/24-review-pr2.md
// §0.2 — in the wild the file name is usually the user's full name).
//
// The drop rules are heuristics over prose and are meant to over-drop: a career line lost from the
// digest costs a little ranking, a personal line kept costs the user their address.

import { readFile, stat } from "node:fs/promises";

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE = /(?:^|\s)\+?\d[\d\s().-]{7,20}\d(?:\s|$)/;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b(?:github|gitlab|linkedin|twitter|x)\.com\/\S+/i;
// A street line ("221B Baker Street", "Flat 4, 12 Park Road"), or a town-and-postcode line
// ("San Francisco, CA 94110", "London SW1A 1AA", "Bengaluru, Karnataka 560001"). The postcode
// shapes are read case-sensitively and the six-digit one only at the end of a line, because
// case-folded they also spell ordinary CV text ("v2 3rd party", "processed 250000 rows").
const STREET =
  /\b\d{1,6}[a-z]?\b[^,]{0,40}\b(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|court|ct|place|pl|way|walk|close|crescent|terrace|apartment|apt|suite|ste|unit|flat|floor|block|sector|colony|nagar|marg)\b/i;
const POSTCODE = /\b[A-Z]{2} \d{5}(?:-\d{4})?\b|\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b|\b\d{6}\s*$/;
const POSTCODE_LABEL = /\b(?:postal code|post code|pin code|zip(?: code)?)\b/i;
const DOB = /\b(?:date of birth|d\.?o\.?b\.?|birth ?date|born on|year of birth)\b/i;
const MARITAL = /\b(?:marital status|maritalstatus|married|unmarried|divorced|widow(?:ed|er)?)\b/i;
const NATIONALITY = /\b(?:nationality|citizenship|citizen of|passport (?:no|number|details)?|visa status|residency status)\b/i;
const PERSONAL = [EMAIL, PHONE, URL_RE, STREET, POSTCODE, POSTCODE_LABEL, DOB, MARITAL, NATIONALITY];
const BULLET = /^[-*•‣·—–▪◦●]\s*/;
// The page separator pdf-parse inserts between pages ("-- 1 of 2 --").
const PAGE_MARK = /^-*\s*\d+\s+of\s+\d+\s*-*$/i;

const lineKey = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** A résumé's text → its content lines, in order: trimmed, de-bulleted, no personal lines, no repeats. */
export function profileLines(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim().replace(BULLET, "");
    if (line.length < 3 || PAGE_MARK.test(raw.trim()) || PERSONAL.some((re) => re.test(line))) continue;
    const key = lineKey(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/** The lines of one résumé that none of the others contain — what makes it the tailored one. */
export function distinctiveLines(own, others) {
  const shared = new Set(others.flat().map(lineKey));
  return own.filter((line) => !shared.has(lineKey(line)));
}

/**
 * One résumé as a Jev criterion: the label the caller gave it and what only it says, most of the
 * budget spent on the distinctive lines. A résumé with nothing of its own says so, which is what
 * lets Jev answer "none fits better" instead of splitting hairs between two copies.
 *
 * `label` is the criterion's own key (`r0`, `r1`, …), never the file's name: the name is the one
 * part of a résumé that is reliably the user's own, and Jev is choosing between texts, not files.
 */
export function resumeDigest(label, own, others, max = 1200) {
  const unique = distinctiveLines(own, others);
  const body = unique.length ? unique.join(" · ") : "(same content as the other résumés)";
  const text = `${label}: ${body}`;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Keyed by path and mtime, so an edited résumé re-reads itself. Bounded because the key grows with
// every save: a CLI run touches two or three résumés, but this module is ordinary enough to end up
// inside something long-lived, and an unbounded Map of parsed CVs is a slow leak of the user's own
// documents. Oldest key out first — `Map` iterates in insertion order.
const CACHE_MAX = 16;
const cache = new Map();

/** The content lines of the PDF at `file`, cached per path and modification time. */
export async function resumeLines(file) {
  const { mtimeMs } = await stat(file);
  const key = `${file}\u0000${mtimeMs}`;
  if (cache.has(key)) return cache.get(key);
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: await readFile(file) });
  try {
    const lines = profileLines((await parser.getText())?.text ?? "");
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, lines);
    return lines;
  } finally {
    await parser.destroy?.();
  }
}
