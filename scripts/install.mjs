#!/usr/bin/env node
// Prepare the private data directory (PLAN D11). Idempotent, and it never touches secrets:
// the `env` file is read for *presence only* and is never created, overwritten, or printed.
// One JSON object on stdout; the human-readable tree also goes to stderr.

import { mkdirSync, chmodSync, statSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR, PRIVATE_DIRS, REQUIRED_KEYS, SIGNUP, paths } from "../src/config.mjs";

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

// env: presence and variable names only. Values are never read into the output.
let envPresent = true;
let names = [];
try {
  names = readFileSync(paths.env, "utf8")
    .split("\n")
    .map((l) => l.trim().replace(/^export\s+/, ""))
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => l.slice(0, l.indexOf("=")).trim());
} catch (err) {
  if (err.code !== "ENOENT") throw err;
  envPresent = false;
}
const present = Object.fromEntries(REQUIRED_KEYS.map((k) => [k, names.includes(k) || Boolean(process.env[k])]));
const missing = REQUIRED_KEYS.filter((k) => !present[k]);
tree.push(`${label(paths.env)}  ${envPresent ? mode(paths.env) : "----"}  ${envPresent ? "existed (not modified)" : "MISSING"}`);

const out = {
  status: missing.length ? "needs_user" : "ready",
  configDir: CONFIG_DIR,
  tree,
  created,
  env: { path: paths.env, present: envPresent, keys: present },
};

if (missing.length) {
  out.reason = "missing_env";
  out.missing = missing;
  out.signup = Object.fromEntries(missing.map((k) => [k, SIGNUP[k]]));
  out.message = [
    `jev-apply cannot run until ${paths.env} holds ${missing.join(" and ")}.`,
    "Create it with `chmod 600` and one KEY=VALUE per line:",
    ...missing.map((k) => `  ${`${k}=…`.padEnd(Math.max(...missing.map((m) => m.length)) + 3)}  # get a key at ${SIGNUP[k]}`),
    "Nothing else is needed; re-run `node scripts/install.mjs` to confirm.",
  ].join("\n");
}

process.stdout.write(JSON.stringify(out) + "\n");
process.stderr.write(`${CONFIG_DIR}\n${tree.map((l) => `  ${l}`).join("\n")}\n`);
if (out.message) process.stderr.write(`\n${out.message}\n`);
process.exit(0);
