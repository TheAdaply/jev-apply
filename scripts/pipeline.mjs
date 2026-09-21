#!/usr/bin/env node
// The pipeline's user-facing verbs (PLAN §2.5, CONTRACTS §CLI).
//
//   node scripts/pipeline.mjs list [--status found] [--top 10] [--json]
//   node scripts/pipeline.mjs queue <id> [<id> …]          shortlist for `apply.mjs --queue N`
//   node scripts/pipeline.mjs mark <id> <status> [note]    transition-checked (src/pipeline/status.mjs)
//   node scripts/pipeline.mjs prune [--stale-days 30] [--keep-days 90]
//   node scripts/pipeline.mjs render                       writes pipeline.md next to pipeline.yaml
//
// `list` prints a table and `render` prints a path — both are read by a person. `queue`, `mark` and
// `prune` print one JSON object (`--json` makes `list` do the same). Exit 0, 1 only for a usage error.

import {
  loadPipeline,
  markdownPath,
  prune,
  queue,
  renderToFile,
  setStatus,
} from "../src/pipeline/store.mjs";
import { byFit, table } from "../src/pipeline/render.mjs";
import { isStatus, STATUSES } from "../src/pipeline/status.mjs";

const USAGE = [
  "usage: pipeline.mjs list [--status S] [--top N] [--json]",
  "       pipeline.mjs queue <id…> | mark <id> <status> [note] | prune | render",
  `status ∈ ${STATUSES.join(" | ")}`,
].join("\n");

const log = (line) => process.stderr.write(`${line}\n`);
const out = (value) => process.stdout.write(`${value}\n`);
const json = (value) => out(JSON.stringify(value));

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--status") flags.status = argv[++i];
    else if (a === "--top") flags.top = Number(argv[++i]);
    else if (a === "--stale-days") flags.staleDays = Number(argv[++i]);
    else if (a === "--keep-days") flags.keepDays = Number(argv[++i]);
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else rest.push(a);
  }
  return { flags, rest };
}

async function cmdList({ flags }) {
  const pipeline = await loadPipeline();
  if (flags.status && !isStatus(flags.status)) throw new Error(`unknown status "${flags.status}"`);

  const all = pipeline.jobs;
  const selected = (flags.status ? all.filter((e) => e.status === flags.status) : all).sort(byFit);
  const shown = Number.isFinite(flags.top) && flags.top > 0 ? selected.slice(0, flags.top) : selected;

  if (flags.json) return json({ status: "ok", total: all.length, matched: selected.length, jobs: shown });
  if (shown.length === 0) {
    out(all.length === 0 ? "pipeline is empty — run scan.mjs" : `no postings with status ${flags.status}`);
    return;
  }

  const counts = {};
  for (const entry of all) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  out(table(shown));
  out(
    `${shown.length} of ${selected.length}${flags.status ? ` ${flags.status}` : ""} shown · ` +
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([status, n]) => `${status} ${n}`)
        .join(" · "),
  );
}

async function cmdQueue({ rest }) {
  const ids = rest.slice(1);
  if (ids.length === 0) throw new Error("queue needs at least one id");
  const result = await queue(ids);
  json({ status: result.queued.length > 0 ? "ok" : "blocked", ...result });
}

async function cmdMark({ rest }) {
  const [, id, status, ...note] = rest;
  if (!id || !status) throw new Error("mark needs <id> <status> [note]");
  const entry = await setStatus(id, status, note.join(" ") || undefined);
  const last = entry.notes[entry.notes.length - 1];
  json({ status: "ok", id: entry.id, from: last?.from ?? null, to: entry.status });
}

async function cmdPrune({ flags }) {
  json({ status: "ok", ...(await prune(flags)) });
}

async function cmdRender() {
  await renderToFile();
  out(markdownPath());
}

const COMMANDS = { list: cmdList, queue: cmdQueue, mark: cmdMark, prune: cmdPrune, render: cmdRender };

const { flags, rest } = (() => {
  try {
    return parseFlags(process.argv.slice(2));
  } catch (err) {
    log(`${err.message}\n${USAGE}`);
    process.exit(1);
  }
})();

const command = COMMANDS[rest[0] ?? "list"];
if (!command) {
  log(`unknown command: ${rest[0]}\n${USAGE}`);
  process.exit(1);
}

try {
  await command({ flags, rest });
} catch (err) {
  json({ status: "blocked", reason: err.message });
  log(err.stack ?? String(err));
}
