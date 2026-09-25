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

// companyRoleKey(job) → "company::role": one key for the same role posted per city, a different key
// for every other role. A trailing "(…)", " - …", " | …" or "—…" is dropped only when it says where
// or how the job is done: a work mode ("Remote", "Hybrid", "On-site"), or a run of words the
// posting's own `location` states ("Senior Engineer - Berlin, DE" posted in "Berlin, DE"). Any
// other suffix is the team or the specialization ("Machine Learning Engineer - Ads", "Member of
// Technical Staff - ML Performance"). Cut, it made distinct roles one key: `dedupeJobs` kept the
// first and dropped the rest, and the scan-history fingerprint then hid every later posting of that
// title with another team. A plain hyphen separates only when spaced: "Full-Stack Engineer" and
// "Post-Training Research Scientist" are one word each, where they used to key as "full"/"post".
export function companyRoleKey(job) {
  const company = String(job?.company ?? "").toLowerCase().trim();
  const location = ` ${words(job?.location)} `;
  const whereOrHow = (suffix) => {
    const said = words(suffix);
    return Boolean(said) && (WORK_MODE_RE.test(said) || location.includes(` ${said} `));
  };

  let title = String(job?.title ?? "").trim();
  for (;;) {
    const last = /\s*\(([^()]*)\)\s*$/.exec(title) ?? /\s+[-–—|]\s+((?:(?!\s[-–—|]\s).)+)$/.exec(title) ?? /\s*[–—|]\s*([^–—|]+)$/.exec(title);
    if (!last || !whereOrHow(last[1])) break;
    title = title.slice(0, last.index);
  }

  return `${company}::${words(title)}`;
}

// A work mode the way boards write one, compared in `words()` form: "Remote", "On-site",
// "In-Office", "Remote-First", "Hybrid / Remote". A bare "Office" is a team as often as a place.
const MODE = String.raw`(?:remote|hybrid|onsite|on site|in office|in person)(?: (?:first|only|friendly))?`;
const WORK_MODE_RE = new RegExp(String.raw`^${MODE}(?: (?:or |and )?${MODE})*$`);

/** Lowercase alphanumeric words, single-spaced: the form both the key and the location compare in. */
function words(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
