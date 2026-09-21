# jev-apply bench — 2026-09-22-round3-domfix

5 posting(s) · 1 ready_to_submit · 4 needs_user · 60/97 fields filled · 18 ask(s) · 0 failed set(s) · 168.9s wall · $0.006406

**`--exercise-controls` run:** after each fill, every remaining non-sensitive, non-gate row was driven with a bench-chosen value. Those are counted as `exercised`, never as `filled`.

Started 2026-09-22T20:55:50.616Z · list `/tmp/jev-bench/round3-subset.yml` · home `/tmp/jev-bench` · CDP 9224 · models `jev-1.13.0` / `gpt-5.4` · synthetic profile, demographics skipped, Submit never clicked.

Memory: the synthetic store **plus** `scripts/answers.mjs --families devrel_techwriter,frontend,product_manager,security` — 21 constants · 12 rules · 13 policies · 76 narratives (122 rows). answers ready for 63% of questions seen in 500 real forms; 74 narratives to review. Not pre-answered: q.auth.nationality needs f.citizenship; q.legal.previously_applied needs pipeline.

## Per posting

| # | company | family | ATS | status | filled/total | asks | failed | ms | $ |
| ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | cloudflare | security | greenhouse | ready_to_submit | 12/17 | 0 | 0 | 15935 | $0.000266 |
| 2 | 1password | product_manager | ashby | needs_user | 19/28 | 6 | 0 | 20978 | $0.002528 |
| 3 | elevenlabs | frontend | ashby | needs_user | 8/12 | 2 | 0 | 13953 | $0.001060 |
| 4 | deepl | product_manager | ashby | needs_user | 9/17 | 6 | 0 | 14192 | $0.000551 |
| 5 | figma | devrel_techwriter | greenhouse | needs_user | 12/23 | 4 | 0 | 16729 | $0.002001 |

## Per control type

| control | attempts | ok | fail | ok % | median ms | replanned |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| text | 30 | 30 | 0 | 100% | 738 | 1 |
| textarea | 7 | 7 | 0 | 100% | 726 | — |
| react_select | 3 | 3 | 0 | 100% | 1299 | — |
| radio | 4 | 4 | 0 | 100% | 701 | — |
| checkbox | 2 | 2 | 0 | 100% | 679 | — |
| tel | 4 | 4 | 0 | 100% | 666 | — |
| file | 5 | 5 | 0 | 100% | 488 | — |
| location | 6 | 6 | 0 | 100% | 1966 | 5 |

## Failures, ranked

| kind | reason | count | controls | examples (form labels) |
| --- | --- | ---: | --- | --- |
| plan | plan:no_product_manager_senior_eu_remote_row_ | 2 | — | "What is the beginning of your desired annual base salary ra…" · "What is the end of your desired annual base salary range? (…" |
| plan | plan:no_product_manager_senior_uk_london_row_ | 2 | — | "What is your annual salary expectation?" · "Would you like to provide any additional context or details…" |
| plan | plan:attestation | 1 | — | "Would you like us to keep your application details on file …" |
| plan | plan:canon_q_company_figma_where_intend_work_ | 1 | — | "From where do you intend to work?" |
| plan | plan:canon_q_core_how_heard | 1 | — | "What brought you to this job posting" |
| plan | plan:canon_q_screening_devrel_techwriter_work | 1 | — | "Have you worked as a full-time software engineer in a profe…" |
| plan | plan:canon_q_screening_product_manager_experi | 1 | — | "Do you have experience in cybersecurity SaaS?" |
| plan | plan:no_company_answer_saved_for_1password | 1 | — | "Why 1Password?" |
| plan | plan:no_company_answer_saved_for_elevenlabs | 1 | — | "Why ElevenLabs, and why now?" |
| plan | plan:no_company_answer_saved_for_figma | 1 | — | "Why do you want to join Figma?" |
| plan | plan:no_pipeline_history_to_answer_from | 1 | — | "Have you ever worked for Figma before, as an employee or a …" |
| plan | plan:no_saved_question_asks_for_the_same_info | 1 | — | "As a PM which AI tool are you using on daily or weekly basi…" |
| plan | plan:p_how_heard | 1 | — | "How did you hear about ElevenLabs?" |
| plan | plan:p_in_office | 1 | — | "Please select the office(s) you are closest to and/or would…" |
| plan | plan:p_relocation | 1 | — | "Are you willing to relocate? And if you are looking to relo…" |
| plan | plan:what_is_your_earliest_possible_desired_s | 1 | — | "What is your earliest possible/desired start date?" |

`dom` = the adapter drove a control and the form would not take it. `vocabulary` = the widget's
own live list had no entry to commit. `plan` = memory had no answer, so the user is asked —
often by design (`company_specific` questions are the user's, PLAN §2.1).

## Asks by reason

| reason | count | should_be_answerable? | canon kind(s) | classes | examples (form labels) |
| --- | ---: | --- | --- | --- | --- |
| plan:no_product_manager_senior_eu_remote_row_ | 2 | yes 2/2 | rule | circumstance | "What is the beginning of your desired annual base salary ra…" · "What is the end of your desired annual base salary range? (…" |
| plan:no_product_manager_senior_uk_london_row_ | 2 | yes 2/2 | rule | circumstance | "What is your annual salary expectation?" · "Would you like to provide any additional context or details…" |
| plan:attestation | 1 | — | — | policy_gate | "Would you like us to keep your application details on file …" |
| plan:canon_q_company_figma_where_intend_work_ | 1 | yes 1/1 | constant | company_specific | "From where do you intend to work?" |
| plan:canon_q_core_how_heard | 1 | yes 1/1 | constant | company_specific | "What brought you to this job posting" |
| plan:canon_q_screening_devrel_techwriter_work | 1 | yes 1/1 | constant | company_specific | "Have you worked as a full-time software engineer in a profe…" |
| plan:canon_q_screening_product_manager_experi | 1 | yes 1/1 | constant | company_specific | "Do you have experience in cybersecurity SaaS?" |
| plan:no_company_answer_saved_for_1password | 1 | — | — | why_us | "Why 1Password?" |
| plan:no_company_answer_saved_for_elevenlabs | 1 | no 0/1 | company | why_us | "Why ElevenLabs, and why now?" |
| plan:no_company_answer_saved_for_figma | 1 | no 0/1 | company | why_us | "Why do you want to join Figma?" |
| plan:no_pipeline_history_to_answer_from | 1 | yes 1/1 | rule | circumstance | "Have you ever worked for Figma before, as an employee or a …" |
| plan:no_saved_question_asks_for_the_same_info | 1 | yes 1/1 | constant | essay | "As a PM which AI tool are you using on daily or weekly basi…" |
| plan:p_how_heard | 1 | — | — | circumstance | "How did you hear about ElevenLabs?" |
| plan:p_in_office | 1 | yes 1/1 | rule | circumstance | "Please select the office(s) you are closest to and/or would…" |
| plan:p_relocation | 1 | — | — | circumstance | "Are you willing to relocate? And if you are looking to relo…" |
| plan:what_is_your_earliest_possible_desired_s | 1 | — | — | circumstance | "What is your earliest possible/desired start date?" |

11 of 18 ask(s) match a canonical question whose `kind_default` is one `scripts/answers.mjs` writes an answer for (`constant` · `rule` · `policy` · `narrative`) — those are gaps in the runner, not questions that are the user's to answer. `—` means the row matched no canonical question at all: unknown, not no. `company` and `never` rows are the user's by design (PLAN §2.1); attestations and demographics are never auto-answered (AGENTS.md).

## Exercised controls

| control | attempts | ok | fail | ok % | median ms | value picked by | fell back because | failure reasons |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| text | 6 | 6 | 0 | 100% | 732 | fixed_text×5, fixed_date_as_planned×1 | — | — |
| textarea | 5 | 5 | 0 | 100% | 782 | fixed_text×5 | — | — |
| react_select | 5 | 5 | 0 | 100% | 2582 | jev_generic×3, first_two×2 | — | — |
| radio | 3 | 3 | 0 | 100% | 2019 | jev_generic×3 | — | — |
| checkbox | 2 | 2 | 0 | 100% | 713 | boolean×2 | — | — |
| combobox | 1 | 1 | 0 | 100% | 6273 | jev_generic×1 | — | — |
| location | 1 | 1 | 0 | 100% | 610 | fixed_text×1 | — | — |

| declined | rows |
| --- | ---: |
| file_upload_is_the_runners_own | 2 |

These rows were *not* driven, so they are not attempts and not failures. A `file` or `tel` row has
no honest bench value; `no_options_rendered` and `none_of_these` are the widget or the selector
declining, which is the same caution the fill loop applies.

## Coverage against the list

| expected control | postings listing it | measured as | filled attempts | ok % | exercised | exercised ok % | total attempts |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| eeo | 4 | (never driven, by design) | 0 | — | 0 | — | 0 |
| hear_about | 2 | (a question, not a widget) | 0 | — | 0 | — | 0 |
| long_option_list | 1 | (a question, not a widget) | 0 | — | 0 | — | 0 |
| date | 1 | date · really text×1 | 0 | — | 1 | 100% | 1 |
| tel | 4 | tel | 4 | 100% | 0 | — | 4 |
| tel_country | 2 | tel | 4 | 100% | 0 | — | 4 |
| file | 5 | file | 5 | 100% | 0 | — | 5 |
| multi_select | 4 | checkbox · really react_select×2 | 2 | 100% | 4 | 100% | 6 |
| checkbox_single | 2 | checkbox · really react_select×2 | 2 | 100% | 4 | 100% | 6 |
| checkbox_group | 1 | checkbox · really react_select×2 | 2 | 100% | 4 | 100% | 6 |
| location | 5 | location | 6 | 100% | 1 | 100% | 7 |
| radio | 3 | radio · really combobox×1 | 4 | 100% | 4 | 100% | 8 |
| react_select | 2 | react_select | 3 | 100% | 5 | 100% | 8 |
| yesno_buttons | 2 | radio · really combobox×1 | 4 | 100% | 4 | 100% | 8 |
| textarea | 3 | textarea | 7 | 100% | 5 | 100% | 12 |
| essay | 1 | textarea | 7 | 100% | 5 | 100% | 12 |
| text | 5 | text | 30 | 100% | 6 | 100% | 36 |

`filled attempts 0` means the fill loop never drove that control — the row resolved to `ask` or
`skip` before the adapter ran, so it is untested, not passing. `exercised` is `--exercise-controls`
closing exactly that hole with a bench-chosen value, which proves the widget, not the answer.
`total attempts 0` is therefore the only genuinely unmeasured row. The one exception is `eeo`,
where 0 everywhere is the pass: neither the runner nor the bench may touch a demographic control
without an explicit preference. `hear_about` and `long_option_list` name a *question*, not a widget,
so they have no bucket and are always co-listed with the control they render as.

## How to read this

`filled` counts `fill` + `check` Decisions; `asks` are the rows handed back to the user; `failed`
counts DOM writes whose read-back did not match. `median ms` per control is the gap between one
write and the previous browser event — the adapter's 150–400 ms cadence plus the set plus the
read-back, i.e. what a user waits through. Costs use `PRICING` in `src/config.mjs`.

`exercised` is the bench driving a row the runner left open, with a value the **bench** chose, so a
widget that was never reached is measured instead of silently scoring zero. It is never a `filled`,
it never touches a `sensitive` or `policy_gate` row, and its Jev spend is reported separately (7 request(s), $0.000133, 40.3s) so the `$ / posting` above stays what a user would actually pay.

