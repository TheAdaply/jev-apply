// The hand-written seed of the canonical question bank (docs/PLAN.md §2.7).
//
// These are the questions an applicant is asked on almost every form, written once in the
// product's own words. `scripts/canon-cluster.mjs` starts from this list, maps the 400 build-set
// postings onto it, and *derives* the rest (family screening, company templates, the long tail).
// Nothing here is personal data: this is the question side of the form, never an answer.
//
// Why a seed at all, when the corpus is right there: the clusterer's first pass needs something
// to match against, and the ids are a public interface — `answers.yaml`, `memory/answers`,
// `remember.mjs` and `src/jev/plan.mjs` all key off them. Deriving `q.core.email` from whichever
// surface form happened to be most frequent would make the id a function of the scrape.
//
// Fields (PLAN §2.7):
//   qid              stable id; the prefix is the layer (`q.company.*` is what remember.mjs
//                    scopes to a company, so company-layer ids must keep that prefix)
//   text             the canonical phrasing, in question form
//   layer            core | auth | legal | comp | eeo | narrative | screening
//   type             the FormPlan control type this usually arrives as
//   answer_shape     what a stored answer looks like (ANSWER_SHAPES)
//   kind_default     how the answer is normally produced (ANSWER_KINDS):
//                      constant  a stable saved fact (name, links, résumé)
//                      rule      derived at fill time from memory + the posting (work auth, salary)
//                      policy    the user's standing yes/no on a gate (arbitration, consent)
//                      narrative written text (essays), curated once, expanded per posting
//                      company   one sentence per company, asked at queue time
//                      never     never auto-filled — EEO/demographics (AGENTS.md invariant)
//   dependency?      {qid, condition} — only asked when the parent answer matches
//   jurisdiction_notes? why the answer is not universal (country, US state, statute)
//
// `screening` rows are only ever family-scoped (they carry `family`), because `canonCandidates()`
// in src/jev/plan.mjs admits a screening row only when `row.family` equals the posting's family.
// A question everybody asks therefore belongs in `core`, even when it reads like screening
// (years of experience, highest degree): a "universal screening" row would never be a candidate.

/** @typedef {"core"|"auth"|"legal"|"comp"|"eeo"|"narrative"|"screening"|"company"} Layer */
/** @typedef {"constant"|"rule"|"policy"|"narrative"|"company"|"never"} AnswerKind */
/**
 * @typedef {{qid:string, text:string, layer:Layer, type:string, answer_shape:string,
 *            kind_default:AnswerKind, dependency?:{qid:string, condition:string},
 *            jurisdiction_notes?:string, family?:string, company?:string}} CanonicalQuestion
 */

/** Layers, in the order they are written to `canon/questions.yaml`. */
export const LAYERS = ["core", "auth", "legal", "comp", "eeo", "narrative", "screening", "company"];

/** How an answer is produced. `never` means the runner leaves the field alone. */
export const ANSWER_KINDS = ["constant", "rule", "policy", "narrative", "company", "never"];

/** What a stored answer looks like once resolved. */
export const ANSWER_SHAPES = [
  "name",
  "text_short",
  "text_long",
  "email",
  "phone",
  "url",
  "file",
  "date",
  "month",
  "money",
  "integer",
  "yes_no",
  "select_one",
  "select_many",
  "consent",
  "address",
];

/** Id prefix → layer, for ids minted by the clusterer. */
export const LAYER_PREFIX = {
  core: "q.core.",
  auth: "q.auth.",
  legal: "q.legal.",
  comp: "q.comp.",
  eeo: "q.eeo.",
  narrative: "q.narrative.",
  screening: "q.screening.",
  company: "q.company.",
};

/** @type {CanonicalQuestion[]} */
export const SEED = [
  // ─── identity ───────────────────────────────────────────────────────────────────────────────
  { qid: "q.core.first_name", text: "What is your first name?", layer: "core", type: "text", answer_shape: "name", kind_default: "constant" },
  { qid: "q.core.last_name", text: "What is your last name?", layer: "core", type: "text", answer_shape: "name", kind_default: "constant" },
  { qid: "q.core.full_name", text: "What is your full legal name?", layer: "core", type: "text", answer_shape: "name", kind_default: "constant" },
  { qid: "q.core.preferred_name", text: "What name would you like us to call you?", layer: "core", type: "text", answer_shape: "name", kind_default: "constant" },
  { qid: "q.core.name_pronunciation", text: "How do you pronounce your name?", layer: "core", type: "text", answer_shape: "text_short", kind_default: "constant" },
  { qid: "q.core.pronouns", text: "What are your pronouns?", layer: "core", type: "single_select", answer_shape: "select_one", kind_default: "constant" },
  { qid: "q.core.email", text: "What is your email address?", layer: "core", type: "text", answer_shape: "email", kind_default: "constant" },
  { qid: "q.core.phone", text: "What is your phone number?", layer: "core", type: "phone", answer_shape: "phone", kind_default: "constant" },

  // ─── where you are ──────────────────────────────────────────────────────────────────────────
  { qid: "q.core.location_current", text: "Where are you currently located (city, state/region, country)?", layer: "core", type: "text", answer_shape: "text_short", kind_default: "constant" },
  { qid: "q.core.country_current", text: "Which country are you based in?", layer: "core", type: "single_select", answer_shape: "select_one", kind_default: "constant" },
  { qid: "q.core.address_working", text: "What is the address you would work from, including if you plan to relocate?", layer: "core", type: "text", answer_shape: "address", kind_default: "constant" },
  { qid: "q.core.work_location_preference", text: "Which office location(s) are you applying to or willing to work from?", layer: "core", type: "single_select", answer_shape: "select_many", kind_default: "rule" },
  { qid: "q.core.relocation", text: "Are you open to relocating for this role?", layer: "core", type: "single_select", answer_shape: "yes_no", kind_default: "rule" },
  { qid: "q.core.in_office", text: "Are you willing to work in the office on this role's required schedule?", layer: "core", type: "single_select", answer_shape: "yes_no", kind_default: "rule" },
  { qid: "q.core.timezone", text: "Which time zone are you in, and can you cover the hours this role requires?", layer: "core", type: "text", answer_shape: "text_short", kind_default: "rule" },

  // ─── documents and links ────────────────────────────────────────────────────────────────────
  { qid: "q.core.resume", text: "Upload your résumé/CV.", layer: "core", type: "file", answer_shape: "file", kind_default: "constant" },
  { qid: "q.core.cover_letter", text: "Upload a cover letter.", layer: "core", type: "file", answer_shape: "file", kind_default: "narrative" },
  { qid: "q.core.linkedin", text: "What is your LinkedIn profile URL?", layer: "core", type: "url", answer_shape: "url", kind_default: "constant" },
  { qid: "q.core.github", text: "What is your GitHub profile URL?", layer: "core", type: "url", answer_shape: "url", kind_default: "constant" },
  { qid: "q.core.website", text: "What is your personal website or blog URL?", layer: "core", type: "url", answer_shape: "url", kind_default: "constant" },
  { qid: "q.core.portfolio", text: "What is your portfolio URL?", layer: "core", type: "url", answer_shape: "url", kind_default: "constant" },
  { qid: "q.core.publications", text: "Where can we find your publications (Google Scholar, arXiv)?", layer: "core", type: "url", answer_shape: "url", kind_default: "constant" },
  { qid: "q.core.twitter", text: "What is your X/Twitter profile URL?", layer: "core", type: "url", answer_shape: "url", kind_default: "constant" },
  { qid: "q.core.other_links", text: "Any other links you would like to share?", layer: "core", type: "url", answer_shape: "url", kind_default: "constant" },

  // ─── current work and background ────────────────────────────────────────────────────────────
  { qid: "q.core.current_company", text: "What is your current or most recent employer?", layer: "core", type: "text", answer_shape: "text_short", kind_default: "constant" },
  { qid: "q.core.current_title", text: "What is your current or most recent job title?", layer: "core", type: "text", answer_shape: "text_short", kind_default: "constant" },
  { qid: "q.core.years_experience", text: "How many years of relevant professional experience do you have?", layer: "core", type: "text", answer_shape: "integer", kind_default: "rule" },
  { qid: "q.core.education_degree", text: "What is your highest level of education completed?", layer: "core", type: "single_select", answer_shape: "select_one", kind_default: "constant" },
  { qid: "q.core.education_school", text: "Which university or school did you attend?", layer: "core", type: "single_select", answer_shape: "select_one", kind_default: "constant" },
  { qid: "q.core.education_field", text: "What did you study?", layer: "core", type: "text", answer_shape: "text_short", kind_default: "constant" },
  { qid: "q.core.languages", text: "Which languages do you speak, and at what level?", layer: "core", type: "multi_select", answer_shape: "select_many", kind_default: "constant" },
  { qid: "q.core.security_clearance", text: "Do you hold, or are you eligible to obtain, a government security clearance?", layer: "core", type: "single_select", answer_shape: "yes_no", kind_default: "constant", jurisdiction_notes: "Clearance regimes are national (US DoD, UK SC/DV); an answer for one country says nothing about another." },

  // ─── availability ───────────────────────────────────────────────────────────────────────────
  { qid: "q.core.start_date", text: "When could you start?", layer: "core", type: "text", answer_shape: "month", kind_default: "rule" },
  { qid: "q.core.notice_period", text: "What is your current notice period?", layer: "core", type: "text", answer_shape: "text_short", kind_default: "rule" },
  { qid: "q.core.deadlines", text: "Do you have deadlines or timeline considerations we should know about (competing offers, visa dates)?", layer: "core", type: "textarea", answer_shape: "text_long", kind_default: "rule" },
  { qid: "q.core.how_heard", text: "How did you hear about this role?", layer: "core", type: "single_select", answer_shape: "select_one", kind_default: "constant" },
  { qid: "q.core.how_heard_detail", text: "Which event, person or publication was that?", layer: "core", type: "text", answer_shape: "text_short", kind_default: "company", dependency: { qid: "q.core.how_heard", condition: "answered other/event/referral" } },
  { qid: "q.core.accommodation_request", text: "Do you need an accommodation to take part in the hiring process?", layer: "core", type: "single_select", answer_shape: "yes_no", kind_default: "policy" },

  // ─── work authorization (two-valued per country, PLAN §2.4) ────────────────────────────────
  { qid: "q.auth.authorized_in_country", text: "Are you legally authorized to work in the country this role is based in?", layer: "auth", type: "single_select", answer_shape: "yes_no", kind_default: "rule", jurisdiction_notes: "Per target country; a yes for one country never implies another. Derived from memory work_auth.<cc>.authorized_now." },
  { qid: "q.auth.sponsorship_now", text: "Do you require visa sponsorship now to work in that country?", layer: "auth", type: "single_select", answer_shape: "yes_no", kind_default: "rule", dependency: { qid: "q.auth.authorized_in_country", condition: "no" }, jurisdiction_notes: "Per target country." },
  { qid: "q.auth.sponsorship_future", text: "Will you now or in the future require visa sponsorship to keep working in that country?", layer: "auth", type: "single_select", answer_shape: "yes_no", kind_default: "rule", jurisdiction_notes: "Per target country; a visa that expires makes this yes even when authorized_now is yes." },
  { qid: "q.auth.visa_status", text: "What is your current work-authorization or visa status, and when does it expire?", layer: "auth", type: "text", answer_shape: "text_short", kind_default: "rule", dependency: { qid: "q.auth.sponsorship_future", condition: "yes" }, jurisdiction_notes: "Per target country." },
  { qid: "q.auth.nationality", text: "What is your nationality or citizenship?", layer: "auth", type: "single_select", answer_shape: "select_one", kind_default: "constant", jurisdiction_notes: "Asked lawfully in some jurisdictions (export control, EU/UK right-to-work) and unlawful as a screen in others." },

  // ─── legal gates and disclosures ────────────────────────────────────────────────────────────
  { qid: "q.legal.arbitration", text: "Do you agree to the mutual arbitration agreement?", layer: "legal", type: "single_select", answer_shape: "consent", kind_default: "policy", jurisdiction_notes: "US-centric; enforceability varies by state (e.g. California AB 51 litigation history)." },
  { qid: "q.legal.restrictive_agreements", text: "Are you bound by a non-compete, non-solicit or other agreement that could restrict this work?", layer: "legal", type: "single_select", answer_shape: "yes_no", kind_default: "policy" },
  { qid: "q.legal.restrictive_agreements_detail", text: "Please describe the restriction.", layer: "legal", type: "textarea", answer_shape: "text_long", kind_default: "policy", dependency: { qid: "q.legal.restrictive_agreements", condition: "yes" } },
  { qid: "q.legal.previously_employed", text: "Have you ever been employed by this company (including as a contractor)?", layer: "legal", type: "single_select", answer_shape: "yes_no", kind_default: "rule" },
  { qid: "q.legal.previously_interviewed", text: "Have you interviewed with this company before?", layer: "legal", type: "single_select", answer_shape: "yes_no", kind_default: "rule" },
  { qid: "q.legal.previously_applied", text: "Have you applied to this company before?", layer: "legal", type: "single_select", answer_shape: "yes_no", kind_default: "rule" },
  { qid: "q.legal.referral", text: "Were you referred by an employee, and by whom?", layer: "legal", type: "text", answer_shape: "text_short", kind_default: "company" },
  { qid: "q.legal.privacy_consent", text: "Do you acknowledge the candidate privacy notice?", layer: "legal", type: "single_select", answer_shape: "consent", kind_default: "policy", jurisdiction_notes: "GDPR/UK GDPR and CCPA notices differ; consent is to that company's notice, not a global one." },
  { qid: "q.legal.ai_policy_attestation", text: "Do you attest to how you used AI tools while preparing this application?", layer: "legal", type: "single_select", answer_shape: "consent", kind_default: "policy" },
  { qid: "q.legal.ai_tools_consent", text: "Do you consent to AI notetakers or AI-assisted review during the interview process?", layer: "legal", type: "single_select", answer_shape: "consent", kind_default: "policy" },
  { qid: "q.legal.interview_recording_consent", text: "Do you consent to interviews being recorded?", layer: "legal", type: "single_select", answer_shape: "consent", kind_default: "policy" },
  { qid: "q.legal.age_18", text: "Are you at least 18 years old?", layer: "legal", type: "single_select", answer_shape: "yes_no", kind_default: "policy", jurisdiction_notes: "Age of majority varies; some forms ask 16+ or 21+ for regulated roles." },
  { qid: "q.legal.background_check", text: "Do you consent to a background check if an offer is made?", layer: "legal", type: "single_select", answer_shape: "consent", kind_default: "policy", jurisdiction_notes: "US FCRA requires standalone disclosure; ban-the-box laws restrict timing in many states." },
  { qid: "q.legal.export_control", text: "For export-control purposes, what is your citizenship or US-person status?", layer: "legal", type: "single_select", answer_shape: "select_one", kind_default: "policy", jurisdiction_notes: "US EAR/ITAR: 'U.S. person' = citizen, national, lawful permanent resident, or protected individual." },
  { qid: "q.legal.government_official", text: "Are you, or is a close relative, a government official?", layer: "legal", type: "single_select", answer_shape: "yes_no", kind_default: "policy", jurisdiction_notes: "Anti-bribery screening (FCPA/UK Bribery Act); standard on fintech and crypto forms." },
  { qid: "q.legal.conflict_of_interest", text: "Do you have a relative, partner or close friend working at this company, or another conflict of interest?", layer: "legal", type: "single_select", answer_shape: "yes_no", kind_default: "policy" },
  { qid: "q.legal.application_truthful", text: "Do you certify that the information in this application is true and complete?", layer: "legal", type: "single_select", answer_shape: "consent", kind_default: "policy" },

  // ─── compensation ───────────────────────────────────────────────────────────────────────────
  { qid: "q.comp.expected_salary", text: "What are your base salary expectations?", layer: "comp", type: "text", answer_shape: "money", kind_default: "rule", jurisdiction_notes: "Pay-transparency states publish the band; answer against the posted range where one exists." },
  { qid: "q.comp.expected_salary_min", text: "What is the bottom of your desired base salary range?", layer: "comp", type: "text", answer_shape: "money", kind_default: "rule" },
  { qid: "q.comp.expected_salary_max", text: "What is the top of your desired base salary range?", layer: "comp", type: "text", answer_shape: "money", kind_default: "rule", dependency: { qid: "q.comp.expected_salary_min", condition: "answered" } },
  { qid: "q.comp.current_salary", text: "What is your current compensation?", layer: "comp", type: "text", answer_shape: "money", kind_default: "never", jurisdiction_notes: "Salary-history questions are banned for employers in CA, NY, WA, MA, CO and others; never auto-filled." },
  { qid: "q.comp.range_acknowledgement", text: "Are you comfortable with the salary range posted for this role?", layer: "comp", type: "single_select", answer_shape: "yes_no", kind_default: "rule" },

  // ─── EEO / demographics — never auto-filled (AGENTS.md invariant) ───────────────────────────
  { qid: "q.eeo.gender", text: "What is your gender?", layer: "eeo", type: "single_select", answer_shape: "select_one", kind_default: "never", jurisdiction_notes: "US EEO-1 voluntary self-identification; a UK/EU form asks a different set." },
  { qid: "q.eeo.gender_identity", text: "How do you describe your gender identity, including whether you identify as transgender?", layer: "eeo", type: "single_select", answer_shape: "select_one", kind_default: "never" },
  { qid: "q.eeo.race", text: "What is your race or ethnicity?", layer: "eeo", type: "single_select", answer_shape: "select_one", kind_default: "never", jurisdiction_notes: "US EEOC race/ethnicity categories; the UK uses ONS categories and Canada uses employment-equity groups." },
  { qid: "q.eeo.veteran", text: "What is your protected-veteran status?", layer: "eeo", type: "single_select", answer_shape: "select_one", kind_default: "never", jurisdiction_notes: "US VEVRAA only." },
  { qid: "q.eeo.disability", text: "Do you have a disability, per the voluntary self-identification form?", layer: "eeo", type: "single_select", answer_shape: "select_one", kind_default: "never", jurisdiction_notes: "US OFCCP form CC-305 (Section 503); wording is prescribed by regulation." },
  { qid: "q.eeo.sexual_orientation", text: "What is your sexual orientation, or do you identify as LGBTQ+?", layer: "eeo", type: "single_select", answer_shape: "select_one", kind_default: "never" },
  { qid: "q.eeo.self_id_name", text: "Your name, on the voluntary self-identification form.", layer: "eeo", type: "text", answer_shape: "name", kind_default: "never", dependency: { qid: "q.eeo.disability", condition: "form present" } },
  { qid: "q.eeo.self_id_date", text: "Today's date, on the voluntary self-identification form.", layer: "eeo", type: "date", answer_shape: "date", kind_default: "never", dependency: { qid: "q.eeo.disability", condition: "form present" } },

  // ─── narrative (~12 prompts; the writer expands these, Jev never writes) ────────────────────
  { qid: "q.narrative.why_role", text: "Why are you interested in this role?", layer: "narrative", type: "textarea", answer_shape: "text_long", kind_default: "narrative" },
  { qid: "q.narrative.why_company", text: "Why do you want to work at this company?", layer: "narrative", type: "textarea", answer_shape: "text_long", kind_default: "company" },
  { qid: "q.narrative.proudest_project", text: "What work are you proudest of, and why?", layer: "narrative", type: "textarea", answer_shape: "text_long", kind_default: "narrative" },
  { qid: "q.narrative.hardest_problem", text: "What is the hardest technical problem you have solved?", layer: "narrative", type: "textarea", answer_shape: "text_long", kind_default: "narrative" },
  { qid: "q.narrative.conflict", text: "Tell us about a disagreement with a colleague and how it ended.", layer: "narrative", type: "textarea", answer_shape: "text_long", kind_default: "narrative" },
  { qid: "q.narrative.leadership", text: "Tell us about a time you led others or drove a project without authority.", layer: "narrative", type: "textarea", answer_shape: "text_long", kind_default: "narrative" },
  { qid: "q.narrative.failure", text: "Tell us about a time you failed and what you changed afterwards.", layer: "narrative", type: "textarea", answer_shape: "text_long", kind_default: "narrative" },
  { qid: "q.narrative.exceptional_work", text: "What is the most exceptional thing you have built or done?", layer: "narrative", type: "textarea", answer_shape: "text_long", kind_default: "narrative" },
  { qid: "q.narrative.additional_info", text: "Is there anything else you would like us to know?", layer: "narrative", type: "textarea", answer_shape: "text_long", kind_default: "narrative" },
  { qid: "q.narrative.looking_for", text: "What are you looking for in your next role?", layer: "narrative", type: "textarea", answer_shape: "text_long", kind_default: "narrative" },
  { qid: "q.narrative.cover_letter_text", text: "Paste your cover letter.", layer: "narrative", type: "textarea", answer_shape: "text_long", kind_default: "narrative" },
  { qid: "q.narrative.personal_preferences", text: "What should we know about how you like to work, or anything that would make the process better for you?", layer: "narrative", type: "textarea", answer_shape: "text_long", kind_default: "narrative" },
];

/** @type {Map<string, CanonicalQuestion>} */
export const SEED_BY_ID = new Map(SEED.map((q) => [q.qid, q]));

/** Seed ids, in declaration order (the order the bank is written in). */
export const SEED_IDS = SEED.map((q) => q.qid);

/** @param {string} qid @returns {CanonicalQuestion|undefined} */
export function seedQuestion(qid) {
  return SEED_BY_ID.get(qid);
}

/** Layer implied by an id prefix — used for ids the clusterer mints. */
export function layerOfId(qid) {
  for (const [layer, prefix] of Object.entries(LAYER_PREFIX)) {
    if (String(qid).startsWith(prefix)) return layer;
  }
  return "core";
}

/** Throws on a malformed seed row; called by the clusterer before anything else runs. */
export function checkSeed(rows = SEED) {
  const seen = new Set();
  for (const row of rows) {
    if (!row.qid || seen.has(row.qid)) throw new Error(`canon seed: duplicate or missing qid "${row.qid}"`);
    seen.add(row.qid);
    if (!LAYERS.includes(row.layer)) throw new Error(`canon seed: ${row.qid} has unknown layer "${row.layer}"`);
    if (layerOfId(row.qid) !== row.layer) throw new Error(`canon seed: ${row.qid} prefix does not match layer "${row.layer}"`);
    if (!ANSWER_KINDS.includes(row.kind_default)) throw new Error(`canon seed: ${row.qid} has unknown kind_default "${row.kind_default}"`);
    if (!ANSWER_SHAPES.includes(row.answer_shape)) throw new Error(`canon seed: ${row.qid} has unknown answer_shape "${row.answer_shape}"`);
    if (row.dependency && !seen.has(row.dependency.qid) && !rows.some((r) => r.qid === row.dependency.qid)) {
      throw new Error(`canon seed: ${row.qid} depends on unknown ${row.dependency.qid}`);
    }
  }
  return rows.length;
}
