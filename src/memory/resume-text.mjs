// What a saved résumé actually says, for choosing between several of them per posting
// (`resumeStage`, src/jev/plan.mjs). Read from the PDF itself, not from the stories onboarding kept:
// those skip the summary and the skills section, which are exactly where tailored résumés differ.
//
// Nothing here is written by a model. Lines are the user's own text; contact lines are dropped so
// only career content is ever compared.

import { readFile, stat } from "node:fs/promises";

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE = /(?:^|\s)\+?\d[\d\s().-]{7,20}\d(?:\s|$)/;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b(?:github|gitlab|linkedin|twitter|x)\.com\/\S+/i;
const BULLET = /^[-*•‣·—–▪◦●]\s*/;
// The page separator pdf-parse inserts between pages ("-- 1 of 2 --").
const PAGE_MARK = /^-*\s*\d+\s+of\s+\d+\s*-*$/i;

const lineKey = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** A résumé's text → its content lines, in order: trimmed, de-bulleted, no contact lines, no repeats. */
export function profileLines(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim().replace(BULLET, "");
    if (line.length < 3 || PAGE_MARK.test(raw.trim()) || EMAIL.test(line) || PHONE.test(line) || URL_RE.test(line)) continue;
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
 * One résumé as a Jev criterion: its file name and what only it says, most of the budget spent on
 * the distinctive lines. A résumé with nothing of its own says so, which is what lets Jev answer
 * "none fits better" instead of splitting hairs between two copies.
 */
export function resumeDigest(name, own, others, max = 1200) {
  const unique = distinctiveLines(own, others);
  const body = unique.length ? unique.join(" · ") : "(same content as the other résumés)";
  const text = `${name}: ${body}`;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

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
    cache.set(key, lines);
    return lines;
  } finally {
    await parser.destroy?.();
  }
}
