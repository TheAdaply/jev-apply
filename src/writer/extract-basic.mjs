// Résumé → memory rows, with no model involved at all.
//
// `scripts/learn.mjs` normally hands the document to `extractResume()` (src/writer/openai.mjs),
// which is a model call. When there is no writer model — the `host` backend, i.e. jev-apply
// running inside Claude Code or Codex with only a Jev key — onboarding must still work, so this
// module handles explicit contact details, dated education/employment entries, and bullet lines
// under section headings.
//
// The rules it keeps are the product's rules, not a parser's:
//   * Names and prose come directly from the document. Explicit dates and employment types may be
//     converted to memory's canonical shape; unstated values are never defaulted. A fact this file
//     is unsure of is omitted, and the user is asked for it later like any other missing fact.
//   * A story is one bullet line, with the heading it sat under as its context. The title is the
//     question that bullet answers, built from the bullet's own words so it stays grounded.
//   * Row shapes, ids and `source` provenance are exactly `extractResume`'s, so a store topped up
//     by either route looks the same and the host can refine any row with `remember.mjs`.

/** Canonical identity ids (references/memory-format.md); the same set `extractResume` folds into. */
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
// Phone numbers as CVs print them: optional +, then 7–17 digits with spaces, dots, dashes or
// parentheses between them. Anchored on a digit run long enough that a date or a postcode cannot
// match, and validated on digit count afterwards.
const PHONE = /(\+?\d[\d\s().-]{7,20}\d)/;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()[\]{}"']+|(?:^|\s)((?:github|gitlab|linkedin|twitter|x)\.com\/[^\s<>()[\]{}"']+)/gi;

/** host → the identity row a link belongs on. A link that matches nothing becomes the site row. */
const LINK_IDS = [
  [/(^|\.)github\.com$/i, "f.identity.github_url"],
  [/(^|\.)gitlab\.com$/i, "f.identity.github_url"],
  [/(^|\.)linkedin\.com$/i, "f.identity.linkedin_url"],
  [/(^|\.)(twitter\.com|x\.com)$/i, "f.identity.x_twitter_url"],
  [/(^|\.)scholar\.google\.[a-z.]+$/i, "f.identity.publications_url"],
  [/(^|\.)orcid\.org$/i, "f.identity.publications_url"],
];

/** Lines that are the document's own title rather than the candidate's name. */
const DOC_TITLE = /^(resume|résumé|curriculum vitae|cv|personal details|contact)\b/i;

/** Section headings a CV uses for the material a story is made of. */
const STORY_HEADING =
  /^(work\s+)?(experience|employment|professional experience|career|projects?|selected projects?|open source|publications?|achievements?|highlights?|leadership|volunteering)\b/i;

/** Headings whose bullets are lists of nouns, not things that happened. */
const SKIP_HEADING = /^(skills?|technical skills|tools|technologies|languages|education|certifications?|interests|awards)\b/i;

const BULLET = /^[-*•‣·—–]\s+(.*\S)\s*$/;

/** An explicit `Location: Lisbon, Portugal` label, and the bare "City, Country" line under a name. */
const LOCATION_LABEL = /^(location|based in|address)\s*[:\u2013-]\s*(.+\S)\s*$/i;
const CITY_COUNTRY = /^[A-Z][\p{L}.'’-]+(?:\s[A-Z][\p{L}.'’-]+)*,\s[A-Z][\p{L}.'’-]+(?:\s[A-Z][\p{L}.'’-]+)*$/u;

const NAME_LINE = /^[\p{Lu}][\p{L}.'’-]*(?:\s+[\p{L}][\p{L}.'’-]*){0,4}$/u;

/** How many bullets one heading contributes. A CV's first bullets are the ones it leads with. */
const MAX_PER_HEADING = 6;
const MAX_STORIES = 24;

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function pagesOf(text, pages) {
  const list = (Array.isArray(pages) && pages.length ? pages : String(text ?? "").split(/\f/))
    .map((p) => String(p ?? "").trimEnd())
    .filter((p) => p.trim());
  if (!list.length) throw new Error("extractBasic: the document text is empty");
  return list;
}

/** Every line of the document, each tagged with the page it came from. */
function linesOf(pageList) {
  const out = [];
  pageList.forEach((page, i) => {
    for (const raw of page.split("\n")) out.push({ text: raw.replace(/\s+$/, ""), page: i + 1 });
  });
  return out;
}

function hostOf(url) {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function linkRows(lines) {
  const rows = [];
  for (const { text, page } of lines) {
    URL_RE.lastIndex = 0;
    for (const match of text.matchAll(URL_RE)) {
      const value = clean(match[0]).replace(/[),.;]+$/, "");
      if (!value) continue;
      const host = hostOf(value);
      if (!host) continue;
      const id = LINK_IDS.find(([re]) => re.test(host))?.[1] ?? "f.identity.site_url";
      rows.push({ id, value, page });
    }
  }
  return rows;
}

/**
 * The candidate's name: the first line of the document that reads like one. A CV that opens with
 * "RESUME" or a heading is skipped rather than guessed at, and a line carrying an address, an
 * email or a digit is not a name.
 */
function nameRow(lines) {
  for (const { text, page } of lines.slice(0, 8)) {
    const value = clean(text);
    if (!value || value.length > 60) continue;
    if (DOC_TITLE.test(value) || /[@\d|/]/.test(value)) continue;
    if (!NAME_LINE.test(value)) continue;
    if (!/\s/.test(value)) continue; // a single word is a heading more often than a full name
    return { id: "f.identity.full_name", value, page };
  }
  return null;
}

function locationRow(lines) {
  for (const { text, page } of lines.slice(0, 12)) {
    const value = clean(text);
    if (!value) continue;
    const labelled = value.match(LOCATION_LABEL);
    if (labelled) return { id: "f.identity.city", value: clean(labelled[2]), page };
  }
  for (const { text, page } of lines.slice(0, 8)) {
    const value = clean(text);
    if (value && value.length <= 48 && CITY_COUNTRY.test(value)) {
      return { id: "f.identity.city", value, page };
    }
  }
  return null;
}

function contactRow(lines, re, id, accept = () => true) {
  for (const { text, page } of lines) {
    const match = clean(text).match(re);
    if (!match) continue;
    const value = clean(match[1] ?? match[0]);
    if (!accept(value)) continue;
    return { id, value, page };
  }
  return null;
}

/** A phone number has 7–15 digits (E.164's ceiling); anything else was a date or an id. */
const looksLikePhone = (value) => {
  const digits = value.replace(/\D/g, "").length;
  return digits >= 7 && digits <= 15;
};

/**
 * The bullet lines under each section heading that describes work, as stories.
 * The heading itself is kept on the row's tags so `rankStories` and the writer can see it.
 */
function storyRows(lines, source, seen) {
  const stories = [];
  let heading = null;
  let perHeading = 0;
  for (const { text, page } of lines) {
    const value = clean(text);
    if (!value) continue;
    const bullet = value.match(BULLET);
    if (!bullet) {
      // A heading is a short line that is not itself a bullet or a sentence.
      if (value.length <= 48 && !/[.;]$/.test(value)) {
        if (STORY_HEADING.test(value)) {
          heading = value.replace(/[:\s]+$/, "");
          perHeading = 0;
        } else if (SKIP_HEADING.test(value)) {
          heading = null;
        }
      }
      continue;
    }
    if (!heading || perHeading >= MAX_PER_HEADING || stories.length >= MAX_STORIES) continue;
    const body = clean(bullet[1]);
    if (body.split(/\s+/).length < 5) continue; // a three-word bullet is a skill, not a story
    perHeading += 1;
    const slug = `${slugOf(heading)}_${perHeading}`;
    const id = uniqueId(`b.story.${slug}`, seen);
    stories.push({
      id,
      title: titleFor(body),
      text: body,
      tags: [slugOf(heading)].filter(Boolean),
      source: source(page),
    });
  }
  return stories;
}

/** Section headings a CV puts its degrees under. */
const EDUCATION_HEADING = /^(education|academic (background|qualifications?|history)|qualifications|degrees?)\b/i;

/** A line that names a degree — the anchor of one education entry. */
const DEGREE_RE =
  /\b(bachelor|master|doctor(?:ate)?|ph\.?\s?d|mba|associate(?:'s)? degree|diploma|b\.?\s?tech|m\.?\s?tech|b\.?\s?sc|m\.?\s?sc|b\.?\s?eng|m\.?\s?eng|b\.?\s?e\.?|m\.?\s?e\.?|b\.?\s?s\.?|m\.?\s?s\.?|b\.?\s?a\.?|m\.?\s?a\.?|b\.?\s?com|m\.?\s?com|bca|mca|llb|llm|md)(?=[\s,.(–—-]|$)/i;
const SCHOOL_LEAVING = /\b(high school|secondary|matriculation|hsc|ssc|cbse|icse|a[- ]levels?|gcse|o[- ]levels?|abitur|baccalaur[ée]at|class (?:x|xii|10|12)|(?:10|12)th (?:grade|standard|class))\b/i;

/** "2016 – 2020", "Aug 2016 - May 2020", "2022 – Present": the opening month and year are the start. */
const YEAR_RANGE = /(?:\b([A-Za-z]{3,9})\.?\s+)?\b((?:19|20)\d{2})\s*[–—-]\s*(?:[A-Za-z]{3,9}\.?\s+)?(?:(?:19|20)\d{2}|present|current|now)\b/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A range's start as `since:` — "YYYY-MM" when the month is printed, else the year alone. */
function rangeStart(range) {
  const month = range[1] ? MONTHS.indexOf(range[1].slice(0, 3).toLowerCase()) + 1 : 0;
  return month > 0 ? `${range[2]}-${String(month).padStart(2, "0")}` : range[2];
}

/**
 * The degrees under an Education heading, one row each (`f.education.<slug>`), newest-first order
 * left to `educationHistory()`. A CV prints an entry either on one line ("B.Tech, EEE — IIT Patna,
 * 2016–2020") or as a school line with the degree under it; the second shape is joined back into
 * the first with " — ", which is the separator `educationHistory()` reads the school after. Each
 * half is copied verbatim; a line this cannot place is left out, and the form asks for it.
 */
function educationRows(lines, source, seen) {
  const rows = [];
  let inside = false;
  let pending = null; // the school line an entry's degree line may follow
  for (const { text, page } of lines) {
    const raw = clean(text);
    if (!raw) continue;
    const value = clean(raw.match(BULLET)?.[1] ?? raw);
    const heading = value.length <= 48 && !/[.;]$/.test(value) && !DEGREE_RE.test(value);
    if (heading && EDUCATION_HEADING.test(value)) {
      inside = true;
      pending = null;
      continue;
    }
    if (heading && (STORY_HEADING.test(value) || SKIP_HEADING.test(value))) {
      inside = false;
      continue;
    }
    if (!inside) continue;
    if (SCHOOL_LEAVING.test(value)) {
      pending = null;
      continue;
    }
    if (!DEGREE_RE.test(value)) {
      pending = value.length <= 90 ? { value, page } : null;
      continue;
    }
    // The dates go last, in brackets, whichever line printed them: a range left inside the school
    // line would be read back as part of the school's name.
    const own = value.match(YEAR_RANGE);
    const other = pending?.value.match(YEAR_RANGE) ?? null;
    const range = own ?? other;
    const strip = (line) => clean(range ? line.replace(range[0], "").replace(/\(\s*\)/g, "").replace(/[,\s|·]+$/, "") : line);
    const joined = /\s[—–-]\s/.test(strip(value)) || !pending ? strip(value) : `${strip(value)} — ${strip(pending.value)}`;
    const dated = range ? `${joined} (${clean(range[0])})` : joined;
    const id = uniqueId(`f.education.${slugOf(value) || "degree"}`, seen);
    rows.push({ id, value: dated, ...(range ? { since: rangeStart(range) } : {}), source: source(page) });
    pending = null;
  }
  return rows;
}

/** Explicit title — company + date ranges under work headings; unplaced lines remain unknown. */
function employmentRows(lines, source, seen) {
  const rows = [];
  let inside = false;
  let last = null;
  let pending = null;
  for (const { text, page } of lines) {
    const value = clean(text);
    if (!value) continue;
    if (/^(?:(?:work|professional)\s+)?(?:experience|employment|work history|career)\s*:?\s*$/i.test(value) || /^work\s*:?\s*$/i.test(value)) {
      inside = true;
      last = pending = null;
      continue;
    }
    if (EDUCATION_HEADING.test(value) || SKIP_HEADING.test(value) || /^(?:projects?|publications?|volunteering)\s*:?\s*$/i.test(value)) {
      inside = false;
      last = pending = null;
    }
    if (!inside) continue;
    if (/^full[- ]time\b/i.test(value) && last) {
      if (!last.value.employment_type) last.value.employment_type = "full_time";
      continue;
    }
    const range = value.match(YEAR_RANGE);
    if (!range) {
      pending = !BULLET.test(value) && value.length <= 90 && !/[.!?]$/.test(value) ? { value, page } : null;
      continue;
    }
    const headline = clean(value.replace(range[0], "").replace(/\(\s*\)/g, "").replace(/[,\s|·]+$/, ""));
    const halves = headline.split(/\s+[—–-]\s+/);
    const role = halves.length === 2 ? halves[0] : pending && halves.length === 1 ? headline : null;
    const company = halves.length === 2 ? halves[1] : pending?.value;
    if (!role || !company || BULLET.test(value)) { pending = null; continue; }
    const end = range[0].split(/\s*[–—-]\s*/).at(-1);
    const current = /^(present|current|now)$/i.test(end);
    const closing = current ? null : end.match(/^(?:([A-Za-z]{3,9})\.?\s+)?((?:19|20)\d{2})$/);
    if (!current && !closing) { pending = null; continue; }
    last = {
      id: uniqueId(`f.employment.${slugOf(`${company}_${role}`)}`, seen),
      value: { company, role, ...(current ? { current: true } : { until: rangeStart(closing) }), ...(/\bintern(?:ship)?\b/i.test(role) ? { employment_type: "internship" } : {}) },
      since: rangeStart(range),
      source: source(page),
    };
    rows.push(last);
    pending = null;
  }
  return rows;
}

const slugOf = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);

function uniqueId(id, seen) {
  let unique = id;
  for (let n = 2; seen.has(unique); n++) unique = `${id}-${n}`;
  seen.add(unique);
  return unique;
}

/**
 * The interview question this bullet answers, built from the bullet's own opening words so every
 * word of the title is in the document. `remember.mjs` is how a better title gets written.
 */
function titleFor(body) {
  const lead = body
    .split(/\s+/)
    .slice(0, 9)
    .join(" ")
    .replace(/[,;:.]+$/, "");
  return `Can you tell me about when you ${lead.charAt(0).toLowerCase()}${lead.slice(1)}?`;
}

/**
 * Résumé text → the rows `extractResume` would return, minus everything that needs a model.
 *
 * @param {string} text the document's text (form feeds separate pages), or use `pages`.
 * @param {{doc?:string, pages?:string[]}} [opts]
 * @returns {{facts: Array<{id,value,source}>, stories: Array<{id,title,text,tags,source}>}}
 */
export function extractBasic(text, { doc = "resume", pages = null } = {}) {
  const pageList = pagesOf(text, pages);
  const lines = linesOf(pageList);
  const page = (n) => Math.min(Math.max(1, Math.round(Number(n) || 1)), pageList.length);
  const source = (n) => `resume:${doc}#p${page(n)}`;

  const candidates = [
    nameRow(lines),
    contactRow(lines, EMAIL, "f.identity.email"),
    contactRow(lines, PHONE, "f.identity.phone", looksLikePhone),
    locationRow(lines),
    ...linkRows(lines),
  ].filter(Boolean);

  // One row per identity id: the first claim in the document wins, exactly as `extractResume`
  // treats a canonical fact. A CV that lists two GitHub links does not get two rows.
  const facts = [];
  const seenFacts = new Set();
  for (const row of candidates) {
    if (seenFacts.has(row.id)) continue;
    seenFacts.add(row.id);
    facts.push({ id: row.id, value: row.value, source: source(row.page) });
  }

  facts.push(...educationRows(lines, source, seenFacts), ...employmentRows(lines, source, seenFacts));

  const stories = storyRows(lines, source, new Set());
  if (!facts.length && !stories.length) throw new Error("extractBasic: nothing extracted from the document");
  return { facts, stories };
}
