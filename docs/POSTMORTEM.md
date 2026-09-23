# Postmortem — what filled wrong, why, and what stops it now

Five cold judgements of real and synthetic fills: round 1 and round 2 (11 postings each, graded from
screenshots against the store), two single-posting final submit gates (Together AI, Scale AI), and a
ten-posting real-profile round — 136 decision rows, **89.7% correct, 97.1% of *filled* rows
correct**. The judge reports are local notes under `docs/research/` and are not published; every
claim below is restated from the code and the commit history, which are.

Scope of the record: **35 distinct failure classes**. 21 are fixed in-tree (`77214e5`, `be3aafc`,
two earlier in `d7a49f8`); the other 14 each named the guard **required** before auto-submit could be
trusted on an unseen board, and every one of those guards is now in the tree. Guard status is read
off the tree: text in quotes is an assertion that exists in `eval/plan.test.mjs`, a name in
`code font` is a runtime refusal in `src/plan/preflight.mjs`. No personal value, no store path and
no real answer text appears here: rows are named by qid, label or memory id.

## The three that matter most for the next phase

1. **The obvious submit command re-fills the page it is about to submit** (B1). A plain
   `apply.mjs --url …` run re-opens the tab, *reloads* it (`openPosting`, `src/plan/execute.mjs`),
   re-fills from scratch and only then reaches `maybeSubmit`; `--resume <slug>` alone never clicks
   at all. That re-fill is now both gated and *identified*: `decisions.json` freezes the form's
   fingerprint, and a run whose page no longer matches the one a reviewed fill landed on refuses
   rather than re-filling, unless `--refill` says otherwise.
2. **The runner under-writes rather than mis-writes, and the under-write was invisible in the
   record** (A17, B2, B4–B7). 8 of the 14 non-correct rows in the ten-posting round were a required
   field left empty while memory held the answer. A blank raises no read-back error, no validation
   marker and no exception — and `required` was `null` on every decision row, so "required and
   empty" was only countable live, off the page. It is now on the frozen row.
3. **A write that lands is not a write that is right** (A1, A2, A12, B4). Every round-1 `wrong` row
   was `readback.ok: true`. Read-back proves the browser accepted a value; nothing before the judge
   rounds asked whether the value answered the question.

## 1 · Fixed in-tree

| # · class | What a user would have seen | Root cause | Why the earlier checks missed it | Fixed | Guard |
|---|---|---|---|---|---|
| A1 `policy_gate_from_answer_bank` | A privacy-policy consent and a background-check attestation **ticked** on the user's behalf | `classify()` returned `company_specific` for "acknowledge…"/"I understand…" labels (`src/schema/classes.mjs`), so the `policy_gate` branch never ran and `src/canon/answers.mjs` answered from `q.legal.*` | no attestation label in the fixture corpus, and a tick is a *successful* write — read-back cannot tell a correct tick from a forged one | `77214e5` · `classes.mjs`, `canon/answers.mjs` | "classify: an acknowledgement of a privacy policy is a policy_gate"; "policy gate: asks with no p.legal.* on file, naming the id that closes it" + runtime `policy_gate_source` |
| A2 `work_mode_as_location` | A US town the candidate has no connection to, committed into Location on a form that also declares no US work authorization | a work-mode value reached the geocoder and `pickLocation()` matched on its prefix (`resolve.mjs`, `controls.mjs`) | `setLocation` checks the read-back against *the label it clicked*, never the user's city — deliberate, and it makes a fabricated pick log `ok: true` | `77214e5` · `resolve.mjs`, `controls.mjs` (`WORK_MODE_RE`, `not_a_place`) | "location: a work-mode fact is not a place — the row asks for the city" + runtime `work_mode_as_location` |
| A3 `conditional_child_filled` | A follow-up textarea holding an explanation under a parent answered **No**, and another under a parent nobody answered | `DEPENDENCY_RE`/`conditionPolarity()` did not list "responded/indicated/chose", and `applyDependencies()` skipped a parent still on `ask` | `dependencyOn()` was only ever run against the two recorded boards' phrasings | `77214e5` · `classes.mjs`, `resolve.mjs` | in place: "A4 survey_block_unreachable — the Ashby survey's `_systemfield_eeoc_*` rows are in the plan and every one of them is classed sensitive", over `eval/fixtures/ashby-survey.json` (a synthetic document for the `surveyForms` branch; the two recorded fixtures stay as captured) |
| A4 `survey_block_unreachable` | A whole US EEO block — gender, race, veteran — blank on a live posting while `p.eeo` was on file | the Ashby posting document never requested `surveyForms`, so `_systemfield_eeoc_*` existed on the page and not in the FormPlan | a row absent from the plan is invisible to every plan-level assertion; the gap was a comment in the adapter header, not a check | `77214e5` · `schema/ashby.mjs`, `eval/fixtures/ashby-query.graphql` | in place: "A4 survey_block_unreachable — the Ashby survey's `_systemfield_eeoc_*` rows are in the plan and every one of them is classed sensitive" (the recorded fixture now carries the `surveyForms` block the document requests) |
| A5 `prose_into_date_control` | "Available immediately" typed into a date field, picker left **open** over the next question | the circumstance branch returned the notice-rule prose; `setControl()` dispatched on the *detected* control, so `setDate()`'s guard never ran | the row was driven as text and read back as text — a passing write of a failing value | `77214e5` · `resolve.mjs`, `controls.mjs` | "start date: a date control gets a date, never the notice-period prose"; `eval/fixtures/controls.html` `ashby_start` + runtime `prose_into_date_control` |
| A6 `identity_label_phrasing_miss` | Required "Full Legal Name" and "From where do you intend to work?" empty with both facts on file | `NAME_RULES`/`LOCATION_RE` matched the fixtures' wordings only | the regexes were tested against the corpus that produced them | `77214e5` · `resolve.mjs` | "name: 'Full Legal Name' …"; "location: 'From where do you intend to work?' reads as a location question" |
| A7 `pronouns_as_protected_class` | Pronoun fields blank on three boards although the user volunteered them | `SENSITIVE_RE` included `pronouns?`, so the row was gated on `p.eeo` | the EEO invariant asserted that a *guess* never happens, never that a volunteered fact is used | `77214e5` · `resolve.mjs` | "pronouns: filled from f.identity.pronouns with no p.eeo on file" |
| A8 `option_mapping_gives_up` | A saved how-heard preference and a saved relocation stance beside option lists that state them in other words; boxes empty | no synonym set in `src/canon/normalize.mjs`; the relocation branch never mapped a country list | "no option matches" degrades to an `ask`, and asks were counted safe until the judge rounds graded them | `77214e5` · `normalize.mjs`, `resolve.mjs` | "options: a company's own careers page is matched exactly where the list offers it"; "relocation: a country list is answered with the posting's country" |
| A9 `word_limit_ignored` | A 140-word essay in a field printing "In 100 words or less" | `parseLimits()` wrote `q.limits.words` and no consumer read it | the parser had a test; the consumer had none | `77214e5` · `answers.mjs`, `decisions.mjs`, `draft.mjs` | "limits: a 140-word answer does not fit a 100-word field"; "limits: an over-length fill is downgraded to check" |
| A10 `name_split_blind` | The given name in **Last Name** and an initial in First Name, on every Greenhouse board | the split helper assumed `<given> <family>` and split on the space | synthetic names are two clean tokens; the real shape never appeared in a fixture | `77214e5` · `resolve.mjs`, `derive.mjs` | "name: an initial is the family name, whichever side it is written on" + runtime `name_split_blind` — which catches the residue: one frozen record from the graded rounds still carries a mechanical split made *after* both name facts were saved, and the new gate refuses it |
| A11 `retry_reported_as_failure` | A summary reading "the form would not take it" beside a form that carried the value | the live-sensitive retry re-drove the control but never rewrote the `why` left by the first `control_not_found` | assertions covered the form state; the sentence the user actually reads had none | `77214e5` · `execute.mjs` | in place: "A11 retry_reported_as_failure — a row the page read back never keeps a control_not_found why, and a row the retry never reached is still an ask" — `restoreRetried` no longer needs the `_was` memory to drop the complaint |
| A12 `selfid_text_into_accommodation_box` | The disability self-ID sentence typed into a box that said *not* to restate it and asked about accommodations | `SENSITIVE_RE` matched "disability" in the label and the no-options branch wrote the EEO map value verbatim | the branch existed for genuine free-text self-ID fields, never tested against a box that merely *mentions* a protected characteristic | `77214e5` · `resolve.mjs`, `classes.mjs` (`isAccommodationRequest`) | "sensitive: a free-text box that does not ask you to self-identify gets no canonical wording"; "accommodation: p.accommodation answers it, and only that" + runtime `sensitive_source` (both halves of the provenance must agree) |
| A13 `checkbox_group_as_boolean` | Four demographic/relocation questions with every box empty, each reported `not_boolean` | `setControl()` drove a checkbox *group with option labels* down the single-checkbox path | before `p.eeo` existed on the bench profile those rows resolved to `ask` and were never driven — newly *exposed*, not newly introduced | `77214e5` · `controls.mjs`, `eval/fixtures/controls.html` | `scripts/controls-smoke.mjs` cases `checkbox_group`, `checkbox_group_ashby`, `checkbox_1option` + runtime `readback_failed` ("a write the page never confirmed is refused") |
| A14 `eeo_vocab_variant_miss` | A military-service question blank while "Veteran / Retired" was on screen and the token was saved | the veteran vocabulary knew only US protected-veteran wording | vocab files were written from the boards in the corpus | `77214e5` · `canon/vocab/eeo-*.yaml` | "eeo: 'Veteran / Retired' states a saved veteran, and 'Never served' does not" |
| A15 `writer_never_fires` | Required "Why do you want to join …?" handed back empty on real postings | the draft path was reachable only behind a story match, and no saved story *is* a why-us | 0 writer calls across 11 postings read as "cheap", not as "broken" | `77214e5` · `decisions.mjs`, `plan/draft.mjs` | "auto-draft: p.auto_draft turns a why-us ask into a draft request for the writer" |
| A16 `draft_grounding_question_blind` | The same latency anecdote in every draft — twice on one page, three paragraphs apart | the grounding list was byte-identical for three different companies, and nothing excluded a story another box on the page had already told | drafts were graded on limits, grounding and refusals; nothing compared two drafts to each other | `77214e5` + `be3aafc` · `decisions.mjs`, `jev/plan.mjs` (`storyPool`), `draft.mjs` | "story pool: a prompt naming a topic is offered only the items that carry it" + runtime `draft_gates` (a draft with no relevance verdict on record never ships) + in place: "A16 draft_grounding_question_blind — a second box on the same page is offered a different story, and with only one on file repeating beats refusing" |
| A17 `employment_education_id_miss` | Required job title, employer and school blank on three real boards with all three on the CV | the resolver read `f.employment.current`/`f.education.school`; a store written from a real CV holds one dated row per role | the bench profile *does* carry the canonical ids (`src/bench/synthetic.mjs`) — green on synthetic, blind on real | `be3aafc` · `derive.mjs` (`latestEmployment`/`latestEducation`), `resolve.mjs`, `answers.mjs`, `jev/plan.mjs` | "employment: the newest `since:` role is the one read…"; "employment: a bare 'Current company' is not answered with an employer the user has left"; "canon rule: 'where have you most recently worked' resolves to the newest employer" |
| A18 `topic_qualifier_dropped` | "Your most complex project **with LLM**?" answered with a GPU-kernel physics story, on an LLM company's form | a qualified label collapsed onto the topic-free `q.narrative.exceptional_work` | canon matching was scored on whether the *qid* matched, never on whether the answer was responsive | `be3aafc` · `canon/normalize.mjs` (`unmetTopics`), `jev/plan.mjs` (`topicGap`) | "topics: a topic-free answer does not answer a prompt that names a topic"; "story pool: with nothing on file about the topic the pool is empty" |
| A19 `fact_question_drafted` | A required "What spoken languages are you fluent in?" answered by the writer from a GPU-inference story, with a self-defeating disclaimer | a textarea with a question mark classified as `essay`, and `autoDraft()` drafted any essay row | round 1 graded this exact row **correct** as an `ask`; the regression only became possible once `p.auto_draft` was on | `be3aafc` · `classes.mjs` (`FACT_SEEKING_RE`), `decisions.mjs`, `draft.mjs` (two relevance gates) | "classify: a spoken-languages textarea is a fact, not an essay"; "auto-draft: the spoken-languages row is never drafted"; "resolve: with no languages fact on file the row is an ask, and empty" + runtime `fact_from_writer` |
| A20 `remember_id_inference` | "I currently live in <city>" saved under a brand-new id no resolver rule ever reads — the fact on file, permanently unused | `remember.mjs` minted an id from the sentence instead of selecting among the ids the rules read | nothing asserted that a saved row is *reachable*; the store validated shape, not usefulness | `77214e5` · `memory/schema.mjs` (`ID_CATALOGUE`), `scripts/remember.mjs` | in place: "A20 remember_id_inference" ×3 — the criteria are the catalogue plus the saved ids with an explicit `none_of_these`; `none_of_these` above the gate mints and below it asks; a catalogue id stores the value, not the sentence |
| A21 `company_question_never_rephrased` | A required question the store answers verbatim, asked anyway because its wording was unfamiliar | anything unrecognised fell to `company_specific` → `ask` with no second look | the corpus was clustered from the same boards the matcher was tested on | `d7a49f8` (second look) + `be3aafc` (topic gate on that pass) · `jev/plan.mjs` | in place: "A21 company_question_never_rephrased — a rephrasing that does not answer the label's topic leaves the row open; one that does answers it" (`topicGap` through `applyRephrasing`) |

## 2 · Open when the record was written — every guard now in the tree

Each was verified by reading the named code, not by trusting a report. Every row below carries an
assertion in `eval/plan.test.mjs`; B1, B3, B12 and B14 additionally refuse at runtime. What the
guards do *not* do is make the behaviour unfalsifiable — each one names the branch it pins, and §5
still lists what no assertion in this repo can decide.

| # · class | What a user would have seen | Root cause | Why the earlier checks missed it | Guard |
|---|---|---|---|---|
| B1 `submit_preflight_refill` | Submit clicked on a fresh re-fill of the page, not on the state that was reviewed | `--url` takes `attach:false` → `openPosting` reloads and re-plans, then `maybeSubmit` clicks; `--resume` alone never clicks | nothing operated at the moment of the click; readiness was computed from the plan, not from the page | **in place**: `submitGate()` refuses before the click and `settle()` records `blocked{reason:"preflight"}` with `clicked:false` — "guard: B1 submit_preflight — a refused submit is a no-click marker carrying every failure"; and the identity refusal itself — `decisions.json` freezes the form's fingerprint (`formFingerprint`) and `refillGuard` refuses to re-fill a posting whose shape changed under a fill the page already read back, unless `--refill` says so: "B1 submit_preflight_refill — a --url run refuses to re-fill a form that is not the one it filled, unless --refill says so" |
| B2 `required_flag_absent` | Nothing — this is why a blank required field is unprovable from the record | `required` is `null` on every decision row; only the draft record keeps it | every required/optional call in all five rounds was read off an asterisk in a screenshot | **in place**: `required_empty` reads the live snapshot and outranks the plan — "guard: required_empty — the live snapshot outranks the plan: a control empty on the page refuses the submit"; and `required` is now carried from the form's own schema onto every frozen row (`withFormFacts`), so a fill is gradable without a browser: "B2 required_flag_absent — the form's own required flag is carried onto the decision and survives the freeze" |
| B3 `sensitive_readback_unprovable` | Nothing — but a reviewer without the browser cannot prove the EEO block landed | a sensitive row stores `observed: ""` by design, so `readback.ok` is the only signal | the redaction rule that protects the value also erases the evidence | **in place**: a `sensitive` row's read-back records `observed_matches:boolean` in place of the value, and the preflight refuses a false verdict — runtime `sensitive_readback` + "B3 sensitive_readback_unprovable — a sensitive row records observed_matches instead of the value, and a false verdict refuses the submit" |
| B4 `third_party_employer_from_pipeline` | "No — I have never been employed by <audit firm>", justified by "the pipeline has no record for <this company>" | the applied-before branch derives from the application pipeline for any matching label, ignoring which organisation the label names | the answer happened to be true; only a judge reading the `why` could see it was unfounded | **in place**: "guard: B4 third_party_employer_from_pipeline — an employment-history row is answered from the pipeline only when the label names *this* company or puts it in the first person; PwC asks" (`asksAboutThisEmployer`) |
| B5 `citizenship_blind_export_control` | Two required export-control rows empty with the exact option ("I am not a U.S. person…") printed on screen | `citizenshipCountry()` is read only for a remote posting naming no country, so the one row class *about* citizenship cannot see the fact | export-control rows appeared for the first time in the ten-posting round | **in place**: "guard: B5 citizenship_blind_export_control — an export-control status row is answered from f.citizenship + f.work_auth as a check, never from a neighbouring fact and never by position" + F2's two assertions on the boards' own labels |
| B6 `relocation_label_country_unknown` | "Are you based in Cyprus, or open to relocating?" empty while the same preference answered Yes on two other boards | the country table has no entry for that country, so `countryInQuestion()` returns null and `relocationAnswer()` turns `anywhere_except` into null | the country table was built from the corpus' own postings | **in place**: "guard: B6 relocation_label_country_unknown — a country named only in the label reaches p.relocation (Yes), an excepted country and one outside an explicit to[] are No" + "F3 country_table — …an unmappable destination is still an ask, never a default Yes" |
| B7 `shape_mismatch_into_select` | Two required rows empty: a Yes/No confirmation fed a name string, a status select fed a sibling row's boolean | no shape reconciliation before option matching | it fails safe — "no option states it" → `ask` — so it looks like a legitimate ask in every count | **in place**: "guard: B7 shape_mismatch_into_select — a Yes/No confirmation is answered Yes from the presence of the fact behind it, and never fed the name string itself"; "…a categorical status select never carries a value its own options do not state; with no matching status on file it asks" + F4's two assertions |
| B8 `race_conditional_on_hispanic` | Nothing visible — but the run logs `failed: 1` for a complete fill, and one affirmative ethnicity answer away the race control never mounts at all | Greenhouse mounts `#race` only after the ethnicity question is answered; the planner plans it from the payload as a top-level row | the retry pass happened to answer it after its parent in all seven recorded runs | **in place**: "guard: B8 race_conditional_on_hispanic — a demographic row is planned as a fill from p.eeo, and one the page never confirmed cannot be submitted" + "B8 race_conditional_on_hispanic — race is planned as a dependant of the ethnicity row, driven after it, and a not-yet-mounted conditional is deferred rather than failed" (`mounts_after` in `schema/greenhouse.mjs`, `rowOrder`/`deferredMount` in `plan/execute.mjs`) |
| B9 `eeo_split_token_undisclosed` | A demographic question declined although the store held the answer, with a `why` citing the decline preference on a *race* row | one saved token maps to ≥2 of that form's mutually exclusive options; folding it into the standing decline is invariant-safe but unexplained | declining is indistinguishable from a correct decline in every count, and the behaviour is deliberate and pinned by "sensitive: a survey that splits a saved race answers from the stated standing decline" | **met**: "guard: B9 eeo_split_token_undisclosed — when a form splits one saved EEO token across options, the row's own `why` says so and names the preference it came from". Disclosure, not a behaviour change; the decline itself stays pinned by the assertion in the previous column |
| B10 `age_notice_as_sensitive` | An "I acknowledge" box unchecked for the right outcome and the wrong reason — a reason that keeps it unanswerable even after the user states a preference | a notice *offering* redaction of a protected characteristic matches `SENSITIVE_RE` | the outcome was correct, so no count moved | **in place**: "guard: B10 age_notice_as_sensitive — a notice offering redaction of a protected characteristic is a policy_gate answered from p.legal.age_redaction_ack alone, and asks while that row is absent" (`policySlug`) |
| B11 `why_text_misleading` | `► CHECK` lines reading "…for CY (authorized) → option No" — the sub-question's *name* where its value belongs | the work-auth `why` renders the fact's field name, not its value (`resolve.mjs`) | the `why` is what the user reads and the one artefact nothing asserted (the two round-2 cosmetics, "on file on file" and the office-location preference, *are* asserted) | **in place**: "guard: B11 why_text_misleading — the work-auth answer, the sentence request 2 matches against and the user-facing `why` all state the fact's value, never its field name" |
| B12 `overlay_over_submit` | A board's own cookie card covering the lower-right of the page, including part of Submit | not modelled: the runner scrolls and clicks the adapter's control | overlays are the board's widget, invisible to every plan-level check and easy to read as scenery in a screenshot | **in place**: runtime `overlay_over_submit` — `submitObstruction()` hit-tests the submit control's own box and the preflight refuses a click that would land on the board's overlay: "B12 overlay_over_submit — an element covering the submit control refuses the click, a clear button passes, and no geometry at all is unchecked" |
| B13 `captcha_challenge` | A submit that posts no token, or a challenge the runner cannot answer | score-based reCAPTCHA is injected after the form renders; a click before it exists posts an untokenised form | — | **already guarded, keep it**: `scripts/submit-smoke.mjs` asserts `blocked{submit_failed}` with `cause: "captcha_challenge"`, the lazily injected script is waited for, and the runner never solves one. The *silent* score rejection stays unverifiable (§5) |
| B14 `host_draft_ungated` | A paragraph written by the host agent sitting in a required box with no relevance verdict behind it | `acceptHostDrafts()` checks limits, grounding and substitutions but bypasses both Jev relevance gates in `src/plan/draft.mjs` | the host writer backend was added after the gates, and the gates live inside the model-writer call; no graded round used a host-backed draft | **in place**: runtime `draft_gates` refuses to submit a draft carrying no verdict, and the host path now runs both gates at fill time so the row is downgraded to `ask` instead — "B14 host_draft_ungated — a host draft runs both relevance gates at fill time: it ships with both verdicts on record, and a gate below the threshold (or one that cannot be reached) sends the row back as an ask" |

## 3 · Why the earlier checks missed all of this

Three structural blind spots. **The bench profile was too tidy** — it carried the canonical memory
ids, two-token names and a real city, so A10, A17 and A2 could not appear; A17 is the pure case,
green on synthetic and four required fields lost on real. **Read-back answers the wrong question** —
it proves the browser accepted the value, and every `wrong` row in round 1 was `readback.ok: true`;
correctness needed a cold reader with the store in hand. **An `ask` looked safe** — asks were counted
as the invariant working, so six classes (A6, A8, B5–B7, B9) hid inside a number nobody graded until
the judge rounds started grading the *decision to ask*.

## 4 · How a fill is verified before submission

Nine ordered stages. Each can only downgrade a row (`fill` → `check` → `ask`); nothing upgrades a
row on confidence alone.

1. **Deterministic resolution** (`src/plan/resolve.mjs`). Identity, circumstance, sensitive, legal
   and dependency rows resolve from facts and preferences by rule. An unknown personal fact is
   `ask` — never a default, never the first option. A value read out of prose commits as `check`.
2. **Jev selection with `none_of_these`** (`src/jev/plan.mjs`). Only rows the rules left open reach
   the model, and only ever as a *selection* between saved items or the form's own options. Every
   question carries an explicit `none_of_these` exit, and the answer is validated (`choice ∈
   criteria`, probabilities sum ≈ 1, argmax == choice) before it is used.
3. **Gates** (`src/jev/gates.mjs`, the only place thresholds live). `none_of_these` or confidence
   below `askBelow` (0.5) ⇒ `ask`; a top-to-runner-up margin under `checkGap` (0.15) ⇒ `check`, so a
   thin win is surfaced rather than filled silently; no distribution at all ⇒ `check`.
4. **DOM read-back on every write** (`src/browser/controls.mjs`, `readback.mjs`). The control is
   re-read after the write and the outcome appended to the application's `trace.jsonl`. Sensitive
   values are redacted there and never photographed.
5. **Dependency pass.** A child whose parent is negative *or* still unanswered is blanked; the
   parent's answer is what re-opens it.
6. **Required-empty check** (`submitReadiness`, `src/plan/execute.mjs`). Zero `ask` rows and zero
   required controls still empty — *including* controls the plan never knew about, because a form
   can grow a conditional while it is being filled. A `sensitive` ask is reported and never
   subtracted: auto-submitting past a demographic question answers it by omission.
7. **Draft relevance gates** (`src/plan/draft.mjs`). A draft must be grounded in the user's own
   material, inside the field's stated limit, name no other company the user is applying to, and
   repeat no story another box on the same page already told. Then two Jev judgements bracket the
   writer: *does the saved material answer this prompt?* before the call, *does this text answer this
   prompt?* after it. Below the gate the row goes back to `ask`. A gate that cannot be reached
   refuses — an unverifiable draft is not a draft. The host writer backend faces the same two
   gates on the way back in through `--answers` (B14).
8. **Preflight** (`src/plan/preflight.mjs`, `scripts/preflight.mjs`, `apply.mjs --preflight`). The
   last gate before the click, and the only one that judges what is *on the form* rather than what
   the plan intended: twelve refusals — `sensitive_source`, `policy_gate_source`, `draft_gates`,
   `fact_from_writer`, `dependency_child_filled`, `work_mode_as_location`, `prose_into_date_control`,
   `required_empty` (from the page's own snapshot when there is one), `readback_failed`,
   `sensitive_readback` (the in-page verdict a redacted row records in place of its value),
   `name_split_blind`, and `overlay_over_submit` (the board's own cookie card over the button) —
   with the `guard:` assertions in `eval/plan.test.mjs` and four recorded fixtures behind them. A
   rule whose inputs are absent is reported `unchecked`, never passed. A refusal is
   `blocked{reason:"preflight"}` with `clicked:false`, so the posting stays retryable. It is not
   retroactive theatre: three records frozen during the graded rounds fail it today — two for
   `draft_gates` (their drafts predate the gates) and one for `name_split_blind`. Before any of it
   runs, a re-fill is refused outright when the page is no longer the form the frozen plan was
   filled against (`refillGuard`, B1).
9. **Confirmation detection** (`src/plan/execute.mjs`). The attempt is traced *before* the click, so
   a crash during the wait cannot lose the fact that an application was sent, and a click happens at
   most once per application. The board's own confirmation rules are then polled for ≤45 s, stopping
   early on a visible error banner or a captcha challenge. Confirmation is checked before failure —
   a receipt page carrying the word "error" in its footer is still a receipt. No confirmation ⇒
   `blocked{reason:"submit_failed"}` with a screenshot, never retried, never reported as success.

## 5 · What we still cannot verify automatically

- **What the board actually posts.** Two Greenhouse forms render a country dial-code box beside a
  number that already carries the same dial code; one board displays a date as `11/02/2026` without
  saying which order it posts. Both need one manual submit-and-inspect.
- **Whether a saved value is true.** The pipeline verifies provenance and reachability, never
  accuracy. A role that ended last month, a stale city, a preference the user has since changed —
  all fill cleanly.
- **Sensitive rows, end to end.** The value is redacted in the trace, blank in the record and
  painted over in the receipt screenshot. The record now carries the page's own verdict
  (`observed_matches`) instead of the value, so a reviewer can tell a block that landed from one
  that did not — but "the value is the right one" is still `p.eeo` plus a human looking at pixels.
- **Required vs optional, before this pass.** Decision rows carry `required` from the form's own
  schema now; every required/optional judgement in the five graded rounds was still read off an
  asterisk in a screenshot, so those numbers cannot be recomputed from the frozen records (B2).
- **Option lists inside a closed control.** A `react_select` does not render its options until it is
  opened, so "no matching option exists" is unfalsifiable from a screenshot for those controls.
- **Whether a draft is *accurate*.** The gates check grounding, limits, exclusivity and relevance.
  "Grounded" means every number and name traces to cited material; it does not mean the sentence is
  a true account of what the user did, and nothing checks tone, register or role fit.
- **Whether a score-based captcha silently rejected the session.** A visible challenge is detected
  and blocks; a failing invisible score leaves no signal but a missing confirmation, which is
  indistinguishable from a slow board.
- **The correctness oracle itself.** There is no automated pixel judge: screenshots are produced by
  the harness and graded by a cold reader with the store in hand. Every accuracy number in this
  document comes from that process, and it does not run in CI.
- **The one-shot rows.** A standing "No" to "do you have a close personal relationship at this
  company?" is right until the day it is wrong, and nothing can tell which day that is.
