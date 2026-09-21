// Ashby job-board provider. Public, unauthenticated JSON API.
// GET https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true

export const id = "ashby";

const API_HOST = "api.ashbyhq.com";
const BOARD_HOSTS = new Set(["jobs.ashbyhq.com", API_HOST]);
const TIMEOUT_MS = 10_000;

export function detect(url) {
  try {
    const u = new URL(url);
    return BOARD_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export async function fetch(entry, ctx = {}) {
  const org = entry?.org;
  if (!org) throw new Error("ashby.fetch: entry.org is required");
  const url = `https://${API_HOST}/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`;
  const data = await fetchJson(url, ctx);
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  return jobs.map((job) => toJob(job, entry));
}

function toJob(job, entry) {
  return {
    provider: id,
    externalId: job.id ?? job.jobUrl,
    title: job.title,
    url: job.jobUrl,
    applyUrl: job.applyUrl,
    company: entry?.name ?? entry?.org,
    location: job.location,
    remote: job.isRemote,
    description: job.descriptionPlain ?? undefined,
    postedAt: job.publishedAt,
    salary: findSalary(job),
    department: job.department,
  };
}

function findSalary(job) {
  const comp = job.compensation;
  if (!comp || typeof comp !== "object") return undefined;
  if (typeof comp.compensationTierSummary === "string" && comp.compensationTierSummary) {
    return comp.compensationTierSummary;
  }
  if (Array.isArray(comp.summaryComponents) && comp.summaryComponents.length > 0) {
    return comp.summaryComponents
      .map((c) => (typeof c?.summary === "string" ? c.summary : undefined))
      .filter(Boolean)
      .join("; ") || undefined;
  }
  return undefined;
}

async function fetchJson(url, ctx = {}) {
  const u = new URL(url);
  const allowlist = ctx.allowedHosts ?? [API_HOST];
  if (!allowlist.includes(u.hostname)) {
    throw new Error(`ashby.fetch: host not allowlisted: ${u.hostname}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await globalThis.fetch(url, {
      redirect: "error",
      signal: controller.signal,
      headers: { "User-Agent": "jev-apply", Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`ashby.fetch: HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
