// The private memory store: one YAML file per section under CONFIG_DIR/memory, atomic writes.
// Nothing here ever writes under the repo (PLAN D11) and nothing here calls a model.

import { constants as FS } from "node:fs";
import { access, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";

import { paths } from "../config.mjs";
import {
  SECTIONS,
  SECTION_FILE,
  emptyMemory,
  isUserSourced,
  normalizeSection,
  rowKey,
  stamp,
  validateRow,
} from "./schema.mjs";
import { getFact, resolvePreference } from "./resolve.mjs";

// Re-exported so one import of the store gives a caller the whole read surface (CONTRACTS §memory).
export { getFact, resolvePreference };
export { SECTIONS } from "./schema.mjs";

const YAML_OPTS = { lineWidth: 0 };
const BASELINES_FILE = "salary-baselines.yaml";

export function memoryDir() {
  return paths.memory;
}

export function sectionPath(name) {
  const file = SECTION_FILE[name];
  if (!file) throw new Error(`unknown memory section: ${name}`);
  return path.join(paths.memory, file);
}

async function readIfPresent(file) {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** tmp + fsync + rename, 0600 — a crashed write never leaves a half-parsed memory file. */
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

/** @returns {Promise<object[]>} one section's rows; a missing file is an empty section. */
export async function loadSection(name) {
  const file = sectionPath(name);
  const text = await readIfPresent(file);
  if (text == null) return [];
  let parsed;
  try {
    parsed = YAML.parse(text);
  } catch (err) {
    throw new Error(`memory/${SECTION_FILE[name]} is not valid YAML: ${err.message}`);
  }
  return normalizeSection(name, parsed);
}

/** `{facts, preferences, documents, answers, stories, drafts, corrections}`, always arrays. */
export async function loadMemory() {
  const mem = emptyMemory();
  await Promise.all(SECTIONS.map(async (name) => { mem[name] = await loadSection(name); }));
  return mem;
}

/**
 * Replace a whole section. Every row is validated first: the file on disk is either the previous
 * good state or the new good state, never a partially-valid mixture.
 */
export async function saveSection(name, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const problems = list.flatMap((row) => validateRow(name, row).map((p) => `${p} (${rowKey(name, row) ?? "?"})`));
  if (problems.length) {
    throw new Error(`refusing to write memory/${SECTION_FILE[name]}: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ""}`);
  }
  const header = `# jev-apply memory — ${name} (${list.length} rows, written ${stamp()})\n# Private user data. Never copied into the repo. See references/memory-format.md.\n`;
  await writeAtomic(sectionPath(name), header + YAML.stringify(list, YAML_OPTS));
  return { section: name, path: sectionPath(name), rows: list.length };
}

/**
 * Merge proposed rows into a section by row identity.
 * A row the user stated (`source: user`) is never overwritten by anything else (PLAN §2.4).
 * @returns {Promise<{added:number, updated:number, kept_user:number, rejected:string[]}>}
 */
export async function mergeSection(name, incoming, { overwriteUser = false } = {}) {
  const existing = await loadSection(name);
  const index = new Map(existing.map((row, i) => [rowKey(name, row), i]));
  const result = { added: 0, updated: 0, kept_user: 0, rejected: [] };

  for (const raw of incoming ?? []) {
    const problems = validateRow(name, raw);
    if (problems.length) {
      result.rejected.push(problems[0]);
      continue;
    }
    const key = rowKey(name, raw);
    const at = index.get(key);
    if (at === undefined) {
      existing.push({ ...raw, updated: raw.updated ?? stamp() });
      index.set(key, existing.length - 1);
      result.added += 1;
      continue;
    }
    const current = existing[at];
    if (!overwriteUser && isUserSourced(current) && !isUserSourced(raw)) {
      result.kept_user += 1;
      continue;
    }
    existing[at] = { ...current, ...raw, updated: raw.updated ?? stamp() };
    result.updated += 1;
  }
  await saveSection(name, existing);
  return { ...result, rows: existing.length };
}

/** Add or replace one row; same user-precedence rule as `mergeSection`. */
export async function upsertRow(name, row, opts = {}) {
  const result = await mergeSection(name, [row], opts);
  if (result.rejected.length) throw new Error(`invalid ${name} row: ${result.rejected[0]}`);
  return { ...result, id: rowKey(name, row) };
}

/** The salary table `learn.mjs --seed` installs next to the sections; parsed, never generated. */
export async function loadBaselines() {
  const text = await readIfPresent(path.join(paths.memory, BASELINES_FILE));
  if (text == null) return null;
  try {
    return YAML.parse(text);
  } catch (err) {
    throw new Error(`memory/${BASELINES_FILE} is not valid YAML: ${err.message}`);
  }
}

/** Install a side file (the salary table) verbatim — its comments carry the answering rule. */
export async function saveAuxText(file, text) {
  return writeAtomic(path.join(paths.memory, file), text);
}

export const BASELINES = BASELINES_FILE;

/** Copy a document into CONFIG_DIR/documents and return its installed path + sha256. */
export async function installDocument(sourcePath, { name } = {}) {
  const { createHash } = await import("node:crypto");
  const bytes = await readFile(sourcePath);
  const target = path.join(paths.documents, name ?? path.basename(sourcePath));
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, target);
  return { path: target, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

export async function exists(file) {
  try {
    await access(file, FS.R_OK);
    return true;
  } catch {
    return false;
  }
}
