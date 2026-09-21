# The canonical question bank

`canon/` (docs/PLAN.md §2.7) is the public question bank: every application form asks a small,
recurring set of questions once you strip company-specific wording, and pre-answering each
canonical question once — instead of judging it fresh on every posting — is what keeps an
application to ≤3 `ask` rows after the first one. Everything under `canon/` is question *text*
published by employers; nothing there is personal data. The user's *answers* to those questions
live outside the repo, in `~/.config/jev-apply/memory/answers.yaml` (row shape:
`references/memory-format.md`).

`canon/README.md` documents the generated files themselves (file-by-file, with a sample row) and
is regenerated alongside them — read it for the current bank. This file documents the four scripts
that build, evaluate, and pre-answer it.

## Layers

Every canonical id's prefix names its layer, in bank order:

| Layer | What | Typical `kind_default` |
|---|---|---|
| `core` | identity, links, résumé, dates, relocation, sponsorship, arbitration, how-did-you-hear — asked on nearly every form | `constant`, `rule` |
| `auth` | work authorization / visa / right-to-work | `rule` |
| `legal` | arbitration, consent, background check, non-compete, attestations | `policy` |
| `comp` | salary / compensation expectation | `rule` |
| `eeo` | gender, race, veteran, disability | `never` |
| `narrative` | why this role/company, proudest project, hardest problem, failure, leadership | `narrative` |
| `screening` | per-family: years of X, frameworks, degree, clearance, seniority self-rating | `constant`, `rule` |
| `company` | one employer's own question, seen on ≥3 of their postings | `company` |

`kind_default: never` (EEO, salary history in states that forbid asking it) is never auto-filled —
the resolver always returns `ask`, and `remember.mjs`/`answers.mjs` never write a `never` row.

## Build pipeline

Four scripts, run in order; each is idempotent and re-running rewrites only its own output.

### 1. `scripts/canon-scan.mjs` — collect the corpus

```
node scripts/canon-scan.mjs [--companies private/companies-seed.yml] [--per-family 20]
                             [--families backend,mobile] [--extras corpus/companies-extra.yml]
                             [--recorded private/o1] [--out corpus] [--refresh]
```
Fetches real postings from Greenhouse (`?questions=true`), Ashby (GraphQL, ≤3 concurrent — the
schema endpoint 429s above ~6), and Lever (apply-page HTML), classifies each by
`src/canon/families.mjs`'s 20-family title taxonomy, and writes one file per posting —
`corpus/<ats>/<family>/<company>-<id>.json` — holding question *labels* only (help text truncated
to 300 chars, no personal data). A posting already on disk is counted, not re-fetched, unless
`--refresh`. 20% of the result is held out into `corpus/holdout.txt` (fixed seed, so re-running
does not reshuffle it) for `canon-eval.mjs`.

### 2. `scripts/canon-cluster.mjs` — build the bank

```
node scripts/canon-cluster.mjs [--dry-run] [--corpus corpus] [--out canon] [--concurrency 6]
```
Reads every `corpus/` file except the hold-out set and runs four passes: **group** (free —
`normalizeLabel()` collapses punctuation/case variants), **exact** (free — the alias table in
`src/canon/normalize.mjs`), **Jev pass 1** (one `choice` per still-unresolved label group against
the growing canon, with an explicit `none_of_these` meaning "this is new"), **Jev pass 2**
(clusters the resulting proposals against each other). A **route** step then promotes each
resolved group into a layer by fixed rules (`RULES` in the script) — core: asked across ≥8 job
families by ≥2 employers; family screening: recurs inside one family; company: one employer's
question on ≥3 of their postings; template: ≥3 postings from one employer sharing ≥80% of their
canonical ids; anything else stays in `canon/proposals.yaml` for a human pass. `--dry-run` runs the
free passes only (group + exact), no model calls. Rewrites `canon/questions.yaml`,
`canon/families/*.yaml`, `canon/vocab/*.yaml`, `canon/templates/*.yaml`, `canon/proposals.yaml`,
and `canon/README.md`. Jev only ever *selects* here (`choice` with `none_of_these`, refused below
confidence 0.7) — every id and canonical text is a deterministic slug minted in code, so two runs
over the same corpus differ only in the model's judgment calls, never in id spelling.

### 3. `scripts/canon-eval.mjs` — measure coverage

```
node scripts/canon-eval.mjs [--holdout FILE] [--limit N] [--concurrency N] [--out DIR] [--json]
```
Maps every hold-out posting's questions to canonical ids using the exact same matcher `apply.mjs`
uses at fill time (never the postings `canon-cluster.mjs` trained on: `--holdout` defaults to
`corpus/holdout.txt`), then prints a coverage table broken down by layer, ATS, and family, with two
numbers per bucket: **mapped** (the field resolved to a canonical id the gate accepts — the bank's
reach) and **answerable** (mapped *and* that id's `kind_default` is one the user can pre-answer:
`constant`/`rule`/`policy`/`narrative` — a field that maps to a `company` or `never` question is
correctly mapped and still ends as an `ask`, by design). Targets (core ≥ 95%, screening ≥ 85%,
narrative ≥ 80%) score the **answerable** column, per docs/PLAN.md §2.7's "mapped to a canonical
question *that has an answer*"; `eeo` is reported but has no target — the runner skips it by
design. Writes `canon/eval-<YYYY-MM-DD>.md` beside the printed table; `--json` instead prints
`{status, postings, instances, requests, groups, layers, ats, families, report}` with a
`mapped_pct`/`answerable_pct` on every bucket.

### 4. `scripts/answers.mjs` — pre-compute the user's answers

```
node scripts/answers.mjs --families ml_engineer,research_engineer [--curate] [--concurrency N]
                         [--dry-run] [--json]
node scripts/answers.mjs --accept ~/.config/jev-apply/review/narratives.md
```
Onboarding's last step (docs/PLAN.md §2.7, after the six-question interview and the résumé).
`constant`, `rule` and `policy` rows are written for every canonical question in the fixed
`CONSTANTS` / `RULES` / `POLICIES` tables in `src/canon/answers.mjs`; `--families` (one of the 20
ids in `src/canon/families.mjs`, printed by `--help`) additionally selects the `narrative` prompts,
walking the universal layers (core, auth, legal, comp, narrative) plus the screening layer of the
families named. It writes `~/.config/jev-apply/memory/answers.yaml` — `constant` rows copied from
stated facts and `rule` rows (a `rule_ref` evaluated at fill time by `ruleAnswer()` in
`src/jev/plan.mjs`), both silent; `policy` rows only where a matching preference already states a
stance, silent; `narrative` rows (three length variants) written by the OpenAI writer from facts
and usable stories, shown once for review. `company` and `never` kind rows are never written here —
`company` answers are produced per posting at queue time (docs/PLAN.md §2.2 step 10), `never` rows
are never auto-filled at all. A canonical question whose backing fact or preference is missing is
left out and listed under `missing` with the memory id that would fill it; the one rule the
*pipeline* backs (`q.legal.previously_applied`) is written only when there is application history
to answer from. Merging is additive and re-running is safe: a row already `reviewed: true` or
`source: user` is never overwritten. `--curate` additionally writes
`~/.config/jev-apply/review/narratives.md` — the drafted narratives in one file, addressed by handle,
for the user to edit. `--accept <file>` is a second, separate invocation (not combined with
`--families`): it reads that file back, and for every narrative — unchanged text is marked
`reviewed: true`; edited text is marked `reviewed: true` **and** `source: user`, so it is preserved
verbatim by every later run. `--dry-run` stops after the deterministic passes and prints what
*would* be written (`dry_run: true` in the payload): no writer call, no network, nothing saved.
`--json` keeps stdout's one JSON object and drops the progress logs on stderr.

Prints one JSON object: `{status, constants, rules, policies, narratives, coverage_line, missing[],
not_written?, review?}` (`--accept` instead prints `{status, constants, rules, policies, narratives,
coverage_line, reviewed, edited, unknown?}`); `status` is `needs_user` while any narrative is still
unreviewed, else `ready_to_submit`. `coverage_line` is the same "answers ready for N% of questions
seen in M real forms; K narratives to review" line the host relays to the user once.

## Regenerating the bank

```
node scripts/canon-scan.mjs             # ≥20 postings per family, 20 families (500 today)
node scripts/canon-cluster.mjs          # needs TYPESAFE_API_KEY
node scripts/canon-eval.mjs             # coverage on the 100-posting hold-out
```
All three are safe to re-run: `canon-scan.mjs` skips postings already on disk, `canon-cluster.mjs`
rewrites `canon/` deterministically apart from Jev's own judgment calls, and `canon-eval.mjs` never
writes into `canon/questions.yaml` — only its own dated report.
