// Views over the pipeline: the Markdown file `pipeline.mjs render` writes next to the YAML, and the
// plain-text table `pipeline.mjs list` prints. Both are *derived* — nothing here reads or writes a
// file, so a view can never be the thing that loses data (PLAN §2.5: "`pipeline.md` is a view").

import { statusRank, STATUSES } from "./status.mjs";

/** A fit at or above this Noul probability carries a dealbreaker warning marker. */
const DEALBREAKER_MARK = 0.5;

const clip = (value, n) => {
  const s = String(value ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/**
 * Story titles are authored as "<headline> -- <the prompt it answers>"; the headline is the reason
 * line the user recognizes, so views show that half and the YAML keeps the whole title.
 */
export function reasonHeadline(reason) {
  if (!reason) return "";
  const cut = String(reason).split(" -- ")[0];
  return cut.trim();
}

const fitCell = (entry) => {
  if (typeof entry?.fit !== "number") return "—";
  const mark = typeof entry.dealbreaker === "number" && entry.dealbreaker >= DEALBREAKER_MARK ? "!" : "";
  return `${entry.fit.toFixed(1)}${mark}`;
};

/** fit desc (unscored last), then newest first, then id — the order every view uses. */
export function byFit(a, b) {
  const fa = typeof a?.fit === "number" ? a.fit : -1;
  const fb = typeof b?.fit === "number" ? b.fit : -1;
  if (fb !== fa) return fb - fa;
  const newest = String(b?.found ?? "").localeCompare(String(a?.found ?? ""));
  if (newest !== 0) return newest;
  return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

// ─── plain-text table (`pipeline.mjs list`) ───────────────────────────────────────────────────

const COLUMNS = [
  { key: "id", label: "id", width: 28 },
  { key: "fit", label: "fit", width: 4, align: "right" },
  { key: "company", label: "company", width: 16 },
  { key: "title", label: "title", width: 34 },
  { key: "location", label: "location", width: 20 },
  { key: "status", label: "status", width: 9 },
  { key: "reason", label: "reason", width: 38 },
];

function cells(entry) {
  return {
    id: entry.id,
    fit: fitCell(entry),
    company: entry.company,
    title: entry.title,
    location: entry.location ?? "—",
    status: entry.status,
    reason: reasonHeadline(entry.reason) || "—",
  };
}

/**
 * `id | fit | company | title | location | status | reason` — the six columns CONTRACTS names, plus
 * the reason line, because a fit the user cannot trace back to one of their own stories is noise.
 * @param {object[]} entries already filtered and sorted by the caller.
 */
export function table(entries) {
  const rows = entries.map(cells);
  const widths = COLUMNS.map((col) =>
    Math.min(col.width, Math.max(col.label.length, ...rows.map((r) => String(r[col.key] ?? "").length), 1)),
  );
  const line = (values) =>
    COLUMNS.map((col, i) => {
      const text = clip(values[col.key], widths[i]);
      return col.align === "right" ? text.padStart(widths[i]) : text.padEnd(widths[i]);
    })
      .join(" | ")
      .trimEnd();

  const header = line(Object.fromEntries(COLUMNS.map((c) => [c.key, c.label])));
  const rule = widths.map((w) => "-".repeat(w)).join("-+-");
  return [header, rule, ...rows.map(line)].join("\n");
}

// ─── Markdown view (`pipeline.mjs render` → pipeline.md) ──────────────────────────────────────

const md = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function section(status, entries) {
  const rows = entries
    .slice()
    .sort(byFit)
    .map((e) => {
      const link = e.url ? `[${md(clip(e.title, 70))}](${e.url})` : md(clip(e.title, 70));
      return `| ${fitCell(e)} | ${md(e.company)} | ${link} | ${md(e.location ?? "—")} | \`${md(e.id)}\` | ${md(reasonHeadline(e.reason) || "—")} |`;
    });
  return [
    `## ${status} (${entries.length})`,
    "",
    "| fit | company | role | location | id | reason |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

/**
 * The whole pipeline as one Markdown page, newest decision first.
 * @param {{jobs:object[], updated?:string}} pipeline `loadPipeline()` result.
 * @returns {string} file text — the caller writes it (`store.renderToFile`).
 */
export function render(pipeline) {
  const jobs = Array.isArray(pipeline?.jobs) ? pipeline.jobs : [];
  const byStatus = new Map(STATUSES.map((s) => [s, []]));
  for (const job of jobs) {
    if (!byStatus.has(job?.status)) byStatus.set(job?.status ?? "unknown", []);
    byStatus.get(job?.status ?? "unknown").push(job);
  }

  const present = [...byStatus.entries()].filter(([, rows]) => rows.length > 0);
  present.sort(([a], [b]) => statusRank(a) - statusRank(b));

  const scored = jobs.filter((j) => typeof j?.fit === "number");
  const counts = present.map(([status, rows]) => `${status} ${rows.length}`).join(" · ");
  const head = [
    "# Pipeline",
    "",
    `${jobs.length} posting${jobs.length === 1 ? "" : "s"}${counts ? ` · ${counts}` : ""}`,
    `updated ${pipeline?.updated ?? "—"}${scored.length ? ` · ${scored.length} scored by Jev` : ""}`,
    "",
    "A view of `pipeline.yaml` — edit the YAML (or use `pipeline.mjs`), then re-run `pipeline.mjs render`.",
    "`fit` is 0–4 from Jev; `!` marks a posting Jev flagged against a stated dealbreaker; `reason` is",
    "the user's own story that best matches the role.",
    "",
    "",
  ].join("\n");

  if (present.length === 0) return `${head}_No postings yet — run \`scan.mjs\`._\n`;
  return `${head}${present.map(([status, rows]) => section(status, rows)).join("\n")}`;
}
