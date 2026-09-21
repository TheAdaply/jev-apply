# jev-apply

A memory-backed job-application skill. TypeSafe AI's **Jev** model *selects* which saved fact,
preference, story, or prior answer belongs in each form field — it never writes text and never
guesses a personal detail; anything unknown comes back as a question. An OpenAI model writes only
genuinely new prose, such as a "why us" paragraph. A Playwright runner fills each control and reads
the value back. It stops at **ready to submit**; the user clicks Submit.

## Quickstart

```
git clone https://github.com/theadaply/jev-apply.git && cd jev-apply && npm install
node scripts/install.mjs                       # creates ~/.config/jev-apply/
# put TYPESAFE_API_KEY and OPENAI_API_KEY in ~/.config/jev-apply/env, chmod 600
node scripts/learn.mjs --resume cv.pdf          # learn your background once
node scripts/apply.mjs --url <posting>          # fill an application (see status below)
node scripts/scan.mjs && node scripts/pipeline.mjs list   # find roles
```
See `INSTALL.md` for the agent-facing setup (skill registration, key placement) and `SKILL.md` for
how a host agent should relay each verb's output to a user.

## The five verbs

1. **"Learn my background"** — `learn.mjs` extracts facts, preferences, and stories from a résumé
   PDF and public links, echoes a short summary, and asks a fixed six-item day-1 questionnaire once.
2. **"Complete this application \<url\>"** — `apply.mjs` fetches the form schema, resolves
   everything it can from memory, asks Jev for the rest, fills every resolved field on the real
   page, reads each fill back, and returns exactly one of three statuses: `ready_to_submit`,
   `needs_user`, or `blocked`.
3. **"Use that answer next time"** / corrections — `remember.mjs` turns one spoken instruction into
   one memory row at the right scope (global / this company / this role family); Jev only classifies
   and scopes it, the stored words are always the user's own.
4. **"Find roles"** — `scan.mjs` pulls new postings from tracked company boards into a pipeline,
   each with a Jev fit score and a reason built from the user's own story titles.
5. **"Apply to the queue"** — `pipeline.mjs queue <ids>` shortlists postings; `apply.mjs --queue N`
   plans and fills all N in parallel and returns one merged `needs_user` batch before finishing
   every posting to `ready_to_submit`.

## Architecture

```
Host agent → scripts/*.mjs (one JSON object on stdout, exit 0 for every user-facing status)
  learn/remember  → private memory (~/.config/jev-apply/memory, YAML, atomic writes)
  scan/pipeline   → discovery providers → pipeline.yaml (Jev fit score)
  apply           → schema fetch (Greenhouse/Ashby public APIs, no browser)
                  → deterministic resolve pass (facts/preferences/derivations)
                  → Jev (canonical question, then option match) → gated Decision table
                  → Playwright over a dedicated Chrome CDP profile, one tab per posting
                  → ready_to_submit / needs_user / blocked, ≤20-line summary
```

## The question bank

400 real postings (7,090 question instances, 938 normalized labels) collapse into 292 canonical
questions across 8 layers (core, auth, legal, comp, eeo, narrative, screening, company) — five
questions appear on nearly every form, because the form is set by the company's own template, not
the job. Most questions are pre-answered once (`scripts/answers.mjs`) and only *mapped* at fill
time instead of judged fresh on every application. See `canon/README.md` for the generated bank
and `references/canon.md` for how it is built, evaluated, and regenerated.

## Measured

Hold-out coverage, on the 100 postings the bank was never built from (`canon/eval-2026-09-22.md`,
1,946 question instances). The targets score **answerable** — mapped to a canonical question *that
has an answer* — not merely recognised:

| group | answerable | target |
|---|---:|---:|
| core | 98.5% ✓ | 95% |
| screening | 64.9% ✗ | 85% |
| narrative | 51.8% ✗ (91.1% mapped) | 80% |
| overall | 78.3% (79.5% mapped) | — |

Core clears it. Narrative is recognised on 91.1% of its instances but half of that is
`q.narrative.why_company`, which is written per posting at queue time rather than pre-answered.
Screening misses because a screening question is only a candidate when its family matches the
posting's title. EEO (349 instances) reads 0% by design: demographic rows are never put in front of
the selector.

Live, end to end: real Greenhouse (Together AI) and Ashby (Baseten) application forms filled —
schema fetch, deterministic resolve, Jev, then Playwright with every write read back — at **1–2 Jev
requests per posting**, about **$0.0004 of Jev per posting**.

## Privacy

All user data — memory, documents, applications, the pipeline, the browser profile — lives in
`~/.config/jev-apply/` (`0700`), never in this repository. `TYPESAFE_API_KEY` and `OPENAI_API_KEY`
live in `~/.config/jev-apply/env` and are read once at process start; no script prints, logs, or
commits key material. The runner never clicks Submit and never answers a policy/attestation
question on the user's behalf.

## Status

v1 targets hosted Greenhouse (`job-boards.greenhouse.io`) and Ashby (`jobs.ashbyhq.com`)
application forms; every other URL — embedded/iframe boards, Lever, Workday, or anything else —
returns `blocked{reason:"unsupported_ats"}`. `apply.mjs` fills real forms end to end: schema
fetch, the deterministic resolve pass, the two Jev requests, a Playwright pass over a dedicated
Chrome CDP profile with every fill read back, and a `ready_to_submit` / `needs_user` / `blocked`
result — verified live against real Greenhouse and Ashby postings. `--queue N` does the same for
a whole pipeline shortlist in one merged batch. For architecture, data shapes, the runner
pipeline, and the full build order, see [`docs/PLAN.md`](docs/PLAN.md); module interfaces are in
[`docs/CONTRACTS.md`](docs/CONTRACTS.md).
