# jev-apply — module contracts

Binding interfaces for parallel implementation. Each module is owned by one slice; other slices import by
this contract only. Node ≥ 20, ESM `.mjs`, no build step. Every script: one JSON object on stdout, logs on
stderr, exit 0 for all three statuses (`ready_to_submit` · `needs_user` · `blocked{reason}`), exit 1 only
for programmer errors. See `docs/PLAN.md` §2.2–2.7 for behaviour.

## src/config.mjs
```js
export const JEV_MODEL = "jev-1.13.0";
export const OPENAI_MODEL = "…";            // owner picks the current GPT-5.x id from skill://openai-llm
export const CONFIG_DIR;                     // ~/.config/jev-apply (override: JEV_APPLY_HOME)
export const paths = { env, configJson, memory, documents, applications, pipeline, profile, corpus? };
export function loadEnv();                   // reads CONFIG_DIR/env (KEY=VALUE), sets process.env if unset,
                                             // returns { TYPESAFE_API_KEY, OPENAI_API_KEY }; throws a
                                             // fail-fast Error naming the missing var + signup URL
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

## src/memory/*.mjs (private store at CONFIG_DIR/memory, YAML per section, atomic writes)
```js
export async function loadMemory();          // → { facts, preferences, documents, answers, stories, drafts, corrections }
export async function saveSection(name, rows);
export function getFact(mem, id);            // → the whole fact row {id, value, since?, source, updated} | undefined
export function resolvePreference(mem, id, { company, role_family });
// derive.mjs
export function yearsSince(mem, factId, now);
export function workAuth(mem, countryCode);  // → {authorized_now, needs_sponsorship_future, country, exact, fact, …}
                                             // exact:false = answered from f.work_auth.default → row is `check`
export function experienceLevel(mem, now, baselines);  // salary level; cutoffs = baselines.rule.levels ?? LEVEL_YEARS
export function noticeRule(mem, ctx);  export function salaryFor(mem, job, baselines);  export function appliedBefore(pipeline, company);
```
Seed import: `scripts/learn.mjs --seed private/profile/memory-seed` copies the seed into CONFIG_DIR/memory
(facts, preferences, documents, stories ← blobs.yaml; `use: never` entries are kept but flagged).

## src/writer/openai.mjs (OpenAI Responses API)
```js
export async function extractResume({ text });                 // → { facts:[…], stories:[…] } with page provenance
export async function narrative({ prompt, facts, stories, family, limits }); // → { short, medium, long }
export async function expand({ story, question, limits, job });
export async function whyUs({ sentence, stories, job });
export function groundingCheck(text, groundingTexts);          // numbers/org names must appear in grounding
export function substitutionCheck(text, otherCompanies);       // no other company's name
```

## src/browser/*.mjs (Playwright library over CDP; PLAN D12)
```js
export async function connect({ profileDir = paths.profile, port = 9223 }); // spawns Chrome if needed, connectOverCDP → { browser, context }
export async function openTab(context, url);   export async function findTab(context, urlPrefix);
export async function disconnect(browser);    // never closes Chrome
// adapters/greenhouse.mjs, adapters/ashby.mjs
export async function setField(page, question, value, { trace }); // → { ok, observed, attempts }
export async function uploadFile(page, question, filePath, { trace });
export async function snapshotRequired(page);  // → [{qid?, selector, label, filled:boolean}]
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
```

## Decision record and files (PLAN §2.3)
`applications/<slug>/{decisions.json, trace.jsonl, summary.md}`; `answers.json` (host → runner) `{ "<qid>": { value, remember_as:{kind,id,scope} } }`.

## CLI surface
- `apply.mjs --url U | --tab | --queue N | --schema F` · `--answers F` · `--resume SLUG` · `--dry-run` · `--record-schema` · `--strict`
- `learn.mjs --resume a.pdf [--resume b.pdf] --links … | --seed DIR`; `remember.mjs "<instruction>" [--scope …]`
- `scan.mjs [--companies F]`; `pipeline.mjs list|queue <ids>|mark <id> <status>|prune|render`
- `canon-scan.mjs [--families a,b] [--per-family 20]`; `canon-cluster.mjs`; `canon-eval.mjs`; `answers.mjs --families a,b`
- `jev-smoke.mjs`; `install.mjs`

## Rules for every slice
Only `ScaffoldJev` runs `npm install`; others wait for `node_modules/` (poll ≤5 min) or message it on `hub`.
Never print key material. Never write user data under the repo (only `private/` and CONFIG_DIR). Run only
your named check. Report deviations from these contracts explicitly.
