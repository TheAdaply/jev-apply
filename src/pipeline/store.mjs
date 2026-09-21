// The pipeline store: `CONFIG_DIR/pipeline/pipeline.yaml` (the record) + `scan-history.tsv`
// (the append-only ledger of every posting ever seen, which is what makes a re-scan add zero
// duplicates). Both are written tmp + fsync + rename, 0600 — a crashed scan leaves the previous
// good file or the new one, never half of both (PLAN §2.5, CONTRACTS §pipeline).
//
// Nothing here calls a model and nothing here writes under the repo.

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import YAML from "yaml";

import { paths, slugify } from "../config.mjs";
import { assertTransition, isStatus, TERMINAL } from "./status.mjs";
import { companyRoleKey, normalizeUrl } from "../discover/dedupe.mjs";
import { byFit, render } from "./render.mjs";

// Re-exported so one import of the store is the whole pipeline surface (CONTRACTS §pipeline).
export { render } from "./render.mjs";
export { STATUSES, TRANSITIONS, isStatus, canTransition } from "./status.mjs";

export const PIPELINE_FILE = "pipeline.yaml";
export const HISTORY_FILE = "scan-history.tsv";
export const MARKDOWN_FILE = "pipeline.md";

/** Column order of `scan-history.tsv`. Readers use the file's own header, so this may only grow. */
export const HISTORY_COLUMNS = [
  "url",
  "first_seen",
  "provider",
  "title",
  "company",
  "status",
  "location",
  "fingerprint",
];

const YAML_OPTS = { lineWidth: 0 };
const FILE_HEADER = `# jev-apply pipeline — written by scripts/scan.mjs and scripts/pipeline.mjs.\n# Private user data (PLAN D11). ${MARKDOWN_FILE} next to it is a generated view.\n`;

/** `"2026-09-22"` — the same timestamp format the memory store uses. */
export const stamp = (date = new Date()) => new Date(date).toISOString().slice(0, 10);

export const pipelineDir = () => paths.pipeline;
export const pipelinePath = () => path.join(paths.pipeline, PIPELINE_FILE);
export const historyPath = () => path.join(paths.pipeline, HISTORY_FILE);
export const markdownPath = () => path.join(paths.pipeline, MARKDOWN_FILE);

// ─── files ────────────────────────────────────────────────────────────────────────────────────

async function readIfPresent(file) {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** tmp + fsync + rename, 0600. */
async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  let handle;
  try {
    handle = await open(tmp, "w", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmp, file);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return file;
}

// ─── ids ──────────────────────────────────────────────────────────────────────────────────────

/** Ashby and Lever board ids are UUIDs; 10 hex digits keep an id typable and still unique. */
const shorten = (slug) => (slug.length > 12 ? slug.replace(/-/g, "").slice(0, 10) : slug);

/**
 * `<company-slug>-<board id>` — stable across runs, which is what lets a second scan recognize a
 * posting and what makes `queue <id>` / `mark <id>` typable. Boards without a usable id fall back
 * to a short digest of the normalized URL (never a random or positional number).
 */
export function jobId(job) {
  const company = slugify(job?.company ?? job?.provider ?? "job");
  const raw = job?.externalId ?? job?.id;
  const text = raw === undefined || raw === null ? "" : String(raw).trim();
  const external = text
    ? shorten(slugify(text))
    : createHash("sha1")
        .update(normalizeUrl(job?.url ?? job?.applyUrl) ?? String(job?.title ?? ""))
        .digest("hex")
        .slice(0, 10);
  return `${company}-${external}`;
}

// ─── pipeline.yaml ────────────────────────────────────────────────────────────────────────────

/** Field order of a stored entry (PLAN §2.5 plus the three fields the runner needs). */
function entryFrom(job, { status = "found", now = stamp() } = {}) {
  return {
    id: job.id ?? jobId(job),
    url: job.url ?? job.applyUrl ?? null,
    company: job.company ?? null,
    title: job.title ?? null,
    provider: job.provider ?? null,
    location: job.location ?? null,
    fit: typeof job.fit === "number" ? job.fit : null,
    reason: job.reason ?? null,
    dealbreaker: typeof job.dealbreaker === "number" ? job.dealbreaker : null,
    status,
    found: now,
    last_seen: now,
    updated: now,
    applied_at: null,
    application: null,
    notes: [],
  };
}

function normalizeEntry(row) {
  if (!row || typeof row !== "object" || typeof row.id !== "string") return null;
  const entry = entryFrom(row, { status: isStatus(row.status) ? row.status : "found", now: row.found ?? stamp() });
  entry.found = row.found ?? entry.found;
  entry.last_seen = row.last_seen ?? entry.found;
  entry.updated = row.updated ?? entry.found;
  entry.applied_at = row.applied_at ?? null;
  entry.application = row.application ?? null;
  entry.notes = Array.isArray(row.notes) ? row.notes : [];
  return entry;
}

/**
 * @returns {Promise<{version:number, updated:string|null, jobs:object[]}>} a missing file is an
 * empty pipeline. The shape `{jobs:[…]}` is what `memory/derive.appliedBefore` reads.
 */
export async function loadPipeline() {
  const text = await readIfPresent(pipelinePath());
  if (text == null) return { version: 1, updated: null, jobs: [] };
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    throw new Error(`pipeline/${PIPELINE_FILE} is not valid YAML: ${err.message}`);
  }
  const rows = Array.isArray(doc) ? doc : (doc?.jobs ?? []);
  return {
    version: doc?.version ?? 1,
    updated: doc?.updated ?? null,
    jobs: (Array.isArray(rows) ? rows : []).map(normalizeEntry).filter(Boolean),
  };
}

export async function savePipeline(pipeline) {
  const doc = {
    version: pipeline?.version ?? 1,
    updated: stamp(),
    jobs: (pipeline?.jobs ?? []).slice().sort(byFit),
  };
  await writeAtomic(pipelinePath(), FILE_HEADER + YAML.stringify(doc, YAML_OPTS));
  return doc;
}

// ─── scan-history.tsv ─────────────────────────────────────────────────────────────────────────

const tsv = (value) => String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();

function historyRow(entry, job) {
  return {
    url: entry.url ?? "",
    first_seen: entry.found,
    provider: entry.provider ?? "",
    title: entry.title ?? "",
    company: entry.company ?? "",
    status: entry.status,
    location: entry.location ?? "",
    fingerprint: companyRoleKey(job ?? entry),
  };
}

/** @returns {Promise<object[]>} every row ever appended, keyed by the file's own header. */
export async function loadHistory() {
  const text = await readIfPresent(historyPath());
  if (text == null) return [];
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const header = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const cols = line.split("\t");
    return Object.fromEntries(header.map((name, i) => [name, cols[i] ?? ""]));
  });
}

/**
 * Every key `discover/dedupe.dedupeJobs` should treat as already seen: the normalized URL of each
 * historical posting and its `company::role` fingerprint. This is the cross-run dedup (PLAN §2.5).
 */
export async function seenKeys() {
  const keys = new Set();
  for (const row of await loadHistory()) {
    const url = normalizeUrl(row.url);
    if (url) keys.add(url);
    if (row.fingerprint) keys.add(row.fingerprint);
  }
  return keys;
}

/** Append-only ledger, rewritten atomically so a crash can never truncate it. */
export async function appendHistory(rows) {
  if (!rows || rows.length === 0) return 0;
  const existing = await readIfPresent(historyPath());
  const header = HISTORY_COLUMNS.join("\t");
  const body = rows.map((row) => HISTORY_COLUMNS.map((c) => tsv(row[c])).join("\t")).join("\n");
  const prefix = existing == null ? `${header}\n` : existing.endsWith("\n") ? existing : `${existing}\n`;
  await writeAtomic(historyPath(), `${prefix}${body}\n`);
  return rows.length;
}

// ─── the operations `scan.mjs` and `pipeline.mjs` call ────────────────────────────────────────

/**
 * Add new postings as `found` and refresh the ones already on file. A status is never changed here:
 * a posting the user queued yesterday and the board still lists today stays `queued`.
 * @param {object[]} jobs discover Jobs, optionally carrying `fit`/`reason`/`dealbreaker`.
 * @returns {Promise<{added:number, updated:number, ids:string[], entries:object[]}>}
 */
export async function upsertJobs(jobs, { status = "found" } = {}) {
  const pipeline = await loadPipeline();
  const byId = new Map(pipeline.jobs.map((e) => [e.id, e]));
  const now = stamp();
  const added = [];
  const touched = [];
  const history = [];

  for (const job of jobs ?? []) {
    const id = job.id ?? jobId(job);
    const existing = byId.get(id);
    if (existing) {
      existing.title = job.title ?? existing.title;
      existing.url = job.url ?? job.applyUrl ?? existing.url;
      existing.location = job.location ?? existing.location;
      if (typeof job.fit === "number") existing.fit = job.fit;
      if (job.reason !== undefined && job.reason !== null) existing.reason = job.reason;
      if (typeof job.dealbreaker === "number") existing.dealbreaker = job.dealbreaker;
      existing.last_seen = now;
      existing.updated = now;
      touched.push(existing);
      continue;
    }
    const entry = entryFrom({ ...job, id }, { status, now });
    byId.set(id, entry);
    added.push(entry);
    history.push(historyRow(entry, job));
  }

  pipeline.jobs = [...byId.values()];
  await savePipeline(pipeline);
  await appendHistory(history);
  return {
    added: added.length,
    updated: touched.length,
    ids: added.map((e) => e.id),
    entries: [...added, ...touched],
  };
}

/** One status change, transition-checked, with an audit note. Throws on unknown id or illegal move. */
export async function setStatus(id, status, note) {
  const pipeline = await loadPipeline();
  const entry = pipeline.jobs.find((e) => e.id === id);
  if (!entry) throw new Error(`no pipeline entry with id "${id}"`);
  const from = entry.status;
  assertTransition(from, status);
  applyStatus(entry, status, note);
  await savePipeline(pipeline);
  return entry;
}

function applyStatus(entry, status, note) {
  const now = stamp();
  const from = entry.status;
  entry.status = status;
  entry.updated = now;
  if (status === "applied" && !entry.applied_at) entry.applied_at = now;
  entry.notes = Array.isArray(entry.notes) ? entry.notes : [];
  entry.notes.push({ when: now, from, to: status, ...(note ? { note: String(note) } : {}) });
  return entry;
}

/**
 * Shortlist postings for `apply.mjs --queue N`. One load/save for the whole batch.
 * @returns {Promise<{queued:string[], skipped:Array<{id:string, reason:string}>}>}
 */
export async function queue(ids, note) {
  const pipeline = await loadPipeline();
  const byId = new Map(pipeline.jobs.map((e) => [e.id, e]));
  const queued = [];
  const skipped = [];
  for (const id of ids ?? []) {
    const entry = byId.get(id);
    if (!entry) {
      skipped.push({ id, reason: "no such id" });
      continue;
    }
    try {
      assertTransition(entry.status, "queued");
    } catch (err) {
      skipped.push({ id, reason: err.message });
      continue;
    }
    applyStatus(entry, "queued", note);
    queued.push(id);
  }
  if (queued.length > 0) await savePipeline(pipeline);
  return { queued, skipped };
}

/** The next `n` queued postings, best fit first — what `apply.mjs --queue N` drains. */
export async function nextQueued(n = 1) {
  const pipeline = await loadPipeline();
  return pipeline.jobs
    .filter((e) => e.status === "queued")
    .sort(byFit)
    .slice(0, Math.max(0, n));
}

/**
 * Housekeeping: postings a board stopped listing go `expired`, and long-finished entries leave the
 * record. Their history rows stay, so a pruned posting is never re-discovered as new.
 * @returns {Promise<{expired:number, removed:number, kept:number}>}
 */
export async function prune({ staleDays = 30, keepDays = 90, now = new Date() } = {}) {
  const pipeline = await loadPipeline();
  const ms = 86_400_000;
  const staleBefore = stamp(new Date(now.getTime() - staleDays * ms));
  const dropBefore = stamp(new Date(now.getTime() - keepDays * ms));

  let expired = 0;
  for (const entry of pipeline.jobs) {
    if (entry.status !== "found") continue;
    if (String(entry.last_seen ?? entry.found) >= staleBefore) continue;
    applyStatus(entry, "expired", `not listed since ${entry.last_seen ?? entry.found}`);
    expired++;
  }

  const before = pipeline.jobs.length;
  pipeline.jobs = pipeline.jobs.filter(
    (entry) => !(TERMINAL.has(entry.status) && String(entry.updated ?? entry.found) < dropBefore),
  );
  const removed = before - pipeline.jobs.length;

  if (expired > 0 || removed > 0) await savePipeline(pipeline);
  return { expired, removed, kept: pipeline.jobs.length };
}

/** Write the Markdown view next to the YAML. @returns {Promise<string>} the path. */
export async function renderToFile(pipeline) {
  const doc = pipeline ?? (await loadPipeline());
  await writeAtomic(markdownPath(), render(doc));
  return markdownPath();
}
