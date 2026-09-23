#!/usr/bin/env node
// canon-cluster — turn the recorded corpus into the canonical question bank (docs/PLAN.md §2.7, Q2).
//
//   node scripts/canon-cluster.mjs [--dry-run] [--corpus corpus] [--out canon] [--concurrency 6]
//
// Input  corpus/<ats>/<family>/*.json, minus the files listed in corpus/holdout.txt (those exist
//        only so canon-eval.mjs can measure coverage on postings the bank never saw).
// Output canon/questions.yaml · canon/families/<family>.yaml · canon/vocab/<qid>.yaml ·
//        canon/templates/<company>.yaml · canon/proposals.yaml · canon/README.md
//
// The pipeline, and which step is allowed to spend a model call:
//
//   1. group      normalizeLabel() collapses "First Name *" / "first name:" into one group. Free.
//   2. exact      ALIASES + the seed's own canonical texts resolve the literal synonyms. Free.
//   3. Jev pass 1 one `choice` per still-unresolved group over the current canon, with an explicit
//                 none_of_these that *means* "this is a new canonical question". Below
//                 MATCH_CONFIDENCE the match is refused and the group becomes a proposal too:
//                 a wrong merge is much more expensive than an extra canonical question, because
//                 it silently pastes one question's saved answer into a different question.
//   4. Jev pass 2 the proposals are then clustered against each other (same shape, candidates are
//                 the more frequent proposals), which is what lets "Why do you want to work at
//                 Palantir?" and "Why are you interested in working at Exa?" become one question.
//   5. route      core (asked across ≥8 families by ≥2 companies) · family screening (recurs
//                 inside a family) · company (one company's template question) · everything left
//                 stays in proposals.yaml for a human pass. Thresholds are the RULES block below.
//
// Jev only ever selects here, never writes: ids and canonical texts are minted by code
// (deterministic slugs), so re-running with the same corpus and the same seed is reproducible
// apart from the model's own judgments.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";

import { SEED, LAYERS, checkSeed } from "../src/canon/seed.mjs";
import {
  ALIASES,
  VOCABS,
  aliasFor,
  canonicalOption,
  canonicalText,
  normalizeLabel,
  normalizeOption,
  optionSetKey,
  proposeId,
  slug,
  vocabFor,
} from "../src/canon/normalize.mjs";
import { FAMILY_IDS } from "../src/canon/families.mjs";
import { NONE, choice, estimateQuestionTokens, systemOne, withNone } from "../src/jev/client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

// ───────────────────────────────────── thresholds ─────────────────────────────────────────────

/**
 * Every judgment call the router makes, in one place.
 *
 * `core.companies: 2` is the one rule that is not in the task text and earns its place: a single
 * company posting across all 20 families (Anthropic has 37 postings here) would otherwise push its
 * bespoke questions into "universal core", where every user would pre-answer them. Breadth means
 * breadth of *employers*, not of job titles; a single employer's recurring question is a company
 * template row, which only becomes a candidate on that employer's forms.
 */
const RULES = {
  /** asked across this many families, by at least this many companies → universal bank */
  core: { families: 8, companies: 2 },
  /** not universal, but recurs inside a family (or is concentrated there) → family screening */
  family: { minInFamily: 2, minShare: 1 / 3, minTotal: 2 },
  /** one employer's question, seen on enough of that employer's postings → company layer */
  company: { share: 0.8, minPostings: 3 },
  /** a company template = the ids on ≥ this share of that company's postings */
  template: { minPostings: 3, presence: 0.8, fit: 0.8 },
  /** a vocab file needs a real disagreement between forms to be worth writing */
  vocab: { minOptionSets: 2 },
  /** Jev must be this sure before two different labels become one canonical question */
  matchConfidence: 0.7,
  /** questions.yaml stays inspectable; the overflow is demoted to proposals.yaml */
  maxBank: 400,
};

/** ≤255 per the API; leave headroom for none_of_these and keep requests batchable. */
const MAX_CRITERIA = 250;
/** Token budget per systemOne call — the client splits above 56k, this keeps one batch = one call. */
const BATCH_TOKENS = 45_000;
/** How much of a label/help/option list Jev is shown. */
const CLIP = { label: 300, help: 200, option: 60, options: 12, criterion: 220, forms: 3 };

// ───────────────────────────────────────── cli ────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    corpus: path.join(REPO, "corpus"),
    out: path.join(REPO, "canon"),
    concurrency: 6,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--corpus") args.corpus = path.resolve(next());
    else if (a === "--out") args.out = path.resolve(next());
    else if (a === "--concurrency") args.concurrency = Number(next());
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") {
      process.stderr.write("usage: canon-cluster.mjs [--dry-run] [--corpus DIR] [--out DIR] [--concurrency N]\n");
      process.exit(0);
    } else throw new Error(`unknown flag: ${a}`);
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) throw new Error("--concurrency must be ≥ 1");
  return args;
}

const log = (msg) => process.stderr.write(`${msg}\n`);

// ────────────────────────────────────── corpus ────────────────────────────────────────────────

async function listCorpus(dir) {
  const out = [];
  for (const ats of await readdir(dir, { withFileTypes: true })) {
    if (!ats.isDirectory()) continue;
    for (const family of await readdir(path.join(dir, ats.name), { withFileTypes: true })) {
      if (!family.isDirectory()) continue;
      for (const file of await readdir(path.join(dir, ats.name, family.name), { withFileTypes: true })) {
        if (file.isFile() && file.name.endsWith(".json")) out.push(path.join(dir, ats.name, family.name, file.name));
      }
    }
  }
  return out.sort();
}

async function loadHoldout(dir) {
  const raw = await readFile(path.join(dir, "holdout.txt"), "utf8").catch(() => "");
  return new Set(
    raw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Every posting in the build split, with its questions. Holdout files are never opened. */
async function loadBuildSet(corpusDir) {
  const holdout = await loadHoldout(corpusDir);
  const files = await listCorpus(corpusDir);
  const postings = [];
  let skipped = 0;
  for (const file of files) {
    const rel = path.relative(REPO, file).split(path.sep).join("/");
    if (holdout.has(rel)) {
      skipped++;
      continue;
    }
    const posting = JSON.parse(await readFile(file, "utf8"));
    postings.push({ ...posting, file: rel });
  }
  return { postings, holdout: skipped, files: files.length };
}

// ───────────────────────────────────── grouping ───────────────────────────────────────────────

const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

/**
 * A follow-up field, not a question of its own: "If yes, please explain", "If you selected
 * Other, which one?". It is answered from whatever its *parent* answer was, so it must never be
 * clustered onto the parent's canonical question — pasting the parent's answer into it would be
 * a wrong fill, not a missing one. These keep their own canonical row plus a `dependency`.
 */
const CONDITIONAL = /^(?:\[[^\]]*\]\s*)?(?:if (?:yes|no|so|not|other|any|applicable|selected|you|your|the answer|answered|"|“)|if you (?:selected|answered|checked|chose|indicated|said|are|have|require|need|do)|please (?:explain|elaborate|specify|describe) (?:if|why|which|below)|if applicable)/;

/** Every instance of one normalized label, with the counts the bank records. */
function groupInstances(postings) {
  /** @type {Map<string, any>} */
  const groups = new Map();
  let instances = 0;
  for (const posting of postings) {
    const questions = posting.questions ?? [];
    questions.forEach((q, i) => {
      instances++;
      const key = normalizeLabel(q.label);
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          labels: new Map(), // raw label → {count, ats:Set}
          types: new Map(),
          sections: new Map(),
          helps: new Map(),
          optionSets: new Map(), // key → {options, count}
          byAts: new Map(),
          byFamily: new Map(),
          byCompany: new Map(),
          prevKeys: new Map(), // the field asked just before this one, per posting
          postings: new Set(),
          conditional: CONDITIONAL.test(key),
          total: 0,
          qid: null,
          via: null,
        };
        groups.set(key, g);
      }
      g.total++;
      const label = String(q.label ?? "").trim();
      const form = g.labels.get(label) ?? { count: 0, ats: new Set() };
      form.count++;
      form.ats.add(posting.ats);
      g.labels.set(label, form);
      bump(g.types, q.type ?? "text");
      if (q.section) bump(g.sections, q.section);
      if (q.help) bump(g.helps, String(q.help).slice(0, CLIP.help));
      bump(g.byAts, posting.ats);
      bump(g.byFamily, posting.family);
      bump(g.byCompany, posting.company);
      if (i > 0) bump(g.prevKeys, normalizeLabel(questions[i - 1].label));
      g.postings.add(posting.file);
      const oKey = optionSetKey(q.options);
      if (oKey) {
        const set = g.optionSets.get(oKey) ?? { options: q.options.map((o) => String(o)), count: 0 };
        set.count++;
        g.optionSets.set(oKey, set);
      }
    });
  }
  return { groups, instances };
}

const topKey = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0];
const topEntry = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0];

const dominantType = (g) => topKey(g.types) ?? "text";
const dominantLabel = (g) => {
  const entries = [...g.labels.entries()].sort((a, b) => b[1].count - a[1].count || a[0].length - b[0].length);
  return entries[0]?.[0] ?? g.key;
};

// ───────────────────────────────── exact-match pass ───────────────────────────────────────────

/** Seed canonical texts, normalized, so "What is your first name?" matches the label "First name". */
function seedTextIndex(canon) {
  const index = new Map();
  for (const row of canon) {
    const key = normalizeLabel(row.text);
    if (key && !index.has(key)) index.set(key, row.qid);
  }
  return index;
}

function exactPass(groups, canon) {
  const byText = seedTextIndex(canon);
  let resolved = 0;
  for (const g of groups.values()) {
    const qid = aliasFor(g.key, dominantType(g)) ?? byText.get(g.key) ?? null;
    if (qid) {
      g.qid = qid;
      g.via = "exact";
      resolved++;
    }
  }
  return resolved;
}

// ─────────────────────────────────── Jev plumbing ─────────────────────────────────────────────

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** What Jev is told about one form field — exactly the keys PLAN §2.7 names. */
function fieldState(g) {
  const options = [...g.optionSets.values()].sort((a, b) => b.count - a.count)[0]?.options ?? [];
  return {
    label: clip(dominantLabel(g), CLIP.label),
    help: clip(topKey(g.helps) ?? "", CLIP.help),
    type: dominantType(g),
    options: options.slice(0, CLIP.options).map((o) => clip(o, CLIP.option)),
    section: clip(topKey(g.sections) ?? "", 80),
    family: topKey(g.byFamily) ?? "",
  };
}

/** A canonical question as one criterion line: its text plus the real labels it has covered. */
function criterionFor(row) {
  const forms = (row.surface_forms ?? []).slice(0, CLIP.forms).map((f) => f.label);
  const body = forms.length ? `${row.text} (seen as: ${forms.map((f) => `"${clip(f, 70)}"`).join(", ")})` : row.text;
  return clip(body, CLIP.criterion);
}

const TYPE_CLASS = {
  text: "short",
  phone: "short",
  number: "short",
  date: "short",
  textarea: "long",
  file: "file",
  url: "link",
  single_select: "pick",
  multi_select: "pick",
  boolean: "pick",
  composite: "composite",
};

/**
 * Keep the criteria under the API's cap. The same canonical question really does arrive as a
 * radio on one form and a text input on the next, so type is only used to *rank* candidates once
 * there are too many of them — never to exclude a candidate while there is still room.
 */
function narrowCandidates(rows, g) {
  if (rows.length <= MAX_CRITERIA) return rows;
  const cls = TYPE_CLASS[dominantType(g)] ?? "short";
  const layerOfGroup = inferLayer(g);
  const score = (row) => {
    let s = row.frequency?.total ?? 0;
    if (TYPE_CLASS[row.type] === cls) s += 10_000;
    if (row.layer === layerOfGroup) s += 5_000;
    return s;
  };
  return [...rows].sort((a, b) => score(b) - score(a)).slice(0, MAX_CRITERIA);
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Split questions into batches that each cost one HTTP call. */
function batchQuestions(entries, stateFor) {
  const batches = [];
  let current = [];
  let cost = 0;
  for (const entry of entries) {
    const c = estimateQuestionTokens(entry.id, entry.question) + estimateQuestionTokens(entry.id, stateFor(entry));
    if (current.length && cost + c > BATCH_TOKENS) {
      batches.push(current);
      current = [];
      cost = 0;
    }
    current.push(entry);
    cost += c;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Ask one `choice` per entry, batched over a shared state.
 *
 * A batch that still fails after one retry is dropped, not fatal: its groups simply stay
 * unmatched (pass 1) or unmerged (pass 2), which is the same outcome as `none_of_these` and is
 * always safe. Losing 130 requests' worth of work to one bad answer is not.
 * @returns {Promise<{answers:Map<string,object>, requests:number, ms:number, usage:object, failed:number}>}
 */
async function askBatched(entries, { stateKey, concurrency, label }) {
  const totals = { requests: 0, ms: 0, usage: { input_tokens: 0, output_tokens: 0 }, failed: 0 };
  const answers = new Map();
  if (!entries.length) return { answers, ...totals };
  const batches = batchQuestions(entries, (e) => e.state);
  log(`${label}: ${entries.length} questions in ${batches.length} batches`);
  let done = 0;
  await mapPool(batches, concurrency, async (batch) => {
    const state = { [stateKey]: Object.fromEntries(batch.map((e) => [e.id, e.state])) };
    const questions = Object.fromEntries(batch.map((e) => [e.id, e.question]));
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await systemOne({ state, questions });
        totals.requests += res.requests;
        totals.ms += res.ms;
        totals.usage.input_tokens += res.usage.input_tokens;
        totals.usage.output_tokens += res.usage.output_tokens;
        for (const [id, answer] of Object.entries(res.answers)) answers.set(id, answer);
        break;
      } catch (err) {
        if (attempt === 1) {
          log(`${label}: batch of ${batch.length} failed (${err.message}); retrying once`);
          continue;
        }
        totals.failed += batch.length;
        log(`${label}: batch of ${batch.length} dropped after retry — ${err.message}`);
        break;
      }
    }
    done += batch.length;
    log(`${label}: ${done}/${entries.length} answered`);
  });
  return { answers, ...totals };
}

// ───────────────────────────────────── Jev pass 1 ─────────────────────────────────────────────

const PASS1_INSTRUCTIONS = (id) =>
  `The form field described in \`fields.${id}\` has to be answered by one of the canonical questions below. ` +
  `Which canonical question is it an instance of — the same thing asked in different words? ` +
  `Choose ${NONE} when no canonical question covers it; that means it becomes a new canonical question.`;

async function jevPass1(unresolved, canonRows, { concurrency, dryRun }) {
  if (dryRun || !unresolved.length) {
    return { matched: 0, requests: 0, ms: 0, usage: { input_tokens: 0, output_tokens: 0 }, asked: 0, lowConfidence: 0, failed: 0 };
  }
  const entries = unresolved.map((g, i) => {
    const id = `f${String(i).padStart(4, "0")}`;
    const rows = narrowCandidates(canonRows, g);
    const criteria = Object.fromEntries(rows.map((row) => [row.qid, criterionFor(row)]));
    return {
      id,
      group: g,
      state: fieldState(g),
      question: choice(PASS1_INSTRUCTIONS(id), withNone(criteria, "No canonical question covers this field; it is a new canonical question")),
    };
  });
  const { answers, requests, ms, usage, failed } = await askBatched(entries, { stateKey: "fields", concurrency, label: "pass 1" });
  let matched = 0;
  let lowConfidence = 0;
  for (const e of entries) {
    const a = answers.get(e.id);
    if (!a || a.choice === NONE) continue;
    if (a.confidence < RULES.matchConfidence) {
      lowConfidence++;
      continue;
    }
    e.group.qid = a.choice;
    e.group.via = "jev";
    e.group.confidence = a.confidence;
    matched++;
  }
  return { matched, requests, ms, usage, asked: entries.length, lowConfidence, failed };
}

// ───────────────────────────────────── Jev pass 2 ─────────────────────────────────────────────

const PASS2_INSTRUCTIONS = (id) =>
  `\`proposals.${id}\` is a form question that no canonical question covered. ` +
  `Is it the same question as one of the proposed canonical questions below, only worded differently? ` +
  `Choose ${NONE} when it is genuinely a different question.`;

/**
 * Merge proposals into each other. Candidates for a proposal are always *more frequent* proposals,
 * so a merge can only ever point "upwards" and the parent chains cannot cycle. Conditional
 * follow-ups take no part: two "If yes, please explain" fields under different parents are
 * different questions, and merging them would give one row two parents.
 */
async function jevPass2(proposals, { concurrency, dryRun }) {
  const empty = { merged: 0, requests: 0, ms: 0, usage: { input_tokens: 0, output_tokens: 0 }, asked: 0, failed: 0 };
  if (dryRun || proposals.length < 2) return empty;
  const ranked = [...proposals].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  const entries = [];
  ranked.forEach((p, i) => {
    if (i === 0 || p.group.conditional) return;
    // a proposal's canonical text *is* its label, so repeating it as a surface form buys nothing
    const rows = ranked
      .slice(0, i)
      .filter((c) => !c.group.conditional)
      .map((c) => ({
        qid: c.qid,
        text: c.text,
        type: c.type,
        layer: c.layer,
        frequency: { total: c.total },
        surface_forms: [],
      }));
    const candidates = narrowCandidates(rows, p.group);
    if (!candidates.length) return;
    const id = `p${String(i).padStart(4, "0")}`;
    entries.push({
      id,
      proposal: p,
      state: fieldState(p.group),
      question: choice(
        PASS2_INSTRUCTIONS(id),
        withNone(Object.fromEntries(candidates.map((c) => [c.qid, criterionFor(c)])), "A different question; keep it separate"),
      ),
    });
  });
  const { answers, requests, ms, usage, failed } = await askBatched(entries, { stateKey: "proposals", concurrency, label: "pass 2" });
  const parent = new Map();
  let merged = 0;
  for (const e of entries) {
    const a = answers.get(e.id);
    if (!a || a.choice === NONE || a.confidence < RULES.matchConfidence) continue;
    parent.set(e.proposal.qid, a.choice);
    merged++;
  }
  const resolve = (qid, seen = new Set()) => {
    let cur = qid;
    while (parent.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = parent.get(cur);
    }
    return cur;
  };
  for (const p of proposals) p.mergedInto = resolve(p.qid);
  return { merged, requests, ms, usage, asked: entries.length, failed };
}

const LAYER_RULES = [
  ["auth", /(sponsor|visa|work (permit|authoriz|authoris)|right to work|legally (authoriz|authoris|entitled)|immigration|citizenship|nationality)/],
  ["legal", /(arbitrat|privacy (notice|policy)|consent|acknowledg|certif|attest|background check|export control|non.?compete|non.?solicit|restrict|18 years|government (official|entity|agency|employee)|conflict of interest|criminal|convict|policy|terms|agree)/],
  ["comp", /(salary|compensation|pay (range|expectation)|remuneration|bonus|equity|hourly rate|desired pay)/],
  ["narrative", /(why (do|are) you|tell us|describe (a|your|the)|what (motivates|excites|draws|interests)|proudest|most exceptional|anything else|cover letter|in your own words|share (a|an) example)/],
];

/**
 * Demographics, in any wording an ATS uses for them. This runs over *every* surface form and
 * *every* section a group was seen under, not just the commonest ones: one form's "U.S. Equal
 * Opportunity Employment Information" block is the same control as another's "What is your
 * gender?", and misreading it as an ordinary question would hand the runner an EEO field to fill
 * (AGENTS.md: EEO is never touched without an explicit preference). A false positive here costs
 * one field the user fills by hand; a false negative breaks the invariant.
 */
const SENSITIVE =
  /(gender|\brace\b|racial|ethnic|veteran|disabilit|sexual orientation|lgbt|transgender|demographic|self.?identif|protected (class|veteran)|pronoun|equal.?(employment.?)?opportunity|\beeo\b|voluntary (self|survey)|age (group|range)|date of birth|religio|marital status|national origin|\bsex\b)/;

const SECTION_EEO = /(eeo|equal (employment )?opportunity|demographic|voluntary self|self.identification|diversity)/i;

/** Every label and section a group was seen under, lowercased — the sensitive test's haystack. */
function identityText(g) {
  return [...g.labels.keys(), ...g.sections.keys()].join(" \n ").toLowerCase();
}

/**
 * Which layer a discovered question belongs to, from its own words and its form section.
 * Help text joins the haystack only for the non-sensitive rules: "we are an equal opportunity
 * employer" is boilerplate that hangs off perfectly ordinary fields.
 */
export function inferLayer(g) {
  const identity = identityText(g);
  if (SENSITIVE.test(identity) || SECTION_EEO.test(identity)) return "eeo";
  const text = `${g.key} ${clip(topKey(g.helps) ?? "", 120)}`.toLowerCase();
  for (const [layer, re] of LAYER_RULES) if (re.test(text)) return layer;
  const type = dominantType(g);
  if (type === "textarea" && g.key.length > 60) return "narrative";
  return "core";
}

const KIND_BY_LAYER = {
  eeo: "never",
  legal: "policy",
  comp: "rule",
  auth: "rule",
  narrative: "narrative",
  core: "constant",
  screening: "constant",
  company: "constant",
};

const SHAPE_BY_TYPE = {
  text: "text_short",
  textarea: "text_long",
  file: "file",
  url: "url",
  single_select: "select_one",
  multi_select: "select_many",
  boolean: "yes_no",
  number: "integer",
  date: "date",
  phone: "phone",
  composite: "text_long",
};

// ───────────────────────────────────── assembly ───────────────────────────────────────────────

/** Fold every group that resolved to `qid` into one canonical record. */
function buildRecord(qid, groups, seedRow) {
  const labels = new Map();
  const types = new Map();
  const optionSets = new Map();
  const byAts = new Map();
  const byFamily = new Map();
  const byCompany = new Map();
  const postings = new Set();
  const sections = new Map();
  let total = 0;
  for (const g of groups) {
    total += g.total;
    for (const [label, form] of g.labels) {
      const row = labels.get(label) ?? { label, count: 0, ats: new Set() };
      row.count += form.count;
      for (const a of form.ats) row.ats.add(a);
      labels.set(label, row);
    }
    for (const [t, c] of g.types) bump(types, t, c);
    for (const [s, c] of g.sections) bump(sections, s, c);
    for (const [k, set] of g.optionSets) {
      const row = optionSets.get(k) ?? { options: set.options, count: 0 };
      row.count += set.count;
      optionSets.set(k, row);
    }
    for (const [a, c] of g.byAts) bump(byAts, a, c);
    for (const [f, c] of g.byFamily) bump(byFamily, f, c);
    for (const [c0, c] of g.byCompany) bump(byCompany, c0, c);
    for (const p of g.postings) postings.add(p);
  }
  const surface_forms = [...labels.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 8)
    .map((f) => ({ label: f.label, count: f.count, ats: [...f.ats].sort() }));
  const options_seen = [...optionSets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((s) => ({ options: s.options, count: s.count }));
  const lead = groups.slice().sort((a, b) => b.total - a.total)[0];
  // merged groups vote: one demographic surface form makes the whole canonical question sensitive
  const inferred = groups.map((g) => inferLayer(g));
  const layer = seedRow?.layer ?? (inferred.includes("eeo") ? "eeo" : inferred[groups.indexOf(lead)] ?? "core");
  const type = seedRow?.type ?? topKey(types) ?? "text";
  return {
    qid,
    text: seedRow?.text ?? canonicalText(dominantLabel(lead), { type }),
    layer,
    type,
    answer_shape: seedRow?.answer_shape ?? SHAPE_BY_TYPE[type] ?? "text_short",
    kind_default: seedRow?.kind_default ?? KIND_BY_LAYER[layer] ?? "constant",
    ...(seedRow?.dependency ? { dependency: seedRow.dependency } : {}),
    ...(seedRow?.jurisdiction_notes ? { jurisdiction_notes: seedRow.jurisdiction_notes } : {}),
    source: seedRow ? "seed" : "derived",
    types_seen: [...types.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => ({ type: t, count: c })),
    surface_forms,
    options_seen,
    frequency: {
      total,
      postings: postings.size,
      by_ats: Object.fromEntries([...byAts.entries()].sort((a, b) => b[1] - a[1])),
      by_family: Object.fromEntries([...byFamily.entries()].sort((a, b) => b[1] - a[1])),
    },
    _byCompany: byCompany,
    _byFamily: byFamily,
    _sections: sections,
    _groups: groups,
    _conditional: groups.some((g) => g.conditional),
  };
}

// ────────────────────────────────────── routing ───────────────────────────────────────────────

/**
 * Labels that only mean something next to the field before them: a bare "Other" is the free-text
 * box beside a select, "Date" is the signature line under a form. As a canonical question they
 * would show up in the user's pre-answer sheet as a question with no question in it, so they wait
 * in proposals.yaml with their counts instead.
 */
const CONTEXT_FREE = new Set([
  "other", "others", "date", "name", "n/a", "none", "link", "links", "url", "notes", "note",
  "comments", "comment", "details", "detail", "description", "explain", "please explain",
  "additional", "optional", "yes", "no", "text", "answer",
]);

/**
 * Where a canonical question lives. Seed rows keep their declared layer; derived rows are placed
 * by how the corpus actually used them (RULES) plus, for the family layer, the durable-screening
 * judgment from pass 3.
 *
 * Demographic questions never leave the `eeo` layer. A screening or company row is a row the
 * runner is allowed to fill once the user has an answer for it; an EEO row is one it must leave
 * alone, and that distinction has to survive routing, not just detection.
 *
 * @param {object} record
 * @param {boolean} durable pass-3 judgment: is this a screening question another employer would ask?
 * @returns {{placement:"bank"|"family"|"company"|"proposal", families?:string[], company?:string}}
 */
function route(record, durable = false) {
  if (record.source === "seed") return { placement: "bank" };
  if (record.layer === "eeo") return { placement: "bank" };
  if (CONTEXT_FREE.has(normalizeLabel(record.text))) return { placement: "proposal" };
  const families = record._byFamily;
  const companies = record._byCompany;
  const [topCompany, topCompanyCount] = topEntry(companies) ?? ["", 0];
  const total = record.frequency.total;

  if (families.size >= RULES.core.families) {
    if (companies.size >= RULES.core.companies) return { placement: "bank" };
    return topCompanyCount >= RULES.company.minPostings
      ? { placement: "company", company: topCompany }
      : { placement: "proposal" };
  }
  const recurs = ([, c]) => c >= RULES.family.minInFamily || (total >= RULES.family.minTotal && c / total >= RULES.family.minShare - 1e-9);
  const claimed = [...families.entries()]
    .filter((entry) => recurs(entry) || durable)
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f);
  if (claimed.length) return { placement: "family", families: claimed };
  if (topCompanyCount / total >= RULES.company.share && topCompanyCount >= RULES.company.minPostings) {
    return { placement: "company", company: topCompany };
  }
  return { placement: "proposal" };
}

// ───────────────────────────────────── Jev pass 3 ─────────────────────────────────────────────

const PASS3_INSTRUCTIONS = (id, family) =>
  `\`questions.${id}\` is a question one employer asked applicants for a ${family.replace(/_/g, " ")} role. ` +
  `Which of these describes it best?`;

const PASS3_CRITERIA = {
  screening:
    "A durable screening question about the applicant themselves — their skills, tools, years of experience, " +
    "education, publications, clearance, seniority or availability — that other employers hiring for the same " +
    "kind of role would also ask, in their own words.",
  company_specific:
    "Only meaningful for this one employer or this one posting: its product, its policy, its offices, its " +
    "programme, or an essay about why the applicant wants to work there.",
  follow_up:
    'A conditional follow-up that only makes sense after another question — "if yes, please explain", ' +
    '"if you selected other, which one".',
  admin:
    "Process or administrative detail rather than a question about the applicant: file uploads, event names, " +
    "internal reference codes, mailing-list opt-ins, or a locale-specific legal form.",
};

/**
 * Pass 3 — the family layer's content test.
 *
 * Recurrence alone cannot build the family layer from 20 postings per family: most family
 * screening questions in this corpus were asked by one employer, once ("Do you have a PhD in a
 * relevant research area?"). Frequency says that is noise; it is not — it is the exact kind of
 * question the next employer in that family asks in different words, which is what the bank is
 * for. So a question that was *observed in a family* also joins that family when Jev judges it a
 * durable screening question. The corpus supplies the family; the judgment supplies durability;
 * neither invents a question.
 */
async function jevPass3(records, { concurrency, dryRun }) {
  const empty = { durable: new Set(), requests: 0, ms: 0, usage: { input_tokens: 0, output_tokens: 0 }, asked: 0, failed: 0 };
  const eligible = records.filter(
    (r) =>
      r.source !== "seed" &&
      !r._conditional &&
      r.layer !== "eeo" &&
      r._byFamily.size > 0 &&
      r._byFamily.size < RULES.core.families &&
      [...r._byFamily.entries()].some(([, c]) => !(c >= RULES.family.minInFamily || (r.frequency.total >= RULES.family.minTotal && c / r.frequency.total >= RULES.family.minShare - 1e-9))),
  );
  if (dryRun || !eligible.length) return empty;
  const entries = eligible.map((record, i) => {
    const id = `c${String(i).padStart(4, "0")}`;
    const family = topEntry(record._byFamily)?.[0] ?? "";
    return {
      id,
      record,
      state: { ...fieldState(record._groups[0]), family, asked_by_companies: record._byCompany.size, times_asked: record.frequency.total },
      question: choice(PASS3_INSTRUCTIONS(id, family), withNone(PASS3_CRITERIA, "None of these fit")),
    };
  });
  const { answers, requests, ms, usage, failed } = await askBatched(entries, { stateKey: "questions", concurrency, label: "pass 3" });
  const durable = new Set();
  for (const e of entries) {
    const a = answers.get(e.id);
    if (a && a.choice === "screening" && a.confidence >= RULES.matchConfidence) durable.add(e.record.qid);
  }
  return { durable, requests, ms, usage, asked: entries.length, failed };
}

// ─────────────────────────────────── vocabularies ─────────────────────────────────────────────

/**
 * The option alias map for one canonical question: every distinct option the corpus showed,
 * mapped onto one canonical value. Named vocabularies (VOCABS) win; otherwise the values are
 * derived from the most frequent wording, so the map is still stable across runs.
 */
function buildVocab(record) {
  const sets = record.options_seen.map((s) => s.options);
  if (sets.length < RULES.vocab.minOptionSets) return null;
  const name = vocabFor(record.qid, sets);
  const observed = new Map(); // normalized option → {label, count}
  for (const set of record.options_seen) {
    for (const option of set.options) {
      const key = normalizeOption(option);
      if (!key) continue;
      const row = observed.get(key) ?? { label: String(option).trim(), count: 0 };
      row.count += set.count;
      observed.set(key, row);
    }
  }
  if (observed.size < 2) return null;

  const aliases = {};
  const unmapped = [];
  const values = {};
  if (name && VOCABS[name]) {
    for (const [value, description] of Object.entries(VOCABS[name].values)) values[value] = description;
    for (const [, row] of [...observed].sort((a, b) => b[1].count - a[1].count)) {
      const value = canonicalOption(name, row.label);
      if (value) aliases[row.label] = value;
      else unmapped.push(row.label);
    }
  } else {
    // derived: the most frequent wording of each distinct option becomes the canonical value
    for (const [, row] of [...observed].sort((a, b) => b[1].count - a[1].count)) {
      const value = slug(normalizeOption(row.label), 32);
      if (!values[value]) values[value] = row.label;
      aliases[row.label] = value;
    }
  }
  const mapped = Object.keys(aliases).length;
  if (!mapped) return null;
  return {
    qid: record.qid,
    vocabulary: name ?? "derived",
    option_sets: record.options_seen.length,
    values,
    aliases,
    ...(unmapped.length ? { unmapped } : {}),
  };
}

// ────────────────────────────────────── writers ───────────────────────────────────────────────

const YAML = (value) => stringify(value, { lineWidth: 0 });
const HEADER = "# generated by scripts/canon-cluster.mjs (docs/PLAN.md §2.7) — do not hand-edit\n";

async function writeYaml(file, header, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${HEADER}${header ? `# ${header}\n` : ""}${YAML(value)}`, "utf8");
}

/**
 * Wipe a generated directory. `keep` names the files this generator does not own: `canon/vocab/`
 * also holds the hand-maintained `eeo-*.yaml` fill maps (the ones `src/plan/resolve.mjs` reads to
 * turn a stored `p.eeo` value into a form's own option wording), and a regeneration that deleted
 * them would silently stop every demographic row from filling.
 */
async function resetDir(dir, { keep = null } = {}) {
  const kept = [];
  if (keep) {
    for (const file of await readdir(dir).catch(() => [])) {
      if (keep.test(file)) kept.push([file, await readFile(path.join(dir, file), "utf8")]);
    }
  }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [file, text] of kept) await writeFile(path.join(dir, file), text, "utf8");
}

/** Strip the private bookkeeping fields before a record is serialized. */
function publicRow(record, extra = {}) {
  const { _byCompany, _byFamily, _sections, _groups, ...row } = record;
  return { ...row, ...extra };
}

// ─────────────────────────────────────── report ───────────────────────────────────────────────

function coverageTable({ records, groups, instances, jev, ms, counts }) {
  const byLayer = new Map();
  for (const record of records) {
    const row = byLayer.get(record.layer) ?? { questions: 0, instances: 0 };
    row.questions++;
    row.instances += record.frequency.total;
    byLayer.set(record.layer, row);
  }
  const mapped = [...groups.values()].filter((g) => g.qid).reduce((n, g) => n + g.total, 0);
  const lines = [];
  lines.push("layer         questions   instances   % of build-set instances");
  lines.push("─".repeat(66));
  const order = [...LAYERS, "proposal"];
  for (const layer of order) {
    const row = byLayer.get(layer);
    if (!row) continue;
    lines.push(
      `${layer.padEnd(13)} ${String(row.questions).padStart(9)} ${String(row.instances).padStart(11)} ${((row.instances / instances) * 100).toFixed(1).padStart(23)}%`,
    );
  }
  lines.push("─".repeat(66));
  lines.push(
    `${"total".padEnd(13)} ${String(records.length).padStart(9)} ${String(mapped).padStart(11)} ${((mapped / instances) * 100).toFixed(1).padStart(23)}%`,
  );
  lines.push("");
  lines.push(
    `bank ${counts.bank} · family files ${counts.familyFiles} (${counts.familyRows} rows) · vocab ${counts.vocab} · templates ${counts.templates} · proposals ${counts.proposals}`,
  );
  lines.push(
    `groups ${groups.size} → exact ${counts.exact} · jev ${counts.jevMatched} · new ${counts.new} (merged ${counts.merged})`,
  );
  lines.push(
    `jev: ${jev.requests} requests, ${jev.questions} questions${jev.failed ? ` (${jev.failed} dropped)` : ""}, ` +
      `${(jev.usage.input_tokens / 1000).toFixed(1)}k input tokens ≈ $${((jev.usage.input_tokens / 1e6) * 0.042).toFixed(3)}`,
  );
  lines.push(`wall time: ${(ms / 1000).toFixed(1)} s`);
  return lines.join("\n");
}

const README = ({ records, counts, postings, instances, holdout, jev, ms, bank }) => `# canon — the canonical question bank

Generated by \`scripts/canon-cluster.mjs\` from \`corpus/\` (docs/PLAN.md §2.7). Question text only:
every label here is public form text an employer publishes, and nothing in this directory is
personal data. The user's *answers* live outside the repo, in \`~/.config/jev-apply/\`.

## What is here

| file | what it is |
|---|---|
| \`questions.yaml\` | the bank: ${bank} canonical questions, each with \`surface_forms\`, \`options_seen\` and \`frequency\` |
| \`families/<family>.yaml\` | the screening layer for one of the 20 job families (${counts.familyFiles} files, ${counts.familyRows} rows) |
| \`vocab/<qid>.yaml\` | option alias maps for questions whose vocabulary differs between forms (${counts.vocab} files) |
| \`templates/<company>.yaml\` | the ordered canonical ids one employer's form uses (${counts.templates} files) |
| \`proposals.yaml\` | ${counts.proposals} clustered questions that did not clear a promotion rule — the human review queue |

A row in \`questions.yaml\`:

\`\`\`yaml
- qid: q.auth.sponsorship_future        # stable id; the prefix is the layer
  text: Will you now or in the future…  # canonical phrasing
  layer: auth                           # core | auth | legal | comp | eeo | narrative | screening | company
  type: single_select                   # the control it usually arrives as
  answer_shape: yes_no
  kind_default: rule                    # constant | rule | policy | narrative | company | never
  surface_forms: [{label: …, count: 30, ats: [greenhouse]}]
  options_seen: [{options: [Yes, No], count: 24}]
  frequency: {total: 120, postings: 118, by_ats: {…}, by_family: {…}}
\`\`\`

\`kind_default: never\` (EEO, salary history) is never auto-filled — see AGENTS.md.

## How it was built

${postings} build-set postings (${instances} question instances; the ${holdout} hold-out postings in
\`corpus/holdout.txt\` were not opened) → ${counts.groups} normalized labels → four passes:

1. **exact** — the alias table in \`src/canon/normalize.mjs\` resolved ${counts.exact} label groups for free.
2. **Jev pass 1** — "which canonical question is this an instance of, or is it new?" matched ${counts.jevMatched} more.
3. **Jev pass 2** — the ${counts.new} new questions were clustered against each other; ${counts.merged} merged.
4. **Jev pass 3** — a question a family asked only once joins that family's screening layer only when
   Jev judges it durable screening (${counts.durable} of ${counts.durableAsked}); the rest wait in \`proposals.yaml\`.

Conditional follow-ups ("If yes, please explain") never join their parent's canonical question —
${counts.conditional} of them keep their own row with a \`dependency\` on the field asked before them,
because filling one with the parent's answer would be a wrong answer, not a missing one.

Jev spent ${jev.requests} requests / ${(jev.usage.input_tokens / 1000).toFixed(0)}k input tokens
(≈ $${((jev.usage.input_tokens / 1e6) * 0.042).toFixed(2)}) in ${(ms / 1000).toFixed(0)} s.

Jev only ever *selected* (\`choice\` with an explicit \`${NONE}\`, refused below confidence
${RULES.matchConfidence}); every id and canonical text is a deterministic slug minted in code.

Promotion rules (\`RULES\` in the script):
- **core** — asked across ≥ ${RULES.core.families} job families by ≥ ${RULES.core.companies} employers.
- **family screening** — recurs inside one family (≥ ${RULES.family.minInFamily} postings, or ≥ ⅓ of the question's instances).
- **company** — one employer's question, on ≥ ${RULES.company.minPostings} of that employer's postings.
- **template** — ≥ ${RULES.template.minPostings} postings from one employer sharing ≥ ${Math.round(RULES.template.presence * 100)}% of their canonical ids.
- anything else stays in \`proposals.yaml\`.

## Regenerate

    node scripts/canon-cluster.mjs            # needs TYPESAFE_API_KEY
    node scripts/canon-cluster.mjs --dry-run  # alias pass only, no model calls

Re-running rewrites every file in this directory.

## Coverage

Measured separately, on the hold-out postings this build never opened, by
\`node scripts/canon-eval.mjs\` — which writes its table to \`canon/eval-<YYYY-MM-DD>.md\` beside
this file. Each bucket carries **mapped** (the bank recognised the field) and **answerable**
(mapped *and* that canonical question has an answer the user can pre-compute); PLAN §2.7's targets
— core ≥ 95%, screening ≥ 85%, narrative ≥ 80% — score the answerable column. The newest
\`eval-<date>.md\` in this directory is the current measurement.
`;

// ──────────────────────────────────────── main ────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  checkSeed();

  const { postings, holdout, files } = await loadBuildSet(args.corpus);
  const { groups, instances } = groupInstances(postings);
  log(`corpus: ${postings.length} build postings (${holdout} held out of ${files}), ${instances} question instances, ${groups.size} normalized labels`);

  // 1. exact pass
  const exact = exactPass(groups, SEED);
  log(`exact pass: ${exact}/${groups.size} label groups resolved by ${Object.keys(ALIASES).length} aliases + seed texts`);

  // 2. Jev pass 1 — unresolved groups against the seed canon
  const seedRecords = new Map();
  for (const row of SEED) seedRecords.set(row.qid, { ...row, surface_forms: [], frequency: { total: 0 } });
  for (const g of groups.values()) {
    if (!g.qid) continue;
    const rec = seedRecords.get(g.qid);
    if (!rec) continue;
    rec.frequency.total += g.total;
    rec.surface_forms.push({ label: dominantLabel(g), count: g.total });
  }
  for (const rec of seedRecords.values()) rec.surface_forms.sort((a, b) => b.count - a.count);
  const canonRows = [...seedRecords.values()];

  // conditional follow-ups skip the canon match: they are answered from their parent's answer,
  // never from the parent's canonical question (see CONDITIONAL)
  const unresolved = [...groups.values()]
    .filter((g) => !g.qid && !g.conditional)
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  const pass1 = await jevPass1(unresolved, canonRows, { concurrency: args.concurrency, dryRun: args.dryRun });
  log(`pass 1: ${pass1.matched}/${pass1.asked} matched to the seed canon (${pass1.lowConfidence} refused below ${RULES.matchConfidence})`);

  // 3. new canonical questions → proposals, then merge them against each other
  const taken = new Set(SEED.map((r) => r.qid));
  const proposals = [];
  for (const g of [...groups.values()].filter((g) => !g.qid).sort((a, b) => b.total - a.total || a.key.localeCompare(b.key))) {
    const layer = inferLayer(g);
    const type = dominantType(g);
    const qid = proposeId({ layer: layer === "screening" ? "core" : layer, label: dominantLabel(g), taken });
    taken.add(qid);
    g.qid = qid;
    g.via = "new";
    proposals.push({
      qid,
      key: g.key,
      group: g,
      total: g.total,
      type,
      layer,
      text: canonicalText(dominantLabel(g), { type }),
      surface_forms: [{ label: dominantLabel(g), count: g.total }],
    });
  }
  const pass2 = await jevPass2(proposals, { concurrency: args.concurrency, dryRun: args.dryRun });
  const remap = new Map();
  for (const p of proposals) if (p.mergedInto && p.mergedInto !== p.qid) remap.set(p.qid, p.mergedInto);
  for (const g of groups.values()) if (remap.has(g.qid)) g.qid = remap.get(g.qid);
  log(`pass 2: ${pass2.merged}/${pass2.asked} proposals merged into a more frequent proposal`);

  // 4. assemble canonical records
  const byQid = new Map();
  for (const g of groups.values()) {
    if (!byQid.has(g.qid)) byQid.set(g.qid, []);
    byQid.get(g.qid).push(g);
  }
  const records = [];
  for (const [qid, gs] of byQid) records.push(buildRecord(qid, gs, SEED.find((r) => r.qid === qid)));
  // seed rows the corpus never showed still belong in the bank
  for (const row of SEED) {
    if (byQid.has(row.qid)) continue;
    records.push({
      ...row,
      source: "seed",
      types_seen: [],
      surface_forms: [],
      options_seen: [],
      frequency: { total: 0, postings: 0, by_ats: {}, by_family: {} },
      _byCompany: new Map(),
      _byFamily: new Map(),
      _sections: new Map(),
      _groups: [],
    });
  }

  // a follow-up's parent is the field asked just before it, on the forms that ask it
  let dependencies = 0;
  for (const record of records) {
    if (!record._conditional || record.dependency) continue;
    const prev = new Map();
    for (const g of record._groups) for (const [key, c] of g.prevKeys) bump(prev, key, c);
    const parentKey = topKey(prev);
    const parent = parentKey ? groups.get(parentKey)?.qid : null;
    if (!parent || parent === record.qid) continue;
    record.dependency = { qid: parent, condition: "follow-up: only asked when the answer to that question selects it" };
    dependencies++;
  }
  log(`follow-ups: ${records.filter((r) => r._conditional).length} conditional questions, ${dependencies} linked to a parent`);

  // 5. route
  const bank = [];
  const familyRows = new Map(); // family → records
  const proposalRows = [];
  const pass3 = await jevPass3(records, { concurrency: args.concurrency, dryRun: args.dryRun });
  log(`pass 3: ${pass3.durable.size}/${pass3.asked} one-off questions judged durable family screening`);

  for (const record of records) {
    const durable = pass3.durable.has(record.qid);
    const decision = route(record, durable);
    if (decision.placement === "bank") {
      bank.push(record);
    } else if (decision.placement === "family") {
      // `layer` decides candidacy (this family's postings); `kind_default` stays whatever the
      // question's own semantics gave it, so a screening row that is really a policy gate or a
      // narrative prompt keeps producing its answer the right way.
      record.layer = "screening";
      record.promoted_by = durable && !decision.families.some((f) => (record._byFamily.get(f) ?? 0) >= RULES.family.minInFamily) ? "judgment" : "recurrence";
      record.family = decision.families[0];
      record.families = decision.families;
      record.qid = renameProposal(record, taken, { layer: "screening", family: decision.families[0] });
      bank.push(record);
      for (const family of decision.families) {
        if (!familyRows.has(family)) familyRows.set(family, []);
        familyRows.get(family).push(record);
      }
    } else if (decision.placement === "company") {
      record.layer = "company";
      record.company = decision.company;
      record.qid = renameProposal(record, taken, { layer: "company", company: decision.company });
      bank.push(record);
    } else {
      proposalRows.push(record);
    }
  }

  // 6. hard cap: questions.yaml stays readable; the weakest derived rows wait in proposals.yaml
  bank.sort(bankOrder);
  if (bank.length > RULES.maxBank) {
    const demotable = bank
      .filter((r) => r.source !== "seed" && (r.layer === "company" || r.layer === "screening"))
      .sort((a, b) => a.frequency.total - b.frequency.total || a.qid.localeCompare(b.qid));
    const demote = new Set(demotable.slice(0, bank.length - RULES.maxBank).map((r) => r.qid));
    for (const r of bank) if (demote.has(r.qid)) proposalRows.push(r);
    for (const [family, rows] of familyRows) familyRows.set(family, rows.filter((r) => !demote.has(r.qid)));
    const kept = bank.filter((r) => !demote.has(r.qid));
    bank.length = 0;
    bank.push(...kept);
    log(`cap: demoted ${demote.size} low-frequency rows to proposals.yaml (bank cap ${RULES.maxBank})`);
  }

  // 7. templates — the id list an employer's form actually uses
  const qidOf = new Map();
  for (const g of groups.values()) qidOf.set(g.key, g.qid);
  const inBank = new Set(bank.map((r) => r.qid));
  const templates = buildTemplates(postings, qidOf, inBank);

  // 8. vocabularies
  const vocabs = [];
  for (const record of bank) {
    const vocab = buildVocab(record);
    if (vocab) vocabs.push(vocab);
  }

  // 9. write
  const out = args.out;
  await mkdir(out, { recursive: true });
  await Promise.all([
    resetDir(path.join(out, "families")),
    resetDir(path.join(out, "vocab"), { keep: /^eeo-.+\.yaml$/ }),
    resetDir(path.join(out, "templates")),
  ]);

  await writeYaml(
    path.join(out, "questions.yaml"),
    `${bank.length} canonical questions from ${postings.length} postings`,
    {
      version: 1,
      generated: new Date().toISOString().slice(0, 10),
      corpus: { postings: postings.length, instances, holdout, labels: groups.size },
      questions: bank.map((r) => publicRow(r)),
    },
  );

  let familyFiles = 0;
  let familyRowCount = 0;
  const postingsPerFamily = new Map();
  for (const p of postings) bump(postingsPerFamily, p.family);
  for (const family of FAMILY_IDS) {
    const rows = (familyRows.get(family) ?? []).sort((a, b) => (b._byFamily.get(family) ?? 0) - (a._byFamily.get(family) ?? 0) || a.qid.localeCompare(b.qid));
    if (!rows.length) continue;
    familyFiles++;
    familyRowCount += rows.length;
    await writeYaml(path.join(out, "families", `${family}.yaml`), `screening layer for ${family}`, {
      family,
      postings: postingsPerFamily.get(family) ?? 0,
      questions: rows.map((r) => ({
        qid: r.qid,
        text: r.text,
        type: r.type,
        answer_shape: r.answer_shape,
        kind_default: r.kind_default,
        count_in_family: r._byFamily.get(family) ?? 0,
        total: r.frequency.total,
        also_in: (r.families ?? []).filter((f) => f !== family),
        surface_forms: r.surface_forms.slice(0, 3).map((f) => f.label),
      })),
    });
  }

  for (const vocab of vocabs) {
    await writeYaml(path.join(out, "vocab", `${vocab.qid}.yaml`), `option aliases for ${vocab.qid}`, vocab);
  }
  for (const template of templates) {
    await writeYaml(path.join(out, "templates", `${template.company}.yaml`), `form template for ${template.company}`, template);
  }

  proposalRows.sort((a, b) => b.frequency.total - a.frequency.total || a.qid.localeCompare(b.qid));
  await writeYaml(path.join(out, "proposals.yaml"), `${proposalRows.length} clustered questions awaiting review`, {
    version: 1,
    generated: new Date().toISOString().slice(0, 10),
    note: "Clustered but below every promotion rule in scripts/canon-cluster.mjs (RULES). Review, then move a row into questions.yaml or a families/ file.",
    proposals: proposalRows.map((r) =>
      publicRow(r, {
        seen_in: {
          companies: [...r._byCompany.keys()].sort(),
          families: [...r._byFamily.keys()].sort(),
        },
      }),
    ),
  });

  const jev = {
    requests: pass1.requests + pass2.requests + pass3.requests,
    questions: pass1.asked + pass2.asked + pass3.asked,
    failed: pass1.failed + pass2.failed + pass3.failed,
    usage: {
      input_tokens: pass1.usage.input_tokens + pass2.usage.input_tokens + pass3.usage.input_tokens,
      output_tokens: pass1.usage.output_tokens + pass2.usage.output_tokens + pass3.usage.output_tokens,
    },
  };
  const counts = {
    groups: groups.size,
    exact,
    jevMatched: pass1.matched,
    new: proposals.length,
    merged: pass2.merged,
    durable: pass3.durable.size,
    durableAsked: pass3.asked,
    conditional: records.filter((r) => r._conditional).length,
    bank: bank.length,
    familyFiles,
    familyRows: familyRowCount,
    vocab: vocabs.length,
    templates: templates.length,
    proposals: proposalRows.length,
  };
  const ms = Date.now() - started;

  await writeFile(
    path.join(out, "README.md"),
    README({ records, counts, postings: postings.length, instances, holdout, jev, ms, bank: bank.length }),
    "utf8",
  );

  process.stdout.write(`${coverageTable({ records: [...bank, ...proposalRows.map((r) => ({ ...r, layer: "proposal" }))], groups, instances, jev, ms, counts })}\n`);
}

/** A promoted proposal gets an id that spells out where it landed (`q.screening.mobile.…`). */
function renameProposal(record, taken, { layer, family, company }) {
  if (record.source === "seed") return record.qid;
  const next = proposeId({ layer, label: record.surface_forms[0]?.label ?? record.text, family, company, taken });
  taken.add(next);
  // the label groups carry the id the template pass reads back, so they move with the record
  for (const g of record._groups ?? []) g.qid = next;
  return next;
}

const LAYER_ORDER = new Map(LAYERS.map((l, i) => [l, i]));
function bankOrder(a, b) {
  const la = LAYER_ORDER.get(a.layer) ?? 99;
  const lb = LAYER_ORDER.get(b.layer) ?? 99;
  if (la !== lb) return la - lb;
  if (a.source !== b.source) return a.source === "seed" ? -1 : 1;
  return b.frequency.total - a.frequency.total || a.qid.localeCompare(b.qid);
}

/** Per-company id lists: the questions that employer asks on nearly every posting. */
function buildTemplates(postings, qidOf, inBank) {
  const byCompany = new Map();
  for (const posting of postings) {
    if (!byCompany.has(posting.company)) byCompany.set(posting.company, []);
    byCompany.get(posting.company).push(posting);
  }
  const templates = [];
  for (const [company, rows] of [...byCompany.entries()].sort()) {
    if (rows.length < RULES.template.minPostings) continue;
    const presence = new Map();
    const position = new Map();
    for (const posting of rows) {
      const ids = [];
      for (const q of posting.questions ?? []) {
        const qid = qidOf.get(normalizeLabel(q.label));
        if (qid && !ids.includes(qid)) ids.push(qid);
      }
      ids.forEach((qid, i) => {
        bump(presence, qid);
        if (!position.has(qid)) position.set(qid, []);
        position.get(qid).push(i);
      });
    }
    const shared = new Set([...presence.entries()].filter(([, c]) => c / rows.length >= RULES.template.presence).map(([qid]) => qid));
    if (!shared.size) continue;
    let fit = 0;
    for (const posting of rows) {
      const ids = new Set();
      for (const q of posting.questions ?? []) {
        const qid = qidOf.get(normalizeLabel(q.label));
        if (qid) ids.add(qid);
      }
      if (!ids.size) continue;
      fit += [...ids].filter((id) => shared.has(id)).length / ids.size;
    }
    fit /= rows.length;
    if (fit < RULES.template.fit) continue;
    const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const questions = [...shared].sort((a, b) => median(position.get(a)) - median(position.get(b)) || a.localeCompare(b));
    templates.push({
      company,
      postings: rows.length,
      fit: Number(fit.toFixed(2)),
      questions,
      unbanked: questions.filter((q) => !inBank.has(q)),
    });
  }
  return templates;
}

main().catch((err) => {
  log(`canon-cluster failed: ${err.stack ?? err.message}`);
  process.exit(1);
});
