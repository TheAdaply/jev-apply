# jev-apply — agent context

Memory-backed job-application assistant packaged as an agent skill. TypeSafe AI's **Jev** model *selects*
which saved item (fact, preference, story, answer) fills each form field; an OpenAI model writes only
genuinely new text; a Playwright runner executes and verifies. Read `docs/PLAN.md` before changing anything —
it is the decision record (architecture §2, data shapes §2.3, memory §2.4, pipeline §2.5, build order §4).

## Conventions
- Node ≥ 20, ESM `.mjs`, no build step, no framework. Dependencies: `@typesafe-ai/sdk`, `playwright`
  (library only), `openai`, `yaml`, `pdf-parse`. HTTP goes through Node's built-in `fetch`; never add
  or import the standalone `undici` package. Its module init takes over the global dispatcher slot
  that built-in `fetch` reads, and every *other* module's responses then arrive still-compressed with
  `content-encoding` stripped — `JSON.parse` sees binary, which reads like a broken ATS, not a bad import.
- Scripts in `scripts/` are the skill's entry points; `SKILL.md` maps the five user verbs to them.
  Every script prints exactly one JSON object on stdout and exits 0 for `ready_to_submit`, `needs_user`,
  and `blocked`.
- Constants live in `src/config.mjs` (`JEV_MODEL = "jev-1.13.0"`, `OPENAI_MODEL`); thresholds only in
  `src/jev/gates.mjs`.

## Data and secrets
- User data lives outside the repo in `~/.config/jev-apply/` (`env`, `memory/`, `documents/`,
  `applications/`, `pipeline/`, `profile/`). Nothing user-specific is ever written under the repo.
- `~/.config/jev-apply/env` holds `TYPESAFE_API_KEY` and `OPENAI_API_KEY`. Never print, log, or commit
  key material; `.env*` (except `.env.example`), `memory/`, `private/`, and local notes under
  `docs/research/` are gitignored.

## Invariants (do not break)
- Jev never generates text; every Jev question has an explicit `none_of_these` exit and its answer is
  validated (`choice ∈ criteria`, probabilities sum ≈ 1, argmax == choice).
- No personal fact is ever defaulted or guessed: unknown → `ask`. Selects never fall back to the first option.
- Drafts are per-application and become memory only through `remember.mjs`.
- Every browser write is read back and logged to `applications/<slug>/trace.jsonl`.
- The runner never clicks Submit and never touches EEO/demographic sections without an explicit preference.

## Working here
- Implement one step of `docs/PLAN.md` §4 at a time; each step ends with its named observable check.
- Do not run project-wide formatters, linters, or test suites unless the task says so.
