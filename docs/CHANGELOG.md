# Changelog

## Unreleased

**Repeating Education / Employment sections.** A form that asks for the education history now gets
every degree on file — a Bachelor's *and* a Master's — each in its own entry, instead of one box
typed with the newest degree or nothing at all. Read live on 2026-09-24: 15 of 90 hosted Greenhouse
postings (50 boards) show an Education section and 5 require it; Ashby's `EducationHistoryField`
was being planned as a plain text box.

- `src/writer/prompts.mjs`, `src/writer/openai.mjs` (`historyFacts`), `src/writer/extract-basic.mjs`
  — résumé reading keeps the whole history: one `f.education.<slug>` / `f.employment.<slug>` row
  per degree and per role, structured, start date in `since:`. The prompt used to ask for "the most
  recent degree" only, and the no-model reader skipped the Education heading altogether.
- `src/memory/derive.mjs` — `educationHistory()` / `employmentHistory()`, newest first, with parts
  the user added later (`<entry>.start`) outranking the résumé's headline; a year-only range
  ("2016 – 2020") is read, and a closing year is no longer turned into a December nobody wrote.
- `src/schema/greenhouse.mjs` — the hosted page's own `education_config` / `employment` (which the
  board API does not publish) becomes one `type: "repeater"` row; `src/schema/ashby.mjs` reads
  Ashby's history fields the same way, dates split into month and year.
- `src/plan/repeat.mjs` (new) — the repeater expands into ordinary rows (`education[1].school`), so
  resolve, the option ladder, read-back, preflight and the summary treat each box like any other.
  Greenhouse's ten degree buckets are reached by a fixed table ("B.Tech" → Bachelor's Degree),
  never by nearest match; a missing required date is one question for its month and year boxes;
  an optional section never grows an entry the form would then refuse.
- `src/browser/repeat.mjs` (new), `src/plan/execute.mjs` — entry N is made to exist by the
  section's own add button before its boxes are filled, and on Ashby (whose cards repeat the same
  ids) each box is found by its label inside its card. A school is matched literally, never by the
  model; a school Greenhouse's catalogue does not carry is its "Other" entry, as a `check`. A box
  whose list the saved words do not match (a Discipline) comes back as a question carrying that
  list, so the answer is one of the form's own entries.
- `eval/plan.test.mjs` — 16 `history:` assertions over two newly recorded fixtures
  (`greenhouse-togetherai-4188119007.json`, `ashby-plaid-5d8abedc.json`). Live `--no-submit` on
  both forms with a two-degree test profile: every box of both entries set and read back; the one
  row left to the user was a Discipline Jev would not pick at 0.46.

The twelve never-seen postings of `docs/research/20-eval-judge-fresh.md`, graded from their own
screenshots, put six rows wrong and left two answerable ones empty. Each of the eight has a fix at
the rule that produced it and a deterministic assertion in `eval/plan.test.mjs` (131 → 148).

- `src/plan/resolve.mjs` — work authorization now reads the jurisdiction the *question* scopes
  itself to before the posting's: "…a visa to remain in your current location?" and "your
  authorization to work in the country where you live" are about where the candidate is, and both
  were answered for the employer's country and came out inverted. A posting that names no country
  at all falls back to the blanket `f.work_auth.default` as a `check` rather than asking, and
  "legally eligible to work" reads as the authorization question it is (`src/schema/classes.mjs`).
- `src/plan/resolve.mjs`, `canon/vocab/eeo-race.yaml` — a demographic list that splits one saved
  value into sub-regions takes the single option the candidate's *other* stated fact settles (the
  country of citizenship, else of residence, against each sub-region's own definition), and
  declines when two or none qualify. Never the nearest sibling, and never a model: a protected
  characteristic is read from `p.eeo` plus a stated country or it is not claimed at all.
- `src/plan/resolve.mjs` — a consent inside the demographic block ("please confirm you consent
  your self-identification data to be processed") is a signature, answered from its own
  `p.legal.self_identification_consent` and never from the `p.eeo` decline stance; a row whose own
  label conditions the answer on an unestablished fact about the candidate ("If you were
  previously employed by … share the email you used") is asked, not filled from an identity fact;
  and a restrictive-agreements question answers from `p.legal.restrictive_agreements` whatever
  class its wording landed in. A residence question that enumerates its own places ("Do you live in
  one of the following states? …") answers from `f.identity.location`.
- `src/plan/preflight.mjs` — two more refusals before the click: `sensitive_decline_conflict` (a
  demographic row holding the list's decline entry alongside a substantive claim) and
  `sensitive_claim_contradicts` (a ticked disability claim the saved `p.eeo.disability_status`
  denies).
- `src/memory/enrich.mjs`, `scripts/memory-enrich.mjs` (new), `src/jev/plan.mjs` — saved answers and
  stories carry `answers_questions[]`/`topics[]`, written by a cheap model reading the user's own
  text back to itself, and `storyPool()` ranks the candidate pool by them. A **pre-filter only**:
  the tags never answer a field, an untagged store behaves exactly as before, demographic rows are
  never sent, and `learn.mjs`/`remember.mjs` tag new rows best-effort so a failure costs ranking
  rather than the row.

The follow-up round (`docs/research/21-eval-judge-final.md`) put **no** row wrong on the same
twelve postings and left seven the store could have answered. Each has a fix at the rule that
produced it and a deterministic assertion in `eval/plan.test.mjs` (148 → 155).

- `src/plan/execute.mjs` — a live location picker's own list is compared as *places*, not as
  strings: past exact equality, an entry whose leading words are the saved value (the probe typed
  it, so the list holds its continuations) and an entry that writes the same place's country
  suffix differently both commit, as a `check`, and only while exactly one entry fits. A work mode
  is refused before either rung — "Remote" filtered through a geocoder returns real addresses that
  merely contain the word (D13).
- `src/plan/resolve.mjs` — a label that prints its own value for a class of candidate
  (`…Non-U.S. based candidates, please enter "00000"`) fills that literal as a `check` when
  `residenceCountry()` puts the user in the class; a jurisdiction notice offering a residency
  disclaimer beside its Acknowledge ("I am not a California resident") picks the disclaimer from
  `f.identity.location`, because that option is a fact rather than a signature; and a location row
  whose options enumerate places the stated location is provably in none of takes the list's own
  catch-all. All three refuse on a near-miss: a candidate inside the notice's own jurisdiction, or
  in the same country as the listed places, still asks.
- `src/plan/resolve.mjs` — the employment-history matcher reads a *list* of organisations
  ("working at Gusto or Symmetry", "employed by Plaid, Quovo or Cognito") and answers only when
  the derivation holds for every one of them: Yes from the user's own employment facts, No only
  when those facts and the pipeline agree. A pipeline hit is never turned into an employment
  claim, and a list naming no entity of this employer is still nobody's to answer. The same
  derivation lets a conditional row whose label prints the other branch's value ("If not, please
  put N/A") fill that literal once memory refutes the condition, instead of leaving a required
  control empty.

Two cold reviews of the merged branches (`docs/research/23-review-pr1.md`,
`docs/research/24-review-pr2.md`) asked for one follow-up each. Every item below is theirs, with an
assertion in `eval/plan.test.mjs` (199 → 211).

- **One re-run of an application frozen before this version is refused once, and only once.** The
  form fingerprint `decisions.json` stores is now taken from the schema *as the board publishes
  it*, before stored conditional rows are merged in and before the fill loop corrects a control to
  what the page renders. Records frozen by an earlier version carry the old, post-fill digest, so
  the first `apply.mjs --url` on one of them sees a mismatch and refuses. The board did not change;
  the definition did. `--refill` clears it and it does not come back. The refusal text says so
  rather than claiming the posting's form changed (`src/plan/decisions.mjs`).
- `src/browser/chrome.mjs` — on Windows, Google Chrome under *any* install root now outranks a
  Chromium under every root: Chrome's own installer writes `%LOCALAPPDATA%`, which the previous
  root-first order ranked below a system-wide `%PROGRAMFILES%\Chromium`.
- `src/plan/resolve.mjs`, `src/schema/classes.mjs`, `src/plan/infer.mjs` — "Name (phonetic)" is a
  pronunciation question, not the name (B15), and the one spelling of a pronouns row now lives in a
  single exported `PRONOUN_ROW_RE` the classifier, the EEO branch and the evidence tier all read.
- `src/schema/normalize.mjs` — a saved location answers the demographic survey's country select
  only when it is unambiguous: a qualifier neither table can read now vetoes the answer
  ("Vancouver, WA" is no longer Canada) and a location of one part must name a country rather than
  a city ("London", "Dublin" name none). `Bengaluru, India` and `San Francisco, CA` are unchanged.
- `src/memory/resume-text.mjs`, `src/jev/plan.mjs` — the per-posting résumé comparison sends each
  file's career lines under a neutral label (`r0`, `r1`, …) instead of its file name, and drops
  postal-address, date-of-birth, marital-status and nationality lines as well as contact lines. A
  confident pick whose file has been deleted now says exactly that and names the file, instead of
  reporting "no résumé clearly fits"; the résumés offered as an answer are filtered to those still
  on disk, and a `--answers` value naming a *directory* is no longer accepted as a file.
- `src/browser/adapters/lever.mjs` — the location suggestion is clicked by its index in the list
  that was read, never by a substring filter: "San Francisco, CA, USA" is a substring of "South San
  Francisco, CA, USA", so the old filter could land on the wrong row and turn a correct location
  into a question. `src/schema/lever.mjs` now logs the two rows it drops (a second named input in
  one block, a block repeating an input already planned) instead of dropping them silently.
- `scripts/apply.mjs` — the `--json` payload carries `form`, the digest of the form as published;
  `--resume <slug>` reads the board's own confirmation rules against the tab, reports what they saw
  under `confirmation`, and settles `submitted` when the board's receipt is on screen. That is how
  a board the runner never clicks for (Lever, B16) gets its confirmation rules verified — by the
  user's own submit.

## v0.5.0

A correctness pass driven by five cold judgements of filled, screenshotted forms rather than by
code review alone — the round-one/round-two eval-shots harness graded 136 real-profile Decision
rows twice, once before and once after this release's fixes. `docs/POSTMORTEM.md` (new) is the
resulting record: all 35 failure classes found across every graded round, 21 fixed in-tree and 14
open, each with its root cause, why earlier checks missed it, and the guard that now catches it —
no personal value, store path, or real answer text appears in it.

- `docs/POSTMORTEM.md` (new) — the failure-class ledger. §4 documents the nine ordered stages a
  fill now passes through before a submit click is even considered; §5 names what still cannot be
  verified automatically (a score-based captcha's silent rejection, whether a saved value is still
  true, option lists inside a closed `react_select`).
- `src/plan/preflight.mjs`, `scripts/preflight.mjs` (new), `eval/fixtures/preflight-*.json` (new) —
  the last gate before the click, judging what is *on the form* rather than what the plan intended:
  `sensitive_source`, `policy_gate_source`, `draft_gates`, `fact_from_writer`,
  `dependency_child_filled`, `work_mode_as_location`, `prose_into_date_control`, `required_empty`
  (from the page's own live snapshot when there is one), `readback_failed`, and `name_split_blind`.
  A refusal is `blocked{reason:"preflight"}` with `clicked:false`, so the posting stays retryable —
  not retroactive theatre: records frozen during the graded rounds still fail it today.
- `src/plan/draft.mjs` — two Jev relevance gates bracket every writer call: does the saved material
  answer this prompt, before the call; does the drafted text answer it, after. A draft with no
  verdict on record is refused rather than submitted (`draft_gates`), and a fact-seeking textarea
  (e.g. "what languages are you fluent in") is classified as a fact and never handed to the writer
  in the first place.
- `src/plan/resolve.mjs`, `src/schema/normalize.mjs`, `src/schema/classes.mjs` — the guards behind
  six of the postmortem's open findings: a question naming another organisation no longer derives
  an answer from the user's own application pipeline (B4); a citizenship/work-authorization pair
  now answers an export-control status row instead of leaving it blank (B5); a relocation
  preference reaches a country the label names even when the country table can't map it (B6); a
  Yes/No confirmation or a categorical select is never fed the wrong-shaped value behind a sibling
  row (B7); a notice offering to redact a protected characteristic is classed `policy_gate`, not
  `sensitive` (B10); and a work-authorization `why` renders the fact's resolved value instead of its
  field name (B11).
- `eval/plan.test.mjs` — 29 `guard:` assertions, one per named failure class in
  `docs/POSTMORTEM.md`; B1, B2 and B14 additionally refuse at runtime.
- `bench/results/accuracy-ten.{md,json,png}` — the ten-posting, 136-field, real-profile accuracy
  report, now judged twice by two independent cold passes: **89.7% → 94.1%** correct (122 → 128 of
  136 rows), **97.1% → 98.1%** of filled fields correct. The report's per-posting table, three-panel
  verdict/time/cost chart, and root-cause list live at `bench/results/accuracy-ten.md`.
- `README.md` — the "Measured" section embeds the before/after chart and a compact per-posting
  table, and links to the full report and `docs/POSTMORTEM.md`.

## v0.4.0

Setup, simplified. Two product changes came out of user-facing review: the "who can this run for"
question drops to one credential, and the "where does this apply" question — scope — is gone from
everything the user sees.
**A writer is optional.** `TYPESAFE_API_KEY` is the only credential jev-apply needs; the few
sentences it cannot look up (`why_us`, an expanded story, a narrative) are written by whichever of
three backends is configured, auto-detected in that order: an `OPENAI_API_KEY` → the Responses API;
`JEV_APPLY_WRITER_URL` (+ `JEV_APPLY_WRITER_MODEL`) → chat completions against a server the user
runs (Ollama, llama.cpp, LM Studio), no key, billed at $0; neither → the host agent (Claude Code,
Codex) writes it. A row the host has to write leaves `apply.mjs` as a `needs_user` item of kind
`draft` carrying the prompt, the posting's and the user's own material as plain grounding lines, and
the field's stated limit, and comes back through `--answers` checked by the same grounding,
substitution, and limit rules a model's draft faces. Résumé onboarding needs no model at all: with
no writer configured, `learn.mjs --resume` reads a deterministic extractor instead of an LLM.
**Scoping is gone from the user surface.** No `--scope` flag, no "remembered for `<scope>`" wording,
no company or role-family override asked or explained. Everything a user states — a fact, a
standing preference, a correction — holds for every application; a `why_us`/company-specific answer
still keys to its own company internally, derived from the draft, never asked.

- `src/config.mjs` — `REQUIRED_KEYS` narrows to `["TYPESAFE_API_KEY"]`; `OPTIONAL_KEYS`,
  `WRITER_URL_VAR`/`WRITER_MODEL_VAR`, and `writerFromEnv(env, {preferLocal})` (the three-way
  auto-detect, in that order, with a `JEV_APPLY_WRITER_URL` set in the process environment
  overriding a stored OpenAI key for that run). `loadEnv()` treats a variable that is present but
  empty as "off this run", never as unset.
- `src/writer/backend.mjs` (new) — `detectWriter`/`describeWriter`/`complete`/`usageTotals` behind
  one interface for all three backends; `HostWriterRequired` is what `complete()` throws for `host`.
  `src/writer/openai.mjs` keeps the prompts, the schemas, and the grounding/substitution post-checks
  and re-exports the backend's client so every caller goes through one module.
- `src/writer/extract-basic.mjs` (new) — `extractBasic(text, {doc, pages})`: name from the top line,
  contacts by regex, one story per bullet line under a work/projects heading — `extractResume`'s row
  shapes with no model at all.
- `src/plan/draft.mjs` — `hostDraft`/`hostDraftAsks`/`checkHostDraft`/`acceptHostDrafts`/
  `groundingTexts`: a row `draftRows` cannot write because the backend is `host` is turned into a
  `needs_user` question instead of an `ask` with no way forward, and the paragraph that comes back
  through `--answers` is graded by exactly the checks a model's own draft would face.
- `scripts/apply.mjs` — wires `hostDraftAsks` into both `singleRun` and `queueRun`'s `needs_user`
  payload, and `acceptHostDrafts` into `--answers` handling before the ordinary `applyAnswers` pass.
- `scripts/install.mjs` — prints which of the three writing options is active (never key material)
  and, when none is, the three ways to add one.
- `scripts/writer-smoke.mjs` (new) — `--detect` prints the resolved backend; `--extract-basic`
  exercises the deterministic résumé reader.
- `scripts/learn.mjs` — `resumeReader()` picks `extractBasic` over `extractResume` automatically
  when `detectWriter().kind === "host"`, so onboarding never blocks on a missing OpenAI key; the
  day-1 `gaps[]` are `g.work_auth`, `g.notice_rule`, `g.salary`, `g.contact` (only with more than one
  email/phone), `g.resume_by_role_family` (only with more than one résumé), `g.looking_for`,
  `g.eeo`, `g.auto_submit`, `g.auto_draft`, and a conditional `g.identity.name_split` for a
  two-token name where one token is an initial; each carries `remember_as:{kind,id}` (no `scope`)
  or none at all where the answer names its own fact ids directly.
- `scripts/remember.mjs` — `--scope` and the scope classification pass are gone: usage is
  `remember.mjs "<instruction>" [--id <memory id>] [--dry-run]`, output `{status, kind, id}`.
- `src/plan/decisions.mjs` — `needs_user`'s `remember_as` is `{kind, id}`; `memoryRow` derives a
  company-specific answer's home from the question's own class and the posting, never from a scope
  the user is asked to pick.
- `src/memory/resolve.mjs` — `promotionHome(draft)` keys a promoted `why_us`/company-specific answer
  to its own company, derived from the draft; `src/memory/schema.mjs` drops
  `p.legal.previously_employed` from `ID_CATALOGUE` (nothing read a global one).
- `references/memory-format.md` — the "## Scope" section is deleted and its prose rewritten;
  `resolvePreference` still returns `scope: "global"` internally (existing stores keep resolving),
  but nothing new is asked or written about it.
- `SKILL.md`, `README.md`, `INSTALL.md` — the setup story cut to a five-command quickstart, a
  three-line "choose how text gets written" section, and a "Writing a `draft` item" section telling
  the host agent exactly how to answer one; every `--scope` example, "remembered for `<scope>`"
  wording, and company/role-family override explanation is gone.

## v0.3.0

Answers a round-1 screenshot judgement of 200 graded filled-form rows — 155 correct, twelve
systematic errors ranked by cost. Two product policy changes came out of it.
**The runner drafts instead of handing back.** With the new `p.auto_draft` preference on, a required
"why this company" or essay box is written by the writer from the posting's own text and the
candidate's saved material — grounded, inside the field's printed limit, listed under ► DRAFTED, and
never blocking Submit. Facts are still never guessed: a row nothing on file supports goes back to
`ask` carrying the reason. **A legal attestation is never answered from memory** unless the user
stated that exact stance: `policy_gate` rows answer only from an explicit `p.legal.<slug>`.

- `src/plan/draft.mjs` (new) — PLAN §2.2 step 10 as the runner calls it: `draftRows` writes every
  `action:"draft"` row through `whyUs`/`expand`/`narrative`, enforces the field's `limits`, runs
  `groundingCheck` + `substitutionCheck` against the posting's own text, the candidate's stories and
  every other company in the pipeline, and turns a draft it cannot ground back into an `ask`.
  `draftFor({plan, stores})` is the hook `runBrowser` calls, mirroring `replanFor`.
- `src/writer/openai.mjs`, `src/writer/prompts.mjs` — `whyUs({sentence})` is optional. Without the
  user's sentence the thesis is built from the JOB block and the grounding, and the grounding check
  is what keeps it from becoming an opinion about the company.
- `src/schema/ashby.mjs`, `eval/fixtures/ashby-query.graphql` — the `ApiJobPosting` document requests
  `surveyForms`, so Ashby's `_systemfield_eeoc_*` block reaches the FormPlan as `sensitive` rows with
  selectors instead of being on the page and in no plan (judge §3.4, three missing rows on a real
  posting, blind on 5 of 11). A survey row `classify()` reads as a `policy_gate` attestation keeps
  that class — always asked.
- `src/browser/adapters/ashby.mjs` — `eeoControls(page)`, so step 8½ also covers a survey control that
  mounts after the fill loop has passed it.
- `src/browser/adapters/index.mjs`, `src/browser/controls.mjs` — a question the ATS types `date` is
  routed to the shared ladder whatever the DOM calls it, and `setDate` refuses prose
  (`unparsable_date`). Ashby's date input is a bare `input[type=text]`, so the plain-text path took
  the sentence "Available immediately" and read it back green (judge §3.5).
- `src/browser/controls.mjs` — `pickLocation` matches on an answer's *place* parts only, and
  `setLocation` refuses a work mode outright (`not_a_place`). "Remote" put through a geocoder returns
  `Remote, <US state>, United States`, which round 1 committed on a form that declared no US work
  authorization two fields above (judge §3.2).
- `src/plan/execute.mjs` — a retried demographic control that *commits* gets its original `why` back,
  instead of keeping the first attempt's "the form would not take it" about a value the trace and the
  screenshot both show set (judge §3.10). `runBrowser` gains the `draft` hook; a `draft` row carrying
  text is `runnable` and stays a draft through the fill.
- `src/schema/classes.mjs`, `src/plan/decisions.mjs`, `src/plan/resolve.mjs`, `src/canon/answers.mjs`,
  `src/memory/derive.mjs` — `policy_gate` now matches acknowledge / I understand / I agree / privacy
  policy / background check / terms-of, and such rows answer only from an explicit `p.legal.<slug>`
  preference, else ask; the canon bank no longer authors the seven `q.legal.*` attestations. Location
  rows reject a work-mode token and fall back to `f.identity.city`, else ask. Conditional children are
  blanked when the parent is No, names another option, or is unanswered, and re-open verbatim once the
  parent is answered. A date control gets `f.identity.start_date` or today + notice as ISO, never
  prose. `NAME_RULES` stacks qualifiers ("Full Legal Name") and a single-letter token is read as the
  family name. Pronouns fill from `f.identity.pronouns` regardless of `p.eeo`. How-heard synonyms
  include "<Company>'s website", and a relocation country list is answered with the posting's country.
  Parsed word/char limits downgrade an over-length fill to `check` — never truncate — and ride along
  in `draft_request`. `finalize(decisions, {mem, context})` is what turns a why-us/essay `ask` into a
  draft; `fitsLimits`/`pickVariant` are the one shared definition of "fits this field".
- `scripts/apply.mjs`, `src/plan/summary.mjs` — drafts are produced in `--dry-run` too and marked
  `dry` (written, never typed); the JSON's `drafted[]` carries the text and the ► DRAFTED line says
  how long it is and what it was built from.
- `scripts/learn.mjs`, `src/memory/schema.mjs`, `src/bench/synthetic.mjs`,
  `references/memory-format.md` — `p.auto_draft` (day-1 gap `g.auto_draft`), validated like every
  other boolean preference and seeded true on the synthetic bench profile.

## v0.2.0

Product policy change: EEO/demographic questions fill from the user's own `p.eeo` preference instead
of being left blank, and the runner can finish an application itself. Statuses become four:
`submitted` / `ready_to_submit` / `needs_user` / `blocked{reason}`.

- `src/memory/*` — new preference ids: `p.auto_submit` (boolean; global, overridable per company),
  `p.eeo` (`{gender, hispanic_latino, race, veteran_status, disability_status, pronouns?}`, canonical
  values from `canon/vocab`), `p.legal.restrictive_agreements` and `p.legal.previously_employed`
  (`"Yes"`/`"No"`, user-stated only, never code-defaulted). Resolved through the existing
  `resolvePreference(mem, id, {company, role_family})` — no bespoke resolver. Shapes documented in
  `references/memory-format.md`.
- `src/schema/classes.mjs`, `src/plan/resolve.mjs` — `sensitive` (EEO) rows resolve to `fill` from
  `p.eeo` when it is on file, `ask` once otherwise (never `skip`); restrictive-agreements-class
  questions resolve to `fill` from `p.legal.restrictive_agreements`, the one `policy_gate`-adjacent
  exception to "always ask" — AI-usage attestation, arbitration, and consent remain always-ask.
- `src/browser/controls.mjs`, `src/browser/adapters/greenhouse.mjs` — a dedicated open-and-retry path
  for EEO react-selects (explicit menu-open wait, portal-option read) and a no-progress counter that
  treats the EEO block as its own run, fixing the observed failure where three demographic selects in a
  row returned `no_options_rendered` and blocked the posting before an application question was reached.
- `src/browser/adapters/{greenhouse,ashby,generic}.mjs` — `findSubmit`, `confirmSubmitted`, and the
  printable `CONFIRMATION` strategy shape.
- `src/plan/execute.mjs` — the submit step: `SUBMIT` (timeout/captcha-wait constants), `submitReady`,
  `detectSubmit` (read-only dry check), `submitApplication`, `submitOutcome`. A click happens at most
  once per application; an unconfirmed submit is `blocked{reason:"submit_failed"}`, never retried.
- `src/plan/summary.mjs` — a `SUBMITTED` summary header (confirmation text/timestamp, `Pipeline: <slug>
  → applied`) alongside the existing `ready_to_submit` header.
- `scripts/apply.mjs` — `--submit`/`--no-submit` (override `p.auto_submit` for one run) and
  `--detect-submit` (prints the Submit selector + confirmation strategy without clicking); queue mode
  now finishes each posting to `submitted` or `ready_to_submit` per its own preference, and sets the
  pipeline entry to `applied` on a confirmed submit.
- `scripts/learn.mjs` — the day-1 questionnaire grows from six to eight items: EEO self-identification
  (`p.eeo`, each field independently declinable) and the auto-submit preference (`p.auto_submit`).
- `SKILL.md`, `README.md`, `docs/PLAN.md`, `docs/CONTRACTS.md`, `AGENTS.md`, `.omp/WATCHDOG.md` —
  updated for the four-status contract and the new invariants: EEO is filled from a stored preference
  and never guessed; Submit is clicked only with the user's own `p.auto_submit` on, gated on a
  confirmed ATS response, and never twice.

## v0.1.0

First public release. Greenhouse and Ashby hosted boards only; every other ATS URL comes back
`blocked{reason:"unsupported_ats"}`. `apply.mjs` runs the full pipeline end to end — schema fetch,
deterministic resolve, the two Jev requests, a real Playwright fill over a dedicated Chrome CDP
profile with every set read back, and one of `ready_to_submit` / `needs_user` / `blocked` — for a
single posting (`--url`/`--tab`), a recorded fixture (`--schema --dry-run`), a whole pipeline
shortlist in one merged `needs_user` batch (`--queue N`), or a half-filled application
(`--resume <slug>`).

- `src/config.mjs` — constants (`JEV_MODEL`, `OPENAI_MODEL`), `CONFIG_DIR`/`paths`, `loadEnv()`,
  `slugify()`.
- `src/jev/client.mjs`, `src/jev/gates.mjs` — the Jev (TypeSafe System One) client: keep-alive
  transport, `choice`/`noul`/`score` builders, `withNone()`, answer validation, the 255-option /
  56k-token request splitter, and the only place confidence thresholds live.
- `src/schema/{greenhouse,ashby,classes,normalize}.mjs` — public job-schema fetchers, question
  classification (`identity`/`circumstance`/`essay`/`why_us`/`company_specific`/`policy_gate`/
  `sensitive`/`optional_text`), limit parsing, and `FormPlan` normalization; recorded fixtures in
  `eval/fixtures/`.
- `src/memory/*` — the private YAML store (`facts`, `preferences`, `documents`, `answers`,
  `stories`, `drafts`, `corrections`), atomic writes, scope resolution, and derivations
  (`workAuth`, `yearsSince`, `noticeRule`, `salaryFor`, `appliedBefore`).
- `src/writer/openai.mjs` — `extractResume`, `narrative`, `expand`, `whyUs`, plus the grounding and
  substitution post-checks.
- `src/discover/*`, `src/pipeline/*`, `scripts/scan.mjs`, `scripts/pipeline.mjs` — discovery
  providers (Greenhouse, Ashby, Lever, Workable, SmartRecruiters, Workday, HN Who's Hiring), the
  model-free filter chain, cross-run dedup, the Jev fit pass, and the pipeline store
  (`pipeline.yaml` + `scan-history.tsv`).
- `src/browser/*` — Chrome lifecycle over CDP (`chrome.mjs`: spawn-once, connect, disconnect-never-
  close), `readback.mjs` (never-option-0 option picking, set→read-back→retry), and the Greenhouse /
  Ashby field adapters (text, react-select, native select, radio, checkbox, phone, file upload) with
  a shared `trace.mjs`. Verified live against Together AI (Greenhouse) and Baseten (Ashby).
- `src/plan/{resolve,decisions,summary,trace}.mjs`, `src/jev/plan.mjs`, `scripts/apply.mjs` — the
  planner: deterministic resolve pass, the two Jev requests (canonical question, then option/
  boolean), gating into a `Decision` table, the `ready_to_submit`/`needs_user`/`blocked` contract,
  `--queue N` (parallel plan + fill, one merged `needs_user`), `--resume <slug>` (re-attach and
  list every unfilled field), `--answers` re-planning, and the ≤20-line summary.
- `src/canon/*`, `scripts/canon-scan.mjs`, `scripts/canon-cluster.mjs` — the corpus builder (400
  postings, 20 families, Greenhouse/Ashby/Lever) and the clustering pipeline that turns it into
  `canon/questions.yaml` (292 canonical questions, 8 layers), `canon/families/*.yaml`,
  `canon/vocab/*.yaml`, and `canon/templates/*.yaml`.
- `scripts/canon-eval.mjs` — hold-out coverage report (mapped/answerable % by layer, ATS, family).
- `scripts/answers.mjs` — pre-computed `answers.yaml` (constant/rule/policy/narrative rows) for a
  chosen family set, with a curation pass for narrative drafts.
- `scripts/learn.mjs`, `scripts/remember.mjs`, `scripts/install.mjs` — onboarding (résumé/link
  extraction, seed import, the day-1 gap list), corrections/promotions with inferred scope, and
  private-directory setup.
- `SKILL.md`, `INSTALL.md`, `README.md`, `references/*.md`, `eval/plan.test.mjs`, `LICENSE` — the
  published skill surface and its offline acceptance check.
