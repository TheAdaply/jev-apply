// Workable job-board provider. Public, unauthenticated JSON API.
// POST https://apply.workable.com/api/v3/accounts/{sub}/jobs
// (GET on this path consistently returns 404, not 405, when verified live on 2026-09-22 —
// this provider always POSTs; see docs/PLAN.md §2.5 deviation note in the PR description.)
// Pagination: the response carries `nextPage` (an opaque token); pass it back as `token` in the
// next POST body until it comes back falsy.

export const id = "workable";

const API_HOST = "apply.workable.com";
const TIMEOUT_MS = 10_000;
const MAX_PAGES = 20; // 20 pages * ~10/page caps a single scan at ~200 postings per company

export function detect(url) {
  try {
    const u = new URL(url);
    return u.hostname === API_HOST;
  } catch {
    return false;
  }
}

export async function fetch(entry, ctx = {}) {
  const sub = entry?.sub;
  if (!sub) throw new Error("workable.fetch: entry.sub is required");
  const url = `https://${API_HOST}/api/v3/accounts/${encodeURIComponent(sub)}/jobs`;

  const results = [];
  let token;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = { query: "", location: [], department: [], worktype: [], remote: [], ...(token && { token }) };
    const data = await fetchJsonPost(url, body, ctx);
    const batch = Array.isArray(data.results) ? data.results : [];
    results.push(...batch);
    token = data.nextPage;
    if (!token || batch.length === 0) break;
  }
  return results.map((job) => toJob(job, entry));
}

function toJob(job, entry) {
  const url = `https://${API_HOST}/j/${job.shortcode}/`;
  return {
    provider: id,
    externalId: job.shortcode ?? String(job.id),
    title: job.title,
    url,
    applyUrl: `${url}apply`,
    company: entry?.name ?? entry?.sub,
    location: formatLocation(job),
    remote: job.remote,
    postedAt: job.published,
    department: Array.isArray(job.department) && job.department.length > 0 ? job.department.join(" / ") : undefined,
  };
}

function formatLocation(job) {
  const loc = job.location;
  if (!loc) return job.remote ? "Remote" : undefined;
  const parts = [loc.city, loc.region, loc.country].filter(Boolean);
  if (parts.length === 0) return job.remote ? "Remote" : undefined;
  return parts.join(", ");
}

async function fetchJsonPost(url, body, ctx = {}) {
  const u = new URL(url);
  const allowlist = ctx.allowedHosts ?? [API_HOST];
  if (!allowlist.includes(u.hostname)) {
    throw new Error(`workable.fetch: host not allowlisted: ${u.hostname}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await globalThis.fetch(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { "User-Agent": "jev-apply", Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`workable.fetch: HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
