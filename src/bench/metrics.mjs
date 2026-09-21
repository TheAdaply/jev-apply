// One posting's run → the numbers the benchmark report is made of.
//
// Inputs are the two artefacts the runner already writes (PLAN §2.2 step 11):
// `applications/<slug>/decisions.json` (what the plan decided) and `trace.jsonl` (what the DOM
// actually did — one row per write, read back). Nothing here talks to a browser or a model.
//
// Two rules shape the output:
//   * **Values never leave.** Labels are the form's own public text and qids are opaque, so both
//     are kept; every candidate value, read-back and "intended: …" tail is dropped. A failure is
//     reported as a normalised *reason key*, never as the text somebody tried to type.
//   * **Only this run counts.** A trace is append-only across every run against a posting, so
//     every reader here filters on `since` — the wall clock just before the child was spawned.

/** The report's columns, in the order they are printed. Anything else buckets into `unknown`. */
export const CONTROL_TYPES = [
  "text",
  "textarea",
  "react_select",
  "native_select",
  "radio",
  "checkbox",
  "tel",
  "file",
  "date",
  "number",
  "combobox",
  "location",
  "unknown",
];

/**
 * Names the adapters emit that are a finer split of a column above. Keeping the report's
 * vocabulary fixed means a new control name never silently disappears — it lands in `unknown`,
 * which is a visible row, and is then either aliased here or promoted to its own column.
 */
const ALIAS = {
  listbox: "combobox",
  checkbox_group: "checkbox",
  checkbox_single: "checkbox",
  multi_select: "checkbox",
  select: "native_select",
  phone: "tel",
  tel_country: "tel",
  yesno_buttons: "radio",
  boolean: "radio",
  essay: "textarea",
  url: "text",
  email: "text",
};

/** A location picker renders as a combobox; the bench wants it counted as the hard case it is. */
const LOCATION_RE = /\b(location|city|where (?:are|do) you|based|country of residence|current residence)\b/i;
const LOCATION_QID = /(^|[_-])(candidate[_-]?location|location|city)([_-]|$)/i;
const LOCATION_HOSTS = new Set(["react_select", "combobox", "text", "unknown", "native_select"]);

/**
 * Which column a written control belongs to.
 *
 * `unknownAs: null` is for rows that never reached the DOM — a planner `ask` carries no control
 * at all. Those rows get no bucket at all, not even from their label: putting "Which office
 * location(s) are you interested in?" in the `location` column next to eleven real autocomplete
 * writes would read as eleven failures of a control the bench never touched.
 *
 * @param {{control?:string, qid?:string, label?:string, type?:string}} row
 * @param {{unknownAs?:string|null}} [opts]
 */
export function classifyControl(row = {}, { unknownAs = "unknown" } = {}) {
  const raw = String(row.control ?? row.type ?? "").trim().toLowerCase();
  if (!raw) return unknownAs;
  const named = ALIAS[raw] ?? raw;
  const bucket = CONTROL_TYPES.includes(named) && named !== "unknown" ? named : "unknown";
  if (bucket === "location") return "location";
  const looksLocal = LOCATION_QID.test(String(row.qid ?? "")) || LOCATION_RE.test(String(row.label ?? ""));
  return looksLocal && LOCATION_HOSTS.has(bucket) ? "location" : bucket;
}

/** Newline-delimited JSON, tolerant of a half-written last line (the file is append-only). */
export function parseTrace(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      /* a row torn by a crash is not a measurement */
    }
  }
  return rows;
}

const at = (row) => Date.parse(row?.ts ?? "") || 0;

/** Events that mark browser progress, so the gap before a write is that write's cost. */
const PACED = new Set(["open", "snapshot", "set", "upload", "probe"]);

/**
 * Per-write wall time. The adapters may stamp `ms` themselves; when they do not, the honest
 * measure is the gap since the previous browser event, which is what a user waits through:
 * the adapter's 150–400 ms cadence plus the set plus the read-back (PLAN §2.2 step 8).
 */
function withDurations(rows) {
  let prev = null;
  return rows.map((row) => {
    const t = at(row);
    const out = row.op === "set" || row.op === "upload" ? { ...row, ms: row.ms ?? (prev == null ? null : t - prev) } : row;
    if (PACED.has(row.op)) prev = t;
    return out;
  });
}

export function median(values) {
  const xs = values.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

const SET_FAILED = /^the form would not take it \(([^)]*)\)/;
const clipLabel = (s, n = 60) => {
  const text = String(s ?? "").replace(/\s+/g, " ").trim();
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};

const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "unknown";

/**
 * An adapter's `reason` → a bucket with its payload removed.
 *
 * The adapters name the reason and then append the evidence: `not_a_number: Lisbon, Portugal`,
 * `unmatched: Yes, No`, `no_matching_option (12 shown)`. That tail is the candidate's own value
 * or the form's vocabulary — neither belongs in a file anyone might paste into a chat — so only
 * the clause before the first `:` or `(` survives. `truncated_to_255` and friends carry a number
 * rather than a value and keep it.
 */
const reasonKey = (raw) => key(String(raw ?? "").split(/[:(]/)[0].trim() || "readback_mismatch");

/**
 * A Decision's `why` → a stable bucket, with every value stripped.
 *
 * The executor's failure clause is `the form would not take it (<reason>) — intended: <value>`;
 * only `<reason>`'s head survives. The vocabulary asks quote what the runner typed, so they
 * collapse to a key. Planner asks keep their leading clause, which names a missing *id*.
 */
export function failureReason(why) {
  const text = String(why ?? "").trim();
  if (!text) return "unknown";
  const set = SET_FAILED.exec(text);
  if (set) return `set_failed:${reasonKey(set[1])}`;
  if (/the form's own list has no entry for/i.test(text)) return "vocabulary:no_exact_match";
  if (/list showed nothing for/i.test(text)) return "vocabulary:empty_list";
  if (/the form has no control for this question/i.test(text)) return "no_control";
  if (/no value to set$/i.test(text)) return "no_value";
  if (/is not on disk/i.test(text)) return "missing_document";
  if (/^required, still empty/i.test(text) || /still empty after the fill pass/i.test(text)) return "required_still_empty";
  // A planner ask: the clause before the first em dash or parenthesis names the gap, not a value.
  return `plan:${key(text.split(/ [—(]/)[0])}`;
}

/**
 * Which half of the system an open row indicts.
 *   `dom`        the adapter drove a control and the form would not take it — a runner bug.
 *   `vocabulary` the widget's own live list had no entry to commit — arguably correct caution.
 *   `plan`       memory had no answer, so the user is asked. Often by design (`company_specific`
 *                questions are the user's, PLAN §2.1) and not a failure of the fill loop at all.
 */
export const kindOf = (reason) =>
  String(reason).startsWith("set_failed:") ? "dom" : String(reason).startsWith("vocabulary:") ? "vocabulary" : "plan";

/**
 * qid → the form's own label, recovered from wherever this run recorded one.
 *
 * A posting that ends `blocked` never reaches `settle()`, so `decisions.json` still describes an
 * earlier run (or does not exist) — and the failed writes that caused the block are then the only
 * evidence there is. Their labels survive in the Jev request rows, which carry the question text
 * the model was shown: `state.questions[qid].label` (canonical/saved-item stage) and
 * `state.rows[qid].question.label` (option stage).
 */
export function labelIndex(rows, decisions = []) {
  const labels = new Map();
  for (const row of rows) {
    if (row.op !== "jev_request") continue;
    for (const [qid, q] of Object.entries(row.state?.questions ?? {})) if (q?.label) labels.set(qid, q.label);
    for (const [qid, r] of Object.entries(row.state?.rows ?? {})) if (r?.question?.label) labels.set(qid, r.question.label);
  }
  for (const d of decisions) if (d?.qid && d.label) labels.set(d.qid, d.label);
  return labels;
}

/**
 * Everything the report knows about one posting's run.
 *
 * @param {{decisions:object[], trace:object[], since:number, status:string, usage:object}} args
 * @returns {{fields:object, controls:object[], failures:object[], screenshots:string[], phases:object}}
 */
export function summarize({ decisions = [], trace = [], since = 0, status = null } = {}) {
  const rows = withDurations(trace).filter((r) => at(r) >= since);
  // `--exercise-controls` writes to this same trace, stamped `bench_exercise: true`. Those are
  // bench-chosen values driven *after* this run's numbers were taken, so they are dropped here
  // rather than counted as a fill (src/bench/exercise.mjs, rule 1).
  const writes = rows.filter((r) => (r.op === "set" || r.op === "upload") && !r.bench_exercise);
  const labels = labelIndex(rows, decisions);
  const labelOf = (qid) => clipLabel(labels.get(qid) ?? "");

  const byQid = new Map(decisions.map((d) => [d.qid, d]));
  const counts = { total: decisions.length, filled: 0, check: 0, ask: 0, skipped: 0, draft: 0, failed: 0, from: "decisions" };
  for (const d of decisions) {
    if (d.action === "fill") counts.filled += 1;
    else if (d.action === "check") counts.check += 1;
    else if (d.action === "ask") counts.ask += 1;
    else if (d.action === "skip") counts.skipped += 1;
    else if (d.action === "draft") counts.draft += 1;
    if (d.readback && d.readback.ok === false) counts.failed += 1;
  }
  // A write the form rejected is a failure even when the row was later answered another way.
  counts.failed = Math.max(counts.failed, writes.filter((w) => w.ok === false).length);

  // A posting that ends `blocked` never reaches `settle()`, so nothing was frozen for this run.
  // The bench home is reused, so `decisions.json` may still hold a *previous* run's plan for the
  // same slug — reporting that as this run's fill would be the one failure mode that looks like
  // success. On `blocked`, the trace is the only witness this run left, so it wins outright.
  const stale = status === "blocked";
  if ((stale || !decisions.length) && (writes.length || rows.some((r) => r.op === "snapshot"))) {
    const required = rows.filter((r) => r.op === "snapshot").at(-1)?.required ?? 0;
    const touched = new Set(writes.map((w) => w.qid)).size;
    counts.from = "trace";
    counts.total = Math.max(required, touched);
    counts.check = 0;
    counts.ask = 0;
    counts.skipped = 0;
    counts.draft = 0;
    counts.filled = writes.filter((w) => w.ok).length;
    counts.failed = writes.filter((w) => !w.ok).length;
  }

  const buckets = new Map();
  for (const w of writes) {
    const name = classifyControl({ control: w.control, qid: w.qid, label: labels.get(w.qid) });
    const b = buckets.get(name) ?? { control: name, attempts: 0, ok: 0, fail: 0, ms: [], strategies: {}, mismatched: 0 };
    b.attempts += 1;
    if (w.ok) b.ok += 1;
    else b.fail += 1;
    if (typeof w.ms === "number") b.ms.push(w.ms);
    if (w.strategy) b.strategies[w.strategy] = (b.strategies[w.strategy] ?? 0) + 1;
    // The schema's guess overridden by live detection: the Greenhouse `multi_value_multi_select`
    // that renders as a react-select on one board and eleven checkboxes on the next.
    if (w.planned && w.planned !== w.control) b.mismatched += 1;
    buckets.set(name, b);
  }

  const controls = CONTROL_TYPES.filter((name) => buckets.has(name)).map((name) => {
    const b = buckets.get(name);
    return {
      control: name,
      attempts: b.attempts,
      ok: b.ok,
      fail: b.fail,
      ok_pct: b.attempts ? Math.round((b.ok / b.attempts) * 1000) / 10 : null,
      median_ms: median(b.ms),
      // The raw per-set times, so the cross-posting roll-up takes a real median rather than a
      // median of medians. Dropped from the Markdown; kept in the JSON record.
      ms: b.ms,
      ...(b.mismatched ? { replanned_from_schema: b.mismatched } : {}),
      ...(Object.keys(b.strategies).length ? { strategies: b.strategies } : {}),
    };
  });

  // Two witnesses, one list. A row the planner handed back carries the richer `why`; a write the
  // form rejected carries the adapter's own `reason` and is the *only* record when the run was
  // blocked before anything could be frozen. Same qid + same reason is one failure.
  const asked = decisions
    .filter((d) => d.action === "ask")
    .map((d) => {
      const reason = failureReason(d.why);
      return {
        reason,
        kind: kindOf(reason),
        qid: d.qid,
        label: clipLabel(d.label),
        // A planner ask never touched a control; `null` says so rather than claiming `unknown`.
        control: classifyControl({ control: d.control, qid: d.qid, label: d.label }, { unknownAs: null }),
        attempts: d.readback?.attempts ?? 0,
        // Which canonical question this row matched, and which class the planner gave it — the two
        // facts that decide whether an ask is a hole in memory or the user's question to answer.
        canon: d.canon ?? null,
        class: d.class ?? null,
        ...(d.shot ? { screenshot: d.shot } : {}),
      };
    });
  const rejected = writes
    .filter((w) => w.ok === false)
    .map((w) => ({
      reason: `set_failed:${reasonKey(w.reason)}`,
      kind: "dom",
      qid: w.qid,
      label: labelOf(w.qid),
      control: classifyControl({ control: w.control, qid: w.qid, label: labels.get(w.qid) }),
      attempts: w.attempts ?? 0,
      ...(w.shot ? { screenshot: w.shot } : {}),
    }));

  const failures = [];
  const seen = new Set();
  for (const f of [...asked, ...rejected]) {
    const id = `${f.qid}|${f.reason}`;
    if (seen.has(id)) continue;
    seen.add(id);
    failures.push(f);
  }

  const screenshots = [...new Set([...failures.map((f) => f.screenshot), ...rows.map((r) => r.shot)].filter(Boolean))];

  const probes = rows.filter((r) => r.op === "probe").map((r) => ({ qid: r.qid, label: labelOf(r.qid), control: r.control, options: r.options }));
  const execute = rows.filter((r) => r.op === "execute").at(-1) ?? null;
  const stopped = rows.find((r) => r.op === "blocked") ?? null;

  return {
    fields: counts,
    controls,
    failures,
    // Every row handed back to the user, kept apart from `failures` (which also carries writes the
    // form rejected and later recovered from). This is what the report's "asks by reason" counts.
    asks: asked,
    screenshots,
    probes,
    writes: writes.length,
    // AGENTS.md: the runner never touches an EEO/demographic control without an explicit
    // preference. Anything above 0 here is an invariant violation, not a slow control.
    eeo_writes: decisions.filter((d) => d.class === "sensitive" && d.readback).length,
    ms_execute: execute?.ms ?? null,
    ...(stopped ? { stopped: { reason: stopped.reason, detail: stopped.detail ?? null } } : {}),
  };
}

/** Roll per-posting control rows up into the report's second table. */
export function rollUpControls(postings) {
  const merged = new Map();
  for (const p of postings) {
    for (const row of p.controls ?? []) {
      const b = merged.get(row.control) ?? { control: row.control, attempts: 0, ok: 0, fail: 0, replanned: 0, ms: [] };
      b.attempts += row.attempts;
      b.ok += row.ok;
      b.fail += row.fail;
      b.replanned += row.replanned_from_schema ?? 0;
      if (Array.isArray(row.ms)) b.ms.push(...row.ms);
      merged.set(row.control, b);
    }
  }
  return CONTROL_TYPES.filter((name) => merged.has(name)).map((name) => {
    const b = merged.get(name);
    return {
      control: name,
      attempts: b.attempts,
      ok: b.ok,
      fail: b.fail,
      replanned: b.replanned,
      ok_pct: b.attempts ? Math.round((b.ok / b.attempts) * 1000) / 10 : null,
      median_ms: median(b.ms),
    };
  });
}

/**
 * Failure reasons across every posting, with up to three example labels.
 *
 * Ordered by `kind` before count: a handful of `dom` rows are the runner failing to drive a
 * widget, while a long tail of `plan` rows is usually the product working as designed (a
 * `company_specific` question *is* the user's to answer). Sorting purely by count buries the
 * three radio failures under twenty-two by-design asks.
 */
const KIND_ORDER = { dom: 0, vocabulary: 1, plan: 2 };

export function rankFailures(postings) {
  const merged = new Map();
  for (const p of postings) {
    for (const f of p.failures ?? []) {
      const row = merged.get(f.reason) ?? { reason: f.reason, kind: f.kind ?? kindOf(f.reason), count: 0, controls: new Set(), examples: [] };
      row.count += 1;
      if (f.control) row.controls.add(f.control);
      if (row.examples.length < 3 && f.label && !row.examples.some((e) => e.label === f.label)) {
        row.examples.push({ label: f.label, company: p.company ?? null });
      }
      merged.set(f.reason, row);
    }
  }
  return [...merged.values()]
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.count - a.count || a.reason.localeCompare(b.reason))
    .map((r) => ({ reason: r.reason, kind: r.kind, count: r.count, controls: [...r.controls].sort(), examples: r.examples }));
}

/**
 * The `exercised` rows of one posting, bucketed by control exactly like the fill rows — so the two
 * tables are read with the same vocabulary and a control that only `--exercise-controls` ever
 * reached is still named `date` and not `unknown`.
 *
 * A row this pass declined to drive (a `file`, a `tel`, a menu that rendered nothing) is not an
 * attempt and is counted separately, by the reason it was declined: "the bench had no honest value
 * for it" and "the widget failed" are different findings and must never share a column.
 */
export function exercisedControls(rows = []) {
  const buckets = new Map();
  const skipped = {};
  // A row whose widget is not what the schema said: the Ashby `Date` field that is a bare text
  // input. It is bucketed by what the DOM turned out to be (the whole point of the control table),
  // and credited *separately* to the control the plan expected, so "date: 0 attempts, untested"
  // and "date: driven, and it is a text input" stay tellable apart.
  const as_planned = {};
  for (const row of rows) {
    if (!row.exercised) {
      const why = String(row.why ?? "unknown").split(/[:(]/)[0].trim() || "unknown";
      skipped[why] = (skipped[why] ?? 0) + 1;
      continue;
    }
    const name = classifyControl({ control: row.control, qid: row.qid, label: row.label });
    const want = row.planned ? classifyControl({ control: row.planned, qid: row.qid, label: row.label }) : null;
    if (want && want !== name) {
      const p = (as_planned[want] ??= { attempts: 0, ok: 0, detected: {} });
      p.attempts += 1;
      if (row.ok) p.ok += 1;
      p.detected[name] = (p.detected[name] ?? 0) + 1;
    }
    const b = buckets.get(name) ?? { control: name, attempts: 0, ok: 0, fail: 0, ms: [], strategies: {}, reasons: {}, fallbacks: {} };
    b.attempts += 1;
    if (row.ok) b.ok += 1;
    else {
      b.fail += 1;
      b.reasons[row.reason ?? "readback_mismatch"] = (b.reasons[row.reason ?? "readback_mismatch"] ?? 0) + 1;
    }
    if (typeof row.ms === "number") b.ms.push(row.ms);
    if (row.strategy) b.strategies[row.strategy] = (b.strategies[row.strategy] ?? 0) + 1;
    // Why the bench had to choose the value itself instead of Jev ranking it. `jev_unavailable`
    // here means the model could not be reached at all — which once silently turned this whole
    // mode into "pick the middle entry", so it is a reported number, never a swallowed catch.
    if (row.fallback_why) b.fallbacks[row.fallback_why] = (b.fallbacks[row.fallback_why] ?? 0) + 1;
    buckets.set(name, b);
  }
  const controls = CONTROL_TYPES.filter((name) => buckets.has(name)).map((name) => {
    const b = buckets.get(name);
    return {
      control: name,
      attempts: b.attempts,
      ok: b.ok,
      fail: b.fail,
      ok_pct: b.attempts ? Math.round((b.ok / b.attempts) * 1000) / 10 : null,
      median_ms: median(b.ms),
      ms: b.ms,
      ...(Object.keys(b.strategies).length ? { strategies: b.strategies } : {}),
      ...(Object.keys(b.reasons).length ? { reasons: b.reasons } : {}),
      ...(Object.keys(b.fallbacks).length ? { fallbacks: b.fallbacks } : {}),
    };
  });
  return { controls, skipped, as_planned };
}

/** Exercised rows across every posting → the report's `exercised` table. */
export function rollUpExercised(postings) {
  const merged = new Map();
  const skipped = {};
  const asPlanned = {};
  for (const p of postings) {
    for (const row of p.exercised?.controls ?? []) {
      const b = merged.get(row.control) ?? { control: row.control, attempts: 0, ok: 0, fail: 0, ms: [], reasons: {}, strategies: {}, fallbacks: {} };
      b.attempts += row.attempts;
      b.ok += row.ok;
      b.fail += row.fail;
      if (Array.isArray(row.ms)) b.ms.push(...row.ms);
      for (const [reason, n] of Object.entries(row.reasons ?? {})) b.reasons[reason] = (b.reasons[reason] ?? 0) + n;
      for (const [s, n] of Object.entries(row.strategies ?? {})) b.strategies[s] = (b.strategies[s] ?? 0) + n;
      for (const [w, n] of Object.entries(row.fallbacks ?? {})) b.fallbacks[w] = (b.fallbacks[w] ?? 0) + n;
      merged.set(row.control, b);
    }
    for (const [why, n] of Object.entries(p.exercised?.skipped ?? {})) skipped[why] = (skipped[why] ?? 0) + n;
    for (const [name, row] of Object.entries(p.exercised?.as_planned ?? {})) {
      const a = (asPlanned[name] ??= { attempts: 0, ok: 0, detected: {} });
      a.attempts += row.attempts;
      a.ok += row.ok;
      for (const [got, n] of Object.entries(row.detected ?? {})) a.detected[got] = (a.detected[got] ?? 0) + n;
    }
  }
  const controls = CONTROL_TYPES.filter((name) => merged.has(name)).map((name) => {
    const b = merged.get(name);
    return {
      control: name,
      attempts: b.attempts,
      ok: b.ok,
      fail: b.fail,
      ok_pct: b.attempts ? Math.round((b.ok / b.attempts) * 1000) / 10 : null,
      median_ms: median(b.ms),
      // How the value was chosen: `jev_generic` is Jev's own ranking, `bench_median` is the bench
      // picking the middle entry itself. `fell_back` says why it had to — `none_of_these` is Jev
      // answering honestly that no option is generic; `jev_unavailable` means the model was never
      // reached, which is a broken run and not a measurement.
      picked_by: Object.entries(b.strategies)
        .sort((x, y) => y[1] - x[1])
        .map(([s, n]) => `${s}×${n}`),
      fell_back: Object.entries(b.fallbacks)
        .sort((x, y) => y[1] - x[1])
        .map(([w, n]) => `${w}×${n}`),
      reasons: Object.entries(b.reasons)
        .sort((x, y) => y[1] - x[1])
        .map(([reason, n]) => `${reason}×${n}`),
    };
  });
  return { controls, skipped, as_planned: asPlanned };
}

/** Canon kinds a pre-answering pass is supposed to have already answered (PLAN §2.7). */
export const ANSWERABLE_KINDS = new Set(["constant", "rule", "policy", "narrative"]);

/**
 * Every row handed back to the user, grouped by reason, with how many of them a *pre-answered*
 * memory should have covered.
 *
 * This is the round-two question. `rankFailures` says which reasons fire; it cannot say which of
 * them are the product working as designed. A row whose canonical question has
 * `kind_default ∈ {constant, rule, policy, narrative}` is one `scripts/answers.mjs` writes an
 * answer for, so an ask there is a gap in the runner. `company` and `never` are the user's by
 * design (PLAN §2.1), and a row that matched no canonical question at all is `—`: unknown, not no.
 *
 * @param {object[]} postings
 * @param {(ask:object) => string|null} canonKind qid/label → the canonical `kind_default`
 */
export function rankAsks(postings, canonKind = () => null) {
  const merged = new Map();
  for (const p of postings) {
    for (const a of p.asks ?? []) {
      const row = merged.get(a.reason) ?? {
        reason: a.reason,
        kind: a.kind ?? kindOf(a.reason),
        count: 0,
        answerable: 0,
        mapped: 0,
        classes: new Set(),
        kinds: new Set(),
        examples: [],
      };
      row.count += 1;
      if (a.class) row.classes.add(a.class);
      const kd = canonKind(a);
      if (kd) {
        row.mapped += 1;
        row.kinds.add(kd);
        if (ANSWERABLE_KINDS.has(kd)) row.answerable += 1;
      }
      if (row.examples.length < 3 && a.label && !row.examples.some((e) => e.label === a.label)) {
        row.examples.push({ label: a.label, company: p.company ?? null });
      }
      merged.set(a.reason, row);
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .map((r) => ({
      reason: r.reason,
      kind: r.kind,
      count: r.count,
      mapped: r.mapped,
      answerable: r.answerable,
      classes: [...r.classes].sort(),
      canon_kinds: [...r.kinds].sort(),
      examples: r.examples,
    }));
}
