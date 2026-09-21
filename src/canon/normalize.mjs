// Label and option normalization for the question bank (docs/PLAN.md §2.7).
//
// Everything here is deterministic string work: the same corpus normalizes to the same keys on
// every run, so `scripts/canon-cluster.mjs` only spends a Jev question on labels that genuinely
// need a judgment. Two passes use this module:
//
//   exact pass   normalizeLabel() collapses "First Name *", "first name:" and "FIRST NAME" to one
//                group key, and ALIASES maps the known surface forms straight onto a seed qid.
//   Jev pass     everything the exact pass did not resolve, with normalizeOption()/optionSetKey()
//                supplying the observed vocabularies as context.
//
// The alias table is deliberately small and literal. It carries the phrasings that are the *same
// question spelled differently* ("email" / "e-mail address"), never ones that need reading
// comprehension ("Do you now or will you in the future require sponsorship…"): those are Jev's
// job, and hand-coding them here would be pretending we clustered something we did not.

// ─── labels ───────────────────────────────────────────────────────────────────────────────────

const SMART = [
  [/[\u2018\u2019\u201B\u02BC]/g, "'"],
  [/[\u201C\u201D\u201F]/g, '"'],
  [/[\u2013\u2014\u2015]/g, "-"],
  [/[\u00A0\u2007\u202F\u200B\uFEFF]/g, " "],
  [/[\u2026]/g, "..."],
];

const OPTIONALITY = /\((?:required|optional|opcional)\)|\[(?:required|optional)\]|\brequired\b\s*$/gi;

/**
 * "First Name *" · "first name:" · "First name (required)" → "first name".
 * Lowercase, straighten punctuation, drop the required/optional decoration, drop the trailing
 * question mark, collapse whitespace.
 * @param {string} label
 * @returns {string}
 */
export function normalizeLabel(label) {
  let s = String(label ?? "");
  for (const [re, to] of SMART) s = s.replace(re, to);
  s = s.toLowerCase();
  s = s.replace(OPTIONALITY, " ");
  s = s.replace(/[*✱]/g, " ");
  s = s.replace(/[:：]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[?？!]+$/g, "").trim();
  s = s.replace(/[.,;·•\-–—_]+$/g, "").trim();
  s = s.replace(/^["'`(\[]+/, "").replace(/["'`)\]]+$/, "").trim();
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Option labels: same treatment, minus the question-mark rule, plus checkbox/marker noise. */
export function normalizeOption(option) {
  let s = String(option ?? "");
  for (const [re, to] of SMART) s = s.replace(re, to);
  s = s.toLowerCase();
  s = s.replace(OPTIONALITY, " ");
  s = s.replace(/^[\s\-–—•*·>\[\]()]+/, "");
  s = s.replace(/[\s.,;:*]+$/, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Stable key for one observed vocabulary, so identical option sets group exactly. */
export function optionSetKey(options) {
  const list = (options ?? []).map(normalizeOption).filter(Boolean);
  if (!list.length) return "";
  return list.join(" | ");
}

/** "Why do you want to work here?" → "why-do-you-want-to-work-here", clipped at a word boundary. */
export function slug(text, max = 48) {
  const words = String(text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const out = [];
  let len = 0;
  for (const w of words) {
    if (len && len + 1 + w.length > max) break;
    out.push(w);
    len += (len ? 1 : 0) + w.length;
  }
  return (out.join("_") || "question").replace(/^_+|_+$/g, "");
}

/**
 * Words that carry no meaning in an id, so "Are you open to relocation for this role?" becomes
 * `open_relocation_role`. Interrogatives (why/how/what) and negations stay: they are the
 * difference between `why_company` and `company`, and between `authorized` and `not_authorized`.
 */
const ID_STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "in", "for", "and", "or", "is", "are", "do", "does", "did", "you",
  "your", "we", "us", "our", "this", "that", "it", "be", "been", "have", "has", "had", "will",
  "would", "can", "could", "please", "if", "any", "at", "on", "by", "with", "as", "from", "about",
  "so", "there", "their", "they", "them", "may", "might", "must", "shall", "should", "were",
  "was", "am",
]);

/**
 * Deterministic id for a question the clusterer discovered.
 * `q.screening.mobile.years_swift`, `q.company.binance.nationality`, `q.core.transcript`.
 * @param {{layer:string, label:string, family?:string, company?:string, taken?:Set<string>}} spec
 */
export function proposeId({ layer, label, family, company, taken }) {
  const words = normalizeLabel(label)
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !ID_STOPWORDS.has(w));
  const body = slug(words.join(" ") || normalizeLabel(label), 44);
  const scope = layer === "screening" && family ? `${family}.` : layer === "company" && company ? `${company}.` : "";
  const base = `q.${layer}.${scope}${body}`;
  if (!taken || !taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A raw form label → the canonical text a canonical question is written in. */
export function canonicalText(label, { type } = {}) {
  const clean = String(label ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s*\*\s*$/, "")
    .trim()
    .replace(/^[\[(](?:optional|required)[\])]\s*/i, "");
  if (!clean) return "(unlabelled field)";
  const trimmed = clean.length > 220 ? `${clean.slice(0, 219)}…` : clean;
  const head = trimmed[0].toUpperCase() + trimmed.slice(1);
  if (/[?.!:]$/.test(head)) return head;
  const interrogative = /^(are|is|do|does|did|have|has|had|will|would|can|could|may|what|which|who|when|where|why|how|tell|describe)\b/i.test(head);
  const upload = type === "file";
  return interrogative ? `${head}?` : upload ? `${head}.` : `${head}`;
}

// ─── alias table for the exact-match pass ─────────────────────────────────────────────────────

/**
 * Normalized label → seed qid. Keys must already be in `normalizeLabel()` form.
 * Only literal synonyms live here; anything needing comprehension goes to Jev.
 * @type {Record<string, string>}
 */
export const ALIASES = {
  // names
  "first name": "q.core.first_name",
  "first name(s)": "q.core.first_name",
  "given name": "q.core.first_name",
  "preferred first name": "q.core.preferred_name",
  "last name": "q.core.last_name",
  "surname": "q.core.last_name",
  "family name": "q.core.last_name",
  "name": "q.core.full_name",
  "full name": "q.core.full_name",
  "legal name": "q.core.full_name",
  "full legal name": "q.core.full_name",
  "please state your full legal name": "q.core.full_name",
  "preferred name": "q.core.preferred_name",
  "what is your preferred name": "q.core.preferred_name",
  "preferred name (if applicable)": "q.core.preferred_name",
  "preferred name | what would you like us to call you": "q.core.preferred_name",
  "name pronunciation": "q.core.name_pronunciation",
  "name pronunciation | how do you pronounce your name": "q.core.name_pronunciation",
  "how do you pronounce your name": "q.core.name_pronunciation",
  "pronouns": "q.core.pronouns",
  "what are your pronouns": "q.core.pronouns",
  "[optional] pronouns - how should we refer to you in the third person": "q.core.pronouns",
  "what are your preferred gender pronouns? (she/her/hers; he/him/his; they/them/theirs, etc.)": "q.core.pronouns",
  "preferred pronouns": "q.core.pronouns",

  // contact
  "email": "q.core.email",
  "e-mail": "q.core.email",
  "email address": "q.core.email",
  "e-mail address": "q.core.email",
  "your email": "q.core.email",
  "phone": "q.core.phone",
  "phone number": "q.core.phone",
  "mobile phone number": "q.core.phone",
  "telephone": "q.core.phone",
  "contact number": "q.core.phone",

  // documents
  "resume": "q.core.resume",
  "resume/cv": "q.core.resume",
  "cv": "q.core.resume",
  "cv/resume": "q.core.resume",
  "resume / cv": "q.core.resume",
  "upload your resume": "q.core.resume",
  "cover letter": "q.core.cover_letter",
  "cover letter (optional)": "q.core.cover_letter",

  // links
  "linkedin": "q.core.linkedin",
  "linkedin url": "q.core.linkedin",
  "linkedin profile": "q.core.linkedin",
  "linkedin profile url": "q.core.linkedin",
  "linkedin (or other profile)": "q.core.linkedin",
  "github": "q.core.github",
  "github url": "q.core.github",
  "github profile": "q.core.github",
  "github profile url": "q.core.github",
  "website": "q.core.website",
  "personal website": "q.core.website",
  "website url": "q.core.website",
  "personal website or blog": "q.core.website",
  "blog": "q.core.website",
  "other website": "q.core.other_links",
  "other links": "q.core.other_links",
  "other link": "q.core.other_links",
  "portfolio": "q.core.portfolio",
  "portfolio url": "q.core.portfolio",
  "design portfolio": "q.core.portfolio",
  "twitter": "q.core.twitter",
  "twitter url": "q.core.twitter",
  "x (twitter)": "q.core.twitter",
  "google scholar": "q.core.publications",
  "publications (e.g. google scholar) url": "q.core.publications",
  "publications": "q.core.publications",

  // where you are
  "location": "q.core.location_current",
  "current location": "q.core.location_current",
  "where are you currently located": "q.core.location_current",
  "where are you currently located? (city, state)": "q.core.location_current",
  "where do you currently live": "q.core.location_current",
  "city": "q.core.location_current",
  "what country are you based in": "q.core.country_current",
  "country": "q.core.country_current",
  "which location are you applying for": "q.core.work_location_preference",
  "which office location(s) are you interested in": "q.core.work_location_preference",
  "open to relocation if necessary": "q.core.relocation",
  "are you open to relocation for this role": "q.core.relocation",
  "are you local to or willing to relocate": "q.core.relocation",

  // current work
  "current company": "q.core.current_company",
  "current employer": "q.core.current_company",
  "who is your current or most recent employer": "q.core.current_company",
  "current title": "q.core.current_title",
  "current job title": "q.core.current_title",
  "what is your current or more recent job title": "q.core.current_title",
  "what is your current title": "q.core.current_title",

  // availability
  "notice period": "q.core.notice_period",
  "what is your current notice period": "q.core.notice_period",
  "start date": "q.core.start_date",
  "earliest start date": "q.core.start_date",
  "when can you start": "q.core.start_date",

  // sourcing
  "how did you hear about us": "q.core.how_heard",
  "how did you hear about this job": "q.core.how_heard",
  "how did you hear about this role": "q.core.how_heard",
  "how did you hear about this position": "q.core.how_heard",
  "how did you hear about this opportunity": "q.core.how_heard",
  "how did you hear about our job opening? please select one of the following options": "q.core.how_heard",
  "please tell us how you heard about this opportunity": "q.core.how_heard",

  // compensation
  "salary expectations": "q.comp.expected_salary",
  "what are your salary expectations": "q.comp.expected_salary",
  "compensation expectations": "q.comp.expected_salary",
  "what are your compensation expectations": "q.comp.expected_salary",
  "desired salary": "q.comp.expected_salary",
  "current salary": "q.comp.current_salary",

  // legal gates
  "are you at least 18 years of age": "q.legal.age_18",
  "are you 18 years of age or older": "q.legal.age_18",
  "agreement to arbitrate": "q.legal.arbitration",
  "please read the arbitration agreement below": "q.legal.arbitration",
  "arbitration agreement": "q.legal.arbitration",
  "candidate ai usage attestation": "q.legal.ai_policy_attestation",
  "ai policy for application": "q.legal.ai_policy_attestation",
  "interview recording consent": "q.legal.interview_recording_consent",
  "what is your nationality": "q.auth.nationality",

  // EEO / demographics
  "gender": "q.eeo.gender",
  "what is your gender": "q.eeo.gender",
  "what gender do you identify with": "q.eeo.gender",
  "what gender do you identify as": "q.eeo.gender",
  "what gender do you most closely identify as": "q.eeo.gender",
  "what best describes your gender": "q.eeo.gender",
  "please identify your sex": "q.eeo.gender",
  "gender identity": "q.eeo.gender_identity",
  "what is your gender identity": "q.eeo.gender_identity",
  "gender identity options": "q.eeo.gender_identity",
  "race": "q.eeo.race",
  "race/ethnicity": "q.eeo.race",
  "what is your race/ethnicity": "q.eeo.race",
  "ethnicity": "q.eeo.race",
  "what is your ethnicity": "q.eeo.race",
  "what best describes your ethnicity": "q.eeo.race",
  "i identify my ethnicity as": "q.eeo.race",
  "please identify your race": "q.eeo.race",
  "please identify your ethnicity": "q.eeo.race",
  "veteran status": "q.eeo.veteran",
  "veteranstatus": "q.eeo.veteran",
  "please identify your veteran status": "q.eeo.veteran",
  "are you a veteran/have you served in the military": "q.eeo.veteran",
  "disability": "q.eeo.disability",
  "disability status": "q.eeo.disability",
  "disabilitystatus": "q.eeo.disability",
  "are you a person living with a disability": "q.eeo.disability",
  "sexual orientation": "q.eeo.sexual_orientation",
  "what is your sexual orientation": "q.eeo.sexual_orientation",
  "do you identify as a member of the lgbtq+ community": "q.eeo.sexual_orientation",
  "do you identify as part of the lgbtqia+ community": "q.eeo.sexual_orientation",
};

/**
 * A few labels are the same words for two different questions and only the control type tells
 * them apart: a "Cover letter" file input is a document, a "Cover letter" textarea is writing.
 * @type {Record<string, Record<string, string>>}
 */
export const TYPED_ALIASES = {
  "cover letter": { textarea: "q.narrative.cover_letter_text", text: "q.narrative.cover_letter_text" },
  "cover letter (optional)": { textarea: "q.narrative.cover_letter_text" },
};

/**
 * Exact-match pass: normalized label (+ its dominant control type) → seed qid, or null.
 * @param {string} normalized already through normalizeLabel()
 * @param {string} [type] FormPlan control type
 */
export function aliasFor(normalized, type) {
  const typed = TYPED_ALIASES[normalized];
  if (typed && type && typed[type]) return typed[type];
  return ALIASES[normalized] ?? null;
}

// ─── option vocabularies ──────────────────────────────────────────────────────────────────────

/**
 * Canonical option values per vocabulary, with the rules that map a real form's wording onto
 * them. Order matters: the first matching rule wins, so put the specific patterns first.
 * `canon/vocab/<qid>.yaml` is written from these plus whatever the corpus actually showed.
 */
export const VOCABS = {
  yes_no: {
    values: {
      yes: "Yes",
      no: "No",
      unsure: "Not sure / it depends",
      not_applicable: "Not applicable",
      prefer_not_to_say: "Prefer not to say / decline to answer",
    },
    match: [
      [/^(prefer not|decline|i (do not|don't) wish|choose not)/, "prefer_not_to_say"],
      [/^(n\/?a\b|not applicable)/, "not_applicable"],
      [/(not sure|unsure|maybe|it depends|don't know|do not know)/, "unsure"],
      [/^(yes|y|true|i (do|am|have|agree|consent|acknowledge|certify|confirm))\b/, "yes"],
      [/^(no|n|false|i (do not|don't|am not|have not|haven't))\b/, "no"],
      [/\bauthorized\b/, "yes"],
      [/\bnot authorized\b/, "no"],
    ],
  },
  consent: {
    values: {
      agree: "I agree / I acknowledge / I consent",
      disagree: "I do not agree",
      acknowledged: "I have read and understood",
      prefer_not_to_say: "Decline to answer",
    },
    match: [
      [/^(i )?(do not|don't|decline|disagree|no\b)/, "disagree"],
      [/(acknowledge|have read|understood|understand|confirm receipt|reviewed)/, "acknowledged"],
      [/(agree|consent|accept|yes\b|opt in|i certify)/, "agree"],
      [/(prefer not|decline)/, "prefer_not_to_say"],
    ],
  },
  how_heard: {
    values: {
      linkedin: "LinkedIn",
      job_board: "A job board or aggregator (Indeed, Otta, Hacker News, Wellfound…)",
      referral: "Referred by an employee or someone I know",
      company_site: "The company's own website or careers page",
      recruiter: "Contacted by a recruiter or sourcer",
      event: "An event, conference, meetup, career fair or on-campus visit",
      social_media: "Social media (X/Twitter, Instagram, YouTube, Reddit, Discord…)",
      school: "University, bootcamp or alumni channel",
      press_or_podcast: "Press, newsletter, blog or podcast",
      other: "Something else",
    },
    match: [
      [/linkedin/, "linkedin"],
      [/(referral|referred|employee|friend|colleague|word of mouth)/, "referral"],
      [/(recruiter|sourcer|talent|outreach|reached out|inmail)/, "recruiter"],
      [/(career (fair|site|page)|company (website|site)|our website|careers page|job posting on our)/, "company_site"],
      [/(conference|event|meetup|hackathon|career fair|on-campus|summit|webinar)/, "event"],
      [/(university|college|school|alumni|bootcamp|professor|campus)/, "school"],
      [/(twitter|\bx\b|instagram|facebook|youtube|reddit|discord|tiktok|social media|slack community)/, "social_media"],
      [/(podcast|newsletter|blog|press|article|news|substack)/, "press_or_podcast"],
      [/(job board|indeed|glassdoor|hacker news|wellfound|angellist|otta|builtin|ziprecruiter|monster|dice|welcome to the jungle|google|search)/, "job_board"],
      [/(other|something else)/, "other"],
    ],
  },
  pronouns: {
    values: {
      she_her: "she/her",
      he_him: "he/him",
      they_them: "they/them",
      self_describe: "Another set of pronouns",
      prefer_not_to_say: "Prefer not to say",
    },
    match: [
      [/^she/, "she_her"],
      [/^he\b|^he\//, "he_him"],
      [/^they/, "they_them"],
      [/(prefer not|decline|not listed)/, "prefer_not_to_say"],
      [/(other|self|describe|ze|xe)/, "self_describe"],
    ],
  },
  eeo_gender: {
    values: {
      man: "Man / male",
      woman: "Woman / female",
      non_binary: "Non-binary, genderqueer or gender non-conforming",
      self_describe: "Prefer to self-describe",
      prefer_not_to_say: "Decline to self-identify",
    },
    match: [
      [/(decline|prefer not|don't wish|do not wish|i don't want)/, "prefer_not_to_say"],
      [/(non-?binary|genderqueer|gender non|gender diverse|agender)/, "non_binary"],
      [/(self-?describe|self identify|another|not listed|other)/, "self_describe"],
      [/\b(male|man|men)\b/, "man"],
      [/\b(female|woman|women)\b/, "woman"],
    ],
  },
  eeo_race: {
    values: {
      american_indian_alaska_native: "American Indian or Alaska Native",
      asian: "Asian",
      black_african_american: "Black or African American",
      hispanic_latino: "Hispanic or Latino",
      native_hawaiian_pacific_islander: "Native Hawaiian or Other Pacific Islander",
      white: "White",
      two_or_more: "Two or more races",
      other: "A group not listed",
      prefer_not_to_say: "Decline to self-identify",
    },
    match: [
      [/(decline|prefer not|don't wish|do not wish)/, "prefer_not_to_say"],
      [/(two or more|multiracial|mixed|more than one)/, "two_or_more"],
      [/(american indian|alaska native|indigenous|native american|first nations)/, "american_indian_alaska_native"],
      [/(hispanic|latino|latinx|latine)/, "hispanic_latino"],
      [/(native hawaiian|pacific islander)/, "native_hawaiian_pacific_islander"],
      [/(black|african american|african|caribbean)/, "black_african_american"],
      [/asian|south asian|east asian|chinese|indian subcontinent/, "asian"],
      [/white|caucasian|european/, "white"],
      [/(other|not listed|another)/, "other"],
    ],
  },
  eeo_veteran: {
    values: {
      protected_veteran: "I identify as one or more protected veteran categories",
      not_a_veteran: "I am not a protected veteran",
      veteran_not_protected: "I am a veteran but not a protected veteran",
      prefer_not_to_say: "I do not wish to answer",
    },
    match: [
      [/(don't wish|do not wish|decline|prefer not|choose not)/, "prefer_not_to_say"],
      [/(not a protected veteran|am not a protected|i am not a veteran|no,? i am not|not a veteran)/, "not_a_veteran"],
      [/(identify as one or more|i am a protected veteran|protected veteran)/, "protected_veteran"],
      [/(veteran who is not protected|not protected)/, "veteran_not_protected"],
      [/(yes|served)/, "protected_veteran"],
    ],
  },
  eeo_disability: {
    values: {
      yes: "Yes, I have (or previously had) a disability",
      no: "No, I do not have a disability",
      prefer_not_to_say: "I do not want to answer",
    },
    match: [
      [/(don't want|do not want|decline|prefer not|choose not|don't wish)/, "prefer_not_to_say"],
      [/^(yes|i have|i identify)/, "yes"],
      [/^(no|i (do not|don't) have)/, "no"],
    ],
  },
  education_degree: {
    values: {
      high_school: "High school or equivalent",
      associate: "Associate degree",
      bachelor: "Bachelor's degree",
      master: "Master's degree",
      doctorate: "Doctorate (PhD, MD, JD…)",
      other: "Something else",
      prefer_not_to_say: "Prefer not to say",
    },
    match: [
      [/(prefer not|decline)/, "prefer_not_to_say"],
      [/(phd|ph\.d|doctor|md\b|jd\b|dphil)/, "doctorate"],
      [/(master|msc|m\.s|mba|meng|ma\b)/, "master"],
      [/(bachelor|bsc|b\.s|ba\b|beng|undergrad)/, "bachelor"],
      [/(associate|a\.a|two-year)/, "associate"],
      [/(high school|secondary|ged|a-level)/, "high_school"],
      [/(other|none|self-taught|bootcamp)/, "other"],
    ],
  },
};

/** Canonical question → which named vocabulary its options belong to. */
export const QID_VOCAB = {
  "q.core.how_heard": "how_heard",
  "q.core.pronouns": "pronouns",
  "q.core.education_degree": "education_degree",
  "q.core.relocation": "yes_no",
  "q.core.in_office": "yes_no",
  "q.core.accommodation_request": "yes_no",
  "q.auth.authorized_in_country": "yes_no",
  "q.auth.sponsorship_now": "yes_no",
  "q.auth.sponsorship_future": "yes_no",
  "q.legal.age_18": "yes_no",
  "q.legal.restrictive_agreements": "yes_no",
  "q.legal.previously_employed": "yes_no",
  "q.legal.previously_interviewed": "yes_no",
  "q.legal.previously_applied": "yes_no",
  "q.legal.government_official": "yes_no",
  "q.legal.conflict_of_interest": "yes_no",
  "q.legal.arbitration": "consent",
  "q.legal.privacy_consent": "consent",
  "q.legal.ai_policy_attestation": "consent",
  "q.legal.ai_tools_consent": "consent",
  "q.legal.interview_recording_consent": "consent",
  "q.legal.background_check": "consent",
  "q.legal.application_truthful": "consent",
  "q.comp.range_acknowledgement": "yes_no",
  "q.eeo.gender": "eeo_gender",
  "q.eeo.gender_identity": "eeo_gender",
  "q.eeo.race": "eeo_race",
  "q.eeo.veteran": "eeo_veteran",
  "q.eeo.disability": "eeo_disability",
  "q.eeo.sexual_orientation": "yes_no",
};

/** Map one observed option onto a vocabulary's canonical value, or null when nothing matches. */
export function canonicalOption(vocabName, option) {
  const vocab = VOCABS[vocabName];
  if (!vocab) return null;
  const text = normalizeOption(option);
  if (!text) return null;
  for (const [re, value] of vocab.match) if (re.test(text)) return value;
  return null;
}

/** Does this option set read as a plain yes/no (so a qid with no named vocab still gets one)? */
export function looksYesNo(options) {
  const list = (options ?? []).map(normalizeOption).filter(Boolean);
  if (list.length < 2 || list.length > 5) return false;
  return list.every((o) => /^(yes|no|n\/a|not applicable|prefer not|decline|unsure|not sure|maybe|true|false)\b/.test(o));
}

/** The vocabulary a canonical question uses: the declared one, else yes/no when it looks like it. */
export function vocabFor(qid, optionSets = []) {
  if (QID_VOCAB[qid]) return QID_VOCAB[qid];
  if (optionSets.length && optionSets.every((set) => looksYesNo(set))) return "yes_no";
  return null;
}
