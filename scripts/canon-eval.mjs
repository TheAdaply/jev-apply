#!/usr/bin/env node
// canon-eval — hold-out coverage for the canonical question bank (docs/PLAN.md §2.7, Q3).
//
//   node scripts/canon-eval.mjs [--holdout corpus/holdout.txt] [--limit N] [--concurrency 6] [--json]
//
// The 100 postings in `corpus/holdout.txt` were never opened by `canon-cluster.mjs`, so they are
// the only honest measure of what the bank does on a form it has not seen. Every question in them
// is mapped **exactly the way fill time maps it**: the same candidate set
// (`canonCandidates()` from src/jev/plan.mjs, keyed on the posting's own title and company), the
// same criterion lines (`canonCriterion()`), the same instructions, the same `none_of_these` exit,
// and the same gate (`src/jev/gates.mjs`), and — like fill time — demographic rows are never put
// in front of the selector at all (`classify() === "sensitive"`; AGENTS.md).
//
// Requests are *not* comparable to fill time's ≤2 per posting and the report prints the measured
// spread instead of claiming one. Each question carries the whole ~90-criterion Choice, so
// client.mjs's estimator (56k budget, 30 tokens per option) packs only a handful of questions per
// request; `apply.mjs` stays at one because `canonStage` sees the few rows the deterministic pass
// left open, while the eval maps every question on the form.
//
// Two numbers per bucket:
//   mapped      the field resolved to a canonical question the gate accepts (choice ≠ none_of_these
//               and confidence ≥ GATES.askBelow). This is the bank's reach.
//   answerable  mapped *and* that canonical question's `kind_default` is one the user can
//               pre-answer (constant | rule | policy | narrative). A field that maps to a `company`
//               or `never` question is correctly mapped and still ends as an ask, by design.
//
// Bucketing needs a layer even for a field that resolved to nothing, so a field's bucket is its
// recorded surface form first (`surfaceIndex()` — the label the bank already knows this question
// by, no model involved), then the pick, then the argmax over the real criteria. The bucket says
// which layer the field belongs to; `mapped` says whether the bank could act on it. Without the
// surface index every "Race" / "Gender" row lands in whichever core question its distribution
// peaked on: the EEO layer is deliberately not a candidate (AGENTS.md — the runner skips those
// rows unless `p.eeo_policy` exists), and a section the runner never touches must not be scored
// as a core coverage miss.
//
// Targets (PLAN §2.7): core ≥ 95% · screening ≥ 85% · narrative ≥ 80%. Actuals are printed as
// measured — a miss is reported, never rounded away.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonCandidates,
  canonCriterion,
  indexByQid,
  isPreAnswerable,
  loadCanon,
  qidOf,
  surfaceIndex,
  TARGETS,
  targetGroup,
} from "../src/canon/index.mjs";
import { normalizeLabel } from "../src/canon/normalize.mjs";
import { NONE, choice, closeJevClient, systemOne, withNone } from "../src/jev/client.mjs";
import { GATES } from "../src/jev/gates.mjs";
import { stamp } from "../src/memory/schema.mjs";
import { classify } from "../src/schema/classes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

/** ≤255 options per Choice (client.mjs MAX_CHOICES); plan.mjs caps its candidate list the same way. */
const MAX_CANDIDATES = 200;
/** Long help text is clipped exactly as `fieldState` in src/jev/plan.mjs clips it. */
const HELP_CHARS = 400;
const MAX_OPTIONS = 25;
/** Pause before the single retry of a posting whose batch failed (the 429 this run actually hit). */
const RETRY_PAUSE_MS = 1500;

// ───────────────────────────────────────── cli ────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    holdout: path.join(REPO, "corpus", "holdout.txt"),
    out: path.join(REPO, "canon"),
    limit: Infinity,
    concurrency: 6,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--holdout") args.holdout = path.resolve(next());
    else if (a === "--out") args.out = path.resolve(next());
    else if (a === "--limit") args.limit = Number(next());
    else if (a === "--concurrency") args.concurrency = Number(next());
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      process.stderr.write("usage: canon-eval.mjs [--holdout FILE] [--limit N] [--concurrency N] [--out DIR] [--json]\n");
      process.exit(0);
    } else throw new Error(`unknown flag: ${a}`);
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) throw new Error("--concurrency must be ≥ 1");
  if (!(args.limit > 0)) throw new Error("--limit must be ≥ 1");
  return args;
}

const log = (msg) => process.stderr.write(`${msg}\n`);

// ────────────────────────────────────── hold-out ──────────────────────────────────────────────

/** The hold-out list holds repo-relative paths, one per line (`corpus/<ats>/<family>/<file>.json`). */
async function loadHoldout(file, limit) {
  const raw = await readFile(file, "utf8");
  const rel = raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  const postings = [];
  for (const entry of rel.slice(0, Number.isFinite(limit) ? limit : rel.length)) {
    const full = path.resolve(REPO, entry);
    const posting = JSON.parse(await readFile(full, "utf8"));
    postings.push({ ...posting, file: entry });
  }
  return { postings, available: rel.length };
}

// ─────────────────────────────────── the fill-time ask ────────────────────────────────────────

const clip = (s, n) => {
  const text = String(s ?? "").replace(/\s+/g, " ").trim();
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};

/** What Jev is shown about one field — the same keys `fieldState()` in src/jev/plan.mjs sends. */
function fieldState(q) {
  const options = (q.options ?? []).map((o) => (typeof o === "string" ? o : o?.label)).filter(Boolean);
  return {
    label: q.label,
    type: q.type,
    ...(q.section ? { section: q.section } : {}),
    ...(q.help ? { help: clip(q.help, HELP_CHARS) } : {}),
    ...(q.limits ? { limits: q.limits } : {}),
    ...(options.length ? { options: options.slice(0, MAX_OPTIONS) } : {}),
  };
}

/** Word for word the instruction `canonStage()` sends (src/jev/plan.mjs). */
const INSTRUCTIONS = (qid) =>
  `Which canonical question is \`questions.${qid}\` an instance of? Pick the one asking for the same information.`;

/** The most likely *real* canonical id, ignoring the none_of_these exit. */
function argmaxCanon(probabilities) {
  let best = null;
  let bestP = -1;
  for (const [id, p] of Object.entries(probabilities ?? {})) {
    if (id === NONE) continue;
    if (typeof p === "number" && p > bestP) {
      bestP = p;
      best = id;
    }
  }
  return best;
}

/**
 * Map one posting's questions, exactly as step 5 of the runner pipeline does — including what it
 * refuses to ask about.
 *
 * A demographic field is never sent to the selector. `resolveForm` routes `class: "sensitive"` to
 * `sensitiveRow()`, which skips the row with `_open: false`, so `canonStage` never sees it; the
 * EEO layer is not in the candidate set either. Asking about it here would be both unfaithful to
 * the path this is supposed to mirror and a demographic question put in front of a model for no
 * reason. Those rows are counted, bucketed as `eeo`, and reported outside the §2.7 targets.
 *
 * `surface` only ever *buckets* a field — which canonical question, and therefore which layer, the
 * field really is — never decides whether it mapped.
 *
 * @returns {Promise<{rows: object[], requests: number, ms: number, usage: object, error?: string}>}
 */
async function mapPosting(posting, canon, surface, { signal } = {}) {
  const candidates = canonCandidates(canon, { title: posting.title, company: posting.company });
  const all = (posting.questions ?? []).filter((q) => q?.label);
  const bucketOf = (q, picked, probabilities) => surface.get(normalizeLabel(q.label)) ?? picked ?? argmaxCanon(probabilities);

  const skipped = [];
  const questions = [];
  for (const q of all) {
    if (classify(q.label, q.help, q.type, q.required) === "sensitive") {
      skipped.push({ label: q.label, type: q.type, picked: null, mapped: false, sensitive: true, reason: "sensitive — never sent to the selector" });
    } else questions.push(q);
  }

  if (!candidates.length || !questions.length) {
    return {
      rows: [...skipped, ...questions.map((q, i) => ({ qid: `q${i}`, label: q.label, picked: null, mapped: false, bucketQid: bucketOf(q, null, null), reason: "no candidates" }))],
      requests: 0,
      ms: 0,
      usage: {},
    };
  }

  const criteria = {};
  for (const row of candidates.slice(0, MAX_CANDIDATES)) criteria[qidOf(row)] = canonCriterion(row);
  const withExit = withNone(criteria, "This field matches none of the canonical questions");

  const state = { job: { title: posting.title ?? "", company: posting.company ?? "", ...(posting.location ? { location: posting.location } : {}) }, questions: {} };
  const ask = {};
  const byId = new Map();
  questions.forEach((q, i) => {
    const qid = `q${i}`;
    byId.set(qid, q);
    state.questions[qid] = fieldState(q);
    ask[`canon_${qid}`] = choice(INSTRUCTIONS(qid), withExit);
  });

  // One retry, then the posting's rows count as unmapped rather than taking the run down with
  // them (same rule as `askBatched` in canon-cluster.mjs). A 429 dropped mid-run would otherwise
  // silently move a whole family's coverage number.
  let res;
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      res = await systemOne({ state, questions: ask, signal });
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (attempt === 1) await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
    }
  }
  if (lastError) {
    return {
      rows: [...skipped, ...[...byId].map(([qid, q]) => ({ qid, label: q.label, picked: null, mapped: false, bucketQid: bucketOf(q, null, null), reason: "request failed" }))],
      requests: 0,
      ms: 0,
      usage: {},
      error: lastError?.message ?? String(lastError),
    };
  }

  const rows = [...byId].map(([qid, q]) => {
    const answer = res.answers[`canon_${qid}`];
    const confidence = typeof answer?.confidence === "number" ? answer.confidence : 0;
    const picked = answer?.choice === NONE ? null : (answer?.choice ?? null);
    // The bank's own gate: none_of_these or a confidence the runner would refuse → not mapped.
    const mapped = picked != null && confidence >= GATES.askBelow;
    return {
      qid,
      label: q.label,
      type: q.type,
      picked,
      confidence,
      mapped,
      bucketQid: bucketOf(q, picked, answer?.probabilities),
      reason: picked == null ? "none_of_these" : mapped ? "" : `confidence ${confidence.toFixed(2)} < ${GATES.askBelow}`,
    };
  });
  return { rows: [...skipped, ...rows], requests: res.requests, ms: res.ms, usage: res.usage };
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// ──────────────────────────────────── tallying ────────────────────────────────────────────────

const emptyCell = () => ({ instances: 0, mapped: 0, answerable: 0 });

function bump(table, key, row, answerable) {
  const cell = table.get(key) ?? emptyCell();
  cell.instances += 1;
  if (row.mapped) cell.mapped += 1;
  if (row.mapped && answerable) cell.answerable += 1;
  table.set(key, cell);
}

const pct = (n, d) => (d ? (n / d) * 100 : 0);
const fmt = (n, d) => (d ? `${pct(n, d).toFixed(1)}%` : "—");

function tally(results, canon) {
  const bank = indexByQid(canon);
  const byLayer = new Map();
  const byGroup = new Map();
  const byAts = new Map();
  const byFamily = new Map();
  const overall = emptyCell();
  const unmapped = new Map();
  const perPosting = [];
  let requests = 0;
  let ms = 0;
  let failedPostings = 0;

  for (const { posting, result } of results) {
    requests += result.requests;
    if (result.requests) perPosting.push(result.requests);
    ms += result.ms;
    if (result.error) failedPostings += 1;
    for (const row of result.rows) {
      // A skipped demographic row has no canonical question by design, so it is placed directly.
      const definition = row.sensitive ? null : row.bucketQid ? bank.get(row.bucketQid) : null;
      const layer = row.sensitive ? "eeo" : definition ? String(definition.layer ?? "core") : "unbucketed";
      const group = row.sensitive ? "eeo" : definition ? targetGroup(definition) : "unbucketed";
      const answerable = definition ? isPreAnswerable(definition) : false;

      overall.instances += 1;
      if (row.mapped) overall.mapped += 1;
      if (row.mapped && answerable) overall.answerable += 1;

      bump(byLayer, layer, row, answerable);
      bump(byGroup, group, row, answerable);
      bump(byAts, posting.ats ?? "unknown", row, answerable);
      bump(byFamily, posting.family ?? "unknown", row, answerable);
      if (!row.mapped) {
        const seen = unmapped.get(row.label) ?? { n: 0, layer };
        unmapped.set(row.label, { n: seen.n + 1, layer });
      }
    }
  }
  return { byLayer, byGroup, byAts, byFamily, overall, unmapped, requests, perPosting, ms, failedPostings };
}

// ───────────────────────────────────── reporting ──────────────────────────────────────────────

const sortRows = (table) => [...table.entries()].sort((a, b) => b[1].instances - a[1].instances || a[0].localeCompare(b[0]));

/**
 * PLAN §2.7 states the target as "% of form questions mapped to a canonical question **that has an
 * answer**", so the target is scored on the `answerable` column. `mapped` carries its own mark
 * beside it — the bank's reach and the user's readiness are different numbers and a table that
 * showed one mark for both would claim the easier one.
 */
function section(title, table, { targets = null } = {}) {
  const mark = (n, d, target) => (target == null ? fmt(n, d) : `${fmt(n, d)} ${pct(n, d) >= target * 100 ? "✓" : "✗"}`);
  const lines = [`| ${title} | instances | mapped | answerable |${targets ? " target |" : ""}`];
  lines.push(`|---|---:|---:|---:|${targets ? "---:|" : ""}`);
  for (const [key, cell] of sortRows(table)) {
    const target = targets?.[key];
    lines.push(
      `| ${key} | ${cell.instances} | ${mark(cell.mapped, cell.instances, target)} | ${mark(cell.answerable, cell.instances, target)} |` +
        (targets ? ` ${target == null ? "—" : `${(target * 100).toFixed(0)}%`} |` : ""),
    );
  }
  return lines.join("\n");
}

function report(t, { postings, available, limit, canon, ms, started }) {
  const out = [];
  out.push(`canon-eval · ${postings} of ${available} hold-out postings · ${t.overall.instances} question instances · ${canon.questions.length} canonical questions`);
  const spread = t.perPosting.length ? `${Math.min(...t.perPosting)}–${Math.max(...t.perPosting)}` : "0";
  out.push(
    `${t.requests} Jev request(s) · ${(t.requests / Math.max(postings, 1)).toFixed(2)} per posting (${spread}) · ` +
      `${((Date.now() - started) / 1000).toFixed(1)} s wall · ${(ms / 1000).toFixed(1)} s model`,
  );
  if (t.failedPostings) out.push(`${t.failedPostings} posting(s) failed and are counted as unmapped`);
  out.push("");
  out.push("PLAN §2.7 targets");
  out.push(section("group", t.byGroup, { targets: TARGETS }));
  out.push("");
  out.push("by layer");
  out.push(section("layer", t.byLayer));
  out.push("");
  out.push("by ATS");
  out.push(section("ats", t.byAts));
  out.push("");
  out.push("by family");
  out.push(section("family", t.byFamily));
  out.push("");
  out.push(`overall  mapped ${fmt(t.overall.mapped, t.overall.instances)} · answerable ${fmt(t.overall.answerable, t.overall.instances)} of ${t.overall.instances} instances`);
  return out.join("\n");
}

const REPORT_HEAD = ({ date, postings, available, limit }) => `# canon coverage — hold-out ${date}

Measured by \`scripts/canon-eval.mjs\` on ${postings} of the ${available} postings in
\`corpus/holdout.txt\`${Number.isFinite(limit) ? ` (\`--limit ${limit}\`)` : ""} — postings \`canon-cluster.mjs\` never opened.

Each question is mapped the way \`scripts/apply.mjs\` maps it: \`canonCandidates()\` over the
posting's own title and company, \`canonCriterion()\` for the criteria text, one \`choice\` per field
with an explicit \`none_of_these\`, and \`src/jev/gates.mjs\` deciding whether the answer is usable.

- **mapped** — the field resolved to a canonical question the gate accepts (\`choice ≠ none_of_these\`
  and \`confidence ≥ ${GATES.askBelow}\`). This is the bank's reach.
- **answerable** — mapped *and* that canonical question's \`kind_default\` is one the user can
  pre-answer (\`constant\` · \`rule\` · \`policy\` · \`narrative\`). \`company\` answers are written at queue
  time and \`never\` answers are never auto-filled, so both are mapped-but-still-an-ask by design.

**The targets score \`answerable\`.** PLAN §2.7 states them as "% of form questions mapped to a
canonical question *that has an answer*", so a question the bank recognises but cannot pre-answer
is not coverage. \`mapped\` carries its own mark beside it because the two numbers fail for
different reasons: a low \`mapped\` means the bank is missing a question, a high \`mapped\` with a low
\`answerable\` means the question is one only the posting or the user can answer.

A field is put in a layer/group row by the label the bank already knows it under (its recorded
\`surface_forms\`, no model involved), then by what it mapped to, then by the argmax over the real
criteria — so a field that mapped to nothing still lands in the right layer. The bucket says where
the field belongs; \`mapped\` says whether the bank could act on it.

The \`eeo\` row is not one of the three targets and never will be. A field \`classify()\` calls
\`sensitive\` is not asked about at all — \`src/plan/resolve.mjs\` skips the whole demographic section
unless \`p.eeo_policy\` states otherwise, so \`canonStage\` never sees one and neither does this eval.
Those instances are counted and shown, with \`mapped\` at 0 because nothing was asked, and excluded
from the score.

Requests per posting are printed as measured and are **not** comparable to the runner's ≤ 2: every
question here carries the whole candidate list, while \`apply.mjs\` sends only the rows its
deterministic pass left open.
`;

// ──────────────────────────────────────── main ────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();

  const canon = await loadCanon(path.join(REPO, "canon"));
  if (!canon) throw new Error("canon/questions.yaml is missing — run scripts/canon-cluster.mjs first");
  const surface = surfaceIndex(canon);
  const { postings, available } = await loadHoldout(args.holdout, args.limit);
  if (!postings.length) throw new Error(`${args.holdout} lists no postings`);
  log(`canon-eval: ${postings.length} of ${available} hold-out postings · ${canon.questions.length} canonical questions`);

  let done = 0;
  const results = await mapPool(postings, args.concurrency, async (posting) => {
    const result = await mapPosting(posting, canon, surface);
    done += 1;
    if (done % 10 === 0 || done === postings.length) log(`canon-eval: ${done}/${postings.length} postings mapped`);
    if (result.error) log(`canon-eval: ${posting.file} failed — ${result.error}`);
    return { posting, result };
  });

  const t = tally(results, canon);
  const text = report(t, { postings: postings.length, available, limit: args.limit, canon, ms: t.ms, started });

  const date = stamp();
  const file = path.join(args.out, `eval-${date}.md`);
  const worst = [...t.unmapped.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 20);
  await mkdir(args.out, { recursive: true });
  await writeFile(
    file,
    [
      REPORT_HEAD({ date, postings: postings.length, available, limit: args.limit }),
      "",
      "```",
      text,
      "```",
      "",
      "## Labels that mapped to nothing",
      "",
      worst.length ? "| label | layer | instances |\n|---|---|---:|" : "_none_",
      ...worst.map(([label, hit]) => `| ${String(label).replace(/\|/g, "\\|").slice(0, 110)} | ${hit.layer} | ${hit.n} |`),
      "",
      `Regenerate: \`node scripts/canon-eval.mjs${Number.isFinite(args.limit) ? ` --limit ${args.limit}` : ""}\``,
      "",
    ].join("\n"),
    "utf8",
  );

  await closeJevClient();

  if (args.json) {
    const asObject = (table) => Object.fromEntries([...table].map(([k, c]) => [k, { ...c, mapped_pct: Number(pct(c.mapped, c.instances).toFixed(1)), answerable_pct: Number(pct(c.answerable, c.instances).toFixed(1)) }]));
    process.stdout.write(
      `${JSON.stringify({
        status: "ready_to_submit",
        postings: postings.length,
        instances: t.overall.instances,
        requests: t.requests,
        groups: asObject(t.byGroup),
        layers: asObject(t.byLayer),
        ats: asObject(t.byAts),
        families: asObject(t.byFamily),
        report: file,
      })}\n`,
    );
    return;
  }
  process.stdout.write(`${text}\n\nwrote ${path.relative(REPO, file)}\n`);
}

main().catch((err) => {
  log(`canon-eval failed: ${err.stack ?? err.message}`);
  process.exit(1);
});
