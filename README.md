# jev-apply

A memory-backed job-application skill. TypeSafe AI's **Jev** model *selects* which of your saved
facts, preferences, or past answers belongs in each form field — it never writes text and never
guesses a personal detail. The few sentences that are genuinely new — a "why us" paragraph, an
expanded story — are written by whichever backend you configure (or by the host agent, when you
configure none). A Playwright runner fills the real form and reads every value back. It targets
hosted **Greenhouse** and **Ashby** application forms, stops at ready-to-submit by default, and
clicks Submit itself only once you turn auto-submit on.

The only credential jev-apply cannot run without is a TypeSafe **Jev** key.

## Quickstart

```
git clone https://github.com/theadaply/jev-apply.git && cd jev-apply && npm install
node scripts/install.mjs
printf 'TYPESAFE_API_KEY=...\n' > ~/.config/jev-apply/env && chmod 600 ~/.config/jev-apply/env
node scripts/learn.mjs --resume you.pdf --links https://linkedin.com/in/you,https://github.com/you
node scripts/apply.mjs --url <posting>
```

`learn.mjs` prints the day-1 questions it still needs answered; write them to `answers.json`
(`{"<id>": <answer>}`) and re-run `node scripts/learn.mjs --answers answers.json`.

## Choose how text gets written

`apply.mjs` writes only a handful of sentences per application — the rest is your own saved
material, selected by Jev, never generated. Pick one:

```
echo 'OPENAI_API_KEY=sk-...' >> ~/.config/jev-apply/env                       # OpenAI writes it
echo 'JEV_APPLY_WRITER_URL=http://127.0.0.1:11434/v1' >> ~/.config/jev-apply/env  # your own model writes it
# do nothing                                                                   # your agent writes it
```

A local server (Ollama, llama.cpp, LM Studio) also needs `JEV_APPLY_WRITER_MODEL=<name>` in the
same file; it costs nothing and needs no key. With neither set, jev-apply detects it is running
inside Claude Code or Codex and hands the paragraph's prompt, grounding, and word limit back as a
question for the host agent to write and return — checked against the same rules a model's draft
would face. `node scripts/writer-smoke.mjs --detect` prints which one is active.

## Daily use

### Complete one application

```
node scripts/apply.mjs --url <posting>
```

Fills every field it can, then prints one JSON object with a status:

- **`submitted`** — Submit was clicked and the ATS confirmed it.
- **`ready_to_submit`** — nothing left to ask; review the summary and click Submit yourself.
- **`needs_user`** — some fields need you; see below.
- **`blocked{reason}`** — e.g. `unsupported_ats`. `apply.mjs --resume <slug>` re-attaches and lists
  every field still unfilled with its intended value, so you can finish by hand.

Answer a `needs_user` batch by writing `answers.json` (`{"<qid>": {"value": "…"}}` from the
questions it printed — add "remember_as" back through exactly as printed for a row you want saved)
and re-running with the answers:

```
node scripts/apply.mjs --url <posting> --answers answers.json
node scripts/apply.mjs --resume <slug>          # re-attach later, list unfilled fields
```

### Corrections

```
node scripts/remember.mjs "my email is now jane@example.com"
node scripts/remember.mjs "never apply to contract roles"
```

Jev only classifies the instruction (fact, preference, or correction) — the words it stores are
always yours, and what you tell it holds for every application from then on.

### Find roles

```
node scripts/scan.mjs
node scripts/pipeline.mjs list
```

`scan.mjs` pulls new postings from your tracked companies into the pipeline; `pipeline.mjs list`
shows them with a Jev fit score and a reason built from your own story titles.

### Apply to the queue

```
node scripts/pipeline.mjs queue 12 15 19
node scripts/apply.mjs --queue 3
```

`queue` shortlists ids from `pipeline.mjs list`; `apply.mjs --queue N` plans and fills all N in
parallel and returns **one** merged, de-duplicated `needs_user` batch — "visa sponsorship?" is
asked once even when five queued postings ask it. Feed `--answers` back once and every posting
finishes to `submitted` or `ready_to_submit`.

### Auto-submit

Off by default. `p.auto_submit` is asked once at onboarding (`g.auto_submit`, y/n). Override it
for one run:

```
node scripts/apply.mjs --url <posting> --submit      # force Submit on for this run
node scripts/apply.mjs --url <posting> --no-submit    # force it off for this run
```

### Demographics and legal questions

`p.eeo` (gender, race/ethnicity, veteran and disability status, pronouns — each independently
declinable) and `p.legal.*` (non-compete and other stated legal stances) are asked once, at
onboarding or the first time a form needs them, then filled from memory on every later
application. Never guessed from your name, résumé, or photo.

## With an agent

Install as a skill — `npx skills add theadaply/jev-apply`, or symlink the clone into
`~/.claude/skills/jev-apply` / `~/.agents/skills/jev-apply`. Then just say: "learn my background",
"complete this application `<url>`", "use that answer next time", "find roles", or "apply to the
queue".

## What it never does

- Never guesses a personal fact — an unknown value always comes back as a question, never a default.
- Never picks a default option — a select needs an explicit match or it's asked.
- Never writes your data into this repository — everything lives under `~/.config/jev-apply/`.
- Never clicks Submit unless you've turned `auto_submit` on — otherwise it stops at ready-to-submit.

## Where your data lives

```
~/.config/jev-apply/        (0700)
  env                       TYPESAFE_API_KEY (required); OPENAI_API_KEY or JEV_APPLY_WRITER_URL /
                            JEV_APPLY_WRITER_MODEL (optional) — chmod 600, read once at start
  memory/                   facts, preferences, stories, pre-computed answers, drafts, corrections
  documents/                résumés and other uploaded files
  applications/<slug>/      per-application trace and decision log
  pipeline/                 tracked companies, scanned postings, the queue
```

## Measured

Hold-out coverage of the canonical question bank, on 100 postings it was never built from
(`canon/eval-2026-09-22.md`, 1,946 question instances). The targets score **answerable** — mapped
to a canonical question *that has an answer* — not merely recognised:

| group | answerable | target |
|---|---:|---:|
| core | 98.5% ✓ | 95% |
| screening | 64.9% ✗ | 85% |
| narrative | 51.8% ✗ (91.1% mapped) | 80% |
| overall | 78.3% (79.5% mapped) | — |

Core clears it. Narrative is recognised on 91.1% of its instances but half of that is
`q.narrative.why_company`, written per posting at queue time rather than pre-answered. EEO (349
instances) maps to 0% by design: demographic rows are resolved from `p.eeo` directly, never judged
by Jev.

Control-driving accuracy, latest run (`bench/results/2026-09-22-round3-domfix.md`, 5 real
postings): 60 of 97 fields filled automatically; every attempted control — text, textarea,
react-select, radio, checkbox, phone, file upload, location — landed and read back at 100%.

Live, end to end: real Greenhouse (Together AI) and Ashby (Baseten) forms filled — schema fetch,
deterministic resolve, Jev, then Playwright with every write read back — at **1–2 Jev requests per
posting**, about **$0.0004 of Jev per posting**.

## Working on it

```
src/
  config.mjs      constants, env loader, writer auto-detection, private-directory paths
  memory/         the YAML store and derivations (since:, notice, salary)
  schema/         Greenhouse/Ashby schema fetch, question classification, FormPlan normalization
  jev/            the Jev client, request builders, confidence gates
  writer/         which backend writes, and the grounding/limit checks every draft passes
  plan/           resolve → decide → draft → execute → summarize
  browser/        Chrome-over-CDP lifecycle and the per-control fill/readback adapters
  discover/       board providers, filters, dedup, fit scoring
  pipeline/       the pipeline store, status transitions, rendering
  canon/          the question-bank builder and its pre-computed answers
  bench/          the form-filling benchmark's synthetic profile, runner, and reports
```

Checks:

```
node eval/plan.test.mjs                 # resolve+Jev+gate pipeline against recorded fixtures
node scripts/controls-smoke.mjs         # every browser control kind, driven live
node scripts/writer-smoke.mjs --detect  # which writer backend this environment would use
node scripts/bench.mjs --postings bench/smoke.txt --limit 2 --home /tmp/jev-bench
node scripts/canon-scan.mjs --companies private/companies-seed.yml   # rebuild the corpus
node scripts/canon-cluster.mjs          # corpus → canon/questions.yaml
node scripts/canon-eval.mjs             # hold-out coverage report
```

The question bank (`canon/`) is generated from real postings; see `canon/README.md` for how it's
built and regenerated. Module interfaces are in `docs/CONTRACTS.md`; architecture, data shapes, and
build order are in `docs/PLAN.md`.
