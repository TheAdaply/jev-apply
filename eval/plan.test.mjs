#!/usr/bin/env node
// Offline-ish acceptance check for the resolve+Jev+gate pipeline (PLAN §4 Phase D), run against the
// two recorded fixtures in eval/fixtures/. "Offline" for the form schema (`--schema` reads the
// recorded JSON, no HTTP to the ATS); the Jev canonical-question and option requests are still live —
// there is no mock decider (AGENTS.md: Jev never guesses, so there is nothing useful to stub).
//
//   node eval/plan.test.mjs
//
// Prints `ok - <assertion>` / `FAIL - <assertion>` per check and exits 1 if any assertion fails.
// Numbers below are what the two fixtures produce against the real memory store; a memory edit
// that removes a row these forms read (work authorization, identity, links, `p.eeo`) is expected
// to move them and should update this file. The Greenhouse fixture's demographic block is the
// clearest case: with `p.eeo` on file those nine rows are `fill`, and with none they are `ask` —
// never `skip`, which is what this file asserted before PLAN D10 changed (docs/CHANGELOG.md).
//
// The third block is the policy the round-1 screenshot judgement changed
// (docs/research/12-eval-judge-round1.md): every assertion in it is a row that judgement graded
// `wrong` or `missing`. It calls the resolver directly, so it needs neither a fixture nor Jev.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classify, dependencyOn, fitsLimits, isAccommodationRequest } from "../src/schema/classes.mjs";
import { countryFromText, countryInQuestion } from "../src/schema/normalize.mjs";
import { optionStating, unmetTopics } from "../src/canon/normalize.mjs";
import { CANON_RULES, ruleAnswer, storyPool } from "../src/jev/plan.mjs";
import { latestEducation, latestEmployment } from "../src/memory/derive.mjs";
import { finalize } from "../src/plan/decisions.mjs";
import { eeoCanonical, resolveForm } from "../src/plan/resolve.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const APPLY = path.join(ROOT, "scripts", "apply.mjs");

/** Any phrasing of the four PLAN §2.7 work-authorization/sponsorship prompts. */
const WORK_AUTH_RE = /authorized to work|work authoriz|sponsor|legally authoriz|require.*visa/i;

let failures = 0;

function check(label, ok) {
  console.log(`${ok ? "ok" : "FAIL"} - ${label}`);
  if (!ok) failures += 1;
}

/** Runs `apply.mjs --dry-run --schema <fixture> --json` and returns the parsed stdout payload. */
function planFixture(fixture) {
  const schema = path.join(ROOT, "eval", "fixtures", fixture);
  const proc = spawnSync(process.execPath, [APPLY, "--dry-run", "--schema", schema, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (proc.error) throw proc.error;
  const line = proc.stdout.trim();
  if (!line) throw new Error(`apply.mjs printed nothing for ${fixture} (exit ${proc.status}): ${proc.stderr}`);
  return JSON.parse(line);
}

/** `tally()` folds fill+check into `filled`, so `filled + asks + drafted + skipped` is every row. */
function rowCount(plan) {
  return plan.filled + plan.asks.length + plan.drafted.length + plan.skipped;
}

// The three rows Greenhouse's own EEOC block asks by these exact labels. They are `fill` whenever
// `p.eeo` states the matching field, which is the D10 policy this file used to assert the opposite
// of (every demographic row `skip`).
const EEOC_RE = /^(gender|race|veteran status)$/i;
// The voluntary demographic *survey* Greenhouse adds on newer boards asks three things `p.eeo` does
// not carry a field for (sexual orientation, transgender status) or asks finer than it does (a race
// list split into East / South / Southeast Asian). Those stay `ask` by design — no stance on file
// and no guessing — so they are counted separately from the plan's own ask budget.
const DEMOGRAPHIC_RE = /how would you describe|do you identify as|veteran or active member|disability or chronic condition/i;

// ─── Greenhouse — Together AI, Research Engineer (togetherai/5179372007) ───────────────────────
{
  const plan = planFixture("greenhouse-togetherai-5179372007.json");
  const asks = plan.asks.filter((q) => !DEMOGRAPHIC_RE.test(q.label));
  check("greenhouse: 22 rows", rowCount(plan) === 22);
  // EEO rows are filled from `p.eeo`, never skipped (PLAN D10): what is left to skip is the
  // optional cover letter and the optional free-text row nothing answers.
  check(`greenhouse: skip <= 2 (got ${plan.skipped})`, plan.skipped <= 2);
  check(
    "greenhouse: the EEOC self-identification rows are filled from p.eeo",
    !plan.asks.some((q) => EEOC_RE.test(q.label)),
  );
  check(`greenhouse: non-demographic asks <= 3 (got ${asks.length})`, asks.length <= 3);
  check(
    "greenhouse: work-auth rows resolved (not in the ask list)",
    !plan.asks.some((q) => WORK_AUTH_RE.test(q.label)),
  );
  // The store now holds a real `f.identity.city`/`f.identity.location` (the judge's §6 "single
  // highest-value user input"), so the board's geocoder gets a place and the row is filled. The
  // rule that produced the old expectation — a work mode is never typed into a geocoder — is
  // asserted deterministically, against its own memory and without the store, in the round-1
  // block below ("a work-mode fact is not a place").
  check(
    "greenhouse: the location row is filled from the stated city, not asked",
    !plan.asks.some((q) => q.qid === "location"),
  );
  // requests <= 2 holds while canon/questions.yaml is absent (saved-item request + options
  // request). Once the canon bank lands, a row whose label misses every canonical id adds a
  // third (story-fallback) request by design — bump this to <= 3 if that starts failing.
  check(`greenhouse: requests <= 2 (got ${plan.requests})`, plan.requests <= 2);
}

// ─── the round-1 policy (docs/research/12-eval-judge-round1.md) ────────────────────────────────
// Deterministic: the resolver is called directly, so these need neither a fixture nor Jev. Every
// assertion below is a row the judgement graded `wrong` or `missing` on a real or synthetic form.
{
  const now = new Date("2026-09-23T00:00:00Z");
  const mem = {
    facts: [
      { id: "f.identity.full_name", value: "T Example", source: "user" },
      { id: "f.identity.location", value: "Remote (no city stated on the CV)", source: "user" },
      { id: "f.identity.pronouns", value: "they/them", source: "user" },
    ],
    preferences: [
      { id: "p.notice_rule", value: { kind: "weeks", weeks: 4, text: "4 weeks' notice" }, source: "user" },
      { id: "p.relocation", value: { willing: true, anywhere_except: ["IN"] }, source: "user" },
    ],
    answers: [],
    stories: [],
    documents: [],
  };
  const questions = [
    { qid: "first", label: "First Name", class: "identity", type: "text", required: true },
    { qid: "last", label: "Last Name", class: "identity", type: "text", required: true },
    { qid: "legal", label: "Full Legal Name", class: "identity", type: "text", required: true },
    { qid: "where", label: "From where do you intend to work?", class: "identity", type: "text", required: true },
    { qid: "pronouns", label: "Pronouns", class: "sensitive", type: "text", required: false },
    { qid: "privacy", label: "Please review and acknowledge Acme's Candidate Privacy Policy", class: "policy_gate", type: "boolean", required: true },
    { qid: "bgcheck", label: "I understand that offers of employment are conditional on a background check", class: "policy_gate", type: "boolean", required: true },
    { qid: "heard", label: "What brought you to this job posting?", class: "circumstance", type: "single_select", required: true, options: [{ label: "LinkedIn" }, { label: "Other" }] },
    { qid: "heard_detail", label: 'If you responded "other" above, let us know how you found this', class: "company_specific", type: "text", required: false, dependency: { parent: "heard", condition: "other" } },
    { qid: "start", label: "What is your earliest possible start date?", class: "circumstance", type: "date", control: "date", required: true },
    { qid: "relocate", label: "Are you willing to relocate? If so, to which entity?", class: "circumstance", type: "multi_select", required: true, options: [{ label: "United Kingdom" }, { label: "I am not willing to relocate." }] },
  ];
  const form = { job: { company: "Acme", title: "Research Engineer", location: "London, United Kingdom", country: "GB" }, questions };
  const row = (qid) => resolveForm(form, { mem, now }).decisions.find((d) => d.qid === qid);

  check("classify: an acknowledgement of a privacy policy is a policy_gate", classify(questions[5].label, "", "boolean", true) === "policy_gate");
  check("classify: a background-check attestation is a policy_gate", classify(questions[6].label, "", "boolean", true) === "policy_gate");
  check("policy gate: asks with no p.legal.* on file, naming the id that closes it", row("privacy").action === "ask" && row("privacy").remember_as?.id === "p.legal.privacy_policy_ack");
  check("policy gate: the background-check attestation asks for its own stored stance", row("bgcheck").remember_as?.id === "p.legal.background_check_consent");

  const stated = { ...mem, preferences: [...mem.preferences, { id: "p.legal.privacy_policy_ack", value: "Yes", source: "user" }] };
  const answered = resolveForm(form, { mem: stated, now }).decisions.find((d) => d.qid === "privacy");
  check("policy gate: an explicit p.legal.<slug> answers it, and only that", answered.action === "fill" && answered.why.startsWith("p.legal.privacy_policy_ack"));

  check("location: a work-mode fact is not a place — the row asks for the city", row("where").action === "ask" && row("where").remember_as?.id === "f.identity.city");
  check("location: 'From where do you intend to work?' reads as a location question", classify(questions[3].label, "", "text", true) === "identity");
  check("name: 'Full Legal Name' fills from the stated full name", row("legal").action === "fill");
  check("name: an initial is the family name, whichever side it is written on", row("first").value === "Example" && row("last").value === "T");
  check("pronouns: filled from f.identity.pronouns with no p.eeo on file", row("pronouns").action === "fill" && row("pronouns").value === "they/them");
  check("dependency: a child whose parent is unanswered is blanked, not filled", row("heard_detail").action === "skip");
  check("dependency: a quoted condition token links the child to its parent", dependencyOn({ label: questions[8].label }, { qid: "heard", type: "single_select" })?.condition === "other");
  check("start date: a date control gets a date, never the notice-period prose", /^\d{4}-\d{2}-\d{2}$/.test(String(row("start").value)));
  check("relocation: a country list is answered with the posting's country", row("relocate").option === "United Kingdom");

  // Limits: parsed off the form's own words and enforced before Submit, never by truncating.
  const long = "word ".repeat(140).trim();
  check("limits: a 140-word answer does not fit a 100-word field", fitsLimits(long, { words: 100 }).ok === false);
  const capped = finalize([{ qid: "essay", class: "essay", action: "fill", value: long, why: "saved answer", _limits: { words: 100 } }]);
  check("limits: an over-length fill is downgraded to check, with the value intact", capped[0].action === "check" && capped[0].value === long);

  // p.auto_draft: the writer takes a why-us prompt instead of handing it back (judge §4.1).
  const asked = [{ qid: "why", class: "why_us", action: "ask", why: "no company answer saved", label: "Why Acme?", _limits: { words: 150 }, _help: "3-4 sentences" }];
  check("auto-draft: absent p.auto_draft leaves the row an ask", finalize(asked, { mem })[0].action === "ask");
  const drafting = { ...mem, preferences: [...mem.preferences, { id: "p.auto_draft", value: true, source: "user" }] };
  const drafted = finalize(asked, { mem: drafting, context: { company: "Acme" } })[0];
  check(
    "auto-draft: p.auto_draft turns a why-us ask into a draft request for the writer",
    drafted.action === "draft" && drafted.draft_request?.kind === "why_us" && drafted.draft_request?.limits?.words === 150,
  );
}

// ─── the round-2 policy (docs/research/13-eval-judge-round2.md) ────────────────────────────────
// Deterministic like the block above, and for the same reason: every assertion is a row that
// judgement graded wrong, or a systematic error it named. N1 (a disability self-identification
// typed into an accommodation box), N3 (a draft written over a question nobody answered), N6 and
// item 9 (two country derivations disagreeing inside one FormPlan).
{
  const now = new Date("2026-09-23T00:00:00Z");
  // A London posting, a candidate in Lisbon: the two facts that made item 9 visible. `f.work_auth.US`
  // deliberately disagrees with `f.work_auth.GB`, so reading the wrong jurisdiction is not
  // survivable by luck the way it was in round 2.
  const mem = {
    facts: [
      { id: "f.identity.full_name", value: "Robin Sanchez", source: "user" },
      { id: "f.identity.city", value: "Lisbon, Portugal", source: "user" },
      { id: "f.work_auth.GB", value: { authorized_now: true, needs_sponsorship_future: false }, source: "user" },
      { id: "f.work_auth.US", value: { authorized_now: false, needs_sponsorship_future: true }, source: "user" },
    ],
    preferences: [
      { id: "p.eeo", value: { gender: "female", disability_status: "yes" }, source: "user" },
      { id: "p.in_office", value: "3 days a week", source: "user" },
    ],
    answers: [],
    stories: [],
    documents: [],
  };

  const VISA = "Do you require any support in obtaining or updating a visa/work permit for the country you are currently in, or your target relocation country?";
  const ACCOM =
    "Helping you bring your best self to the recruitment process means a lot to us. Other than your ethnicity, gender, and disability status (survey below), is there anything you would like to share with us, or information to help us accommodate you?";
  const questions = [
    { qid: "visa", label: VISA, class: "circumstance", type: "single_select", required: true, options: [{ label: "Yes" }, { label: "No" }] },
    { qid: "accom", label: ACCOM, class: classify(ACCOM, "", "textarea", false), type: "textarea", required: false },
    { qid: "freetext", label: "Please tell us anything about your gender that would help us support you", class: "sensitive", type: "textarea", required: false },
    { qid: "selfid", label: "Please self-identify your gender", class: "sensitive", type: "textarea", required: false },
    { qid: "native", label: "Full Legal Name in Native Language", class: "identity", type: "text", required: true },
    { qid: "office", label: "Please select the office(s) you are closest to and/or would be able to commute to", class: "circumstance", type: "multi_select", required: true, options: [{ label: "London" }, { label: "None of the above" }] },
    { qid: "office_hit", label: "Which office location(s) are you interested in?", class: "circumstance", type: "multi_select", required: true, options: [{ label: "Lisbon" }, { label: "Berlin" }] },
    { qid: "days", label: "Which days are you able to be in-office each week?", class: "circumstance", type: "single_select", required: true, options: [{ label: "2 days" }, { label: "3 days" }] },
  ];
  const form = { job: { company: "DeepL", title: "Head of Product Growth", location: "London, United Kingdom", country: "GB" }, questions };
  const planned = resolveForm(form, { mem, now });
  const row = (qid) => planned.decisions.find((d) => d.qid === qid);

  // item 9 — one country per plan. The visa label reads as ", OR" → Oregon → US to the *location*
  // table, which is why it has to be read as prose, and why the posting's own country wins.
  check("country: a question's prose is not read with the location table's state-code rule", countryFromText(VISA) === "US" && countryInQuestion(VISA) === null);
  check("country: the plan derives the posting's country once", planned.context.country === "GB");
  check(
    "work auth: a London posting answers from f.work_auth.GB, never from f.work_auth.US",
    row("visa").why.startsWith("f.work_auth.GB") && !row("visa").why.includes("US"),
  );
  check("country: 'how did you hear about us' is not the United States", countryInQuestion("How did you hear about us?") === null);

  // N1 — an accommodation box never receives a demographic value.
  check("classify: a box that defers ethnicity/gender/disability to a survey is not sensitive", classify(ACCOM, "", "textarea", false) !== "sensitive");
  check(
    "accommodation: with no p.accommodation on file the box asks, and nothing is written into it",
    row("accom").action === "ask" && row("accom").value === undefined && row("accom").remember_as?.id === "p.accommodation",
  );
  const withAccom = { ...mem, preferences: [...mem.preferences, { id: "p.accommodation", value: "No", source: "user" }] };
  const answered = resolveForm(form, { mem: withAccom, now }).decisions.find((d) => d.qid === "accom");
  check("accommodation: p.accommodation answers it, and only that", answered.action === "fill" && answered.value === "No" && answered.why.startsWith("p.accommodation"));
  check(
    "sensitive: a free-text box that does not ask you to self-identify gets no canonical wording",
    row("freetext").action === "ask" && row("freetext").value === undefined,
  );
  check("sensitive: a genuine self-identification prompt still fills from p.eeo", row("selfid").action === "fill" && row("selfid").why.startsWith("p.eeo.gender"));

  // N6 — the two cosmetic/wrong-preference defects.
  check("name: a missing native-script name says 'on file' once", row("native").why === "no name in that script on file");
  check(
    "office: 'which office are you closest to' is geography, not p.in_office",
    row("office").action === "check" && row("office").option === "None of the above" && !row("office").why.includes("p.in_office"),
  );
  check("office: an option naming the city on file is the answer", row("office_hit").action === "fill" && row("office_hit").option === "Lisbon");
  check("office: a schedule question wearing the word 'office' still reaches p.in_office", row("days").why.startsWith("p.in_office"));

  // N7 — non-US veteran wording.
  check(
    "eeo: 'Veteran / Retired' states a saved veteran, and 'Never served' does not",
    eeoCanonical("veteran_status", "Veteran / Retired") === "veteran" && eeoCanonical("veteran_status", "Never served") === "not_veteran",
  );

  // item 8 — option mapping, deterministic and before any model.
  const heard = ["Glassdoor", "Indeed", "LinkedIn Jobs", "LinkedIn Social Post", "Other", "Word of mouth"];
  check("options: a channel the list does not name maps to its own catch-all, not to nothing", JSON.stringify(optionStating("how_heard", "Company careers page", heard)) === '{"label":"Other","exact":false}');
  check("options: a company's own careers page is matched exactly where the list offers it", optionStating("how_heard", "Company careers page", ["Faire's website", "LinkedIn"])?.exact === true);
  check("options: two readings of one answer go to the model, not to a coin toss", optionStating("how_heard", "LinkedIn", heard) === null);
  check("options: 'Other' on a demographic list is a self-describe, never a catch-all", optionStating("eeo_gender", "Woman", ["Man", "Other", "Prefer not to say"]) === null);

  // N3 — auto-draft only where something on file grounds the answer.
  const drafting = { ...mem, preferences: [...mem.preferences, { id: "p.auto_draft", value: true, source: "user" }] };
  const essay = (extra) => finalize([{ qid: "e", class: "essay", action: "ask", why: "open prompt", ...extra }], { mem: drafting, context: { company: "DeepL" } })[0];
  check("auto-draft: an essay with nothing on file behind it stays an ask", essay({ label: "Tell us about a project you are proud of" }).action === "ask");
  check(
    "auto-draft: an essay with a matched story is drafted, as an expand",
    essay({ label: "Tell us about a project you are proud of", story: "b.story.gateway_latency" }).draft_request?.kind === "expand",
  );
  check(
    "auto-draft: a prompt asking which tool you use is never drafted, story or no story",
    essay({ label: "As a PM which AI tool are you using on daily or weekly basis?", story: "b.story.gateway_latency" }).action === "ask",
  );
  check(
    "auto-draft: a why-us prompt is still drafted with nothing saved",
    finalize([{ qid: "w", class: "why_us", action: "ask", why: "no company answer saved", label: "Why DeepL?" }], { mem: drafting, context: { company: "DeepL" } })[0].action === "draft",
  );
}

// ─── the ten-posting round (private/eval-shots/ten/findings.md) ────────────────────────────────
// Mistral's required textarea "What spoken languages are you fluent in?" was classed `essay`,
// handed to the writer, and answered on the live form out of a GPU-inference story. Spoken
// languages are a personal fact: with none on file the row is an `ask`. Deterministic — the
// classifier, `autoDraft` and the resolver, none of which needs Jev or a fixture.
{
  const LANGUAGES = "What spoken languages are you fluent in?";
  // The same form's genuine essay prompt, which must keep drafting: the fix is about facts, not
  // about textareas. Note the typographic apostrophe the board actually serves.
  const PROJECT = "What’s your most complex project with LLM?";

  check("classify: a spoken-languages textarea is a fact, not an essay", classify(LANGUAGES, "", "textarea", true) === "circumstance");
  check("classify: the same form's project prompt is still an essay", classify(PROJECT, "", "textarea", true) === "essay");
  check("classify: 'how many years of Python' in a text box is a fact too", classify("How many years of Python do you have?", "", "text", true) === "circumstance");

  const mem = {
    facts: [],
    preferences: [{ id: "p.auto_draft", value: true, source: "user" }],
    answers: [],
    stories: [],
    documents: [],
  };
  const planned = (row) =>
    finalize([{ qid: "q", action: "ask", why: "open prompt", ...row }], { mem, context: { company: "Mistral.ai" } })[0];

  check(
    "auto-draft: the spoken-languages row is never drafted",
    planned({ class: classify(LANGUAGES, "", "textarea", true), label: LANGUAGES, story: "b.story.gpu_inference" }).action === "ask",
  );
  check(
    "auto-draft: not even wearing the `essay` class it was given in that round",
    planned({ class: "essay", label: LANGUAGES, story: "b.story.gpu_inference" }).action === "ask",
  );
  check(
    "auto-draft: a why-us row on the same form still drafts",
    planned({ class: "why_us", label: "Why do you want to join Mistral.ai?" }).action === "draft",
  );

  // …and end to end through the resolver: no languages fact on file, so the row is handed back
  // with nothing written into it.
  const form = {
    job: { company: "Mistral.ai", title: "Applied Scientist, EMEA", location: "Paris, France" },
    questions: [
      { qid: "langs", label: LANGUAGES, class: classify(LANGUAGES, "", "textarea", true), type: "textarea", control: "textarea", required: true },
    ],
  };
  const langs = resolveForm(form, { mem }).decisions.find((d) => d.qid === "langs");
  check("resolve: with no languages fact on file the row is an ask, and empty", langs.action === "ask" && langs.value === undefined);
}

// ─── E1: the employment / education facts a real CV writes (docs/research/16-eval-judge-ten.md) ─
// Four required rows on three real boards were handed back because the resolver read
// `f.employment.current` / `f.employment.current_title` / `f.education.school` and a store written
// from a CV holds one dated row per role instead. Deterministic: the derivations, the resolver and
// the canonical rule, none of which needs Jev or a fixture.
{
  const now = new Date("2026-09-23T00:00:00Z");
  const cv = (id, value, since) => ({ id, value, since, source: "cv.pdf#p1" });
  const mem = {
    facts: [
      cv("f.employment.northwind", "Staff Inference Engineer — Northwind Compute, Mar 2024 – June 2026. Cut serving cost 30%.", "2024-03"),
      cv("f.employment.lumenbyte", "Backend Engineer — Lumenbyte, Sept 2021 – Feb 2024. Ran the payments API.", "2021-09"),
      cv("f.education.msc_coimbra", "Master of Science, Computer Science — University of Coimbra, Portugal (Sept 2019 – July 2021)", "2019-09"),
    ],
    preferences: [],
    answers: [],
    stories: [],
    documents: [],
  };
  const employment = latestEmployment(mem, now);
  const education = latestEducation(mem, now);

  check(
    "employment: the newest `since:` role is the one read, and its own words state the parts",
    employment.id === "f.employment.northwind" && employment.title === "Staff Inference Engineer" && employment.employer === "Northwind Compute",
  );
  check(
    "employment: a role whose stated range has closed is the most recent one, not the current one",
    employment.current === false && employment.until === "2026-06",
  );
  check(
    "education: the newest degree states its school and its field",
    education.school === "University of Coimbra" && education.field === "Computer Science",
  );

  const ask = (label) => ({ qid: "e", label, class: "identity", type: "text", required: true });
  const form = (label) => ({ job: { company: "Scale AI", title: "Research Engineer", location: "San Francisco, CA", country: "US" }, questions: [ask(label)] });
  const row = (label, store = mem) => resolveForm(form(label), { mem: store, now }).decisions[0];

  check(
    "employment: 'current or most recent job title' is answered from the newest role",
    row("What is your current or most recent job title?").value === "Staff Inference Engineer",
  );
  check(
    "employment: 'current or most recent employer' likewise, and as a check — it is read off prose",
    row("Who is your current or most recent employer?").value === "Northwind Compute" && row("Who is your current or most recent employer?").action === "check",
  );
  check(
    "employment: a bare 'Current company' is not answered with an employer the user has left",
    row("Current company").action === "ask" && row("Current company").value === undefined,
  );

  const employed = { ...mem, facts: [cv("f.employment.westwind", "Inference Engineer — Westwind Labs, Jan 2025 – Present. Owns the serving stack.", "2025-01"), ...mem.facts] };
  check(
    "employment: a role the row says is open does answer 'Current company'",
    row("Current company", employed).value === "Westwind Labs",
  );

  // The canonical route answers the same questions from the same facts, and draws the same line:
  // snowflake's "Where have you most recently worked?" never reaches the deterministic pass.
  const rule = (ref, label) => ruleAnswer(ref, { mem, label });
  check(
    "canon rule: q.core.current_company is evaluated at fill time, not stored as a constant",
    CANON_RULES.get("q.core.current_company") === "employment.employer" && CANON_RULES.get("q.core.education_school") === "education.school",
  );
  check(
    "canon rule: 'where have you most recently worked' resolves to the newest employer",
    rule("employment.employer", "Where have you most recently worked?").value === "Northwind Compute",
  );
  check(
    "canon rule: the same fact does not answer a label that asks only for a current employer",
    rule("employment.employer", "Current employer") === null,
  );
  check(
    "canon rule: the school and the field of study come back from the newest education row",
    rule("education.school", "What college/university did you attend?").value === "University of Coimbra" &&
      rule("education.field", "Field of study").value === "Computer Science",
  );
}

// ─── E3: a topic qualifier is the question (docs/research/16-eval-judge-ten.md) ────────────────
// "What's your most complex project with LLM?" matched the topic-free
// `q.narrative.exceptional_work` and pasted a GPU-kernel physics story into a required field on an
// LLM company's form, with four LLM projects on file.
{
  const PROJECT = "What’s your most complex project with LLM?";
  const GPU_ANSWER = "The most exceptional thing I built was a GPU kernel for CERN's physics inference stack.";
  const LLM_ANSWER = "I built a verifier-gated mixture-of-agents system that routes between language models.";

  check("topics: a topic-free answer does not answer a prompt that names a topic", unmetTopics(PROJECT, GPU_ANSWER).join() === "llm");
  check("topics: an answer that speaks to the topic passes", unmetTopics(PROJECT, LLM_ANSWER).length === 0);
  check("topics: a prompt that narrows itself to nothing gates nothing", unmetTopics("Describe a project you are proud of", GPU_ANSWER).length === 0);

  const mem = {
    facts: [],
    preferences: [],
    answers: [],
    documents: [],
    stories: [
      { id: "b.story.gpu", kind: "story", title: "GPU-accelerated inference for CERN's TMVA SOFIE", tags: ["gpu", "cuda", "cern"], text: "CUDA and ROCm kernels." },
      { id: "b.story.moa", kind: "story", title: "Verifier-gated mixture-of-agents", tags: ["llm", "research"], text: "Routing between language models." },
      { id: "b.story.phishing", kind: "story", title: "Dual-model phishing detector", tags: ["security", "nlp"], text: "A browser extension." },
    ],
  };
  const ids = (label) => storyPool(mem, { label, type: "textarea" }).rows.map((r) => r.id);
  check("story pool: a prompt naming a topic is offered only the items that carry it", ids(PROJECT).join() === "b.story.moa");
  check("story pool: an unqualified prompt still sees every saved item", ids("Describe a project you are proud of").length === 3);
  check(
    "story pool: with nothing on file about the topic the pool is empty, and the row stays an ask",
    ids("Tell us about your most complex embedded firmware project").length === 0,
  );
}

// ─── the live-demo findings (real profile, Together AI 4385540007) ─────────────────────────────
// Five sensitive rows asked on a board whose demographic block is Greenhouse's "U.S. Standard
// Demographic Questions" survey. Three causes, all deterministic and all asserted here: a select
// whose option list the API does not publish (`hispanic_ethnicity`, 0 options, a real select on
// the page — the free-text self-identification guard must not claim it), a survey that splits a
// saved race three ways, and two questions no `p.eeo` field answers at all.
{
  const mem = {
    facts: [],
    preferences: [
      {
        id: "p.eeo",
        value: { gender: "female", hispanic_latino: "no", race: "asian", veteran_status: "veteran", disability_status: "yes", other_demographics: "decline" },
        source: "user",
      },
      { id: "p.accommodation", value: "No", source: "user" },
    ],
    answers: [],
    stories: [],
    documents: [],
  };
  const DECLINE = "I don't wish to answer";
  const RACE_SURVEY = [
    "Black or of African descent",
    "East Asian",
    "Hispanic, Latinx or of Spanish Origin",
    "Indigenous, American Indian or Alaska Native",
    "Middle Eastern or North African",
    "Native Hawaiian or Other Pacific Islander",
    "South Asian",
    "Southeast Asian",
    "White or Caucasian",
    "I prefer to self-describe",
    DECLINE,
  ].map((label) => ({ label }));
  // Lyft asks this as a **required** single-select, and it is not an accommodation request: it
  // asks whether the candidate can do the job (corpus/greenhouse/applied_scientist/lyft-*.json).
  const LYFT = "Can you perform these essential functions of the job with reasonable accommodation?";
  const questions = [
    { qid: "hispanic_ethnicity", label: "Are you Hispanic/Latino?", class: "sensitive", type: "single_select", control: "react_select", required: false, options: [] },
    { qid: "race_survey", label: "How would you describe your racial/ethnic background? (mark all that apply)", class: "sensitive", type: "multi_select", control: "checkbox", required: false, options: RACE_SURVEY },
    { qid: "orientation", label: "How would you describe your sexual orientation? (mark all that apply)", class: "sensitive", type: "multi_select", control: "checkbox", required: false, options: [{ label: "Bisexual and/or pansexual" }, { label: "Heterosexual" }, { label: "Queer" }, { label: DECLINE }] },
    { qid: "transgender", label: "Do you identify as transgender? (select one)", class: "sensitive", type: "single_select", control: "radio", required: false, options: [{ label: "Yes" }, { label: "No" }, { label: DECLINE }] },
    { qid: "essential", label: LYFT, class: classify(LYFT, "", "single_select", true), type: "single_select", required: true, options: [{ label: "Yes" }, { label: "No" }] },
  ];
  const form = { job: { company: "Together AI", title: "Research Engineer", location: "San Francisco, CA", country: "US" }, questions };
  const row = (qid) => resolveForm(form, { mem }).decisions.find((d) => d.qid === qid);

  check(
    "sensitive: a select whose options the API does not publish still gets the canonical wording",
    row("hispanic_ethnicity").action === "fill" && row("hispanic_ethnicity").why.startsWith("p.eeo.hispanic_latino"),
  );
  check(
    "sensitive: a survey that splits a saved race answers from the stated standing decline",
    row("race_survey").action === "fill" && row("race_survey").option === DECLINE && row("race_survey").why.includes("p.eeo.other_demographics"),
  );
  check(
    "sensitive: sexual orientation and transgender answer from p.eeo.other_demographics",
    row("orientation").option === DECLINE && row("transgender").option === DECLINE,
  );
  const noStance = { ...mem, preferences: [{ ...mem.preferences[0], value: { ...mem.preferences[0].value, other_demographics: undefined } }, mem.preferences[1]] };
  const unstated = resolveForm(form, { mem: noStance }).decisions.find((d) => d.qid === "race_survey");
  check("sensitive: with no standing decline on file the split race row still asks", unstated.action === "ask" && unstated.value === undefined);

  // The advisory case: the word "accommodation" alone must never answer a question about the work.
  check("accommodation: 'can you perform these essential functions' is not an accommodation request", isAccommodationRequest(LYFT) === false);
  check(
    "accommodation: a required essential-functions question is never answered from p.accommodation",
    row("essential").action === "ask" && !String(row("essential").why).includes("p.accommodation"),
  );
  check(
    "accommodation: a real request for one is still recognised",
    isAccommodationRequest("Will you require a reasonable accommodation to complete the hiring process which may include technical testing, virtual and in-person style interviews?") === true &&
      isAccommodationRequest("Do you need an accommodation to take part in the hiring process?") === true,
  );
}

// ─── Ashby — Baseten, AI Inference Engineer (baseten/db6477fc) ─────────────────────────────────
{
  const plan = planFixture("ashby-baseten-db6477fc.json");
  check("ashby: 8 rows", rowCount(plan) === 8);
  check(`ashby: ask <= 1 (got ${plan.asks.length})`, plan.asks.length <= 1);
}

if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall assertions passed");
