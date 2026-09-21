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

## Scope

`global` · `company:<slug>` · `role_family:<family>`. Resolution is **company > role_family >
global**, everywhere. `company:` keys are `slugify()`d (`"Acme Inc." → acme-inc`).

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
`preferred_name`, `email`, `phone`, `city`, `location`, `timezone`, `github_url`, `linkedin_url`,
`site_url`, `x_twitter_url`, `publications_url` — the ids
`private/profile/memory-seed/facts.yaml` seeds and `src/plan/resolve.mjs` looks up by name.
Two more pairs are asked for by name on real forms and have their own ids: the role with no end
date is `f.employment.current` (the employer) plus `f.employment.current_title` (the title), and
the most recent degree is `f.education.school`, `f.education.field` and `f.education.degree` —
each a single-valued row, so a second claim is dropped rather than suffixed.
`extractResume()` is told to mint exactly those, and `FACT_ID_ALIASES` in
`src/writer/openai.mjs` folds the plausible near-misses into them (`f.name`, `f.email`,
`f.contact.email`, `f.link.github`, `f.links.github`, `f.identity.name`, `f.employer.current`,
`f.title.current`, `f.education.university`, `f.education.major`, …) before a proposal reaches
`mergeSection`. A row filed under any other prefix is invisible to the form-filling pass: the
field is asked as "no fact on file" even though the CV stated it. Add the alias, do not add a
second namespace. (`f.contact.*`/`f.links.*` in `scripts/jev-smoke.mjs` are a synthetic selector
pool for the smoke test, not store ids.)

`f.identity.preferred_name` is written only when a document *states* a preferred name ("goes by",
"known as"); a first name split out of `f.identity.full_name` is not one, and the résumé pass
never invents it — a form that asks for a preferred name with no fact on file is an `ask`.

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

## `preferences.yaml` — how the user wants applications answered

`overrides[]` carry the scoped values; `value` is the global one. A preference that exists only at
one scope has `value: null`.

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
  overrides:
    - {scope: "company:acme-inc", value: {prefer_posting_range: midpoint, state_end: high}}
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
→ `{id, value, scope: "company:acme-inc", source, overridden: true}`, or `undefined` when nothing
applies — again, the caller asks.

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

Row identity is `qid + scope + family`, so the same canonical question can hold a global answer and
a company-specific one side by side.

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
  scope: "company:acme-inc"
  rule: "Never say I am open to relocation for this company."
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

## API

```js
import { loadMemory, saveSection, mergeSection, upsertRow, loadBaselines } from "../src/memory/store.mjs";
import { getFact, resolvePreference, answersFor, usableStories, documentFor,
         applicableCorrections } from "../src/memory/resolve.mjs";
import { yearsSince, workAuth, noticeRule, salaryFor, appliedBefore, staleFacts } from "../src/memory/derive.mjs";

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
  `ready_to_submit`, or `blocked` with a `reason` for a usage error. `gaps[]` is the six day-1
  questionnaire items minus those already answered, plus anything knowably absent
  (`g.identity.city`). A gap is never filled with a default.
- `scripts/remember.mjs "<instruction>" [--scope …]` — one Jev request (a `choice` for the row kind,
  and a `choice` over concrete scopes unless `--scope` says) writes the row with `source: user` and
  prints `{status, kind, id, scope}`: `ready_to_submit` when written, `needs_user` when the scope of
  a preference or correction is below `GATES.askBelow`. Ids minted from the instruction are
  `f.user.<slug>` / `p.user.<slug>`; promoted drafts become `b.kept.<slug>` stories or `answers`
  rows (company-specific ones forced to `company:<slug>`, deduped against an existing answer for the
  same question with one Noul); corrections take the next `c<N>` handle.
