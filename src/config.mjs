// Constants, private-data paths, and the env-file loader. No I/O at import time.
// Nothing here ever writes under the repo: user data lives in CONFIG_DIR (PLAN D11).

import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Pinned decider (PLAN D2). Aliases (`jev-latest`) move; this must not. */
export const JEV_MODEL = "jev-1.13.0";

// Writer model (PLAN D3: OpenAI Responses API, new text only).
// Picked from skill://openai-llm's tier map (current generation gpt-5.4):
// STANDARD `gpt-5.4` is the recommended default for synthesis-style work and is what the
// writer does — expand a matched story to ~200 words, write a why_us paragraph — inside the
// 120 s per-posting budget. DEEP `gpt-5.4-pro` is reserved for deliberate high-stakes passes
// (slow + costly, not the fill path); FAST `gpt-5.4-mini` is the tier the same map names for
// structured extraction, which is what résumé parsing is.
export const OPENAI_MODEL = "gpt-5.4";
export const OPENAI_MODEL_FAST = "gpt-5.4-mini";

/**
 * USD per million tokens, for the `usage` block `apply.mjs` prints and the bench's `$` column.
 * A rate this file cannot vouch for is `null`, and every consumer then prints `cost: unknown`
 * rather than a guessed number.
 *
 * Jev: $0.042 / Mtok input, output free — https://docs.typesafe.ai/models.md, recorded in
 * docs/research/03-typesafe-jev-api.md §Limits and re-confirmed in 08-skeptic-review.md row 4.
 * That page warns its limits "can change without notice", so treat this as early-access pricing.
 *
 * OpenAI: Standard tier, short context (< 272k), from developers.openai.com/api/docs/pricing
 * read 2026-09-23 — `gpt-5.4` $2.50 in / $15.00 out, `gpt-5.4-mini` $0.75 in / $4.50 out.
 * Cached-input ($0.25 / $0.075) is deliberately *not* modelled: the writer's prompts carry a
 * different story per call, so assuming a cache hit would under-report. Batch and Fast tiers
 * are not used by this runner.
 */
export const PRICING = {
  jev: { input_per_mtok: 0.042, output_per_mtok: 0 },
  openai: {
    "gpt-5.4": { input_per_mtok: 2.5, output_per_mtok: 15.0 },
    "gpt-5.4-mini": { input_per_mtok: 0.75, output_per_mtok: 4.5 },
    // An unkeyed loopback server has no provider bill. Keyed or remote compatible
    // endpoints are recorded under `compatible:<model>` with unknown cost.
    local: { input_per_mtok: 0, output_per_mtok: 0 },
  },
};

/** Repo root (public code, canon bank, recorded public corpus). Never user data. */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

/** Private data root, 0700. Override with JEV_APPLY_HOME (tests, alternate profiles). */
export const CONFIG_DIR = process.env.JEV_APPLY_HOME
  ? path.resolve(process.env.JEV_APPLY_HOME)
  : path.join(homedir(), ".config", "jev-apply");

/**
 * Everything the runner reads or writes. `env`…`profile` are private (CONFIG_DIR);
 * `corpus`, `canon`, `fixtures` are public repo content (question text only, no user data).
 */
export const paths = {
  env: path.join(CONFIG_DIR, "env"),
  configJson: path.join(CONFIG_DIR, "config.json"),
  memory: path.join(CONFIG_DIR, "memory"),
  documents: path.join(CONFIG_DIR, "documents"),
  applications: path.join(CONFIG_DIR, "applications"),
  pipeline: path.join(CONFIG_DIR, "pipeline"),
  profile: path.join(CONFIG_DIR, "profile"),
  companies: path.join(CONFIG_DIR, "companies.yml"),
  corpus: path.join(REPO_ROOT, "corpus"),
  canon: path.join(REPO_ROOT, "canon"),
  fixtures: path.join(REPO_ROOT, "eval", "fixtures"),
};

/** Private directories `scripts/install.mjs` creates, in order. */
export const PRIVATE_DIRS = [
  CONFIG_DIR,
  paths.memory,
  paths.documents,
  paths.applications,
  paths.pipeline,
  paths.profile,
];

/** Where a user gets each credential; used by the fail-fast message and scripts/install.mjs. */
export const SIGNUP = {
  TYPESAFE_API_KEY: "https://console.typesafe.ai/keys",
  OPENAI_API_KEY: "https://platform.openai.com/api-keys",
};

/**
 * The one credential jev-apply cannot run without: Jev is what decides every answer.
 * `loadEnv({ require })` narrows this for single-service scripts.
 */
export const REQUIRED_KEYS = ["TYPESAFE_API_KEY"];

/**
 * Optional writer settings. OpenAI uses its own key and accepts a model override; another
 * OpenAI-compatible endpoint needs a URL and model, and may need its own bearer key.
 */
export const WRITER_URL_VAR = "JEV_APPLY_WRITER_URL";
export const WRITER_MODEL_VAR = "JEV_APPLY_WRITER_MODEL";
export const WRITER_KEY_VAR = "JEV_APPLY_WRITER_KEY";
export const OPTIONAL_KEYS = ["OPENAI_API_KEY", WRITER_KEY_VAR];

/**
 * An explicit process-level URL selects its endpoint even when an OpenAI key is on file.
 * Otherwise an OpenAI key wins, unless the endpoint has its own key. No configured writer
 * means the host agent drafts; it never means a guessed answer.
 */
export function writerFromEnv(env = process.env, { preferLocal = false } = {}) {
  const has = (name) => String(env[name] ?? "").trim();
  const endpoint = has(WRITER_URL_VAR);
  const named = has(WRITER_MODEL_VAR);
  const key = has(WRITER_KEY_VAR);
  if (key && !endpoint) throw new Error(`${WRITER_KEY_VAR} requires ${WRITER_URL_VAR}`);
  const server = () => {
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error(`${WRITER_URL_VAR} must be a valid HTTPS URL or a loopback HTTP URL`);
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
        url.username || url.password || url.search || url.hash) {
      throw new Error(`${WRITER_URL_VAR} must use HTTPS (HTTP only on loopback), with no credentials or query`);
    }
    return { kind: loopback && !key ? "local" : "compatible", model: named || null, baseURL: url.href.replace(/\/+$/, "") };
  };
  if (endpoint && (preferLocal || key)) return server();
  if (has("OPENAI_API_KEY")) return { kind: "openai", model: named || OPENAI_MODEL, modelOverride: Boolean(named), baseURL: null };
  if (endpoint) return server();
  return { kind: "host", model: null, baseURL: null };
}

/** `KEY=VALUE` / `export KEY="VALUE"` lines; `#` comments; values are never logged. */
function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function missingKeyError(names, hasFile) {
  const lines = [
    `jev-apply: missing ${names.length > 1 ? "credentials" : "credential"} ${names.join(", ")}.`,
    hasFile
      ? `Add ${names.length > 1 ? "them" : "it"} to ${paths.env} (KEY=VALUE, one per line, chmod 600):`
      : `Create ${paths.env} (chmod 600) with:`,
  ];
  const width = Math.max(...names.map((n) => n.length)) + 3;
  for (const name of names) lines.push(`  ${`${name}=…`.padEnd(width)}  # ${SIGNUP[name] ?? "see docs/PLAN.md"}`);
  lines.push("Then re-run. `node scripts/install.mjs` prepares the rest of the tree.");
  const err = new Error(lines.join("\n"));
  err.code = "JEV_MISSING_ENV";
  err.missing = names;
  err.envFile = paths.env;
  return err;
}

/**
 * Read CONFIG_DIR/env into process.env (never overwriting a variable the caller already set) and
 * return the credentials. Throws a fail-fast Error naming every missing required variable and its
 * signup URL.
 *
 * A variable that is present but empty is left empty: `OPENAI_API_KEY= node scripts/apply.mjs …`
 * means "not this run", and filling it from the file would take that choice away
 * (src/writer/backend.mjs detectWriter).
 * @param {{ require?: string[] }} [opts] subset of REQUIRED_KEYS a caller actually needs.
 */
export function loadEnv(opts = {}) {
  const required = opts.require ?? REQUIRED_KEYS;
  let hasFile = true;
  try {
    const parsed = parseEnvFile(readFileSync(paths.env, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    hasFile = false;
  }
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw missingKeyError(missing, hasFile);
  return {
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
}

/** "Acme Inc. / Senior Engineer #123" → "acme-inc-senior-engineer-123". */
export function slugify(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
}
