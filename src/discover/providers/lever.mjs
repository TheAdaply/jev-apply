// Lever job-postings provider. Public, unauthenticated JSON API.
// GET https://api.lever.co/v0/postings/{site}?mode=json

export const id = "lever";

const API_HOST = "api.lever.co";
const BOARD_HOSTS = new Set(["jobs.lever.co", API_HOST]);
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
  const site = entry?.site;
  if (!site) throw new Error("lever.fetch: entry.site is required");
  const url = `https://${API_HOST}/v0/postings/${encodeURIComponent(site)}?mode=json`;
  const data = await fetchJson(url, ctx);
  const jobs = Array.isArray(data) ? data : [];
  return jobs.map((job) => toJob(job, entry));
}

function toJob(job, entry) {
  return {
    provider: id,
    externalId: job.id,
    title: job.text,
    url: job.hostedUrl,
    applyUrl: job.applyUrl,
    company: entry?.name ?? entry?.site,
    location: job.categories?.location,
    description: job.descriptionPlain,
    postedAt: typeof job.createdAt === "number" ? new Date(job.createdAt).toISOString() : job.createdAt,
    department: job.categories?.team,
  };
}

async function fetchJson(url, ctx = {}) {
  const u = new URL(url);
  const allowlist = ctx.allowedHosts ?? [API_HOST];
  if (!allowlist.includes(u.hostname)) {
    throw new Error(`lever.fetch: host not allowlisted: ${u.hostname}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await globalThis.fetch(url, {
      redirect: "error",
      signal: controller.signal,
      headers: { "User-Agent": "jev-apply", Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`lever.fetch: HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
