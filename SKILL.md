---
name: jev-apply
description: >-
  Fills Greenhouse, Ashby and Lever job applications from the user's own saved facts, preferences, and
  stories: Jev selects the saved answer for each field (never guessing a personal detail, including
  EEO/demographic fields, which fill from the user's own onboarding answers). OpenAI, a keyed
  OpenAI-compatible model, or the CLI agent currently running writes only grounded new prose.
  Draft items are the agent's work, not questions for the user; unresolved personal facts and
  attestations still require the user's answer. Every fill is read back. When nothing is left
  to ask and the user's auto-submit preference is on, the runner clicks Submit itself and waits
  for the ATS's own confirmation (Lever always stops for the user: its Submit is behind a challenge
  only a person can answer); otherwise it stops at "ready to submit" for the user to click. Use when the user says
  "learn my background" (onboard from a résumé and links), "complete this application <url>", "use
  that answer next time" or gives a correction, "find roles", or "apply to the queue".
license: MIT
compatibility: Node 20+, Google Chrome, network
metadata:
  version: 0.4.0
  repo: theadaply/jev-apply
allowed-tools: Bash(node scripts/*)
---

# jev-apply

Private data lives in `~/.config/jev-apply/` (`env`, `memory/`, `documents/`, `applications/`,
`pipeline/`, `profile/`) — never in this repo. Run `node scripts/install.mjs` once to create it;
see `INSTALL.md` if it reports a missing key. Only `TYPESAFE_API_KEY` is required. For new prose,
the runner selects `OPENAI_API_KEY` (optional `JEV_APPLY_WRITER_MODEL`), or
`JEV_APPLY_WRITER_URL` + `JEV_APPLY_WRITER_MODEL` (+ optional `JEV_APPLY_WRITER_KEY`) for an
OpenAI-compatible endpoint. With neither configured, **you, the current CLI agent**, write the
draft from the supplied grounding; never turn that draft into a user chore.
If the user points you at this repo rather than an installed skill, follow `INSTALL.md` yourself;
let them enter the TypeSafe key in their private file, and ask for their résumé or posting URL
only when you cannot locate one they already supplied.

## Verb 1 — "Learn my background"

```
node scripts/learn.mjs --resume cv.pdf [--resume other.pdf] [--links url,url]
node scripts/learn.mjs --seed DIR          # fresh install only, from a prepared seed
node scripts/learn.mjs --answers ~/.config/jev-apply/answers.json   # private typed answers
```
Prints one JSON object: `{status, facts, preferences, documents, stories, answers, echo[], gaps[]}`.
Without a writer model configured, résumé reading uses a deterministic extractor (name from the
top line, contacts by regex, one story per bullet under a work/projects heading) instead of an
LLM — onboarding needs no OpenAI key. Relay `echo` (≤6 lines) to the user, then ask every
`gaps[].ask` in one message. A gap with one memory home carries `remember_as: {kind,id}`;
use **`remember_as.id`**, not the `g.*` prompt ID, as the key in the private
`~/.config/jev-apply/answers.json`.
For example, `g.email` with `remember_as.id: f.identity.email` is answered as
`{"f.identity.email":"robin@example.invalid"}`. `p.*` ids become preferences and `f.*` ids
become facts; other answers may include `{"p.auto_submit":true,"p.salary":{"min":150000,
"currency":"USD"}}`. Re-run `node scripts/learn.mjs --answers ~/.config/jev-apply/answers.json`.
Demographic answers use `canon/vocab/eeo-*.yaml`; unrecognised wording is
reported in `rejected[]`, never stored.
`g.work_auth` and `g.identity.name_split` carry no `remember_as` — their answers are one or two
plain fact ids named in the question itself (`f.work_auth.<CC>.*`, `f.identity.first_name` /
`f.identity.last_name`). Free-text corrections and gaps with no `remember_as` still go through
`remember.mjs` (verb 3), which mints an id from the instruction text instead of writing a typed row.
Re-running after a résumé changes (its sha256 differs) reports a diff, not a reset.

## Verb 2 — "Complete this application \<url\>"

```
node scripts/apply.mjs --url <posting> [--json]
node scripts/apply.mjs --tab                                  # the ATS tab already open in the profile
node scripts/apply.mjs --resume <slug>                        # re-attach; list every unfilled field
node scripts/apply.mjs --url <posting> --answers ~/.config/jev-apply/answers.json
node scripts/apply.mjs --schema eval/fixtures/<ats>-<id>.json --dry-run   # no ATS/browser; live Jev/writer
```
`--url` (or `--tab` for the ATS tab already open) detects the ATS, fetches the public schema,
resolves everything deterministic (identity, work authorization, dates, money, EEO/demographic rows
from `p.eeo`, restrictive-agreements rows from `p.legal.restrictive_agreements`) from memory, asks
Jev for the rest, drafts what `p.auto_draft` allows, then fills every resolved field on the real
page in the skill's dedicated Chrome profile — every fill is read back before the runner decides
whether to submit. `--dry-run --schema` reads a recorded ATS schema without fetching the board or
opening a browser; Jev and any configured writer still make live, potentially paid calls.
`--record-schema` additionally saves the raw ATS response to
`eval/fixtures/<ats>-<id>.json` for replay. When nothing is left to ask and `p.auto_submit` resolves
true, the runner clicks Submit itself, waits for the ATS's own confirmation, and reports
`submitted`; otherwise the filled tab stays open after the runner exits at `ready_to_submit` —
`--resume <slug>` re-attaches later and lists every field still not on the form, with its intended
value. `--submit`/`--no-submit` override `p.auto_submit` for one run; `--detect-submit` locates the
Submit control and its confirmation strategy and prints them without clicking, for a dry check
against a real form. **Lever is never auto-submitted:** its Submit runs an hCaptcha challenge the
runner never solves, so a Lever run always ends at `ready_to_submit` (or `needs_user`) whatever
`p.auto_submit` or `--submit` say — tell the user to click Submit and complete the challenge.

`--no-submit` applies to one invocation. Keep it on every `--answers` or `--queue` rerun
when the user wants to review before Submit.

### The four-status contract
One JSON object on stdout every time (`--json` suppresses the human-readable Decision table, which
otherwise prints to stderr):
- **`submitted`** — `{slug, confirmation:{detected, text?, url?, screenshot?}, filled, usage}`; the
  runner clicked Submit and the ATS confirmed it; the pipeline entry for this posting is now `applied`.
- **`ready_to_submit`** — nothing left to ask, and either `p.auto_submit` is off or unset, or the
  board is Lever — the summary is ready for the user to review and click Submit.
- **`needs_user`** — `{questions:[{qid, label, options?, remember_as:{kind,id}?, why}]}`. A
  `kind:"draft"` item additionally carries `{writes:"why_us"|"expand"|"narrative", prompt,
  grounding:string[], limits}` and is for the **CLI agent**, not the user.
- **`blocked`** — `{reason, detail?, screenshot?}`, e.g. `unsupported_ats` (URL is not a hosted
  Greenhouse, Ashby or Lever board), `queue_empty`, `submit_failed` (Submit was clicked but no ATS
  confirmation was detected — the tab is left open, untouched, for the user to finish by hand), or a
  captcha/dead-tab failure mid-fill. When a `slug` is present, some fields may already be set —
  `apply.mjs --resume <slug>` re-attaches and lists every field still not on the form with its
  intended value, so the user can finish by hand. That run also reads the board's own confirmation
  rules against the tab and reports `confirmation:{detected, strategy, text}`; once the user has
  submitted by hand — which is always how a Lever application is sent — it answers `submitted`.

### Handling `needs_user` without handing drafting to the user
Split `questions` by `kind`. **First**, for each `kind:"draft"` item, write the paragraph
yourself (instructions below), save it under its `qid` in a private `--answers` file and re-run
the application with the same `--no-submit` preference. This is still the status name
`needs_user` because the runner cannot call the model embedded in your CLI session; the
`draft` item is explicitly for **you**, not the person. If a configured writer made a draft
already, no such item appears.

**Then** relay only ordinary unresolved questions in one message: the `label` and its
`options` if present. A `policy_gate` attestation (AI-usage, arbitration, consent)
may be filled only from the user's explicit preference for **that exact attestation**;
otherwise ask them. Restrictive-agreements and EEO/demographic rows fill from saved
`p.legal.restrictive_agreements` and `p.eeo`; ask the user when either preference is
absent. No model may invent work authorization, identity, salary, EEO, legal stance
or any other missing personal fact.

### Writing a `draft` item as the CLI agent
The item carries `writes` (`why_us`, `expand`, `narrative`), `prompt`, `grounding` and
`limits` (`{words?, chars?}`). Draw only on that posting and the user's saved facts/stories
in `grounding`. Write one paragraph in first person, use past tense for completed work, no
marketing adjectives, no invented or rounded numbers, no other company's name, and respect
the stated limit. The runner checks your paragraph just like an API model's draft; if it
returns the same item with a refusal in `why`, repair the text and resend. If the grounding
cannot answer the question, do not fabricate a story: ask the user for the missing material.

### Feeding `--answers`
In `~/.config/jev-apply/answers.json`, write `{"<qid>":{"value":"…"}}` using the question's
printed `qid`. Copy its `remember_as` into the answer only if you want it saved, then re-run
the same apply command with `--answers ~/.config/jev-apply/answers.json`. A `draft` answer
is `{"value":"<the paragraph you wrote>"}`; it is per-application text, never memory, so it
has no `remember_as`. Re-running with the same file only re-plans open `ask` rows and does
not duplicate stored answers. A file question (the résumé) is answered with a saved file name
(`{"value": "backend-cv.pdf"}`) or a path to a file on disk, never with free text.

### Choosing the résumé
With several résumés saved, Jev reads each PDF and attaches the one whose own content (summary,
skills, tailored bullets) best fits the posting; a résumé the user tied to the role family always
wins. When the résumé question comes back with "none of your N résumés clearly fits this posting",
ask the user in one line: *upload a résumé tailored to this role, or use one of the saved ones?* For
a new file, run `learn.mjs --resume <file>` first, then answer with its file name; otherwise answer
with the name of the saved one they pick. What that comparison sends is each résumé's *career*
lines under a neutral label (`r0`, `r1`, …) — never the file's name, and never a contact, postal,
date-of-birth, marital-status or nationality line. If the pick's file has been deleted since it was
saved, the row says so by name and asks for `learn.mjs --resume <file>` rather than claiming no
résumé fits.

## Verb 3 — "Use that answer next time" / corrections

```
node scripts/remember.mjs "<the user's instruction, verbatim>" [--id <memory id>] [--dry-run]
```
Prints `{status, kind, id}`. Jev only classifies the instruction (a fact, a standing preference, a
correction, or "keep draft `d1`/`c1`"); the stored text is always the user's own words, never
model-authored. What the user states here holds for every application from then on — there is
nothing to ask about where it applies.

## Verb 4 — "Find roles"

```
node scripts/scan.mjs                              # tracked companies → pipeline
node scripts/pipeline.mjs list [--status found] [--top 10]
```
New postings enter `pipeline.yaml` as `found` with a Jev fit score and a reason built from the
user's own story titles.

## First session — guided start
When the user is new ("set me up", "help me apply to jobs"), run the verbs in this order and ask
only at the marked points:
1. **Résumés.** Ask for their standard résumé and any role-specific ones (ML, backend, …). Pass each
   as its own `--resume` to verb 1 and relay its `gaps[]` as usual.
2. **Companies.** `scan.mjs` reads the user's own `~/.config/jev-apply/companies.yml`, seeding it
   once from the repo's starter list on a fresh install (it logs `seeded <path> from …`). Ask which
   companies they want to track (names or careers-page URLs) when they say the seeded list is not
   theirs, or when scan fails with `no …/companies.yml and no seed at …`, and write that list for
   them in the shape `references/companies-format.md` gives — only the companies they named.
3. **Find.** Verb 4, then show `pipeline.mjs list --top 10` and ask which to shortlist.
4. **Apply.** Verb 5 on the shortlist. Each posting gets its best-fitting résumé; relay the one
   merged `needs_user` batch, including any "upload a tailored résumé?" question (see "Choosing the
   résumé").

## Verb 5 — "Apply to the queue"

```
node scripts/pipeline.mjs queue <id> [<id> …]      # shortlist, from `pipeline.mjs list` ids
node scripts/apply.mjs --queue 5 [--answers ~/.config/jev-apply/answers.json]
```
Plans every queued posting (schema fetch + both Jev requests) in parallel, fills every resolved
field on all N tabs, then returns **one** merged and deduplicated `needs_user` batch — "visa
sponsorship?" is asked once even when five queued postings ask it. Resolve `kind:"draft"` items
yourself first, then relay the remaining questions. Feeding the same file back to `--answers`
routes each answer to every posting that asked it, stores it to memory, and finishes each
posting to `submitted` or `ready_to_submit`
depending on `p.auto_submit`.

## Rules

- The runner clicks Submit only when `p.auto_submit` resolves true and nothing is left to ask; it
  always waits for the ATS's own confirmation before reporting `submitted`, and a click happens at
  most once per application. `p.auto_submit` starts unset — the user is asked once, at onboarding.
- A `policy_gate` attestation (AI-usage, arbitration, consent) can use only the explicit
  `p.legal.<slug>` preference the user stated for **that attestation**; absent means ask. Never
  borrow a neighbouring policy preference or a canonical answer. Restrictive-agreements
  questions use the global `p.legal.restrictive_agreements` preference once it exists.
- EEO/demographic rows are filled from `p.eeo` whenever it is on file, and asked once, exactly like
  any other row, the first time it is unset. No personal detail is ever guessed or defaulted from a
  name, photo, or résumé: an unknown value is always `ask`, never a first-option or first-saved-item
  fallback.
- A drafted answer is never a guessed fact: a row nothing on file (or the posting) supports goes
  back to `ask`, whether the writer is a model or you.
- All user data lives under `~/.config/jev-apply/`; nothing personal is ever written to this repo.

## Details

- Jev request shape, validation, and confidence gates: `references/jev-usage.md`
- Greenhouse form anatomy and selectors: `references/ats-greenhouse.md`
- Ashby form anatomy and selectors: `references/ats-ashby.md`
- The canonical question bank (layers, coverage, how to regenerate it, pre-computed answers):
  `references/canon.md`
- Memory file format: `references/memory-format.md`
- Companies/boards file format: `references/companies-format.md`
- Architecture, data shapes, build order: `docs/PLAN.md`; module interfaces: `docs/CONTRACTS.md`
