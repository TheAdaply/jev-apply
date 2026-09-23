# The understanding pipeline — spec

How `jev-apply` decides what a form question means and what answers it, written so a builder can
implement it without re-deriving it. Rationale and evidence: `docs/research/18-core-analysis.md`.

**The rule.** Every step that decides *meaning* is judged by a model with an explicit
`none_of_these`. Code does mechanics only: fetching, normalising, pre-filtering candidates, driving
widgets, reading back, counting, gating. A regex may **narrow a candidate list**; it may never
decide what a question asks for, which item answers it, or whether an answer is right.

## 1 · Modules

| module | owns | export |
|---|---|---|
| `src/understand/prefilter.mjs` | recall-preserving lexical candidate narrowing | `canonCandidatesFor`, `qualifiersIn`, `parentCandidates`, `itemCandidates`, `rankItemCandidates` |
| `src/understand/questions.mjs` | understanding, country scope, document type | `understandForm({formPlan,canon,documents,slug,signal})` |
| `src/understand/select.mjs` | candidate selection and explicit-pair responsiveness | `selectAnswers({formPlan,understanding,mem,itemsByQuestion,canon,slug,signal})` |
| `src/understand/options.mjs` | exact-label equality, then model option mapping | `mapOptions({rows,slug,signal})` |
| `src/verify/filled.mjs` | post-readback semantic verification | `verifyFilled({pairs,slug,signal})`, `verifyDecisions` |

`src/jev/client.mjs` (`systemOne`, `choice`, `noul`, `withNone`, `NONE`, `MAX_CHOICES`) is
unchanged; `src/jev/gates.mjs` gains only §3's three thresholds.

```ts
type Understanding = {
  asks_for: string;                 // a canonical qid, or "new_question", or NONE
  answer_kind: "fact"|"preference"|"policy"|"narrative"|"company"|"document"|"never"|NONE;
  about: "candidate"|"third_party"|"company"|NONE;   conditional_on: string|null;
  qualifiers: string[];             // the qualifiers the model confirmed are part of the question
  attestation: boolean; sensitive: boolean;
  format: "date"|"number"|"url"|"phone"|"free"|"option";
  country_scope: "current"|"posting"|"explicit"|"irrelevant"|NONE;
  explicit_country: string|null;
  question_country?: {country:string|null; source:string|null};
  document_kind?: string;           // resume, cover_letter, or a saved document kind
  scores: Record<string, number> }; // every confidence/noul, frozen for audit
type Selection  = { item: string|null; answers: number; action: "fill"|"check"|"ask"; why: string };
type OptionPick = { option: string|null; faithful: number; action: "fill"|"check"|"ask" };
type Verdict    = { noul: number|null; ok: boolean };
```

## 2 · The four stages (independent question shapes)

Built with `choice`/`noul`/`withNone`/`NONE`; every answer passes `validateAnswer` inside
`systemOne`. `question_123` stands for any qid.

### (a) Question understanding — token-budgeted request batches

```jsonc
{ "state": {
    "job": { "title": "…", "company": "…", "location": "…" },
    "questions": { "question_123": { "label": "…", "help": "…", "type": "single_select",
                                     "required": true, "section": "…", "options": ["…"] } } },
  "questions": {
    "asks_123": { "type": "choice", "instructions": "What does `questions.question_123` ask the applicant for?",
      "criteria": { "q.core.current_title": "The applicant's current or most recent job title", "new_question": "A real question about the applicant that none of these cover", "none_of_these": "Not a question to the applicant at all" } },
    "kind_123": { "type": "choice", "instructions": "What kind of answer does `questions.question_123` want?",
      "criteria": { "fact": "A datum about the applicant they state", "preference": "A standing stance or willingness", "policy": "An acknowledgement or consent the applicant signs", "narrative": "Prose about the applicant's work", "company": "Something about this employer", "document": "A résumé, cover letter or uploaded file", "never": "Something only the applicant may answer in person", "none_of_these": "None of these kinds" } },
    "about_123": { "type": "choice", "instructions": "Whose circumstances does `questions.question_123` ask about?",
      "criteria": { "candidate": "The applicant themselves", "third_party": "Another named organisation or person, not this employer", "company": "This employer, the posting, or the form itself", "none_of_these": "Cannot be told from the wording" } },
    "parent_123": { "type": "choice", "instructions": "Is `questions.question_123` only asked once another question on this form is answered a particular way? Pick that question.",
      "criteria": { "question_122": "…that question's label…", "none": "It stands on its own", "none_of_these": "It depends on something not on this form" } },
    "qual_123_llm": { "type": "noul", "instructions": "Does `questions.question_123` narrow itself to work involving LLMs, so that an answer about anything else would not answer it?",
      "criteria": { "true": "The qualifier is part of what is asked", "false": "It is not" } },
    "sign_123": { "type": "noul", "instructions": "Is `questions.question_123` asking the applicant to sign, consent to, or acknowledge a statement?",
      "criteria": { "true": "It is an attestation", "false": "It is a question about the applicant" } },
    "sens_123": { "type": "noul", "instructions": "Does `questions.question_123` ask the applicant to state a legally protected characteristic about themselves?",
      "criteria": { "true": "It asks for one", "false": "It only mentions or defers one" } },
    "fmt_123": { "type": "choice", "instructions": "What shape of value does `questions.question_123` accept?",
      "criteria": { "date": "A calendar date", "number": "A number", "url": "A web address", "phone": "A telephone number", "free": "Free text", "option": "One or more of the listed options", "none_of_these": "None of these shapes" } } } }
```

Response per id: `{type:"choice", choice, confidence, probabilities}` or `{type:"noul", noul}`.
`qualifiers[]` keeps every `qual_*` at or above `GATES.noulSelect`; one `qual_*` per qualifier
`qualifiersIn(q)` detects — usually 0, capped at 3.

Every row also gets a country-scope Choice (`current`, `posting`, `explicit`, `irrelevant`, NONE).
Country extraction only proposes a place; the model decides which scope the question means.
File rows get a document-type Choice over résumé, cover letter, saved document kinds, and NONE.
Known live options anchor `format:"option"`. Bare Location means present residence, not preferred
work location; compound alternative-link or demographic questions may use `new_question`.
Parent judgments require an explicit condition, not adjacency or a nearby consent.
An independent `input_*` Noul confirms whether the row is an actual applicant-answerable field.
When canonical matching is absent or below its gate but this Noul passes `answersGate`, route to
`new_question` (recording the original canonical confidence and gate), rather than claiming a
canonical meaning. All kind, party, source, selection, option and verification gates still apply.
Canonical recall weights the field label above long boilerplate help.

### (b) Answer selection — Choice, then explicit-pair responsiveness

```jsonc
{ "state": {
    "rows": { "question_123": {
      "question": { "label": "…", "help": "…", "options": ["…"], "understood": {} },
      "items": { "q.core.start_date": { "id": "q.core.start_date", "summary": "…",
        "answers_questions": ["…"], "text": "…", "provenance": {} } } },
    "items": { "m.item.7": { "id": "m.item.7", "summary": "…",
      "answers_questions": ["…"], "text": "…", "provenance": {} } },
    "pairs": { "question_123_0": {
      "question": { "label": "…", "help": "…", "options": ["…"], "understood": {} },
      "item": { "id": "m.item.7", "summary": "…", "answers_questions": ["…"],
        "text": "…at most 600 characters…", "provenance": {} } } } },
  "questions": {
    "pick_question_123": { "type": "choice", "instructions": "Which saved item answers rows.question_123.question?",
      "criteria": { "m.item.7": "…meaningful saved question metadata…",
        "none_of_these": "No saved item answers this; ask the applicant" } },
    "does_question_123_0": { "type": "noul",
      "instructions": "Does pairs.question_123_0.item state the information pairs.question_123_0.question asks for, about the candidate?",
      "criteria": { "true": "The explicit item answers this exact question",
        "false": "none_of_these: unsupported, unrelated, or missing a qualifier" } } } }
```

For pools of at most three candidates, speculate all candidate-pair Nouls in the Choice request,
then use only the chosen candidate's result. Larger pools send the selected item in a second
batched responsiveness request. Never reference another same-batch answer: Jev questions are
isolated. Third-party metadata checks bind the same explicit item. Conditional activation binds
the actual selected parent item and parent question in the second request.

Row-local items override shared items for country-dependent rules. Structured values are text
before selection. Canonical derived values are recomputed from authoritative facts/preferences,
including current location and latest employer/school; stale copied constants are not evidence.
Narrative pools include facts, preferences, answers and stories. Kind filtering and lexical ranking
retain metadata overlap with the understood canonical question; ranking proposes twelve items
plus every such overlap and widens to the full pool when no words overlap. No topic-group Choice
can veto a source. Selection still requires both Choice and responsiveness gates.
Identical canonical copies of a stated fact share one candidate, with every copied id retained
in provenance. Identical HTTP(S) URLs also merge their question metadata. Derived copies are
coalesced only after recomputation; distinct answers and demographic/legal preferences stay
separate. This avoids splitting Choice confidence among copies of the same answer.

### (c) Option mapping — live-label equality, otherwise Choice and explicit fidelity

```jsonc
{ "state": { "rows": { "question_123_0": {
    "question": { "label": "…", "options": ["…"] }, "answer_text": "…",
    "question_country": { "country": "IE", "source": "current" }, "provenance": {},
    "option": { "id": "o0", "label": "…the explicit option being judged…" } } } },
  "questions": {
    "faith_question_123_0": { "type": "noul",
      "instructions": "Does rows.question_123_0.option faithfully state its answer_text for its question and question_country?",
      "criteria": { "true": "Same supported answer", "false": "none_of_these: changes or invents information" } } } }
```

A unique normalized option-label equality resolves mechanically, including sensitive answers.
Otherwise single-select sends a Choice over live options plus NONE. Pools of at most twelve
speculate explicit option-fidelity Nouls; larger lists judge the selected option in a second
request. Multi-select judges each named option directly. Question-country and derivation
provenance travel with the answer: a posting-country rule cannot support a current-country visa
claim. Sensitive answer text is redacted in traces only, including speculative pair copies.

### (d) Post-fill semantic verification — one request per form, after DOM read-back

```jsonc
{ "state": { "rows": { "question_123": { "question": { "label": "…", "help": "…" },
      "filled_value": "…DOM readback…", "candidate": { "text": "…", "answers_questions": ["…"] },
      "resolved_value": "2026-09-24", "reference_date": "2026-09-24",
      "derivation": { "premise": "Immediately", "rule": { "kind": "immediate", "days": 0 },
        "reference_date": "2026-09-24", "resolved_value": "2026-09-24", "source": "p.notice_rule" } } } },
  "questions": { "ver_123": { "type": "noul", "instructions": "Does `rows.question_123.filled_value` answer `rows.question_123.question` correctly for this applicant, as the question is asked?",
      "criteria": { "true": "It answers the question", "false": "It does not answer the question as asked" } } } }
```

`noul < GATES.verifyBelow` ⇒ clear the control, `action:"ask"`, `why:"the value on the page does
not answer this question"`; the run cannot reach `ready_to_submit`. Sensitive rows are exempt and
never send a value — their correctness stays `p.eeo` plus `sensitive_readback` (`preflight.mjs`).

## 3 · Gates

`src/jev/gates.mjs` gains three thresholds and stays the only place any threshold lives:

```js
export const GATES = { askBelow: 0.5, checkGap: 0.15, noulSelect: 0.5,
                       answersGate: 0.6, faithfulGate: 0.6, verifyBelow: 0.5 };
```

Per row, in order — each may only downgrade (`fill` → `check` → `ask`); nothing upgrades:

1. A missing/uncertain canonical match routes to `new_question` only when the independent `input_*` judgment passes; otherwise `ask`.
2. `about == "third_party"` ⇒ `ask` unless an item's `answers_questions[]` names that party (B4/F1).
3. `attestation` ⇒ answerable from an explicit `p.legal.<slug>` alone, else `ask` (`AGENTS.md`).
4. `sensitive` ⇒ answerable from `p.eeo` or the user alone, else `ask` (`AGENTS.md`).
5. `conditional_on != null` and the parent is not answered the way the child needs ⇒ blank.
6. `pick == NONE` or `does < answersGate` ⇒ `ask`; `does < answersGate + checkGap` ⇒ `check`.
7. `opt == NONE` or `faith < faithfulGate` ⇒ `ask`; thin margin ⇒ `check`.
8. read-back not confirmed ⇒ `ask` (unchanged).  9. `ver < verifyBelow` ⇒ revert to `ask`.

## 4 · Budget — at most six measured requests per acceptance posting

The former four-total-request promise depended on unresolved same-batch references and was
incorrect. Understanding is followed by selection (one or two calls), option mapping (zero, one
or two calls), and one post-readback verification call. Small pools use speculative explicit
pairs; equality-only options cost zero calls. The acceptance checks count actual HTTP requests,
including token-estimator splits, and require no more than six on Notion and Luma.

`estimateQuestionTokens` bills `30 × optionCount` plus serialized text against
`MAX_REQUEST_TOKENS = 56_000`; large schemas may split understanding. `MAX_CHOICES = 255`:
canonical candidates ≤16 plus two exits, preceding parents ≤8 plus two exits, saved candidates
≤254 plus NONE, live options ≤254 plus NONE. A saved pool beyond this bound asks rather than
silently omitting evidence. An option list beyond the bound forces a check unless exact equality
already identified a unique supported live label. No first-option fallback is permitted.

`understand/request.mjs` packs questions with only their referenced rows, pairs and candidate
items. Each HTTP payload shares that projected state once; unrelated rows are never copied into
every split. Packing targets 44,800 estimated tokens (headroom below the client's 56k limit).
An oversized single selection row uses candidate summaries of at most 240 characters without
dropping candidate ids or criteria. Responsiveness still receives the selected item's evidence.
If the server rejects the estimate, the wrapper halves the questions and their state; a single
question can compact its candidate text once, but cannot retry an unchanged oversized payload.
Traces record each actual batch and preserve sensitive redaction. Large forms may require more
than the six calls of the two acceptance postings; counters include rejected attempts.

## 5 · Memory

Every `facts` / `preferences` / `answers` / `stories` row gains two fields:

```yaml
- id: f.employment.<slug>          # an address for code; never matched against a label
  value: "…"
  answers_questions:               # what this row answers, in question form
    - "What is your current job title?"
    - "Where have you most recently worked?"
  topics: [inference, gpu]         # free-form labels, not a fixed vocabulary
```

`answers_questions[]` is what (b) puts in the criteria, so selection is over **meaning**, never
over an id or a label regex. `topics[]` feeds the pre-filter and never decides responsiveness — the
`does_*` noul does. `scripts/learn.mjs` writes both on every row it extracts; `scripts/remember.mjs`
writes both for a user-stated row while keeping its `ID_CATALOGUE` choice for the *id*. A row with
no `answers_questions[]` falls back to `[id-words, value-as-text]`; `learn.mjs --backfill` fills it.

`p.eeo` is projected into individual `p.eeo.<field>` views, not offered as an opaque bundle.
Each retains the preference's provenance and field-specific questions. A scoped individual
preference overrides its bundled field. `other_demographics` covers the explicitly saved
stance for demographic questions outside the standard fields; `ask` is not an answer,
and missing demographics are never inferred. Stored enum tokens are rendered as readable text.
Documents resolve mechanically from `documents[]` only after document understanding passes,
using saved role-family/default preference selection and an on-disk existence check.

## 6 · Novel-page protocol

- **Unknown widget** — `detectControl` → `setControl`'s ladder → `setUnknown` → `ask` with a
  screenshot (`src/browser/controls.mjs`, already correct). Never a guess, never a first option.
- **Unknown question** — `asks_for:"new_question"` is not a failure: (b) still runs over the whole
  kind-filtered pool, `ask` is the answer when nothing answers it, and the row carries a
  `remember_as` so one answer closes it on every future board.
- **Unknown option vocabulary** — (c) decides; the vocabulary table may only propose.
- **No regex-only decision about meaning, anywhere.** A pre-filter whose candidate list comes back
  empty must widen to the full list; it may never conclude `ask` on its own.

## 7 · What to delete

| delete / demote | from | becomes |
|---|---|---|
| `classify()`'s class decision, `SENSITIVE_RE`, `POLICY_GATE_RE`, `DEFERS_SENSITIVE_RE`, `REDACTION_OFFER_RE`, `ACCOMMODATION_RE`, `ESSENTIAL_FUNCTIONS_RE`, `FACT_SEEKING_RE`, `IDENTITY_RE`, `WHY_US_RE`, `CIRCUMSTANCE_RE` | `src/schema/classes.mjs` | pre-filters in `understand/prefilter.mjs`; `classify()` keeps only control/type mechanics and returns a **hint** |
| `DEPENDENCY_RE`, `dependencyOn()` | `src/schema/classes.mjs` | `parentCandidates()` |
| `NAME_RULES`, `LINK_RULES`, `MULTI_LINK_RE`, `LOCATION_RE`, `ADDRESS_RE`, `CURRENT_COMPANY_RE`, `CURRENT_TITLE_RE`, `MOST_RECENT_RE`/`acceptsMostRecent`, `CONFIRM_LEAD_RE`, `SELF_ID_RE`, `AUTHORIZED_RE`, `SPONSOR_RE`, `US_PERSON_RE`, `ATTESTS_RE`, `RELOCATE_RE`, `IN_OFFICE_RE`, `OFFICE_LOCATION_RE`, `START_RE`, `SALARY_RE`, `APPLIED_BEFORE_RE`, `HOW_HEARD_RE`, `RESTRICTIVE_RE`, `PREVIOUSLY_EMPLOYED_RE`, `FIRST_PERSON_EMPLOYER_RE`/`asksAboutThisEmployer`, `POLICY_SLUGS`/`policySlug()` | `src/plan/resolve.mjs` | **gone** — replaced by `answers_questions[]` on the rows plus `asks_for` / `about` / `attestation` |
| `TOPICS`, `topicsIn()`, `unmetTopics()` | `src/canon/normalize.mjs` | **gone** — replaced by `qual_*` and the `does_*` gate |
| `topicGap()`, `REPHRASABLE`, `secondPass()`'s three-way routing, `storyPool()`'s `onTopic()`/`poolFor()` | `src/jev/plan.mjs` | **gone** — candidate selection followed by explicit-pair responsiveness |
| `optionStating()`, `vocabFor()`, `ALIASES`, `TYPED_ALIASES` | `src/canon/normalize.mjs` | pre-filters that *propose* an option; (c) decides. Exact normalised label equality stays — mechanics |
| `groundingIds()` (`src/plan/decisions.mjs`), `rankStories()`/`chooseStories()` (`src/plan/draft.mjs`) | | grounding is what (b) selected, ranked by `does_*`, never by token overlap |
| `countryInQuestion()`/`COUNTRY_PLACES` as a decider | `src/schema/normalize.mjs` | pre-filter; `about`/`does_*` decide. Country → work-auth lookup stays |

`src/plan/resolve.mjs` keeps every **derivation** — `workAuth`, `salaryFor`, `noticeRule`,
`startDate`, `latestEmployment`, `latestEducation`, `fullTimeYears`, `relocationFor`,
`inOfficeFor`. They compute values once the model has said which fact the question wants; numbers
are code's job (`PLAN` §2.1).

## 8 · Original migration sequence (historical; current contracts are §§1–5)

1. `src/understand/prefilter.mjs` — move the regex lists out of `classes.mjs`/`resolve.mjs`
   unchanged, expose them as narrowers. No behaviour change; `eval/plan.test.mjs` stays green.
2. `src/understand/questions.mjs` + `--dry-run` over `eval/fixtures/*.json`. Check: one HTTP call
   per form, `asks_for != NONE` on ≥ 95 % of the rows `classify()` types today.
3. `src/understand/select.mjs` behind `--understand`; `resolveForm()` still runs, diff the two
   decision lists per fixture and review every divergence.
4. Memory fields: `scripts/learn.mjs --backfill`, then `scripts/remember.mjs` writes both.
5. Cut over `src/plan/resolve.mjs`: `resolveForm()` stops classifying and consumes `understanding`
   + `selection`; delete §7's label regexes. `src/jev/plan.mjs` collapses to `mapOptions`.
6. `src/verify/filled.mjs` into `src/plan/execute.mjs` after `verify()` and before
   `submitReadiness()`; `src/plan/preflight.mjs` gains a thirteenth rule `semantic_verify`, refusing
   any `ok:false` verdict and reporting `unchecked` — never passing — for one it could not reach.
7. Harness (§9), then re-run the ten-posting round and compare against `ten2`.

## 9 · Evaluation harness change

`src/bench/shots.mjs expectedRows()` and the judge template stop conflating two things:
`correct` (the form carries the right answer) · `wrong` (untrue, unfounded or non-responsive) ·
**`missed`** (memory held an item that answers it, and the row is empty) · **`couldnt`** (blocked:
unsupported widget, control not on the page, invariant-protected gate, or nothing in memory
answers it). Every row carries `resolution: "answered"|"asked_no_item"|"asked_gate"|
"blocked_widget"|"blocked_unsupported"` and `store_had_it: boolean`, computed by one batched
selection pass over the frozen store so it reproduces with no browser. Reported:
`answer_accuracy = correct/(correct+wrong)` (is what we write right?) ·
`miss_rate = missed / rows where store_had_it` (what did we fail to use?) ·
`blocked_rate = couldnt/rows` (what can we not do, stated honestly?). `fill_accuracy` is retired:
it rose to 0.981 while the runner was under-writing, which is the number that hid the problem.

## 10 · Acceptance tests

1. **No regex decides meaning** — `grep`: none of §7's deleted identifiers remain in `resolve.mjs` or `classes.mjs`.
2. **Measured request budget** — fixture, Notion and Luma dry-runs report at most six actual HTTP calls. The four-stage design does not imply four HTTP calls; post-fill verification is separately counted by the live run.
3. **Every choice has an exit** — each built `type:"choice"` carries `none_of_these`, ≤ `MAX_CHOICES` criteria.
4. **Third party** — a question naming another organisation gives `about:"third_party"` and an `ask` (B4/F1).
5. **Qualifier** — a topic-naming prompt with only a topic-free item on file gives `does_* < answersGate` and an `ask`; with a topic-carrying item, that item is selected (A18/E3).
6. **Unseen phrasing** — three labels asking the same thing in wordings absent from every fixture (a name, a location, a most-recent employer) all reach the same `asks_for` id.
7. **Semantic verification reverts** — a frozen record whose `filled_value` answers a different question is refused by `preflight` with `semantic_verify`, `clicked:false`.
8. **Unknown widget** — `scripts/controls-smoke.mjs`: a control no rung recognises ends `ask` with a screenshot.
9. **Invariants unchanged** — the `guard:` assertions for `sensitive_source`, `policy_gate_source`, `draft_gates`, `fact_from_writer` and `required_empty` still pass: this changes how meaning is decided, not what may be answered on the user's behalf.
10. **The harness separates the two** — a fixture with one empty row memory answers and one empty row it does not reports `missed: 1`, `couldnt: 1`, never `missing: 2`.
11. **Regression refusals** — preserve refusals for application history as employment history, generic leadership as datacenter hardware/NPI evidence, a personal email as prior-employer sign-in, and EEO preferences as data-processing consent.
12. **Regression recovery** — résumé document kind, scoped EEO subanswers, factual preferences, current-location facts over stale constants, narrative recall across all four memory sections, and date derivation evidence are exercised by `node eval/plan.test.mjs`.
