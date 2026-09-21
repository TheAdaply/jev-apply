# Changelog

## v0.1.0

First public release. Greenhouse and Ashby hosted boards only; every other ATS URL comes back
`blocked{reason:"unsupported_ats"}`. `apply.mjs` runs the full pipeline end to end — schema fetch,
deterministic resolve, the two Jev requests, a real Playwright fill over a dedicated Chrome CDP
profile with every set read back, and one of `ready_to_submit` / `needs_user` / `blocked` — for a
single posting (`--url`/`--tab`), a recorded fixture (`--schema --dry-run`), a whole pipeline
shortlist in one merged `needs_user` batch (`--queue N`), or a half-filled application
(`--resume <slug>`).

- `src/config.mjs` — constants (`JEV_MODEL`, `OPENAI_MODEL`), `CONFIG_DIR`/`paths`, `loadEnv()`,
  `slugify()`.
- `src/jev/client.mjs`, `src/jev/gates.mjs` — the Jev (TypeSafe System One) client: keep-alive
  transport, `choice`/`noul`/`score` builders, `withNone()`, answer validation, the 255-option /
  56k-token request splitter, and the only place confidence thresholds live.
- `src/schema/{greenhouse,ashby,classes,normalize}.mjs` — public job-schema fetchers, question
  classification (`identity`/`circumstance`/`essay`/`why_us`/`company_specific`/`policy_gate`/
  `sensitive`/`optional_text`), limit parsing, and `FormPlan` normalization; recorded fixtures in
  `eval/fixtures/`.
- `src/memory/*` — the private YAML store (`facts`, `preferences`, `documents`, `answers`,
  `stories`, `drafts`, `corrections`), atomic writes, scope resolution, and derivations
  (`workAuth`, `yearsSince`, `noticeRule`, `salaryFor`, `appliedBefore`).
- `src/writer/openai.mjs` — `extractResume`, `narrative`, `expand`, `whyUs`, plus the grounding and
  substitution post-checks.
- `src/discover/*`, `src/pipeline/*`, `scripts/scan.mjs`, `scripts/pipeline.mjs` — discovery
  providers (Greenhouse, Ashby, Lever, Workable, SmartRecruiters, Workday, HN Who's Hiring), the
  model-free filter chain, cross-run dedup, the Jev fit pass, and the pipeline store
  (`pipeline.yaml` + `scan-history.tsv`).
- `src/browser/*` — Chrome lifecycle over CDP (`chrome.mjs`: spawn-once, connect, disconnect-never-
  close), `readback.mjs` (never-option-0 option picking, set→read-back→retry), and the Greenhouse /
  Ashby field adapters (text, react-select, native select, radio, checkbox, phone, file upload) with
  a shared `trace.mjs`. Verified live against Together AI (Greenhouse) and Baseten (Ashby).
- `src/plan/{resolve,decisions,summary,trace}.mjs`, `src/jev/plan.mjs`, `scripts/apply.mjs` — the
  planner: deterministic resolve pass, the two Jev requests (canonical question, then option/
  boolean), gating into a `Decision` table, the `ready_to_submit`/`needs_user`/`blocked` contract,
  `--queue N` (parallel plan + fill, one merged `needs_user`), `--resume <slug>` (re-attach and
  list every unfilled field), `--answers` re-planning, and the ≤20-line summary.
- `src/canon/*`, `scripts/canon-scan.mjs`, `scripts/canon-cluster.mjs` — the corpus builder (400
  postings, 20 families, Greenhouse/Ashby/Lever) and the clustering pipeline that turns it into
  `canon/questions.yaml` (292 canonical questions, 8 layers), `canon/families/*.yaml`,
  `canon/vocab/*.yaml`, and `canon/templates/*.yaml`.
- `scripts/canon-eval.mjs` — hold-out coverage report (mapped/answerable % by layer, ATS, family).
- `scripts/answers.mjs` — pre-computed `answers.yaml` (constant/rule/policy/narrative rows) for a
  chosen family set, with a curation pass for narrative drafts.
- `scripts/learn.mjs`, `scripts/remember.mjs`, `scripts/install.mjs` — onboarding (résumé/link
  extraction, seed import, the day-1 gap list), corrections/promotions with inferred scope, and
  private-directory setup.
- `SKILL.md`, `INSTALL.md`, `README.md`, `references/*.md`, `eval/plan.test.mjs`, `LICENSE` — the
  published skill surface and its offline acceptance check.
