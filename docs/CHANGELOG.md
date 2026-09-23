# Changelog

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
