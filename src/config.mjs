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

/** Both keys the product needs; `loadEnv({ require })` narrows this for single-service scripts. */
export const REQUIRED_KEYS = ["TYPESAFE_API_KEY", "OPENAI_API_KEY"];

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
 * Read CONFIG_DIR/env into process.env (never overwriting an already-set variable) and return
 * the credentials. Throws a fail-fast Error naming every missing variable and its signup URL.
 * @param {{ require?: string[] }} [opts] subset of REQUIRED_KEYS a caller actually needs.
 */
export function loadEnv(opts = {}) {
  const required = opts.require ?? REQUIRED_KEYS;
  let hasFile = true;
  try {
    const parsed = parseEnvFile(readFileSync(paths.env, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
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
