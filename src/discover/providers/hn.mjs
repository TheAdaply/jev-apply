// HN "Who is hiring?" provider. Public, unauthenticated Algolia HN Search API. List only (PLAN §2.5).
// 1. Find the current month's thread: GET hn.algolia.com/api/v1/search_by_date
//    ?query="Ask HN: Who is hiring"&tags=story  (take the most recent hit whose title matches exactly).
// 2. Fetch every top-level comment on that thread (paged): GET hn.algolia.com/api/v1/search
//    ?tags=comment,story_{id}&hitsPerPage=1000&page=N
// 3. Each top-level comment's first line is "Company | Role | Location | …"; url = the comment permalink.
// `entry`/`ctx.company` are unused — this provider is not company-scoped, it returns every posting on
// the thread; callers filter/dedupe downstream (PLAN §2.5).

export const id = "hn";

const API_HOST = "hn.algolia.com";
const HN_ITEM_HOST = "news.ycombinator.com";
const TIMEOUT_MS = 10_000;
const THREAD_TITLE = /^Ask HN: Who is hiring\?/i;

export function detect(url) {
  try {
    const u = new URL(url);
    return u.hostname === HN_ITEM_HOST || u.hostname === API_HOST;
  } catch {
    return false;
  }
}

export async function fetch(_entry, ctx = {}) {
  const storyId = await findCurrentThreadId(ctx);
  const comments = await fetchAllComments(storyId, ctx);
  const topLevel = comments.filter((c) => c.parent_id === storyId && c.comment_text);
  return topLevel.map((c) => toJob(c)).filter((job) => job.title || job.company);
}

async function findCurrentThreadId(ctx) {
  const url = `https://${API_HOST}/api/v1/search_by_date?query=${encodeURIComponent('"Ask HN: Who is hiring"')}&tags=story&hitsPerPage=10`;
  const data = await fetchJson(url, ctx);
  const hits = Array.isArray(data.hits) ? data.hits : [];
  const thread = hits.find((h) => THREAD_TITLE.test(h.title ?? ""));
  if (!thread) throw new Error("hn.fetch: could not find a current \"Who is hiring?\" thread");
  return Number(thread.objectID);
}

async function fetchAllComments(storyId, ctx) {
  const all = [];
  let page = 0;
  for (;;) {
    const url = `https://${API_HOST}/api/v1/search?tags=comment,story_${storyId}&hitsPerPage=1000&page=${page}`;
    const data = await fetchJson(url, ctx);
    const hits = Array.isArray(data.hits) ? data.hits : [];
    all.push(...hits);
    page += 1;
    if (page >= (data.nbPages ?? 1)) break;
  }
  return all;
}

function toJob(comment) {
  const text = htmlToText(comment.comment_text);
  const firstLine = text.split("\n")[0] ?? "";
  const fields = firstLine.split("|").map((f) => f.trim()).filter(Boolean);
  const [company, title, location, ...rest] = fields;
  const url = `https://${HN_ITEM_HOST}/item?id=${comment.objectID}`;
  return {
    provider: id,
    externalId: String(comment.objectID),
    title: title ?? fields[0],
    url,
    applyUrl: url,
    company: company ?? fields[0],
    location,
    remote: /\bremote\b/i.test(firstLine) || rest.some((f) => /\bremote\b/i.test(f)),
    description: text,
    postedAt: comment.created_at,
  };
}

function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

async function fetchJson(url, ctx = {}) {
  const u = new URL(url);
  const allowlist = ctx.allowedHosts ?? [API_HOST];
  if (!allowlist.includes(u.hostname)) {
    throw new Error(`hn.fetch: host not allowlisted: ${u.hostname}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await globalThis.fetch(url, {
      redirect: "error",
      signal: controller.signal,
      headers: { "User-Agent": "jev-apply", Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`hn.fetch: HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
