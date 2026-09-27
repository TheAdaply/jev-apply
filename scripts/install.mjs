#!/usr/bin/env node
// Prepare the private data directory (PLAN D11). Idempotent; it never writes secrets:
// it checks nonempty credential presence without printing values or changing the env file.
// One JSON object on stdout; the human-readable tree also goes to stderr.

import { mkdirSync, chmodSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CONFIG_DIR,
  OPTIONAL_KEYS,
  PRIVATE_DIRS,
  REQUIRED_KEYS,
  SIGNUP,
  WRITER_KEY_VAR,
  WRITER_MODEL_VAR,
  WRITER_URL_VAR,
  loadEnv,
  paths,
} from "../src/config.mjs";
import { describeWriter, detectWriter } from "../src/writer/backend.mjs";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const mode = (p) => (statSync(p).mode & 0o777).toString(8).padStart(4, "0");
const label = (p, isDir = false) => (p === CONFIG_DIR ? p : path.relative(CONFIG_DIR, p) + (isDir ? "/" : ""));

const tree = [];
const created = [];

for (const dir of PRIVATE_DIRS) {
  let existed = true;
  try {
    statSync(dir);
  } catch {
    existed = false;
  }
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
  if (!existed) created.push(dir);
  tree.push(`${label(dir, true)}  ${mode(dir)}  ${existed ? "existed" : "created"}`);
}

// config.json: written only when absent, so a hand-edited profile path survives re-runs.
let configWritten = false;
try {
  statSync(paths.configJson);
} catch {
  writeFileSync(paths.configJson, JSON.stringify({ envFile: paths.env, profile: paths.profile }, null, 2) + "\n", {
    mode: FILE_MODE,
  });
  configWritten = true;
  created.push(paths.configJson);
}
chmodSync(paths.configJson, FILE_MODE);
tree.push(`${label(paths.configJson)}  ${mode(paths.configJson)}  ${configWritten ? "created" : "existed"}`);

// env: use the same parser as the runner. Blank keys (including explicit empty process overrides)
// are missing; values are never printed.
let envPresent = true;
try {
  statSync(paths.env);
} catch (err) {
  if (err.code !== "ENOENT") throw err;
  envPresent = false;
}
// Detection distinguishes a process-level writer URL from one stored in the env file.
const writer = detectWriter({ refresh: true });
loadEnv({ require: [] });
const keys = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
const present = Object.fromEntries(keys.map((k) => [k, Boolean(process.env[k]?.trim())]));
const missing = REQUIRED_KEYS.filter((k) => !present[k]);
tree.push(`${label(paths.env)}  ${envPresent ? mode(paths.env) : "----"}  ${envPresent ? "existed (not modified)" : "MISSING"}`);

/** Three ways to write from saved material; the agent handles drafts with no key. */
const WRITER_HELP = [
  "Writing (optional — only grounded new prose, never missing personal facts):",
  `  OPENAI_API_KEY=… and optional ${WRITER_MODEL_VAR}=…  # ${SIGNUP.OPENAI_API_KEY}`,
  `  ${WRITER_URL_VAR}=https://provider.example/v1 and ${WRITER_MODEL_VAR}=…`,
  `  ${WRITER_KEY_VAR}=…                  # if that OpenAI-compatible endpoint needs a key`,
  "  Or use a loopback URL (no key), or neither: your CLI agent drafts and jev-apply checks it.",
];

const out = {
  status: missing.length ? "needs_user" : "ready",
  configDir: CONFIG_DIR,
  tree,
  created,
  env: { path: paths.env, present: envPresent, keys: present },
  writer: { kind: writer.kind, detail: describeWriter(writer) },
};

if (missing.length) {
  out.reason = "missing_env";
  out.missing = missing;
  out.signup = Object.fromEntries(missing.map((k) => [k, SIGNUP[k]]));
  out.message = [
    `jev-apply cannot run until ${paths.env} holds ${missing.join(" and ")}.`,
    "Create it with `chmod 600` and one KEY=VALUE per line:",
    ...missing.map((k) => `  ${`${k}=…`.padEnd(Math.max(...missing.map((m) => m.length)) + 3)}  # get a key at ${SIGNUP[k]}`),
    "That one key is all jev-apply needs; re-run `node scripts/install.mjs` to confirm.",
    "",
    ...WRITER_HELP,
  ].join("\n");
} else {
  out.message = [`Ready. Writing: ${describeWriter(writer)}.`, ...(writer.kind === "openai" ? [] : ["", ...WRITER_HELP])].join("\n");
}

process.stdout.write(JSON.stringify(out) + "\n");
process.stderr.write(`${CONFIG_DIR}\n${tree.map((l) => `  ${l}`).join("\n")}\n`);
if (out.message) process.stderr.write(`\n${out.message}\n`);
process.exit(0);
