# jev-apply — agent context

Memory-backed job-application skill: Jev selects saved answers, an optional OpenAI/OpenAI-compatible/
host writer drafts only grounded new text, and Playwright fills and reads back. Read `docs/PLAN.md` before changing
anything — it records architecture (§2), data shapes (§2.3), memory (§2.4), and pipeline (§2.5).
`SKILL.md` is the current user-facing CLI contract.

## Commands
- Install: `npm ci`; initialize a private home with `node scripts/install.mjs` (see `INSTALL.md`).
- Fast CI check: `npm run check:syntax` (parsing only; no key or model calls).
- Live acceptance: `node eval/plan.test.mjs` (private memory + paid Jev calls; not an offline test).
- Browser fixture: `node scripts/controls-smoke.mjs` (Google Chrome; isolated bench profile).
- `scripts/eeo-smoke.mjs --live --url ...` writes synthetic demographic answers to a real
  Greenhouse form in a separate smoke profile; never run it during a user's application or demo.

## Conventions
- Node ≥ 20, ESM `.mjs`, no build step, no framework. Dependencies: `@typesafe-ai/sdk`, `playwright`
  (library only), `openai`, `yaml`, `pdf-parse`. HTTP goes through Node's built-in `fetch`; never add
  or import the standalone `undici` package. Its module init takes over the global dispatcher slot
  that built-in `fetch` reads, and every *other* module's responses then arrive still-compressed with
  `content-encoding` stripped — `JSON.parse` sees binary, which reads like a broken ATS, not a bad import.
- `SKILL.md` maps the five user verbs to scripts in `scripts/`. `scripts/apply.mjs` prints exactly
  one JSON object on stdout and exits 0 for `submitted`, `ready_to_submit`, `needs_user`, and
  `blocked`; diagnostic smoke scripts print check lines instead.
- Constants live in `src/config.mjs` (`JEV_MODEL = "jev-1.13.0"`, `OPENAI_MODEL`); thresholds only in
  `src/jev/gates.mjs`.

## Data and secrets
- User data lives outside the repo in `~/.config/jev-apply/` (`env`, `memory/`, `documents/`,
  `applications/`, `pipeline/`, `profile/`). Nothing user-specific is ever written under the repo.
- `~/.config/jev-apply/env` requires `TYPESAFE_API_KEY`; optional writing uses `OPENAI_API_KEY`
  (with an optional `JEV_APPLY_WRITER_MODEL`) or `JEV_APPLY_WRITER_URL` +
  `JEV_APPLY_WRITER_MODEL` (with an optional `JEV_APPLY_WRITER_KEY`). Never print, log, or commit key material;
  `.env*` (except `.env.example`), `memory/`, `private/`, and local `docs/research/` are gitignored.

## Invariants (do not break)
- Jev never generates text; every Jev question has an explicit `none_of_these` exit and its answer is
  validated (`choice ∈ criteria`, probabilities sum ≈ 1, argmax == choice).
- No personal fact is ever defaulted or guessed: unknown → `ask`. Selects never fall back to the first option.
- Drafts are per-application and become memory only through `remember.mjs`. A `why_us` or essay row is
  written by the writer when `p.auto_draft` resolves true, from the posting's own text and the user's
  saved material only: every number and name in it appears in that grounding, no other company the
  user is applying to is named, the field's stated word/char limit is respected, and the draft is
  listed under ► DRAFTED before Submit. A draft is never a fact — a row nothing on file supports goes
  back to `ask`, and a missing personal fact is still asked, never written around.
- Every browser write is read back and logged to `applications/<slug>/trace.jsonl`.
- The runner clicks Submit only when `p.auto_submit` resolves true (company override, else global) and
  nothing is left to ask; it always waits for the ATS's own confirmation before recording `submitted`,
  and a click happens at most once per application. EEO/demographic controls are filled from `p.eeo`
  whenever it is on file — always attempted, asked once when it is not — never guessed from a name,
  photo, or résumé. Legal questions about the *user* (a non-compete, and similar) answer from the
  global `p.legal.restrictive_agreements` preference. A `policy_gate` attestation — an
  acknowledgement, consent or "I understand…" the user signs — is answered from one explicit
  `p.legal.<slug>` preference they stated, and from nothing else: never from the canonical answer
  bank, never from a neighbouring preference, and `ask` whenever that row is absent.

## Working here
- Treat `docs/PLAN.md` as decisions; §4 is the historical build order, not a pending task list.
- Run the relevant behavioral smoke for a change. Do not run project-wide formatters, linters,
  or the live paid eval unless the task needs them.
