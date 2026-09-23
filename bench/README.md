# `bench/` — the form-filling benchmark

How well does the runner actually drive real ATS controls? Dropdowns are the hard part — a
react-select commits on a portal click, a native `<select>` on a `value`, a location autocomplete
only renders its vocabulary after you type into it, and a Greenhouse
`multi_value_multi_select` renders as eleven checkboxes on one board and a combobox on the next.
This harness measures that, per control type, on real postings.

```bash
JEV_APPLY_HOME=/tmp/jev-bench node scripts/bench.mjs --postings bench/postings.yml --port 9224
JEV_APPLY_HOME=/tmp/jev-bench node scripts/bench.mjs --postings bench/postings.yml --exercise-controls
JEV_APPLY_HOME=/tmp/jev-bench node scripts/bench.mjs --postings bench/smoke.txt --limit 2   # two fixtures
```

Results land in `bench/results/<date>-<run>.json` (everything, diff it against the next run) and
`bench/results/<date>-<run>.md` (the tables and a ranked failure list).

## Flags

| Flag | Default | What it does |
|---|---|---|
| `--postings <file>` | *required* | `bench/postings.yml` (a `postings:` list of `{url, company, family, ats, controls[], notes}`) or any file with one URL per line (`#` comments ignored) |
| `--limit N` | all | first N postings; the list is ordered easiest → hardest |
| `--port N` | `9224` | CDP port of the bench browser. **Not** 9223 — that is the user's own profile |
| `--home DIR` | `/tmp/jev-bench` | the synthetic private store |
| `--run NAME` | `HHMM` (UTC) | suffix of the two result files |
| `--timeout S` | `300` | wall-clock budget per posting before the child is killed |
| `--keep-tabs` | off | leave the filled tabs open (to look at what the runner did) |
| `--eeo` | off | opt the synthetic profile into a stored `p.eeo` preference, so demographic rows are filled instead of asked — its own experiment, see below |
| `--exercise-controls` | off | after the normal fill, drive every *remaining* row with a bench-chosen value so the widget is measured — see below. Refuses to run unless `JEV_APPLY_HOME` names a home that is not `~/.config/jev-apply` |
| `--baseline FILE` | `bench/results/2026-09-22-final.json` | the previous run's result JSON, for the round-over-round table. `--no-baseline` omits the section |

`JEV_BENCH_VERBOSE=1` echoes each child's stderr, including its Decision table.

## Setup: what the synthetic candidate knows

`src/bench/synthetic.mjs` writes the store, and then the harness runs onboarding's last step
against it:

```bash
node scripts/answers.mjs --families <every family in bench/postings.yml> --concurrency 8 --json
```

That is what an *onboarded* user has (PLAN §2.7): the canonical bank pre-answered with the
constants their facts state, the rules evaluated at fill time, the policies their preferences take
a stance on, and the narratives the writer authors from their stories. Without it the benchmark
measures somebody who answered the six day-1 questions and stopped, and every narrative prompt on
every form comes back as an ask — which is a fact about the fixture, not about the runner.

The twelve families `bench/postings.yml` covers produce 77 narrative rows, and those are real
OpenAI calls. So the family list and the resulting counts are stamped into
`<home>/memory/.answers-seed.json` and a matching re-run is skipped (`(cached)` in the log, and in
the report header). Delete the bench home to re-seed. The counts and the coverage line are printed
in the report header, so a run always states which memory it measured.

## What it does, per posting

1. Runs the real binary — `node scripts/apply.mjs --url <posting> --json` — as a child process
   with `JEV_APPLY_HOME=<home>` and `JEV_CHROME_PORT=<port>`, and waits for one of the three
   terminal statuses (`ready_to_submit` · `needs_user` · `blocked`).
2. Reads that application's `decisions.json` and `trace.jsonl` from the bench home, keeping only
   the trace rows stamped after the child started (the trace is append-only across runs). A
   posting that ends `blocked` never reaches `settle()`, so nothing was frozen for that run —
   the field counts and the failure list then come from the trace alone, and the JSON says
   `fields.from: "trace"`.
3. Records the measurements below.
4. With `--exercise-controls`, drives whatever the fill loop left open (next section).
5. Closes the posting's tab on the bench browser. (`apply.mjs` never closes a tab — D12, the
   user's filled form has to outlive the runner. A benchmark has no user and twenty open tabs
   slow every subsequent posting down.)

## `--exercise-controls`: measuring the widgets the runner never reached

`attempts 0` in the coverage table is not a pass, it is a hole. Round one reported zero attempts
for `date`, `number`, `checkbox_group`, `multi_select`, `hear_about` and `yesno_buttons` — not
because those widgets work, but because their rows resolved to `ask` or `skip` before the adapter
ran, so the adapter branch behind each of them is unproven. This mode closes exactly that hole.

After the posting's numbers have been taken, `src/bench/exercise.mjs` re-attaches to the tab and
drives every row the runner left without an answer — `ask`, `skip`, or (on a `blocked` posting,
where `decisions.json` still describes an *earlier* run) every row — with a value the **bench**
chose:

| detected control | value | strategy |
|---|---|---|
| `text` · `textarea` | `bench` | `fixed_text` |
| `number` | `5` | `fixed_number` |
| `date` | `2026-12-01` | `fixed_date` |
| `checkbox` (one box) | `Yes` | `boolean` |
| `checkbox_group`, multi react-select | the first two non-placeholder options | `first_two` |
| `radio`, `native_select`, `react_select`, `combobox`, `listbox`, `location` | one Choice over the options the widget is showing live: *"pick the most generic, non-committal option a test user would choose"*, with `none_of_these` | `jev_generic` |
| …when that list has exactly one entry | that entry | `only_option` |
| …when Jev answers `none_of_these`, the list is wider than 120, or Jev is unreachable | the **middle** non-placeholder entry | `bench_median` |
| `file` · `tel` | *not driven* | declined |

Jev exits on plenty of real lists, and correctly: asked for the most generic entry in
`["Alabama" … "Wyoming"]` the honest answer is that none of them is generic. (Measured over the
bench's own option lists — every wording of the exit came back `none_of_these` at 0.6–0.9 for a
state list and for a role list, and picked an option where a neutral one existed: `Either` out of
Weekdays/Weekends/Either, `A friend` out of a referral-source list.) So `none_of_these` is not a
skip here; it means *this list has no generic member*, and the bench picks one itself and says so
in `value picked by`. The fallback is the **median** entry, never the first: "never position 0" is
the ladder's rule because an option must be committed for matching and not for being first, and a
bench row that took entry 0 would read exactly like that bug. On a type-to-filter react-select a
middle entry is also the better test — reaching it proves the filter and the scroll.

A `location` picker renders nothing until something is typed, so its live list is seeded with
`Lisbon`, then `London`, then `Berlin`; a geocoder that answers for none of the three is not
answering, which is itself the measurement.

Two rules keep those numbers honest:

- **The schema wins for `date` and `number`.** Ashby's `Date` field is a bare `input` with no
  `type=date`, no placeholder and no pattern, so `classifyShape` calls it `text` — and a generic
  `bench` would sail through and prove nothing. Where the plan says date or number, the bench
  writes a date or a number (`fixed_date_as_planned` / `fixed_number_as_planned`): that is the
  value that tests whether the field is what the schema claims. The row is still *bucketed* by what
  the DOM turned out to be, and credited separately to the control the plan expected, which is why
  the coverage table can say `date · really text×2` instead of `date · 0 attempts, untested`.
- **`fell back because` is always printed.** A Choice that cannot reach the model falls back to the
  bench's own median pick, which in a table looks exactly like Jev answering `none_of_these`. That
  column separates them, and a run where the model was never reached says so in bold at the top of
  the report — the exercise pass asks Jev from the *bench* process, and the bench home deliberately
  has no `env` file, so `TYPESAFE_API_KEY` has to be in that process's own environment.

Five rules keep this out of everything else:

1. **Never a `filled`.** The per-posting numbers are taken *before* this pass runs, and its results
   land in their own `exercised` table with their own ok/fail counts. Its trace rows carry
   `bench_exercise: true` and `src/bench/metrics.mjs` drops them.
2. **Never `sensitive`, never `policy_gate`.** EEO/demographic rows and attestations/consents are
   skipped before anything is detected. Those are never written without an explicit human stance,
   and a benchmark is not one (AGENTS.md).
3. **Never the user's home.** `assertExerciseHome` refuses to start unless `JEV_APPLY_HOME` is set,
   is not `~/.config/jev-apply`, and names the same directory as `--home`. This pass types junk
   into a real employer's form; it has to be impossible with the user's own store loaded.
4. **Never Submit**, and nothing is restored — the tab is closed straight afterwards.
5. **Its own money.** The Choice requests are counted and priced separately
   (`totals.exercise_jev_requests`, `totals.exercise_usd`) and kept out of `$ / posting`, so the
   cost a round-over-round table compares is still what a user would pay.

A row that is *declined* — `file`, `tel`, a menu that rendered nothing, a placeholder-only list —
is not an attempt and not a failure. Declined rows are listed with their reason under the
exercised table. `tel` is declined because a phone number the bench invented is not a widget test;
`file` because the upload is the runner's own path and it already runs on every posting.

The confidence gate (`src/jev/gates.mjs`) deliberately does *not* apply: a gate decides whether an
answer is good enough to put in front of a user, and nothing here is. The pick is still one of the
form's own rendered labels, `none_of_these` is still offered, and the SDK still validates the
answer.

## What is measured

| Table | Columns |
|---|---|
| Round over round | postings · filled % · asks · failed · ms/posting · $/posting, this run against `--baseline` |
| Per posting | company · family · ATS · status · filled/total · asks · failed · ms · $ |
| Per control type | attempts · ok · fail · ok % · median ms (· replanned, when live detection overrode the schema) |
| Failures, ranked | kind · reason · count · which controls · up to three example form labels |
| Asks by reason | reason · count · `should_be_answerable?` · canon kind(s) · classes · example labels |
| Exercised controls | attempts · ok · fail · ok % · median ms · value picked by · failure reasons (+ a declined table) |
| Coverage against the list | each control `postings.yml` expects · postings listing it · filled attempts · exercised · total |

`kind` splits the failure list three ways and sorts `dom` first, so a handful of real widget
failures is not buried under a long tail of by-design planner asks: **dom** = the adapter drove a
control and the form would not take it; **vocabulary** = the widget's own live list had no entry
to commit (arguably correct caution); **plan** = memory had no answer, so the user is asked —
a `company_specific` question *is* the user's to answer (PLAN §2.1).

**Asks by reason** is the round-two question: `rankFailures` says which reasons fire, but not which
of them the product is *supposed* to fire. `should_be_answerable?` reads `yes k/n` when k of the n
asks in that bucket match a canonical question whose `kind_default` is one `scripts/answers.mjs`
writes an answer for (`constant` · `rule` · `policy` · `narrative`) — those are gaps in the runner.
`company` and `never` rows are the user's by design (PLAN §2.1) and attestations/demographics are
never auto-answered at all. A row that matched no canonical question shows `—`: unknown, not no.
The canonical question comes from the Decision's own `canon` (the qid Jev matched) and, failing
that, from looking the form's label up in the bank's recorded `surface_forms`.

In the coverage table `filled attempts 0` means the *fill loop* never drove that control, because
the row resolved to `ask` or `skip` before the adapter ran: untested, not passing. `exercised` is
`--exercise-controls` closing that hole, so `total attempts 0` is the only genuinely unmeasured
row. `eeo` is the exception where 0 everywhere is the pass — neither the runner nor the bench may
touch a demographic control — and the report shouts **INVARIANT VIOLATED** if any demographic
control was written without an explicit preference. A few names in `postings.yml` (`hear_about`,
`long_option_list`) describe a question rather than a widget and are always co-listed with the
widget they render as, so their own row shows no bucket.

- **filled** counts `fill` + `check` Decisions; **asks** are the rows handed back to the user;
  **failed** counts DOM writes whose read-back did not match what was set.
- **Control types**: `text, textarea, react_select, native_select, radio, checkbox, tel, file,
  date, number, combobox, location, unknown`. The bucket comes from the trace's `control` field —
  what the adapter *actually* drove, not what the schema guessed. `listbox` folds into `combobox`;
  `checkbox_group`, `checkbox_single` and `multi_select` into `checkbox`; `tel_country` into
  `tel`; `yesno_buttons` and `boolean` into `radio`; `essay` into `textarea`. A control name
  nobody has taught the bench lands in `unknown`, which is a visible row rather than a silent
  drop. A write whose qid or label names a location (`candidate-location`, "Where are you
  based?") is counted as `location` whatever widget it rendered as, because that is the case that
  fails. `native_select` is not expected on hosted Greenhouse or Ashby at all — every `<select>`
  found in a survey of those boards was on an *embedded* board — so a non-empty `native_select`
  row means live detection reclassified something.
- **replanned**: writes whose trace row carries `planned` (the schema's control) different from
  `control` (what detection drove). A Greenhouse `multi_value_multi_select` is eleven checkboxes
  on one board and a react-select on the next; this column counts how often that mattered.
- **median ms per set**: the adapters may stamp `ms` themselves; otherwise it is the gap between
  one write and the previous browser event, i.e. the 150–400 ms cadence plus the set plus the
  read-back — what a user waits through.
- **Failure reasons** are normalised keys, never text somebody typed. From the executor's
  read-back clause and from the adapters' own `reason` field: `set_failed:control_not_found`,
  `set_failed:no_options_rendered`, `set_failed:no_matching_option`, `set_failed:ambiguous_location`,
  `set_failed:placeholder_option`, `set_failed:not_boolean`, `set_failed:not_a_number`,
  `set_failed:unparsable_date`, `set_failed:country_not_set`, `set_failed:unknown_control`,
  `set_failed:readback_mismatch`, … From the planner: `vocabulary:no_exact_match` (the
  autocomplete offered a list with no exact match — the Greenhouse "Location" Pelias case),
  `vocabulary:empty_list`, `no_control`, `no_value`, `missing_document`, `required_still_empty`,
  and `plan:<clause>` for a row memory could not answer. Labels for trace-only failures are
  recovered from the Jev request rows, which carry the question text the model was shown.
- **usage/cost** comes from the child's own `usage` block: per-phase milliseconds
  (`ms_schema`/`ms_plan`/`ms_browser`), Jev requests and tokens, OpenAI calls and tokens, dollars.
  The phases are not a partition of `ms_total` — a conditional follow-up is re-planned from inside
  the fill loop (PLAN §2.2 step 9), so that Jev round trip counts in both `ms_plan` and
  `ms_browser` and the three can sum past the wall clock.

## Safety rails

- **The candidate is invented.** `src/bench/synthetic.mjs` writes the whole store: Robin Sanchez,
  `@bench.invalid`, a Lisbon address that does not exist, `eval/fixtures/blank.pdf` as the CV.
  No real name, email, phone or résumé ever reaches somebody's careers page. The store is
  deliberately *complete* — all six day-1 items, two-valued work authorization for US/GB/DE, the
  policy stances — so an `ask` the bench records is a gap in the runner, not a hole in the
  fixture. Re-running the setup is idempotent and leaves `applications/` alone; `answers.yaml` is
  *merged* rather than overwritten, so the pre-answering pass above survives the next setup.
- **`--exercise-controls` cannot run against the user's store.** `assertExerciseHome` refuses
  unless `JEV_APPLY_HOME` is set, is not `~/.config/jev-apply`, and names the same directory as
  `--home`. That check is first, before a browser is opened or a file is written, because this is
  the one mode that writes values nobody chose into a real employer's form. It never touches a
  `sensitive` or `policy_gate` row, and its results are never counted as `filled`.
- **Demographics are asked, not skipped, with no `p.eeo` on file** (PLAN D10) — the resolver never
  guesses a demographic value, so a bare bench run turns every EEO row into `needs_user`, not a
  silent skip. `--eeo` seeds a synthetic `p.eeo` so the rows fill instead — its own experiment ("can
  the demographic block be driven at all?"), reported as its own run: in the first such run three
  Greenhouse demographic selects returned `no_options_rendered` in a row, the `no_progress` stop rule
  fired, and the posting ended `blocked` before one application question was reached;
  `src/browser/controls.mjs`'s dedicated EEO react-select retry (menu-open wait, portal-option read)
  and a separate no-progress counter for the EEO block fix that.
- **The bench never sets `p.auto_submit`.** Every application it drives stops at `ready_to_submit`;
  the bench adds no way to opt in and it never passes `--submit` or `--answers`.
- **The browser is the bench's own.** `assertBenchPort` refuses to start when something already
  answers on the bench port that is not the bench profile. Chrome will not name its own
  `--user-data-dir` over CDP (`Browser.getBrowserCommandLine` needs `--enable-automation`, which
  `chromeArgs` does not pass), so the check compares the browser process id from
  `SystemInfo.getProcessInfo` with the pid in `<profile>/SingletonLock`; `DevToolsActivePort` is
  tried first when Chrome wrote one. If the user's own profile is squatting on the port, the error
  says so.
- **Credentials come only from `~/.config/jev-apply/env`** (or the environment). They travel in
  the child's environment and are never written under `/tmp`, never logged, never in a result
  file. The bench home deliberately has no `env` file.
- **Values never appear in a report.** Form labels and qids are public; candidate values,
  read-backs and the executor's `— intended: …` tails are dropped before anything is written.

## Pricing

`PRICING` in `src/config.mjs`, in USD per million tokens:

| Vendor | Model | Input | Output | Source |
|---|---|---|---|---|
| TypeSafe | `jev-1.13.0` | $0.042 | free | <https://docs.typesafe.ai/models.md> (recorded in `docs/research/03-typesafe-jev-api.md`, re-confirmed in `08-skeptic-review.md`); the page warns its limits "can change without notice" |
| OpenAI | `gpt-5.4` | $2.50 | $15.00 | <https://developers.openai.com/api/docs/pricing>, Standard tier, short context (< 272k), read 2026-09-23 |
| OpenAI | `gpt-5.4-mini` | $0.75 | $4.50 | same page and date |

Cached input (OpenAI $0.25 / $0.075) is deliberately not modelled: the writer sends a different
story per call, so assuming a cache hit would under-report. Batch and Fast tiers are not used.
A model `PRICING` does not name makes the figure `null` and every renderer prints `cost: unknown`
rather than a guess — that is also what to expect if the model pins in `src/config.mjs` move.

Both `apply.mjs` and the bench read the same table: every `apply.mjs` JSON carries a `usage` block
(`ms_total`, `ms_schema`, `ms_plan`, `ms_browser`, `jev{…}`, `openai{…}`, `usd_total`) and every
`summary.md` carries the matching `► COST` line. `--exercise-controls`'s own Choice requests are
priced the same way but reported separately (`totals.exercise_jev_requests`, `totals.exercise_usd`)
and kept out of `$ / posting`: that column has to stay what a user would pay.

## Files

```
bench/postings.yml     the benchmark list (owned by the postings research slice)
bench/smoke.txt        two fixture URLs — enough to prove the harness runs
bench/results/         <date>-<run>.json + .md, one pair per run
src/bench/synthetic.mjs  the invented candidate, plus the `scripts/answers.mjs` seeding pass
src/bench/postings.mjs   the list loader (YAML or a URL list)
src/bench/run.mjs        spawn apply.mjs, guard the port, read artefacts, close the tab
src/bench/exercise.mjs   --exercise-controls: drive the rows the fill loop left open
src/bench/metrics.mjs    decisions + trace → field counts, control buckets, failure reasons, asks
src/bench/report.mjs     → the JSON record and the Markdown tables
```
