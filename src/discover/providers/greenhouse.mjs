// Greenhouse job-board provider. Public, unauthenticated JSON API.
// GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true

export const id = "greenhouse";

const API_HOST = "boards-api.greenhouse.io";
const BOARD_HOSTS = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io", API_HOST]);
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
  const token = entry?.token;
  if (!token) throw new Error("greenhouse.fetch: entry.token is required");
  const url = `https://${API_HOST}/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
  const data = await fetchJson(url, ctx);
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  return jobs.map((job) => toJob(job, entry));
}

function toJob(job, entry) {
  return {
    provider: id,
    externalId: String(job.id),
    title: job.title,
    url: job.absolute_url,
    applyUrl: job.absolute_url,
    company: entry?.name ?? entry?.token,
    location: job.location?.name,
    description: htmlToText(job.content),
    postedAt: job.updated_at,
    salary: findSalary(job),
    department: Array.isArray(job.departments) && job.departments.length > 0 ? job.departments[0]?.name : undefined,
  };
}

function findSalary(job) {
  const meta = Array.isArray(job.metadata) ? job.metadata : [];
  const hit = meta.find((m) => m && typeof m.name === "string" && /salary|compensation|pay range|pay transparency/i.test(m.name));
  if (!hit || hit.value === null || hit.value === undefined || hit.value === "") return undefined;
  return typeof hit.value === "string" ? hit.value : JSON.stringify(hit.value);
}

function decodeEntities(html) {
  return html
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function htmlToText(html) {
  if (!html) return undefined;
  // Greenhouse serves `content` as HTML-entity-encoded HTML (e.g. `&lt;h3&gt;`);
  // decode entities first so the tag-strip regexes below actually see tags.
  return decodeEntities(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|ul|ol|br|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchJson(url, ctx = {}) {
  const u = new URL(url);
  const allowlist = ctx.allowedHosts ?? [API_HOST];
  if (!allowlist.includes(u.hostname)) {
    throw new Error(`greenhouse.fetch: host not allowlisted: ${u.hostname}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await globalThis.fetch(url, {
      redirect: "error",
      signal: controller.signal,
      headers: { "User-Agent": "jev-apply", Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`greenhouse.fetch: HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
