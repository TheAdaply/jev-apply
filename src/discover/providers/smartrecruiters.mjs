// SmartRecruiters postings provider. Public, unauthenticated JSON API. List only (PLAN §2.5).
// GET https://api.smartrecruiters.com/v1/companies/{co}/postings?limit=100

export const id = "smartrecruiters";

const API_HOST = "api.smartrecruiters.com";
const PUBLIC_HOST = "jobs.smartrecruiters.com";
const TIMEOUT_MS = 10_000;

export function detect(url) {
  try {
    const u = new URL(url);
    return u.hostname === API_HOST || u.hostname === PUBLIC_HOST;
  } catch {
    return false;
  }
}

export async function fetch(entry, ctx = {}) {
  const co = entry?.co;
  if (!co) throw new Error("smartrecruiters.fetch: entry.co is required");
  const limit = ctx.limit ?? 100;
  const url = `https://${API_HOST}/v1/companies/${encodeURIComponent(co)}/postings?limit=${limit}`;
  const data = await fetchJson(url, ctx);
  const postings = Array.isArray(data.content) ? data.content : [];
  return postings.map((posting) => toJob(posting, entry, co));
}

function toJob(posting, entry, co) {
  const detailUrl = `https://${PUBLIC_HOST}/${encodeURIComponent(co)}/${posting.id}`;
  return {
    provider: id,
    externalId: String(posting.id),
    title: posting.name,
    url: detailUrl,
    applyUrl: detailUrl,
    company: entry?.name ?? posting.company?.name ?? co,
    location: posting.location?.fullLocation,
    remote: posting.location?.remote,
    postedAt: posting.releasedDate,
    department: posting.function?.label ?? posting.department?.label,
  };
}

async function fetchJson(url, ctx = {}) {
  const u = new URL(url);
  const allowlist = ctx.allowedHosts ?? [API_HOST];
  if (!allowlist.includes(u.hostname)) {
    throw new Error(`smartrecruiters.fetch: host not allowlisted: ${u.hostname}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await globalThis.fetch(url, {
      redirect: "error",
      signal: controller.signal,
      headers: { "User-Agent": "jev-apply", Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`smartrecruiters.fetch: HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
