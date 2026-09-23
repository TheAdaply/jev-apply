// The two files a bench run leaves behind: `bench/results/<date>-<run>.json` (everything, for a
// diff against the next run) and `bench/results/<date>-<run>.md` (the tables a human reads).
//
// The Markdown is the deliverable: this run against the last one, a per-posting table, what the
// fill loop drove, what it handed back and whether memory should have answered it, what
// `--exercise-controls` drove on top, and the coverage the posting list promised. Values are never
// printed — only form labels, qids, counts, milliseconds and dollars (see src/bench/metrics.mjs).

import { JEV_MODEL, OPENAI_MODEL, PRICING } from "../config.mjs";
import { money } from "../plan/summary.mjs";
import { ANSWERABLE_KINDS, CONTROL_TYPES, classifyControl, rankAsks, rankFailures, rollUpControls, rollUpExercised } from "./metrics.mjs";

const dash = "—";

const cell = (v) => (v == null || v === "" ? dash : String(v).replace(/\|/g, "\\|"));

/** Markdown table with a left-aligned first column and right-aligned numbers. */
function table(headers, rows, aligns = []) {
  const head = `| ${headers.map(cell).join(" | ")} |`;
  const rule = `|${headers.map((_, i) => (aligns[i] === "r" ? "---:" : aligns[i] === "c" ? ":---:" : "---")).map((s) => ` ${s} `).join("|")}|`;
  const body = rows.map((r) => `| ${r.map(cell).join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}

const secs = (ms) => (typeof ms === "number" ? `${(ms / 1000).toFixed(1)}s` : dash);

/** `usd` may legitimately be `null` — an unpriced model prints `cost: unknown`, never a guess. */
const usd = (n) => (n == null ? "unknown" : money(n));


/** Label text reduced to the letters and digits that carry it, for canon surface-form matching. */
const flat = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * ask → the canonical question's `kind_default`, or null when the row matched no canonical
 * question at all.
 *
 * Two witnesses, in order of how much they are worth. `decision.canon` is the qid Jev matched and
 * is authoritative. Failing that, the form's own label is looked up in the bank's recorded
 * `surface_forms` — the same text the corpus saw a real board print — which is how a
 * `company_specific` row that is really a rephrasing of a narrative prompt is caught. Labels are
 * clipped to 60 characters in this report, so a long one is matched by prefix, and only when it is
 * long enough (≥ 12 characters) for a prefix to mean anything.
 */
export function canonKindIndex(canon) {
  const byQid = new Map();
  const byLabel = new Map();
  for (const q of canon?.questions ?? []) {
    const kind = q?.kind_default ?? null;
    if (!kind || !q.qid) continue;
    byQid.set(q.qid, kind);
    for (const form of q.surface_forms ?? []) {
      const key = flat(form?.label);
      if (key && !byLabel.has(key)) byLabel.set(key, kind);
    }
  }
  const keys = [...byLabel.keys()];
  return (ask) => {
    if (ask?.canon && byQid.has(ask.canon)) return byQid.get(ask.canon);
    const label = flat(String(ask?.label ?? "").replace(/[…]+$/, ""));
    if (!label) return null;
    if (byLabel.has(label)) return byLabel.get(label);
    if (label.length < 12) return null;
    const hit = keys.find((k) => k.length >= 12 && (k.startsWith(label) || label.startsWith(k)));
    return hit ? byLabel.get(hit) : null;
  };
}

function totals(postings) {
  const sum = (pick) => postings.reduce((n, p) => n + (pick(p) ?? 0), 0);
  // Two different nulls. A posting whose child never printed a `usage` block reported *nothing*
  // and contributes nothing; only a posting that reported a model `PRICING` cannot price makes
  // the run total genuinely unknown. Conflating them turns one crashed child into "cost: unknown"
  // for the whole benchmark.
  const reported = postings.filter((p) => p.usage);
  const costs = reported.map((p) => p.usage.usd_total);
  return {
    postings: postings.length,
    by_status: postings.reduce((acc, p) => ({ ...acc, [p.status]: (acc[p.status] ?? 0) + 1 }), {}),
    fields: sum((p) => p.fields?.total),
    filled: sum((p) => (p.fields?.filled ?? 0) + (p.fields?.check ?? 0)),
    asks: sum((p) => p.fields?.ask),
    failed: sum((p) => p.fields?.failed),
    writes: sum((p) => p.writes),
    ms: sum((p) => p.ms),
    jev_requests: sum((p) => p.usage?.jev?.requests),
    jev_tokens: sum((p) => (p.usage?.jev?.input_tokens ?? 0) + (p.usage?.jev?.output_tokens ?? 0)),
    openai_calls: sum((p) => p.usage?.openai?.calls),
    openai_tokens: sum((p) => (p.usage?.openai?.input_tokens ?? 0) + (p.usage?.openai?.output_tokens ?? 0)),
    usd: costs.some((c) => c == null) ? null : Math.round(costs.reduce((a, b) => a + b, 0) * 1e6) / 1e6,
    usd_unreported: postings.length - reported.length,
    eeo_writes: sum((p) => p.eeo_writes),
    // `--exercise-controls` is the bench's own spend, never the runner's: it is kept out of `usd`
    // so the `$ / posting` a round-over-round comparison reads is still what a user would pay.
    exercise_ms: sum((p) => p.exercised?.ms),
    exercise_jev_requests: sum((p) => p.exercised?.jev?.requests),
    exercise_usd: postings.some((p) => p.exercised) ? Math.round(sum((p) => p.exercised?.usd) * 1e6) / 1e6 : null,
    judgments: (() => {
      const keys = ["right", "wrong", "missed", "couldnt", "unjudged", "store_had_it", "rows"];
      const c = Object.fromEntries(keys.map((key) => [key, sum((p) => p.judgments?.[key])]));
      return { ...c, answer_accuracy: c.right + c.wrong ? c.right / (c.right + c.wrong) : null,
        miss_rate: c.store_had_it ? c.missed / c.store_had_it : null, blocked_rate: c.rows ? c.couldnt / c.rows : null };
    })(),
  };
}

/**
 * Names `bench/postings.yml` lists that describe a *question* rather than a widget. Each is always
 * co-listed with the control it renders as, so it has no bucket of its own and its `0` is not an
 * untested control.
 */
const QUESTION_SHAPED = new Set(["hear_about", "long_option_list"]);

/**
 * `bench/postings.yml` states which controls each posting is supposed to exercise. Some of those
 * names are *expectation* labels rather than control types (`hear_about`, `long_option_list`,
 * `eeo`) — they describe a question, not a widget — so a name that maps to no column shows its
 * bucket as `—` instead of being folded into `unknown` and pretending to have been measured.
 *
 * `asPlanned` is the other half of that honesty. A row the posting list calls a `date` can turn
 * out to be a bare text input (Ashby's `Date` field is exactly that), and bucketing it by what the
 * DOM really was would leave `date` reading `0 attempts — untested` when the row was driven and
 * the finding is that the widget is not a date picker. Those rows are credited to the control the
 * plan expected, with the control they turned out to be named beside them.
 */
function coverage(postings, controls, exercised = [], asPlanned = {}) {
  const observed = new Map(controls.map((c) => [c.control, c]));
  const drilled = new Map(exercised.map((c) => [c.control, c]));
  const expected = new Map();
  for (const p of postings) {
    for (const name of p.expected_controls ?? []) {
      const row = expected.get(name) ?? { name, postings: 0 };
      row.postings += 1;
      expected.set(name, row);
    }
  }
  return [...expected.values()]
    .map((row) => {
      const bucket = CONTROL_TYPES.includes(classifyControl({ control: row.name })) && classifyControl({ control: row.name }) !== "unknown"
        ? classifyControl({ control: row.name })
        : null;
      const seen = bucket ? observed.get(bucket) : null;
      const drove = bucket ? drilled.get(bucket) : null;
      const planned = bucket ? asPlanned[bucket] : null;
      const attempts = seen?.attempts ?? 0;
      const exercisedAttempts = (drove?.attempts ?? 0) + (planned?.attempts ?? 0);
      const exercisedOk = (drove?.ok ?? 0) + (planned?.ok ?? 0);
      return {
        ...row,
        bucket,
        attempts,
        ok_pct: seen?.ok_pct ?? null,
        exercised: exercisedAttempts,
        exercised_ok_pct: exercisedAttempts ? Math.round((exercisedOk / exercisedAttempts) * 1000) / 10 : null,
        ...(planned?.attempts ? { drove_as: Object.entries(planned.detected).map(([got, n]) => `${got}×${n}`) } : {}),
        total: attempts + exercisedAttempts,
      };
    })
    .sort((a, b) => a.total - b.total || b.postings - a.postings || a.name.localeCompare(b.name));
}

/** The five numbers one bench run is compared to another by, all read off a `totals` block. */
export function headline(t = {}) {
  const priced = (t.postings ?? 0) - (t.usd_unreported ?? 0);
  return {
    postings: t.postings ?? 0,
    fields: t.fields ?? 0,
    filled: t.filled ?? 0,
    filled_pct: t.fields ? Math.round(((t.filled ?? 0) / t.fields) * 1000) / 10 : null,
    asks: t.asks ?? 0,
    failed: t.failed ?? 0,
    ms_per_posting: t.postings ? Math.round((t.ms ?? 0) / t.postings) : null,
    usd_per_posting: t.usd == null || priced <= 0 ? null : Math.round((t.usd / priced) * 1e6) / 1e6,
  };
}

const signed = (n, digits = 0, unit = "") => (n == null ? dash : `${n > 0 ? "+" : n < 0 ? "-" : "±"}${Math.abs(n).toFixed(digits)}${unit}`);

/**
 * This run against the round it is trying to beat.
 *
 * Both sides are read from a result JSON's own `totals` block — never from a Markdown table, and
 * never from a number typed into a commit message — so a comparison that exists at all is a
 * comparison of two runs that were actually recorded. A baseline the harness could not read makes
 * the section say so instead of showing an improvement against nothing.
 */
export function compare(baseline, sums) {
  if (!baseline?.totals) return null;
  const was = headline(baseline.totals);
  const now = headline(sums);
  const diff = (a, b) => (a == null || b == null ? null : b - a);
  return {
    baseline_run: baseline.run ?? null,
    baseline_file: baseline.file ?? null,
    was,
    now,
    rows: [
      ["postings", was.postings, now.postings, signed(diff(was.postings, now.postings))],
      [
        "filled",
        `${was.filled}/${was.fields}${was.filled_pct == null ? "" : ` (${was.filled_pct}%)`}`,
        `${now.filled}/${now.fields}${now.filled_pct == null ? "" : ` (${now.filled_pct}%)`}`,
        signed(diff(was.filled_pct, now.filled_pct), 1, " pt"),
      ],
      ["asks", was.asks, now.asks, signed(diff(was.asks, now.asks))],
      ["failed sets", was.failed, now.failed, signed(diff(was.failed, now.failed))],
      [
        "ms / posting",
        was.ms_per_posting ?? dash,
        now.ms_per_posting ?? dash,
        signed(diff(was.ms_per_posting, now.ms_per_posting) == null ? null : diff(was.ms_per_posting, now.ms_per_posting) / 1000, 1, " s"),
      ],
      [
        "$ / posting",
        was.usd_per_posting == null ? "unknown" : money(was.usd_per_posting),
        now.usd_per_posting == null ? "unknown" : money(now.usd_per_posting),
        was.usd_per_posting == null || now.usd_per_posting == null
          ? dash
          : `${now.usd_per_posting >= was.usd_per_posting ? "+" : "-"}${money(Math.abs(now.usd_per_posting - was.usd_per_posting))}`,
      ],
    ],
  };
}

/**
 * @param {{run:string, started:string, postings:object[], list:object, home:string, port:number,
 *          ms:number, canon?:object, baseline?:object, seeded?:object, exercise?:boolean}} args
 * @returns {{json:object, markdown:string}}
 */
export function buildReport({ run, started, finished, postings, list, home, port, ms, eeo = false, canon = null, baseline = null, seeded = null, exercise = false }) {
  const controls = rollUpControls(postings);
  const failures = rankFailures(postings);
  const drilled = rollUpExercised(postings);
  const expected = coverage(postings, controls, drilled.controls, drilled.as_planned);
  const sums = totals(postings);
  // Choices that never reached the model at all. Kept as its own number because the fallback it
  // triggers is indistinguishable, in the table, from Jev honestly answering `none_of_these`.
  const unreachable = drilled.controls.reduce(
    (n, c) => n + (c.fell_back ?? []).reduce((m, s) => m + (s.startsWith("jev_unavailable×") ? Number(s.split("×")[1]) || 0 : 0), 0),
    0,
  );
  const asks = rankAsks(postings, canonKindIndex(canon));
  const versus = compare(baseline, sums);
  const askTotals = asks.reduce((acc, a) => ({ count: acc.count + a.count, mapped: acc.mapped + a.mapped, answerable: acc.answerable + a.answerable }), {
    count: 0,
    mapped: 0,
    answerable: 0,
  });

  const json = {
    run,
    started,
    finished,
    ms,
    harness: {
      postings_file: list?.file ?? null,
      postings_source: list?.source ?? null,
      home,
      cdp_port: port,
      jev_model: JEV_MODEL,
      openai_model: OPENAI_MODEL,
      pricing: PRICING,
      profile: eeo ? "synthetic + EEO opted in (src/bench/synthetic.mjs)" : "synthetic (src/bench/synthetic.mjs)",
      exercise_controls: Boolean(exercise),
      answers_seeded: seeded ?? null,
      canon_questions: canon?.questions?.length ?? null,
    },
    totals: { ...sums, asks_answerable: askTotals.answerable, asks_mapped: askTotals.mapped },
    comparison: versus,
    postings,
    controls,
    exercised: drilled,
    failures,
    asks,
    coverage: expected,
  };

  const lines = [
    `# jev-apply bench — ${run}`,
    "",
    `${sums.postings} posting(s) · ${Object.entries(sums.by_status).map(([k, v]) => `${v} ${k}`).join(" · ") || dash} · ` +
      `${sums.filled}/${sums.fields} fields filled · ${sums.asks} ask(s) · ${sums.failed} failed set(s) · ` +
      `${secs(ms)} wall · ${usd(sums.usd)}` +
      (exercise ? `\n\n**\`--exercise-controls\` run:** after each fill, every remaining non-sensitive, non-gate row was driven with a bench-chosen value. Those are counted as \`exercised\`, never as \`filled\`.` : "") +
      // A Choice that cannot reach the model falls back to the bench's own median pick, which in a
      // table looks exactly like Jev answering `none_of_these`. Saying so out loud is the whole
      // difference between "no option here was generic" and "the ranking never ran".
      (exercise && unreachable
        ? `\n\n**The Jev ranking did not run for ${unreachable} control(s): the model could not be reached**, so those were filled by the bench's own median pick. \`TYPESAFE_API_KEY\` has to be in *this* process's environment — the bench home has no \`env\` file by design.`
        : "") +
      (!eeo && sums.eeo_writes ? `\n\n**INVARIANT VIOLATED: ${sums.eeo_writes} write(s) to a demographic control.** The runner must never touch one without an explicit preference (AGENTS.md).` : ""),
    "",
    `Started ${started} · list \`${list?.file ?? dash}\` · home \`${home}\` · CDP ${port} · ` +
      `models \`${JEV_MODEL}\` / \`${OPENAI_MODEL}\` · synthetic profile${eeo ? " **with EEO opted in**" : ", demographics skipped"}, Submit never clicked.`,
    "",
    seeded
      ? `Memory: the synthetic store **plus** \`scripts/answers.mjs --families ${(seeded.families ?? []).join(",")}\`${seeded.cached ? " (cached from an earlier setup)" : ""} — ` +
        `${seeded.constants ?? 0} constants · ${seeded.rules ?? 0} rules · ${seeded.policies ?? 0} policies · ${seeded.narratives ?? 0} narratives (${seeded.rows ?? 0} rows). ` +
        `${seeded.coverage_line ? `${seeded.coverage_line}.` : ""}${(seeded.missing ?? []).length ? ` Not pre-answered: ${seeded.missing.join("; ")}.` : ""}`
      : "Memory: the synthetic store only — the canonical bank was **not** pre-answered for this run.",
    "",
    `Judgments: ${sums.judgments.right} right · ${sums.judgments.wrong} wrong · ${sums.judgments.missed} missed (memory had it) · ${sums.judgments.couldnt} couldnt (blocked/no memory) · ${sums.judgments.unjudged} unjudged.`,
    `answer_accuracy: ${sums.judgments.answer_accuracy ?? dash} · miss_rate: ${sums.judgments.miss_rate ?? dash} · blocked_rate: ${sums.judgments.blocked_rate ?? dash}. A semantic verdict is not independent ground truth.`,
    "",
  ];

  if (versus) {
    lines.push(
      `## Round over round — vs \`${versus.baseline_file ?? versus.baseline_run ?? "baseline"}\``,
      "",
      table(["metric", `round one (${versus.baseline_run ?? dash})`, `this run (${run})`, "Δ"], versus.rows, ["l", "r", "r", "r"]),
      "",
    );
  } else if (baseline) {
    lines.push(`## Round over round`, "", `_No comparison: \`${baseline.file ?? baseline}\` could not be read as a bench result JSON._`, "");
  }

  lines.push(
    "## Per posting",
    "",
    table(
      ["#", "company", "family", "ATS", "status", "filled/total", "asks", "failed", "ms", "$"],
      postings.map((p) => [
        p.n,
        p.company,
        p.family ?? dash,
        p.ats,
        p.status,
        `${(p.fields?.filled ?? 0) + (p.fields?.check ?? 0)}/${p.fields?.total ?? 0}`,
        p.fields?.ask ?? 0,
        p.fields?.failed ?? 0,
        p.ms ?? dash,
        p.usage ? usd(p.usage.usd_total) : dash,
      ]),
      ["r", "l", "l", "l", "l", "r", "r", "r", "r", "r"],
    ),
    "",
    "## Per control type",
    "",
    controls.length
      ? table(
          // `replanned` only earns a column when live detection actually overrode the schema —
          // a Greenhouse `multi_value_multi_select` that is eleven checkboxes on one board and a
          // react-select on the next is the whole reason this number exists.
          ["control", "attempts", "ok", "fail", "ok %", "median ms", ...(controls.some((c) => c.replanned) ? ["replanned"] : [])],
          controls.map((c) => [
            c.control,
            c.attempts,
            c.ok,
            c.fail,
            c.ok_pct == null ? dash : `${c.ok_pct}%`,
            c.median_ms ?? dash,
            ...(controls.some((x) => x.replanned) ? [c.replanned || dash] : []),
          ]),
          ["l", "r", "r", "r", "r", "r", "r"],
        )
      : "_No control was written — every posting was blocked before the browser._",
    "",
    "## Failures, ranked",
    "",
    failures.length
      ? table(
          ["kind", "reason", "count", "controls", "examples (form labels)"],
          failures.map((f) => [f.kind, f.reason, f.count, f.controls.join(", ") || dash, f.examples.map((e) => `"${e.label}"`).join(" · ")]),
          ["l", "l", "r", "l", "l"],
        )
      : "_Nothing open: every field was filled and read back._",
    "",
    "`dom` = the adapter drove a control and the form would not take it. `vocabulary` = the widget's",
    "own live list had no entry to commit. `plan` = memory had no answer, so the user is asked —",
    "often by design (`company_specific` questions are the user's, PLAN §2.1).",
    "",
    "## Asks by reason",
    "",
    asks.length
      ? table(
          ["reason", "count", "should_be_answerable?", "canon kind(s)", "classes", "examples (form labels)"],
          asks.map((a) => [
            a.reason,
            a.count,
            a.mapped === 0 ? dash : `${a.answerable > 0 ? "yes" : "no"} ${a.answerable}/${a.count}`,
            a.canon_kinds.join(", ") || dash,
            a.classes.join(", ") || dash,
            a.examples.map((e) => `"${e.label}"`).join(" · "),
          ]),
          ["l", "r", "l", "l", "l", "l"],
        )
      : "_No row was handed back to the user._",
    "",
    `${askTotals.answerable} of ${sums.asks} ask(s) match a canonical question whose \`kind_default\` is one ` +
      `\`scripts/answers.mjs\` writes an answer for (\`${[...ANSWERABLE_KINDS].join("\` · \`")}\`) — those are gaps in the runner, ` +
      `not questions that are the user's to answer. \`${dash}\` means the row matched no canonical question at all: unknown, not no. ` +
      "`company` and `never` rows are the user's by design (PLAN §2.1); attestations and demographics are never auto-answered (AGENTS.md).",
    "",
    "## Exercised controls",
    "",
    drilled.controls.length
      ? table(
          ["control", "attempts", "ok", "fail", "ok %", "median ms", "value picked by", "fell back because", "failure reasons"],
          drilled.controls.map((c) => [
            c.control,
            c.attempts,
            c.ok,
            c.fail,
            c.ok_pct == null ? dash : `${c.ok_pct}%`,
            c.median_ms ?? dash,
            (c.picked_by ?? []).join(", ") || dash,
            (c.fell_back ?? []).join(", ") || dash,
            (c.reasons ?? []).join(", ") || dash,
          ]),
          ["l", "r", "r", "r", "r", "r", "l", "l", "l"],
        )
      : exercise
        ? "_`--exercise-controls` ran but drove nothing: every remaining row was sensitive, a policy gate, or had no control on the page._"
        : "_Not an `--exercise-controls` run: only the rows the runner itself filled were driven._",
    "",
    ...(Object.keys(drilled.skipped).length
      ? [
          table(
            ["declined", "rows"],
            Object.entries(drilled.skipped).sort((a, b) => b[1] - a[1]),
            ["l", "r"],
          ),
          "",
          "These rows were *not* driven, so they are not attempts and not failures. A `file` or `tel` row has",
          "no honest bench value; `no_options_rendered` and `none_of_these` are the widget or the selector",
          "declining, which is the same caution the fill loop applies.",
          "",
        ]
      : []),
  );

  const blocked = postings.filter((p) => p.status === "blocked");
  if (blocked.length) {
    lines.push(
      "## Blocked",
      "",
      table(["#", "company", "reason"], blocked.map((p) => [p.n, p.company, p.reason ?? dash]), ["r", "l", "l"]),
      "",
    );
  }

  // Did the run reach what the list promised? A posting that blocks on field 3 never exercises
  // the date picker it was chosen for, and a table of what was measured hides that.
  if (expected.length) {
    lines.push(
      "## Coverage against the list",
      "",
      table(
        ["expected control", "postings listing it", "measured as", "filled attempts", "ok %", "exercised", "exercised ok %", "total attempts"],
        expected.map((e) => [
          e.name,
          e.postings,
          // `hear_about` and `long_option_list` name a question, `eeo` a class of rows — none of
          // them is a widget, so a blank `—` next to `0` reads like an untested control when it is
          // nothing of the sort.
          (e.bucket ?? (QUESTION_SHAPED.has(e.name) ? "(a question, not a widget)" : e.name === "eeo" ? "(never driven, by design)" : dash)) +
            (e.drove_as ? ` · really ${e.drove_as.join(", ")}` : ""),
          e.attempts,
          e.ok_pct == null ? dash : `${e.ok_pct}%`,
          e.exercised,
          e.exercised_ok_pct == null ? dash : `${e.exercised_ok_pct}%`,
          e.total,
        ]),
        ["l", "r", "l", "r", "r", "r", "r", "r"],
      ),
      "",
      "`filled attempts 0` means the fill loop never drove that control — the row resolved to `ask` or",
      "`skip` before the adapter ran, so it is untested, not passing. `exercised` is `--exercise-controls`",
      "closing exactly that hole with a bench-chosen value, which proves the widget, not the answer.",
      "`total attempts 0` is therefore the only genuinely unmeasured row. The one exception is `eeo`,",
      "where 0 everywhere is the pass: neither the runner nor the bench may touch a demographic control",
      "without an explicit preference. `hear_about` and `long_option_list` name a *question*, not a widget,",
      "so they have no bucket and are always co-listed with the control they render as.",
      "",
    );
  }

  const shots = postings.flatMap((p) => (p.screenshots ?? []).map((s) => [p.company, s]));
  if (shots.length) {
    lines.push("## Failure screenshots", "", table(["company", "path"], shots, ["l", "l"]), "");
  }

  lines.push(
    "## How to read this",
    "",
    "`filled` counts `fill` + `check` Decisions; `asks` are the rows handed back to the user; `failed`",
    "counts DOM writes whose read-back did not match. `median ms` per control is the gap between one",
    "write and the previous browser event — the adapter's 150–400 ms cadence plus the set plus the",
    "read-back, i.e. what a user waits through. Costs use `PRICING` in `src/config.mjs`.",
    "",
    "`exercised` is the bench driving a row the runner left open, with a value the **bench** chose, so a",
    "widget that was never reached is measured instead of silently scoring zero. It is never a `filled`,",
    "it never touches a `sensitive` or `policy_gate` row, and its Jev spend is reported separately" +
      (sums.exercise_jev_requests ? ` (${sums.exercise_jev_requests} request(s), ${usd(sums.exercise_usd)}, ${secs(sums.exercise_ms)})` : "") +
      " so the `$ / posting` above stays what a user would actually pay.",
    "",
  );

  return { json, markdown: lines.join("\n") };
}
