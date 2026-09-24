// Prompts, JSON schemas and word lists for the writer (src/writer/openai.mjs).
// Pure strings and data — no network, no secrets, no I/O. PLAN §2.2 step 10, §2.4, §2.7.

/** Hard house limits per narrative variant (PLAN §2.7: drafts are short). */
export const VARIANT_WORDS = { short: 60, medium: 150, long: 300 };

/** A why_us paragraph is never longer than a curated narrative draft. */
export const WHY_US_WORDS = 150;

/** An expanded story answer targets 200 words unless the field's limit is tighter. */
export const EXPAND_WORDS = 200;

/**
 * Marketing / filler vocabulary. A hit is only a violation when the phrase is NOT already in the
 * grounding — if the user wrote "passionate" in their own sentence, echoing it is their voice.
 */
export const MARKETING_PHRASES = [
  "passion", "passionate", "leverage", "leveraging", "leveraged", "synergy", "synergies",
  "world-class", "world class", "cutting-edge", "cutting edge", "best-in-class", "best in class",
  "state-of-the-art", "state of the art", "industry-leading", "next-generation", "game-changing",
  "game changer", "revolutionary", "revolutionize", "innovative", "innovation", "visionary",
  "rockstar", "rock star", "ninja", "guru", "thrilled", "delighted", "excited", "exciting",
  "excitement", "eager", "honored", "privileged", "dream job", "perfect fit", "uniquely positioned",
  "impactful", "unparalleled", "seamless", "seamlessly", "holistic", "dynamic", "amazing",
  "awesome", "incredible", "incredibly", "extremely", "deeply committed", "proven track record",
  "wealth of experience", "hit the ground running", "in today's", "i am writing to",
  "i would love the opportunity", "look no further", "10x",
];

/**
 * Capitalized words that are never an organisation or product. Only consulted for mid-sentence
 * capitals; sentence-initial capitals are handled positionally in openai.mjs.
 */
export const NAME_STOPWORDS = new Set([
  "I", "I'm", "I've", "I'd", "I'll", "A", "An", "The", "And", "But", "Or", "So", "If", "When",
  "While", "After", "Before", "Then", "That", "This", "These", "Those", "It", "Its", "We", "Our",
  "My", "Me", "You", "Your", "They", "Their", "He", "She", "His", "Her", "There", "Here", "What",
  "Why", "How", "Who", "Where", "Which", "Now", "Today", "Later", "Most", "More", "Less", "Both",
  "Each", "Every", "No", "Not", "Yes", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
  "Saturday", "Sunday", "January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December",
]);

const STYLE_RULES = `You write one job-application answer in the applicant's own voice. Follow these rules in order.

1. GROUNDING. The FACTS and STORIES block below is the only thing you know about the applicant.
   Never invent, round, merge or re-scale a number: copy every number exactly as it appears, or leave
   it out. Never name a company, product, tool, framework, language, school or person that is not in
   the grounding (or in the JOB block, when there is one). If the grounding does not support a claim,
   drop the claim — do not hedge it into existence.
2. VOICE. First person, past tense for work already done. Say "I" for what you did and "we" only
   where the grounding says it was a team.
3. PLAIN. Short declarative sentences, one idea each. Concrete nouns. No marketing or self-praise
   adjectives (no "passionate", "world-class", "cutting-edge", "excited", "innovative", "impactful",
   "proven track record"). No enthusiasm, no flattery, no closing sales pitch, no restating the
   question, no "In today's ...". Contractions are fine.
4. SHAPE. Prose paragraphs, no headings, no bullet lists, no markdown, no sign-off, no greeting.
5. LENGTH. Stay under the word cap. Do not pad to reach it; a shorter honest answer is better.`;

const JSON_NOTE = "Return only the JSON object required by the schema.";

/** Renders facts + stories as the model's only source material. */
export function groundingBlock({ facts = [], stories = [] } = {}) {
  const f = facts.length
    ? facts.map((x) => `- ${x.id}: ${x.value}${x.since ? ` (since ${x.since})` : ""}`).join("\n")
    : "- (none)";
  const s = stories.length
    ? stories.map((x) => `- ${x.id} | ${x.title}\n  ${collapse(x.text)}`).join("\n")
    : "- (none)";
  return `FACTS (the only facts about the applicant you may state)\n${f}\n\nSTORIES (the only events you may describe)\n${s}`;
}

/**
 * The anecdotes another answer on this same application has already told.
 *
 * `src/plan/draft.mjs` picks a different story per box wherever the candidate has one, so this
 * list is normally empty; it is non-empty exactly when there was nothing else on file and the
 * same material had to be handed to a second box. A reader meeting the same p99 anecdote twice,
 * three paragraphs apart, is the failure this closes
 * (docs/research/13-eval-judge-round2.md §3 N4) — so when the material must be reused, the
 * *telling* must not be.
 */
export function avoidBlock(avoid = []) {
  const list = (Array.isArray(avoid) ? avoid : [avoid]).map((a) => collapse(a)).filter(Boolean);
  if (!list.length) return "";
  return `\n\nALREADY TOLD IN ANOTHER ANSWER ON THIS SAME APPLICATION\n${list
    .map((a) => `- ${a}`)
    .join("\n")}\nThe reader will see that answer too. Do not re-tell these episodes: do not repeat their
narrative, their sequence of events or their headline numbers. Use different material from the
grounding, and if this question genuinely needs the same work, refer to its *result* in one clause
and spend the answer on what this question actually asks.`;
}

export function jobBlock(job) {
  if (!job) return "";
  const bits = [
    job.company && `company: ${job.company}`,
    job.title && `role: ${job.title}`,
    job.location && `location: ${job.location}`,
    job.description && `posting: ${collapse(job.description).slice(0, 1500)}`,
  ].filter(Boolean);
  return bits.length ? `\n\nJOB\n${bits.map((b) => `- ${b}`).join("\n")}` : "";
}

export function repairNote(problems) {
  return `\n\nYOUR PREVIOUS ANSWER BROKE THE RULES:\n${problems.map((p) => `- ${p}`).join("\n")}\nWrite it again. Fix exactly these problems and change nothing else. Every number and every capitalized name must appear verbatim in the grounding, otherwise cut the sentence that carries it.`;
}

// ---------------------------------------------------------------- narrative

export const NARRATIVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["short", "medium", "long"],
  properties: {
    short: { type: "string", description: "the answer at its shortest, still a full answer" },
    medium: { type: "string", description: "the default answer" },
    long: { type: "string", description: "the answer with the most supporting detail" },
  },
};

export function narrativeInstructions({ caps, family }) {
  return `${STYLE_RULES}

You are writing the SAME answer at three lengths: short (at most ${caps.short.words} words),
medium (at most ${caps.medium.words} words), long (at most ${caps.long.words} words). All three
must answer the prompt on their own and must use the same facts — the longer ones add detail from
the grounding, never new claims.${family ? `\nThe role family is "${family}"; keep the technical detail that a ${family} hiring manager reads for.` : ""}
${JSON_NOTE}`;
}

export function narrativeInput({ prompt, facts, stories, family, job, avoid = [], note = "" }) {
  return `PROMPT TO ANSWER\n${prompt}${family ? `\n\nROLE FAMILY\n${family}` : ""}${jobBlock(job)}\n\n${groundingBlock({ facts, stories })}${avoidBlock(avoid)}${note}`;
}

// ------------------------------------------------------------------ expand

export const TEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: { text: { type: "string", description: "the answer, prose only" } },
};

export function expandInstructions({ cap }) {
  return `${STYLE_RULES}

You are expanding ONE story the applicant already wrote into a full answer to the question below.
Keep the story's facts, numbers and order; add only detail that is already in the story or the
facts. At most ${cap.words} words${cap.chars < Infinity ? ` and at most ${cap.chars} characters` : ""}.
${JSON_NOTE}`;
}

export function expandInput({ story, question, facts = [], job, avoid = [], note = "" }) {
  return `QUESTION\n${question}${jobBlock(job)}\n\n${groundingBlock({ facts, stories: [story] })}${avoidBlock(avoid)}${note}`;
}

// ------------------------------------------------------------------ why_us

export function whyUsInstructions({ cap, company, sentence = true }) {
  const thesis = sentence
    ? `The applicant's own sentence is the
thesis: keep its claim, do not soften or replace it, and do not add a second reason of your own.`
    : `The applicant has not written a sentence for this company, so the thesis has to come from
what is already on file: pick the ONE overlap between the JOB block and the FACTS/STORIES that a
reader would call specific — the same system, the same problem, the same stack — and say it as a
plain claim. If the job block and the grounding overlap in nothing concrete, say so by writing a
single sentence about the one technical area both mention and stop there. Never invent an
interest, never praise the company, never claim to have used a product that is not in the
grounding.`;
  return `${STYLE_RULES}

You are writing the "why this company" paragraph for ${company}. ${thesis}
Use one or two of the stories as the evidence that the applicant can do what the thesis claims, and
at most one concrete detail from the JOB block. Name ${company} once or twice; never name any other
company. One or two paragraphs, at most ${cap.words} words${cap.chars < Infinity ? ` and at most ${cap.chars} characters` : ""}.
No greeting, no sign-off, no "I am writing to apply".
${JSON_NOTE}`;
}

export function whyUsInput({ sentence, stories, facts = [], job, avoid = [], note = "" }) {
  const thesis = sentence
    ? `THE APPLICANT'S SENTENCE (the thesis — this is why they want this company)\n${sentence}`
    : "THE APPLICANT'S SENTENCE\n(none on file — build the thesis from the JOB block and the grounding below)";
  return `${thesis}${jobBlock(job)}\n\n${groundingBlock({ facts, stories })}${avoidBlock(avoid)}${note}`;
}

// ----------------------------------------------------------------- extract

export const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["facts", "stories", "history"],
  properties: {
    history: {
      type: "array",
      description: "one entry per degree and one per role the document lists — every one of them, not only the latest",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "organization", "role", "field", "start", "end", "employment_type", "page"],
        properties: {
          kind: { type: "string", enum: ["education", "employment"] },
          organization: { type: "string", description: "the school or the employer, exactly as written" },
          role: {
            type: ["string", "null"],
            description: "the degree (\"Bachelor of Technology\", \"MSc\") or the job title, exactly as written",
          },
          field: {
            type: ["string", "null"],
            description: "education only: the subject studied (\"Computer Science\"), exactly as written; else null",
          },
          start: { type: ["string", "null"], description: "\"YYYY-MM\", or \"YYYY\" when only the year is printed; null when not stated" },
          end: {
            type: ["string", "null"],
            description: "\"YYYY-MM\" or \"YYYY\"; \"present\" when the document says it is ongoing; null when not stated",
          },
          employment_type: {
            type: ["string", "null"],
            enum: ["full_time", "part_time", "internship", "contract", null],
            description: "employment only, and only when the document says so (\"Intern\", \"Contract\"); else null",
          },
          page: { type: "integer", description: "1-based [[page N]] marker the entry came from" },
        },
      },
    },
    facts: {
      type: "array",
      description: "atomic, checkable facts copied from the document",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "value", "since", "page"],
        properties: {
          id: {
            type: "string",
            description:
              "dotted lowercase id. Identity facts use these fixed ids and no others: " +
              "f.identity.full_name, f.identity.preferred_name (ONLY when the document states a " +
              "preferred name — \"goes by\", \"known as\", a nickname in quotes or brackets; never " +
              "a shortening you inferred), f.identity.email, f.identity.phone, f.identity.city " +
              "(whenever the document names a city — the value may carry the country, " +
              "\"Berlin, Germany\"), f.identity.location (only when the stated locality is NOT a " +
              "city, e.g. \"Remote\" or a bare country — never both city and location), " +
              "f.identity.timezone (only for a zone: \"CET\", \"UTC+2\", \"Europe/Berlin\"), " +
              "f.identity.github_url, f.identity.linkedin_url, f.identity.site_url, " +
              "f.identity.x_twitter_url, f.identity.publications_url (a Google Scholar, arXiv, " +
              "Semantic Scholar or publications page, when the document links one). " +
              "The role the applicant holds now — the one with no end date, or whose end date is " +
              "\"Present\"/\"Current\"/\"now\" — is two facts: f.employment.current (just the " +
              "employer's name) and f.employment.current_title (just the job title). Education is " +
              "f.education.school (the institution), f.education.field (the subject studied) and " +
              "f.education.degree (the qualification), from the most recent degree. Everything " +
              "else is f.skill.<technology>",
          },
          value: { type: "string", description: "the value exactly as the document states it" },
          since: {
            type: ["string", "null"],
            description: "YYYY-MM the fact became true (first use of a skill, start date), else null",
          },
          page: { type: "integer", description: "1-based [[page N]] marker the fact came from" },
        },
      },
    },
    stories: {
      type: "array",
      description: "one per substantial accomplishment; raw material for later answers",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "text", "tags", "page"],
        properties: {
          id: { type: "string", description: "dotted lowercase id, b.story.<slug>, e.g. b.story.queue_latency" },
          title: {
            type: "string",
            description:
              "the interview question this story answers, phrased as a question ending in '?', " +
              "e.g. \"Which project shows you cutting tail latency?\"",
          },
          text: {
            type: "string",
            description: "2-5 sentences, first person, only what the document supports, numbers verbatim",
          },
          tags: { type: "array", items: { type: "string" }, description: "3-6 lowercase topic tags" },
          page: { type: "integer", description: "1-based [[page N]] marker the story came from" },
        },
      },
    },
  },
};

export function extractInstructions() {
  return `You read a résumé and split it into FACTS and STORIES for a private job-application memory.

FACTS are atomic and checkable: name, email, phone, where they live, links, current employer and
title, degrees, and one entry per named skill or technology with the month the applicant first used
it when the document supports it. Use the exact ids the schema names — in particular a stated city
is f.identity.city and only a non-city locality ("Remote", a bare country) is f.identity.location,
never both. Copy values exactly as written. Never guess, never normalise, never fill a gap — if the
document does not say it, it is not a fact. Dates are "YYYY-MM"; use null when unknown.

Four of those ids are worth reading the document twice for, because a form asks for each of them by
name and a missing one becomes a question the applicant has to answer by hand:
- f.employment.current / f.employment.current_title — the employer and title of the role with no
  end date (or one that says "Present"). Split them: the employer's name in one, the title in the
  other, neither carrying the dates or the location. If every role has ended, write neither.
- f.education.school / f.education.field — the institution and the subject of the most recent
  degree, split the same way ("BSc Computer Science, TU Munich" → school "TU Munich", field
  "Computer Science", degree "BSc Computer Science").
- f.identity.preferred_name — only when the document states one ("goes by", "known as", a nickname
  in quotes). A first name you split out of the full name is not a preferred name.
- f.identity.publications_url — a Google Scholar, arXiv, Semantic Scholar or publications link.

STORIES are the accomplishments, one per bullet or per closely related group of bullets, written in
first person with every number copied verbatim from the document. Each story's TITLE must be the
interview question that story answers, phrased as a question and ending in "?" — for example
"Which project shows you cutting tail latency?" or "When did you lead a migration under a deadline?".
A title that is a heading rather than a question is wrong.

HISTORY is the document's education and work sections as a list: one entry per degree and one per
role, every one the document prints — a Bachelor's and a Master's are two entries, and so are two
roles at one employer. Copy names, degrees and titles exactly as written. Dates are only what the
document prints: "YYYY-MM", or "YYYY" when it gives the year alone, "present" for an ongoing one,
null when it gives none. School-leaving certificates (high school, A-levels, 12th grade) are not
entries.

The document is split by [[page N]] markers; report the page each item came from.
${JSON_NOTE}`;
}

export function extractInput({ text, doc, note = "" }) {
  return `DOCUMENT: ${doc}\n\n${text}${note}`;
}

function collapse(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}
