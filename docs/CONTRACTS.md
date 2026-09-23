# jev-apply — module contracts

Binding interfaces for parallel implementation. Each module is owned by one slice; other slices import by
this contract only. Node ≥ 20, ESM `.mjs`, no build step. Every script: one JSON object on stdout, logs on
stderr, exit 0 for all four statuses (`submitted` · `ready_to_submit` · `needs_user` · `blocked{reason}`),
exit 1 only for programmer errors. See `docs/PLAN.md` §2.2–2.7 for behaviour.

## Statuses
- `submitted` — `{status:"submitted", slug, confirmation:{detected:boolean, text?, url?, screenshot?},
  filled, usage}`; the pipeline entry for this posting is set to `applied`.
- `ready_to_submit` — nothing left to ask, and `p.auto_submit` is off/unset for this application.
- `needs_user` — `{questions:[{qid, label, options?, remember_as:{kind,id,scope}, why}]}`. A question the
  host agent has to *write* (no writer model configured) additionally carries
  `{kind:"draft", writes:"why_us"|"expand"|"narrative", prompt, grounding:string[], limits}`; its answer
  comes back through `--answers` as `{qid:{value:"<text>"}}`.
- `blocked{reason, detail?, screenshot?}` — includes `submit_failed` (Submit was clicked but no ATS
  confirmation was detected within `SUBMIT.timeout`; the tab is left open, untouched).

## src/config.mjs
```js
export const JEV_MODEL = "jev-1.13.0";
export const OPENAI_MODEL = "…";            // owner picks the current GPT-5.x id from skill://openai-llm
export const CONFIG_DIR;                     // ~/.config/jev-apply (override: JEV_APPLY_HOME)
export const paths = { env, configJson, memory, documents, applications, pipeline, profile, corpus? };
export function loadEnv();                   // reads CONFIG_DIR/env (KEY=VALUE), sets process.env when the
                                             // variable is unset (a present-but-empty one means "off this
                                             // run"), returns { TYPESAFE_API_KEY, OPENAI_API_KEY }; throws a
                                             // fail-fast Error naming the missing var + signup URL
export const REQUIRED_KEYS = ["TYPESAFE_API_KEY"];   // the only credential jev-apply needs
export const OPTIONAL_KEYS = ["OPENAI_API_KEY"];     // one of three ways to have a writer
export const WRITER_URL_VAR, WRITER_MODEL_VAR;       // JEV_APPLY_WRITER_URL / JEV_APPLY_WRITER_MODEL
export function writerFromEnv(env, { preferLocal }); // → {kind:"openai"|"local"|"host", model, baseURL}
export function slugify(s);                  // "acme-123" style
```

## src/jev/client.mjs
```js
export async function systemOne({ state, questions, model = JEV_MODEL, signal });
// → { answers: {[id]: Answer}, usage, ms, requests }
// - one keep-alive client (undici Agent or @typesafe-ai/sdk); retries 429/5xx (SDK policy)
// - validates every choice answer: choice ∈ criteria keys, probabilities keys == criteria keys,
//   |sum-1| ≤ 0.02, argmax == choice; invalid → throws JevValidationError({id, reason})
// - estimates tokens (chars/3.5 + 30/option) and splits `questions` into parallel requests under 56k,
//   sharing `state`; merges answers; `requests` = how many HTTP calls
// - 400/422 → JevBadRequest(detail); 401 → JevAuthError
export const choice = (instructions, criteria) => ({ type: "choice", instructions, criteria });
export const noul   = (instructions, criteria) => ({ type: "noul", instructions, ...(criteria && {criteria}) });
export const score  = (instructions, levels)   => ({ type: "score", instructions, criteria: levels });
export const NONE = "none_of_these";
```

## src/jev/gates.mjs (the only place thresholds live)
```js
export const GATES = { askBelow: 0.5, checkGap: 0.15, noulSelect: 0.5 };
export const LEVEL_YEARS = { early: 1, senior: 3 };         // salary-table level cutoffs, in full-time
                                                            // years; a table's `rule.levels` overrides
export function gate({ choice, confidence, probabilities }) // → "fill" | "check" | "ask"
export function runnerUpGap(probabilities, picked)          // → top − best alternative, or undefined
```

## src/schema/*.mjs → FormPlan (PLAN §2.3)
```js
export function detectAts(url);              // → { ats:"greenhouse", token, id } | { ats:"ashby", org, id } | null
export async function fetchGreenhouse({ token, id });   // raw JSON of ?questions=true&pay_transparency=true
export async function fetchAshby({ org, id });          // raw JSON via non-user-graphql (document in eval/fixtures/ashby-query.graphql)
export function normalize(raw, ats, url);    // → FormPlan { ats, url, job:{title,company,description,location,payRange?}, questions:[…] }
// FormPlan.question: { qid, label, help?, required, section?, type, control, selector, options?, limits?, class, dependency? }
// type    ∈ text|textarea|file|single_select|multi_select|boolean|number|date|phone|url
// control ∈ text|textarea|react_select|native_select|radio|checkbox|tel|file|date
// class   ∈ identity|circumstance|essay|why_us|company_specific|policy_gate|sensitive|optional_text
export async function loadFormPlan(urlOrFile);          // url → fetch+normalize; .json file → normalize recorded raw
export async function recordSchema(url, dir="eval/fixtures"); // saves raw JSON as <ats>-<board>-<short id>.json
// (the board slug is in the name because an Ashby response names no org) with `_source_url` written
// beside the response; `loadFormPlan` prefers it over rebuilding the URL from the filename. → path
```
`src/schema/classes.mjs` exports `classify(label, help, type, required)` and `parseLimits(label, help, maxlength)`,
with the regex lists for `policy_gate` (AI-usage/attestation/arbitration/consent) and `sensitive` (EEO).
Restrictive-agreements-style questions keep their existing `circumstance`/`core` class — they are not
`policy_gate` — because `src/plan/resolve.mjs` resolves them from `p.legal.restrictive_agreements`
instead of always asking.

## src/memory/*.mjs (private store at CONFIG_DIR/memory, YAML per section, atomic writes)
```js
export async function loadMemory();          // → { facts, preferences, documents, answers, stories, drafts, corrections }
export async function saveSection(name, rows);
export function getFact(mem, id);            // → the whole fact row {id, value, since?, source, updated} | undefined
export function resolvePreference(mem, id, { company, role_family });
// recognized preference ids include p.auto_submit (boolean), p.eeo (object; canon/vocab-valued),
// p.legal.restrictive_agreements and p.legal.previously_employed ("Yes"|"No", user-stated only, never
// code-defaulted); shapes: references/memory-format.md (owned by the Eeo slice).
// derive.mjs
export function yearsSince(mem, factId, now);
export function workAuth(mem, countryCode);  // → {authorized_now, needs_sponsorship_future, country, exact, fact, …}
                                             // exact:false = answered from f.work_auth.default → row is `check`
export function experienceLevel(mem, now, baselines);  // salary level; cutoffs = baselines.rule.levels ?? LEVEL_YEARS
export function noticeRule(mem, ctx);  export function salaryFor(mem, job, baselines);  export function appliedBefore(pipeline, company);
```
Seed import: `scripts/learn.mjs --seed private/profile/memory-seed` copies the seed into CONFIG_DIR/memory
(facts, preferences, documents, stories ← blobs.yaml; `use: never` entries are kept but flagged).

## src/writer/backend.mjs (which model writes, and whether there is one)
```js
export function detectWriter({ refresh });   // → {kind:"openai"|"local"|"host", model, baseURL}; memoised.
// OPENAI_API_KEY → openai · JEV_APPLY_WRITER_URL (+ _MODEL) → local · neither → host.
// A writer URL set in the process environment (not the env file) wins over a stored key.
export function describeWriter(cfg);         // one printable line; never key material
export async function complete({ system, input, schema, name, model, effort, maxTokens, signal });
// → the parsed JSON object. openai: Responses API, strict json_schema. local: chat completions at
//   baseURL with the schema stated in the prompt (json_object when the server takes it) and one
//   re-ask on a reply that is not JSON. host: throws HostWriterRequired.
export class WriterError extends Error {}
export class HostWriterRequired extends WriterError {}   // `what` = which answer needed writing
export function usageTotals();               // {calls, input_tokens, output_tokens, by_model}
export function resetUsage(); export function resetWriter();
// Local calls are counted under the by_model key "local", which PRICING.openai rates at $0.
```

## src/writer/openai.mjs (the prompts, the post-checks — any backend)
```js
export async function extractResume({ text });                 // → { facts:[…], stories:[…] } with page provenance
export async function narrative({ prompt, facts, stories, family, limits, avoid }); // → { short, medium, long }
export async function expand({ story, question, limits, job, avoid });
export async function whyUs({ sentence, stories, job, limits, facts, avoid }); // sentence optional: without one the
//   thesis comes from the JOB block + the grounding (p.auto_draft); throws when both are empty
//   `avoid`: titles of anecdotes another answer on this same application already told. Rendered by
//   `prompts.avoidBlock()`; empty on every row the planner could ground in unused material.
export function groundingCheck(text, groundingTexts);          // numbers/org names must appear in grounding
export function substitutionCheck(text, otherCompanies);       // no other company's name
export { WriterError, HostWriterRequired, usageTotals, resetUsage };  // re-exported from backend.mjs
```

## src/writer/extract-basic.mjs (résumé onboarding with no model at all)
```js
export function extractBasic(text, { doc, pages });  // → { facts:[{id,value,source}],
//   stories:[{id,title,text,tags,source}] } — `extractResume`'s row shapes, ids and provenance.
// Deterministic: name from the top line, email/phone/link/location regexes, and one story per
// bullet line under a work/projects heading (title = the question that bullet answers). Nothing
// is inferred: a value it is not sure of is not emitted, and the user is asked for it later.
// `scripts/learn.mjs` uses it instead of `extractResume` when `detectWriter().kind === "host"`.
```

## src/plan/draft.mjs (PLAN §2.2 step 10 — the writer, as the runner calls it)
```js
export async function draftRows({ formPlan, decisions, mem, context, pipeline, dry, signal, onLog });
// → the rows that now carry a draft. Mutates them: value/words/source:"writer"/why, `dry:true` in a
//   dry run. A row it cannot ground, or that will not fit the field's `limits`, becomes `ask` with
//   the reason — drafting never suspends "no personal fact is guessed".
export function draftFor({ plan, stores, dry, onLog });  // → { rows(decisions) } — runBrowser's `draft` hook
export function groundFrom(mem, ids, ctx);   // memory ids → { facts, stories } for the writer's prompts
export function rankStories(stories, job, limit);  // deterministic: shared distinctive vocabulary, never a model
export function motivationStories(pool);    // the `motivation`-tagged rows a why_us thesis is made of
export function chooseStories({ named, pool, job, kind, used, limit });
//   which stories one draft gets: why_us leads with a motivation row, the rest rank by overlap with
//   this posting's own text, and anything `used` (told by an earlier draft on the same page) is
//   skipped unless skipping it would leave the row with nothing. A written row records what it was
//   actually handed as `grounding_used` (`grounding_ids` stays the planner's offer).
export function otherCompanies(pipeline, company); // the names substitutionCheck must not find
export function hostDraftAsks(questions, decisions); // the `needs_user` items, with `kind:"draft"` +
//   prompt/grounding/limits on every row the host agent has to write (backend kind `host`)
export function hostDraft(d, { kind, prompt, grounding, limits }); // one row → that question
export function groundingTexts(grounding);   // the writer's grounding objects as plain lines
export function checkHostDraft(text, host, forbidden); // → the complaint, or null
export async function acceptHostDrafts({ decisions, answers, pipeline, company, dry, onLog, slug, jev, signal, gate });
//   → {answers, accepted, refused} — `answers` is what is left for `applyAnswers`. A host-written
//   draft passes the same limit/groundingCheck/substitutionCheck a model's draft does *and* the
//   same two Jev relevance gates (`gate`, defaulting to the real call), with both verdicts left on
//   `d.gates` (action stays `draft`, source `host`); a draft either check refuses — or one whose
//   gate cannot be reached — stays `ask` with the reason, at fill time rather than at the click.
```

## src/browser/*.mjs (Playwright library over CDP; PLAN D12)
```js
export async function connect({ profileDir = paths.profile, port = 9223 }); // spawns Chrome if needed, connectOverCDP → { browser, context }
export async function openTab(context, url);   export async function findTab(context, urlPrefix);
export async function disconnect(browser);    // never closes Chrome
// adapters/index.mjs — the dispatcher. `detectControl` names the widget; an ATS adapter gets it only
//   when its `HANDLES` claims that kind, and a question the ATS types `date` always goes to the
//   shared ladder (no adapter tunes a date, and only `setDate` refuses prose).
// controls.mjs — `classifyShape` reads a checkbox *group* from either witness (n boxes in the field,
//   or two or more published options) and a date control from a date-named class; `isCheckboxGroup`
//   re-asks both before `setControl` reaches for the Boolean rung.
// adapters/greenhouse.mjs, adapters/ashby.mjs, adapters/generic.mjs
export async function setField(page, question, value, { trace }); // → { ok, observed, attempts, strategy? }
export async function uploadFile(page, question, filePath, { trace });
export async function snapshotRequired(page);  // → [{qid?, selector, label, filled:boolean}]
export async function eeoControls(page);       // greenhouse + ashby: the demographic block as rendered,
//   → [{qid, label, section, selector, multiple, control, value}] — opens no menu, writes nothing
export async function findSubmit(page);        // → {selector, text, strategy} | null — read-only, no click
export async function confirmSubmitted(page, { timeout, url0 }); // → {detected:boolean, text?, url?, strategy?, reason?}
export const CONFIRMATION = { url?: RegExp, text: RegExp, selectors: string[], toast?: string }; // printable strategy
// trace.mjs — the only appender. `trace` is a slug, a function sink, or `{slug, mask}`.
// appendTrace(slug, event) → applications/<slug>/trace.jsonl (0600 in a 0700 dir)
// fieldEvent({op, question, value, result}) → the row; `class:"sensitive"` redacts observed *and* value_len
// captureFailure(page, trace, question) → shots/<qid>-<ts>.png | null; never shoots a sensitive row and
//   masks every sensitive control in `mask` (a FormPlan | its questions[] | selector strings) before the shutter
```

## src/discover/providers/<name>.mjs
```js
export const id = "greenhouse";
export function detect(url);                 // → boolean
export async function fetch(entry, ctx);     // entry from companies.yml → Job[]
// providers/index.mjs — registry, loads every sibling module (no list to maintain)
export async function providers();           // → Promise<Array<{id, detect, fetch}>>
export async function providerFor(entry);    // {provider} | url | {url} → module | null
```
`src/discover/detect.mjs`: `await resolveCompany({ name, careers_url })` → provider + identifier or `unknown`.

## src/pipeline/store.mjs (CONFIG_DIR/pipeline/pipeline.yaml + scan-history.tsv)
```js
export async function loadPipeline(); export async function upsertJobs(jobs); export async function setStatus(id, status, note);
export async function queue(ids); export async function nextQueued(n); export function render(pipeline); // → pipeline.md text
// status ∈ found|queued|ready|applied|interview|offer|rejected|withdrawn|expired
// found → applied is not a legal transition; a confirmed submit for a posting the user never queued
// is stepped found → ready → applied. Pipeline write errors are logged, never fatal to a confirmed submit.
```

## src/plan/execute.mjs (submit step; PLAN §2.2 steps 8½ and 12)
```js
export const SUBMIT = { timeout: 45000, captchaWaitMs: 5000 };
export function submitReady({ decisions, state });         // → boolean: zero `ask` rows AND zero required-empty controls
export async function detectSubmit({ context, formPlan }); // read-only: attaches the tab, returns {selector, text, confirmation} — no click (`--dry-run --detect-submit`)
export const boardAdapter = (ats) => adapter;               // never throws; falls back to the generic adapter for an unrecognized page
export function matchLiveControls(live, { questions, decisions }); // → {retry, novel} — pairs live-DOM EEO controls with plan Decisions
export function rowOrder(questions);      // qid → fill rank; a `mounts_after` row is driven after the row it mounts under (B8)
export function deferredMount(question, result); // control_not_found on a `mounts_after` row = not on the page yet, never a failed write
export function observedMatches(observed, wanted); // the verdict a `sensitive` read-back records instead of the value (B3)
export function restoreRetried(d);        // a row the retry committed never keeps the first attempt's failure `why` (A11)
export async function submitObstruction({ page, ats, formPlan }); // → {selector, label, overlaps:[{tag,name}]} | null — geometry only (B12)
export const runnable = (d) => boolean;   // fill/check, or a `draft` that already carries text; not yet read back ok
export async function runBrowser({ context, formPlan, decisions, slug, budget, replan, draft, attach, rows });
// `draft` is `{ rows(decisions) }` (src/plan/draft.mjs `draftFor`) — step 10, called before the fill
// loop and again for anything a delta round discovers. A retried demographic row that commits gets
// its pre-failure `why` restored, so the summary never reports a refusal the read-back contradicts.
export async function submitApplication({ page, ats, formPlan, decisions, slug, timeout });
// → { ok, clicked:boolean, selector, confirmation:{detected, text?, url?, screenshot?, strategy}, reason?, shot? }
// writes a {op:"submit", stage:"attempt", …} trace row BEFORE the click
export function submitOutcome(result);
// → { status:"submitted", confirmation } | { status:"blocked", reason:"submit_failed", screenshot? }
export async function priorSubmit(slug, frozen = null); // → {attempted:boolean, confirmed:boolean, sources:string[]}
```
`p.auto_submit` is resolved by the caller via the existing `resolvePreference(mem, "p.auto_submit",
{company, role_family})` — no dedicated resolver function.

## Decision record and files (PLAN §2.3)
`applications/<slug>/{decisions.json, trace.jsonl, summary.md}`; `answers.json` (host → runner) `{ "<qid>": { value, remember_as:{kind,id,scope} } }`.
`decisions.json`'s meta carries `submitted:boolean` and `submit_attempted:boolean`, written by `settle()`
*after* the confirmation wait — a process killed mid-wait leaves no record there even if the click
already posted. `priorSubmit` is the double-submit guard's reader and consults both sources: the
pre-click `{op:"submit", stage:"attempt"}` row `trace.jsonl` carries across every run (append-only), and
`decisions.json`'s flags. `scripts/apply.mjs` refuses to click when `attempted` is true from either
source — a click that landed but whose confirmation was missed must never be repeated. `submit_not_found`
(the button itself was never located) writes neither marker, so it is the one submit failure that stays
retryable.

`Decision.action` includes `"draft"`: the writer owns that row (PLAN §2.2 step 10). A `draft` row
that has text is typed into the control and read back like any other value, it stays a `draft` so the
summary lists it under ► DRAFTED, and it never blocks Submit. The deterministic pass attaches
`draft_request {kind:"why_us"|"expand"|"narrative", limits:{words?,chars?}|null, grounding_ids:string[],
prompt:string, help:string}` — public, frozen into `decisions.json` — and `finalize(decisions, {mem,
context})` is what turns a why-us/essay `ask` into one when `p.auto_draft` resolves true.

`grounding_ids` is what the planner *offered*; `src/plan/draft.mjs` then ranks it against this
posting and drops anything an earlier draft on the same page already told, and a row that ends up
with text records the set it was actually handed as `grounding_used:string[]`. Both are frozen, and
the pair is the only way to see from the JSON whether two answers on one application — or three
applications to three companies — are telling the same story (round-2 judge §3 N4).

Every frozen row carries `required:boolean` from the form's own schema (`withFormFacts`), so
"required and empty" is countable off `decisions.json` without a browser (B2), and a `sensitive`
row's `readback` carries `observed_matches:boolean` in place of the value it must not record (B3).
`decisions.json`'s meta carries `form`, the fingerprint of the form the rows were filled against
(`formFingerprint`); `refillGuard({frozen, formPlan, refill})` reads it before a `--url` run
re-fills, and refuses when the shape changed under a fill that was already read back — `--refill`
is the only thing that overrules it (B1).

## CLI surface
- `apply.mjs --url U | --tab | --queue N | --schema F` · `--answers F` · `--resume SLUG` · `--dry-run` ·
  `--record-schema` · `--strict` · `--submit` (force Submit this run) · `--no-submit` (force stop at
  `ready_to_submit`) · `--detect-submit` (dry check: prints the Submit selector + confirmation strategy,
  no click) · `--refill` (re-fill a posting whose form changed under a reviewed fill; `refillGuard` refuses without it)
- `learn.mjs --resume a.pdf [--resume b.pdf] --links … | --seed DIR | --answers F`; `remember.mjs "<instruction>" [--scope …]`
- `scan.mjs [--companies F]`; `pipeline.mjs list|queue <ids>|mark <id> <status>|prune|render`
- `canon-scan.mjs [--families a,b] [--per-family 20]`; `canon-cluster.mjs`; `canon-eval.mjs`; `answers.mjs --families a,b`
- `jev-smoke.mjs`; `install.mjs`

## Rules for every slice
Never print key material. Never write user data under the repo (only `private/` and CONFIG_DIR). Run only
your named check. Report deviations from these contracts explicitly.
