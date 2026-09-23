#!/usr/bin/env node
// The screenshot eval: fill a list of postings, photograph every form, and put the runner's own
// answer key next to the photographs.
//
//   node scripts/eval-shots.mjs --round round1 --profile synthetic --postings bench/postings.yml
//   node scripts/eval-shots.mjs --round round1 --profile synthetic --postings <url> <url> …
//   node scripts/eval-shots.mjs --round round1 --profile real --postings <url> [--limit 1]
//
// For each posting: `apply.mjs --url <posting> --no-submit --json` against the profile's home and
// CDP port, then a re-attach to that same Chrome to scroll the filled tab from top to bottom (so
// lazy sections mount) and save `full.png`, `viewport-<n>.png` (1280 CSS px, device-scale 2),
// `expected.json` (one row per Decision) and `result.json` (the runner's stdout) under
// `private/eval-shots/<round>/<profile>/<slug>/`. The tab is left open — it *is* the evidence.
//
// Two profiles, and the difference between them is the whole safety story:
//   synthetic  JEV_APPLY_HOME=/tmp/jev-bench, CDP 9224, the invented candidate from
//              `src/bench/synthetic.mjs`. This is the only profile that may be pointed at an
//              arbitrary live posting.
//   real       the user's own `~/.config/jev-apply`, CDP 9223, their real name and CV. Only ever
//              run on postings the user named.
//
// `--no-submit` is passed on every child, so no `p.auto_submit` preference in either home can
// turn a screenshot session into an application. `assertBenchPort` refuses to run when the
// browser answering on the profile's port is not that profile's own, so synthetic data can never
// reach the real Chrome and the real store can never be typed through the bench browser.
//
// The synthetic home is refreshed (idempotent) before the round; `scripts/answers.mjs` is *not*
// re-run — this eval measures the store as the benchmark left it, and re-seeding narratives would
// pay the writer for answers that are already on disk.
//
// One JSON object on stdout; progress and the round table on stderr; exit 0 unless the harness
// itself could not start.

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { REPO_ROOT } from "../src/config.mjs";
import { parseTrace } from "../src/bench/metrics.mjs";
import { loadPostings } from "../src/bench/postings.mjs";
import { assertBenchPort, loadSecrets, readArtifacts } from "../src/bench/run.mjs";
import {
  captureShots,
  countRows,
  draftReport,
  eeoOnFile,
  expectedRows,
  fallbackSlug,
  fieldIndex,
  profileFor,
  renderIndex,
  resetTab,
  runFill,
  shotsDir,
  writeJson,
} from "../src/bench/shots.mjs";
import { ensureSyntheticHome } from "../src/bench/synthetic.mjs";

const USAGE = [
  "usage: eval-shots.mjs --round <name> --profile synthetic|real",
  "       --postings <bench/postings.yml | url-list.txt | <url> [<url> …]>",
  "       [--limit N] [--timeout 300] [--close] [--no-submit] [--verbose]",
  "       eval-shots.mjs --round <name> --index-only",
  "",
  "  --postings    a postings file, or one or more posting URLs on the command line.",
  "  --limit N     only the first N of them.",
  "  --timeout     seconds per posting before the child is killed (default 300).",
  "  --no-submit   accepted and always true — every child is spawned with `--no-submit` whatever",
  "                either home's `p.auto_submit` says. There is no `--submit`.",
  "  --close       close each tab once its screenshots are on disk. Off by default: the filled tab",
  "                is the fixture (D12). Use it for long rounds against the real profile, where a",
  "                dozen filled forms left open in the user's own Chrome is its own hazard.",
  "  --index-only  re-render <round>/index.md from the profiles that already ran; fills nothing.",
].join("\n");

function parseArgs(argv) {
  const args = { postings: [], timeout: 300, verbose: false, indexOnly: false, close: false };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--round": args.round = next(); break;
      case "--profile": args.profile = next(); break;
      case "--postings":
        args.postings.push(next());
        // `--postings <url> <url> …`: every following bare word is another posting.
        while (argv[i + 1] && !argv[i + 1].startsWith("--")) args.postings.push(argv[++i]);
        break;
      case "--limit": args.limit = Number(next()); break;
      case "--timeout": args.timeout = Number(next()); break;
      case "--verbose": args.verbose = true; break;
      case "--close": args.close = true; break;
      case "--index-only": args.indexOnly = true; break;
      // Stating the invariant at the call site is allowed; changing it is not.
      case "--no-submit": break;
      default: throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  if (!args.round) throw new Error("need --round <name>");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(args.round)) throw new Error("--round takes a directory-safe name, e.g. round1");
  if (args.indexOnly) return args;
  if (!args.profile) throw new Error("need --profile synthetic|real");
  if (!args.postings.length) throw new Error("need --postings <file> or --postings <url> …");
  if (args.limit != null && (!Number.isInteger(args.limit) || args.limit < 1)) throw new Error("--limit takes a positive integer");
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) throw new Error("--timeout takes seconds");
  return args;
}

const log = (line) => process.stderr.write(`${line}\n`);
const stamp = () => new Date().toISOString();
const isUrl = (s) => /^https?:\/\//i.test(s);
const rel = (p) => path.relative(REPO_ROOT, p);

/**
 * A file of postings, or the URLs the caller typed. The URL form is written to a scratch list and
 * read back through `loadPostings`, so the company/ATS derivation has exactly one implementation;
 * the scratch file never outlives this function.
 */
async function resolvePostings(list) {
  if (list.length === 1 && !isUrl(list[0])) return loadPostings(list[0]);
  const bad = list.filter((u) => !isUrl(u));
  if (bad.length) throw new Error(`not a posting URL: ${bad[0]} (pass one file, or only URLs)`);

  const dir = path.join(REPO_ROOT, "private", "eval-shots");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `.urls-${process.pid}.txt`);
  await writeFile(file, `${list.join("\n")}\n`, { mode: 0o600 });
  try {
    return { ...(await loadPostings(file)), file: null, source: "urls" };
  } finally {
    await rm(file, { force: true });
  }
}

/**
 * One posting: reset its tab, fill it, write its answer key, photograph it. Never throws — a
 * failure is a row.
 *
 * The tab is reset *before* the fill because round 1's tabs are still open on both profiles (D12:
 * the runner never closes one). The runner reloads a tab it re-uses, but Chrome restores form
 * state across a reload, so a row this round leaves alone could be photographed still holding
 * last round's answer — the one failure mode that looks exactly like a wrong fill.
 *
 * The bench home and its Chrome are shared: another process filling the same posting between the
 * fill and the shutter would leave `expected.json` describing one state and the PNGs another. The
 * frozen record's `updated` stamp is read before and after the screenshots, and a row whose stamp
 * moved is marked `integrity.ok:false` instead of being reported as evidence.
 */
async function shootOne(posting, ctx) {
  const since = Date.now();
  log(`\n[${posting.n}/${ctx.total}] ${posting.company} · ${posting.ats} · ${posting.url}`);

  const reset = await resetTab({
    url: posting.url,
    home: ctx.home,
    port: ctx.port,
    onLog: (line) => log(`    ${line}`),
  });
  if (!reset.ok) log(`    reset: ${reset.why} — an untouched row may still show an earlier round's value`);
  else if (reset.state !== "reloaded") log(`    reset: nothing to clear (${reset.state})`);

  const run = await runFill({
    url: posting.url,
    home: ctx.home,
    port: ctx.port,
    secrets: ctx.secrets,
    timeoutMs: ctx.timeoutMs,
    onLog: ctx.verbose ? (line) => log(`    ${line}`) : null,
  });

  const result = run.result ?? { status: run.status, reason: run.reason ?? "unknown", url: posting.url };
  const slug = result.slug ?? fallbackSlug(posting.url);
  const dir = shotsDir({ round: ctx.round, profile: ctx.profile, slug });
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const { decisions, trace, frozen } = await readArtifacts(ctx.home, result.slug ?? null);
  const traced = parseTrace(trace);
  const fields = await fieldIndex({ url: result.url ?? posting.url, trace: traced, extra: frozen?.extra ?? [] });
  const expected = expectedRows(decisions, fields);

  // The runner's own witness that this form started blank. `resetTab` above can legitimately
  // no-op — no browser yet, no tab yet — and Chrome can then restore an earlier session's tab
  // when the child spawns it, so the harness's own log is not proof. `openPosting` records what
  // it actually did (`src/plan/execute.mjs`: `{op:"open", reused, reloaded}`): a fresh tab
  // (`reused:false`) or a reloaded one (`reloaded:true`) is the only pair of states in which no
  // earlier round's value can still be in a box.
  //
  // `trace.jsonl` is append-only across every run this posting has ever had — the bench homes
  // carry a dozen `open` rows each — so the row is taken from *this* run's window. A child that
  // exited before it opened anything would otherwise inherit the previous round's row and the
  // stale-tab check would pass by quoting the evidence it exists to catch.
  const opened =
    [...traced].reverse().find((row) => row?.op === "open" && row.ts && Date.parse(row.ts) >= since) ?? null;
  const startedBlank = opened ? opened.reused === false || opened.reloaded === true : null;
  const tab = {
    ...reset,
    ok: reset.ok && startedBlank === true,
    open: opened ? { ts: opened.ts, reused: opened.reused === true, reloaded: opened.reloaded === true } : null,
    ...(startedBlank === true
      ? {}
      : {
          why:
            startedBlank === false
              ? "the runner re-used an open tab without reloading it — a row it did not touch may still show an earlier value"
              : "this run logged no `open` row, so nothing witnesses what state the form was in when it was filled",
        }),
  };
  if (!tab.ok) log(`    tab: ${tab.why}`);
  const counts = countRows(decisions);

  await writeJson(path.join(dir, "expected.json"), expected);
  // `result.json` is the runner's own stdout, plus the two things a reader of *this* round asks it
  // for and the runner does not print in one place: `counts`, the Decision tally the index's
  // filled/asks/drafted/failed columns are computed from (the runner prints `filled` and lists
  // `asks`, but never a denominator), and the usage block, which the runner does print and which
  // is therefore only asserted here — a result without one is a run that died before it planned.
  await writeJson(path.join(dir, "result.json"), {
    ...result,
    counts,
    ...(result.usage ? {} : { usage: null }),
    ...(run.result ? {} : { stderr_tail: run.stderr.split("\n").filter(Boolean).slice(-8).join("\n") }),
  });

  // The writer's side of the evidence, whether or not it wrote anything: an empty `drafts[]` next
  // to a `why_us` row handed back is a different finding from a draft that was refused.
  const drafts = draftReport({ result, decisions, fields });
  await writeJson(path.join(dir, "drafts.json"), drafts);

  const shots = await captureShots({
    url: result.url ?? posting.url,
    home: ctx.home,
    port: ctx.port,
    dir,
    close: ctx.close,
    onLog: (line) => log(`    ${line}`),
  });
  if (!shots.ok) log(`    screenshots: ${shots.why ?? "none captured"}`);

  // Two ways the answer key and the photographs can describe different states, both checked here
  // rather than left for a reader to notice: another process re-filled this posting while the
  // shutter was open, or this run exited `blocked` before it froze anything, leaving the previous
  // run's `decisions.json` sitting next to today's screenshots.
  const after = await readArtifacts(ctx.home, result.slug ?? null);
  const frozenAt = frozen?.updated ? Date.parse(frozen.updated) : null;
  const integrity =
    frozen && after.frozen && after.frozen.updated !== frozen.updated
      ? { ok: false, why: `decisions.json was rewritten during the shoot (${frozen.updated} → ${after.frozen.updated}) — another process filled this posting` }
      : frozenAt != null && frozenAt < since
        ? { ok: false, why: `decisions.json predates this run (frozen ${frozen.updated}) — this run never froze one, so expected.json describes an earlier fill, not these screenshots` }
        : { ok: true };
  if (!integrity.ok) log(`    integrity: ${integrity.why}`);

  const row = {
    n: posting.n,
    url: posting.url,
    company: posting.company,
    ats: posting.ats,
    family: posting.family ?? null,
    slug,
    dir: path.posix.join(ctx.profile, slug),
    status: run.status,
    ...(run.status === "blocked" ? { reason: result.reason ?? run.reason ?? "unknown" } : {}),
    title: result.title ?? null,
    counts,
    ms: Date.now() - since,
    run_at: new Date().toISOString(),
    eeo_on_file: ctx.eeo ?? null,
    reset: tab,
    integrity,
    drafts: drafts.counts,
    shots: { ok: shots.ok, ...(shots.why ? { why: shots.why } : {}), closed: shots.closed === true, viewports: shots.viewports, page: shots.page },
    files: {
      full: shots.full,
      viewports: shots.viewports,
      expected: "expected.json",
      result: "result.json",
      drafts: "drafts.json",
    },
  };

  log(
    `    ${row.status} · ${counts.filled}/${counts.total} filled · ${counts.asks} ask · ${counts.drafted} drafted · ${counts.failed} failed · ` +
      `${shots.full ? "full" : "no full"} + ${shots.viewports.length} viewport shot(s) · ${(row.ms / 1000).toFixed(1)}s` +
      (row.reason ? ` · ${row.reason}` : ""),
  );
  return row;
}

/**
 * The round index is rendered from every profile's manifest, so one profile never hides another.
 *
 * Each row's counts, spend and draft tally are re-derived from the `expected.json`, `result.json`
 * and `drafts.json` sitting in its directory rather than trusted from the manifest: a row kept by
 * the merge was tallied by whatever version of `countRows` ran that day, and the index must not be
 * able to disagree with the artifact a reader opens next to it. `usage` in particular is only ever
 * read from `result.json`, so a money column in the index and the run's own stdout cannot drift.
 *
 * `family` lives on the postings file, not on the run: it is looked up from the list the manifest
 * names so the index can group by role without the harness having to have recorded it.
 */
async function rebuildIndex(round) {
  const roundDir = shotsDir({ round });
  const entries = await readdir(roundDir, { withFileTypes: true }).catch(() => []);
  const runs = [];
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const raw = await readFile(path.join(roundDir, entry.name, "run.json"), "utf8").catch(() => null);
    if (!raw) continue;
    try {
      const manifest = JSON.parse(raw);
      const families = new Map();
      const source = manifest.postings_source;
      if (source && /\.ya?ml$/i.test(source)) {
        const list = await loadPostings(path.join(REPO_ROOT, source)).catch(() => null);
        for (const row of list?.postings ?? []) if (row.family) families.set(row.url, row.family);
      }
      manifest.postings = await Promise.all(
        (manifest.postings ?? []).map(async (p) => {
          const read = async (name) => JSON.parse(await readFile(path.join(roundDir, entry.name, p.slug, name), "utf8").catch(() => "null"));
          const [rows, drafts, result] = await Promise.all([read("expected.json"), read("drafts.json"), read("result.json")]);
          return {
            ...p,
            ...(p.family ? {} : families.has(p.url) ? { family: families.get(p.url) } : {}),
            ...(Array.isArray(rows) ? { counts: countRows(rows) } : {}),
            ...(result?.usage ? { usage: result.usage } : {}),
            ...(drafts?.counts ? { drafts: drafts.counts, files: { ...(p.files ?? {}), drafts: "drafts.json" } } : {}),
          };
        }),
      );
      runs.push(manifest);
    } catch {
      log(`index: ${entry.name}/run.json is not readable JSON — skipped`);
    }
  }
  // The round's hand-written verdict, if a reader left one: `findings.md` sits beside `index.md`
  // and is pasted into it, so a defect the screenshots exposed survives the next re-render.
  const findings = await readFile(path.join(roundDir, "findings.md"), "utf8").catch(() => null);
  const file = path.join(roundDir, "index.md");
  await writeFile(file, renderIndex({ round, runs, findings }), { mode: 0o600 });
  return { file, runs, postings: runs.reduce((n, r) => n + (r.postings?.length ?? 0), 0) };
}

// ─── entry ────────────────────────────────────────────────────────────────────────────────────

const args = (() => {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (err) {
    log(`${err.message}\n${USAGE}`);
    process.exit(1);
  }
})();

const started = stamp();
const t0 = Date.now();

try {
  // `--index-only`: the round's profiles already ran; only `index.md` is re-rendered.
  if (args.indexOnly) {
    const index = await rebuildIndex(args.round);
    if (!index.runs.length) throw new Error(`no run.json under ${rel(shotsDir({ round: args.round }))} — nothing to index`);
    log(`wrote ${rel(index.file)} (${index.postings} posting(s) over ${index.runs.length} profile(s))`);
    process.stdout.write(
      `${JSON.stringify({ status: "ready_to_submit", round: args.round, postings: index.postings, profiles: index.runs.map((r) => r.profile), index: rel(index.file) })}\n`,
    );
    process.exit(0);
  }

  const profile = profileFor(args.profile);
  const list = await resolvePostings(args.postings);
  const postings = args.limit ? list.postings.slice(0, args.limit) : list.postings;
  if (!postings.length) throw new Error(`${list.file ?? "the URL list"} lists no postings`);

  const home = path.resolve(profile.home);
  const { env: secrets, found, missing } = await loadSecrets();
  if (missing.length) log(`credentials: ${found.length} found, missing ${missing.join(", ")} — those postings will come back blocked`);
  else log(`credentials: both keys loaded from the private env file (never written under ${rel(shotsDir({ round: args.round }))})`);

  // The synthetic home is seeded only when it does not exist yet. It is shared with
  // `scripts/bench.mjs` and with any other run in flight, and `ensureSyntheticHome` rewrites
  // `preferences.yaml` — re-seeding here would silently drop a `p.eeo` somebody else put on file
  // and change what the very next posting photographs. An existing home is used as it stands, and
  // the real home is never touched at all.
  if (profile.synthetic && !existsSync(path.join(home, "memory", "facts.yaml"))) {
    log(`synthetic home: seeding a fresh store at ${home}`);
    await ensureSyntheticHome(home);
  } else if (profile.synthetic) {
    log(`synthetic home: using ${home} as it stands (not re-seeded)`);
  }

  // Refuse to drive a browser that is not this profile's own — the one check that keeps synthetic
  // data out of the real Chrome, and the real store out of the bench browser.
  await assertBenchPort({ port: profile.port, home }).catch((err) => {
    throw new Error(`[${profile.name}] ${err.message}`);
  });

  // One round, one experiment. `p.eeo` on file turns every EEO/demographic row from `ask` into
  // `fill` (PLAN §2.2 step 4), so a posting shot under a different answer than its neighbours is
  // not comparable to them. Every row records the state it was shot under; this refuses to add a
  // row that disagrees with the ones already in this profile — unless the run covers all of them,
  // which re-establishes the posture for the whole profile in one pass.
  const manifestFile = path.join(shotsDir({ round: args.round, profile: profile.name }), "run.json");
  const previous = JSON.parse(await readFile(manifestFile, "utf8").catch(() => "null"))?.postings ?? [];
  const eeo = await eeoOnFile(home);
  const disagree = previous.filter((p) => p.eeo_on_file != null && p.eeo_on_file !== eeo);
  if (disagree.length) {
    const here = new Set(postings.map((p) => p.url));
    const orphans = disagree.filter((p) => !here.has(p.url));
    if (orphans.length) {
      throw new Error(
        `[${profile.name}] ${home} has p.eeo ${eeo ? "on file" : "absent"}, but ${disagree.length} row(s) already in this round were shot the other way ` +
          `(${orphans.map((p) => p.slug).join(", ")}). Every EEO row flips between fill and ask on that one preference, so the round would mix two experiments. ` +
          `Either put the home back (ensureSyntheticHome("${home}", { eeo: ${!eeo} })) and re-run, or re-shoot every posting in this profile in one command.`,
      );
    }
    log(`posture: p.eeo ${eeo ? "on file" : "absent"} — this run re-shoots every row that disagreed, so the profile moves as a whole`);
  }
  log(`posture: p.eeo ${eeo === null ? "unknown (no preferences.yaml)" : eeo ? "on file — EEO rows resolve to fill" : "absent — EEO rows resolve to ask"}`);

  log(
    `eval-shots ${args.round}/${profile.name}: ${postings.length} posting(s) · home ${home} · CDP ${profile.port} · ` +
      `--no-submit on every run · ${args.close ? "each tab is closed once its screenshots are on disk" : "tabs are left open"}`,
  );

  const ctx = {
    round: args.round,
    profile: profile.name,
    home,
    port: profile.port,
    secrets,
    eeo,
    timeoutMs: args.timeout * 1000,
    total: postings.length,
    verbose: args.verbose,
    close: args.close,
  };

  const rows = [];
  for (const posting of postings) rows.push(await shootOne(posting, ctx));

  // Merge by slug: re-shooting one posting refreshes its row and keeps every other row this
  // profile already has, so a partial re-run never drops postings out of the round's index. Each
  // row carries its own `run_at`, so nothing merged in is silently passed off as fresh.
  const fresh = new Map(rows.map((r) => [r.slug, r]));
  const merged = [...previous.map((p) => fresh.get(p.slug) ?? p), ...rows.filter((r) => !previous.some((p) => p.slug === r.slug))];
  const manifest = {
    round: args.round,
    profile: profile.name,
    note: profile.note,
    home,
    port: profile.port,
    postings_source: list.file ? rel(list.file) : "urls on the command line",
    started,
    finished: stamp(),
    ms: Date.now() - t0,
    postings: merged.map((row, i) => ({ ...row, n: i + 1 })),
  };
  await writeJson(manifestFile, manifest);
  const index = await rebuildIndex(args.round);

  const shot = rows.filter((r) => r.shots.ok).length;
  log(
    `\n${args.round}/${profile.name}: ${rows.length} posting(s) · ${shot} with screenshots · ` +
      `${rows.reduce((n, r) => n + r.files.viewports.length, 0)} viewport shot(s) · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  log(`wrote ${rel(index.file)} (${index.postings} posting(s) over ${index.runs.length} profile(s))`);

  process.stdout.write(
    `${JSON.stringify({
      status: "ready_to_submit",
      round: args.round,
      profile: profile.name,
      postings: rows.length,
      shot,
      index: rel(index.file),
      rows: rows.map((r) => ({ slug: r.slug, status: r.status, filled: r.counts.filled, total: r.counts.total, asks: r.counts.asks, viewports: r.files.viewports.length })),
    })}\n`,
  );
} catch (err) {
  log(err?.stack ?? String(err));
  process.stdout.write(`${JSON.stringify({ status: "blocked", round: args.round, profile: args.profile, reason: err?.message ?? String(err), ms: Date.now() - t0 })}\n`);
  process.exit(1);
}
process.exit(0);
