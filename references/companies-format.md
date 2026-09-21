# Companies format

The tracked-boards list `scripts/scan.mjs` reads. One YAML file at
`~/.config/jev-apply/companies.yml` (`$JEV_APPLY_HOME/companies.yml` when set) — the user's own
file, never written by any script. On the first scan, if it does not exist, the repo's
`private/companies-seed.yml` is copied there once; after that the copy is the only thing scan reads,
so edits are never overwritten. `scan.mjs --companies F` reads `F` instead and copies nothing.

All examples below are synthetic.

## Shape

Two lists, both optional but at least one required. They are read identically — `boards:` exists so a
feed can be tracked without pretending to be a company (PLAN §2.5).

```yaml
checked: 2026-01-31          # free-form provenance; ignored by scan
companies:
  - name: Acme               # required: the company name stored on every posting
    provider: greenhouse     # which src/discover/providers/<id>.mjs fetches this board
    token: acme              # the provider's identifier (see the table below)
    careers_url: https://job-boards.greenhouse.io/acme
    keywords: ["machine learning", "inference"]
    enabled: true
boards:
  - name: HN Who's Hiring
    provider: hn
```

Unknown keys are ignored, so provenance notes (`jobs_at_check`, `legacy_greenhouse_token`, comments)
can live next to an entry.

## Fields

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Stored as `company` on every posting from this board, and is what `slugify(name)` in the pipeline id and in `applications/<slug>` comes from. |
| `provider` | yes | A provider module id. `unknown` (or missing) → the entry is **skipped** with a note on stderr. |
| identifier | yes | The one key the provider needs — see below. |
| `careers_url` | no | The human careers page. Used by `resolveCompany()` when re-probing, never fetched by scan. |
| `keywords` | no | Extra title keywords for **this board only** (see *Filters*). |
| `enabled` | no | `false` skips the entry entirely. Anything else (including absent) is enabled. |

### Identifier per provider

| `provider` | identifier key | Endpoint |
|---|---|---|
| `greenhouse` | `token` | `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` |
| `ashby` | `org` | `api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true` |
| `lever` | `site` | `api.lever.co/v0/postings/{site}?mode=json` |
| `workable` | `sub` | `apply.workable.com/api/v3/accounts/{sub}/jobs` |
| `smartrecruiters` | `co` | `api.smartrecruiters.com/v1/companies/{co}/postings` |
| `workday` | `tenant`, `n`, `site` | `{tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` |
| `hn` | — | the current *Ask HN: Who is hiring?* thread |

Every provider is public and unauthenticated, checks its host against an allowlist, and refuses
redirects. An entry whose identifier is missing fails that one board and never the scan.

`provider: unknown` means no public board answered for any slug candidate when the entry was written.
Re-resolve one with:

```
node scripts/providers-smoke.mjs --resolve "Acme"     # → {"provider":"ashby","org":"acme"}
```

and paste the result into the entry.

## How `scan.mjs` reads it

1. Every entry with `enabled !== false` is matched to a provider module; unresolved entries are
   skipped and named on stderr.
2. Boards are fetched **4 at a time, at most 3 of them Ashby** (PLAN §2.5: the Ashby endpoint
   throttles above ~6 concurrent requests). A board that fails is retried once, then reported and
   skipped — one dead board never fails a scan.
3. Each board's postings go through the filter chain, and at most `--per-board N` (default 100) of
   the survivors are taken from any one board. The cap is applied **after** filtering: a board
   answers in a single HTTP call regardless, so capping the raw response would only throw away
   matching roles further down a large board.
4. Survivors are deduped by normalized URL and `company::role`, within the run and against
   `pipeline/scan-history.tsv`, so a second scan of unchanged boards adds nothing.

## Filters

The chain itself is model-free and lives in `src/discover/filters.mjs`
(blacklist → title keywords → seniority → location → age → salary floor → content). `scan.mjs`
derives its rules from the **structured** parts of the user's `p.looking_for` preference:

| Memory | Rule |
|---|---|
| `role_families` (of the `target_roles`) | `title_keywords.include` — the phrases the user calls their target roles |
| `acceptable_locations: {rule: any_country_except, except: [IN]}` | `location.any_country_except: [IN]` — a job located in an excluded country is rejected; a remote job always passes |
| `dealbreakers` | `content_keywords.exclude` as literal `stem:` matches |

A free-text dealbreaker means more than its own words ("no sponsorship" is rarely written that way),
so the filter only takes the literal reading and the real judgment happens in the Jev `noul` of the
fit pass. Nothing about the user is inferred here.

An entry's `keywords` are OR'd into `title_keywords.include` **for that board only**: a tracked
company is tracked deliberately, and `"machine learning"` catches
`Software Engineer, Machine Learning Platform`, which no role-family phrase matches. Location, age
and content rules stay global. Keyword syntax is the filter module's: `word:x` whole-word,
`stem:x` substring, bare text substring, `a+b` inside one entry = AND, separate entries = OR.

`scan.mjs --filters rules.yml` merges a file over the derived rules by top-level key, which is how a
blacklist, a seniority exclusion, an age limit or a salary floor is added:

```yaml
blacklist: ["staffing agency"]
seniority: {exclude: ["word:intern", "word:principal"]}
age_days: 45
salary_floor: 90000
```

Standing corrections the user states in words ("never contract roles") become preference rows
through `remember.mjs`, not by hand-editing this file.

## What scan never does

No credentials are read or sent, no entry is rewritten, and nothing user-specific is written under
the repo: postings land in `~/.config/jev-apply/pipeline/` only.
