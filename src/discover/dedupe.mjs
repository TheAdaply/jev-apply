// Cross-provider dedup for the scan pipeline (PLAN §2.5): "dedupe by normalized URL (keep `gh_jid`;
// strip `utm_*`/`ref`/`lever-source`) and `company::role`, cross-run dedup against
// `pipeline/scan-history.tsv`."

const STRIP_PARAM_PREFIXES = ["utm_"];
const STRIP_PARAMS_EXACT = new Set(["ref", "lever-source", "gh_src"]);
const KEEP_PARAMS_EXACT = new Set(["gh_jid"]);

// normalizeUrl(url) → a stable string for equality comparison: lowercase host, trailing-slash-trimmed
// path, and only the query params that survive the strip/keep rules above (sorted for stability).
export function normalizeUrl(url) {
  if (!url) return undefined;
  let u;
  try {
    u = new URL(url);
  } catch {
    return String(url).trim();
  }
  const kept = [];
  for (const [key, value] of u.searchParams) {
    const lower = key.toLowerCase();
    if (KEEP_PARAMS_EXACT.has(lower)) {
      kept.push([lower, value]);
      continue;
    }
    if (STRIP_PARAM_PREFIXES.some((p) => lower.startsWith(p))) continue;
    if (STRIP_PARAMS_EXACT.has(lower)) continue;
    kept.push([lower, value]);
  }
  kept.sort(([a], [b]) => a.localeCompare(b));
  const search = kept.length > 0 ? `?${kept.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `${u.hostname.toLowerCase()}${path}${search}`;
}

// companyRoleKey(job) → "company::role" with a best-effort strip of trailing location suffixes
// ("Senior Engineer (Berlin)" / "Senior Engineer - Berlin, DE" → "senior engineer").
export function companyRoleKey(job) {
  const company = String(job?.company ?? "").toLowerCase().trim();
  let title = String(job?.title ?? "");

  let prev;
  do {
    prev = title;
    title = title.replace(/\s*\([^()]*\)\s*$/, "");
  } while (title !== prev);

  // A plain hyphen separates a suffix only when spaced (" - Berlin"); unspaced it is part of a word
  // ("Full-Stack", "Front-End"), and cutting there made distinct roles collide as "acme::full".
  const spaced = title.replace(/\s+[-–—|]\s+(?:(?!\s[-–—|]\s).)+$/, "");
  title = spaced !== title ? spaced : title.replace(/\s*[–—|]\s*[^–—|]+$/, "");

  title = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  return `${company}::${title}`;
}

// dedupeJobs(jobs, seenKeys?) → Job[], deduplicated within this batch and against a caller-supplied
// Set of previously-seen normalizedUrl/companyRoleKey strings (e.g. loaded from scan-history.tsv).
// `seenKeys` is read, never mutated; pass a fresh Set() (default) for a same-run-only dedup.
export function dedupeJobs(jobs, seenKeys = new Set()) {
  const seen = new Set(seenKeys);
  const kept = [];
  for (const job of jobs) {
    const urlKey = normalizeUrl(job.url ?? job.applyUrl);
    const roleKey = companyRoleKey(job);
    if ((urlKey && seen.has(urlKey)) || seen.has(roleKey)) continue;
    if (urlKey) seen.add(urlKey);
    seen.add(roleKey);
    kept.push(job);
  }
  return kept;
}
