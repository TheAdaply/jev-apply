// The benchmark's private home: a complete, entirely invented candidate.
//
// `scripts/bench.mjs` fills real ATS forms to measure how well the runner drives their controls.
// It must never put the user's real name, email, phone or CV on somebody's careers page, and it
// must never read the user's real memory to decide what to type — so the bench runs against its
// own `JEV_APPLY_HOME` (default `/tmp/jev-bench`) holding the store below.
//
// Every value here is fictional. The person, the employer, the university, the phone number and
// the links do not exist; the CV is `eval/fixtures/blank.pdf`, an empty one-page PDF. The only
// thing this home does *not* contain is credentials: `TYPESAFE_API_KEY`/`OPENAI_API_KEY` stay in
// `~/.config/jev-apply/env` and reach the child process through its environment, never a file
// under `/tmp` (AGENTS.md: "Never print, log, or commit key material").
//
// The store is deliberately *complete* — the six day-1 questionnaire items (PLAN §2.4) are all
// answered, work authorization is two-valued for three countries, and the policy/EEO stances
// exist — so that an `ask` the bench records is a genuine gap in the runner, not a hole in this
// file. Idempotent: re-running rewrites the same bytes and leaves `applications/` alone.

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { REPO_ROOT } from "../config.mjs";

/** Stamped into every row so `updated` never drifts between runs (idempotence). */
const SEEDED = "2026-09-01";

/** The invented CV: an empty PDF, so an upload that "works" proves the control, not the content. */
export const BENCH_CV = path.join(REPO_ROOT, "eval", "fixtures", "blank.pdf");

const fact = (id, value, extra = {}) => ({ id, value, source: "user", updated: SEEDED, ...extra });

function facts() {
  return [
    fact("f.identity.full_name", "Robin Sanchez"),
    fact("f.identity.preferred_name", "Robin"),
    fact("f.identity.email", "robin.sanchez@bench.invalid"),
    fact("f.identity.phone", "+351912000000"),
    fact("f.identity.city", "Lisbon"),
    fact("f.identity.location", "Lisbon, Portugal"),
    fact("f.identity.address", "Rua Inventada 12, 1200-192 Lisboa, Portugal"),
    fact("f.identity.timezone", "Europe/Lisbon"),
    fact("f.identity.github_url", "https://github.com/bench-robin-sanchez"),
    fact("f.identity.linkedin_url", "https://www.linkedin.com/in/bench-robin-sanchez"),
    fact("f.identity.site_url", "https://bench-robin-sanchez.invalid"),
    fact("f.identity.portfolio_url", "https://bench-robin-sanchez.invalid/work"),
    fact("f.identity.x_twitter_url", "https://x.com/bench_robin"),
    fact("f.identity.publications_url", "https://bench-robin-sanchez.invalid/papers"),
    fact("f.identity.scholar_url", "https://scholar.google.com/citations?user=BENCHROBIN"),
    fact("f.employment.current", "Northwind Compute"),
    fact("f.employment.current_title", "Senior Inference Engineer"),
    fact("f.education.school", "University of Coimbra"),
    fact("f.education.field", "Computer Science"),
    fact("f.education.degree", "MSc"),

    // Full-time years drive the salary level; only `employment_type: full_time` counts.
    fact("f.employment.northwind", { role: "Senior Inference Engineer", employment_type: "full_time" }, { since: "2021-06" }),
    fact("f.employment.lumenbyte", { role: "Backend Engineer", employment_type: "full_time", until: "2021-05" }, { since: "2018-09" }),

    // `since:` so "years of X" is computed at fill time and never goes stale.
    fact("f.skill.python", "Python", { since: "2016-09" }),
    fact("f.skill.pytorch", "PyTorch", { since: "2019-01" }),
    fact("f.skill.cuda", "CUDA", { since: "2021-03" }),
    fact("f.skill.distributed_systems", "Distributed systems", { since: "2019-09" }),
    fact("f.skill.llm_inference", "LLM inference", { since: "2022-04" }),

    // Two-valued per target country (PLAN §2.4). GB is the code `countryFor()` produces for the UK.
    fact("f.work_auth.PT", { authorized_now: true, needs_sponsorship_future: false, status: "citizen" }),
    fact("f.work_auth.DE", { authorized_now: true, needs_sponsorship_future: false, status: "EU citizen" }),
    fact("f.work_auth.US", { authorized_now: false, needs_sponsorship_future: true, status: "would need H-1B sponsorship" }),
    fact("f.work_auth.GB", { authorized_now: false, needs_sponsorship_future: true, status: "would need a Skilled Worker visa" }),
    fact("f.work_auth.default", { authorized_now: false, needs_sponsorship_future: true, status: "needs sponsorship" }),

    fact("f.identity.pronouns", "they/them"),
    fact("f.identity.start_date", "2026-11-02"),
  ];
}

/** The six day-1 answers plus the stances that are otherwise lazily asked at first sight. */
const preferences = ({ eeo = false } = {}) => [
  ...(eeo
    ? [{ id: "p.eeo_policy", value: { answer: "Decline to self-identify" }, source: "user", updated: SEEDED }]
    : []),
  { id: "p.notice_rule", value: { kind: "weeks", weeks: 4, text: "4 weeks' notice" }, source: "user", updated: SEEDED },
  {
    id: "p.salary",
    value: { mode: "market_average", prefer_posting_range: "midpoint", state_end: "mid", baselines: "salary-baselines.yaml" },
    source: "user",
    updated: SEEDED,
  },
  {
    id: "p.looking_for",
    value: {
      target_roles: ["ml_engineer"],
      role_families: {
        ml_engineer: ["machine learning engineer", "inference engineer", "research engineer", "performance engineer", "gpu engineer"],
      },
      must_haves: ["remote-friendly"],
      dealbreakers: ["unpaid on-call"],
      acceptable_locations: { rule: "any_country_except", except: [] },
    },
    source: "user",
    updated: SEEDED,
  },
  { id: "p.resume_by_role_family", value: { default: "doc.resume.bench" }, source: "user", updated: SEEDED },
  { id: "p.contact", value: { email: "robin.sanchez@bench.invalid", phone: "+351912000000" }, source: "user", updated: SEEDED },
  // No `p.eeo_policy` on purpose. Without one the resolver *skips* every demographic row
  // (PLAN D10, and the product's default), which is what the bench wants to measure: opting in
  // made Greenhouse's demographic react-selects the first thing the runner touched, three of
  // them returned `no_options_rendered`, and the `no_progress` stop rule ended the run before a
  // single application question was reached. The EEO block is its own experiment, not this one.
  { id: "p.relocation", value: { willing: true }, source: "user", updated: SEEDED },
  { id: "p.in_office", value: { answer: "Yes" }, source: "user", updated: SEEDED },
  { id: "p.how_heard", value: "Company careers page", source: "user", updated: SEEDED },
  { id: "p.age_18", value: "Yes", source: "user", updated: SEEDED },
  { id: "p.arbitration", value: "Yes", source: "user", updated: SEEDED },
  { id: "p.ai_usage", value: "No", source: "user", updated: SEEDED },
  { id: "p.application_truthful", value: "Yes", source: "user", updated: SEEDED },
  { id: "p.background_check", value: "Yes", source: "user", updated: SEEDED },
  { id: "p.privacy_consent", value: "Yes", source: "user", updated: SEEDED },
  { id: "p.recording_consent", value: "Yes", source: "user", updated: SEEDED },
  { id: "p.restrictive_agreements", value: "No", source: "user", updated: SEEDED },
  { id: "p.export_control", value: "No", source: "user", updated: SEEDED },
  { id: "p.government_official", value: "No", source: "user", updated: SEEDED },
  { id: "p.conflict_of_interest", value: "No", source: "user", updated: SEEDED },
  { id: "p.accommodation", value: "No", source: "user", updated: SEEDED },
];

const answers = () => [
  { qid: "q.circumstance.notice_period", kind: "rule", rule_ref: "p.notice_rule", scope: "global", source: "user", reviewed: true, updated: SEEDED },
  { qid: "q.core.how_heard", kind: "constant", value: "Company careers page", scope: "global", source: "user", reviewed: true, updated: SEEDED },
  { qid: "q.core.start_date", kind: "constant", value: "2026-11-02", scope: "global", source: "user", reviewed: true, updated: SEEDED },
  {
    qid: "q.narrative.proudest_project",
    kind: "narrative",
    variants: {
      short: "I cut p99 latency on Northwind Compute's inference gateway by 62% by batching at the scheduler instead of the model server.",
      medium:
        "At Northwind Compute I owned the inference gateway that fronts our hosted models. p99 latency had crept to 840 ms because every request was batched inside the model server, where the queue could not see request shape. I moved batching up into the scheduler, keyed on sequence length, and cut p99 to 320 ms without adding a GPU. The change shipped behind a flag and ran on 4 of 9 clusters for two weeks before the full rollout.",
      long: "At Northwind Compute I owned the inference gateway that fronts our hosted models. p99 latency had crept to 840 ms under a load pattern nobody had designed for: a long tail of 8k-token requests sharing a batch with thousands of 200-token ones. Batching happened inside the model server, which could not see the shape of what was queued behind it. I moved batching into the scheduler and keyed it on sequence length, so short requests stopped waiting on long ones. p99 fell to 320 ms on the same hardware and throughput rose 18%. The riskiest part was the rollout: I shipped it behind a flag, ran it on 4 of 9 clusters for two weeks, and compared per-cluster latency histograms before turning it on everywhere.",
    },
    family: "ml_engineer",
    scope: "global",
    source: "user",
    reviewed: true,
    updated: SEEDED,
  },
  {
    qid: "q.narrative.hardest_problem",
    kind: "narrative",
    variants: {
      short: "Chasing a CUDA illegal-memory-access that only reproduced under multi-tenant load on one GPU model.",
      medium:
        "A fused attention kernel crashed with an illegal memory access roughly once a day, only on A100s, only when two tenants shared the device. I bisected by replaying captured traffic, found a shared-memory offset computed from the batch's max sequence length rather than the per-request one, and fixed the indexing. The repro harness stayed in CI.",
      long: "A fused attention kernel crashed with an illegal memory access about once a day, only on A100s, and only when two tenants shared the device — the sort of failure where the stack trace names the wrong kernel. I built a replay harness that captured production request mixes and fed them back at 20x, which turned a daily crash into a five-minute one. From there it bisected quickly: a shared-memory offset was computed from the batch's max sequence length instead of the per-request length, so any batch mixing a 4k request with 128-token ones wrote past its tile. I fixed the indexing, added a bounds assert behind a debug flag, and kept the replay harness in CI, where it has caught two more indexing regressions since.",
    },
    family: "ml_engineer",
    scope: "global",
    source: "user",
    reviewed: true,
    updated: SEEDED,
  },
];

const stories = () => [
  {
    id: "b.story.gateway_latency",
    kind: "story",
    title: "Cut inference-gateway p99 by 62% — describe a performance project you are proud of",
    text: "Moved batching from the model server up into the scheduler and keyed it on sequence length; p99 fell from 840 ms to 320 ms on the same hardware and throughput rose 18%.",
    tags: ["performance", "inference", "scheduling"],
    source: "user",
  },
  {
    id: "b.story.cuda_illegal_access",
    kind: "story",
    title: "Debugged a multi-tenant CUDA illegal memory access — describe the hardest problem you solved",
    text: "A fused attention kernel wrote past its shared-memory tile whenever a batch mixed a 4k-token request with short ones. A 20x replay harness turned a daily crash into a five-minute repro.",
    tags: ["cuda", "debugging", "kernels"],
    source: "user",
  },
  {
    id: "b.story.oss_kv_cache",
    kind: "story",
    title: "Upstreamed a paged KV-cache eviction policy — describe an open-source contribution",
    text: "Contributed a length-aware eviction policy to an open-source serving stack; it cut cache thrash on long-context workloads and shipped in the following release.",
    tags: ["open-source", "kv-cache"],
    source: "user",
  },
  {
    id: "b.answer.why_inference",
    kind: "answer",
    title: "Why inference work — what are you looking for",
    text: "I want to keep working where the model meets the machine: schedulers, kernels and the cost per token, on a team that ships its own serving stack rather than renting one.",
    tags: ["motivation"],
    source: "user",
  },
  {
    id: "b.answer.team_conflict",
    kind: "answer",
    title: "Disagreed with a colleague over a rollout — describe a conflict and how you resolved it",
    text: "A teammate wanted to ship the batching change everywhere at once. We agreed on a two-week flagged rollout on 4 of 9 clusters and a histogram comparison as the decision rule, which settled it with data instead of seniority.",
    tags: ["collaboration"],
    source: "user",
  },
];

/** The market table `salaryFor` reads. Invented numbers for an invented person. */
const BASELINES = `# Synthetic salary table for the jev-apply benchmark. Invented numbers, invented person.
rule:
  state: mid
  when_posting_publishes_range: midpoint_of_posting_range
  when_market_unknown: ask
  never: personal_number
  basis: annual_base
markets:
  us_sf: ["san francisco", "sf bay", "bay area", "palo alto", "mountain view", "menlo park"]
  us_nyc: ["new york", "nyc", "manhattan", "brooklyn"]
  eu_remote: ["lisbon", "portugal", "remote", "europe", "emea"]
  uk_london: ["london", "united kingdom"]
  de_berlin: ["berlin", "munich", "germany"]
rows:
  - {role_family: ml_engineer, level: senior, market: us_sf, currency: USD, low: 210000, mid: 245000, high: 280000, basis: annual_base, checked: 2026-09-01}
  - {role_family: ml_engineer, level: senior, market: us_nyc, currency: USD, low: 195000, mid: 225000, high: 260000, basis: annual_base, checked: 2026-09-01}
  - {role_family: ml_engineer, level: senior, market: eu_remote, currency: EUR, low: 95000, mid: 115000, high: 135000, basis: annual_base, checked: 2026-09-01}
  - {role_family: ml_engineer, level: senior, market: uk_london, currency: GBP, low: 95000, mid: 115000, high: 135000, basis: annual_base, checked: 2026-09-01}
  - {role_family: ml_engineer, level: senior, market: de_berlin, currency: EUR, low: 100000, mid: 120000, high: 140000, basis: annual_base, checked: 2026-09-01}
`;

const HEADER = (section) =>
  `# ${section}.yaml — SYNTHETIC benchmark data (scripts/bench.mjs). Not a real person.\n# Regenerated by src/bench/synthetic.mjs; edit that file, not this one.\n`;

async function writeSection(home, name, rows) {
  const file = path.join(home, "memory", `${name}.yaml`);
  await writeFile(file, `${HEADER(name)}${YAML.stringify(rows, { lineWidth: 0 })}`, { mode: 0o600 });
  return file;
}

/** Stable key for an `answers.yaml` row: a narrative is stored once per role family. */
const answerKey = (row) => `${row?.qid}|${row?.family ?? ""}`;

/**
 * `answers.yaml` is the one section this file does not own outright. `seedAnswers` runs the real
 * `scripts/answers.mjs` on top of it, and on the bench's twelve families that is 77 narrative rows
 * the OpenAI writer was paid to author — so the six hand-written rows below are *merged* over
 * whatever is already there instead of replacing the file. A fresh home still gets exactly the
 * same bytes; a warm home keeps its seeding, which is what makes two bench runs in a row cheap.
 */
async function mergeAnswerSection(home, rows) {
  const file = path.join(home, "memory", "answers.yaml");
  let existing = [];
  try {
    const parsed = YAML.parse(await readFile(file, "utf8"));
    if (Array.isArray(parsed)) existing = parsed;
  } catch {
    /* absent or unreadable: the synthetic rows are the whole file */
  }
  const own = new Set(rows.map(answerKey));
  const out = [...rows, ...existing.filter((row) => !own.has(answerKey(row)))];
  await writeFile(file, `${HEADER("answers")}${YAML.stringify(out, { lineWidth: 0 })}`, { mode: 0o600 });
  return file;
}

/**
 * Create (or refresh) the benchmark home. Idempotent: the same bytes every time, and nothing
 * under `applications/` is touched, so a bench run's artifacts survive the next setup.
 *
 * `eeo: true` adds the global EEO stance, which turns every demographic row from `skip` into
 * `fill` — the separate experiment (`bench.mjs --eeo`) that measures whether the demographic
 * block can be driven at all. It is off by default because it is not the product's default and
 * because three demographic selects failing in a row ends a posting under the `no_progress` stop
 * rule before a single application question is reached.
 *
 * @param {string} home absolute path, e.g. `/tmp/jev-bench`
 * @param {{eeo?: boolean}} [opts]
 * @returns {Promise<{home:string, cv:string, sections:string[], eeo:boolean}>}
 */
export async function ensureSyntheticHome(home, { eeo = false } = {}) {
  const root = path.resolve(home);
  for (const dir of ["", "memory", "documents", "applications", "pipeline", "profile"]) {
    await mkdir(path.join(root, dir), { recursive: true, mode: 0o700 });
  }

  const cv = path.join(root, "documents", "cv.pdf");
  await copyFile(BENCH_CV, cv);
  const sha256 = createHash("sha256").update(readFileSync(cv)).digest("hex");

  const documents = [
    { id: "doc.resume.bench", path: cv, sha256, role_families: ["ml_engineer"], updated: SEEDED },
  ];

  const sections = [];
  sections.push(await writeSection(root, "facts", facts()));
  sections.push(await writeSection(root, "preferences", preferences({ eeo })));
  sections.push(await writeSection(root, "documents", documents));
  sections.push(await mergeAnswerSection(root, answers()));
  sections.push(await writeSection(root, "stories", stories()));
  sections.push(await writeSection(root, "drafts", []));
  sections.push(await writeSection(root, "corrections", []));
  await writeFile(path.join(root, "memory", "salary-baselines.yaml"), BASELINES, { mode: 0o600 });

  // The profile lives inside the bench home so the real 9223 profile is never opened on 9224.
  await writeFile(
    path.join(root, "config.json"),
    `${JSON.stringify({ envFile: path.join(root, "env"), profile: path.join(root, "profile"), synthetic: true, eeo }, null, 2)}\n`,
    { mode: 0o600 },
  );

  return { home: root, cv, sections, eeo };
}

/** Where `seedAnswers` records what it already paid the writer for. */
const SEED_STAMP = ".answers-seed.json";

const countAnswers = async (home) => {
  let rows = [];
  try {
    const parsed = YAML.parse(await readFile(path.join(home, "memory", "answers.yaml"), "utf8"));
    if (Array.isArray(parsed)) rows = parsed;
  } catch {
    /* no answers yet */
  }
  const by = (kind) => rows.filter((r) => r?.kind === kind).length;
  return { rows: rows.length, constants: by("constant"), rules: by("rule"), policies: by("policy"), narratives: by("narrative") };
};

/** The last stdout line that parses as a JSON object — every script in `scripts/` prints exactly one. */
function lastJson(stdout) {
  for (const line of String(stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean).reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* progress lines are not the result */
    }
  }
  return null;
}

function runNode(args, { cwd, env, timeoutMs, onLog }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += String(c);
      if (onLog) for (const line of String(c).split("\n")) if (line.trim()) onLog(line);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ result: null, code: null, error: err.message, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ result: lastJson(stdout), code, stderr: stderr.slice(-2000) });
    });
  });
}

/**
 * Onboarding's last step, run against the bench home: `scripts/answers.mjs --families <the
 * families `bench/postings.yml` lists>`.
 *
 * Without it the benchmark measures a user who finished the six day-1 questions and stopped —
 * which is not what a `needs_user` rate is supposed to describe. `answers.mjs` walks the canonical
 * bank and writes the constants, the rules, the policies the preferences state, and the narrative
 * answers the writer authors from the synthetic stories. That is what an onboarded user has, so
 * that is what the round-two bench runs against.
 *
 * Idempotent and, more to the point, *not paid for twice*: the 77 narrative rows on the bench's
 * twelve families are real OpenAI calls, so the family list and the resulting counts are stamped
 * into the home and a matching re-run is skipped (`cached: true`). Nothing is cached across
 * different family lists, and deleting the bench home re-seeds from scratch.
 *
 * Credentials travel in the child's environment exactly as they do for `apply.mjs`; the bench home
 * still has no `env` file of its own.
 *
 * @param {string} home
 * @param {{families:string[], secrets?:object, repoRoot?:string, concurrency?:number,
 *          timeoutMs?:number, onLog?:(line:string)=>void}} opts
 */
export async function seedAnswers(home, { families, secrets = {}, repoRoot = REPO_ROOT, concurrency = 8, timeoutMs = 900_000, onLog = null } = {}) {
  const root = path.resolve(home);
  const wanted = [...new Set(families ?? [])].filter(Boolean).sort();
  if (!wanted.length) return { ran: false, why: "the posting list names no role families", families: [], ...(await countAnswers(root)) };

  const stampFile = path.join(root, "memory", SEED_STAMP);
  const stamp = await readFile(stampFile, "utf8").then(JSON.parse).catch(() => null);
  const stored = await countAnswers(root);
  if (stamp?.families?.join(",") === wanted.join(",") && stored.narratives > 0 && stored.narratives >= (stamp.narratives ?? 0)) {
    return { ran: false, cached: true, families: wanted, coverage_line: stamp.coverage_line ?? null, missing: stamp.missing ?? [], ...stored };
  }

  const run = await runNode(
    ["scripts/answers.mjs", "--families", wanted.join(","), "--concurrency", String(concurrency), "--json"],
    { cwd: repoRoot, env: { ...process.env, ...secrets, JEV_APPLY_HOME: root }, timeoutMs, onLog },
  );
  const counts = await countAnswers(root);
  const result = run.result ?? {};
  const out = {
    ran: true,
    cached: false,
    families: wanted,
    status: result.status ?? (run.error ? "blocked" : "unknown"),
    coverage_line: result.coverage_line ?? null,
    missing: result.missing ?? [],
    ...(result.not_written?.length ? { not_written: result.not_written.length } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...counts,
  };
  // A run that authored nothing is not stamped: the next bench run should try again rather than
  // inherit an empty seeding as if it had been paid for.
  if (counts.narratives > 0) {
    await writeFile(stampFile, `${JSON.stringify({ at: new Date().toISOString(), families: wanted, coverage_line: out.coverage_line, missing: out.missing, ...counts }, null, 1)}\n`, { mode: 0o600 });
  }
  return out;
}
