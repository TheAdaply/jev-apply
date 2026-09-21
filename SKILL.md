---
name: jev-apply
description: >-
  Fills Greenhouse and Ashby job applications from the user's own saved facts, preferences, and
  stories: Jev selects the saved answer for each field (never guessing a personal detail), an
  OpenAI model drafts only genuinely new text, and every fill is read back before the runner stops
  at "ready to submit" for the user to click Submit. Use when the user says "learn my background"
  (onboard from a résumé and links), "complete this application <url>", "use that answer next time"
  or gives a correction, "find roles", or "apply to the queue".
license: MIT
compatibility: Node 20+, Google Chrome, network
metadata:
  version: 0.1.0
  repo: theadaply/jev-apply
allowed-tools: Bash(node scripts/*)
---

# jev-apply

Private data lives in `~/.config/jev-apply/` (`env`, `memory/`, `documents/`, `applications/`,
`pipeline/`, `profile/`) — never in this repo. Run `node scripts/install.mjs` once to create it;
see `INSTALL.md` if it reports missing keys.

## Verb 1 — "Learn my background"

```
node scripts/learn.mjs --resume cv.pdf [--resume other.pdf] [--links url,url]
node scripts/learn.mjs --seed DIR          # fresh install only, from a prepared seed
```
Prints one JSON object: `{status, facts, preferences, documents, stories, echo[], gaps[]}`. Relay
`echo` (≤6 lines) to the user, then ask every `gaps[].ask` in one message and store the answers with
`remember.mjs` (verb 3). Re-running after a résumé changes (its sha256 differs) reports a diff, not
a reset.

## Verb 2 — "Complete this application \<url\>"

```
node scripts/apply.mjs --url <posting> [--json]
node scripts/apply.mjs --tab                                  # the ATS tab already open in the profile
node scripts/apply.mjs --resume <slug>                        # re-attach; list every unfilled field
node scripts/apply.mjs --url <posting> --answers answers.json # finish after the host relays answers
node scripts/apply.mjs --schema eval/fixtures/<ats>-<id>.json --dry-run   # plan offline, no browser
```
`--url` (or `--tab` for the ATS tab already open) detects the ATS, fetches the public schema,
resolves everything deterministic (identity, work authorization, dates, money) from memory, asks
Jev for the rest, then fills every resolved field on the real page in the skill's dedicated Chrome
profile — every fill is read back before the runner stops. `--dry-run` skips the browser entirely
(plan only, useful offline with `--schema`); `--record-schema` additionally saves the raw ATS
response to `eval/fixtures/<ats>-<id>.json` for replay. Submit is never clicked, and the filled tab
stays open after the runner exits — `--resume <slug>` re-attaches later and lists every field still
not on the form, with its intended value.

### The three-status contract
One JSON object on stdout every time (`--json` suppresses the human-readable Decision table, which
otherwise prints to stderr):
- **`ready_to_submit`** — nothing left to ask.
- **`needs_user`** — `{questions:[{qid, label, options?, remember_as:{kind,id,scope}, why}]}`.
- **`blocked`** — `{reason, detail?, screenshot?}`, e.g. `unsupported_ats` (URL is neither a
  hosted Greenhouse nor Ashby board), `queue_empty`, or a captcha/dead-tab failure mid-fill. When a
  `slug` is present, some fields may already be set — `apply.mjs --resume <slug>` re-attaches and
  lists every field still not on the form with its intended value, so the user can finish by hand.

### Relaying `needs_user`
For each question, in one message: `label` → its `options` if present → "I'll remember this for
`<remember_as.scope>`". Never answer a `policy_gate`-class question (AI-usage attestation,
arbitration, consent) on the user's behalf — always ask, every time, even at company scope.

### Feeding `--answers`
Write a file shaped `{"<qid>": {"value": "…", "remember_as": {"kind": "fact|preference|answer",
"id": "…", "scope": "global|company:<slug>|role_family:<family>"}}}` and re-run the exact same
`apply.mjs` invocation with `--answers answers.json` added. It re-plans only the rows still marked
`ask` — idempotent, so a second run with the same file changes nothing — and stores an answer to
memory whenever `remember_as` is present.

## Verb 3 — "Use that answer next time" / corrections

```
node scripts/remember.mjs "<the user's instruction, verbatim>" [--scope global|company:<slug>|role_family:<family>]
```
Jev only classifies the instruction (a fact, a standing preference, a correction, or "keep draft
`d1`/`c1`") and picks the scope when it's ambiguous; the stored text is always the user's own words,
never model-authored.

## Verb 4 — "Find roles"

```
node scripts/scan.mjs                              # tracked companies → pipeline
node scripts/pipeline.mjs list [--status found] [--top 10]
```
New postings enter `pipeline.yaml` as `found` with a Jev fit score and a reason built from the
user's own story titles.

## Verb 5 — "Apply to the queue"

```
node scripts/pipeline.mjs queue <id> [<id> …]      # shortlist, from `pipeline.mjs list` ids
node scripts/apply.mjs --queue 5 [--answers answers.json]
```
Plans every queued posting (schema fetch + both Jev requests) in parallel, fills every resolved
field on all N tabs, then returns **one** merged and deduplicated `needs_user` batch — "visa
sponsorship?" is asked once even when five queued postings ask it. Relay it exactly like verb 2's
`needs_user`; feeding the same file back to `--answers` routes each answer to every posting that
asked it, stores it to memory, and finishes all N to `ready_to_submit`.

## Rules

- Never click Submit. The runner's terminal state is "ready to submit"; the user submits.
- Never answer a `policy_gate` question (AI-usage attestation, arbitration, consent) for the user.
- No personal detail is ever guessed or defaulted — an unknown value is always `ask`, never a
  first-option or first-saved-item fallback.
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
