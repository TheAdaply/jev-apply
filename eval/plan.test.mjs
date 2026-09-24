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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classify, dependencyOn, fitsLimits, isAccommodationRequest } from "../src/schema/classes.mjs";
import { countryFromText, countryInQuestion, countryOfLocation, detectAts, loadFormPlan } from "../src/schema/normalize.mjs";
import { normalizeAshby } from "../src/schema/ashby.mjs";
import { normalizeGreenhouse } from "../src/schema/greenhouse.mjs";
import { optionStating, unmetTopics } from "../src/canon/normalize.mjs";
import { NONE } from "../src/jev/client.mjs";
import { GATES } from "../src/jev/gates.mjs";
import { CANON_RULES, applyRephrasing, applyResumePick, countryOption, noClearFit, resumeCriterion, ruleAnswer, storyPool } from "../src/jev/plan.mjs";
import { distinctiveLines, profileLines, resumeDigest } from "../src/memory/resume-text.mjs";
import { ID_CATALOGUE } from "../src/memory/schema.mjs";
import { latestEducation, latestEmployment } from "../src/memory/derive.mjs";
import { applyAnswers, finalize, formFingerprint, publicDecision, refillGuard, withFormFacts } from "../src/plan/decisions.mjs";
import { inferBlocked, inferRows, inferredMemoryRows } from "../src/plan/infer.mjs";
import { acceptHostDrafts, chooseStories, hostDraft } from "../src/plan/draft.mjs";
import { boardAdapter, deferredMount, matchLiveControls, observedMatches, restoreRetried, rowOrder, samePlace } from "../src/plan/execute.mjs";
import { atsFromUrl } from "../src/browser/adapters/index.mjs";
import { pickSuggestion, setField as leverSetField } from "../src/browser/adapters/lever.mjs";
import { RULES, preflight, submitGate } from "../src/plan/preflight.mjs";
import { appliedBeforeFor, asksAboutThisEmployer, eeoCanonical, eeoMapFor, employersNamed, policySlug, relocationAnswer, resolveForm, workAuthAnswer } from "../src/plan/resolve.mjs";
import { catalogueValue, idCriteria, idDecision } from "../scripts/remember.mjs";
import { expectedRows } from "../src/bench/shots.mjs";
import { windowsChromeCandidates } from "../src/browser/chrome.mjs";

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

/** Runs `apply.mjs --dry-run --schema <fixture> --json [extra…]` and returns the parsed payload. */
function planFixture(fixture, extra = []) {
  const schema = path.join(ROOT, "eval", "fixtures", fixture);
  const proc = spawnSync(process.execPath, [APPLY, "--dry-run", "--schema", schema, "--json", ...extra], {
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
  // Budget: saved-item request + options request, plus the evidence tier's two batched requests
  // (gather/propose, justify) when any row is still open — never more than 4 on this fixture.
  check(`greenhouse: requests <= 4 (got ${plan.requests})`, plan.requests <= 4);
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
// 12 rows since the recorded document gained its `surveyForms` block: eight application fields
// and the four `_systemfield_eeoc_*` rows the survey renders (A4, asserted row by row below).
{
  const plan = planFixture("ashby-baseten-db6477fc.json");
  check("ashby: 12 rows", rowCount(plan) === 12);
  check(`ashby: ask <= 1 (got ${plan.asks.length})`, plan.asks.length <= 1);
}

// ─── regression guards — the submit preflight (src/plan/preflight.mjs) ─────────────────────────
//
// One assertion per failure class the preflight refuses to submit on. Each starts from
// `eval/fixtures/preflight-decisions-clean.json` — a frozen record for an invented person that
// passes every rule that has an input — and changes exactly one row, so a guard that fires can only be firing on
// the defect it names. Deterministic: no fixture fetch, no Jev, no browser, no real memory.
//
// The class names are the ones docs/POSTMORTEM.md indexes. Every one of them is a row a graded
// round put in front of a real employer (docs/research/12…16, private/eval-shots/*): a demographic
// answered from a story, an attestation ticked from the answer bank, a draft nobody checked
// answers its own question, a work mode typed into a geocoder, prose in a date picker, a
// conditional child answered under a No, a required control left empty, a write the page never
// confirmed, a name split apart while the user had stated both halves.
{
  const fixture = (name) => JSON.parse(readFileSync(path.join(ROOT, "eval", "fixtures", name), "utf8"));
  const FORM = fixture("preflight-form.json");
  const MEM = fixture("preflight-memory.json");
  const CLEAN = fixture("preflight-decisions-clean.json");

  /** The clean record with one row replaced by `patch` (`null` deletes the row). */
  const withRow = (qid, patch) =>
    CLEAN.decisions.map((d) => (d.qid === qid ? (patch === null ? null : { ...d, ...patch }) : { ...d })).filter(Boolean);

  const run = (decisions, { questions = FORM.questions, mem = MEM, live = null, submit = null } = {}) => preflight({ decisions, questions, mem, live, submit });
  /** Did exactly this rule refuse, and did it say so in one actionable line naming the row? */
  const refused = (report, rule, qid) => {
    const hit = report.failures.find((f) => f.rule === rule && (qid === undefined || f.qid === qid));
    return (
      report.ok === false &&
      Boolean(hit) &&
      hit.message.length > 40 &&
      !hit.message.includes("\n") &&
      hit.message.includes(hit.label.slice(0, 12))
    );
  };

  const clean = run(CLEAN.decisions);
  check(
    `guard: preflight — the clean record passes every rule it has an input for (checked ${clean.checked.length}, unchecked ${clean.unchecked.length})`,
    clean.ok === true && clean.checked.length === RULES.length - 1 && clean.unchecked.map((u) => u.rule).join() === "overlay_over_submit",
  );

  check(
    "guard: sensitive_source — a demographic row filled from a saved story is refused",
    refused(run(withRow("gender", { source: "story", why: "b.story.latency" })), "sensitive_source", "gender"),
  );
  check(
    "guard: sensitive_source — p.eeo and the user's own answer are the two sources it accepts",
    run(withRow("gender", { source: "user", why: "you answered — remembered" })).ok === true &&
      run(withRow("gender", { source: "answer", why: "q.eeo.gender (canon)" })).failures.some((f) => f.rule === "sensitive_source"),
  );

  check(
    "guard: policy_gate_source — an attestation ticked from the canonical answer bank is refused",
    refused(run(withRow("privacy_ack", { source: "answer", why: "q.legal.privacy_consent (canon)" })), "policy_gate_source", "privacy_ack"),
  );
  check(
    "guard: policy_gate_source — the p.legal.<slug> stance the user signed passes, a neighbouring preference does not",
    clean.ok === true && run(withRow("privacy_ack", { why: "p.eeo.other_demographics (global)" })).failures.some((f) => f.rule === "policy_gate_source"),
  );
  // `SENSITIVE_RE` claims a pronouns field, but `pronounRow()` answers it from the volunteered
  // `f.identity.pronouns` fact when no `p.eeo` block carries one — a phrase the user wrote on
  // their own CV, and the one sensitive-classed row this rule must not hold a submit over.
  check(
    "guard: sensitive_source — a pronouns row stated as f.identity.pronouns passes; any other fact does not",
    run([...CLEAN.decisions, { qid: "pronouns", label: "Pronouns", class: "sensitive", source: "fact", action: "fill", topic: "eeo", why: "f.identity.pronouns", value: "they/them" }]).ok === true &&
      run([...CLEAN.decisions, { qid: "pronouns", label: "Pronouns", class: "sensitive", source: "fact", action: "fill", topic: "eeo", why: "f.identity.full_name", value: "they/them" }]).failures.some(
        (f) => f.rule === "sensitive_source" && f.qid === "pronouns",
      ),
  );

  check(
    "guard: draft_gates — a draft carrying no relevance verdict is refused",
    refused(run(withRow("why_us", { gates: undefined })), "draft_gates", "why_us"),
  );
  check(
    "guard: draft_gates — a narrative draft needs both gates; why_us is exempt from the grounding one only",
    run(withRow("why_us", { gates: { kind: "narrative", draft: 0.9 } })).failures.some((f) => f.rule === "draft_gates") &&
      run(withRow("why_us", { gates: { kind: "narrative", draft: 0.9, grounding: 0.8 } })).ok === true,
  );

  check(
    "guard: fact_from_writer — a fact about the user composed by the writer is refused",
    refused(run(withRow("languages", { source: "writer", why: "drafted from your saved facts and stories" })), "fact_from_writer", "languages"),
  );

  check(
    "guard: dependency_child_filled — a child answered while its parent is still open is refused",
    refused(
      run(
        withRow("restrictive", { action: "ask", source: "none", value: undefined, option: undefined }).map((d) =>
          d.qid === "restrictive_detail" ? { ...d, action: "fill", source: "user", value: "None." } : d,
        ),
      ),
      "dependency_child_filled",
      "restrictive_detail",
    ),
  );
  check(
    "guard: dependency_child_filled — a child answered under a parent that says No is refused, and passes under Yes",
    refused(run(withRow("restrictive_detail", { action: "fill", source: "user", value: "None." })), "dependency_child_filled", "restrictive_detail") &&
      run(
        withRow("restrictive_detail", { action: "fill", source: "user", value: "A one-year non-solicit." }).map((d) =>
          d.qid === "restrictive" ? { ...d, value: "Yes", option: "Yes" } : d,
        ),
      ).ok === true,
  );

  check(
    "guard: work_mode_as_location — a work mode in the location row is refused, a city is not",
    refused(run(withRow("location", { value: "Remote" })), "work_mode_as_location", "location") && clean.ok === true,
  );

  check(
    "guard: prose_into_date_control — a date control holding prose is refused, an ISO day is not",
    refused(run(withRow("start_date", { value: "Immediately" })), "prose_into_date_control", "start_date") &&
      run(withRow("start_date", { value: "2027-01-04" })).ok === true,
  );

  check(
    "guard: required_empty — a required row the plan leaves open is refused",
    refused(run(withRow("languages", { action: "ask", source: "none", value: undefined, readback: undefined })), "required_empty", "languages"),
  );
  check(
    "guard: B2 required_empty — the live snapshot outranks the plan: a control empty on the page refuses the submit",
    run(CLEAN.decisions, {
      live: { unfilled: [{ row: { label: "Start date" }, decision: { qid: "start_date", label: "Start date" } }], unknown: [] },
    }).failures.some((f) => f.rule === "required_empty" && f.qid === "start_date") &&
      run(CLEAN.decisions, { live: { unfilled: [], unknown: [{ qid: "new_row", label: "If other, please specify" }] } }).failures.some(
        (f) => f.rule === "required_empty" && f.qid === "new_row",
      ),
  );

  check(
    "guard: readback_failed — a write the page never confirmed is refused",
    refused(run(withRow("first_name", { readback: { ok: false, observed: "", attempts: 2 } })), "readback_failed", "first_name"),
  );

  check(
    "guard: name_split_blind — a name split out of the full name is refused while both halves are on file",
    refused(run(withRow("first_name", { why: "first name split from f.identity.full_name" })), "name_split_blind", "first_name"),
  );
  check(
    "guard: name_split_blind — with no first/last fact stated, the same split is the only answer there is",
    run(withRow("first_name", { why: "first name split from f.identity.full_name" }), {
      mem: { ...MEM, facts: MEM.facts.filter((f) => !/first_name|last_name/.test(f.id)) },
    }).ok === true,
  );

  check(
    "guard: preflight — a rule with no input to run on is reported unchecked, never passed silently",
    (() => {
      const bare = preflight({ decisions: CLEAN.decisions });
      const names = bare.unchecked.map((u) => u.rule);
      return (
        bare.ok === true &&
        names.includes("dependency_child_filled") &&
        names.includes("prose_into_date_control") &&
        names.includes("required_empty") &&
        names.includes("name_split_blind") &&
        names.includes("overlay_over_submit") &&
        bare.checked.length + bare.unchecked.length === RULES.length
      );
    })(),
  );

  // The gate as the runner calls it before step 12. A refusal must be a *no-click* marker: the
  // runner returns it instead of pressing Submit, `settle()` renders it as
  // `blocked{reason:"preflight"}`, and `clicked:false` keeps the double-submit guard saying this
  // posting was never attempted — a gate that cost the user their retry would be worse than none.
  check(
    "guard: B1 submit_preflight — a refused submit is a no-click marker carrying every failure",
    (() => {
      const bad = submitGate({ decisions: withRow("gender", { source: "story" }), questions: FORM.questions, mem: MEM });
      const good = submitGate({ decisions: CLEAN.decisions, questions: FORM.questions, mem: MEM });
      return (
        bad.ok === false &&
        bad.refusal.clicked === false &&
        bad.refusal.ok === false &&
        bad.refusal.cause === "preflight" &&
        bad.refusal.preflight.failures.length === bad.report.failures.length &&
        bad.refusal.detail === bad.report.failures[0].message &&
        good.ok === true &&
        good.refusal === null
      );
    })(),
  );

  // The CLI the user actually runs, over the fixture whose one defect is a demographic row filled
  // from a story: one JSON object on stdout, `ok:false`, and the rule named in it.
  check(
    "guard: sensitive_source — scripts/preflight.mjs refuses the tainted record and names the rule",
    (() => {
      const proc = spawnSync(process.execPath, [path.join(ROOT, "scripts", "preflight.mjs"), "--file", path.join(ROOT, "eval", "fixtures", "preflight-decisions-tainted.json")], {
        cwd: ROOT,
        encoding: "utf8",
      });
      const out = JSON.parse(proc.stdout);
      return proc.status === 0 && out.ok === false && out.failures.length === 1 && out.failures[0].rule === "sensitive_source";
    })(),
  );
}

// ─── regression guards — the classes docs/POSTMORTEM.md §2 still prints as open ────────────────
//
// The preflight above refuses a *submit*; these eight classes are decided long before it, in the
// resolver and the classifier, and none of them is fixed in-tree. A guard that asserted the fix
// would be red, and a guard that asserted the wrong value a form received would cement it — so
// each one pins the **safe half** that holds today (the row asks, or the answer is right) and
// names what is still open in its own line. When somebody lands the fix, the `(open: …)` clause
// is what tells them this assertion has to be rewritten rather than deleted.
//
// Deterministic: the resolver, the classifier and the derivations, none of which needs Jev, a
// fixture or a browser.
{
  const question = (qid, label, options = ["Yes", "No"]) => ({
    qid,
    label,
    required: true,
    type: "single_select",
    control: "radio",
    selector: `#${qid}`,
    options: options.map((l) => ({ label: l, value: l })),
    class: classify(label, "", "single_select", true),
  });
  const plan = (questions, { company = "Snowflake", country = "US" } = {}) => ({
    ats: "greenhouse",
    url: "https://job-boards.greenhouse.io/acme/jobs/1",
    job: { title: "Engineer", company, description: "We run things.", country },
    questions,
  });
  const store = {
    facts: [
      { id: "f.citizenship", value: "DE", source: "user" },
      { id: "f.identity.full_name", value: "Robin Sanchez", source: "user" },
      { id: "f.work_auth.default", value: { authorized_now: false, needs_sponsorship_future: true }, source: "user" },
    ],
    preferences: [
      { id: "p.eeo", value: { race: "asian" }, source: "user" },
      { id: "p.eeo.other_demographics", value: "decline", source: "user" },
      { id: "p.relocation", value: { willing: true, anywhere_except: ["IN"] }, source: "user" },
    ],
    answers: [],
    stories: [],
    documents: [],
  };
  const rowFor = (q, { pipeline = null } = {}) => resolveForm(plan([q]), { mem: store, pipeline }).decisions[0];

  // Every label below is the board's own, copied from the frozen record the judgement graded, so
  // each guard runs through the same branch the defect ran through.
  const pwc = rowFor(
    question(
      "pwc",
      "Due to SEC auditor independence requirements, please let us know whether you have previously worked at, or if currently working at PricewaterhouseCoopers (PwC), who is our independent auditor.",
      ["Yes - I have previously worked at, or is currently working at PwC", "No - I have never been employed by PwC"],
    ),
  );
  check(
    "guard: B4 third_party_employer_from_pipeline — an employment-history row is answered from the pipeline only when the label names *this* company or puts it in the first person; PwC asks",
    appliedBeforeFor(null, "Snowflake").value === null &&
      pwc.action === "ask" &&
      pwc.value === undefined &&
      asksAboutThisEmployer("Have you ever worked for us before?", "Snowflake") === true &&
      asksAboutThisEmployer("Have you previously applied to Snowflake?", "Snowflake") === true &&
      asksAboutThisEmployer(
        "Due to SEC auditor independence requirements, please let us know whether you have previously worked at PricewaterhouseCoopers (PwC).",
        "Snowflake",
      ) === false,
  );

  const exportRow = rowFor(
    question(
      "export",
      "A “U.S. person” is a citizen, legal permanent resident, or legal temporary resident (i.e., a refugee or asylee) of the United States. Which of the following best describes your “U.S. person” status?",
      ["I am a U.S. person", "I am a citizen of Cuba, Iran, North Korea, or Syria AND I am NOT a U.S. person", "None of the above; I am a citizen of a different country"],
    ),
  );
  check(
    "guard: B5 citizenship_blind_export_control — an export-control status row is answered from f.citizenship + f.work_auth as a check, never from a neighbouring fact and never by position",
    exportRow.action === "check" &&
      exportRow.source === "derived" &&
      exportRow.option === "None of the above; I am a citizen of a different country" &&
      /f\.citizenship/.test(exportRow.why) &&
      /f\.work_auth/.test(exportRow.why),
  );

  // B6 is the one class in this block whose fix is in the tree: tenstorrent's Cyprus label — a
  // country the posting itself never names — now reaches `p.relocation` and is answered Yes,
  // while the exception list and an explicit `to[]` still decide the No cases.
  check(
    "guard: B6 relocation_label_country_unknown — a country named only in the label reaches p.relocation (Yes), an excepted country and one outside an explicit to[] are No",
    relocationAnswer({ willing: true, anywhere_except: ["IN"] }, "IN") === "No" &&
      relocationAnswer({ willing: true, anywhere_except: ["IN"] }, "DE") === "Yes" &&
      relocationAnswer({ willing: true, to: ["DE"] }, "FR") === "No" &&
      relocationAnswer({ willing: false }, "DE") === "No" &&
      countryInQuestion("Are you currently based in Cyprus, or open to relocating there for this role?") === "CY" &&
      (() => {
        const cy = rowFor(question("cyprus", "Are you currently based in Cyprus, or open to relocating there for this role?"));
        return (cy.option ?? cy.value) === "Yes" && /p\.relocation/.test(cy.why);
      })(),
  );

  const confirm = rowFor(question("confirm", "Have you added your full legal name and surname (including any middle names)?"));
  check(
    "guard: B7 shape_mismatch_into_select — a Yes/No confirmation is answered Yes from the presence of the fact behind it, and never fed the name string itself",
    (confirm.option ?? confirm.value) === "Yes" &&
      confirm.action === "fill" &&
      /f\.identity\.full_name/.test(confirm.why) &&
      !/Robin|Sanchez/.test(`${confirm.value} ${confirm.option ?? ""}`),
  );
  // The other half of the same class, and the one that actually reached a live form: graphcore's
  // "right to work status" list is a *category*, and it was handed the work-authorization Yes/No
  // (`check`, so it would have been written). The invariant that must hold whatever answers it:
  // a row never carries a value its own option list does not state.
  const statusSelect = rowFor(
    question("rtw", "Please select your right to work status", ["British or Irish Citizen", "EU Pre-Settled Status", "EU Settled Status", "Indefinite leave to remain (ILR)"]),
  );
  check(
    "guard: B7 shape_mismatch_into_select — a categorical status select never carries a value its own options do not state; with no matching status on file it asks",
    (() => {
      const stated = ["British or Irish Citizen", "EU Pre-Settled Status", "EU Settled Status", "Indefinite leave to remain (ILR)"];
      const held = statusSelect.option ?? statusSelect.value ?? null;
      return held === null ? statusSelect.action === "ask" : stated.includes(held);
    })(),
  );

  const split = rowFor(
    question("race", "How would you describe your racial identity? (mark all that apply)", ["East Asian", "South Asian", "Southeast Asian", "I don’t wish to answer"]),
  );
  check(
    "guard: B9 eeo_split_token_undisclosed — when a form splits one saved EEO token across options, the row's own `why` says so and names the preference it came from",
    split.class === "sensitive" && /p\.eeo\.race/.test(split.why) && /\b[23]\b[^.]*options state it|splits your saved race/.test(split.why),
  );
  check(
    "guard: B8 race_conditional_on_hispanic — a demographic row is planned as a fill from p.eeo, and one the page never confirmed cannot be submitted",
    eeoMapFor("Race")?.field === "race" &&
      preflight({
        decisions: [{ qid: "race", label: "Race", class: "sensitive", source: "preference", action: "fill", why: "p.eeo.race (global)", value: "Asian", readback: { ok: false, observed: "", attempts: 2 } }],
      }).failures.some((f) => f.rule === "readback_failed" && f.qid === "race"),
  );

  const notice = rowFor(
    question(
      "age_notice",
      "In any materials you submit, you may redact or remove age-identifying information such as age, date of birth, or dates of school attendance or graduation. You will not be penalized for redacting or removing this information.",
      ["I Acknowledge"],
    ),
  );
  check(
    "guard: B10 age_notice_as_sensitive — a notice offering redaction of a protected characteristic is a policy_gate answered from p.legal.age_redaction_ack alone, and asks while that row is absent",
    notice.class === "policy_gate" &&
      notice.action === "ask" &&
      notice.source === "none" &&
      notice.remember_as?.id === "p.legal.age_redaction_ack" &&
      policySlug(
        "In any materials you submit, you may redact or remove age-identifying information such as age, date of birth, or dates of school attendance or graduation.",
      ) === "age_redaction_ack",
  );

  const authed = workAuthAnswer("authorized", { authorized_now: false, needs_sponsorship_future: true }, "US");
  const ukRow = rowFor(question("uk_auth", "Do you have the legal right to work in the United Kingdom?"));
  check(
    "guard: B11 why_text_misleading — the work-auth answer, the sentence request 2 matches against and the user-facing `why` all state the fact's value, never its field name",
    authed.value === "No" &&
      /not currently legally authorized/i.test(authed.answerText) &&
      (ukRow.option ?? ukRow.value) === "No" &&
      /\(authorized: No\)/.test(ukRow.why) &&
      !/\(authorized\)/.test(ukRow.why),
  );

  // B2, B3, B12 and B14 used to be named here as "no deterministic assertion can carry this yet".
  // All four now carry one, in the closing block of this file: `required` on the frozen row, the
  // sensitive read-back verdict, the submit control's geometry, and the host writer's two gates.
  // B13 (captcha) is asserted where it belongs, in scripts/submit-smoke.mjs, and is not rebuilt here.
}

// ─── docs/research/17-eval-judge-ten2.md §3 F1–F7, each closed ────────────────────────────────
// One assertion per finding, on the board's own label, through the same branch the defect ran
// through. F1 is B4 above, F5 is B11, F6 is B10 — those three rewrote the guard that pinned the
// open behaviour rather than adding a second one.
{
  const question = (qid, label, options = ["Yes", "No"], extra = {}) => ({
    qid,
    label,
    required: true,
    type: "single_select",
    control: "radio",
    selector: `#${qid}`,
    options: options.map((l) => ({ label: l, value: l })),
    class: classify(label, extra.help ?? "", extra.type ?? "single_select", true),
    ...extra,
  });
  const store = {
    facts: [
      { id: "f.citizenship", value: "DE", source: "user" },
      { id: "f.identity.full_name", value: "Robin Sanchez", source: "user" },
      { id: "f.identity.github_url", value: "https://github.com/example", source: "user" },
      { id: "f.identity.site_url", value: "https://example.dev", source: "user" },
      { id: "f.work_auth.default", value: { authorized_now: false, needs_sponsorship_future: true }, source: "user" },
    ],
    preferences: [],
    answers: [],
    stories: [],
    documents: [],
  };
  const rowFor = (q, mem = store) =>
    resolveForm(
      {
        ats: "greenhouse",
        url: "https://job-boards.greenhouse.io/acme/jobs/1",
        job: { title: "Engineer", company: "Cerebras", description: "We run things.", country: "US" },
        questions: [q],
      },
      { mem },
    ).decisions[0];

  // F2 — the status row answers, the attestation beside it does not.
  const cerebras = rowFor(
    question(
      "52ef2dc3",
      "Cerebras products, software, source code, technology, and/or services are subject to the U.S. Export Administration Regulations (EAR). Cerebras can be required to perform an export compliance assessment to review if an individual is a U.S. person. In order to comply with these regulations (and for no other reason), we are asking you to confirm citizenship and permanent residency as defined below. Please check the field that applies to you:",
      [
        "I am a U.S. person – this includes any individual who is a citizen of the United States, a permanent resident alien of the United States, or a protected individual as defined by 8 U.S.C. 1324b(a)(3).",
        "I am not a U.S. person, and I am not a current citizen or permanent resident of Cuba, Iran, North Korea, or Syria.",
        "I am not a U.S. person, and I am a current citizen or permanent resident of Cuba, Iran, North Korea, or Syria.",
      ],
    ),
  );
  const attestation = rowFor(
    question("10595218007", "I have read and understand the Export Control statement included in the job description above."),
  );
  check(
    "F2 export_control_status — a U.S.-person status list picks the denial that also matches the citizenship, and the attestation beside it still asks",
    cerebras.action === "check" &&
      cerebras.option === "I am not a U.S. person, and I am not a current citizen or permanent resident of Cuba, Iran, North Korea, or Syria." &&
      attestation.action === "ask" &&
      attestation.option === undefined,
  );
  check(
    "F2 export_control_status — a citizen of one of the four sanctioned countries takes that option instead, and a US citizen takes the U.S.-person one",
    rowFor(
      question("52ef2dc3", "Which of the following best describes your “U.S. person” status?", [
        "I am a U.S. person",
        "I am a citizen of Cuba, Iran, North Korea, or Syria AND I am NOT a U.S. person",
        "None of the above; I am a citizen of a different country",
      ]),
      { ...store, facts: store.facts.map((f) => (f.id === "f.citizenship" ? { ...f, value: "IR" } : f)) },
    ).option === "I am a citizen of Cuba, Iran, North Korea, or Syria AND I am NOT a U.S. person" &&
      rowFor(
        question("52ef2dc3", "Which of the following best describes your “U.S. person” status?", [
          "I am a U.S. person",
          "I am a citizen of Cuba, Iran, North Korea, or Syria AND I am NOT a U.S. person",
          "None of the above; I am a citizen of a different country",
        ]),
        { ...store, facts: store.facts.map((f) => (f.id === "f.citizenship" ? { ...f, value: "US" } : f)) },
      ).option === "I am a U.S. person",
  );

  // F3 — the country table knows the places these labels name, which is what makes the preference
  // answer. The fix is the table, not a looser rule: with the destination still unknown an
  // exception list cannot be ruled out, so that case stays an ask.
  check(
    "F3 country_table — the EU/EEA and GCC members a relocation label names map to a code, and an unmappable destination is still an ask, never a default Yes",
    countryInQuestion("open to relocating to Cyprus?") === "CY" &&
      countryInQuestion("based in Malta") === "MT" &&
      countryInQuestion("relocate to Riyadh, Saudi Arabia") === "SA" &&
      countryFromText("Tallinn, Estonia") === "EE" &&
      relocationAnswer({ willing: true, anywhere_except: ["IN"] }, "CY") === "Yes" &&
      relocationAnswer({ willing: true, anywhere_except: ["IN"] }, null) === null &&
      relocationAnswer({ willing: true, to: ["DE"] }, null) === null,
  );

  // F4 — a categorical status select is resolved from the fact's category, never from the Yes/No
  // the sibling row derived, and never by position.
  const status = rowFor(
    question("37324683002", "Please select your right to work status", [
      "British or Irish Citizen",
      "EU Settled Status",
      "Indefinite leave to remain (ILR)",
      "Skilled worker or Tier 2 (General) Visa",
      "Other",
    ]),
  );
  check(
    "F4 status_select_shape — a right-to-work status list takes the residual entry when the fact says no listed status applies, never the sibling row's 'No'",
    status.action === "check" &&
      status.option === "Other" &&
      /f\.work_auth\.default/.test(status.why) &&
      status.value !== "No",
  );
  check(
    "F4 status_select_shape — with no residual entry to take, the same list asks rather than picking one",
    rowFor(
      question("37324683002", "Please select your right to work status", ["British or Irish Citizen", "EU Settled Status"]),
    ).action === "ask",
  );
  const gate = rowFor(question("gate", "Have you provided consent to our Candidate Privacy Notice?"));
  check(
    "F4 confirmation_shape — the confirmation rule never diverts a policy_gate: an attestation phrased as one still asks for its own p.legal.<slug>",
    gate.class === "policy_gate" &&
      gate.action === "ask" &&
      gate.remember_as?.id === "p.legal.privacy_policy_ack",
  );

  // F7 — an optional links box is an identity row, answered from the link facts on file.
  const links = rowFor(
    question("c0de7d81", "Social Network and Web Links", [], {
      required: false,
      type: "textarea",
      control: "textarea",
      help: "Provide us with links to see some of your work (Git/ Blog/ Medium)",
    }),
  );
  const noLinks = rowFor(
    question("c0de7d81", "Social Network and Web Links", [], { required: false, type: "textarea", control: "textarea" }),
    { ...store, facts: store.facts.filter((f) => !/_url$/.test(f.id)) },
  );
  check(
    "F7 optional_links_skipped — a links box answers from every f.identity.* link fact on file, and only says 'no saved item' when none is",
    links.class === "identity" &&
      links.action === "fill" &&
      /f\.identity\.github_url/.test(links.why) &&
      /f\.identity\.site_url/.test(links.why) &&
      String(links.value).split("\n").length === 2 &&
      noLinks.action === "skip" &&
      /no link facts on file/.test(noLinks.why),
  );

  // The answer key carries the form's own `required` flag, so a judgement no longer reads it off
  // an asterisk in a screenshot (§2d flipped a submit verdict on exactly that).
  const key = expectedRows(
    [
      { qid: "a", label: "First Name", class: "identity", action: "fill", value: "Robin", source: "fact", why: "f.identity.first_name" },
      { qid: "b", label: "In office?", class: "circumstance", action: "ask", source: "none", why: "no p.in_office on file" },
      { qid: "c", label: "Unknown to every source", class: "company_specific", action: "ask", source: "none", why: "x" },
    ],
    new Map([
      ["a", { control: "text", required: true }],
      ["b", { control: "react_select", required: false }],
    ]),
  );
  check(
    "answer key — expectedRows emits `required` from the field index, and null (not false) where no source knew",
    key[0].required === true && key[1].required === false && key[2].required === null,
  );
}

// ─── the last REQUIRED guards in docs/POSTMORTEM.md, each closed ──────────────────────────────
//
// One assertion per class id, on the rule that closes it. Deterministic: every one of these calls
// a pure function or the preflight directly — no fixture fetch, no Jev, no browser, no store. The
// one model-shaped seam (the host writer's relevance gates) is injected, because what is asserted
// there is that the gates run and that their verdict decides, not what a model says.
{
  // A4 — the Ashby document requests `surveyForms`, so the EEO block exists in the plan at all.
  // Asserted row by row rather than by count: a block that is present but classed anything other
  // than `sensitive` would be filled from the wrong source, which is the failure A12 names.
  const ashby = normalizeAshby(
    JSON.parse(readFileSync(path.join(ROOT, "eval", "fixtures", "ashby-baseten-db6477fc.json"), "utf8")),
    "https://jobs.ashbyhq.com/baseten/db6477fc/application",
  );
  const eeoc = ashby.questions.filter((q) => /^_systemfield_eeoc_/.test(q.qid));
  check(
    "A4 survey_block_unreachable — the Ashby survey's _systemfield_eeoc_* rows are in the plan and every one of them is classed sensitive",
    eeoc.length >= 3 &&
      eeoc.every((q) => q.class === "sensitive") &&
      ["gender", "race", "veteran_status"].every((f) => eeoc.some((q) => q.qid === `_systemfield_eeoc_${f}`)) &&
      eeoc.every((q) => (q.options ?? []).length >= 2),
  );

  // A11 — the sentence the user reads. A row the retry committed may not keep the first
  // attempt's complaint, with or without the `_was` memory of what it was before.
  const committed = {
    qid: "race",
    action: "ask",
    why: "the form would not take it (control_not_found) — intended: ••••",
    shot: "applications/x/race.png",
    readback: { ok: true, observed: "", attempts: 1, observed_matches: true },
  };
  restoreRetried(committed);
  const remembered = { qid: "gender", action: "ask", why: "the form would not take it (control_not_found)", _was: { action: "fill", why: "p.eeo.gender (global)" }, readback: { ok: true } };
  restoreRetried(remembered);
  const missed = { qid: "veteran_status", action: "check", why: "p.eeo.veteran_status (global)", readback: { ok: false, observed: "", attempts: 2 } };
  restoreRetried(missed);
  check(
    "A11 retry_reported_as_failure — a row the page read back never keeps a control_not_found why, and a row the retry never reached is still an ask",
    committed.action !== "ask" &&
      !/control_not_found|would not take it/.test(committed.why) &&
      committed.shot === undefined &&
      remembered.action === "fill" &&
      remembered.why === "p.eeo.gender (global)" &&
      missed.action === "ask",
  );

  // A16 — the per-page dedupe, as the draft pass applies it: a story an earlier box on this page
  // already told is skipped, and the rule yields rather than leaving a draft with nothing.
  const pool = [
    { id: "b.story.kernel", title: "Kernel work", text: "cuda kernel latency serving throughput" },
    { id: "b.story.pipeline", title: "Pipeline work", text: "streaming pipeline latency serving throughput" },
  ];
  const job = { title: "Inference Engineer", description: "latency serving throughput kernels" };
  const firstDraft = chooseStories({ pool, job, limit: 1 });
  const secondDraft = chooseStories({ pool, job, limit: 1, used: new Set([firstDraft[0].id]) });
  const onlyOne = chooseStories({ pool: [pool[0]], job, limit: 1, used: new Set([pool[0].id]) });
  check(
    "A16 draft_grounding_question_blind — a second box on the same page is offered a different story, and with only one on file repeating beats refusing",
    firstDraft.length === 1 && secondDraft.length === 1 && secondDraft[0].id !== firstDraft[0].id && onlyOne.length === 1 && onlyOne[0].id === pool[0].id,
  );

  // A20 — `remember.mjs` selects an id, it never invents one. Three halves of that rule.
  const store = { facts: [{ id: "f.custom.dietary" }], preferences: [{ id: "p.custom.tone" }] };
  const criteria = idCriteria(store);
  check(
    "A20 remember_id_inference — the id criteria are the catalogue plus the ids already saved, with an explicit none_of_these exit",
    Object.keys(ID_CATALOGUE).every((id) => criteria[id]) &&
      criteria["f.custom.dietary"] &&
      criteria["p.custom.tone"] &&
      typeof criteria[NONE] === "string" &&
      criteria["f.identity.city"] !== criteria["f.identity.location"],
  );
  const minted = idDecision({ picked: NONE, confidence: 0.94, kind: "fact", instruction: "I am allergic to peanuts", taken: new Set() });
  const unsure = idDecision({ picked: "f.identity.city", confidence: 0.3, kind: "fact", instruction: "I am allergic to peanuts", taken: new Set() });
  const chosen = idDecision({ picked: "f.identity.city", confidence: 0.91, kind: "fact", instruction: "I currently live in Lisbon, Portugal", taken: new Set() });
  check(
    "A20 remember_id_inference — none_of_these above the gate mints a row of its own, below the gate the user is asked, and a confident pick is the id it names",
    minted.mode === "mint" &&
      minted.id === null &&
      unsure.mode === "ask" &&
      typeof unsure.id === "string" &&
      unsure.id.startsWith("f.") &&
      chosen.mode === "id" &&
      chosen.id === "f.identity.city",
  );
  check(
    "A20 remember_id_inference — a catalogue id stores the value, not the sentence that stated it, and a yes_no id refuses anything that states neither",
    catalogueValue("f.identity.city", "I currently live in Lisbon, Portugal").value === "Lisbon, Portugal" &&
      catalogueValue("f.identity.phone", "my phone is +351 912 345 678").value === "+351 912 345 678" &&
      catalogueValue("p.relocation", "yes, I would relocate").value === "Yes" &&
      typeof catalogueValue("p.relocation", "it depends on the city").needs === "string",
  );

  // A21 — the second look answers the label's topic, or the row stays open. Same `topicGap` the
  // first canonical pass applies, on the rephrasing path (A18's E3 guard, one question later).
  const canon = {
    questions: [{ qid: "q.narrative.exceptional_work", layer: "narrative", text: "Describe the work you are most proud of.", kind_default: "narrative" }],
  };
  const rephraseMem = {
    facts: [],
    preferences: [],
    stories: [],
    answers: [{ qid: "q.narrative.exceptional_work", kind: "narrative", value: "A GPU kernel rewrite that cut a physics simulation's step time.", scope: "global", source: "user" }],
  };
  const matched = { confidence: 0.92, choice: "q.narrative.exceptional_work", probabilities: { "q.narrative.exceptional_work": 0.92, [NONE]: 0.08 } };
  const qualified = { qid: "f1", action: "ask", source: "none", why: "" };
  const plain = { qid: "f2", action: "ask", source: "none", why: "" };
  applyRephrasing([qualified], { same_f1: matched }, {
    canon,
    mem: rephraseMem,
    context: {},
    baselines: null,
    pipeline: null,
    byQid: new Map([["f1", { label: "What is your most complex project with LLMs?" }]]),
  });
  applyRephrasing([plain], { same_f2: matched }, {
    canon,
    mem: rephraseMem,
    context: {},
    baselines: null,
    pipeline: null,
    byQid: new Map([["f2", { label: "Tell us about the work you are most proud of." }]]),
  });
  check(
    "A21 company_question_never_rephrased — a rephrasing that does not answer the label's topic leaves the row open; one that does answers it",
    qualified.action === "ask" &&
      qualified.canon === undefined &&
      /llm/i.test(qualified.why) &&
      plain.canon === "q.narrative.exceptional_work" &&
      plain.action !== "ask",
  );

  // B1 — plan-vs-DOM identity. The fingerprint is the form's shape, and a re-fill against a
  // different shape is refused while a reviewed fill is on record.
  const formA = { ats: "greenhouse", questions: [{ qid: "first_name", control: "text", required: true }, { qid: "gender", control: "react_select", required: false }] };
  const formB = { ...formA, questions: [...formA.questions, { qid: "export_control", control: "radio", required: true }] };
  const frozenA = { slug: "acme-1", form: formFingerprint(formA), decisions: [{ qid: "first_name", readback: { ok: true } }] };
  const changed = refillGuard({ frozen: frozenA, formPlan: formB });
  const legacy = refillGuard({ frozen: { slug: "acme-1", decisions: frozenA.decisions }, formPlan: formB });
  check(
    "B1 submit_preflight_refill — a --url run refuses to re-fill a form that is not the one it filled, unless --refill says so",
    formFingerprint(formA) === formFingerprint({ ...formA, questions: [...formA.questions] }) &&
      formFingerprint(formA) !== formFingerprint(formB) &&
      refillGuard({ frozen: frozenA, formPlan: formA }).ok === true &&
      changed.ok === false &&
      changed.reason === "plan_identity" &&
      /--refill/.test(changed.detail) &&
      refillGuard({ frozen: frozenA, formPlan: formB, refill: true }).ok === true &&
      refillGuard({ frozen: { ...frozenA, decisions: [{ qid: "first_name" }] }, formPlan: formB }).ok === true &&
      legacy.ok === true &&
      legacy.checked === false,
  );

  // B2 — `required` on the frozen row, so "required and empty" is countable off the record.
  const carried = withFormFacts(
    [{ qid: "first_name", action: "fill" }, { qid: "gender", action: "ask" }, { qid: "not_on_this_form", action: "ask" }],
    { questions: [{ qid: "first_name", required: true }, { qid: "gender", required: false, options: [{ label: "Male" }, { label: "Female" }] }] },
  );
  const graded = preflight({ decisions: [{ qid: "languages", label: "Languages you speak", action: "ask", source: "none", required: true }] });
  const optional = preflight({ decisions: [{ qid: "cover", label: "Cover letter", action: "skip", source: "none", required: false }] });
  check(
    "B2 required_flag_absent — the form's own required flag is carried onto the decision, survives the freeze, and makes 'required and empty' countable with no schema and no browser",
    carried[0].required === true &&
      carried[1].required === false &&
      carried[1].options.length === 2 &&
      carried[2].required === undefined &&
      publicDecision(carried[1]).required === false &&
      publicDecision(carried[0]).required === true &&
      graded.failures.some((f) => f.rule === "required_empty" && f.qid === "languages") &&
      optional.ok === true &&
      optional.checked.includes("required_empty") &&
      preflight({ decisions: [{ qid: "languages", action: "ask" }] }).unchecked.some((u) => u.rule === "required_empty"),
  );

  // B3 — the redacted half of a sensitive read-back, replaced by a verdict.
  const sensitiveRow = (patch) => [{ qid: "gender", label: "Gender", class: "sensitive", source: "preference", action: "fill", why: "p.eeo.gender (global)", value: "Female", readback: { ok: true, observed: "", attempts: 1, ...patch } }];
  check(
    "B3 sensitive_readback_unprovable — a sensitive row records observed_matches instead of the value, and a false verdict refuses the submit",
    observedMatches("Female", "Female") === true &&
      observedMatches("Decline to self identify", "Female") === false &&
      observedMatches("", "Female") === false &&
      preflight({ decisions: sensitiveRow({ observed_matches: false }) }).failures.some((f) => f.rule === "sensitive_readback" && f.qid === "gender") &&
      preflight({ decisions: sensitiveRow({ observed_matches: true }) }).ok === true,
  );

  // B8 — `#race` is planned as a control that mounts under the ethnicity row, driven after it,
  // and a control the page has not grown yet is deferred rather than counted as a failed write.
  const greenhouse = normalizeGreenhouse(
    JSON.parse(readFileSync(path.join(ROOT, "eval", "fixtures", "greenhouse-togetherai-5179372007.json"), "utf8")),
    "https://job-boards.greenhouse.io/togetherai/jobs/5179372007",
  );
  const raceRow = greenhouse.questions.find((q) => q.qid === "race");
  const ranks = rowOrder([{ qid: "hispanic_ethnicity" }, { qid: "gender" }, { qid: "race", mounts_after: "hispanic_ethnicity" }]);
  const orphan = rowOrder([{ qid: "gender" }, { qid: "race", mounts_after: "hispanic_ethnicity" }]);
  check(
    "B8 race_conditional_on_hispanic — race is planned as a dependant of the ethnicity row, driven after it, and a not-yet-mounted conditional is deferred rather than failed",
    raceRow?.mounts_after === "hispanic_ethnicity" &&
      raceRow?.dependency === undefined &&
      ranks.get("race") > ranks.get("hispanic_ethnicity") &&
      ranks.get("race") < ranks.get("gender") &&
      orphan.get("race") > orphan.get("gender") &&
      deferredMount(raceRow, { ok: false, reason: "control_not_found" }) === true &&
      deferredMount(raceRow, { ok: false, reason: "unmatched: Asian" }) === false &&
      deferredMount({ qid: "gender" }, { ok: false, reason: "control_not_found" }) === false,
  );

  // B12 — the one rule about the button rather than the fill.
  const covered = preflight({ decisions: [], submit: { label: "Submit application", overlaps: [{ tag: "div", name: "#onetrust-banner-sdk" }] } });
  const cleared = preflight({ decisions: [], submit: { label: "Submit application", overlaps: [] } });
  check(
    "B12 overlay_over_submit — an element covering the submit control refuses the click, a clear button passes, and no geometry at all is unchecked",
    covered.ok === false &&
      covered.failures.some((f) => f.rule === "overlay_over_submit" && /onetrust/.test(f.message)) &&
      cleared.ok === true &&
      cleared.checked.includes("overlay_over_submit") &&
      preflight({ decisions: [] }).unchecked.some((u) => u.rule === "overlay_over_submit"),
  );

  // B14 — the host writer's paragraph faces the same two gates the model's does, at fill time.
  const hostRow = (qid) =>
    hostDraft(
      { qid, label: "What have you built that you are proud of?" },
      {
        kind: "narrative",
        prompt: "What have you built that you are proud of?",
        grounding: ["kernel work — i cut p99 latency on a serving path"],
        limits: null,
      },
    );
  const text = "i cut p99 latency on a serving path and would do that kind of work here";
  const stages = [];
  const accepted = hostRow("proud_ok");
  const out = await acceptHostDrafts({
    decisions: [accepted],
    answers: { proud_ok: text },
    gate: async ({ stage }) => {
      stages.push(stage);
      return 0.88;
    },
  });
  const rejected = hostRow("proud_no");
  const refusedOut = await acceptHostDrafts({ decisions: [rejected], answers: { proud_no: text }, gate: async () => 0.2 });
  const unreachable = hostRow("proud_err");
  const unreachableOut = await acceptHostDrafts({
    decisions: [unreachable],
    answers: { proud_err: text },
    gate: async () => {
      throw new Error("the relevance gate returned no probability");
    },
  });
  check(
    "B14 host_draft_ungated — a host draft runs both relevance gates at fill time: it ships with both verdicts on record, and a gate below the threshold (or one that cannot be reached) sends the row back as an ask",
    out.accepted.join() === "proud_ok" &&
      stages.join() === "draft_grounding,draft_answers" &&
      accepted.action === "draft" &&
      accepted.source === "host" &&
      accepted.gates.grounding === 0.88 &&
      accepted.gates.draft === 0.88 &&
      refusedOut.accepted.length === 0 &&
      refusedOut.refused[0]?.qid === "proud_no" &&
      rejected.action === "ask" &&
      rejected.value === undefined &&
      rejected.gates.grounding === 0.2 &&
      rejected.gates.draft === undefined &&
      unreachableOut.refused.length === 1 &&
      unreachable.action === "ask",
  );
}

// ─── the fresh-12 baseline findings (docs/research/20-eval-judge-fresh.md) ─────────────────────
// Twelve never-seen postings, graded from their own screenshots. Every assertion below is one row
// that round put wrong on a real form, or left unanswered with the memory that answers it on file.
// All of them are deterministic: one synthetic memory, `resolveForm` called directly, no Jev.
//
// The synthetic person here is a citizen of, and lives in, one country (IN) while the postings are
// in another (US/CA) — which is the shape that produced the two inverted work-authorization rows,
// and the shape that settles which sub-region of a split race list is theirs.
{
  const DECLINE = "I don't wish to answer";
  const mem = {
    facts: [
      { id: "f.identity.full_name", value: "Priya Raman", source: "user" },
      { id: "f.identity.email", value: "priya@example.com", source: "user" },
      { id: "f.identity.location", value: "Bengaluru, India", source: "user" },
      { id: "f.citizenship", value: "Indian", source: "user" },
      { id: "f.work_auth.IN", value: { authorized_now: true, needs_sponsorship_future: false, status: "citizen" }, source: "user" },
      { id: "f.work_auth.default", value: { authorized_now: false, needs_sponsorship_future: true, status: "needs sponsorship" }, source: "user" },
      { id: "f.employment.older_co", value: { employer: "Older Co" }, since: "2021-03", until: "2023-01", source: "user" },
      { id: "f.employment.newest_co", value: { employer: "Newest Co" }, since: "2024-05", source: "user" },
      { id: "f.education.older_school", value: { school: "Older School", degree: "Secondary" }, since: "2018-04", source: "user" },
      { id: "f.education.newest_school", value: { school: "Newest University", degree: "BTech" }, since: "2020-07", source: "user" },
      { id: "f.identity.github_url", value: "https://github.com/example", source: "user" },
    ],
    preferences: [
      { id: "p.eeo", value: { gender: "female", hispanic_latino: "no", race: "asian", veteran_status: "not_veteran", disability_status: "no", other_demographics: "decline" }, source: "user" },
      { id: "p.legal.restrictive_agreements", value: "No", source: "user" },
      { id: "p.legal.privacy_policy_ack", value: "Yes", source: "user" },
    ],
    answers: [],
    stories: [],
    documents: [],
  };
  const US_JOB = { company: "Vercel", title: "Engineer", location: "San Francisco, CA", country: "US" };
  const plan = (questions, job = US_JOB) => ({ job, questions });
  const rowOf = (q, job) => resolveForm(plan([q], job), { mem }).decisions[0];
  const q = (over) => ({ qid: "q1", required: true, type: "single_select", control: "react_select", ...over, class: over.class ?? classify(over.label, "", over.type ?? "single_select", true) });

  // ── wrong #1/#2: the jurisdiction the question names is the candidate's, not the employer's ──
  const remainHere = rowOf(
    q({
      label: "Will you now or in the future require sponsorship for a visa to remain in your current location?",
      options: [{ label: "No" }, { label: "Yes, EU Blue Card" }, { label: "Yes, USMCA Professional (TN) Visa (USA)" }],
    }),
    { ...US_JOB, company: "GitLab", country: "CA" },
  );
  check(
    "fresh #1 work_auth_scope — 'sponsorship to remain in your current location' is answered for where the candidate is, not for the employer's country",
    remainHere.action === "fill" && remainHere.value === "No" && /f\.work_auth\.IN/.test(remainHere.why) && /where you are, not where the role is/.test(remainHere.why),
  );

  const STATUSES = [
    { label: "I am authorized to work in the country due to my nationality" },
    { label: "I am authorized to work in the country based on a valid work permit and do not need a company to sponsor my visa" },
    { label: "I am authorized to work in the country based on a valid work permit which needs to be sponsored by the company I work for" },
    { label: "I am not authorized to work in the country and need visa support" },
    { label: "Other" },
  ];
  const liveHere = rowOf(q({ label: "Your authorization to work in the country where you live. Please choose the option that describes your work authorization.", options: STATUSES }));
  check(
    "fresh #2 status_list_polarity — a status list whose entries all read 'I am …' is not a Yes/No control: the row takes the option the candidate's own nationality states",
    liveHere.option === STATUSES[0].label && /f\.citizenship/.test(liveHere.why),
  );
  // The same guard must not swallow a genuine Yes/No question whose Yes is split by *timing*:
  // Together AI's three-way now/future/never list is answered by the option stage, not refused.
  const timing = rowOf(
    q({
      label: "Will you now or in the future require company sponsorship to retain or extend your work authorization in the country where the job is located?",
      options: [
        { label: "Yes, I will require immigration sponsorship now to legally work in the country where the job is located." },
        { label: "Yes, I will require immigration sponsorship in the future to legally work in the country where the job is located." },
        { label: "No, I do not and will not require immigration sponsorship to legally work in the country where the job is located." },
      ],
    }),
  );
  check(
    "fresh #2b timing_variants_survive — two Yes options that differ only in when sponsorship starts are still a Yes/No question: the row keeps its derived answer and the answer text that dates it, instead of being refused as a status list",
    timing.action === "check" && timing.value === "Yes" && /sponsorship starting now/.test(String(timing._answerText)),
  );

  // ── wrong #3/#4: a race list split into sub-regions ────────────────────────────────────────
  const ENUMERATED = [
    "East Asian (inclusive of Chinese, Japanese, Korean, Mongolian, Tibetan, and Taiwanese)",
    "South Asian (inclusive of Afghani, Bangladeshi, Bhutanese, Indian, Nepali, Pakistani, and Sri Lankan)",
    "Southeast Asian (inclusive of Burmese, Cambodian, Filipino, Hmong, Indonesian, Laotian, Malaysian, Mien, Singaporean, Thai, and Vietnamese)",
    "White",
    DECLINE,
  ].map((label) => ({ label }));
  const BARE = ["Black or of African descent", "East Asian", "South Asian", "Southeast Asian", "White or European", DECLINE].map((label) => ({ label }));
  const raceRow = (options) => rowOf(q({ label: "I identify my race/ethnicity as (mark all that apply):", type: "multi_select", control: "react_select", options }));
  const enumerated = raceRow(ENUMERATED);
  const bare = raceRow(BARE);
  check(
    "fresh #3/#4 race_subregion — a split race list takes the one sub-region the stated country lands in, on a list that enumerates nationalities and on one that does not",
    enumerated.option === ENUMERATED[1].label && bare.option === BARE[2].label && !/other_demographics/.test(`${enumerated.why}${bare.why}`),
  );
  const noCountry = { ...mem, facts: mem.facts.filter((f) => !/citizenship|identity\.location/.test(f.id) && f.id !== "f.citizenship") };
  const unsettled = resolveForm(plan([q({ label: "I identify my race/ethnicity as (mark all that apply):", type: "multi_select", control: "react_select", options: BARE })]), { mem: noCountry }).decisions[0];
  check(
    "fresh #3/#4 race_subregion — with no country stated the split is not guessed at: the standing decline answers it and no sibling sub-region is ticked",
    unsettled.option === DECLINE && /other_demographics/.test(unsettled.why),
  );

  // ── wrong #5: a row conditioned on something about the user that nothing settles ────────────
  const conditional = rowOf(
    q({
      label: "If you were previously employed by Remote, please share the email you used for signing in. If not, please put N/A (text box)",
      type: "textarea",
      control: "textarea",
      options: [],
    }),
  );
  check(
    "fresh #5 conditional_self — an identity fact is never written into a row whose own label conditions it on an unestablished fact about the candidate",
    conditional.action === "ask" && conditional.value === undefined && /condition about you/.test(conditional.why),
  );

  // ── wrong #6: a consent inside the demographic block ────────────────────────────────────────
  const consent = rowOf(q({ label: "Please confirm you consent your self-identification data to be processed for the listed purposes", options: [{ label: "Yes, I consent" }, { label: DECLINE }] }));
  check(
    "fresh #6 sensitive_consent — a consent in the demographic block is a signature, answered from its own p.legal.* row and never from the p.eeo decline stance",
    consent.action === "ask" && consent.topic === "policy" && consent.remember_as?.id === "p.legal.self_identification_consent" && !/other_demographics/.test(consent.why),
  );

  // ── missed #1: a restrictive-agreements row wearing an identity label ───────────────────────
  const restrictive = rowOf(q({ label: "Are you subject to any employment agreements and/or post-employment restrictions with your current employer or a past employer?", options: [{ label: "Yes" }, { label: "No" }] }));
  check(
    "fresh missed #1 restrictive_agreements — 'employment agreements and/or post-employment restrictions with your current employer' answers from the standing preference, not from an employment fact",
    restrictive.action === "fill" && restrictive.value === "No" && /p\.legal\.restrictive_agreements/.test(restrictive.why),
  );

  // ── missed #2: a residence question that enumerates its own places ──────────────────────────
  // Class as the recorded Vercel schema classes it (`circumstance`): the rule is a circumstance
  // rule, and the class this label lands in is the normalizer's judgement, not this rule's.
  const STATES = "Do you live in one of the following states? Alabama, Alaska, Delaware, Kansas, Maine, Mississippi, Montana, Nebraska, New Mexico, North Dakota, South Dakota, West Virginia, or Wyoming.";
  const statesQ = q({ label: STATES, class: "circumstance", options: [{ label: "Yes" }, { label: "No" }] });
  const livesIn = (value) =>
    resolveForm(plan([statesQ]), { mem: { ...mem, facts: mem.facts.map((f) => (f.id === "f.identity.location" ? { ...f, value } : f)) } }).decisions[0];
  const states = rowOf(statesQ);
  check(
    "fresh missed #2 listed_residence — a residence question listing US states is answered from the stated location, and a stated location in another country answers it No",
    states.action === "fill" && states.option === "No" && /f\.identity\.location/.test(states.why),
  );
  const inList = livesIn("Portland, Maine");
  const ambiguous = livesIn("San Francisco Bay Area");
  check(
    "fresh missed #2 listed_residence — a stated location that names one of the listed states answers Yes, and one inside the US that names no state at all is still asked",
    inList.option === "Yes" && ambiguous.action === "ask" && ambiguous.value === undefined,
  );

  // ── the answerable `couldnt` rows ───────────────────────────────────────────────────────────
  const ELIGIBLE = "Work eligibility is extremely important. Are you legally eligible to work in the country where you\u2019re planning to work from?";
  const REMOTE_JOB = { company: "Remote", title: "PM", location: "Remote", country: null, remote: false };
  const eligible = rowOf(q({ label: ELIGIBLE, options: [{ label: "Yes" }, { label: "No" }] }), REMOTE_JOB);
  check(
    "fresh couldnt work_eligibility — 'legally eligible to work' is the authorization question in other words: it classes as a circumstance and answers for where the candidate is",
    classify(ELIGIBLE, "", "single_select", true) === "circumstance" && eligible.action === "fill" && eligible.value === "Yes",
  );
  const noCountryJob = rowOf(q({ label: "Will you require sponsorship if you join Remote?", options: [{ label: "Yes" }, { label: "No" }] }), REMOTE_JOB);
  check(
    "fresh couldnt blanket_work_auth — a posting that names no country at all is answered from the blanket f.work_auth.default rule, as a check the user sees",
    noCountryJob.action === "check" && noCountryJob.value === "Yes" && /f\.work_auth\.default/.test(noCountryJob.why),
  );
  // The employer / school / link rows: what settles them is which saved row is the newest, and
  // these three stores each hold an older row that a blind read would return instead.
  const link = rowOf(q({ label: "Portfolio/GitHub/Website", type: "text", control: "text", required: false, options: [] }));
  check(
    "fresh couldnt newest_since — the most-recent employer and school are the newest `since:` rows, not the first or the longest-held, and a portfolio row answers from the saved link fact",
    latestEmployment(mem, new Date("2026-09-24")).id === "f.employment.newest_co" &&
      latestEducation(mem, new Date("2026-09-24")).id === "f.education.newest_school" &&
      link.action === "fill" &&
      /f\.identity\.github_url/.test(link.why),
  );

  // ── the two invariants the submit gate now refuses ──────────────────────────────────────────
  const both = { qid: "orientation", label: "How do you identify your sexual orientation? Please select all that apply.", class: "sensitive", action: "fill", source: "preference", why: "p.eeo.other_demographics (global)", option: `Queer | Bisexual | ${DECLINE}` };
  const disability = { qid: "communities", label: "Which of the following communities do you belong to?", class: "sensitive", action: "fill", source: "preference", why: "p.eeo.other_demographics (global)", option: `Person with disability | ${DECLINE}` };
  const clean = { qid: "race", label: "Race", class: "sensitive", action: "fill", source: "preference", why: "p.eeo.race (global)", option: "South Asian" };
  const verdict = preflight({ decisions: [both, disability, clean], mem });
  const named = (rule) => verdict.failures.filter((f) => f.rule === rule).map((f) => f.qid);
  check(
    "fresh invariant decline_conflict — a demographic row holding the decline entry alongside substantive claims refuses the submit, and a row holding one answer passes",
    named("sensitive_decline_conflict").join() === "orientation,communities" && verdict.ok === false,
  );
  check(
    "fresh invariant claim_contradicts — a ticked disability claim is refused when p.eeo.disability_status says the candidate does not have one",
    named("sensitive_claim_contradicts").join() === "communities" &&
      preflight({ decisions: [clean], mem }).failures.length === 0,
  );
  check(
    "fresh invariant claim_contradicts — the rule reads the saved stance: with disability_status 'yes' the same row is the candidate's own answer and is not refused",
    preflight({
      decisions: [disability],
      mem: { ...mem, preferences: mem.preferences.map((p) => (p.id === "p.eeo" ? { ...p, value: { ...p.value, disability_status: "yes" } } : p)) },
    }).failures.filter((f) => f.rule === "sensitive_claim_contradicts").length === 0,
  );

  // ── the salvaged enrichment, as a pre-filter and nothing more ───────────────────────────────
  const tagged = {
    facts: [],
    preferences: [],
    answers: [],
    documents: [],
    stories: [
      { id: "b.story.kernel", kind: "story", title: "Inference kernels", tags: ["gpu"], text: "CUDA kernels.", answers_questions: ["Describe a technical project you are proud of that used LLM serving"], topics: ["llm", "gpu"] },
      { id: "b.story.ops", kind: "story", title: "On-call rotation", tags: ["ops"], text: "Paging and runbooks.", answers_questions: ["How do you handle production incidents?"], topics: ["ops"] },
    ],
  };
  const LLM_PROMPT = "Tell us about your most complex project with LLM";
  const pooled = storyPool(tagged, { label: LLM_PROMPT, type: "textarea" }).rows.map((r) => r.id);
  const untagged = storyPool(
    { ...tagged, stories: tagged.stories.map(({ answers_questions, topics, ...rest }) => rest) },
    { label: LLM_PROMPT, type: "textarea" },
  ).rows.map((r) => r.id);
  check(
    "fresh enrichment_prefilter — the tag is what makes a row findable for a prompt its own title and text never mention, it narrows to that one row, and an unqualified prompt still sees the whole pool",
    pooled.join() === "b.story.kernel" && untagged.length === 0 && storyPool(tagged, { label: "Describe a project you are proud of", type: "textarea" }).rows.length === 2,
  );
}

// ─── the seven remaining `missed` rows (docs/research/21-eval-judge-final.md §4 M1–M6) ─────────
// The `fresh3` run put nothing wrong on a real form; these seven are rows the store could have
// answered and did not. Every label below is the posting's own, every class is the one the
// normalizer gave it in that run, and the memory is the same synthetic person as the block above
// — a citizen of and resident in one country (IN) applying to US employers. Deterministic:
// `resolveForm` and `samePlace` are called directly, no Jev and no browser.
{
  const mem = {
    facts: [
      { id: "f.identity.full_name", value: "Priya Raman", source: "user" },
      { id: "f.identity.location", value: "Bengaluru, India", source: "user" },
      { id: "f.identity.email", value: "priya@example.com", source: "user" },
      { id: "f.citizenship", value: "Indian", source: "user" },
      { id: "f.employment.older_co", value: { employer: "Older Co" }, since: "2021-03", until: "2023-01", source: "user" },
      { id: "f.employment.newest_co", value: { employer: "Newest Co" }, since: "2024-05", source: "user" },
    ],
    preferences: [],
    answers: [],
    stories: [],
    documents: [],
  };
  // A pipeline with history in it, and no record of any employer these rows name: an *empty*
  // pipeline is not evidence of "never", so the derivation refuses on one (`appliedBeforeFor`).
  const pipeline = { jobs: [{ id: "j1", company: "Some Other Co", status: "applied", applied_at: "2026-02-01" }] };
  const rowOf = (question, job) => resolveForm({ job, questions: [question] }, { mem, pipeline }).decisions[0];
  const withLocation = (value, question, job) =>
    resolveForm({ job, questions: [question] }, {
      mem: { ...mem, facts: mem.facts.map((f) => (f.id === "f.identity.location" ? { ...f, value } : f)) },
      pipeline,
    }).decisions[0];
  const GUSTO = { company: "Gusto, Inc.", title: "SWE", location: "Denver, CO", country: "US" };
  const PLAID = { company: "Plaid", title: "Data Engineer", location: "New York, NY", country: "US" };
  const REMOTE = { company: "Remote", title: "PM", location: "Remote", country: null };

  // ── M1: a location picker's own list, compared as places rather than as strings ─────────────
  // The probe types the saved string, so the list it returns is that string's continuations. The
  // three rungs `samePlace()` adds past equality, and the two shapes that must still refuse.
  const LOCATION_ROW = "Where are you currently located?";
  const openai = rowOf(
    { qid: "loc", label: LOCATION_ROW, required: true, type: "text", control: "react_select", class: "identity", options: [] },
    { company: "OpenAI", title: "Research Engineer", location: "San Francisco, CA", country: "US" },
  );
  check(
    "final M1 location_option_match — a location row fills from the stated place, and the live list matches it on punctuation, on a typed prefix and on a country suffix, but never when two entries fit",
    openai.action === "fill" &&
      /f\.identity\.location/.test(openai.why) &&
      samePlace(["Bengaluru \u2013 India", "Chennai, India"], "Bengaluru, India")?.label === "Bengaluru \u2013 India" &&
      samePlace(["Bengaluru, Karnataka, India", "Chennai, Tamil Nadu, India"], "Bengaluru")?.label === "Bengaluru, Karnataka, India" &&
      samePlace(["Bengaluru, IN", "Chennai, IN"], "Bengaluru, India")?.label === "Bengaluru, IN" &&
      samePlace(["Bengaluru, Karnataka, India", "Bengaluru Urban, Karnataka, India", "Bengaluru, KA, India"], "Bengaluru") === null &&
      samePlace(["Modesto Remote Encoding Ctr, California", "Remote, Oregon, United States"], "Remote") === null,
  );

  // ── M2: a label that prints its own value for a class the candidate is provably in ──────────
  const ZIP = 'Zip Code / Postal Code (Non-U.S. based candidates, please enter "00000")';
  const zipQ = { qid: "zip", label: ZIP, required: true, type: "text", control: "text", class: "company_specific", options: [] };
  const zip = rowOf(zipQ, GUSTO);
  const zipUS = withLocation("Austin, Texas", zipQ, GUSTO);
  check(
    "final M2 printed_fallback — a label printing its own value for non-U.S. candidates fills that literal as a check when the stated location is outside the US, and is left to the user when it is inside",
    zip.action === "check" && zip.value === "00000" && /f\.identity\.location/.test(zip.why) && zipUS.action === "ask" && zipUS.value === undefined,
  );

  // ── M3: a jurisdiction notice whose second option is a fact, not a signature ────────────────
  const NOTICE = "Notice at Collection for California Job Applicants";
  const noticeQ = (options) => ({ qid: "ccpa", label: NOTICE, required: true, type: "single_select", control: "react_select", class: "policy_gate", options: options.map((label) => ({ label })) });
  const notice = rowOf(noticeQ(["Acknowledge/Confirm", "I am not a California resident"]), REMOTE);
  const noticeCA = withLocation("San Jose, California", noticeQ(["Acknowledge/Confirm", "I am not a California resident"]), REMOTE);
  const ackOnly = rowOf(noticeQ(["Acknowledge/Confirm"]), REMOTE);
  check(
    "final M3 jurisdiction_escape — a policy gate offering a residency disclaimer picks it from the stated location as a check, while a candidate in that state and a gate with only the signature both still ask",
    notice.action === "check" &&
      notice.option === "I am not a California resident" &&
      /f\.identity\.location/.test(notice.why) &&
      noticeCA.action === "ask" &&
      /no p\.legal\./.test(noticeCA.why) &&
      ackOnly.action === "ask",
  );

  // ── M4: a closed enumeration of places beside the list's own catch-all ──────────────────────
  const CITIES = "Please Indicate your current location:";
  const citiesQ = { qid: "city", label: CITIES, required: true, type: "single_select", control: "react_select", class: "company_specific", options: ["Denver", "New York City", "San Fransisco", "Other"].map((label) => ({ label })) };
  const cities = rowOf(citiesQ, GUSTO);
  const citiesUS = withLocation("Austin, Texas", citiesQ, GUSTO);
  const onTheList = withLocation("Denver, Colorado", citiesQ, GUSTO);
  check(
    "final M4 enumerated_places — a location row listing places the stated location is provably in none of takes the catch-all as a check, takes the named option outright when it is on the list, and asks when the stated location is in the same country as the list",
    cities.action === "check" &&
      cities.option === "Other" &&
      /f\.identity\.location/.test(cities.why) &&
      onTheList.action === "fill" &&
      onTheList.option === "Denver" &&
      citiesUS.action === "ask" &&
      citiesUS.value === undefined,
  );

  // ── M5: "…working at Gusto or Symmetry…" — one answer for every entity the label names ──────
  const GUSTO_ROW = "Have you ever, or are you currently working at Gusto or Symmetry in any capacity (ie: employee or contingent worker)?";
  const yesNo = [{ label: "Yes" }, { label: "No" }];
  const gustoQ = { qid: "prior", label: GUSTO_ROW, required: true, type: "single_select", control: "react_select", class: "company_specific", options: yesNo };
  const gusto = rowOf(gustoQ, GUSTO);
  const noHistory = resolveForm({ job: GUSTO, questions: [gustoQ] }, { mem: { ...mem, facts: mem.facts.filter((f) => !/^f\.employment\./.test(f.id)) }, pipeline }).decisions[0];
  const emptyPipeline = resolveForm({ job: GUSTO, questions: [gustoQ] }, { mem, pipeline: { jobs: [] } }).decisions[0];
  check(
    "final M5 multi_entity_employer — a prior-employment row naming this employer and a sister brand answers No as a check when the derivation holds for both, and asks when the employment history is empty or the pipeline cannot speak",
    gusto.action === "check" &&
      gusto.option === "No" &&
      gusto.topic === "previously_employed" &&
      employersNamed(GUSTO_ROW, "Gusto, Inc.").join() === "Gusto,Symmetry" &&
      noHistory.action === "ask" &&
      emptyPipeline.action === "ask",
  );

  // ── M5b: the same shape over three entities, and the third-party guard that must survive ────
  const PLAID_ROW = "Have you ever been previously employed by Plaid, Quovo or Cognito?";
  const plaidQ = { qid: "prior3", label: PLAID_ROW, required: true, type: "boolean", control: "radio", class: "circumstance", options: yesNo };
  const plaid = rowOf(plaidQ, PLAID);
  const worked = resolveForm({ job: PLAID, questions: [plaidQ] }, {
    mem: { ...mem, facts: [...mem.facts, { id: "f.employment.quovo", value: { employer: "Quovo" }, since: "2019-01", until: "2020-06", source: "user" }] },
    pipeline,
  }).decisions[0];
  const thirdParty = rowOf({ ...plaidQ, qid: "pwc", label: "Have you ever been previously employed by Acme, Beta or Gamma?" }, PLAID);
  check(
    "final M5b multi_entity_employer — the same rule over three names answers Yes from the employment history when one of them is in it, and a list naming no entity of this employer is still nobody's to answer",
    plaid.action === "check" &&
      plaid.option === "No" &&
      employersNamed(PLAID_ROW, "Plaid").join() === "Plaid,Quovo,Cognito" &&
      worked.action === "check" &&
      worked.option === "Yes" &&
      employersNamed("Have you ever been previously employed by Acme, Beta or Gamma?", "Plaid") === null &&
      thirdParty.action === "ask",
  );

  // ── M6: a conditional row whose label prints the answer for the other branch ────────────────
  const CONDITIONAL = "If you were previously employed by Remote, please share the email you used for signing in. If not, please put N/A (text box)";
  const condQ = { qid: "cond", label: CONDITIONAL, required: true, type: "textarea", control: "textarea", class: "identity", options: [] };
  const conditional = rowOf(condQ, REMOTE);
  const noElse = rowOf({ ...condQ, qid: "cond2", label: "If you were previously employed by Remote, please share the email you used for signing in." }, REMOTE);
  check(
    "final M6 conditional_else_value — a conditional row whose label prints the else-value fills that literal as a check once memory refutes the condition, never the identity fact the condition asks for, and the same row without a printed else-value still asks",
    conditional.action === "check" &&
      conditional.value === "N/A" &&
      conditional.topic === "previously_employed" &&
      !/priya/i.test(String(conditional.value)) &&
      noElse.action === "ask" &&
      /condition about you/.test(noElse.why),
  );
}

// ─── the evidence tier (src/plan/infer.mjs) ────────────────────────────────────────────────────
// The root cause these twelve assertions pin: on 12 unseen postings, 54 rows came back unfilled
// recording "no <key> on file" for questions the runner understood, while memory held the evidence
// for the answer (pipeline provenance, the relocation stance, employment `since:` dates, the
// stated full name, the blanket acknowledgement stance). Memory was a lookup table; the tier makes
// it evidence to reason over, and every row it answers is a `check` with its evidence on record.
//
// Deterministic: the two Jev passes are driven through `inferRows`'s own transport seam with
// fabricated answers, exactly as the request-2 assertions above drive `applyRephrasing`. What is
// being asserted is the tier's reasoning — which rows it may reach, what it proposes, what the
// gates do with a verdict — not the model's opinion, which the real dry runs measure.
{
  const now = new Date("2026-09-24T00:00:00Z");
  const mem = {
    facts: [
      { id: "f.identity.full_name", value: "Priya Raman", source: "user" },
      { id: "f.identity.city", value: "Bengaluru, India", source: "user" },
      { id: "f.employment.newest_co", value: "ML Engineer — Newest Co, Jan 2023 – Present", since: "2023-01", source: "cv.pdf#p1" },
      { id: "f.employment.older_co", value: "Intern — Older Co", since: "2022-06", until: "2022-12", source: "cv.pdf#p1" },
    ],
    preferences: [
      { id: "p.relocation", value: { willing: true, anywhere_except: ["IN"] }, source: "user" },
      { id: "p.looking_for", value: { acceptable_locations: { rule: "any_country_except", except: ["IN"] } }, source: "user" },
      { id: "p.eeo", value: { gender: "male", race: "asian", hispanic_latino: "no", veteran_status: "not_veteran", disability_status: "no" }, source: "user" },
      { id: "p.legal.standard_acks", value: "Yes", source: "user" },
    ],
    answers: [],
    stories: [],
    documents: [],
    corrections: [],
  };
  const pipeline = { jobs: [{ id: "vercel-1", url: "https://job-boards.greenhouse.io/vercel/jobs/1", company: "Vercel", provider: "greenhouse", status: "queued", found: "2026-09-22" }] };
  const JOB = { company: "Vercel", title: "ML Engineer", location: "Berlin, Germany", country: "DE" };
  const yesNo = [{ label: "Yes" }, { label: "No" }];
  const q = {
    how: { qid: "how", label: "How did you hear about this opportunity?", required: true, type: "single_select", control: "react_select", class: "circumstance", options: [{ label: "Company careers page" }, { label: "LinkedIn" }, { label: "Recruiter" }] },
    office: { qid: "office", label: "Are you comfortable working in-office 3 days a week?", required: true, type: "boolean", control: "radio", class: "circumstance", options: yesNo },
    years: { qid: "years", label: "How many years of professional experience do you have?", required: true, type: "number", control: "text", class: "circumstance", options: [] },
    prior: { qid: "prior", label: "Have you previously been employed by Vercel?", required: true, type: "boolean", control: "radio", class: "company_specific", options: yesNo },
    pronouns: { qid: "pronouns", label: "What pronouns would you like our team to use?", required: false, type: "text", control: "text", class: "sensitive", options: [] },
    gender: { qid: "gender", label: "Gender", required: true, type: "single_select", control: "select", class: "sensitive", options: [{ label: "Man" }, { label: "Woman" }] },
    preferred: { qid: "preferred", label: "Preferred Name", required: false, type: "text", control: "text", class: "identity", options: [] },
    truthful: { qid: "truthful", label: "I certify that the information in this application is true and complete.", required: true, type: "boolean", control: "checkbox", class: "policy_gate", options: [{ label: "I agree" }] },
    ai: { qid: "ai", label: "I acknowledge that I did not use AI tools to write my answers.", required: true, type: "boolean", control: "checkbox", class: "policy_gate", options: [{ label: "I agree" }] },
    thirdParty: { qid: "pwc", label: "Have you ever been previously employed by PricewaterhouseCoopers?", required: true, type: "boolean", control: "radio", class: "circumstance", options: yesNo },
  };
  const formPlan = { ats: "greenhouse", url: "https://job-boards.greenhouse.io/vercel/jobs/1", job: JOB, questions: Object.values(q) };

  /**
   * The transport seam, answering as a decider that reads the evidence: every offered item bears,
   * the proposal is `picks[qid]` (or `none_of_these` where the evidence settles nothing), and the
   * justification is `verdict`. One object per test so a low verdict is a *different* run, not a
   * mutated one.
   */
  const decider = ({ picks = {}, verdict = 0.88, bears = 0.95 } = {}) => {
    const seen = { propose: 0, justify: 0 };
    const ask = async ({ stage, questions, totals }) => {
      seen[stage === "infer_propose" ? "propose" : "justify"] += 1;
      totals.requests += 1;
      totals.stages.push(stage);
      const out = {};
      for (const [id, question] of Object.entries(questions)) {
        if (question.type === "noul") {
          out[id] = { type: "noul", noul: id.startsWith("bears_") ? bears : verdict };
          continue;
        }
        const labels = Object.keys(question.criteria);
        const wanted = picks[id.slice("pick_".length)];
        const choice = wanted && labels.includes(wanted) ? wanted : wanted === NONE ? NONE : labels[0];
        out[id] = {
          type: "choice",
          choice,
          confidence: 0.9,
          probabilities: Object.fromEntries(labels.map((l) => [l, l === choice ? 0.9 : 0.1 / (labels.length - 1)])),
        };
      }
      return out;
    };
    ask.seen = seen;
    return ask;
  };

  const PICKS = { how: "Company careers page", office: "Yes", prior: "No", years: "4", preferred: "Priya", truthful: "I agree" };

  const planned = (over = {}, { picks = PICKS, verdict = 0.88 } = {}) => {
    const plan = { ...formPlan, ...over };
    const { decisions, context } = resolveForm(plan, { mem: over.mem ?? mem, pipeline, now });
    const ask = decider({ picks, verdict });
    return inferRows({ formPlan: plan, decisions, mem: over.mem ?? mem, context, pipeline, now, ask }).then((out) => ({ ...out, context, ask }));
  };

  const run = await planned();
  const row = (qid) => run.decisions.find((d) => d.qid === qid);

  // ── (a) how-heard, answered from where the application was reached ──────────────────────────
  check(
    "infer: a how-heard row with no p.how_heard on file takes the company's own careers-page option as a check, citing the posting's provenance",
    row("how").action === "check" &&
      row("how").source === "inferred" &&
      row("how").option === "Company careers page" &&
      /^inferred — /.test(row("how").why) &&
      row("how").inference.evidence.some((id) => /^pipeline\.|^posting/.test(id)),
  );

  // ── (b) in-office, answered from the relocation/location stance ─────────────────────────────
  check(
    "infer: an in-office row with a null p.in_office answers Yes as a check from the stance that accepts this posting's country",
    row("office").action === "check" && row("office").source === "inferred" && row("office").option === "Yes" && row("office").inference.evidence.includes("p.relocation"),
  );

  // ── (c) years of experience, counted from the user's own `since:` dates ─────────────────────
  // Two candidates are offered and this is the second: `fullTimeYears()` — the derivation
  // `CANON_RULES`' `experience.years_total` reads — answers 0 on a store written from a real CV,
  // because no row there *says* it is full-time. The span the `since:` dates describe is the
  // reading that is left, and the `why` says which rule produced the number.
  check(
    "infer: a years-of-experience row is a computed number counted from the saved roles' own since: dates, never a stored count",
    row("years").action === "check" && row("years").source === "inferred" && row("years").value === "4" && /since:/.test(row("years").why),
  );

  // ── (d) previously employed *here*, with a history naming other employers ───────────────────
  check(
    "infer: a previously-employed-by-this-company row answers No as a check, and its why states the reading the answer rests on",
    row("prior").action === "check" && row("prior").option === "No" && /no role at this company/.test(row("prior").why),
  );

  // ── (e) pronouns: the refusal, not an inference ──────────────────────────────────────────────
  // The design asked for pronouns to be derived from the saved gender. It is not: a pronoun read
  // off `p.eeo.gender` is a heuristic over a neighbouring demographic field, which is the one
  // thing the EEO invariant forbids (AGENTS.md; `PRONOUN_FACT_RE` in preflight admits a *stated*
  // pronoun fact and nothing else). The row stays the user's, and `pronounRow()` still fills it
  // outright the moment `f.identity.pronouns` or `p.eeo.pronouns` is on file.
  const withPronouns = { ...mem, preferences: [...mem.preferences, { id: "p.eeo.pronouns", value: "they/them", source: "user" }] };
  const stated = resolveForm({ ...formPlan, questions: [q.pronouns] }, { mem: withPronouns, pipeline, now }).decisions[0];
  check(
    "infer: a pronouns row is never inferred from a saved gender — it stays the user's question, and a stated pronoun row still fills it",
    inferBlocked(row("pronouns"), q.pronouns, { context: run.context, mem }) === "a pronoun is stated, never inferred" &&
      row("pronouns").source !== "inferred" &&
      stated.action === "fill" &&
      /pronouns/.test(stated.why),
  );

  // ── (f) preferred name, read off the stated full name ───────────────────────────────────────
  check(
    "infer: an optional preferred-name box skipped for want of a fact is answered with the given name of the stated full name, as a check",
    row("preferred").action === "check" && row("preferred").source === "inferred" && row("preferred").value === "Priya" && row("preferred").inference.evidence.includes("f.identity.full_name"),
  );

  // ── (g) the standard acknowledgements, and the attestation that is not one ───────────────────
  check(
    "infer: a truthfulness acknowledgement is signed from p.legal.standard_acks as a check, an AI-usage attestation still asks, and the preflight accepts the first and only the first",
    row("truthful").action === "check" &&
      row("truthful").source === "inferred" &&
      /p\.legal\.standard_acks/.test(row("truthful").why) &&
      row("ai").action === "ask" &&
      /ai_usage_ack/.test(row("ai").why) &&
      !preflight({ decisions: [row("truthful")], questions: [q.truthful], mem }).failures.some((f) => f.rule === "policy_gate_source" || f.rule === "inferred_justified"),
  );

  // ── (g2) arbitration is outside the blanket stance, whatever slug it lands on ────────────────
  const arbitration = { qid: "arb", label: "I agree that any dispute arising from my application will be resolved by binding arbitration.", required: true, type: "boolean", control: "checkbox", class: "policy_gate", options: [{ label: "I agree" }] };
  const arbRow = resolveForm({ ...formPlan, questions: [arbitration] }, { mem, pipeline, now }).decisions[0];
  check(
    "infer: an arbitration clause is never signed from the blanket stance — a right given up is not a notice read",
    typeof inferBlocked(arbRow, arbitration, { context: run.context, mem }) === "string" && /arbitration_ack|specific/.test(inferBlocked(arbRow, arbitration, { context: run.context, mem })),
  );

  // ── (h) a protected characteristic, never ────────────────────────────────────────────────────
  // `Gender` is a *fill* here — `p.eeo` states it, which is the one source a demographic row has.
  // The row that would tempt the tier is the survey question no `p.eeo` field covers, which is
  // still an `ask` with a whole demographic block on file: that is the one to pin.
  const lgbtq = { qid: "lgbtq", label: "Do you identify as a member of the LGBTQ+ community?", required: false, type: "single_select", control: "select", class: "sensitive", options: [{ label: "Yes" }, { label: "No" }] };
  const survey = await planned({ questions: [...Object.values(q), lgbtq] });
  const surveyRow = survey.decisions.find((d) => d.qid === "lgbtq");
  check(
    "infer: a demographic row is never inferred — a survey question no p.eeo field covers still asks with the whole block on file, and no sensitive row on the plan is ever sourced `inferred`",
    surveyRow.action === "ask" &&
      inferBlocked(surveyRow, lgbtq, { context: run.context, mem }) === "a protected characteristic is never inferred" &&
      inferBlocked(row("gender"), q.gender, { context: run.context, mem }) === "not an open ask" &&
      row("gender").source === "preference" &&
      !survey.decisions.some((d) => d.class === "sensitive" && d.source === "inferred"),
  );

  // ── (i) somebody else's employment history, never ───────────────────────────────────────────
  check(
    "infer: a prior-employment row naming a third organisation is nobody's to infer — it stays an ask (B4 survives the tier)",
    row("pwc").action === "ask" && /another organisation/.test(inferBlocked(row("pwc"), q.thirdParty, { context: run.context, mem })),
  );

  // ── (j) the justification gate ───────────────────────────────────────────────────────────────
  const weak = await planned({}, { verdict: GATES.inferBelow - 0.2 });
  const refusedNone = await planned({}, { picks: { ...PICKS, how: NONE } });
  check(
    `infer: a justification below ${GATES.inferBelow} sends the row back to the user, and so does a proposal of none_of_these`,
    weak.decisions.every((d) => d.source !== "inferred") &&
      weak.decisions.find((d) => d.qid === "how").action === "ask" &&
      /did not justify/.test(weak.decisions.find((d) => d.qid === "how").why) &&
      refusedNone.decisions.find((d) => d.qid === "how").action === "ask" &&
      /does not settle/.test(refusedNone.decisions.find((d) => d.qid === "how").why),
  );

  // ── (j2) an inferred row with no justification on record never reaches a real employer ──────
  const forged = { ...row("how"), inference: { ...row("how").inference, justified: 0.2 } };
  const unbacked = { ...row("how"), inference: undefined };
  const silent = { ...row("how"), action: "fill" };
  check(
    "infer: preflight's inferred_justified refuses an inferred row whose justification is low, missing, or that is about to be filled instead of shown",
    [forged, unbacked, silent].every((d) => preflight({ decisions: [d], questions: [q.how], mem }).failures.some((f) => f.rule === "inferred_justified")) &&
      finalize([silent])[0].action === "check",
  );

  // ── (k) the budget, and the tier's own accounting ────────────────────────────────────────────
  check(
    `infer: the whole tier costs two Jev requests for a nine-row form (got ${run.requests}), one to propose and one to justify`,
    run.requests === 2 && run.ask.seen.propose === 1 && run.ask.seen.justify === 1,
  );

  // ── (l) an inference is paid for once: the second form replays it with no model at all ──────
  const saved = inferredMemoryRows(run.decisions, run.context);
  const mem2 = { ...mem, answers: saved };
  const second = resolveForm(formPlan, { mem: mem2, pipeline, now });
  const replay = await inferRows({
    formPlan,
    decisions: second.decisions,
    mem: mem2,
    context: second.context,
    pipeline,
    now,
    ask: async () => {
      throw new Error("a replayed inference must not reach the model");
    },
  });
  const replayed = (qid) => replay.decisions.find((d) => d.qid === qid);
  // …and a correction the user states overrides it: `remember.mjs` writes `source: user` over the
  // same qid, and `mergeSection` lets that through in exactly one direction.
  const corrected = { ...mem, answers: saved.map((r) => (r.qid === "q.inferred.how_heard" ? { ...r, value: "Recruiter", source: "user" } : r)) };
  const afterCorrection = await inferRows({
    formPlan: { ...formPlan, questions: [q.how] },
    decisions: resolveForm({ ...formPlan, questions: [q.how] }, { mem: corrected, pipeline, now }).decisions,
    mem: corrected,
    context: run.context,
    pipeline,
    now,
    ask: async () => {
      throw new Error("a user-corrected answer must not reach the model either");
    },
  });
  const correctedRow = afterCorrection.decisions[0];
  check(
    "infer: an inferred answer is filed under its topic and fills the next form directly — no Jev request, still a check — and a user correction over the same qid replaces it",
    saved.some((r) => r.qid === "q.inferred.how_heard" && r.source === "inferred" && r.answers_questions.length) &&
      replay.requests === 0 &&
      replayed("how").action === "check" &&
      replayed("how").source === "inferred" &&
      replayed("how").option === "Company careers page" &&
      replayed("how").inference.replayed === true &&
      correctedRow.action === "check" &&
      correctedRow.source === "answer" &&
      correctedRow.option === "Recruiter" &&
      /answered this before/.test(correctedRow.why),
  );

  // ── (k2) --no-infer restores exactly today's behaviour, end to end through the CLI ──────────
  const off = planFixture("greenhouse-togetherai-5179372007.json", ["--no-infer"]);
  check(
    `infer: --no-infer skips the tier — no inferred row, and the run stays inside its old request budget (got ${off.requests})`,
    Array.isArray(off.inferred) && off.inferred.length === 0 && off.requests <= 2 && !off.checks.some((c) => /^inferred/.test(String(c.why ?? ""))),
  );
}

{
  const found = windowsChromeCandidates({ PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" });
  check(
    "chrome: Windows installs are looked up under every install root, built from the environment",
    found.length === 9 && found[0] === "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" && found.some((p) => p.startsWith("C:\\Users\\u\\AppData\\Local\\")) && windowsChromeCandidates({}).length === 0,
  );
}

{
  const mem = {
    facts: [
      { id: "f.identity.full_name", value: "T Example", source: "user" },
      { id: "f.identity.pronouns", value: "they/them", source: "user" },
    ],
    preferences: [],
    answers: [],
    stories: [],
    documents: [],
  };
  const labels = { say: "Name Pronunciation | How do you pronounce your name?", ask: "How do you pronounce your name?", name: "Full name", pronouns: "Pronouns" };
  const questions = Object.entries(labels).map(([qid, label]) => ({ qid, label, class: classify(label, "", "text", false), type: "text", required: false }));
  const row = (qid) => resolveForm({ job: {}, questions }, { mem }).decisions.find((d) => d.qid === qid);
  check(
    "pronunciation: 'how do you pronounce your name' is not a demographic question; 'Pronouns' still is",
    questions[0].class !== "sensitive" && questions[1].class !== "sensitive" && questions[3].class === "sensitive",
  );
  check(
    "pronunciation: a name-pronunciation row is never filled with the name itself, while a name row still is",
    row("say").action !== "fill" && row("say").value !== "T Example" && row("ask").value !== "T Example" && row("name").value === "T Example" && row("pronouns").action === "fill",
  );
}

{
  const published = { ats: "greenhouse", questions: [{ qid: "first_name", control: "text", required: true }, { qid: "location", control: "react_select", required: true }] };
  const grown = { qid: "hispanic_ethnicity", control: "react_select", required: false };
  const afterFill = { ...published, questions: [published.questions[0], { ...published.questions[1], control: "location" }, grown] };
  const frozen = { slug: "acme-2", form: formFingerprint(published), decisions: [{ qid: "first_name", readback: { ok: true } }] };
  const replanned = { ...published, questions: [...published.questions, grown] };
  const changed = { ...published, questions: [...published.questions, { qid: "export_control", control: "radio", required: true }] };
  check(
    "B1 refill identity: a control the page corrected and a row it grew do not make an unchanged posting a different form; a changed schema still does",
    formFingerprint(afterFill) !== frozen.form &&
      refillGuard({ frozen, formPlan: replanned, form: formFingerprint(published) }).ok === true &&
      refillGuard({ frozen, formPlan: changed, form: formFingerprint(changed) }).ok === false,
  );
}

// ─── Lever — Spotify, Android Engineer (spotify/2193db3f), recorded 2026-09-24 ──────────────────
// Offline: the recorded fixture is the posting JSON plus the apply page's <form>; no Jev, no browser.
{
  const posting = "https://jobs.lever.co/spotify/2193db3f-77c5-43b8-b030-8f92c9882bf1";
  const target = detectAts(posting);
  check(
    "lever: a posting URL, its /apply form and an EU-hosted board are all detected",
    target?.ats === "lever" &&
      target.site === "spotify" &&
      target.region === null &&
      detectAts(`${posting}/apply`)?.id === target.id &&
      detectAts("https://jobs.eu.lever.co/acme/2193db3f-77c5-43b8-b030-8f92c9882bf1")?.region === "eu" &&
      atsFromUrl(`${posting}/apply`) === "lever",
  );

  const plan = await loadFormPlan(path.join(ROOT, "eval", "fixtures", "lever-spotify-2193db3f.json"));
  const byQid = new Map(plan.questions.map((q) => [q.qid, q]));
  check(`lever: 17 rows (got ${plan.questions.length})`, plan.questions.length === 17);
  check("lever: the plan opens the /apply form, not the posting page", plan.ats === "lever" && plan.url.endsWith("/apply"));
  check("lever: the posting's own country field decides job.country", plan.job.country === "GB" && plan.job.company === "Spotify");
  check(
    "lever: standard fields are keyed and selected by their input name",
    byQid.get("name")?.selector === '[name="name"]' && byQid.get("name").required && byQid.get("resume")?.control === "file",
  );
  const cards = plan.questions.filter((q) => q.qid.startsWith("cards["));
  check(
    "lever: custom cards take their control from the card template (multiple-select → checkbox group, multiple-choice → radio)",
    cards.length === 3 &&
      cards[0].control === "checkbox_group" &&
      cards[1].control === "radio" &&
      cards[1].options.some((o) => o.value === "Yes") &&
      cards[0].selector.startsWith('input[name="cards['),
  );
  check(
    "lever: the country-gated demographic survey is not planned from the schema; its location select is",
    !plan.questions.some((q) => q.qid.startsWith("surveysResponses")) && byQid.get("candidate_location")?.control === "native_select",
  );
  check("lever: the captcha response is never a row", !byQid.has("h-captcha-response"));
}

{
  const three = ["London, Greater London, England, GBR", "London, ON, CAN", "London, OH, USA"];
  check("lever location: a bare city with several matches is ambiguous, never picked by position", pickSuggestion(three, "London").pick === null);
  check("lever location: a saved qualifier makes the match unique", pickSuggestion(three, "London, ON").pick === "London, ON, CAN");
  check(
    "lever location: a suggestion for a different city is never taken",
    pickSuggestion(["South San Francisco, CA, USA"], "San Francisco, CA").pick === null &&
      pickSuggestion(["San Francisco, CA, USA", "South San Francisco, CA, USA"], "San Francisco, CA").pick === "San Francisco, CA, USA",
  );
}

{
  check(
    "lever submit: the board declares a human-only submit step; Greenhouse and Ashby do not",
    typeof boardAdapter("lever").HUMAN_SUBMIT === "string" && !boardAdapter("greenhouse").HUMAN_SUBMIT && !boardAdapter("ashby").HUMAN_SUBMIT,
  );
  const live = [{ qid: "surveysResponses[s][responses][field0]", label: "What best describes your gender?", selector: 'input[name="x"]', control: "radio", multiple: false, options: [{ label: "Woman", value: "Woman" }] }];
  const { novel } = matchLiveControls(live, { questions: [], decisions: [] });
  const bare = matchLiveControls([{ ...live[0], options: undefined }], { questions: [], decisions: [] }).novel[0];
  check(
    "live survey: options rendered in the DOM reach the new sensitive row; a closed menu still sends none",
    novel[0]?.class === "sensitive" && novel[0].options?.[0]?.label === "Woman" && !("options" in bare),
  );
  const hiddenPage = { locator: () => ({ first: () => ({ isVisible: async () => false }) }) };
  const stored = { qid: "surveysResponses[s][responses][field0]", selector: 'input[name="x"]', control: "radio", class: "sensitive" };
  const result = await leverSetField(hiddenPage, stored, "Prefer not to disclose", {});
  check(
    "lever survey: a stored survey the page is not showing yet is deferred behind its location select, never counted as a refused write",
    result.ok === false && result.reason === "control_not_found" && stored.mounts_after === "candidate_location" && deferredMount(stored, result),
  );
}

{
  check(
    "location country: a saved location names its country only when every part agrees",
    countryOfLocation("San Francisco, CA") === "US" &&
      countryOfLocation("Toronto, ON") === "CA" &&
      countryOfLocation("London, ON") === null &&
      countryOfLocation("Paris, TX") === null &&
      countryOfLocation("Remote") === null,
  );
  const byCode = { options: [{ label: "United Kingdom", value: "GB" }, { label: "United States", value: "US" }, { label: "United States Minor Outlying Islands", value: "UM" }] };
  const byName = { options: [{ label: "United Kingdom", value: "1" }, { label: "United States", value: "2" }] };
  check(
    "location country: the one option stating the country is picked by its ISO value, else by its label; none when no option states it",
    countryOption(byCode, "US") === "United States" && countryOption(byName, "US") === "United States" && countryOption(byName, "DE") === null,
  );
}

{
  const file = fileURLToPath(import.meta.url);
  const doc = (name, extra = {}) => ({ id: `doc.resume.${name}`, path: file, source: `resume:${name}.pdf`, ...extra });
  const ml = doc("ml");
  const backend = doc("backend");
  const base = {
    facts: [],
    preferences: [],
    answers: [],
    stories: [
      { id: "b.1", title: "Trained a ranking model", source: "resume:ml.pdf#p1" },
      { id: "b.2", title: "Built a payments API", source: "resume:backend.pdf#p1" },
    ],
    documents: [ml, backend],
  };
  const resumeRow = { qid: "resume", label: "Resume/CV", class: "identity", type: "file", control: "file", required: true };
  const form = { job: { title: "Backend Engineer", company: "Acme", role_family: "backend" }, questions: [resumeRow] };
  const resolved = (mem) => resolveForm(form, { mem }).decisions[0];
  const oneOnly = { ...base, documents: [ml] };
  const mapped = { ...base, preferences: [{ id: "p.resume_by_role_family", value: { backend: "doc.resume.ml" }, source: "user" }] };
  check(
    "résumé pick: Jev is consulted only with several résumés and none tied to this role family",
    resolved(base)._pickResume === true && !resolved(oneOnly)._pickResume && !resolved(mapped)._pickResume && resolved(mapped).path === file,
  );
  check(
    "résumé pick: a résumé whose PDF cannot be read is described by its file name and the stories read out of it",
    resumeCriterion(ml, base).includes("Trained a ranking model") && !resumeCriterion(ml, base).includes("payments"),
  );
  const rows = () => [{ qid: "resume", action: "ask", source: "none", remember_as: { kind: "document" } }];
  const confident = rows();
  const picked = applyResumePick(confident, [ml, backend], { choice: "r1", confidence: 0.9, probabilities: { r0: 0.05, r1: 0.9, none_of_these: 0.05 } });
  const thin = rows();
  applyResumePick(thin, [ml, backend], { choice: "r1", confidence: 0.5, probabilities: { r0: 0.45, r1: 0.5, none_of_these: 0.05 } });
  const none = rows();
  applyResumePick(none, [ml, backend], { choice: "none_of_these", confidence: 0.8, probabilities: { r0: 0.1, r1: 0.1, none_of_these: 0.8 } });
  check(
    "résumé pick: a confident pick attaches that file, a thin one attaches it as a check, none_of_these leaves the stated rule's row",
    picked === backend && confident[0].action === "fill" && confident[0].path === file && !confident[0].remember_as &&
      thin[0].action === "check" &&
      none[0].action === "ask" && none[0].remember_as?.kind === "document",
  );
  check("résumé pick: the reason names the pick and the runner-up with their probabilities", /backend.*90%.*vs doc\.resume\.ml 5%/.test(confident[0].why));
}

{
  const shared = "T Example\nt@example.com · +1 415 555 0100 · github.com/texample\nEDUCATION\nBSc Computer Science, 2019";
  const android = profileLines(`${shared}\nSUMMARY\nAndroid engineer shipping Kotlin apps\n• Built offline playback in Jetpack Compose\nSKILLS\nKotlin, Jetpack Compose, Android SDK\n-- 1 of 1 --`);
  const backend = profileLines(`${shared}\nSUMMARY\nBackend engineer for payment systems\n• Designed Go microservices on Postgres\nSKILLS\nGo, Postgres, Kafka`);
  check(
    "résumé text: contact lines and page markers never leave the file, bullets are unwrapped, content stays in order",
    !android.some((l) => /@|555|github|1 of 1/.test(l)) && android.includes("Built offline playback in Jetpack Compose") && android.indexOf("SKILLS") < android.indexOf("Kotlin, Jetpack Compose, Android SDK"),
  );
  const unique = distinctiveLines(android, [backend]);
  check(
    "résumé text: what only one résumé says is its summary, bullets and skills, not the shared name and education",
    unique.includes("Kotlin, Jetpack Compose, Android SDK") && unique.includes("Android engineer shipping Kotlin apps") && !unique.includes("BSc Computer Science, 2019") && !unique.includes("SKILLS"),
  );
  check(
    "résumé text: a résumé with nothing of its own says so instead of repeating the shared text",
    /same content as the other résumés/.test(resumeDigest("copy.pdf", android, [android])) && resumeDigest("a.pdf", android, [backend], 60).length === 60,
  );
}

{
  const file = fileURLToPath(import.meta.url);
  const ml = { id: "doc.resume.ml", path: file };
  const backend = { id: "doc.resume.backend", path: file };
  const unsure = [{ qid: "resume", action: "ask", source: "none" }];
  const kept = [{ qid: "resume", action: "fill", why: "p.resume_by_role_family → doc.resume.ml", path: file }];
  noClearFit([...unsure, ...kept], [ml, backend]);
  check(
    "résumé pick: with no clear fit, the question says so and names the saved résumés; a default already attached stays attached",
    /none of your 2 résumés clearly fits/.test(unsure[0].why) && /plan\.test\.mjs/.test(unsure[0].why) && unsure[0].action === "ask" &&
      kept[0].action === "fill" && kept[0].path === file && /tailored one may do better/.test(kept[0].why),
  );
  const q = [{ qid: "resume", label: "Resume/CV", type: "file", control: "file" }];
  const answer = async (value) =>
    (await applyAnswers([{ qid: "resume", action: "ask", remember_as: { kind: "document" } }], { resume: { value } }, { formPlan: { questions: q }, documents: [ml, backend], persist: false })).decisions[0];
  const byName = await answer("backend");
  const byPath = await answer(file);
  const unknown = await answer("no-such-cv.pdf");
  check(
    "résumé answer: naming a saved résumé or giving a real path attaches that file; anything else stays a question",
    byName.action === "fill" && byName.path === file && !byName.remember_as &&
      byPath.action === "fill" && byPath.path === path.resolve(file) &&
      unknown.action === "ask" && /no saved document or file named/.test(unknown.why),
  );
}

if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall assertions passed");
