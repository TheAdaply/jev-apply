# corpus — real application forms, question text only

Input to `scripts/canon-cluster.mjs` (docs/PLAN.md §2.7). 500 public job postings from
75 companies across Greenhouse, Ashby and Lever, carrying 9036 question
instances. The canonical question bank is derived from these: labels are clustered, the recurring
ones become canonical questions with `surface_forms` and `options_seen`, and the user pre-answers
those once instead of re-answering every form.

Regenerate with:

    node scripts/canon-scan.mjs --companies private/companies-seed.yml --per-family 20

Re-running is idempotent — postings already here are counted, not re-fetched (`--refresh` forces).

## What is in a file

`corpus/<ats>/<family>/<company>-<id>.json`:

    { ats, company, family, title, location, url,
      questions: [{ label, help, type, required, section, options: [label…] }],
      sections: [title…], captured }

`family` comes from `src/canon/families.mjs` (deterministic title keywords, no model call).
`section` is the form's own grouping (Ashby section, Lever card title, Greenhouse compliance
block), which the clusterer needs as context for an otherwise ambiguous label.
`type` uses the FormPlan vocabulary — text · textarea · file · single_select · multi_select ·
boolean · number · date · phone · url — plus `composite` for a repeating sub-form that one ATS
models as a single field (Ashby's education/work history; Greenhouse spells the same thing out as
separate selects).

## What is deliberately not in a file

No job description (only per-question `help`, truncated to 300 characters), no applicant
data, no answers, no cookies or tokens, no company-private fields. Everything here is served
publicly and anonymously by the three board APIs to anyone opening the posting.

## Counts

Target: ≥ 20 postings per family (collection stops at 25).

| family | greenhouse | ashby | lever | total |
|---|---|---|---|---|
| ai_product_fde | 13 | 7 | 5 | 25 |
| research_engineer | 13 | 12 | 0 | 25 |
| applied_scientist | 13 | 8 | 4 | 25 |
| ml_scientist | 13 | 8 | 4 | 25 |
| ml_engineer | 13 | 5 | 7 | 25 |
| gpu_performance | 13 | 6 | 6 | 25 |
| systems_embedded_compilers | 13 | 3 | 9 | 25 |
| security | 13 | 5 | 7 | 25 |
| infra_sre | 13 | 5 | 7 | 25 |
| data_engineer | 13 | 2 | 10 | 25 |
| analytics_engineer | 13 | 0 | 12 | 25 |
| data_scientist | 13 | 3 | 9 | 25 |
| mobile | 6 | 6 | 13 | 25 |
| fullstack | 5 | 9 | 11 | 25 |
| frontend | 5 | 10 | 10 | 25 |
| backend | 7 | 8 | 10 | 25 |
| product_manager | 7 | 11 | 7 | 25 |
| product_designer | 8 | 6 | 11 | 25 |
| solutions_engineer | 13 | 5 | 7 | 25 |
| devrel_techwriter | 13 | 5 | 7 | 25 |
| **total** | 220 | 124 | 156 | **500** |

Postings per company (75 companies; no single board is more than
7% of the corpus):

Anthropic 37 · Binance 31 · Zoox 20 · Match Group 19 · Palantir 18 · Shield AI 18
Spotify 17 · Databricks 16 · Veeva 16 · Baseten 14 · Asana 12 · PointClickCare 12
Coinbase 11 · CoreWeave 11 · Affirm 10 · Airbnb 10 · Brex 10 · Cohere 10
Cloudflare 9 · Datadog 9 · Mistral 9 · Cerebras 8 · Scale AI 8 · Wayve 8
Cognition 7 · ElevenLabs 7 · Fireworks 7 · Together AI 7 · Anyscale 6 · Decagon 6
Etched 6 · Harvey 6 · 1Password 5 · Exa 5 · Faire 5 · Figma 5
Graphcore 5 · Discord 4 · Isomorphic Labs 4 · LangChain 4 · Tenstorrent 4 · Character.AI 3
d-Matrix 3 · DeepL 3 · Elastic 3 · GitLab 3 · Instacart 3 · JumpCloud 3
Lyft 3 · Ramp 3 · xAI 3 · Confluent 2 · Dropbox 2 · Duolingo 2
Gopuff 2 · Luma 2 · Notion 2 · Pinterest 2 · Samsara 2 · Snowflake 2
Speechmatics 2 · Flexport 1 · Grafana Labs 1 · Gusto 1 · Lambda 1 · Linear 1
Okta 1 · Perplexity 1 · Physical Intelligence 1 · Reddit 1 · Redis 1 · Roblox 1
Sierra 1 · Stability AI 1 · Synthesia 1

## Hold-out

`holdout.txt` lists a seeded-random 20% of the files (seed
0x5ca7f00d, same split every run). `canon-eval.mjs` measures coverage on those
files only, so the bank is never evaluated on the postings it was clustered from.

## Licence and provenance

Question labels are factual form field text published by the employer's public job board
(`boards-api.greenhouse.io`, `api.ashbyhq.com`, `api.lever.co`, `jobs.lever.co/…/apply`).
They are collected here as short factual excerpts for interoperability research — mapping the
questions an applicant is asked to answers the applicant has already written. Each file keeps the
posting `url` so any entry can be traced to its source. Trademarks and role descriptions belong to
their respective companies; no employer endorses this project. Code in this repository is MIT;
this directory is data *about* public forms, not a work of the companies listed.
