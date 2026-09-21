// Workday CXS postings provider. Public, unauthenticated JSON API. List only (PLAN §2.5).
// POST https://{tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
// body {appliedFacets:{}, limit:20, offset:0, searchText:""}; pages (offset += 20) to 100 postings.
// Detail url: https://{tenant}.wd{n}.myworkdayjobs.com/{locale}/{site}{externalPath}

export const id = "workday";

const TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 20;
const MAX_TOTAL = 100;

export function detect(url) {
  try {
    const u = new URL(url);
    return /\.myworkdayjobs\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

export async function fetch(entry, ctx = {}) {
  const { tenant, n, site } = entry ?? {};
  if (!tenant || !n || !site) throw new Error("workday.fetch: entry.tenant, entry.n, entry.site are required");
  const locale = entry.locale ?? "en-US";
  const host = `${tenant}.wd${n}.myworkdayjobs.com`;
  const url = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
  const max = ctx.limit ?? MAX_TOTAL;

  const postings = [];
  let knownTotal;
  for (let offset = 0; offset < max; offset += PAGE_LIMIT) {
    const body = { appliedFacets: {}, limit: PAGE_LIMIT, offset, searchText: "" };
    const data = await fetchJsonPost(url, host, body, ctx);
    const batch = Array.isArray(data.jobPostings) ? data.jobPostings : [];
    postings.push(...batch);
    // Workday's `total` is only reliable on the first page (later pages have been observed to report 0
    // on 2026-09-22 live testing even though jobPostings keeps coming back full); only trust it once.
    if (offset === 0 && typeof data.total === "number") knownTotal = data.total;
    if (batch.length < PAGE_LIMIT) break;
    if (typeof knownTotal === "number" && postings.length >= knownTotal) break;
  }
  return postings.slice(0, max).map((job) => toJob(job, entry, host, locale, site));
}

function toJob(job, entry, host, locale, site) {
  const detailUrl = `https://${host}/${locale}/${site}${job.externalPath}`;
  return {
    provider: id,
    externalId: job.bulletFields?.[0] ?? job.externalPath,
    title: job.title,
    url: detailUrl,
    applyUrl: detailUrl,
    company: entry?.name ?? entry?.tenant,
    location: job.locationsText,
    postedAt: parsePostedOn(job.postedOn),
  };
}

// Workday only exposes a relative string ("Posted Today", "Posted 3 Days Ago", "Posted 30+ Days Ago");
// converted to an ISO date best-effort so the age filter (PLAN §2.5) has something to compare against.
function parsePostedOn(postedOn) {
  if (typeof postedOn !== "string") return undefined;
  const now = Date.now();
  if (/today/i.test(postedOn)) return new Date(now).toISOString();
  if (/yesterday/i.test(postedOn)) return new Date(now - 86_400_000).toISOString();
  const m = postedOn.match(/(\d+)\+?\s+Days?\s+Ago/i);
  if (m) return new Date(now - Number(m[1]) * 86_400_000).toISOString();
  return undefined;
}

async function fetchJsonPost(url, host, body, ctx = {}) {
  const allowlist = ctx.allowedHosts ?? [host];
  if (!allowlist.includes(host)) {
    throw new Error(`workday.fetch: host not allowlisted: ${host}`);
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
    if (!res.ok) throw new Error(`workday.fetch: HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
