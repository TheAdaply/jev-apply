# Memory format

The private store the runner reads before it touches a form. One YAML file per section under
`~/.config/jev-apply/memory/` (`$JEV_APPLY_HOME/memory/` when set), mode `0600`, written
tmp + `fsync` + `rename` so a crash leaves either the old file or the new one — never half of both.
Nothing here is ever copied into the repo, and no model ever writes a row without a `source` that
says where it came from (PLAN §2.4).

```
~/.config/jev-apply/memory/
  facts.yaml  preferences.yaml  documents.yaml  answers.yaml  stories.yaml  drafts.yaml
  corrections.yaml
  salary-baselines.yaml      # side table, not a section: installed verbatim by learn.mjs --seed
```

A missing file is an empty section. Every file is a YAML **list of mappings**; the two header
comment lines are regenerated on each write.

All examples below are synthetic.

## `facts.yaml` — what is true of the user

Never model-written. `since:` (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`) is stored instead of "N years", so
"years of X" is computed at fill time and never goes stale.

```yaml
- id: f.identity.full_name
  value: Jane Example
  source: resume:cv.pdf#p1      # resume:<doc>#p<n> | user | link:<url> | pipeline
  updated: 2026-01-31
- id: f.identity.city           # absent → learn.mjs reports the g.identity.city gap
  value: Lisbon, Portugal
  source: user
  updated: 2026-01-31
- id: f.skill.rust
  value: Rust
  since: "2021-06"              # yearsSince(mem, "f.skill.rust") → 4.6
  source: resume:cv.pdf#p2
  updated: 2026-01-31
- id: f.employment.acme
  value: {role: Staff Engineer, employment_type: full_time, until: "2025-12"}
  since: "2023-02"              # only employment_type:full_time counts toward salary level
  source: resume:cv.pdf#p1
  updated: 2026-01-31
```

**One id namespace.** Every identity fact the resolver reads is `f.identity.*` — `full_name`,
`first_name`, `last_name`, `preferred_name`, `full_name_native`, `email`, `phone`, `city`,
`location`, `address`, `pronouns`, `timezone`, `start_date`, `github_url`, `linkedin_url`,
`site_url`, `x_twitter_url`, `portfolio_url`, `scholar_url`, `publications_url` — the ids
`private/profile/memory-seed/facts.yaml` seeds and `src/plan/resolve.mjs` looks up by name.
Two more pairs are asked for by name on real forms and have their own ids: the role with no end
date is `f.employment.current` (the employer) plus `f.employment.current_title` (the title), and
the most recent degree is `f.education.school`, `f.education.field` and `f.education.degree` —
each a single-valued row, so a second claim is dropped rather than suffixed.

**The whole history.** A form's repeating Education / Employment section needs every degree and
every role, not the latest one, so each also has a row of its own — `f.education.<slug>` and
`f.employment.<slug>`, start date in `since:`:

```yaml
- id: f.education.bachelor_of_technology_iit_patna
  value: {school: IIT Patna, degree: Bachelor of Technology, field: Electrical Engineering, until: "2020-05"}
  since: "2016-08"                # "YYYY" when the CV prints only the year — never completed
- id: f.employment.staff_engineer_acme
  value: {company: Acme, role: Staff Engineer, employment_type: full_time, current: true}
  since: "2024-07"
- id: f.education.bachelor_of_technology_iit_patna.start   # added later by the user's answer
  value: "2016-08"
  source: user
```

`educationHistory()` / `employmentHistory()` (`src/memory/derive.mjs`) read them newest first; a
prose row ("B.Tech, EEE — IIT Patna (2016 – 2020)") is read the way `latestEducation()` reads it,
and its parts are filled as `check`. School-leaving certificates are not entries. A part a form
requires and the row does not state is asked once and kept beside the entry as
`<entry id>.<part>` (`school`, `degree`, `field`, `employer`, `title`, `start`, `end`), never
written over the résumé's own row. `extractResume()` writes these rows from its `history` list and
`extractBasic()` from the lines under an Education heading. Citizenship is
`f.citizenship`, and three rules read it: "what is your nationality?", the jurisdiction a remote
posting that names no country at all is answered for, and the export-control / "U.S. person"
status rows, which are the one class of question that is *about* citizenship
(`exportControlRow()` in `src/plan/resolve.mjs`, answered together with `f.work_auth.US` and
always as a `check`). Write it however a passport reads it — the ISO-3166 alpha-2 code (`IE`),
the nationality adjective (`Irish`, `Irish citizen`) or the country's own name (`Ireland`):
`countryOfNationality()` in `src/schema/normalize.mjs` reads all three. It is deliberately not the
*place* table, because `\bindia\b` does not match "Indian" and an adjective loose in the place
table would read the EEO option "American Indian or Alaska Native" as a country.
`extractResume()` is told to mint exactly those, and `FACT_ID_ALIASES` in
`src/writer/openai.mjs` folds the plausible near-misses into them (`f.name`, `f.email`,
`f.contact.email`, `f.link.github`, `f.links.github`, `f.identity.name`, `f.employer.current`,
`f.title.current`, `f.education.university`, `f.education.major`, …) before a proposal reaches
`mergeSection`. A row filed under any other prefix is invisible to the form-filling pass: the
field is asked as "no fact on file" even though the CV stated it. Add the alias, do not add a
second namespace. (`f.contact.*`/`f.links.*` in `scripts/jev-smoke.mjs` are a synthetic selector
pool for the smoke test, not store ids.)

The link facts — `github_url`, `linkedin_url`, `site_url`, `x_twitter_url`, `portfolio_url`,
`scholar_url`, `publications_url` — answer the named rows one at a time *and* the single box some
boards ask them all into ("Social Network and Web Links"), which takes every one on file, one per
line. A links row is skipped as "no link facts on file" only when that is true.

`f.identity.preferred_name` is written only when a document *states* a preferred name ("goes by",
"known as"); a first name split out of `f.identity.full_name` is not one, and the résumé pass
never invents it — a form that asks for a preferred name with no fact on file is an `ask`.

**First and last name.** A Greenhouse form asks for the two halves separately, and splitting the
stated full name at the first space is only right while the tokens are `<given> <family>`. When
one of two tokens is a single letter it is an **initial**, and the initial is the family name
whichever side it is written on — `R Sanchez` and `Sanchez R` both mean first name `Sanchez`, last
name `R` (`nameSplit()` in `src/plan/resolve.mjs`). Explicit facts always win over the split:

```yaml
- id: f.identity.first_name     # stated, never derived — overrides any split
  value: Sanchez
  source: user
  updated: 2026-01-31
- id: f.identity.last_name
  value: R
  source: user
  updated: 2026-01-31
```

`scripts/learn.mjs` reports the `g.identity.name_split` gap whenever the stated name has that
shape and the two explicit rows are absent: it says which reading it will use and asks the user to
confirm it or send the pair the other way round. `f.identity.full_name_native` is a separate fact
for the "Full Legal Name in Native Language" field some boards ask for; nothing derives it from the
Latin-script name.

**Where the user is.** `f.identity.location` may hold a work mode rather than a place — a CV that
says "Remote" says nothing about where its author lives. `locationFact()` (`src/memory/derive.mjs`)
rejects `Remote`/`Hybrid`/`Anywhere`/`Distributed`/`On-site`… and falls back to `f.identity.city`;
with neither on file the row is an `ask` carrying `remember_as: f.identity.city`. It is never typed
into a board's location autocomplete, which is how one run committed a US city the candidate had no
connection to on a form that declared no US work authorization
(`docs/research/12-eval-judge-round1.md` §3.2).

**When the user can start.** `f.identity.start_date` (`YYYY-MM-DD`) is what a **date** control
receives; with no such fact the date is computed as today plus `p.notice_rule`. A date control
never receives the notice rule's prose ("Available immediately") — the picker rejects it, stays
open over the next field and commits nothing.

Work authorization is **two-valued per target country** — `f.work_auth.<CC>`, with
`f.work_auth.default` covering every country without its own row:

```yaml
- id: f.work_auth.PT
  value: {authorized_now: true, needs_sponsorship_future: false, status: citizen}
  source: user
  updated: 2026-01-31
- id: f.work_auth.US
  value: {authorized_now: true, needs_sponsorship_future: true, status: H-1B, expiry: "2027-09"}
  source: user
  updated: 2026-01-31
- id: f.work_auth.default
  value: {authorized_now: false, needs_sponsorship_future: true, status: "needs sponsorship"}
  source: user
  updated: 2026-01-31
```

`workAuth(mem, "US")` → `{authorized_now: true, needs_sponsorship_future: true, status: "H-1B",
expiry: "2027-09", country: "US", exact: true, fact: "f.work_auth.US", source: "user"}`;
`workAuth(mem, "DE")` returns the same shape from `f.work_auth.default` with `exact: false`, and a
row answered that way is filled but flagged `check` — the two most legally consequential questions
on a form are never answered silently for a country the user never named. No fact and no default →
`null`, and the caller **asks** (PLAN §2.4: a personal fact is never guessed).

**Which country a row is answered for** is decided in one fixed order: the question's own wording
("authorized to work in the United States") first, because a form may ask about a country the
posting is not in; then the posting, whose `job.country` (ISO-3166 alpha-2) and `job.remote` are
read off the raw ATS schema by `src/schema/normalize.mjs` — Greenhouse's `location.name` plus
`offices[]`, Ashby's `locationName`/`workplaceType`/`isRemote`; then, only for a remote posting
that names no country at all, `f.citizenship`. A posting naming several countries answers for the
one it names **first**, and a region ("EMEA", "APAC") is not a country. Nothing recognised → the
row is an `ask`, and a jurisdiction taken from citizenship rather than from the posting is filled
as `check`, never silently.

## `preferences.yaml` — how the user wants applications answered

One row per preference, and it holds for every application: the user says how they want
applications answered and is never asked where the answer applies.

```yaml
- id: p.notice_rule
  value: {kind: immediate, text: Available immediately}   # kind: immediate|days|weeks|months
  source: user
  updated: 2026-01-31
- id: p.salary
  value:
    mode: market_average
    prefer_posting_range: midpoint    # `none` to ignore a published range
    state_end: mid                    # which end of the baseline row to state: low|mid|high
    baselines: salary-baselines.yaml
  source: user
  updated: 2026-01-31
- id: p.looking_for
  value:
    target_roles: [ml_engineer]
    role_families:                    # title phrases → family; drives salaryFor and remember.mjs
      ml_engineer: ["machine learning engineer", "inference engineer"]
    must_haves: ["remote"]
    dealbreakers: ["on-call rotation"]
    acceptable_locations: {rule: any_country_except, except: [XX]}
  source: user
  updated: 2026-01-31
- id: p.resume_by_role_family
  value: {default: doc.resume.main, ml_engineer: doc.resume.ml}
  source: user
  updated: 2026-01-31
```

`resolvePreference(mem, "p.salary", {company: "Acme Inc.", role_family: "ml_engineer"})`
→ `{id, value, scope: "global", source, overridden: false}`, or `undefined` when nothing is on
file — and then the caller asks. (`overrides[]` on a row are still read, most specific first, so a
store written by an older version keeps resolving; nothing writes one any more.)

### The preferences other code reads as a *shape*

`validateRow("preferences", row)` (`src/memory/schema.mjs`) checks these where they are written
rather than where they are used, so a typo cannot surface half an hour later as an unanswerable
form row. Every one of them is user-stated; none is ever defaulted by code.

```yaml
- id: p.eeo                      # asked once at onboarding (learn.mjs gap g.eeo), used on every form
  value:
    gender: female               # male | female | non_binary | decline
    hispanic_latino: "yes"       # yes | no | decline
    race: two_or_more            # american_indian | asian | black | hispanic_latino |
                                 # native_hawaiian | white | two_or_more | decline
    veteran_status: veteran      # not_veteran | veteran | decline
    disability_status: decline   # yes | no | decline
    pronouns: they/them          # optional, free text — the user's own phrase, never derived
    other_demographics: decline  # decline | ask — the stance for survey questions the five
                                 # fields above do not answer (sexual orientation, transgender
                                 # status, age band). Absent means `ask`.
  source: user
  updated: 2026-01-31
- id: p.auto_submit              # asked once (gap g.auto_submit); absent is not "no", it is unanswered
  value: true                    # true | false
  source: user
  updated: 2026-01-31
- id: p.auto_draft               # asked once (gap g.auto_draft); absent is not "no", it is unanswered
  value: true                    # true | false — may the writer draft "why us" / essay answers?
  source: user
  updated: 2026-09-23
- id: p.legal.restrictive_agreements   # "Are you bound by a non-compete / non-solicit?"
  value: "No"                          # "Yes" | "No"
  source: user
  updated: 2026-01-31
- id: p.legal.previously_employed      # "Have you ever been employed here?" — only if the user says so
  value: "No"                          # "Yes" | "No"; with no row, the pipeline answers instead
  source: user
  updated: 2026-01-31
- id: p.accommodation                  # "Do you need an accommodation for the hiring process?"
  value: "No"                          # free text, or a plain Yes/No the form's options can state.
  source: user                         # The ONLY thing an accommodation prompt is answered from —
  updated: 2026-01-31                  # never `p.eeo.disability_status` (judge round 2, N1).
```

**`p.eeo` is what fills a form's demographic block** (PLAN D10): `sensitiveRow()` in
`src/plan/resolve.mjs` reads the field the question asks about, and `canon/vocab/eeo-*.yaml` maps
the canonical value onto that form's own option wording — Greenhouse's official EEOC labels, its
"U.S. Standard Demographic Questions" list, Ashby's and the UK census variants. `decline` is a
stated answer, not a blank: it picks the form's "Decline to self-identify" / "I don't wish to
answer" option. Where several of a form's options state one saved value, the plain wording wins
over a qualified one ("Man" over "Transgender man, male, or masculine" — committing the qualified
label would assert something the user did not say); where none is plainly the answer, a
*single*-select goes to Jev with `none_of_these` and the gate decides, and a *multi*-select must
not — request 3 scores each option on its own with no `none_of_these`, so "Asian" against a list
split into East / South / Southeast could select three ancestries the user never claimed.

`other_demographics: decline` is what answers those rows. It is the user's standing stance for a
demographic question their saved block cannot answer **exactly**, and it covers three cases: a
question outside the five fields (sexual orientation, transgender status, age band), a form that
asks finer than they stated, and a list with no entry for what they stated. In each the form's own
"Decline to self-identify" / "I don't wish to answer" option is picked, and only where the user has
stated that stance — absent, every one of them is still an `ask`. A field with nothing on file is
an `ask` carrying `remember_as: {kind: preference, id: "p.eeo.<field>"}` — never a
guess, and never a skip. Ethnicity outranks race on a form that folds both into one select: with
`hispanic_latino: yes`, a `Hispanic or Latino` option is the answer to the race question.

A `p.eeo.<field>` row on its own is read as well as the whole mapping, and it may hold the form's
own wording ("Male") rather than a token — that is what the host stores when the user answers one
demographic row (`src/plan/decisions.mjs memoryRow()`), so the same vocabulary translates it back.
`scripts/learn.mjs --answers answers.json` (`{"<memory id>": <value>}`, the ids the gaps name)
writes these canonically: wording no vocabulary states is rejected and reported, never stored.

Redaction is unchanged by any of this: a `class: sensitive` row is never photographed, its trace
row carries neither its text nor its length, and the summary prints `••••`
(`src/browser/trace.mjs`, `src/plan/summary.mjs`).

**Pronouns are not one of the five.** `p.eeo.pronouns` is free text, and a `f.identity.pronouns`
fact answers a pronouns field on its own — the volunteered phrase is read whether or not the rest
of `p.eeo` was ever stated, which is the one demographic-looking field that is not gated on it.

**`p.auto_submit`** is read by `scripts/apply.mjs` through `resolvePreference(mem,
"p.auto_submit", {company, role_family})`: `true` (or `"yes"`/`"true"`/`"on"`/`"1"`) means click
Submit once nothing is left to ask; anything else, **including an absent row**, stops at
`ready_to_submit`.

**`p.auto_draft`** is the same shape and the same rule (`resolvePreference`, absent means
*unanswered*). `true` lets the writer draft the two classes nobody
can answer from stored facts — `why_us` and required essay prompts — from the posting plus the
user's own saved material; the Decision carries `draft_request: {kind, limits, grounding_ids,
prompt, help}` and the draft is listed under ► DRAFTED before anything is submitted. Facts are
untouched by it: a missing personal fact is still an `ask`, never a draft.

**`p.legal.restrictive_agreements`** answers every "are you bound by a non-compete / non-solicit?"
row from one global statement: a restriction binds the user wherever they apply, and the "If yes,
please explain" row underneath is left blank when the answer is No. **`p.legal.previously_employed`
is different**: "have you ever been employed **by this company**?" is a different question at every
employer, so the row is not answered from a stated stance at all — it falls back to the pipeline
derivation (`appliedBeforeFor`), which answers per company or asks.

**`p.legal.<slug>` — the standing answer to an acknowledgement.** Besides the two stances above,
the `p.legal.*` namespace holds one `"Yes"`/`"No"` row per attestation the user has decided to
stand behind: `p.legal.privacy_policy_ack`, `p.legal.background_check_consent`,
`p.legal.interview_recording_consent`, `p.legal.arbitration_ack`, `p.legal.ai_usage_ack`,
`p.legal.retention_consent`, `p.legal.terms_ack`, `p.legal.application_truthful_ack`,
`p.legal.export_control_ack`, `p.legal.age_redaction_ack`. A form row classed `policy_gate`
("Please review and acknowledge our Candidate Privacy Policy", "I understand that an offer is
conditional on a background check") is
answered from **that row and nothing else** — no canonical answer, no neighbouring preference, no
derivation — and with nothing on file it is an `ask` carrying the id that closes it everywhere
(`policyGateRow()` and `policySlug()` in `src/plan/resolve.mjs`). The slug comes from the gate's
subject, not the company's wording, so one stored answer covers every board that asks it.
`age_redaction_ack` is the newest of them and the reason the list is a class rather than a
vocabulary of demographics: a notice that *offers* to let the candidate redact age-identifying
material from their own documents names a protected characteristic without asking for one, so it
is a gate the user signs, not a demographic row the EEO decline stance may refuse
(`docs/research/17-eval-judge-ten2.md` §3 F6). The
older per-gate ids (`p.privacy_consent`, `p.background_check`, `p.recording_consent`,
`p.arbitration`, `p.ai_usage`, `p.application_truthful`) are **no longer read**: they were
consumed through the canonical answer bank, which is what ticked two legal attestations on the
user's behalf in round 1 (`docs/research/12-eval-judge-round1.md` §3.1). Those seven `q.legal.*`
questions are no longer authored into `answers.yaml` at all (`POLICIES` in
`src/canon/answers.mjs`) — the class decides, not the answer bank.

**`p.legal.standard_acks` — the one blanket stance, and the only one there is.** Three
acknowledgements say the same three things on every board: this application is truthful, interviews
may be recorded, the candidate privacy notice has been read. `learn.mjs` asks once whether the
runner may accept those for the user (`g.legal.standard_acks`), and a `"Yes"` lets the evidence
tier answer a gate whose *own* `p.legal.<slug>` is absent — as a `check`, with a justification on
record, and for those three subjects only (`STANDARD_ACK_SLUGS`, `src/plan/infer.mjs`). It is not a
neighbouring preference standing in for a missing one: it is read only after `policyGateRow()` has
already looked for the gate's own row, it never outranks one, and four things are outside it by
construction — `arbitration_ack` (a right being given up, not a notice being read),
`ai_usage_ack` (a statement about what the candidate did while applying), any gate whose wording
names a specific obligation (a waiver, a fee, a background check, a relocation commitment), and
every other slug. Those keep asking, each under its own id. `preflight` enforces the boundary:
`policy_gate_source` accepts an inferred gate only when its `why` names this id *and*
`inferred_justified` passes.

## `documents.yaml` — the files a form uploads

`path` always points inside `~/.config/jev-apply/documents/`; `learn.mjs` copies the file there and
computes `sha256` itself (a changed digest is what makes `learn.mjs` re-run as a diff).

```yaml
- id: doc.resume.main
  path: /Users/example/.config/jev-apply/documents/cv.pdf
  sha256: 0000000000000000000000000000000000000000000000000000000000000000
  role_families: [ml_engineer]
  updated: 2026-01-31
```

## `answers.yaml` — pre-computed answers, keyed by canonical question (§2.7)

Row identity is `qid + scope + family`. A "why us?" sentence is one answer *per company* — saved
globally it would be handed straight back at the next employer — so an answer to a `why_us`,
`company_specific` or `policy_gate` question is keyed to the posting it was written for. That key
is derived from the question's own class and the company being applied to
(`memoryRow` in `src/plan/decisions.mjs`, `promotionHome` in `src/memory/resolve.mjs`); the user
is never asked about it. Everything else is `global`.

```yaml
- qid: q.policy.arbitration
  kind: policy                 # constant | rule | policy | narrative | company | never
  value: "Yes"
  scope: "company:acme-inc"
  source: user
  reviewed: true
  updated: 2026-01-31
- qid: q.narrative.proudest_project
  kind: narrative
  variants: {short: "…40 words…", medium: "…120 words…", long: "…250 words…"}
  family: ml_engineer
  scope: global
  source: authored:gpt-5.4@2026-01-31   # LLM-authored at onboarding, curated once by the user
  reviewed: true
  updated: 2026-01-31
- qid: q.circumstance.notice_period
  kind: rule
  rule_ref: p.notice_rule      # computed at fill time instead of stored
  scope: global
  source: user
  reviewed: true
  updated: 2026-01-31
```

`kind: never` rows are saved history the resolver never offers.

**`rule_ref` values are a closed set.** They come from `CANON_RULES` in `src/jev/plan.mjs`, which
is also the function that evaluates them at fill time, so a stored ref and an evaluable ref are
the same string by construction — a ref nothing can evaluate turns "no saved answer" into "rule
cannot be evaluated" and still ends in an `ask`, which is worse than having no row. The refs, and
what each reads:

| `rule_ref` | canonical questions | reads |
|---|---|---|
| `work_auth.authorized_now` · `work_auth.sponsorship_now` · `work_auth.sponsorship_future` | `q.auth.*` | `f.work_auth.<CC>` for the posting's country, else `f.work_auth.default` |
| `p.notice_rule` | `q.core.start_date` · `q.core.notice_period` | `p.notice_rule` |
| `p.salary` | `q.comp.expected_salary` | `p.salary` + `memory/salary-baselines.yaml` |
| `p.relocation` · `p.in_office` | `q.core.relocation` · `q.core.in_office` | the matching preference + the posting's country |
| `applied_before` | `q.legal.previously_applied` | `pipeline/pipeline.yaml` |
| `identity.location` | `q.core.location_current` | `f.identity.location`, else `f.identity.city` |
| `identity.address` | `q.core.address_working` | `f.identity.address`, else the location facts above |
| `experience.years_total` | `q.core.years_experience` | the `since:` dates on `employment_type: full_time` facts, floored |

The last three are `rule` rows rather than `constant` ones on purpose: where the user lives and how
long they have worked change without anybody editing memory, and a stored number would state a
stale year count on a real application. `q.core.how_heard` and `q.core.pronouns` are the opposite
case — a standing choice the user makes once — and are written as `constant` rows from
`p.how_heard` and `f.identity.pronouns`, only when that row exists.

**`q.inferred.<topic>` rows — an inference, filed so it is paid for once.** The evidence tier
(`src/plan/infer.mjs`) answers a row nothing on file states but saved evidence justifies, and files
what it concluded here: `qid: q.inferred.how_heard`, `source: inferred`, the questions it answers,
and an `inference` block carrying the evidence ids and the justification score. The next form that
asks the same thing replays it with no model call at all (`storedInference`), and it is still a
`check` on every form it reaches — an inferred answer is never silently filled, on the run that
inferred it or any run after. `source: inferred` is what keeps the row subordinate: `mergeSection`
lets a `source: user` row overwrite one and never the reverse, so a `remember.mjs` correction (or a
`corrections.yaml` rule naming the topic) replaces the inference permanently. Topics whose answer
belongs to one employer (`previously_employed`, `how_heard`, `policy_ack`) are written
`scope: company:<slug>`; the rest are `global`. A dry run writes none of them.

```yaml
- qid: q.inferred.how_heard
  kind: company
  scope: "company:acme-inc"
  value: Company careers page
  source: inferred            # a user-stated row over the same qid always wins
  answers_questions: ["How did you hear about this opportunity?"]
  topics: [how heard]
  inference:
    evidence: [pipeline.acme-123, posting]
    justified: 0.86
    label: How did you hear about this opportunity?
  updated: 2026-09-24
```

## `stories.yaml` — raw material (résumé bullets, accepted drafts, interview answers)

`learn.mjs --seed` imports `blobs.yaml` here wholesale; rows flagged `use: never` stay saved but are
filtered out of every selector pool and writer prompt (`usableStories(mem)`).

```yaml
- id: b.story.cache_rewrite
  kind: story                  # story | answer | fact (as authored in the seed)
  title: Rewrote a cache layer — describe a technical project
  text: "…the story, in the user's own words…"
  tags: [performance, caching]
  source: https://example.com/projects/cache
- id: b.story.excluded_employer
  title: Work the user does not want mentioned
  text: "…"
  source: user
  use: never
```

## `drafts.yaml` — per application, until `remember.mjs` promotes them

```yaml
- id: d1                       # the handle the user says: "keep d1"
  application: acme-inc-123    # applications/<slug>
  company: Acme Inc.           # what a company-scoped promotion is keyed on
  canon: q.company.why_us      # or `qid:`; absent → promoting it makes a story, not an answer
  class: why_us                # FormPlan class; why_us/company_specific force company scope
  family: ml_engineer
  text: "…the draft the writer produced…"
  created: 2026-01-31
```

## `corrections.yaml` — standing "never do that again" rules

```yaml
- id: c1                       # the handle the user says: "drop c1"
  when: 2026-01-31T09:15:00.000Z
  scope: global                # a correction the user states holds for every application
  rule: "Never say I am open to relocation."
  source: user
```

## `salary-baselines.yaml` — the market table (side file, not a section)

Installed verbatim (its comments carry the user's authoritative answering rule).

```yaml
rule: {state: mid, when_posting_publishes_range: midpoint_of_posting_range, when_market_unknown: ask,
       never: personal_number, basis: annual_base}
markets:                       # optional: the table's own location aliases, matched before the
  us_nyc: ["new york", "nyc"]  # built-in defaults, so a new market row is reachable immediately
rows:
  - {role_family: ml_engineer, level: entry, market: us_nyc, currency: USD,
     low: 120000, mid: 145000, high: 170000, basis: annual_base, checked: 2026-01-31}
```

`level` ∈ `entry | early | senior` comes from `p.salary.level` if the user stated one, otherwise
from full-time years on file — and only a fact that *says* `employment_type: full_time` counts, so
internships and open-source rows never inflate it. The boundaries are `< 1 yr` entry, `< 3 yr`
early, the rest senior (`LEVEL_YEARS` in `src/jev/gates.mjs`, the one file thresholds live in); a
table may state its own with `rule: {levels: {early: 1, senior: 3}}`, the same way its `markets:`
block owns the market vocabulary. `market` is derived from the posting location by
`marketFor(job, baselines)`; a location that matches no market in the table returns
`action: "ask"` (the table's own `when_market_unknown: ask`), never a neighbouring market.

`role_family` is the third key. It is the user's own vocabulary first (`p.looking_for.role_families`)
and, when the posting's title matches
nothing there, the canon taxonomy's name for it (`classifyTitle` in `src/canon/families.mjs`, the
same deterministic classifier that picks the screening layer) — so a designer or PM posting is
priced from the table instead of asking about a role family the user never listed. A title that
names no family at all, and a `{role_family, level, market}` triple with no row in the table, both
return `action: "ask"`: an absent row is never interpolated from a neighbouring one.

## API

```js
import { loadMemory, saveSection, mergeSection, upsertRow, loadBaselines } from "../src/memory/store.mjs";
import { getFact, resolvePreference, answersFor, usableStories, documentFor,
         applicableCorrections } from "../src/memory/resolve.mjs";
import { yearsSince, fullTimeYears, workAuth, noticeRule, salaryFor, tableFamily, appliedBefore,
         staleFacts } from "../src/memory/derive.mjs";

const mem = await loadMemory();        // {facts, preferences, documents, answers, stories, drafts, corrections}
getFact(mem, "f.identity.email");      // → the whole row ({id, value, source, …}), or undefined
resolvePreference(mem, "p.salary", { company, role_family });
await mergeSection("facts", proposals);// → {added, updated, kept_user, rejected[], rows}
await upsertRow("corrections", row);   // one row, same rules
```

`saveSection` validates every row and refuses the whole write if any row is malformed, so a section
file is always either the previous good state or the new one. `mergeSection` never lets a proposal
overwrite a row whose `source` is `user` (pass `{overwriteUser: true}` to mean it).

`staleFacts(mem)` lists time-based facts older than 90 days; they are re-confirmed inside the next
`needs_user` batch, never as a separate prompt.

## Who writes what

- `scripts/learn.mjs --seed DIR` — imports `facts.yaml`, `preferences*.yaml`, `documents.yaml`
  (copying each file into `documents/`), `blobs.yaml` → `stories.yaml`, `salary-baselines.yaml`.
- `scripts/learn.mjs --resume cv.pdf [--links …]` — `pdf-parse` → `extractResume({text, pages, doc})`
  proposals, merged without overwriting anything the user stated; each résumé is also installed into
  `documents/` and registered as `doc.resume.<file>` with its `sha256`, which is what makes the next
  run a diff.
- Both print `{status, facts, preferences, documents, stories, answers, echo[], gaps[]}`. `status` is
  one of the three every script is bound to — `needs_user` while `gaps[]` is non-empty, otherwise
  `ready_to_submit`, or `blocked` with a `reason` for a usage error. `gaps[]` is the day-1
  questions minus those already answered — the six standing ones, the demographic block and
  auto-submit, plus drafting — each in the words a person would use, each carrying the id its
  answer is stored under. Nothing else is asked on day 1, and a gap is never filled with a default.
- `scripts/remember.mjs "<instruction>" [--id <memory id>] [--dry-run]` — **one** Jev
  request carrying two choices: the row kind and the memory **id** it belongs to. It writes the
  row with `source: user` and prints `{status, kind, id}` — `ready_to_submit` when written,
  `needs_user` when the id is below `GATES.askBelow`. Everything remembered this way holds for
  every application. `--dry-run` runs the same selection and reports
  the row it would write without touching disk; `--id` answers the `needs_user` and skips the id
  choice entirely.
- The id choice runs over `ID_CATALOGUE` (`src/memory/schema.mjs`) plus every id already in
  `facts.yaml`/`preferences.yaml`, with an explicit `none_of_these`. The catalogue is the set of
  ids the resolver actually reads, each with the one line that distinguishes it; `shape: yes_no`
  ids (`p.legal.*`, `p.relocation`, the switches) store a plain Yes/No and refuse anything else,
  and `shape: text` ids store the user's own words with the stating lead-in removed
  ("I currently live in Lisbon, Portugal" → `f.identity.city: Lisbon, Portugal`). Without it the
  script minted `f.user.i_currently_live_in_<city>` — a valid row no form rule ever reads.
  Structured ids (`p.eeo` as a block, `p.salary`, `p.notice_rule`, `p.looking_for`,
  `f.work_auth.<CC>`) are deliberately out of the catalogue: a spoken sentence cannot build one.
- Only when the choice answers `none_of_these` **above** the gate is an id minted from the
  instruction — `f.user.<slug>` / `p.user.<slug>`. Below the gate the script asks instead, naming
  the id it would mint (`new:f.user.<slug>`). Promoted drafts become `b.kept.<slug>` stories or
  `answers` rows (company-specific ones forced to `company:<slug>`, deduped against an existing
  answer for the same question with one Noul); corrections take the next `c<N>` handle.
