// Screenshot evidence for one round of fills: what the runner *meant* to type, next to a
// photograph of what is actually on the form.
//
// `scripts/bench.mjs` already answers "did the adapter's read-back agree with the adapter" — it
// scores `trace.jsonl`, which is written by the same code that did the typing. This module
// answers the question that trace cannot: **is the right value in the right box?** A read-back of
// "Yes" proves a radio flipped; it does not prove the radio belonged to the question above it.
// So for every posting it keeps four artefacts side by side under
// `private/eval-shots/<round>/<profile>/<slug>/`:
//
//   full.png         the whole form, one image
//   viewport-<n>.png 1280 CSS px wide at device-scale 2, one per scroll step — small labels,
//                    helper text and chip contents stay legible when a human or a vision model
//                    reads them back
//   expected.json    one row per Decision: {qid, label, class, control, action, value, source,
//                    why, readback} — the answer key the screenshots are graded against
//   result.json      the runner's own stdout JSON for that posting
//
// Three rules this module does not bend:
//   * **Never Submit.** Every child gets `--no-submit`, which is why this file spawns the runner
//     itself instead of calling `runApply` from `./run.mjs` (that one takes no extra flags).
//   * **Never close the tab.** The filled tab is the fixture; a reviewer opens it after the fact.
//     Only the CDP connection is dropped (D12).
//   * **Sensitive rows stay sensitive in text.** A row classed `sensitive` carries `<redacted>`
//     as its value *and* as its read-back, exactly as `src/browser/trace.mjs` does — the point of
//     the EEO rows in this eval is that they are *empty*, which the screenshot shows on its own.
//
// The viewport shots are taken through `Emulation.setDeviceMetricsOverride` so the width is the
// same 1280 on every machine and every profile; the override is cleared and the page scrolled
// back to the top before this module lets go, so the tab the user finds is the tab the runner
// left.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import YAML from "yaml";

import { cdpVersion, connect, disconnect, findTab } from "../browser/chrome.mjs";
import { OPENAI_MODEL, REPO_ROOT, slugify } from "../config.mjs";
import { fitsLimits, wordCount } from "../schema/classes.mjs";
import { loadFormPlan } from "../schema/index.mjs";
import { parseTrace } from "./metrics.mjs";
import { fromUrl } from "./postings.mjs";
import { parseResult } from "./run.mjs";

/** What a `sensitive` row shows instead of its value, in `expected.json` and in the index. */
export const REDACTED = "<redacted>";

/**
 * The executor's failed-set clause, verbatim from `src/plan/execute.mjs:185`
 * (`the form would not take it (<reason>) — intended: <value>`). `src/bench/metrics.mjs:119` keeps
 * the same literal but does not export it, and that file is not this slice's to change.
 */
const SET_FAILED = /^the form would not take it \(([^)]*)\)/;

/**
 * The two homes this eval runs against, and the browser each one owns.
 *
 * `synthetic` is the benchmark's invented candidate on its own CDP port — the profile that may be
 * pointed at anybody's live careers page. `real` is the user's own memory and their own Chrome,
 * and is only ever used on postings the user named.
 */
export const PROFILES = {
  synthetic: {
    name: "synthetic",
    home: "/tmp/jev-bench",
    port: 9224,
    synthetic: true,
    note: "invented candidate (src/bench/synthetic.mjs) · JEV_APPLY_HOME=/tmp/jev-bench · CDP 9224",
  },
  real: {
    name: "real",
    home: path.join(homedir(), ".config", "jev-apply"),
    port: 9223,
    synthetic: false,
    note: "the user's own memory and Chrome profile · CDP 9223",
  },
};

export function profileFor(name) {
  const found = PROFILES[String(name ?? "").toLowerCase()];
  if (!found) throw new Error(`unknown profile ${name}; pick one of ${Object.keys(PROFILES).join(", ")}`);
  return { ...found };
}

/** Where a round's artefacts live. Under `private/`, which is gitignored, and 0700 like the home. */
export function shotsDir({ round, profile = null, slug = null, root = REPO_ROOT }) {
  const parts = [root, "private", "eval-shots", round];
  if (profile) parts.push(profile);
  if (slug) parts.push(slug);
  return path.join(...parts);
}

/** The directory name for a posting the runner never got far enough to name. */
export function fallbackSlug(url) {
  const { company, id } = fromUrl(url);
  return slugify(`${company}-${id || "unknown"}`);
}

/**
 * Does this home have a `p.eeo` block on file?
 *
 * It decides whether every EEO/demographic row on a form resolves to `fill` or to `ask`
 * (PLAN §2.2 step 4), so two postings shot under different answers to this question are two
 * different experiments. The round records it per row and refuses to mix them silently.
 */
export async function eeoOnFile(home) {
  const text = await readFile(path.join(home, "memory", "preferences.yaml"), "utf8").catch(() => null);
  if (text == null) return null;
  const rows = YAML.parse(text);
  return Array.isArray(rows) && rows.some((r) => String(r?.id ?? "").startsWith("p.eeo"));
}

const TERMINAL = new Set(["ready_to_submit", "needs_user", "blocked"]);

/**
 * One posting through the real binary: `apply.mjs --url <posting> --no-submit --json`.
 *
 * `--no-submit` is not a default this harness relies on — it is passed on every run, so no
 * `p.auto_submit` preference in either home can turn a screenshot session into an application.
 *
 * @param {{url:string, home:string, port:number, repoRoot?:string, secrets?:object,
 *          timeoutMs?:number, onLog?:(line:string)=>void}} args
 * @returns {Promise<{result:object|null, status:string, reason?:string, code:number|null, ms:number, stderr:string}>}
 */
export function runFill({ url, home, port, repoRoot = REPO_ROOT, secrets = {}, timeoutMs = 300_000, onLog = null }) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/apply.mjs", "--url", url, "--no-submit", "--json"], {
      cwd: repoRoot,
      env: { ...process.env, ...secrets, JEV_APPLY_HOME: home, JEV_CHROME_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      if (onLog) for (const line of text.split("\n")) if (line.trim()) onLog(line);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ result: null, status: "blocked", reason: `spawn_failed: ${err.message}`, code: null, ms: Date.now() - started, stderr });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const result = parseResult(stdout);
      const status = TERMINAL.has(result?.status) ? result.status : "blocked";
      resolve({
        result,
        status,
        ...(status === "blocked" && !result
          ? { reason: timedOut ? `eval_timeout after ${Math.round(timeoutMs / 1000)}s` : `no JSON on stdout (exit ${code})` }
          : {}),
        code,
        ms: Date.now() - started,
        stderr: stderr.slice(-4000),
      });
    });
  });
}

/**
 * `qid → {control, limits, required}` for every question on the form.
 *
 * `decisions.json` carries the class but not the control (`src/plan/decisions.mjs` freezes the
 * Decision shape, and `control`/`limits` live on the FormPlan question), and the trace only names
 * the control of rows that were actually written — which excludes every `ask`, i.e. exactly the
 * rows a reviewer most wants to identify. Three sources, narrowest last:
 *
 *   trace      what the adapter dispatched on, for rows it wrote
 *   extra      the frozen record's `extra[]` — the conditional follow-ups that only appeared
 *              *after* the form was filled (PLAN §2.2 step 9), e.g. Greenhouse's
 *              `hispanic_ethnicity`, which the public schema does not carry at all
 *   FormPlan   the posting's public schema, re-fetched (HTTP only, no browser, no Jev) and
 *              authoritative for every row it knows; a refused fetch just leaves the other two
 *
 * `limits` comes along because a draft is graded against the box it went into: an answer past the
 * cap the field prints is a wrong answer however well it reads (`drafts.json`).
 */
export async function fieldIndex({ url, trace = [], extra = [] }) {
  const byQid = new Map();
  const put = (qid, patch) => {
    if (!qid) return;
    const row = byQid.get(qid) ?? { control: null, limits: null, required: null };
    for (const [key, value] of Object.entries(patch)) if (value != null) row[key] = value;
    byQid.set(qid, row);
  };
  for (const row of trace) if (row?.qid && row?.control && !byQid.has(row.qid)) put(row.qid, { control: row.control });
  for (const q of extra) put(q?.qid, { control: q?.control, limits: q?.limits, required: q?.required });
  try {
    const plan = await loadFormPlan(url);
    for (const q of plan?.questions ?? []) put(q?.qid, { control: q?.control, limits: q?.limits, required: q?.required });
  } catch {
    /* offline or a board that stopped answering: the trace and `extra` still stand */
  }
  return byQid;
}

/**
 * The answer key: one row per Decision, in form order.
 *
 * `value` is what should be **on the form** — the picked option when the row had one, else the
 * resolved value — because that is what the screenshot can be compared against. A `sensitive` row
 * shows `<redacted>` in place of both the value and the read-back.
 *
 * A row the runner did not type keeps an empty `value` even when the Decision still carries one:
 * a set the control refused, or a pick re-gated to `ask` afterwards, leaves the old value on the
 * frozen record while the form stays blank (round 2 shot three such rows — judge round 2 §
 * harness notes). Grading `value` against the photograph then flags a wrong fill where nothing
 * was written at all, so the value moves to `intended`, which says exactly that: this is what the
 * row would have typed, and the form must not show it.
 */
export function expectedRows(decisions = [], fields = new Map()) {
  const TYPED = new Set(["fill", "check", "draft"]);
  return decisions.map((d) => {
    const sensitive = d.class === "sensitive";
    const carried = d.option ?? d.value ?? null;
    const shown = carried == null ? null : sensitive ? REDACTED : String(carried);
    const typed = TYPED.has(d.action) && carried != null;
    return {
      qid: d.qid ?? null,
      label: d.label ?? null,
      class: d.class ?? null,
      control: fields.get(d.qid)?.control ?? null,
      action: d.action ?? null,
      value: typed ? shown : null,
      ...(typed || shown == null ? {} : { intended: shown }),
      source: d.source ?? null,
      why: d.why ?? null,
      readback: d.readback
        ? {
            ok: d.readback.ok === true,
            observed: d.readback.observed == null ? null : sensitive ? REDACTED : String(d.readback.observed),
          }
        : null,
    };
  });
}

/**
 * fill + check are both "filled" (PLAN §2.6); the denominator is every row on the form.
 *
 * `disputed` is the row that contradicts itself: `src/plan/execute.mjs` writes
 * `the form would not take it (<reason>) — intended: …` and calls `markAsk` when a set fails, so a
 * row still carrying that clause while claiming `fill`/`check` was re-gated on its Jev confidence
 * after the form refused it. Its answer key says the value is on the form and its own `why` says it
 * is not — the screenshot is the tiebreaker, which is the entire point of this round.
 */
export function countRows(decisions = []) {
  const n = (action) => decisions.filter((d) => d.action === action).length;
  return {
    total: decisions.length,
    filled: n("fill") + n("check"),
    checks: n("check"),
    asks: n("ask"),
    drafted: n("draft"),
    skipped: n("skip"),
    failed: decisions.filter((d) => d.readback && d.readback.ok !== true).length,
    disputed: decisions.filter((d) => SET_FAILED.test(d.why ?? "") && d.action !== "ask").length,
  };
}

/** `src/plan/draft.mjs:251` turns a draft the writer would not stand behind back into an `ask`. */
const DRAFT_REFUSED = /^could not draft this one — (.*)$/s;

/**
 * `drafts.json`: every row the writer was handed, the text it produced, and what it cost.
 *
 * Round 1 had no drafts at all — `p.auto_draft` did not exist yet and four "why this company"
 * boxes went back to the user (judge §4.1) — so round 2's drafts are new behaviour and the one
 * thing a screenshot grades poorly: a photograph shows that *a* paragraph is in the box, not
 * whether it is the paragraph the field asked for, within the cap the field printed.
 *
 * A refused draft is kept as a row with `text:null` and the reason the writer gave. Without it,
 * "the writer declined this one" and "the writer never ran" look identical from outside, and only
 * one of those is a bug.
 */
export function draftReport({ result = null, decisions = [], fields = new Map(), model = OPENAI_MODEL, generated = new Date().toISOString() }) {
  const drafts = [];
  let handles = 0;
  for (const d of decisions) {
    const refusal = DRAFT_REFUSED.exec(d.why ?? "");
    if (d.action !== "draft" && !refusal && !d.draft_request) continue;
    const field = fields.get(d.qid) ?? {};
    const limits = d.draft_request?.limits ?? field.limits ?? null;
    const sensitive = d.class === "sensitive";
    const text = d.action === "draft" && typeof d.value === "string" ? d.value : null;
    const fit = text == null ? null : fitsLimits(text, limits);
    drafts.push({
      handle: d.action === "draft" ? `d${(handles += 1)}` : null,
      qid: d.qid ?? null,
      label: d.label ?? null,
      class: d.class ?? null,
      control: field.control ?? null,
      required: field.required ?? null,
      limits,
      kind: d.draft_request?.kind ?? null,
      // What the planner *offered* vs what the writer was actually handed. Round 2's repeated
      // anecdote was invisible in any screenshot and only legible here: three why-us rows on
      // three different companies carried byte-identical `grounding_ids`
      // (docs/research/13-eval-judge-round2.md §3 N4). `grounding_used` is the set
      // `src/plan/draft.mjs` ranked and de-duplicated per posting, which is the one a reader can
      // diff across postings to see whether the repetition is gone.
      grounding_ids: d.draft_request?.grounding_ids ?? null,
      grounding_used: d.grounding_used ?? null,
      action: d.action ?? null,
      text: text == null ? null : sensitive ? REDACTED : text,
      words: text == null ? null : (d.words ?? wordCount(text)),
      chars: text == null ? null : text.length,
      within_limit: fit == null || limits == null ? null : fit.ok,
      ...(fit && !fit.ok ? { over_limit: `${fit.count} ${fit.over} against the form's ${fit.limit}` } : {}),
      reason: text == null ? (refusal ? refusal[1] : (d.why ?? "the writer never ran")) : null,
      why: d.why ?? null,
      readback: d.readback ? { ok: d.readback.ok === true, observed_chars: d.readback.observed == null ? null : String(d.readback.observed).length } : null,
    });
  }
  const written = drafts.filter((row) => row.text != null);
  const openai = result?.usage?.openai ?? null;
  return {
    slug: result?.slug ?? null,
    url: result?.url ?? null,
    company: result?.company ?? null,
    title: result?.title ?? null,
    generated,
    counts: {
      rows: drafts.length,
      written: written.length,
      refused: drafts.length - written.length,
      words: written.reduce((n, row) => n + (row.words ?? 0), 0),
      over_limit: drafts.filter((row) => row.within_limit === false).length,
    },
    // The writer's own spend for this posting (`apply.mjs` re-baselines it per posting), and the
    // pinned model it was spent on. Zero calls next to a non-empty `drafts[]` means the rows came
    // from a re-used frozen plan, not from a writer that ran for free.
    writer: {
      model,
      calls: openai?.calls ?? 0,
      input_tokens: openai?.input_tokens ?? 0,
      output_tokens: openai?.output_tokens ?? 0,
      usd: openai?.usd ?? null,
      ms_browser: result?.usage?.ms_browser ?? null,
    },
    drafts,
  };
}

/** Walk the page top to bottom once so anything that mounts on scroll has mounted. */
const lazyPass = async ({ pause, maxSteps }) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const full = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const step = Math.max(200, Math.round(window.innerHeight * 0.8));
  let y = 0;
  for (let i = 0; i < maxSteps; i += 1) {
    window.scrollTo(0, y);
    await sleep(pause);
    if (y + window.innerHeight >= full() - 4) break;
    y += step;
  }
  window.scrollTo(0, 0);
  await sleep(pause);
  return { height: full(), inner: window.innerHeight, width: window.innerWidth };
};

const scrollState = () => ({
  y: Math.round(window.scrollY),
  height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
  inner: window.innerHeight,
});

/**
 * Put this posting's tab back to a blank form before the runner touches it.
 *
 * The runner already reloads a tab it re-uses (`openPosting`, PLAN §2.2 step 8), but a reload is
 * not a clean slate: Chrome restores form state across `Page.reload`, so round 1's values can
 * come back up in the boxes round 2 chose to leave alone — and an `ask` row photographed with
 * yesterday's answer still in it reads as a wrong fill. A navigation away and back discards that
 * state, so every pixel in `full.png` was written by this round.
 *
 * Nothing to reset is a normal outcome, not a failure: with no tab (or no browser) the runner
 * opens a fresh one, which is the state this function exists to produce.
 *
 * @param {{url:string, home:string, port:number, timeout?:number, onLog?:(line:string)=>void}} args
 * @returns {Promise<{ok:boolean, state:"reloaded"|"no_tab"|"no_browser"|"failed", why?:string}>}
 */
export async function resetTab({ url, home, port, timeout = 45000, onLog = null }) {
  if (!(await cdpVersion(port))) return { ok: true, state: "no_browser" };
  let conn = null;
  try {
    conn = await connect({ profileDir: path.join(home, "profile"), port, spawnIfMissing: false });
    const page = await findTab(conn.context, url);
    if (!page) return { ok: true, state: "no_tab" };
    // A half-filled form asks "leave site?" on the way out. Accepting is the whole point here —
    // the filled state is exactly what this round must not photograph.
    const accept = (dialog) => dialog.accept().catch(() => {});
    page.on("dialog", accept);
    try {
      await page.goto("about:blank", { waitUntil: "load", timeout });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
    } finally {
      page.off("dialog", accept);
    }
    onLog?.("tab reset to a blank form before filling");
    return { ok: true, state: "reloaded" };
  } catch (err) {
    return { ok: false, state: "failed", why: err.message };
  } finally {
    if (conn) await disconnect(conn.browser, { port, verify: false }).catch(() => {});
  }
}

/**
 * Photograph the tab this posting was filled in, and leave it exactly as it was found.
 *
 * @param {{url:string, home:string, port:number, dir:string, width?:number, height?:number,
 *          scale?:number, maxShots?:number, pause?:number, onLog?:(line:string)=>void}} args
 * @returns {Promise<{ok:boolean, why?:string, full:string|null, viewports:string[], page:object|null}>}
 */
export async function captureShots({
  url,
  home,
  port,
  dir,
  width = 1280,
  height = 900,
  scale = 2,
  maxShots = 40,
  pause = 220,
  onLog = null,
}) {
  const log = (line) => onLog?.(line);
  const empty = { full: null, viewports: [], page: null };
  if (!(await cdpVersion(port))) return { ok: false, why: `no browser on 127.0.0.1:${port}`, ...empty };

  let conn = null;
  let session = null;
  let overridden = false;
  try {
    conn = await connect({ profileDir: path.join(home, "profile"), port, spawnIfMissing: false });
    const page = await findTab(conn.context, url);
    if (!page) return { ok: false, why: "no tab for this posting", ...empty };
    await page.bringToFront().catch(() => {});
    await mkdir(dir, { recursive: true, mode: 0o700 });

    // 1. lazy mounts, at the tab's own size — nothing is emulated yet, so a form that only
    //    renders its later sections on scroll has rendered them before the first shutter.
    const metrics = await page.evaluate(lazyPass, { pause, maxSteps: maxShots + 10 });
    log?.(`page ${metrics.width}×${metrics.height}px (viewport ${metrics.inner}px)`);

    // 2. the whole form in one image, at the window's own width.
    let full = null;
    try {
      const buf = await page.screenshot({ fullPage: true, type: "png" });
      await writeFile(path.join(dir, "full.png"), buf, { mode: 0o600 });
      full = "full.png";
    } catch (err) {
      log?.(`full-page screenshot failed: ${err.message}`);
    }

    // 3. the legible pass: a fixed 1280 CSS px at device-scale `scale`, one image per screenful.
    try {
      session = await conn.context.newCDPSession(page);
      await session.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
      overridden = true;
      await page.waitForTimeout(pause);
    } catch (err) {
      log?.(`device-metrics override refused (${err.message}); shooting at the window's own size`);
    }

    const viewports = [];
    let at = await page.evaluate(scrollState);
    const stride = Math.max(200, at.inner - Math.min(80, Math.round(at.inner * 0.1)));
    for (let i = 0, y = 0; i < maxShots; i += 1, y += stride) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await page.waitForTimeout(pause);
      const buf = await page.screenshot({ type: "png" });
      const file = `viewport-${i + 1}.png`;
      await writeFile(path.join(dir, file), buf, { mode: 0o600 });
      viewports.push(file);
      at = await page.evaluate(scrollState);
      if (at.y + at.inner >= at.height - 4) break;
    }

    return { ok: viewports.length > 0, full, viewports, page: { ...metrics, shots: viewports.length } };
  } catch (err) {
    return { ok: false, why: err.message, ...empty };
  } finally {
    if (session) {
      if (overridden) await session.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
      await session.detach().catch(() => {});
    }
    // The tab outlives this process (D12): scrolled back to the top, never closed.
    if (conn) {
      const page = await findTab(conn.context, url).catch(() => null);
      await page?.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await disconnect(conn.browser, { port, verify: false }).catch(() => {});
    }
  }
}

/** 0600 JSON, pretty enough to read in a diff. */
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
  return file;
}

/**
 * `index.md` for the whole round: every posting of every profile that has run so far, with the
 * three numbers a reader checks first (status, filled, asks) and the path to its evidence.
 * Rendered from the per-profile `run.json` manifests, so re-running one profile never drops the
 * other one's rows.
 */
export function renderIndex({ round, runs = [], generated = new Date().toISOString() }) {
  const rows = runs.flatMap((r) => (r.postings ?? []).map((p) => ({ ...p, profile: r.profile })));
  const byProfile = runs.map((r) => `${r.profile} ${r.postings?.length ?? 0}`).join(" · ");
  const lines = [
    `# eval-shots — ${round}`,
    "",
    `${rows.length} posting${rows.length === 1 ? "" : "s"} (${byProfile}) · generated ${generated}`,
    "",
    "Every posting was filled with `node scripts/apply.mjs --url <posting> --no-submit --json`; no Submit",
    "control was clicked and no tab was closed — each one is still open in the profile's Chrome. Each",
    "tab was navigated away and back *before* its fill (a plain reload does not clear Chrome's",
    "restored form state), and each posting line below also carries what the runner itself recorded",
    "doing with the tab it found, so the two witnesses can be checked against each other.",
    "",
    "`expected.json` is the answer key the screenshots are graded against: one row per Decision, with",
    "`value` = what should be *on the form* (the picked option when there is one, else the resolved",
    "value) and `readback` = what the runner saw after it typed. Rows classed `sensitive` (EEO and",
    "demographics) carry `<redacted>` in place of both, so the row's **action** is what grades them:",
    "`ask` (no `p.eeo` on file) must be **empty** on the form, `fill`/`check` must carry the answer",
    "`p.eeo` holds. A sensitive control that is filled against an `ask` row is a broken invariant.",
    "",
    "`value` is only ever set on a row the runner typed (`fill`/`check`/`draft`). A row that ended",
    "as `ask` or `skip` while still carrying a value — a set the control refused, or a pick re-gated",
    "afterwards — shows it as `intended` instead: that value must **not** appear on the form, and",
    "reading it as `value` would flag a wrong fill where nothing was written at all.",
    "",
    "The PNGs are deliberately **unmasked** photographs of the form — proving the demographic block",
    "was left untouched is the point, and a mask would erase that evidence — so this tree holds form",
    "content verbatim, including the real profile's own answers. It lives under `private/`",
    "(gitignored), directories 0700 and files 0600, like `applications/`. **Do not paste one of",
    "these images into a chat, issue, report or pull request** — read it, cite the path, quote no",
    "value. The containment is this directory; the failure mode is an image forwarded out of it.",
    "",
    "A row marked **contaminated** had its `decisions.json` rewritten between the fill and the",
    "shutter by another process using the same home, or never froze one at all: its answer key and",
    "its screenshots describe two different states and it is not evidence. Re-shoot it with the home",
    "and port to yourself.",
    "",
    "`drafts.json` is the writer's side of the same evidence: every row `p.auto_draft` handed to the",
    "writer, with the text it produced, its word/char count against the cap the field printed, and",
    "the OpenAI spend for that posting. A row the writer refused stays in the file with `text:null`",
    "and the reason, so \"declined\" and \"never ran\" cannot be confused.",
    "",
    "`filled` counts `fill` + `check` (PLAN §2.6); `chk` is how many of them are `check` rows the",
    "user is meant to eyeball. `drafted` counts rows the writer wrote into the form. `disputed`",
    "counts rows whose own `why` records that the form refused the set while the action still claims",
    "it took — look at the photograph before believing either.",
    "",
  ];

  for (const run of runs) {
    const posts = run.postings ?? [];
    lines.push(`## ${run.profile} — ${run.note ?? ""}`.trimEnd(), "");
    const stamped = posts.filter((p) => p.eeo_on_file != null);
    const posture = [...new Set(stamped.map((p) => p.eeo_on_file))];
    const coverage = `${stamped.length}/${posts.length} row${posts.length === 1 ? "" : "s"} record it`;
    const eeoNote =
      posture.length === 0
        ? ""
        : posture.length > 1
          ? " · ⚠ **mixed `p.eeo` posture** — these rows are not comparable"
          : posture[0]
            ? ` · \`p.eeo\` on file: EEO rows resolve to \`fill\` (${coverage})`
            : ` · no \`p.eeo\` on file: EEO rows resolve to \`ask\` and must be empty (${coverage})`;
    lines.push(
      `home \`${run.home}\` · CDP ${run.port} · ${posts.length} posting${posts.length === 1 ? "" : "s"}` +
        `${run.finished ? ` · finished ${run.finished}` : ""}${eeoNote}`,
      "",
    );
    lines.push("| # | slug | status | filled | chk | asks | drafted | failed | disputed | shots | dir |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
    for (const p of posts) {
      const c = p.counts ?? {};
      const shots = p.shots?.ok ? `full + ${p.shots.viewports?.length ?? 0}` : `none (${p.shots?.why ?? "not captured"})`;
      const flag = p.integrity && p.integrity.ok === false ? " **contaminated**" : "";
      const stale = p.reset && p.reset.ok === false ? " ⚠ not reset" : "";
      const drafted = `${c.drafted ?? 0}${p.drafts?.refused ? ` (+${p.drafts.refused} refused)` : ""}`;
      lines.push(
        `| ${p.n} | ${p.slug}${flag}${stale} | ${p.status}${p.reason ? ` (${p.reason})` : ""} | ${c.filled ?? 0}/${c.total ?? 0} | ${c.checks ?? 0} | ${c.asks ?? 0} | ${drafted} | ${c.failed ?? 0} | ${c.disputed ?? 0} | ${shots} | \`${p.dir}/\` |`,
      );
    }
    lines.push("");
    for (const p of posts) {
      const files = p.files ?? {};
      const n = files.viewports?.length ?? 0;
      const shots = [files.full, n === 0 ? null : n === 1 ? "viewport-1.png" : `viewport-1…${n}.png`].filter(Boolean);
      lines.push(`- **${p.slug}** — ${p.status} · ${p.counts?.filled ?? 0}/${p.counts?.total ?? 0} filled · ${p.counts?.asks ?? 0} ask — ${p.url}`);
      // Two independent witnesses that the form started blank: the harness's own reset, and what
      // the runner recorded doing with the tab it found (`{op:"open"}` in trace.jsonl).
      const open = p.reset?.open;
      const byRunner = !open ? "" : open.reused ? (open.reloaded ? ", runner reloaded it" : ", runner re-used it **unreloaded**") : ", runner opened a fresh one";
      lines.push(
        `  - \`${p.dir}/\` — ${shots.length ? shots.join(" · ") : "_no screenshot_"} · ` +
          `expected.json (${p.counts?.total ?? 0} rows) · result.json` +
          (files.drafts ? ` · drafts.json (${p.drafts?.written ?? 0} written, ${p.drafts?.refused ?? 0} refused)` : "") +
          (p.run_at ? ` · shot ${p.run_at}` : "") +
          (p.reset?.state ? ` · tab ${p.reset.state}${byRunner}` : ""),
      );
      if (p.integrity && p.integrity.ok === false) lines.push(`  - ⚠ contaminated: ${p.integrity.why}`);
      if (p.reset && p.reset.ok === false) lines.push(`  - ⚠ ${p.reset.why ?? "the tab was not reset before the fill"} — an untouched row may still show an earlier round's value`);
    }
    lines.push("");
  }

  const shots = rows.reduce((n, r) => n + (r.files?.viewports?.length ?? 0) + (r.files?.full ? 1 : 0), 0);
  const graded = rows.reduce((n, r) => n + (r.counts?.total ?? 0), 0);
  const drafted = rows.reduce((n, r) => n + (r.counts?.drafted ?? 0), 0);
  lines.push(
    `${rows.length} posting${rows.length === 1 ? "" : "s"} · ${shots} screenshot${shots === 1 ? "" : "s"} · ` +
      `${graded} Decision row${graded === 1 ? "" : "s"} to grade · ${drafted} drafted row${drafted === 1 ? "" : "s"} · ` +
      "every posting directory holds `full.png`, `viewport-<n>.png`, `expected.json`, `result.json` and `drafts.json`.",
    "",
  );
  return lines.join("\n");
}
